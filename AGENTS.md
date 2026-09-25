# Kokoreader

## What this is

Kokoreader reads text and Markdown aloud using local Kokoro inference. It provides:

- A Node.js CLI for files and pipelines.
- A VS Code/VSCodium extension for reading an editor selection, an entire tab, or text from the cursor onward.
- Audio export for WAV, MP3, FLAC, and Opus.

Synthesis is local after one-time dependency and model downloads; it does not require an account, API key, text upload, or cloud inference service.

The reader phonemizes text before synthesis, splits long content below Kokoro’s model boundary, and prepares an upcoming unit while the current unit plays. Source paragraphs retain an 800 ms gap in live and saved audio, while internal split units do not receive extra paragraph pauses.

Markdown handling removes formatting, links, images, and HTML. Block quotes, including quoted task lists, task-list state, and list items receive spoken structural markers. The default technical profile says “The code is - ” then reads closed triple-backtick code blocks; narrative announces them instead. Speech-inserted Markdown labels are localized for `en-us`, `en-gb`, `es`, `fr-fr`, `hi`, `it`, `ja`, `pt-br`, and `cmn`, with English fallback; technical-token normalization remains English. Inline backtick code always uses technical-token normalization. Well-formed GitHub-flavored pipe tables, including one-column tables, become a column announcement and labeled row paragraphs in both profiles; malformed tables remain source text.

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

Technical-mode Markdown code blocks are read after “The code is - ” by default. Narrative mode is available when closed triple-backtick blocks should instead be announced to keep listeners oriented.

Well-formed GitHub-flavored pipe tables are spoken semantically in both profiles: columns are announced once, then each data row is read as labeled cells and gets the normal source-paragraph gap. Preserve malformed tables as source text.

The extension exports the active editor’s in-memory selection, or its in-memory document when no selection exists, through a private temporary input. A command targeting another editor tab must use that tab’s URI instead. Only one export or pending save dialog can run at a time, and saving must remain unavailable while reading; command handlers must enforce the same rule for Command Palette calls. The saving context keeps Read and Save unavailable while leaving Stop available. Create the temporary input only after the dialog resolves, restore saving state if the dialog rejects, and ensure cancellation or deactivation cannot leak it. Cleanup must remain tied to reader and save-process completion, cancellation, and deactivation.

The VS Code language setting is a static dropdown for Kokoro-82M’s nine voice languages. Voice remains a manual setting until the deferred interactive filtered picker is added; use CLI `--list --lang CODE` to discover installed voices matching a language. CLI language and voice input remain flexible for advanced espeak-ng use.

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
