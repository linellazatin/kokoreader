#!/usr/bin/env python3
"""Small JSONL bridge between Kokoro ONNX and the Node reader."""

import argparse
import base64
import json
import re
import sys

import numpy as np
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


def synth_warning(text, lang, tokenizer, names):
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
    kept = tokenizer.phonemize(text, lang)
    if not kept:
        return f'lang "{lang}" produced no phonemes for this text; check the espeak-ng dictionary'
    dropped = 1 - len(kept) / len(raw) if raw else 0
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
    args = parser.parse_args()
    kokoro = Kokoro(args.model, args.voices)
    names = EspeakBackend.supported_languages()

    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get('id')
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
            elif request['action'] == 'synthesize':
                check_lang(request['lang'], request['voice'], names)
                warning = synth_warning(request['text'], request['lang'], kokoro.tokenizer, names)
                samples, sample_rate = kokoro.create(
                    request['text'], voice=request['voice'], speed=request['speed'], lang=request['lang']
                )
                response = {'id': request_id, 'sampleRate': sample_rate,
                            'pcm': base64.b64encode(pcm16(samples)).decode('ascii')}
                if warning:
                    response['warning'] = warning
                emit(response)
            else:
                raise ValueError(f"unknown action: {request['action']}")
        except Exception as error:
            emit({'id': request_id, 'error': str(error)})


def selfcheck():
    """python3 python/kokoro_worker.py --selfcheck: the pure parts, no model needed."""
    assert VOICE_LANGS['z'] == 'cmn' and VOICE_LANGS['a'] == 'en-us'
    assert LANG_SWITCH.findall('kˌonnitɕˈih (en)tʃˈaɪniːz(ja)lˈetə') == ['en', 'ja']
    assert not LANG_SWITCH.search('ˈola mˈundo, ˈesto ˈes ˈuna pɾuˈeba')
    assert not LANG_SWITCH.search('ni2χˈɑu s.ˈi.5 tɕˈiɛ5')
    assert NON_LATIN.search('Hello 世界 world.')
    assert not NON_LATIN.search('Caffè Crème ñü ế')  # accented Latin is still Latin
    assert ''.join(dict.fromkeys(NON_LATIN.findall('世界 a 世界'))) == '世界'
    print('ok')


if __name__ == '__main__':
    if '--selfcheck' in sys.argv:
        selfcheck()
    else:
        main()
