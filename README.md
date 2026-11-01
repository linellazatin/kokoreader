# Kokoreader

<div align="center">

[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/openlines/kokoreader?logo=vscodium&label=open-vsx.org)](https://open-vsx.org/extension/openlines/kokoreader)
[![VS Marketplace](https://img.shields.io/badge/VS_Marketplace-Kokoreader-white?labelColor=blue)](https://marketplace.visualstudio.com/items?itemName=openlines.kokoreader)

</div>

Kokoreader reads text and Markdown aloud with local Kokoro inference. It provides a `Node.js` CLI and a VS Code/VSCodium extension for an editor tab or selection. Synthesis is local: no account, API key, or cloud service is used after one-time dependency and model downloads.

## Main Features

Kokoreader is built for reading real working documents aloud, not just short plain-text prompts.

### Local by design

Everything runs on your machine after the one-time model and dependency download. There is no account, API key, text upload, or cloud inference path.

### Read where you work

Use the CLI for files and pipelines, or use the VS Code/VSCodium extension to read an editor selection, a whole tab, or from the current cursor through the rest of the document. Save the same output as WAV, MP3, FLAC, or Opus when live playback is not practical.

### Long-document playback that stays moving

Kokoreader phonemizes text before synthesis, splits it safely below Kokoro’s model boundary, and synthesizes one upcoming unit while the current one plays, including split units within the same paragraph. It uses one resident inference worker; if the upcoming audio is not ready when playback ends, it waits for that synthesis to finish. Pause allows an already-running prefetch request to finish but withholds further prefetch requests until Resume. That avoids the long-paragraph bounds failure and reduces dead air caused by waiting for the next inference.

Live playback retains paragraph preparation only for the active paragraph and its successor, releases consumed cached PCM, and discards completed entries during forward reading. Source text remains available for navigation; Previous and Replay synthesize the selected paragraph again rather than keeping a document-wide audio cache.

It preserves a natural **800 ms** gap between source paragraphs in both live playback and saved audio, without adding pauses inside a paragraph that was safely split into multiple units. The first unit targets an early sentence boundary within 200 phonemes to reduce time to first audio; later units retain the 500-phoneme safety boundary.

### Markdown-aware, without silently hiding structure

Formatting, links, images, and HTML are removed before speech. Block quotes are announced as “Quote.”, including quoted task and list items; task-list items are “Checked item.” or “Unchecked item.”, unordered list items receive a short pause instead of an item marker, and ordered lists retain their number. The default technical profile says “The code is - ” and reads closed triple-backtick code blocks. Use `-p narrative` or set `PROFILE=narrative` to announce them instead:

> "A code block follows. You can see the code in the document."

### Reading profiles

**Technical** is the default: it reads closed code blocks after saying “The code is - ”, and normalizes inline code, decimal numbers, and currency amounts for speech. **Narrative** is available with `-p narrative`, `PROFILE=narrative`, or `kokoreader.profile`; it removes Markdown formatting and announces closed code blocks without reading their source. Both profiles read well-formed Markdown tables, including one-column tables, as labeled rows.

### Language-aware Markdown labels

The speech-inserted Markdown labels follow `--lang` / `kokoreader.lang`: code-block introductions, table/column/row/blank-cell markers, quotes, task state, and ordered-list numbers are mapped for `en-us`, `en-gb`, `es`, `fr-fr`, `hi`, `it`, `ja`, `pt-br`, and `cmn`. Any other language code uses English labels. Technical-token normalization, including “dot”, “dash”, and currency names, remains English in this release.

### Playback controls that respect listening

Pause immediately ends the active player so audio stops rather than continuing in the background. Resume replays a short amount of context instead of skipping a word. Stop cancels live playback and active exports.

### Language-aware guardrails

Kokoreader validates selected voices, style data, and eSpeak language codes before phonemization or inference. Known voice-prefix/language disagreements warn without blocking experimental pairings; unknown custom prefixes remain usable. Script and phoneme-coverage warnings identify likely pronunciation loss in mixed-language Markdown and non-Latin text.

### Documentation-grade output

Saved audio is streamed through one ffmpeg encoder, so long exports do not require buffering an entire document in memory. Each export encodes inside its own private directory beside the destination and publishes by atomic rename; it does not use or remove a preexisting sibling `.part`. Failure or cancellation before publication preserves prior output and cleans only owned staging. Stop requests CLI cleanup; the extension retains ownership and private input until streams close, with a hard-kill fallback after 2.5 seconds. An already-completed publication is not undone.

Concurrent CLI exports use separate staging directories: the last successful atomic publication wins, without ordering or locking guarantees. Use a stable, user-controlled destination directory; this does not defend against malicious ancestor replacement or processes running as the same user.

## Repository layout

| Path | Contents |
| --- | --- |
| `bin/` | CLI entry point. |
| `extension/` | VS Code/VSCodium extension entry point. |
| `python/` | Kokoro worker and Python requirements. |
| `config/` | Sample CLI configuration. |
| `test/` | Node-based checks. |

## Compatibility
>
> ** Windows OS still needs to be further tested - unfortunately I do not have any Windows device as of the current, so I will be depending on everyone's help on this. Feel free to raise an issue, specially if you're on Windows OS.
>

| Surface | Supported target | Notes |
| --- | --- | --- |
| CLI | macOS, Linux, Windows** | Needs Node.js, Python 3.11+, and ffmpeg. Live playback also needs ffplay. |
| Extension | VS Code and VSCodium 1.75+ | Runs the bundled CLI through the editor's Node runtime. |
| CPU | macOS 14+ Apple silicon, Windows** x64, Linux x64 | Pins CPU ONNX Runtime 1.28.0; no official baseline wheels for Intel/older macOS. |
| Linux ARM64 | Best effort | Matching Python and ONNX Runtime wheels must be available. |
| Save to File | Any supported CLI platform with ffmpeg | No audio device or ffplay required. |
| Pause / Resume | macOS verified, Linux and Windows** expected | Ends the paragraph's player to mute and replays it on Resume. No platform suspend or mute API is involved. See the table below for what each platform sounds like. |
| Remote/headless editor | Save to File, by default | Live playback requires an audio device where the extension host runs. |

`ffplay` cannot be frozen in place, so Pause ends its `ffmpeg`/`ffplay` pair and Resume replays the same paragraph from a remembered offset. What that means per platform:

| Platform | Mute | Click at Pause | Resume lands at |
| --- | --- | --- | --- |
| macOS | player exits 8-9 ms after the signal, measured | subtle, confirmed by ear | measured: the rest of the paragraph plays, nothing skipped |
| Linux | same code path: `SIGTERM`, which SDL turns into a quit event that closes the audio device. Not measured. | not known | same arithmetic. Unmeasured: if PulseAudio, PipeWire, or ALSA owns more audio than the 0.8 s back-off, Resume skips that much instead of repeating it. Report it. |
| Windows** | same code path, but Node terminates the process abruptly instead of signalling it, so muting is at least as fast. Not measured. | expected to be the hardest of the three | same arithmetic. Pause did nothing at all before 0.1.3. |

The character of the click belongs to the audio stack, not to Kokoreader. Only the macOS row has been checked on real hardware.

Packaged reader/export lifecycle checks pass on macOS, Fedora, and Ubuntu with VS Code 1.75/1.144 and VSCodium 1.75/1.143. Automated playback uses dummy SDL and Save tests substitute the dialog result; manual UI and listening acceptance remain separate. Editor launches preserve the 1.75 minimum without passing Microsoft's obsolete private bootstrap flag to stock VSCodium or current Electron.

Kokoreader is not a mobile, browser, or web-extension tool.

## Requirements

- Node.js 20 or newer
- Python 3.11 or newer; current official runtime wheels cover CPython 3.11–3.14
- `pip3` for that same Python interpreter
- ffmpeg, including `ffplay` for live playback
- About 340 MB free for default model files, plus generated audio

Kokoreader pins `kokoro-onnx==0.4.7` and `onnxruntime==1.28.0` in [python/requirements.txt](python/requirements.txt), and rejects older ONNX Runtime before loading a model. Official macOS installation requires macOS 14+ Apple silicon; Intel/older macOS needs a separately verified patched-source route, not an affected-version fallback. The configured Python and ffmpeg must be accessible to the CLI and the GUI application's environment.

For the standalone CLI, prefer a maintained Node.js LTS release, such as the tested Node.js 22. Node.js 20 remains the compatibility minimum but is upstream EOL; the extension uses its editor runtime, so prefer a maintained editor release too.

Run the CLI suite with `npm test`. CI uses Node.js 22 and runs `node test/package.js` after making `vsce` 4.0.0 available. That check verifies a distribution-file allowlist against disposable local-state fixtures; new runtime files must be added explicitly to `.vscodeignore`.

## CLI setup

### 1. Get the source

Clone or download this repository and open a terminal in its directory.

### 2. Check Node and Python

```sh
node --version
python3 --version
python3 -m pip --version
```

The Python version must be 3.11 or newer. `python3` and `pip3` must resolve to the same installation. On Windows, use an absolute `python.exe` path when `python3` is not available.

### 3. Install inference dependencies

```sh
pip3 install -r python/requirements.txt
```

With multiple Python installations, target the configured one explicitly:

```sh
/path/to/python3 -m pip install -r python/requirements.txt
```

### 4. Install and verify ffmpeg

Install an ffmpeg distribution for your platform, then confirm both executables are on `PATH`:

```sh
ffmpeg -version
ffplay -version
```

Saving WAV needs only `ffmpeg`; live reading needs `ffplay` and a working audio device.

### 5. Download model assets

Choose a directory and run:

```sh
node bin/kokoreader.js --model-dir kkr-models --download
```

This downloads `kokoro-v1.0.onnx` and `voices-v1.0.bin`. Downloads happen only when explicitly requested, never while reading. A failed or cancelled download cleans its owned staging; rerun the command.

Each asset is checked against the SHA-256 of the file in the [`model-files-v1.0` release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0) it came from, both after download and for files that already exist. A file that fails its digest is reported and left untouched; `--force` replaces exactly those:

```sh
node bin/kokoreader.js --model-dir kkr-models --download --force
```

Use `--force` to restore mismatching files from the pinned release, including truncated files, not to refresh regenerated upstream content. Matching assets are never downloaded or rewritten, even with `--force`. If upstream bytes no longer match the pinned digest, the download fails and preserves the existing file.

Downloads use private operation-owned staging directories inside the model directory; existing sibling `.download` files and symlinks are ignored. Only digest-verified assets publish by atomic rename, and `--force` does not bypass verification. Failed or cancelled transfers close owned streams before staging cleanup. Concurrent downloads use separate staging; use a stable, user-controlled model directory.

FP32 is the default. To explicitly download FP16 or INT8 instead:

```sh
node bin/kokoreader.js -md kkr-models -mp fp16 -d
node bin/kokoreader.js -md kkr-models -mp int8 -d
```

Set the same `MODEL_PRECISION` in configuration or `kokoreader.modelPrecision` in the extension before using a non-FP32 model from `modelDir`.

The current worker requires `kokoro-onnx==0.4.7` and ONNX Runtime 1.28.0 or newer. Its guard covers supported `tokens`/FLOAT-speed and `input_ids`/INT32-speed input signatures, not generic ONNX or vocabulary-identity certification. INT32-speed graphs reject fractional speeds. Voice styles need at least 501 rows of `(1, 256)` real, finite values: FLOAT32 for `tokens`, or safely convertible to FLOAT32 for `input_ids`. Upgrade runtime and assets together, not model URLs alone.

### 6. Configure the CLI

Copy [config/kokoreader.sampleconf](config/kokoreader.sampleconf) to `config/kokoreader.conf`, then set absolute paths:

```conf
MODEL_DIR=/path/to/kokoro-models
MODEL_PRECISION=fp32
PYTHON_PATH=/path/to/python3
VOICE=af_heart
LANG=en-us
PROFILE=technical
SPEED=1.0
TEMPO=1.0
GAIN=-1
VOLUME=1.0
FORMAT=wav
SAMPLE_RATE=0
NORMALIZE=false
LIMITER=true
```

`PYTHON_PATH` must be an executable such as `/usr/local/bin/python3`, not a directory ending in `bin`.

Relative `MODEL_DIR`, `MODEL_PATH`, and `VOICES_PATH` values in a config file resolve against the Kokoreader install directory, so `MODEL_DIR=kkr-models` works from any working directory and in the extension. Absolute paths are still recommended. `OUTPUT_FILE`, `START_PARA`, and `DEBUG` are accepted only as flags, never from a config file.

Configuration precedence:

1. `KOKORO_READER_CONFIG`, a config-file path
2. `config/kokoreader.conf`
3. `~/.config/kokoreader/config`
4. Built-in defaults

CLI flags override config-file values.

### 7. Test it

```sh
node bin/kokoreader.js --list
node bin/kokoreader.js README.md
node bin/kokoreader.js --output README.wav README.md
```

Expect paragraph progress. Kokoreader phonemizes and splits each paragraph into safe units before synthesis. It adds a natural 800 ms silent gap between source paragraphs in both live playback and saved audio, but not between safe units from the same paragraph. With a file input, a controlling process can send `pause`, `resume`, `previous`, `replay`, `next`, and `stop` through stdin. Navigation is paragraph-based; it cancels stale work and keeps the paused state. `pause` ends the paragraph's player at once; `resume` replays that paragraph from where it was heard, backed off by about 0.8 s. With no file, stdin is text input:

```sh
printf 'Hello from Kokoreader.\n' | node bin/kokoreader.js
```

## CLI reference

| Flag | Purpose |
| --- | --- |
| `-md`, `--model-dir DIR` | Directory containing model assets. |
| `-m`, `--model PATH`; `-vs`, `--voices PATH` | Explicit model and voice-data paths. |
| `-mp`, `--model-precision P` | Download/use `fp32` (default), `fp16`, or `int8` model assets. |
| `-py`, `--python-path PATH` | Python interpreter executable. |
| `-v`, `--voice NAME`; `-l`, `--lang CODE`; `-s`, `--speed N` | Voice, language, and Kokoro synthesis speed (0.5-2.0). |
| `-p`, `--profile NAME` | `technical` (default) says “The code is - ” then reads closed fenced code blocks; `narrative` announces them. |
| `-t`, `--tempo N`; `-g`, `--gain DB`; `-vol`, `--volume N` | Final playback controls. Tempo accepts 0.5 through 100. |
| `-f`, `--format TYPE`; `-sr`, `--sample-rate HZ` | Saved format and sample rate. The format controls encoding; use a matching filename extension. |
| `-n`, `--normalize`; `-nn`, `--no-normalize` | Enable or disable EBU R128 normalization. |
| `-lim`, `--limiter`; `-nlim`, `--no-limiter` | Enable or disable final peak limiting. |
| `-o`, `--output FILE` | Save audio instead of playing. Use an extension that matches `--format`. |
| `-sp`, `--start-para N` | Start at one-based paragraph N; `0` reads from the beginning. |
| `--threads N` | Cap ONNX Runtime inference threads. `0` is the default and lets ONNX Runtime choose. |
| `--pronunciations FILE` | Read a local JSON pronunciation replacement dictionary. |
| `-d`, `--download` | Download selected assets to `--model-dir`. |
| `--force` | With `--download`, replace assets whose SHA-256 does not match the release. |
| `-ls`, `--list`; `-ll`, `--list-languages`; `-dbg`, `--debug` | List voices, list accepted language codes, or show worker errors. The extension always appends failed reads and exports to `err.jsonl`. Add `--lang CODE` to `--list` to show only installed voices matching that Kokoro voice language. |

Input is plain text or Markdown. Formatting, links, images, and HTML tags are removed before synthesis. The default `technical` profile says “The code is - ” before reading a closed triple-backtick fenced code block. With `-p narrative`, the block is replaced with the spoken paragraph:

```text
“A code block follows. You can see the code in the document.”
```

Inline backtick code is normalized as a technical token in both profiles: dots become “dot”, underscores become “underscore”, path separators become “slash” or “backslash”, hyphens become “dash”, and camelCase gets a word boundary. Thus `nmnm.jsonc` is read as “nmnm dot jsonc.” In either profile, a dot directly between digits is read as “dot”, so `3.11` becomes “3 dot 11.” Currency decimals instead use “point” and a trailing currency name: `$3.50`, `€45.35`, `£1.00`, and `¥0.75` become “3 point 50 dollars,” “45 point 35 euros,” “1 point 00 pounds,” and “0 point 75 yen.” Block quotes are announced, task-list state is spoken, unordered list bullets produce a short pause, and ordered lists retain numbered markers. These inserted labels use the configured language map for `en-us`, `en-gb`, `es`, `fr-fr`, `hi`, `it`, `ja`, `pt-br`, and `cmn`; unsupported codes use English labels. Well-formed GitHub-flavored pipe tables, including one-column tables, are read in both profiles as a table and column announcement followed by one labeled row per paragraph; blank cells use the configured language’s blank marker. Malformed tables remain source text. The `technical` profile uses the configured language’s code introduction before reading each closed backtick or tilde fence with those rules. Unclosed fences remain literal source text.

### Pronunciations and CPU budget

Set `--pronunciations FILE`, `PRONUNCIATIONS_PATH`, or `kokoreader.pronunciationsPath` to a readable local JSON object such as `{ "nmnm.jsonc": "n m n m dot json c" }`. Replacements are case-sensitive, match whole literal phrases, prefer longer keys, run only against original source text, and run before Markdown and technical-token processing. Empty keys or values and malformed JSON stop the read before the worker starts. Set `--threads N`, `THREADS`, or `kokoreader.threads` to cap ONNX Runtime CPU use. Keep `0`: the current listening comparison found longer synthesis pauses with explicit caps of 2 and 4. The worker reports ready after model startup; startup that exceeds 20 seconds and requests that exceed 120 seconds stop the worker with a named error.

### Debug error log

Every failed extension read or Save to File export appends one JSON Lines record. Records contain only timestamp, operation, process event, exit code or signal, and a generated summary; raw stderr, source text, and audio are never recorded. Export failures show a bounded CLI error after stderr drains, including setup and encoder details without enabling debug. Cancellation produces no success/failure notification or error-log entry. `kokoreader.debug` exposes additional worker diagnostics without replacing playback progress. Kokoreader first writes `<extension>/logs/err.jsonl`, for example `/Users/lines/.vscode-oss/extensions/openlines.kokoreader-0.4.0/logs/err.jsonl`; if that installed directory is not writable, it uses the editor's extension log storage instead. The file rotates at 1 MiB, retaining one previous file as `err.jsonl.1`.

## VS Code and VSCodium setup

The repository currently contains extension source. Install a packaged `.vsix` once one is built, or use an Extension Development Host when developing locally.

Kokoreader requires Workspace Trust and is disabled in Restricted Mode. Workspace settings can select the Python executable and model files, so review those settings before trusting a workspace. Model-contract checks are not a sandbox for untrusted model files.

Configure these editor settings:

1. `kokoreader.pythonPath`: an absolute Python 3.11+ executable with the requirements installed.
2. `kokoreader.modelDir`: the downloaded model directory, or both `kokoreader.modelPath` and `kokoreader.voicesPath`.
3. `kokoreader.modelPrecision`: `fp32` by default, or `fp16`/`int8` when the matching model asset was downloaded.
4. `kokoreader.profile` defaults to `technical`; set it to `narrative` to announce, rather than read, fenced code. The setting applies to Read, Read From Cursor, and Save to File.
5. `kokoreader.lang` is a dropdown of Kokoro-82M’s nine voice languages. Set `kokoreader.voice` manually to a matching installed voice; use `kokoreader --list --lang CODE` to inspect matches. The interactive language and filtered voice commands are deferred.
6. Optionally set playback controls below, and `kokoreader.debug` to reveal Python worker errors.

Right-click an editor tab for **Read**, **Read From Cursor**, **Pause**, **Resume**, **Stop**, or **Save to File**. On the active editor, **Read** and **Save to File** use its current in-memory selection when one exists, otherwise its current in-memory document, so unsaved edits are included. A command invoked for another tab reads that tab’s saved file rather than silently using the active editor. **Read From Cursor** ignores any selection and speaks from the exact active cursor position through the end of the current in-memory document, so it can start mid-word. **Save to File** uses `kokoreader.format` to select WAV, MP3, FLAC, or Opus; it is unavailable while reading, and only one export or pending save dialog can run at a time. **Stop** cancels either safely before an export process or private temporary input is created. The same guards apply to Command Palette commands, and a dialog failure restores the commands immediately. The status bar shows activity and stops active playback when clicked. **Pause** mutes at once and **Resume** replays the current paragraph from where it stopped, so a word or two can repeat.

## Voice quality and performance controls

### Implemented controls

| Setting | Effect |
| --- | --- |
| `voice` / `VOICE` / `--voice` | Selects Kokoro timbre and style. |
| `lang` / `LANG` / `--lang` | Selects language and phonemization behavior. VS Code offers Kokoro-82M’s supported languages; the CLI accepts any installed **espeak-ng** code. |
| `profile` / `PROFILE` / `-p`, `--profile` | Selects `technical` (read closed code fences) or `narrative` (announce them). |
| `speed` / `SPEED` / `--speed` | Changes Kokoro synthesis speed within 0.5-2.0. |
| `threads` / `THREADS` / `--threads` | Caps ONNX Runtime inference threads; keep `0` for the current default because listening tests found longer synthesis pauses with 2 and 4. |
| `tempo` / `TEMPO` / `--tempo` | Changes final playback speed while preserving pitch. |
| `gain` / `GAIN` / `--gain` | Sets output headroom in dB. |
| `volume` / `VOLUME` / `--volume` | Sets final loudness multiplier. |
| `format` / `FORMAT` / `--format` | Selects WAV, MP3, FLAC, or Opus for saved audio. |
| `sampleRate` / `SAMPLE_RATE` / `--sample-rate` | Converts saved audio; `0` preserves Kokoro’s source rate. |
| `normalize` / `NORMALIZE` / `--normalize` | Applies EBU R128 loudness normalization. |
| `limiter` / `LIMITER` / `--limiter` | Caps peaks after gain, tempo, and optional normalization. |
| `pronunciationsPath` / `PRONUNCIATIONS_PATH` / `--pronunciations` | Applies literal source-phrase replacements before Markdown and technical-token processing. |
| `modelDir`, `modelPath`, `voicesPath`, `modelPrecision` | Chooses installed model assets and FP32/FP16/INT8 precision. |
| `pythonPath` | Chooses the Python inference environment. |

### Languages, voices, and mismatch warnings

`--lang` is an espeak-ng code, not Kokoro's documented language letter. Match it to the language of the text as well as the voice: Japanese text should use `--lang ja` and a `j`-initial Japanese voice. Safe chunking prevents the 510-phoneme bounds failure but cannot make Japanese pronounced through `en-us` sound correct. Mixed-language text is not automatically routed to multiple G2P pipelines. A punctuation-free run is hard-split without dropping text, which can make that boundary sound less natural. `VOICE_LANGS` in `python/kokoro_worker.py` maps each Kokoro voice initial to the code its voices were trained for:

| Voice | Language | `--lang` |
| --- | --- | --- |
| `af_*`, `am_*` | American English | `en-us` |
| `bf_*`, `bm_*` | British English | `en-gb` |
| `ef_*`, `em_*` | Spanish | `es` |
| `ff_*` | French | `fr-fr` |
| `hf_*`, `hm_*` | Hindi | `hi` |
| `if_*`, `im_*` | Italian | `it` |
| `jf_*`, `jm_*` | Japanese | `ja` |
| `pf_*`, `pm_*` | Brazilian Portuguese | `pt-br` |
| `zf_*`, `zm_*` | Mandarin Chinese | `cmn` |

The following Kokoro-82M v1.0 inventory and overall grades are derived from upstream [`VOICES.md`](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md). Grades estimate training-data quality and quantity, not a universal listening-quality ranking. “Not published” means upstream does not provide an overall grade for that voice. Custom or partial local `voices-v1.0.bin` assets can differ; use `--list` to inspect what is installed.

| Name | Grade | Language |
| --- | --- | --- |
| `af_heart` | A | American English |
| `af_alloy` | C | American English |
| `af_aoede` | C+ | American English |
| `af_bella` | A- | American English |
| `af_jessica` | D | American English |
| `af_kore` | C+ | American English |
| `af_nicole` | B- | American English |
| `af_nova` | C | American English |
| `af_river` | D | American English |
| `af_sarah` | C+ | American English |
| `af_sky` | C- | American English |
| `am_adam` | F+ | American English |
| `am_echo` | D | American English |
| `am_eric` | D | American English |
| `am_fenrir` | C+ | American English |
| `am_liam` | D | American English |
| `am_michael` | C+ | American English |
| `am_onyx` | D | American English |
| `am_puck` | C+ | American English |
| `am_santa` | D- | American English |
| `bf_alice` | D | British English |
| `bf_emma` | B- | British English |
| `bf_isabella` | C | British English |
| `bf_lily` | D | British English |
| `bm_daniel` | D | British English |
| `bm_fable` | C | British English |
| `bm_george` | C | British English |
| `bm_lewis` | D+ | British English |
| `ef_dora` | Not published | Spanish |
| `em_alex` | Not published | Spanish |
| `em_santa` | Not published | Spanish |
| `ff_siwis` | B- | French |
| `hf_alpha` | C | Hindi |
| `hf_beta` | C | Hindi |
| `hm_omega` | C | Hindi |
| `hm_psi` | C | Hindi |
| `if_sara` | C | Italian |
| `im_nicola` | C | Italian |
| `jf_alpha` | C+ | Japanese |
| `jf_gongitsune` | C | Japanese |
| `jf_nezumi` | C- | Japanese |
| `jf_tebukuro` | C | Japanese |
| `jm_kumo` | C- | Japanese |
| `pf_dora` | Not published | Brazilian Portuguese |
| `pm_alex` | Not published | Brazilian Portuguese |
| `pm_santa` | Not published | Brazilian Portuguese |
| `zf_xiaobei` | D | Mandarin Chinese |
| `zf_xiaoni` | D | Mandarin Chinese |
| `zf_xiaoxiao` | D | Mandarin Chinese |
| `zf_xiaoyi` | D | Mandarin Chinese |
| `zm_yunjian` | D | Mandarin Chinese |
| `zm_yunxi` | D | Mandarin Chinese |
| `zm_yunxia` | D | Mandarin Chinese |
| `zm_yunyang` | D | Mandarin Chinese |

List every code the installed espeak-ng build accepts, plus the voice counts for the assets in `--model-dir`:

```sh
node bin/kokoreader.js --list-languages
```

espeak-ng does the phonemization, so three failures are otherwise visible only in the audio. Each is reported once per run on stderr as `Kokoreader: ...` and playback continues:

- **Foreign script under a Latin-only code** (Han, kana, Hangul, Cyrillic, Greek, Arabic, Hebrew, Devanagari, Thai): espeak-ng spells the characters out in English, so `世界` becomes "chinese letter". Set `--lang` to the language of the text.
- **A language switch inside one paragraph**: espeak-ng marks it `(en)`-style and Kokoro's vocabulary filter keeps the letters inside the brackets as phonemes.
- **Phonemes outside Kokoro's vocabulary**: reported as a percentage. Mandarin loses its tone digits this way (about 22%); `yue` loses less. `cmn-latn-pinyin` resolves to the same espeak-ng voice as `cmn`, so Latin pinyin is still read as English.

Japanese and Mandarin are the weakest pairings: upstream trains them with misaki and publishes no espeak-ng fallback, and `kokoro-onnx` does not use misaki.

## Troubleshooting

| Symptom | Cause and action |
| --- | --- |
| `spawn .../bin ENOENT` | `PYTHON_PATH` is a directory. Use a Python executable. |
| `No module named 'kokoro_onnx'` | Install requirements with the exact configured interpreter. |
| `requires onnxruntime 1.28.0 or newer` | Reinstall `python/requirements.txt` with the configured interpreter. Intel/older macOS has no official baseline wheel; do not downgrade around the guard. |
| `model not found` | Run `--download` with `--model-dir`, or correct model paths. |
| No audio | Verify `ffplay -version` and audio output. Try `--output test.wav` first. |
| Resume repeats a word or two | Expected. `ffplay` cannot be paused in place, so Pause ends its player and Resume replays the paragraph from the remembered position, about 0.8 s back. |
| A short click at Pause | Expected, and the point of ending the player: it replaces the word `ffplay` used to stutter out while frozen. Measured on macOS as subtle; expected to be most audible on Windows, where the process is terminated abruptly. |
| `speed must be between 0.5 and 2.0` | Kokoro synthesis limit. Keep `speed` in range and use `tempo` for faster or slower playback. |
| `lang "zh" is not supported by espeak-ng` | `--lang` takes espeak-ng codes, not Kokoro's: Mandarin is `cmn`, Cantonese is `yue`. Run `--list-languages` for the full set. |
| `Kokoreader: espeak-ng cannot read ... (Latin dictionaries only)` | The text is not Latin script but `--lang` is a Latin-only code. Set `--lang` to the language of the text. |
| `Kokoreader: espeak-ng read part of this text as ...` | The paragraph mixes languages and espeak-ng switched. Split the text, or set `--lang` to the dominant language. |
| `Kokoreader: NN% of the phonemes ... were dropped` | Expected for `cmn`/`yue`: tone digits and vowels are outside Kokoro's vocabulary. Non-Latin output quality is limited by espeak-ng, not by Kokoreader. |
| `does not match the kokoro-onnx model-files-v1.0 release` | The asset is stale or truncated. Rerun with `--download --force` to replace it. |
| Worker error | Check the reported error; retry with `--debug` for additional Python diagnostics. |

## Known bugs

Hardening remains in progress. Windows verification is deferred until a device is available, not passed or waived. Packaged lifecycle checks, native pinned Linux downloads, local TLS failure probes, and Node 20/22 download-close regressions pass. Manual UI/listening acceptance remains pending; the tested ONNX Runtime 1.28.0 baseline is now enforced. Voice/model guards do not certify arbitrary custom graph/vocabulary pairings. Japanese and Mandarin quality remains a documented engine limitation.

## Credits and licensing

Kokoreader is an independent wrapper inspired by and built around the same Kokoro ONNX inference approach as [Kokoro TTS](https://github.com/nazdridoy/kokoro-tts), created by [Nazmul Hossain (@nazdridoy)](https://github.com/nazdridoy). Thank you for the MIT-licensed design reference; no source code was copied or translated from it.

Kokoreader's original source is [MIT-licensed](LICENSE). It uses [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) and [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), but its current packages do not include Python dependencies, native libraries, model/voice assets or FFmpeg. Users install dependencies and download assets directly from upstream; shipping this wrapper does not redistribute those copies.

The Python worker uses GPL-licensed phonemizer-fork/eSpeak NG. [MIT is GPL-compatible](https://www.gnu.org/licenses/license-list.html#Expat), so original wrapper source can remain MIT; a redistributed combined runtime must still follow the GPL. If you later bundle or mirror dependencies, preserve their applicable licences/notices and provide corresponding source where the GPL requires it. Redistributing Apache-2.0 model/voice assets requires their applicable licence and notices, not training attestations. These are conditional packaging duties, not missing notices for the current unbundled wrapper.

The pinned ONNX matches its [converter origin](https://github.com/taylorchu/kokoro-onnx/releases/tag/v0.2.0), and repacking all 54 original voice tensors reproduces the pinned voice file exactly. Such provenance checks provide supply-chain assurance; the inspected licences do not require upstream build/training attestations or an independent training-data audit to use or distribute this wrapper.
