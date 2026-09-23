# Kokoreader

## What this is

Kokoreader reads text and Markdown aloud using local Kokoro inference. It provides:

- A Node.js CLI for files and pipelines.
- A VS Code/VSCodium extension for reading an editor selection, an entire tab, or text from the cursor onward.
- Audio export for WAV, MP3, FLAC, and Opus.

Synthesis is local after one-time dependency and model downloads; it does not require an account, API key, text upload, or cloud inference service.

The reader phonemizes text before synthesis, splits long content below Kokoro’s model boundary, and prepares an upcoming unit while the current unit plays. Source paragraphs retain an 800 ms gap in live and saved audio, while internal split units do not receive extra paragraph pauses.

Markdown handling removes formatting, links, images, and HTML. Closed triple-backtick code blocks are skipped and announced rather than read aloud.

## Commands

Run the test suite:

```sh
npm test
```

This executes:

```sh
node test/cli.js
```

## Architecture

The repository contains both the Node.js CLI and the editor extension, with local model assets and Python support code.

- `extension/` contains the VS Code/VSCodium extension.
- `bin/` contains CLI-related files.
- `python/` contains Python code used by the local inference workflow.
- `kkr-models/` contains Kokoro model assets, including `.onnx` and `.bin` files.
- `test/` contains CLI tests.
- `config/` contains configuration files.
- `docs/`, `images/`, and `research*/` contain documentation, images, and research material.

The top-level `package.json` defines the available npm scripts.

## Configuration and installation

Kokoreader relies on one-time dependency and model downloads before local synthesis can run. Inspect the relevant configuration and installation files before changing setup behavior:

- `config/` for configuration files, including `.conf` and `.sampleconf`.
- `kkr-models/` for bundled or downloaded model assets.
- `package.json` for Node.js package behavior.
- `extension/` for editor-extension configuration.

Keep secrets and generated output out of tracked configuration.

## Testing and operational quirks

Use the narrowest relevant test while making a focused change, then run `npm test` when appropriate.

Long text behavior is intentional: content is phonemized and split safely before synthesis to avoid model-boundary failures. Playback is pipelined to reduce pauses between synthesized units, and paragraph timing differs from internal chunk timing. Preserve these distinctions when modifying text processing or audio playback.

Markdown code blocks are intentionally not spoken verbatim when they are closed triple-backtick blocks; they are announced to keep listeners oriented.

## Key files

- `README.md` / `readme.md` — project overview and user-facing behavior.
- `package.json` — npm scripts; currently defines `test`.
- `test/cli.js` — CLI test entry point.
- `extension/` — VS Code/VSCodium extension implementation.
- `bin/` — CLI-related implementation.
- `python/` — Python inference support.
- `kkr-models/` — local Kokoro model files.
- `config/` — configuration and sample configuration.
- `CHANGELOG.md` — release history.
- `AGENTS.md` — repository-specific agent instructions.
<!-- opl-init:fp 94ae4eeff5f75140 -->
