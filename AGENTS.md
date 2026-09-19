# Kokoreader

## What this is

A Node.js CLI plus a VS Code/VSCodium extension that reads text and Markdown aloud using local Kokoro TTS inference. A Python worker runs the pinned `kokoro-onnx` wrapper out of process. Synthesis is fully local: no account, API key, or cloud call after one-time dependency and model downloads.

Only 14 files are tracked. Model assets, local config, and packaged extensions are ignored by `.gitignore` (`*model*/`, `*.conf`, `*.vsix`, `__pycache__/`, `.nanomneme/`), so `kkr-models/` exists only after `--download` has run on that machine.

## Commands

- `npm test` — the only package script; runs `node test/cli.js`.
- No build step, linter, typecheck, or bundler. CI's runtime checks are `node --check` on `bin/kokoreader.js`, `extension/extension.js`, `test/cli.js`, and `python3 -m py_compile python/kokoro_worker.py`.
- `node bin/kokoreader.js ...` — CLI entry. Text comes from stdin or a file argument. `--output FILE` saves instead of playing (required on headless/remote hosts, which have no audio device). `--download` fetches assets into `--model-dir`; `--force` replaces assets that fail their digest; `--list` and `--list-languages`/`-ll` are diagnostics; `--debug` surfaces worker output.
- `-f` is `--format`, not `--force`.

## Architecture

- `extension/extension.js` — extension host: registers the six `kokoreader.*` commands and editor-context menu actions, spawns the CLI through the editor's own Node runtime, owns the status bar item and the temp-file lifecycle.
- `bin/kokoreader.js` — CLI: strips Markdown to paragraphs, synthesizes one paragraph at a time (progress is per-paragraph), then plays through `ffplay` or encodes through `ffmpeg`.
- `python/kokoro_worker.py` — resident JSONL worker on stdio with `synthesize`, `list`, and `languages` actions; `kokoro-onnx==0.4.7` is pinned in `python/requirements.txt`.
- Teardown invariant: `killActive()` is the single reaper for the worker, `ffmpeg`, and `ffplay`, and it also deletes a pending `OUTPUT_FILE.part`, because `process.exit` skips `read()`'s cleanup.

## Configuration and installation

Runtime requirements: Node 20+, Python 3.11+ with `pip3` for that same interpreter, and ffmpeg (plus ffplay for live playback). `PYTHON_PATH` must be an executable, not a directory.

Config precedence: `KOKORO_READER_CONFIG` > `config/kokoreader.conf` > `~/.config/kokoreader/config` > built-in defaults; CLI flags override everything. Relative `MODEL_DIR`/`MODEL_PATH`/`VOICES_PATH` in a config file resolve against the install directory, while flag values resolve against the working directory. `OUTPUT_FILE`, `START_PARA`, `DEBUG`, and `FORCE` are flag-only (`IGNORED_CONFIG_KEYS`) so a config file cannot redirect every editor read.

## Testing and operational quirks

- `test/cli.js` drives the real CLI against stubbed `python`, `ffmpeg`, and `ffplay` placed on `PATH`: no network, no model, no audio device. Shared fixtures are `stubs()`, `stubEnv()`, `cliArgs()`, `stubEvents()`, `waitFor()`, and `isStopped()`/`isAlive()`.
- `--lang` is an espeak-ng code, not Kokoro's documented language letter: `zh` is invalid, Mandarin is `cmn`. `VOICE_LANGS` in the worker maps each voice initial to its code. Japanese and Mandarin are degraded because `kokoro-onnx` has no misaki G2P, so the worker reports the failure modes (unusable code, foreign script under a Latin-only code, mid-paragraph language switch, >10% of phonemes dropped) once per run as `Kokoreader: ...` on stderr. Keep those warnings, not errors: audio is still produced.
- `python3 python/kokoro_worker.py --selfcheck` checks the language rules with no model and no network, but needs the requirements installed, so CI does not run it.
- Bounds differ on purpose: `speed` is 0.5-2.0 (asserted inside `Kokoro.create()`), `tempo` is 0.5-100 (ffmpeg `atempo`).
- `ASSET_SHA256` in the CLI pins the four `model-files-v1.0` assets because upstream regenerates release assets in place and publishes no checksums. A failed download leaves a partial `.download` file; remove and rerun.
- CI validates PRs, then on a `v<version>` tag matching `package.json` version publishes the CI-built VSIX to Open VSX and builds a GitHub Release from the matching `CHANGELOG.md` section, which is extracted by an exact `## <version>` heading. Keep that heading format.
- Two comma-separated voices blend equally; weighted blends and editor voice/language pickers are not implemented.

## Key files

- `package.json` — extension manifest: six commands and sixteen `kokoreader.*` settings. Changing a command or setting touches this and `extension/extension.js` together.
- `README.md` — authoritative user guide, flag reference, and troubleshooting table.
- `CHANGELOG.md` — release notes consumed by CI; `config/kokoreader.sampleconf` — documented config template.

<!-- opl-init:fp 2265c460b50c7d49 -->
