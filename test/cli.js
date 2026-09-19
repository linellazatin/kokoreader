'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'kokoreader.js');
let passed = 0;
let failed = 0;

function run(label, fn) {
    try { fn(); console.log(`PASS ${label}`); passed++; }
    catch (error) { console.error(`FAIL ${label}: ${error.message}`); failed++; }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function cli(args, options = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        input: options.input,
        env: { ...process.env, ...options.env },
    });
}

run('--help describes the Kokoro reader CLI', () => {
    const result = cli(['--help']);
    assert(result.status === 0, `exit ${result.status}: ${result.stderr}`);
    assert(result.stdout.includes('Usage: kokoreader'), 'missing usage');
    assert(result.stdout.includes('--voice'), 'missing voice option');
});

run('--help exposes output processing controls', () => {
    const result = cli(['--help']);
    assert(result.status === 0, `exit ${result.status}: ${result.stderr}`);
    for (const option of ['--format', '--sample-rate', '--normalize', '--limiter']) {
        assert(result.stdout.includes(option), `missing ${option}`);
    }
});

run('--help exposes compact aliases and model precision', () => {
    const result = cli(['--help']);
    assert(result.status === 0, `exit ${result.status}: ${result.stderr}`);
    for (const option of ['-md', '-mp', '--model-precision', '-sr', '-lim']) {
        assert(result.stdout.includes(option), `missing ${option}`);
    }
});

run('invalid model precision is rejected before download', () => {
    const result = cli(['-md', '/tmp/kokoreader-test', '-mp', 'broken', '--download']);
    assert(result.status !== 0, 'invalid precision unexpectedly succeeded');
    assert(result.stderr.includes('model-precision must be fp32, fp16, or int8'), `stderr: ${result.stderr}`);
});

run('unknown options exit non-zero', () => {
    const result = cli(['--not-real']);
    assert(result.status !== 0, 'unknown option unexpectedly succeeded');
    assert(result.stderr.includes('Unknown option'), `stderr: ${result.stderr}`);
});

run('missing input file exits non-zero', () => {
    const result = cli(['/missing/kokoreader-input.txt']);
    assert(result.status !== 0, 'missing file unexpectedly succeeded');
    assert(result.stderr.includes('Error:'), `stderr: ${result.stderr}`);
});

run('extension manifest exposes read, playback, and save commands', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const commands = manifest.contributes.commands.map(command => command.command);
    for (const command of ['kokoreader.readFile', 'kokoreader.readFromCursor', 'kokoreader.pause', 'kokoreader.resume', 'kokoreader.stop', 'kokoreader.saveFile']) {
        assert(commands.includes(command), `missing ${command}`);
    }
});

run('extension save command and format setting are format-neutral', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const save = manifest.contributes.commands.find(command => command.command === 'kokoreader.saveFile');
    assert(save.title.endsWith('Save to File'), `unexpected title: ${save.title}`);
    assert(manifest.contributes.configuration.properties['kokoreader.format'].description.includes('Save to File'), 'format setting does not describe Save to File');
});

run('cursor command reads from the active cursor through document end', () => {
    const source = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8');
    assert(source.includes("registerCommand('kokoreader.readFromCursor'"), 'missing cursor command registration');
    assert(source.includes('editor.selection.active'), 'cursor command does not use active cursor');
    assert(source.includes('new vscode.Range(cursor, end)'), 'cursor command does not read through document end');
});

run('extension manifest exposes output processing settings', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const settings = manifest.contributes.configuration.properties;
    for (const setting of ['kokoreader.format', 'kokoreader.sampleRate', 'kokoreader.normalize', 'kokoreader.limiter', 'kokoreader.modelPrecision']) {
        assert(settings[setting], `missing ${setting}`);
    }
});

run('extension settings have an intentional setup-to-output order', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const settings = manifest.contributes.configuration.properties;
    const ordered = [
        'kokoreader.pythonPath', 'kokoreader.modelDir', 'kokoreader.modelPath', 'kokoreader.voicesPath', 'kokoreader.modelPrecision',
        'kokoreader.voice', 'kokoreader.lang', 'kokoreader.speed',
        'kokoreader.tempo', 'kokoreader.gain', 'kokoreader.volume',
        'kokoreader.format', 'kokoreader.sampleRate', 'kokoreader.normalize', 'kokoreader.limiter'
    ];
    assert(ordered.every((setting, index) => settings[setting].order === index + 1), 'settings are not explicitly ordered');
});

run('runtime source uses the organized project layout', () => {
    for (const file of ['bin/kokoreader.js', 'extension/extension.js', 'python/kokoro_worker.py', 'python/requirements.txt', 'config/kokoreader.sampleconf']) {
        assert(fs.existsSync(path.join(ROOT, file)), `missing ${file}`);
    }
    assert(!fs.existsSync(path.join(ROOT, 'kokoreader.js')), 'CLI remains at the project root');
    assert(!fs.existsSync(path.join(ROOT, 'extension.js')), 'extension remains at the project root');
});

run('CLI loads its default config from the config directory', () => {
    const source = fs.readFileSync(path.join(ROOT, 'bin', 'kokoreader.js'), 'utf8');
    assert(source.includes("path.join(__dirname, '..', 'config', 'kokoreader.conf')"), 'default config is not in config/kokoreader.conf');
});

run('GitHub workflow validates pull requests before packaging releases', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'main.yml'), 'utf8');
    for (const fragment of ['pull_request:', "tags:\n      - 'v*'", 'npm test', 'node --check bin/kokoreader.js', 'python3 -m py_compile python/kokoro_worker.py', 'vsce package', 'needs: validate', 'softprops/action-gh-release@v2']) {
        assert(workflow.includes(fragment), `missing workflow step: ${fragment}`);
    }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
