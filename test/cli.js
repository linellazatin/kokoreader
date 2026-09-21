'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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
        cwd: options.cwd || ROOT,
        encoding: 'utf8',
        input: options.input,
        env: { ...process.env, ...options.env },
    });
}

// Deterministic 8-byte PCM so tests can count bytes travelling through the pipeline.
const STUB_PCM = Buffer.alloc(8, 1).toString('base64');

// Fake worker plus fake ffmpeg/ffplay on PATH, so inference and audio devices are
// never needed to exercise process lifecycle and streaming behaviour.
function stubs(options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoreader-stub-'));
    const paths = {
        dir, tools: path.join(dir, 'tools'), input: path.join(dir, 'input.txt'),
        worker: path.join(dir, 'worker.js'), events: path.join(dir, 'events.jsonl'),
        model: path.join(dir, 'model.onnx'), voices: path.join(dir, 'voices.bin'),
    };
    fs.mkdirSync(paths.tools);
    fs.writeFileSync(paths.model, 'model');
    fs.writeFileSync(paths.voices, 'voices');
    fs.writeFileSync(paths.input, options.text || 'First paragraph.\n\nSecond paragraph.\n');
    fs.writeFileSync(paths.worker, `#!/usr/bin/env node
const fs = require('fs'), readline = require('readline');
const events = ${JSON.stringify(paths.events)};
const delay = Number(process.env.KKR_STUB_SYNTH_DELAY || 0);
fs.appendFileSync(events, JSON.stringify({ tool: 'worker', pid: process.pid }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(events, line + '\\n');
  const send = () => {
    if (process.env.KKR_STUB_FAIL_TEXT && request.text.includes(process.env.KKR_STUB_FAIL_TEXT)) {
      process.stdout.write(JSON.stringify({ id: request.id, error: 'stub synthesis failed' }) + '\\n');
    } else if (request.action === 'languages') {
      process.stdout.write(JSON.stringify({ id: request.id,
        kokoro: [{ letter: 'a', lang: 'en-us', voices: 20 }, { letter: 'z', lang: 'cmn', voices: 8 }],
        espeak: { 'en-us': 'English (America)', cmn: 'Chinese', foo: 'Foo' } }) + '\\n');
    } else if (request.action === 'list') {
      process.stdout.write(JSON.stringify({ id: request.id, voices: ['af_heart'] }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ id: request.id, pcm: process.env.KKR_STUB_PCM, sampleRate: 24000, warning: process.env.KKR_STUB_WARNING || undefined }) + '\\n');
    }
  };
  delay ? setTimeout(send, delay) : send();
});
`);
    fs.writeFileSync(path.join(paths.tools, 'ffmpeg'), `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(paths.events)}, JSON.stringify({ tool: 'ffmpeg', args: process.argv.slice(2) }) + '\\n');
const out = process.argv[process.argv.length - 1];
const sink = /^pipe:/.test(out) ? null : out;
if (sink) process.stdin.on('data', chunk => fs.appendFileSync(sink, chunk));
process.stdin.on('end', () => process.exit(0));
if (!sink) process.stdin.resume();
`);
    fs.writeFileSync(path.join(paths.tools, 'ffplay'), `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(paths.events)}, JSON.stringify({ tool: 'ffplay', pid: process.pid }) + '\\n');
if (process.env.KKR_STUB_FFPLAY_HOLD === '0') process.stdin.on('end', () => process.exit(0));
if (process.env.KKR_STUB_FFPLAY_HOLD === '1') setInterval(() => {}, 1000);
process.stdin.resume();
`);
    for (const tool of ['ffmpeg', 'ffplay']) fs.chmodSync(path.join(paths.tools, tool), 0o755);
    fs.chmodSync(paths.worker, 0o755);
    return paths;
}

function stubEnv(paths) {
    return { PATH: paths.tools + path.delimiter + process.env.PATH, KKR_STUB_PCM: STUB_PCM };
}

