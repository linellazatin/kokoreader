#!/usr/bin/env python3
"""Small JSONL bridge between Kokoro ONNX and the Node reader."""

import argparse
import base64
import json
import re
import sys

import numpy as np
import onnxruntime as ort
import phonemizer
from kokoro_onnx import Kokoro
from kokoro_onnx.tokenizer import Tokenizer
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


def prepare(text, lang, tokenizer):
    phonemes = tokenizer.phonemize(text, lang)
    if not phonemes:
        raise ValueError(f'lang "{lang}" produced no phonemes for this text; check the espeak-ng dictionary')
    return split_phonemes(phonemes)


def emit(message):
    print(json.dumps(message), flush=True)


def check_lang(lang, voice, names):
    """Fail a bad --lang before inference, and name the code to use instead."""
    if lang in names:
        return
    implied = VOICE_LANGS.get((voice or '')[:1])
    detail = f'; voice "{voice}" needs --lang {implied}' if implied else ''
    raise ValueError(
        f'lang "{lang}" is not supported by espeak-ng{detail}. '
        'Run kokoreader --list-languages for the codes this install accepts.')


def synth_warning(text, lang, phonemes, names):
    """Report what espeak-ng could not read, which is otherwise silent quality loss."""
    if lang in LATIN_ONLY:
        foreign = ''.join(dict.fromkeys(NON_LATIN.findall(text)))[:12]
        if foreign:
            return (f'espeak-ng cannot read "{foreign}" with lang "{lang}" (Latin dictionaries '
                    'only), so that text is spelled out in English instead. Set --lang to the '
                    'language of the text.')
    # phonemize() returns one joined string here, not a list of utterances.
    raw = phonemizer.phonemize(
        Tokenizer.normalize_text(text), lang, preserve_punctuation=True, with_stress=True)
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
    options = ort.SessionOptions()
    if args.threads:
        options.intra_op_num_threads = args.threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
    session = ort.InferenceSession(args.model, sess_options=options)
    kokoro = Kokoro.from_session(session, args.voices)
    names = EspeakBackend.supported_languages()

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
                check_lang(request['lang'], request['voice'], names)
                phonemes = kokoro.tokenizer.phonemize(request['text'], request['lang'])
                warning = synth_warning(request['text'], request['lang'], phonemes, names)
                response = {'id': request_id,
                            'units': split_phonemes(phonemes)}
                if warning:
                    response['warning'] = warning
                emit(response)
            elif request['action'] == 'synthesize':
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
    print('ok')


if __name__ == '__main__':
    if '--selfcheck' in sys.argv:
        selfcheck()
    else:
        main()
