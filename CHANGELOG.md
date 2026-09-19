# Changelog

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