function stubEvents(paths) {
    if (!fs.existsSync(paths.events)) return [];
    return fs.readFileSync(paths.events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function sleepSync(ms) {
    spawnSync('sleep', [String(ms / 1000)]);
}

function waitFor(check, timeout = 5000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const found = check();
        if (found) return found;
        if (Date.now() >= deadline) return null;
        sleepSync(50);
    }
}

function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function cliArgs(paths) {
    return ['--python-path', paths.worker, '--model', paths.model, '--voices', paths.voices];
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

run('invalid playback values are rejected before inference', () => {
    for (const [args, message] of [
        [['--speed', '0'], 'speed must be between 0.5 and 2.0'],
        [['--speed', '3'], 'speed must be between 0.5 and 2.0'],
        [['--tempo', '0.25'], 'tempo must be between 0.5 and 100'],
        [['--start-para', '-1'], 'start-para must be a non-negative integer'],
    ]) {
        const result = cli(args);
        assert(result.status !== 0, `${args.join(' ')} unexpectedly succeeded`);
        assert(result.stderr.includes(message), `stderr: ${result.stderr}`);
    }
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

run('file reads exit while the extension IPC pipe remains open', () => {
    const probe = String.raw`
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = process.argv[1];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoreader-ipc-test-'));
const input = path.join(temp, 'selection.txt');
const model = path.join(temp, 'model.onnx');
const voices = path.join(temp, 'voices.bin');
const worker = path.join(temp, 'worker.js');
const tools = path.join(temp, 'tools');
const output = path.join(temp, 'output.wav');
fs.mkdirSync(tools);
fs.writeFileSync(input, 'A short selection.');
fs.writeFileSync(model, 'model');
fs.writeFileSync(voices, 'voices');
fs.writeFileSync(worker, '#!/usr/bin/env node\nconst readline = require("readline");\nreadline.createInterface({ input: process.stdin }).on("line", line => { const { id } = JSON.parse(line); process.stdout.write(JSON.stringify({ id, pcm: "AAA=", sampleRate: 24000 }) + "\\n"); });\n');
fs.writeFileSync(path.join(tools, 'ffmpeg'), '#!/usr/bin/env node\nconst fs = require("fs");\nconst out = process.argv[process.argv.length - 1];\nif (out !== "pipe:1") process.stdin.on("data", c => fs.appendFileSync(out, c));\nprocess.stdin.on("end", () => process.exit(0));\n');
fs.chmodSync(worker, 0o755);
fs.chmodSync(path.join(tools, 'ffmpeg'), 0o755);
const child = spawn(process.execPath, [path.join(root, 'bin', 'kokoreader.js'), '--python-path', worker, '--model', model, '--voices', voices, '--output', output, input], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, PATH: tools + path.delimiter + process.env.PATH } });
child.stderr.resume();
const cleanup = () => fs.rmSync(temp, { recursive: true, force: true });
child.on('exit', code => { cleanup(); process.exit(code === 0 ? 0 : 2); });
// The child must exit by itself even though the parent keeps the control pipe open.
// The exit is the condition, so the timer only has to be long enough to call a hang a
// hang: observed 277-460 ms for three Node spawns, with a cold first spawn past 1 s.
setTimeout(() => { child.kill(); cleanup(); process.exit(1); }, 5000);
`;
    const result = spawnSync(process.execPath, ['-e', probe, ROOT], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
    assert(result.status === 0, `file-reading child did not exit: ${result.stderr}`);
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
    const source = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8');
    const save = manifest.contributes.commands.find(command => command.command === 'kokoreader.saveFile');
    assert(save.title.endsWith('Save to File'), `unexpected title: ${save.title}`);
    assert(manifest.contributes.configuration.properties['kokoreader.format'].description.includes('Save to File'), 'format setting does not describe Save to File');
    assert(source.includes("process.on('error', error => { item.dispose()"), 'save process errors are not handled');
});

run('cursor command reads from the active cursor through document end', () => {
    const source = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8');
    assert(source.includes("registerCommand('kokoreader.readFromCursor'"), 'missing cursor command registration');
    assert(source.includes('editor.selection.active'), 'cursor command does not use active cursor');
    assert(source.includes('new vscode.Range(cursor, end)'), 'cursor command does not read through document end');
});

run('extension gives each temporary input private, process-owned cleanup', () => {
    const source = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8');
    assert(source.includes("fs.mkdtempSync(path.join(os.tmpdir(), 'kokoreader-'))"), 'temporary directory is not unique');
    assert(source.includes('mode: 0o600'), 'temporary input is not private');
    assert(source.includes('activeProc !== proc'), 'previous reader can still clear a newer reader state');
});

run('extension forwards both boolean output settings explicitly', () => {
    const source = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8');
    assert(source.includes("'--no-normalize'"), 'normalize false is not forwarded');
    assert(source.includes("'--no-limiter'"), 'limiter false is not forwarded');
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
    for (const fragment of ['pull_request:', "tags:\n      - 'v*'", 'permissions:\n      contents: read', 'npm test', 'node --check bin/kokoreader.js', 'python3 -m py_compile python/kokoro_worker.py', '@vscode/vsce@4.0.0', 'vsce package', 'needs: validate', 'publish release/kokoreader.vsix', 'softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65']) {
        assert(workflow.includes(fragment), `missing workflow step: ${fragment}`);
    }
});

run('GitHub Actions are pinned to immutable revisions', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'main.yml'), 'utf8');
    for (const action of ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/download-artifact', 'softprops/action-gh-release']) {
        assert(new RegExp(`${action}@[0-9a-f]{40}`).test(workflow), `${action} is not pinned to a commit`);
    }
});

run('local CLI configuration is excluded from VSIX packages', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
    assert(ignore.split(/\r?\n/).includes('config/kokoreader.conf'), 'config/kokoreader.conf is not excluded');
});

run('local model assets are excluded from VSIX packages', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split(/\r?\n/);
    for (const pattern of ['**/*.onnx', '**/*.bin', '**/*.download', '**/__pycache__/**']) {
        assert(ignore.includes(pattern), `${pattern} is not excluded`);
    }
});

