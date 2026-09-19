#!/usr/bin/env python3
"""Small JSONL bridge between Kokoro ONNX and the Node reader."""

import argparse
import base64
import json
import sys

import numpy as np
from kokoro_onnx import Kokoro


def emit(message):
    print(json.dumps(message), flush=True)


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

    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get('id')
        try:
            if request['action'] == 'list':
                emit({'id': request_id, 'voices': sorted(kokoro.get_voices())})
            elif request['action'] == 'synthesize':
                samples, sample_rate = kokoro.create(
                    request['text'], voice=request['voice'], speed=request['speed'], lang=request['lang']
                )
                emit({'id': request_id, 'sampleRate': sample_rate,
                      'pcm': base64.b64encode(pcm16(samples)).decode('ascii')})
            else:
                raise ValueError(f"unknown action: {request['action']}")
        except Exception as error:
            emit({'id': request_id, 'error': str(error)})


if __name__ == '__main__':
    main()
