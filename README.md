# Kokoreader

Kokoreader reads text and Markdown aloud with local Kokoro inference. It provides a Node.js CLI and a VS Code/VSCodium extension for an editor tab or selection. Synthesis is local: no account, API key, or cloud service is used after one-time dependency and model downloads.

## Repository layout

| Path | Contents |
| --- | --- |
| `bin/` | CLI entry point. |
| `extension/` | VS Code/VSCodium extension entry point. |
| `python/` | Kokoro worker and Python requirements. |
| `config/` | Sample CLI configuration. |
| `test/` | Node-based checks. |

## CI and releases

Pull requests run the CLI tests, runtime syntax checks, and VSIX packaging. Pushing a `v<package-version>` tag runs the same validation job, then publishes its validated VSIX artifact with the matching changelog section as GitHub release notes.

## Compatibility

| Surface | Supported target | Notes |
| --- | --- | --- |
| CLI | macOS, Linux, Windows | Needs Node.js, Python 3.11+, and ffmpeg. Live playback also needs ffplay. |
| Extension | VS Code and VSCodium 1.75+ | Runs the bundled CLI through the editor's Node runtime. |
| CPU | macOS Apple silicon or Intel, Windows x64, Linux x64 | Uses the CPU ONNX Runtime package. |
| Linux ARM64 | Best effort | Matching Python and ONNX Runtime wheels must be available. |
| Save to File | Any supported CLI platform with ffmpeg | No audio device or ffplay required. |
| Remote/headless editor | Save to File, by default | Live playback requires an audio device where the extension host runs. |

Windows pause/resume uses PowerShell. Kokoreader is not a mobile, browser, or web-extension tool.

## Requirements

- Node.js 20 or newer
- Python 3.11 or newer
- `pip3` for that same Python interpreter
- ffmpeg, including `ffplay` for live playback
- About 340 MB free for default model files, plus generated audio

Kokoreader pins its inference dependency in [python/requirements.txt](python/requirements.txt). The configured Python and ffmpeg must be accessible to the CLI, and to the GUI application's environment when using the extension.

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

This downloads `kokoro-v1.0.onnx` and `voices-v1.0.bin`. Downloads happen only when explicitly requested, never while reading. If a download fails, remove its partial `.download` file and rerun the command.

FP32 is the default. To explicitly download FP16 or INT8 instead:

```sh
node bin/kokoreader.js -md kkr-models -mp fp16 -d
node bin/kokoreader.js -md kkr-models -mp int8 -d
```

Set the same `MODEL_PRECISION` in configuration or `kokoreader.modelPrecision` in the extension before using a non-FP32 model from `modelDir`.

### 6. Configure the CLI

Copy [config/kokoreader.sampleconf](config/kokoreader.sampleconf) to `config/kokoreader.conf`, then set absolute paths:

