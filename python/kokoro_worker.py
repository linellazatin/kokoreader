#!/usr/bin/env python3
"""Small JSONL bridge between Kokoro ONNX and the Node reader."""

import argparse
import base64
import json
import re
import sys
from importlib import metadata

import numpy as np
import onnxruntime as ort
import phonemizer
from kokoro_onnx import Kokoro
from kokoro_onnx.tokenizer import Tokenizer
from packaging.version import Version
from phonemizer.backend import EspeakBackend

# The espeak-ng code each Kokoro voice initial stands for, per hexgrad/Kokoro-82m
# VOICES.md. Upstream gives 'j' and 'z' no espeak-ng fallback: those voices are
# trained with misaki, which kokoro-onnx does not use, so ja/cmn output is only an
# approximation and Mandarin loses its tone digits to the vocabulary filter.
VOICE_LANGS = {
    'a': 'en-us', 'b': 'en-gb', 'e': 'es', 'f': 'fr-fr', 'h': 'hi',
    'i': 'it', 'j': 'ja', 'p': 'pt-br', 'z': 'cmn',
}
# espeak-ng brackets text it read in a different language with "(<code>)". Kokoro
# keeps the brackets, and the vocabulary filter leaves their letters in, so the
# model reads aloud "japanese letter" instead of the kana that was pasted in.
LANG_SWITCH = re.compile(r'\(([a-z][a-z-]{1,9})\)')
# The codes for Kokoro's own voices that espeak-ng only has Latin dictionaries for.
LATIN_ONLY = {'en-us', 'en-gb', 'es', 'fr-fr', 'it', 'pt-br'}
# CJK, kana, Hangul, Cyrillic, Greek, Arabic, Hebrew, Devanagari and Thai letters.
# Accented Latin (é ñ ü ế) is deliberately not in these ranges.
NON_LATIN = re.compile('[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff'
                       '\uac00-\ud7af\u0400-\u04ff\u0370-\u03ff\u0590-\u05ff'
                       '\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f]')
# Ordinary loss is a few percent (stress marks, spaces); Mandarin sits at 22%.
DROP_WARN = 0.10
SAFE_PHONEME_LENGTH = 500
FIRST_PHONEME_LENGTH = 200
SENTENCE_BREAKS = frozenset('.!?…。！？')
CLAUSE_BREAKS = frozenset(',;:،，；：')


def split_at(remaining, limit):
    prefix = remaining[:limit]
    split = max((prefix.rfind(mark) + 1 for mark in SENTENCE_BREAKS), default=0)
    if not split:
        split = max((prefix.rfind(mark) + 1 for mark in CLAUSE_BREAKS), default=0)
    if not split:
        split = prefix.rfind(' ') + 1
    return split if split > 0 else limit


def split_phonemes(phonemes):
    units = []
    remaining = phonemes
    while remaining:
        limit = FIRST_PHONEME_LENGTH if not units else SAFE_PHONEME_LENGTH
        if len(remaining) <= limit:
            units.append(remaining)
            break
        boundary = split_at(remaining, limit)
        units.append(remaining[:boundary])
        remaining = remaining[boundary:]
    return [unit for unit in units if unit]


def error_response(request_id, error, warning):
    response = {'id': request_id, 'error': str(error)}
    if warning:
        response['warning'] = warning
    return response


def filter_phonemes(raw, vocab):
    return ''.join(phoneme for phoneme in raw if phoneme in vocab).strip()


def emit(message):
    print(json.dumps(message), flush=True)


def check_model_contract(session):
    inputs = {node.name: node for node in session.get_inputs()}
    token_name = 'input_ids' if 'input_ids' in inputs else 'tokens'
    expected = {token_name: 'tensor(int64)', 'style': 'tensor(float)',
                'speed': 'tensor(int32)' if token_name == 'input_ids' else 'tensor(float)'}
    if set(inputs) != set(expected):
        raise ValueError(f'unsupported model inputs {sorted(inputs)}; kokoro-onnx 0.4.7 requires tokens or input_ids, style, and speed')
    for name, kind in expected.items():
        if inputs[name].type != kind:
            raise ValueError(f'unsupported model input "{name}" type {inputs[name].type}; kokoro-onnx 0.4.7 requires {kind}. Upgrade runtime and model assets together, not just the model URL')
    for name, dimensions in ((token_name, (1, None)), ('style', (1, 256)), ('speed', (1,))):
        shape = inputs[name].shape
        if not isinstance(shape, list) or len(shape) != len(dimensions):
            raise ValueError(f'unsupported model input "{name}" shape {shape}; expected {dimensions}')
        for actual, expected_size in zip(shape, dimensions):
            if actual is None or isinstance(actual, str):
                continue
            if expected_size is None or actual != expected_size:
                raise ValueError(f'unsupported model input "{name}" shape {shape}; expected {dimensions} with variable token length')
    return token_name


