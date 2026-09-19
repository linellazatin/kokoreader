# Changelog

## 0.1.2 - MAJOR RUNTIME FIXES

- Fixed CLI signal handling: `SIGINT`, `SIGTERM`, and `SIGHUP` now run `killActive()` before exit, so the Python worker, `ffmpeg`, and `ffplay` no longer outlive the CLI and the extension's 500 ms fallback kill is safe.
- Fixed pause between paragraphs: state moved to a `playbackPaused` latch that `playPCM` re-applies to the next spawned `ffplay`, instead of `pausePlayback` returning early when no player is alive during synthesis.
- Fixed config-relative asset paths: `MODEL_DIR`, `MODEL_PATH`, and `VOICES_PATH` from a config file resolve against the install directory; flag values still resolve against the working directory.
- Fixed `speed` validation: CLI, `SPEED`, and `kokoreader.speed` now enforce 0.5-2.0, the range `kokoro-onnx` 0.4.7 asserts in `Kokoro.create()`, rejecting it before the model is loaded. `tempo` keeps the 0.5-100 ffmpeg `atempo` range.
- Fixed download integrity: added `ASSET_SHA256` for the four `model-files-v1.0` release assets, verified after download and before the `.download` rename, and verified for files already present. Added `--force` to replace assets whose digest does not match, so a stale or truncated asset is reported instead of trusted.
- Fixed `--download` stalls and truncation: 60 s socket timeout, redirect depth capped at 5 with `new URL()` resolution of relative `Location` headers, `Content-Length` compared to bytes received, and discarded redirect bodies resumed.
- Fixed silent stream crashes: `ffmpeg.stdin`, `ffmpeg.stdout`, and `ffplay.stdin` error events are ignored so a child dying mid-paragraph reports `ffmpeg exited with code N` instead of throwing `EPIPE`.
- Fixed editor silence on failure: the reader's exit code is checked and the CLI's `Error:` line is shown, and `kokoreader.debug` forwards `--debug` to surface Python worker tracebacks.
- Fixed Save to File being unstoppable: the child is held in `activeSave` and killed by `kokoreader.stop` and `deactivate`.
- Fixed export memory: `--output` streams each paragraph into one `ffmpeg` via `startSaveEncoder` with write-callback backpressure, and publishes atomically through `OUTPUT_FILE.part` plus rename, so a late failure leaves the previous file intact. `killActive()` deletes a pending `OUTPUT_FILE.part`, because `process.exit` skips the cleanup in `read()`.
- Fixed `stripMarkdown` eating comparisons: the tag pattern now requires a letter or `!` after `<`, so `x < 10 and y > 5` survives while `<b>` and `<!-- -->` still strip.
- Fixed config scope: `OUTPUT_FILE`, `START_PARA`, `DEBUG`, and `FORCE` are CLI flags only, so a config file cannot redirect or skip every editor read.
- Fixed editor surfacing of mid-read failures: the CLI writes its `Error:` line on the same stderr line as the `\r` progress text, so the extension now extracts the message with `indexOf('Error: ')` instead of `startsWith`.
- Added `--list-languages` (`-ll`): reports the espeak-ng code each Kokoro voice initial requires, derived from the voices actually present in `voices-v1.0.bin`, plus every code the installed espeak-ng build accepts.
- Fixed silent language failures: `python/kokoro_worker.py` rejects an unknown `--lang` before inference and names the code the voice needs (`zh` becomes `--lang cmn`), and warns once per run on `Kokoreader: ...` when espeak-ng cannot read the text: foreign script under a Latin-only code, a mid-paragraph language switch (`(en)` markers surviving the vocabulary filter), or more than 10% of phonemes dropped as out-of-vocabulary.
- Added regression coverage for signals, latched pause, path anchoring, stream guards, cancelable save, streaming export, digest checks, config scope, worker warnings, and `--list-languages`, on stubbed `python`, `ffmpeg`, and `ffplay`; `python3 python/kokoro_worker.py --selfcheck` checks the language detection rules without a model.

## 0.1.1

- Added Marketplace metadata and Open VSX release publishing.
- Hardened temporary editor input, playback errors, and worker exits.
- Fixed reader completion when the extension keeps its control pipe open.
- Enforced export format, stricter CLI validation, and model-file exclusions.
- Pinned CI actions and VSIX packaging tools.

## 0.1.0

- Initial CLI and VS Code/VSCodium extension.
- Local Kokoro inference, voice selection, playback controls, and audio export.
- Explicit model downloads, configuration, and Markdown/text input.
- Read-from-cursor command for the active editor document.
- Output format, sample-rate conversion, loudness normalization, and limiting controls.
- FP32/FP16/INT8 model-download selection and compact CLI aliases.
- Moved the default CLI configuration into `config/`.