```conf
MODEL_DIR=/path/to/kokoro-models
MODEL_PRECISION=fp32
PYTHON_PATH=/path/to/python3
VOICE=af_heart
LANG=en-us
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

Expect paragraph progress. Kokoreader synthesizes each paragraph before playing it. With a file input, a controlling process can send `pause`, `resume`, and `stop` through stdin. With no file, stdin is text input:

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
| `-v`, `--voice NAME`; `-l`, `--lang CODE`; `-s`, `--speed N` | Voice, language, and Kokoro speed. |
| `-t`, `--tempo N`; `-g`, `--gain DB`; `-vol`, `--volume N` | Final playback controls. |
| `-f`, `--format TYPE`; `-sr`, `--sample-rate HZ` | Saved format and sample rate. |
| `-n`, `--normalize`; `-nn`, `--no-normalize` | Enable or disable EBU R128 normalization. |
| `-lim`, `--limiter`; `-nlim`, `--no-limiter` | Enable or disable final peak limiting. |
| `-o`, `--output FILE` | Save audio instead of playing. Use an extension that matches `--format`. |
| `-sp`, `--start-para N` | Start at one-based paragraph N. |
| `-d`, `--download` | Download selected assets to `--model-dir`. |
| `-ls`, `--list`; `-dbg`, `--debug` | List voices or show worker errors. |

Input is plain text or Markdown. Formatting, links, images, fenced code blocks, and HTML tags are removed before synthesis.

## VS Code and VSCodium setup

The repository currently contains extension source. Install a packaged `.vsix` once one is built, or use an Extension Development Host when developing locally.

Configure these editor settings:

1. `kokoreader.pythonPath`: an absolute Python 3.11+ executable with the requirements installed.
2. `kokoreader.modelDir`: the downloaded model directory, or both `kokoreader.modelPath` and `kokoreader.voicesPath`.
3. `kokoreader.modelPrecision`: `fp32` by default, or `fp16`/`int8` when the matching model asset was downloaded.
4. Optionally set voice and playback controls below.

Right-click an editor tab for **Read**, **Read From Cursor**, **Pause**, **Resume**, **Stop**, or **Save to File**. **Read** speaks the selection when one exists, otherwise the file. **Read From Cursor** ignores any selection and speaks from the exact active cursor position through the end of the current in-memory document, so it can start mid-word. **Save to File** uses `kokoreader.format` to select WAV, MP3, FLAC, or Opus. The status bar shows activity and stops active playback when clicked.

## Voice quality and performance controls

### Available now

| Setting | Effect | Viability |
| --- | --- | --- |
| `voice` / `VOICE` / `--voice` | Selects Kokoro timbre and style. | Implemented. |
| `lang` / `LANG` / `--lang` | Selects language/phonemization behavior. Match it to voice and text. | Implemented. |
| `speed` / `SPEED` / `--speed` | Changes Kokoro synthesis speed. | Implemented. |
| `tempo` / `TEMPO` / `--tempo` | Changes final speed while preserving pitch. | Implemented; use moderate values for best quality. |
| `gain` / `GAIN` / `--gain` | Sets output headroom in dB. Negative gain reduces clipping risk. | Implemented. |
| `volume` / `VOLUME` / `--volume` | Sets final loudness multiplier. | Implemented. |
| `format` / `FORMAT` / `--format` | Selects WAV, MP3, FLAC, or Opus for saved audio. | Implemented. |
| `sampleRate` / `SAMPLE_RATE` / `--sample-rate` | Converts only saved audio; `0` preserves Kokoro's source rate. | Implemented. |
| `normalize` / `NORMALIZE` / `--normalize` | Applies EBU R128 loudness normalization. | Implemented; off by default because it changes intended loudness. |
| `limiter` / `LIMITER` / `--limiter` | Caps peaks after gain, tempo, and optional normalization. | Implemented; on by default. |
| `modelDir`, `modelPath`, `voicesPath`, `modelPrecision` | Chooses installed model assets and FP32/FP16/INT8 precision. | Implemented. |
| `pythonPath` | Chooses the Python inference environment. | Implemented. |

### Viable additions, not exposed yet

| Control | Value | Viability |
| --- | --- | --- |
| Weighted two-voice blend | `voiceA:60,voiceB:40` | Viable. Kokoro exposes voice-style vectors; the worker needs blend parsing and validation. |
| Editor voice/language picker | Quick-pick settings | Viable. The worker already lists voices; language listing needs one request. |
| Execution provider | CPU, CUDA, CoreML, DirectML, OpenVINO | Viable only with direct ONNX Runtime session control. The current worker uses the wrapper's default CPU provider. |
| Thread counts | ONNX intra/inter-op limits | Viable only after direct session control. |
| Prefetch/chunk size | Generation latency vs. memory | Viable; does not change model voice quality. |
| Paragraph silence/fades | Gap and boundary behavior | Viable through ffmpeg. |

Piper noise scales, speaker IDs, and phoneme-length scale have no Kokoro equivalent and should not be exposed.

## Troubleshooting

| Symptom | Cause and action |
| --- | --- |
| `spawn .../bin ENOENT` | `PYTHON_PATH` is a directory. Use a Python executable. |
| `No module named 'kokoro_onnx'` | Install requirements with the exact configured interpreter. |
| `model not found` | Run `--download` with `--model-dir`, or correct model paths. |
| No audio | Verify `ffplay -version` and audio output. Try `--output test.wav` first. |
| Worker error | Retry with `--debug` to reveal the Python exception. |

## Credits and licensing

Kokoreader is an independent wrapper inspired by and built around the same Kokoro ONNX inference approach as [Kokoro TTS](https://github.com/nazdridoy/kokoro-tts), created by [Nazmul Hossain (@nazdridoy)](https://github.com/nazdridoy). Thank you for the MIT-licensed reference implementation, CLI design, model-download guidance, and voice behavior.

Kokoreader uses [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) for inference and [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model assets. Review their licenses and notices before redistributing bundled dependencies or model files.