run('saved audio uses the selected output format', () => {
    const source = fs.readFileSync(path.join(ROOT, 'bin', 'kokoreader.js'), 'utf8');
    assert(source.includes("args.push('-f', cfg.FORMAT, temporary)"), 'ffmpeg output format is inferred from filename instead of configuration');
});

run('release tag-version command is valid Bash', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'main.yml'), 'utf8');
    const command = workflow.match(/^\s+run: (test .+)$/m);
    assert(command, 'missing tag-version command');
    const result = spawnSync('bash', ['-c', command[1]], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REF_NAME: `v${require(path.join(ROOT, 'package.json')).version}` },
    });
    assert(result.status === 0, `invalid Bash: ${result.stderr}`);
});

run('CLI kills its worker when it is terminated by a signal', () => {
    const paths = stubs();
    const child = spawn(process.execPath, [CLI, ...cliArgs(paths), '--output', path.join(paths.dir, 'out.wav'), paths.input], {
        env: { ...process.env, ...stubEnv(paths), KKR_STUB_SYNTH_DELAY: '30000' },
    });
    child.stderr.resume();
    child.once('exit', () => {});
    try {
        const worker = waitFor(() => stubEvents(paths).find(event => event.tool === 'worker'));
        assert(worker, 'worker never started');
        assert(waitFor(() => stubEvents(paths).some(event => event.id)), 'worker never received a request');
        child.kill('SIGTERM');
        assert(waitFor(() => (isAlive(worker.pid) ? null : true)), `worker ${worker.pid} survived CLI SIGTERM`);
    } finally {
        child.kill();
        fs.rmSync(paths.dir, { recursive: true, force: true });
    }
});

run('pause during synthesis withholds the next paragraph until resume', () => {
    const paths = stubs();
    const child = spawn(process.execPath, [CLI, ...cliArgs(paths), paths.input], {
        env: { ...process.env, ...stubEnv(paths), KKR_STUB_SYNTH_DELAY: '400', KKR_STUB_FFPLAY_HOLD: '1' },
    });
    child.stderr.resume();
    sleepSync(100);
    child.stdin.write('pause\n');
    sleepSync(700);
    try {
        assert(stubEvents(paths).filter(event => event.tool === 'ffplay').length === 0,
            'a player started although pause was requested during synthesis');
        child.stdin.write('resume\n');
        assert(waitFor(() => stubEvents(paths).find(event => event.tool === 'ffplay')), 'resume never started the withheld paragraph');
    } finally {
        child.kill();
        fs.rmSync(paths.dir, { recursive: true, force: true });
    }
});

