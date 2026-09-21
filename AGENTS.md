# Repository Guide

## What this is

Kokoreader is a local text-to-speech tool that reads text and Markdown aloud using Kokoro inference. It provides two primary interfaces:
1.  A **Node.js CLI** for command-line usage.
2.  A **VS Code/VSCodium extension** for reading editor tabs or selections.

Synthesis is performed locally; no account, API key, or cloud service is required after the initial download of dependencies and models. The project supports macOS (Apple silicon/Intel), Windows (x64), and Linux (x64, with best-effort ARM64 support).

## Architecture

The repository is structured to separate the Node.js orchestration from the Python-based inference engine:

*   **`bin/`**: Contains the CLI entry point.
*   **`extension/`**: Contains the VS Code/VSCodium extension entry point. This runs the bundled CLI through the editor's Node runtime.
*   **`python/`**: Houses the Kokoro worker script and Python requirements (`requirements.txt`). This component handles the actual speech synthesis via ONNX Runtime.
*   **`config/`**: Stores sample configuration files for the CLI.
*   **`test/`**: Contains Node-based checks and test scripts.
*   **`kkr-models/`**: Likely stores model weights or related assets (indicated by `.onnx` and `.bin` files in inventory).

### Playback Mechanism
Live playback relies on `ffmpeg` and `ffplay`. Since `ffplay` cannot be paused in place, the "Pause" function terminates the current `ffmpeg`/`ffplay` process pair. "Resume" replays the same paragraph from a remembered offset. This behavior has been verified on macOS, while Linux and Windows are expected to function similarly but rely on standard process management rather than platform-specific suspend APIs. For remote or headless editors where audio devices are unavailable, the system defaults to "Save to File," which only requires `ffmpeg`.

## Configuration and installation

### Prerequisites
*   **Node.js**: Required for the CLI and Extension host.
*   **Python 3.11+**: Required for the inference worker.
*   **ffmpeg**: Required for all audio processing.
*   **ffplay**: Required specifically for live playback features.

### Installation Notes
*   **CPU Inference**: Uses the CPU ONNX Runtime package.
*   **Linux ARM64**: Support is best-effort; matching Python and ONNX Runtime wheels must be available for the specific architecture.
*   **Extension Compatibility**: Supports VS Code and VSCodium version 1.75+.

## Commands

The following npm scripts are defined in `package.json`:

```bash
npm run test
```

This executes `node test/cli.js`, which runs the Node-based test suite.

## Key files

*   `package.json`: Defines scripts, dependencies, and metadata for the Node.js components.
*   `README.md`: Primary documentation including compatibility tables and usage instructions.
*   `AGENTS.md`: Context for AI agents working on this repository.
*   `CHANGELOG.md`: History of changes.
*   `LICENSE`: Project licensing information.
*   `.gitignore` / `.vscodeignore`: Exclusion rules for version control and packaging.
*   `config/`: Sample configuration files (e.g., `.conf`, `.sampleconf`).
*   `python/`: Worker scripts (`.py`) and requirements (`.txt`).
<!-- opl-init:fp 65c187abe81a2b0d -->
