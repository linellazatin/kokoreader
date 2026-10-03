# Kokoreader

## What this is

Kokoreader reads text and Markdown aloud using local Kokoro inference. It provides:

- A Node.js CLI for files and pipelines.
- A VS Code/VSCodium extension for reading an editor selection, whole tab, or text from the cursor onward.
- Audio export in WAV, MP3, FLAC, or Opus formats.

After one-time dependency and model downloads, synthesis runs locally without accounts, API keys, text uploads, or cloud inference.

The reader phonemizes text before synthesis, splits long content below the model boundary, and synthesizes an upcoming unit while the current unit plays. Source paragraphs retain an 800 ms gap; safely split units within a paragraph do not receive additional pauses.

Markdown processing removes formatting, links, images, and HTML before speech while retaining document structure such as announced block quotes.

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

The repository includes both CLI and editor-extension functionality:

- `extension/` contains the VS Code/VSCodium extension.
- `test/` contains CLI tests.
- `kkr-models/` contains model-related assets, including ONNX and binary files.
- `python/` contains Python support code.
- `config/` contains configuration files and sample configuration.
- `bin/` contains executable/support scripts.
- `research/`, `research_kokoro_bounds/`, and `research_workflow_pinning/` contain investigation and workflow material.

## Configuration and installation

Kokoreader requires one-time dependency and model downloads before local inference can run. Inspect `README.md`, `config/`, and the extension configuration before changing installation or runtime behavior.

Keep secrets and generated output out of tracked configuration.

## Testing and operational quirks

Long text handling is central to behavior:

- The first synthesis unit targets an early sentence boundary within 200 phonemes to reduce time to first audio.
- Later units use a 500-phoneme safety boundary.
- Paragraph boundaries produce an 800 ms pause in live playback and saved audio.

Run the narrowest relevant test before running the full suite, and inspect implementation files before changing CLI, Markdown, synthesis, or extension behavior.

## Key files

- `README.md` — user-facing usage and feature documentation.
- `package.json` — Node package scripts, including tests.
- `test/cli.js` — CLI test entry point.
- `extension/` — editor extension implementation.
- `config/` — runtime configuration and sample configuration.
- `kkr-models/` — local model assets.
- `CHANGELOG.md` — release history.
- `AGENTS.md` — repository-specific agent instructions.
<!-- opl-init:fp e67408ad14955ca9 -->