run('pause cuts the player and resume replays the paragraph from the remembered offset', () => {
    const paths = stubs();
    const child = spawn(process.execPath, [CLI, ...cliArgs(paths), paths.input], {
        env: { ...process.env, ...stubEnv(paths), KKR_STUB_FFPLAY_HOLD: '1' },
    });
    child.stderr.resume();
    try {
        const first = waitFor(() => stubEvents(paths).find(event => event.tool === 'ffplay'));
        assert(first, 'ffplay never started');
        child.stdin.write('pause\n');
        assert(waitFor(() => (isAlive(first.pid) ? null : true)), `pause left ffplay ${first.pid} running`);
        sleepSync(400);
        const players = () => stubEvents(paths).filter(event => event.tool === 'ffplay').length;
        assert(players() === 1, `the paragraph kept rolling while paused: ${players()} players`);
        child.stdin.write('resume\n');
        assert(waitFor(() => (players() > 1 ? true : null)), 'resume never replayed the paused paragraph');
        const requests = stubEvents(paths).filter(event => event.action === 'synthesize');
        assert(requests.length === 1, `resume re-synthesized the paragraph: ${requests.length} requests`);
    } finally {
        child.kill();
        fs.rmSync(paths.dir, { recursive: true, force: true });
    }
});

run('extension reports a failed reader exit and can surface worker errors', () => {
    const source = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert(/proc\.on\('exit', code =>/.test(source), 'reader exit code is still ignored');
    assert(source.includes('Kokoreader: reader failed'), 'failed reader exit is not shown to the user');
    assert(source.includes("lastLine.indexOf('Error: ')"), 'error detail is parsed only from the start of a line the progress text shares');
    assert(source.includes("'--debug'"), 'worker debug output cannot be forwarded');
    assert(manifest.contributes.configuration.properties['kokoreader.debug'].order === 16, 'debug setting is not ordered last');
});

run('relative model paths from a config file resolve against the install directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoreader-conf-'));
    const conf = path.join(dir, 'config');
    fs.writeFileSync(conf, 'MODEL_DIR=relative-models\n');
    const result = cli([path.join(ROOT, 'README.md')], { cwd: dir, env: { KOKORO_READER_CONFIG: conf } });
    fs.rmSync(dir, { recursive: true, force: true });
    assert(result.status !== 0, `relative MODEL_DIR unexpectedly succeeded: ${result.stderr}`);
    assert(result.stderr.includes(path.join(ROOT, 'relative-models')), `model path is not anchored to the install directory: ${result.stderr}`);
});

run('extension tracks the save process so it can be cancelled', () => {
    const source = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8');
    assert(source.includes('let activeSave = null'), 'save process is not tracked');
    assert(/if \(activeSave\)/.test(source), 'save process is never killed by stop');
    assert(source.includes('activeSave = process'), 'running save is not recorded');
});

run('playback and encode streams carry error handlers so child death cannot crash the CLI', () => {
    const source = fs.readFileSync(path.join(ROOT, 'bin', 'kokoreader.js'), 'utf8');
    assert(source.includes("for (const stream of [ffmpeg.stdin, ffmpeg.stdout, ffplay.stdin]) stream.on('error', () => {});"),
        'playback pipes are not guarded against stream errors');
});

run('save path streams each paragraph into one encoder without waiting for the document', () => {
    const paths = stubs();
    const out = path.join(paths.dir, 'out.wav');
    const child = spawn(process.execPath, [CLI, ...cliArgs(paths), '--output', out, paths.input], {
        env: { ...process.env, ...stubEnv(paths), KKR_STUB_SYNTH_DELAY: '700' },
    });
    child.stderr.resume();
    child.once('exit', () => {});
    try {
        const halfway = waitFor(() => (fs.existsSync(`${out}.part`)
            && fs.statSync(`${out}.part`).size === Buffer.from(STUB_PCM, 'base64').length) || null);
        assert(halfway, 'first paragraph never reached the encoder while the second was still synthesizing');
        assert(!fs.existsSync(out), 'final output was published before the document finished');
        assert(waitFor(() => (fs.existsSync(out) && fs.statSync(out).size === 2 * Buffer.from(STUB_PCM, 'base64').length) || null, 8000),
            'both paragraphs were never concatenated into the output');
    } finally {
        child.kill();
        fs.rmSync(paths.dir, { recursive: true, force: true });
    }
});

run('save path encodes once and publishes only on success', () => {
    const paths = stubs();
    const out = path.join(paths.dir, 'out.wav');
    spawnSync(process.execPath, [CLI, ...cliArgs(paths), '--output', out, paths.input],
        { env: { ...process.env, ...stubEnv(paths) } });
    const encodes = stubEvents(paths).filter(event => event.tool === 'ffmpeg');
    fs.rmSync(paths.dir, { recursive: true, force: true });
    assert(encodes.length === 1, `expected one ffmpeg encode for the document, saw ${encodes.length}`);
    assert(encodes[0].args[encodes[0].args.length - 1] === `${out}.part`, 'encoder did not write a temporary file');
});