def check_voice(kokoro, voice):
    if voice not in kokoro.get_voices():
        raise ValueError(f'voice "{voice}" is not installed; run kokoreader --list for available voices')
    try:
        style = np.asarray(kokoro.get_voice_style(voice))
    except (ValueError, TypeError) as error:
        raise ValueError(f'voice "{voice}" has unreadable style data: {error}') from error
    if style.ndim != 3 or style.shape[0] <= SAFE_PHONEME_LENGTH or style.shape[1:] != (1, 256):
        raise ValueError(f'voice "{voice}" has unsupported style shape {style.shape}; expected at least {SAFE_PHONEME_LENGTH + 1} rows of (1, 256)')
    if not np.issubdtype(style.dtype, np.number) or np.issubdtype(style.dtype, np.complexfloating):
        raise ValueError(f'voice "{voice}" style data must contain real numeric values')
    cast_style = any(node.name == 'input_ids' for node in kokoro.sess.get_inputs())
    if cast_style:
        with np.errstate(over='ignore', invalid='ignore'):
            style = style.astype(np.float32)
    elif style.dtype != np.float32:
        raise ValueError(f'voice "{voice}" style dtype {style.dtype} is unsupported by the tokens adapter; use float32')
    if not np.isfinite(style).all():
        raise ValueError(f'voice "{voice}" style data contains non-finite values')


def check_lang(lang, voice, names):
    """Reject unknown languages; warn, rather than forbid, experimental pairings."""
    implied = VOICE_LANGS.get((voice or '')[:1])
    if lang in names:
        if implied and lang != implied:
            return f'voice "{voice}" prefix suggests --lang {implied}, but --lang {lang} was selected; this experimental pairing may sound incorrect'
        return None
    detail = f'; voice "{voice}" needs --lang {implied}' if implied else ''
    raise ValueError(
        f'lang "{lang}" is not supported by espeak-ng{detail}. '
        'Run kokoreader --list-languages for the codes this install accepts.')


def synth_warning(text, lang, raw, phonemes, names):
    """Report what espeak-ng could not read, which is otherwise silent quality loss."""
    if lang in LATIN_ONLY:
        foreign = ''.join(dict.fromkeys(NON_LATIN.findall(text)))[:12]
        if foreign:
            return (f'espeak-ng cannot read "{foreign}" with lang "{lang}" (Latin dictionaries '
                    'only), so that text is spelled out in English instead. Set --lang to the '
                    'language of the text.')
    if not phonemes:
        return f'lang "{lang}" produced no phonemes for this text; check the espeak-ng dictionary'
    dropped = 1 - len(phonemes) / len(raw) if raw else 0
    switched = sorted(set(LANG_SWITCH.findall(raw)))
    if switched:
        return (f"espeak-ng read part of this text as {'/'.join(switched)}, not "
                f"{names[lang]}; Kokoro will pronounce the foreign words letter by letter. "
                'Match --lang to the text, or use a voice for that language.')
    if dropped > DROP_WARN:
        return (f"{round(dropped * 100)}% of the phonemes for lang \"{lang}\" are outside "
                "Kokoro's vocabulary and were dropped; expect lost tones or vowels.")
    return None


def pcm16(samples):
    clipped = np.clip(np.asarray(samples), -1, 1)
    return (clipped * 32767).astype('<i2').tobytes()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--voices', required=True)
    parser.add_argument('--threads', type=int, default=0)
    args = parser.parse_args()
    runtime = metadata.version('kokoro-onnx')
    if runtime != '0.4.7':
        raise ValueError(f'this worker requires kokoro-onnx 0.4.7, found {runtime}; use python/requirements.txt with the configured Python or upgrade runtime and model assets together')
    if Version(ort.__version__) < Version('1.28.0'):
        raise ValueError(f'this worker requires onnxruntime 1.28.0 or newer, found {ort.__version__}; install python/requirements.txt with the configured Python')
    options = ort.SessionOptions()
    if args.threads:
        options.intra_op_num_threads = args.threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
    session = ort.InferenceSession(args.model, sess_options=options)
    token_name = check_model_contract(session)
    kokoro = Kokoro.from_session(session, args.voices)
    names = EspeakBackend.supported_languages()
    emit({'ready': True})

    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get('id')
        warning = None
        try:
            if request['action'] == 'list':
                emit({'id': request_id, 'voices': sorted(kokoro.get_voices())})
            elif request['action'] == 'languages':
                counts = {}
                for voice in kokoro.get_voices():
                    counts[voice[:1]] = counts.get(voice[:1], 0) + 1
                emit({'id': request_id,
                      'kokoro': [{'letter': k, 'lang': VOICE_LANGS.get(k), 'voices': v}
                                 for k, v in sorted(counts.items())],
                      'espeak': names})
            elif request['action'] == 'prepare':
                check_voice(kokoro, request['voice'])
                warning = check_lang(request['lang'], request['voice'], names)
                raw = phonemizer.phonemize(
                    Tokenizer.normalize_text(request['text']), request['lang'], preserve_punctuation=True, with_stress=True)
                phonemes = filter_phonemes(raw, kokoro.tokenizer.vocab)
                speech_warning = synth_warning(request['text'], request['lang'], raw, phonemes, names)
                warning = '; '.join(message for message in (warning, speech_warning) if message) or None
                response = {'id': request_id,
                            'units': split_phonemes(phonemes)}
                if warning:
                    response['warning'] = warning
                emit(response)
            elif request['action'] == 'synthesize':
                check_voice(kokoro, request['voice'])
                if token_name == 'input_ids' and request['speed'] % 1 != 0:
                    raise ValueError('this input_ids graph uses INT32 speed and cannot represent fractional speed; use a compatible tokens/FLOAT-speed model or upgrade runtime and model assets together')
                samples, sample_rate = kokoro.create(
                    request['phonemes'], voice=request['voice'], speed=request['speed'], is_phonemes=True
                )
                emit({'id': request_id, 'sampleRate': sample_rate,
                      'pcm': base64.b64encode(pcm16(samples)).decode('ascii')})
            else:
                raise ValueError(f"unknown action: {request['action']}")
        except Exception as error:
            emit(error_response(request_id, error, warning))


