# Changelog

## 0.2.0

### Added
- Added reading profiles `technical` and `narrative`
  - Added `-p` / `--profile` selection for the CLI, config file, and VS Code/VSCodium extension. Technical is the default and reads closed fenced code blocks; narrative preserves the fenced-code announcement.
  - Technical profile says “The code is - ” before each closed fenced code block.
  - Inline backtick code is read as technical tokens in either profile: `nmnm.jsonc` becomes “nmnm dot jsonc,” while camelCase, underscores, hyphens, and path separators receive spoken boundaries.
- Compact numeric decimals are now read with “dot” in either profile, including versions such as `3.11`. Currency decimals use “point” plus a trailing name: `$3.50`, `€45.35`, `£1.00`, and `¥0.75` become “3 point 50 dollars,” “45 point 35 euros,” “1 point 00 pounds,” and “0 point 75 yen.”
- Well-formed pipe tables are read as a column announcement followed by labeled data rows in both profiles; malformed tables remain source text.
- Block quotes, task-list state, and list items now receive spoken structural markers; one-column pipe tables are accepted.
- Speech-inserted Markdown labels now follow `--lang` / `kokoreader.lang` for `en-us`, `en-gb`, `es`, `fr-fr`, `hi`, `it`, `ja`, `pt-br`, and `cmn`, with English fallback.
- Added extension's dropdown for Kokoro-82M’s supported voice languages, and `--list --lang CODE` to show only installed voices matching a language while preserving manual CLI voice and language input.

### Fixed
- Fixed Read and Save to File in the extension to export the active editor’s current selection or document through a private temporary input, so unsaved edits are included and the temporary input is removed when the process completes or is stopped.
- Fixed tab-context Read and Save actions selecting the active editor instead of their target tab; non-active targets now use their own URI.
- Fixed overlapping exports being partly uncontrollable: only one Save to File export can run, Read and Save are unavailable while it runs, and Stop remains available to cancel it.
- Fixed an open Save to File dialog leaving a private temporary input or later starting an export after Stop or deactivation; dialog cancellation now invalidates the pending save before input creation, and Command Palette reads cannot bypass the export guard.
- Fixed Save to File dialog failures leaving editor commands disabled, and Command Palette Save starting alongside live reading.
- Fixed blockquote task and ordered-list markers being lost after the quote announcement.

## 0.1.4

### Added
- Added one-unit live synthesis prefetch: while a unit plays, Kokoreader synthesizes its successor with the resident worker to reduce audible gaps without starting a second model worker.
- Added an 800 ms silent gap between source paragraphs in live playback and saved audio; safe chunks from the same paragraph remain seamless.
- Closed triple-backtick code blocks are now skipped with the spoken marker, “A code block follows. You can see the code in the document,” instead of disappearing silently.

### Fixed
- Fixed Kokoro's 510-phoneme bounds failure by phonemizing and splitting source paragraphs into ordered 500-phoneme safe units before inference, preserving punctuation-free text with a final hard split.
- Fixed no pause at spaced dashes: espeak-ng drops spaced hyphens outright and Kokoro renders `—` as a stretch with no silence, so `works — the` read as `works the`. Spaced dashes (`-`, `--`, `–`, `—`) are now rewritten to `..` before synthesis, which the model renders as a real ~170 ms pause. Word-internal hyphens (`local-first`) and Markdown list bullets are untouched.

## 0.1.3

- Fixed Pause and Resume losing the rest of a paragraph, and the stutter at the moment of Pause. `ffplay` cannot be paused in place: frozen, it stutters out the ~0.25 s of samples already handed to SDL and CoreAudio; continued, it burns the rest of its input at ~6x realtime (ffmpeg 9 on macOS) and exits. Pause now ends the paragraph's `ffmpeg`/`ffplay` pair, which mutes within ~10 ms, and Resume replays that paragraph from the remembered offset, `PAUSE_REWIND_MS` back, without re-synthesizing it.
- Fixed a paragraph paused during synthesis being spawned and then frozen; it is now withheld until resume, which also removes the spawn-then-stop blip.
- Fixed Pause doing nothing on Windows: the PowerShell `Suspend-Process`/`Resume-Process` cmdlets it shelled out to do not exist, and the failure was swallowed. Pause is now the same kill on every platform, with per-platform expectations documented in the Compatibility table. Only macOS is measured on hardware.
- Added regression coverage for the withheld and the replayed paragraph, and made `KKR_STUB_FFPLAY_HOLD=1` keep a stub player alive so a paused paragraph is observable at all.

## 0.1.2

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