run('failed synthesis leaves the previous output file untouched', () => {
    const paths = stubs();
    const out = path.join(paths.dir, 'out.wav');
    fs.writeFileSync(out, 'previous');
    const result = spawnSync(process.execPath, [CLI, ...cliArgs(paths), '--output', out, paths.input],
        { env: { ...process.env, ...stubEnv(paths), KKR_STUB_FAIL_TEXT: 'Second' } });
    const untouched = fs.existsSync(out) && fs.readFileSync(out, 'utf8') === 'previous';
    const noPartial = !fs.existsSync(`${out}.part`);
    fs.rmSync(paths.dir, { recursive: true, force: true });
    assert(result.status !== 0, 'failing synthesis unexpectedly succeeded');
    assert(untouched, 'partial audio replaced the previous output');
    assert(noPartial, 'partial encoder output was left behind');
});

run('download is bounded by timeout, redirect depth, and transfer length', () => {
    const source = fs.readFileSync(path.join(ROOT, 'bin', 'kokoreader.js'), 'utf8');
    assert(source.includes('too many redirects'), 'redirect depth is unbounded');
    assert(source.includes('setTimeout'), 'download has no stall timeout');
    assert(source.includes("response.headers['content-length']"), 'transfer length is never checked');
    assert(source.includes('new URL('), 'relative redirect locations are not resolved');
    assert(source.includes('response.resume()'), 'discarded redirect bodies pin a socket');
});

run('text comparisons are not mistaken for HTML tags', () => {
    const paths = stubs({ text: 'if x < 10 and y > 5 then stop.\n' });
    spawnSync(process.execPath, [CLI, ...cliArgs(paths), '--output', path.join(paths.dir, 'o.wav'), paths.input],
        { env: { ...process.env, ...stubEnv(paths) } });
    const synthesis = stubEvents(paths).find(event => event.action === 'synthesize');
    fs.rmSync(paths.dir, { recursive: true, force: true });
    assert(synthesis, 'worker never received a synthesis request');
    assert(synthesis.text === 'if x < 10 and y > 5 then stop.', `mangled input: ${JSON.stringify(synthesis.text)}`);
});

run('config files cannot set run-mode keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoreader-mode-'));
    const conf = path.join(dir, 'config');
    fs.writeFileSync(conf, `START_PARA=99\nOUTPUT_FILE=${path.join(dir, 'leak.wav')}\nDEBUG=true\n`);
    const paths = stubs();
    const result = spawnSync(process.execPath, [CLI, ...cliArgs(paths), paths.input], {
        encoding: 'utf8', input: '',
        env: { ...process.env, ...stubEnv(paths), KOKORO_READER_CONFIG: conf, KKR_STUB_FFPLAY_HOLD: '0' },
    });
    const synthesized = stubEvents(paths).some(event => event.action === 'synthesize');
    const players = stubEvents(paths).filter(event => event.tool === 'ffplay').length;
    const leaked = fs.existsSync(path.join(dir, 'leak.wav'));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(paths.dir, { recursive: true, force: true });
    assert(result.status === 0, `config run-mode keys were honoured: ${result.stderr}`);
    assert(synthesized && players === 2, `paragraphs were not all read: ${players} players, ${synthesized}`);
    assert(!leaked, 'config redirected the audio output');
});

run('download verifies existing assets by sha256 and never replaces them unasked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoreader-assets-'));
    fs.writeFileSync(path.join(dir, 'kokoro-v1.0.onnx'), 'not the real model');
    fs.writeFileSync(path.join(dir, 'voices-v1.0.bin'), 'not the real voices');
    const result = cli(['--model-dir', dir, '--download']);
    const unchanged = fs.readFileSync(path.join(dir, 'voices-v1.0.bin'), 'utf8') === 'not the real voices';
    fs.rmSync(dir, { recursive: true, force: true });
    assert(result.status === 0, `download of verified-present assets failed: ${result.stderr}`);
    assert(result.stderr.includes('does not match the kokoro-onnx model-files-v1.0 release'), `no staleness warning: ${result.stderr}`);
    assert(result.stderr.includes('--download --force'), 'staleness warning omits the fix');
    assert(unchanged, 'an unverified asset was replaced without --force');
});