def selfcheck():
    """python3 python/kokoro_worker.py --selfcheck: the pure parts, no model needed."""
    assert VOICE_LANGS['z'] == 'cmn' and VOICE_LANGS['a'] == 'en-us'
    assert LANG_SWITCH.findall('kˌonnitɕˈih (en)tʃˈaɪniːz(ja)lˈetə') == ['en', 'ja']
    assert not LANG_SWITCH.search('ˈola mˈundo, ˈesto ˈes ˈuna pɾuˈeba')
    assert not LANG_SWITCH.search('ni2χˈɑu s.ˈi.5 tɕˈiɛ5')
    assert NON_LATIN.search('Hello 世界 world.')
    assert not NON_LATIN.search('Caffè Crème ñü ế')  # accented Latin is still Latin
    assert ''.join(dict.fromkeys(NON_LATIN.findall('世界 a 世界'))) == '世界'
    assert filter_phonemes('a?b', {'a': 1, 'b': 2}) == 'ab'
    assert [len(unit) for unit in split_phonemes('a' * 500)] == [200, 300]
    assert [len(unit) for unit in split_phonemes('a' * 501)] == [200, 301]
    source = ('a' * 503) + ' b' + ('c' * 503)
    units = split_phonemes(source)
    assert ''.join(units) == source
    assert all(0 < len(unit) <= SAFE_PHONEME_LENGTH for unit in units)
    assert split_phonemes('a' * 190 + '. ' + 'b' * 20) == ['a' * 190 + '.', ' ' + 'b' * 20]
    assert error_response(7, ValueError('bad'), 'language warning') == {
        'id': 7, 'error': 'bad', 'warning': 'language warning'
    }
    from io import StringIO
    from types import SimpleNamespace
    from unittest.mock import Mock, patch

    valid_style = np.zeros((510, 1, 256), dtype=np.float32)

    def serve_fixture(request=None, styles=None, token_name='tokens',
                      token_type='tensor(int64)', speed_type='tensor(float)',
                      style_type='tensor(float)', runtime='0.4.7', token_shape=None,
                      ort_version='1.28.0', expect_no_session=False):
        styles = {'af_aoede': valid_style} if styles is None else styles
        inputs = [SimpleNamespace(name=token_name, type=token_type, shape=token_shape or [1, 'length']),
                  SimpleNamespace(name='style', type=style_type, shape=[1, 256]),
                  SimpleNamespace(name='speed', type=speed_type, shape=[1])]
        session = SimpleNamespace(get_inputs=lambda: inputs)
        create = Mock(return_value=(np.ones(8), 24000))
        model = SimpleNamespace(sess=session, tokenizer=SimpleNamespace(vocab={'a': 1}),
                                get_voices=lambda: list(styles), get_voice_style=lambda name: styles[name], create=create)
        output = StringIO()
        message = {'id': 1, 'action': 'prepare', 'text': 'Hello.', 'voice': 'af_aoede', 'lang': 'en-us', **(request or {})}
        with patch.object(sys, 'argv', ['worker', '--serve', '--model', 'fixture', '--voices', 'fixture']), \
             patch.object(sys, 'stdin', StringIO(json.dumps(message) + '\n' if request is not None else '')), \
             patch.object(sys, 'stdout', output), \
             patch.object(metadata, 'version', return_value=runtime), \
             patch.object(ort, '__version__', ort_version), \
             patch.object(ort, 'InferenceSession', return_value=session) as create_session, \
             patch.object(Kokoro, 'from_session', return_value=model), \
             patch.object(EspeakBackend, 'supported_languages', return_value={'en-us': 'English', 'es': 'Spanish'}), \
             patch.object(phonemizer, 'phonemize', return_value='a') as phonemize:
            try:
                main()
            finally:
                if expect_no_session:
                    create_session.assert_not_called()
                    assert not output.getvalue(), 'unsupported ORT announced readiness'
        return [json.loads(line) for line in output.getvalue().splitlines()], phonemize.call_count, create.call_count

    for action in ('prepare', 'synthesize'):
        messages, prepared, inferred = serve_fixture({'action': action, 'voice': 'missing-voice', 'phonemes': 'a', 'speed': 1.0})
        assert 'missing-voice' in messages[1].get('error', ''), f'missing voice was not rejected: {messages[1]}'
        assert prepared == inferred == 0, 'missing voice reached phonemization or inference'
    for style in (np.zeros((500, 1, 256), dtype=np.float32),
                  np.zeros((510, 256), dtype=np.float32),
                  np.zeros((510, 1, 128), dtype=np.float32),
                  np.zeros((510, 1, 256), dtype=np.float64),
                  np.zeros((510, 1, 256), dtype=np.complex64),
                  np.full((510, 1, 256), 'x'),
                  np.full((510, 1, 256), np.nan, dtype=np.float32),
                  np.full((510, 1, 256), np.inf, dtype=np.float32)):
        messages, prepared, inferred = serve_fixture({}, styles={'af_aoede': style})
        assert 'style' in messages[1].get('error', ''), f'invalid style was not rejected: {style.shape}/{style.dtype}'
        assert prepared == inferred == 0, 'invalid style reached phonemization or inference'
    messages, prepared, inferred = serve_fixture({}, styles={'af_aoede': np.full((510, 1, 256), 1e100)},
                                                token_name='input_ids', speed_type='tensor(int32)')
    assert 'non-finite' in messages[1].get('error', '') and prepared == inferred == 0, 'float32 style overflow reached phonemization or inference'
    messages, prepared, _ = serve_fixture({'lang': 'es'})
    assert messages[1].get('units') and 'en-us' in messages[1].get('warning', '') and prepared == 1, 'known voice-language mismatch was not warned nonfatally'
    messages, prepared, _ = serve_fixture({'voice': 'xx_custom'}, styles={'xx_custom': valid_style})
    assert messages[1].get('units') and not messages[1].get('warning') and prepared == 1, 'unknown custom prefix was rejected or warned'

    def expect_guard_error(fragment, **kwargs):
        try:
            serve_fixture(**kwargs)
        except ValueError as error:
            assert fragment in str(error), str(error)
        else:
            raise AssertionError(f'unsupported model/runtime was not rejected: {kwargs}')

    for ort_version in ('1.23.2', '1.24.1', '1.27.0', '1.28.0rc1', '1.28.0.dev1'):
        expect_guard_error('onnxruntime 1.28.0', ort_version=ort_version, expect_no_session=True)
    for ort_version in ('1.28.0', '1.28.1', '1.29.0'):
        messages, _, _ = serve_fixture(ort_version=ort_version)
        assert messages == [{'ready': True}], f'supported ORT was rejected: {ort_version}'
    expect_guard_error('0.4.7', runtime='0.6.1')
    expect_guard_error('inputs', token_name='unknown')
    expect_guard_error('tokens', token_type='tensor(int32)')
    expect_guard_error('style', style_type='tensor(float16)')
    expect_guard_error('speed', speed_type='tensor(int32)')
    expect_guard_error('speed', token_name='input_ids', speed_type='tensor(float)')
    expect_guard_error('tokens', token_shape=[1, 510])
    messages, _, inferred = serve_fixture({'action': 'synthesize', 'phonemes': 'a', 'speed': 1.0})
    assert messages[1].get('pcm') and inferred == 1
    messages, _, inferred = serve_fixture({'action': 'synthesize', 'voice': 'xx_custom', 'phonemes': 'a', 'speed': 1.0},
                                          styles={'xx_custom': valid_style.astype(np.float64)}, token_name='input_ids', speed_type='tensor(int32)')
    assert messages[1].get('pcm') and inferred == 1, 'compatible cast-style custom voices were rejected'
    messages, _, inferred = serve_fixture({'action': 'synthesize', 'phonemes': 'a', 'speed': 0.5}, token_name='input_ids', speed_type='tensor(int32)')
    assert 'INT32 speed' in messages[1].get('error', '') and inferred == 0, 'fractional speed was truncated by the INT32 adapter'
    print('ok')


if __name__ == '__main__':
    if '--selfcheck' in sys.argv:
        selfcheck()
    else:
        main()
