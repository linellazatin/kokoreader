# Kokoreader

## What this is

Kokoreader reads text and Markdown aloud using local Kokoro inference. It provides:

- A Node.js CLI for files and pipelines.
- A VS Code/VSCodium extension for reading an editor selection, a whole tab, or from the cursor through the rest of a document.
- Audio export in WAV, MP3, FLAC, or Opus formats.

After one-time dependency and model downloads, synthesis runs locally without an account, API key, text upload, or cloud inference service.

Long-document playback phonemizes text, splits it below Kokoro’s model boundary, and keeps an upcoming unit synthesized while the current unit plays. Source paragraphs retain an 800 ms gap in live playback and saved audio; safe internal splits do not add paragraph pauses.

Markdown structure is handled before speech: formatting, links, images, and HTML are removed. Block quotes are announced as “Quote.”, task items as “Checked item.” or “Unchecked item.”, and regular list items retain an item marker.

## Commands

The package exposes this test command:

```sh
npm test
```

It runs:

```sh
node test/cli.js
```

## Architecture

The repository is organized around the CLI and editor extension, with local Kokoro inference and supporting research/configuration material:

- `bin/` — command-line implementation.
- `extension/` — VS Code/VSCodium extension code.
- `kkr-models/` — model-related assets.
- `python/` — Python support code.
- `images/` — image assets.
- `config/` — configuration files.
- `test/` — test runner and test files.
- `research/`, `research_kokoro_bounds/`, `research_workflow_pinning/` — research and workflow material.
- `.github/`, `.nanomneme/`, `.superpowers/` — repository support directories.

## Configuration and installation

The project uses `package.json` for its Node.js package metadata and scripts. Local inference requires one-time dependency and model downloads, as described by the project documentation. Configuration-related files are under `config/`; inspect their contents before changing runtime behavior.

## Testing and operational quirks

Run `npm test` after changes affecting the CLI or shared behavior. The implementation is designed for long documents and must preserve Kokoro’s model-boundary handling and paragraph timing. Avoid adding pauses when a paragraph is internally split into multiple synthesis units.

Keep secrets and generated output out of tracked configuration.

## Key files

- `README.md` — product behavior and user-facing feature description.
- `package.json` — package metadata and commands.
- `bin/` — CLI implementation.
- `extension/` — editor integration.
- `test/cli.js` — command invoked by the test script.
- `config/` — runtime configuration area.
- `kkr-models/` — model assets.
- `AGENTS.md` — repository-specific agent instructions.
<!-- opl-init:fp c5a1e712ed5e40dc -->