run('--force is download-only and documented', () => {
    const result = cli(['--force']);
    assert(result.status !== 0, '--force without --download unexpectedly succeeded');
    assert(result.stderr.includes('--force requires --download'), `stderr: ${result.stderr}`);
    assert(cli(['--help']).stdout.includes('--force'), 'help does not document --force');
});

run('every downloadable asset is pinned to a 64-hex sha256 digest', () => {
    const source = fs.readFileSync(path.join(ROOT, 'bin', 'kokoreader.js'), 'utf8');
    const files = source.match(/const MODEL_FILES = \{([\s\S]*?)\n\};/);
    const table = source.match(/const ASSET_SHA256 = \{([\s\S]*?)\n\};/);
    assert(files && table, 'MODEL_FILES or ASSET_SHA256 was renamed');
    const names = [...files[1].matchAll(/'(kokoro[^']+)'/g)].map(match => match[1]);
    assert(names.length === 3, `expected 3 precisions, found ${names.length}`);
    for (const name of [...names, /const VOICES_FILE = '([^']+)'/.exec(source)[1]]) {
        assert(new RegExp(`'${name}':\\s*'[0-9a-f]{64}'`).test(table[1]), `${name} has no pinned sha256`);
    }
});

run('signaling the CLI mid-export leaves no temporary encoder file behind', () => {
    const paths = stubs();
    const out = path.join(paths.dir, 'out.wav');
    const child = spawn(process.execPath, [CLI, ...cliArgs(paths), '--output', out, paths.input], {
        env: { ...process.env, ...stubEnv(paths), KKR_STUB_SYNTH_DELAY: '900' },
    });
    child.stderr.resume();
    child.once('exit', () => {});
    try {
        assert(waitFor(() => (fs.existsSync(`${out}.part`) || null)), 'encoder never started');
        child.kill('SIGTERM');
        assert(waitFor(() => (!fs.existsSync(`${out}.part`) && !fs.existsSync(out)) || null, 3000),
            'temporary or published file survived the signal');
    } finally {
        child.kill();
        fs.rmSync(paths.dir, { recursive: true, force: true });
    }
});

run('worker language warnings reach the user once per distinct message', () => {
    const paths = stubs();
    const result = cli([...cliArgs(paths), paths.input], {
        env: { ...stubEnv(paths), KKR_STUB_WARNING: 'espeak-ng cannot read "\u4e16\u754c" with lang "en-us"' },
    });
    const shown = (result.stderr.match(/Kokoreader: espeak-ng cannot read/g) || []).length;
    assert(shown === 1, `warning appeared ${shown} times for 2 paragraphs, expected 1`);
    fs.rmSync(paths.dir, { recursive: true, force: true });
});

run('--list-languages maps voice initials to codes and lists what espeak-ng accepts', () => {
    for (const flag of ['--list-languages', '-ll']) {
        const paths = stubs();
        const result = cli([...cliArgs(paths), flag], { env: stubEnv(paths) });
        fs.rmSync(paths.dir, { recursive: true, force: true });
        assert(result.status === 0, `${flag} failed: ${result.stderr}`);
        assert(/a\s+en-us\s+20 voice\(s\)/.test(result.stdout), `${flag} omits the American English row`);
        assert(/z\s+cmn\s+8 voice\(s\)/.test(result.stdout), `${flag} omits the Mandarin row`);
        assert(/accepts \(3\)/.test(result.stdout), `${flag} does not count the codes`);
        assert(/^ {2}foo\s+Foo$/m.test(result.stdout), `${flag} omits a code`);
    }
});

run('a signal during synthesis reaps the resident worker', () => {
    const paths = stubs();
    const child = spawn(process.execPath, [CLI, ...cliArgs(paths), paths.input], {
        env: { ...process.env, ...stubEnv(paths), KKR_STUB_SYNTH_DELAY: '900' },
    });
    child.stderr.resume();
    try {
        const workerPid = waitFor(() => {
            const event = stubEvents(paths).find(entry => entry.tool === 'worker');
            return event && event.pid;
        }, 8000);
        assert(workerPid, 'the worker never started');
        child.kill('SIGTERM');
        assert(waitFor(() => !isAlive(workerPid) || null, 4000), `worker ${workerPid} outlived the CLI`);
    } finally {
        child.kill();
        fs.rmSync(paths.dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
