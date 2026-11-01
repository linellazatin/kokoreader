'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const expected = [
    'package.json', 'LICENSE', 'README.md', 'CHANGELOG.md',
    'bin/kokoreader.js', 'config/kokoreader.sampleconf', 'extension/extension.js',
    'images/openlines.png', 'python/kokoro_worker.py', 'python/requirements.txt',
];
const localFiles = [
    'logs/err.jsonl', 'logs/err.jsonl.1', '.venv/audit-marker.txt',
    'python/venv/audit-marker.txt', '.private/audit-marker.txt',
    'config/kokoreader.conf', 'nested/local.conf', 'nested/custom.sampleconf',
    '.kokoreader-export-audit/audio.part', '.kokoreader-download-audit/asset.download',
    'kkr-models/audit.onnx', 'kkr-models/audit.bin', 'nested/__pycache__/audit.pyc',
    'generated.wav', 'generated.mp3', 'generated.flac', 'generated.opus',
    'bin/local.js', 'extension/local.js', 'python/local.py', 'images/local.png',
];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoreader-package-test-'));
try {
    for (const file of [...expected, '.vscodeignore']) {
        const target = path.join(directory, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), target);
    }
    for (const file of localFiles) {
        const target = path.join(directory, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'package audit fixture only\n');
    }
    const result = spawnSync('vsce', ['ls'], { cwd: directory, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(result.status, 0, result.error ? result.error.message : result.stderr);
    const files = result.stdout.trim().split(/\r?\n/).sort();
    assert.deepStrictEqual(files, expected.slice().sort(), 'VSIX file selection includes local state or omits a required file');
    console.log('PASS VSIX file selection excludes local state and includes every distribution file');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
