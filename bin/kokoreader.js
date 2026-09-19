#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const MODEL_FILES = {
    fp32: 'kokoro-v1.0.onnx',
    fp16: 'kokoro-v1.0.fp16.onnx',
    int8: 'kokoro-v1.0.int8.onnx',
};
const VOICES_FILE = 'voices-v1.0.bin';
const MODEL_URLS = {
    fp32: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx',
    fp16: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx',
    int8: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx',
};
const VOICES_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin';
const DEFAULTS = {
    MODEL_DIR: '', MODEL_PATH: '', VOICES_PATH: '', PYTHON_PATH: '',
    MODEL_PRECISION: 'fp32',
    VOICE: 'af_heart', LANG: 'en-us', SPEED: 1, TEMPO: 1, GAIN: -1,
    VOLUME: 1, FORMAT: 'wav', SAMPLE_RATE: 0, NORMALIZE: false, LIMITER: true,
    OUTPUT_FILE: '', START_PARA: 0, DEBUG: false,
};

function loadConfig() {
    const cfg = { ...DEFAULTS };
    const configPath = process.env.KOKORO_READER_CONFIG || [
        path.join(__dirname, '..', 'config', 'kokoreader.conf'),
        path.join(os.homedir(), '.config', 'kokoreader', 'config'),
    ].find(fs.existsSync);
    if (!configPath || !fs.existsSync(configPath)) return cfg;
    for (const line of fs.readFileSync(configPath, 'utf8').split('\n')) {
        const match = line.trim().match(/^([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
        if (!match || !(match[1] in DEFAULTS)) continue;
        const [_, key, value] = match;
        cfg[key] = typeof DEFAULTS[key] === 'number' ? Number(value) :
            typeof DEFAULTS[key] === 'boolean' ? /^(1|true|yes)$/i.test(value) : value;
    }
    return cfg;
}

function usage() {
    process.stdout.write(`Usage: kokoreader [OPTIONS] [FILE]\n\n` +
`  FILE                       Input text or Markdown file; stdin if omitted\n\n` +
`Kokoro:\n` +
`  -md, --model-dir DIR       Directory containing Kokoro model assets\n` +
`  -m, --model PATH           Explicit Kokoro ONNX model path\n` +
`  -vs, --voices PATH         Explicit Kokoro voice-data path\n` +
`  -mp, --model-precision P   fp32, fp16, or int8 (default: fp32)\n` +
`  -py, --python-path PATH    Python 3.11 or newer interpreter\n` +
`  -v, --voice NAME           Kokoro voice (default: af_heart)\n` +
`  -l, --lang CODE            Language code (default: en-us)\n` +
`  -s, --speed N              Kokoro synthesis speed (default: 1)\n\n` +
`Playback:\n` +
`  -t, --tempo N              Pitch-preserving playback speed (default: 1)\n` +
`  -g, --gain DB              ffmpeg gain in dB (default: -1)\n` +
`  -vol, --volume N           Playback volume multiplier (default: 1)\n` +
`  -f, --format TYPE          wav, mp3, flac, or opus (default: wav)\n` +
`  -sr, --sample-rate HZ      Saved-file sample rate; 0 preserves source rate\n` +
`  -n, --normalize            Apply EBU R128 loudness normalization\n` +
`  -nn, --no-normalize        Disable loudness normalization (default)\n` +
`  -lim, --limiter            Prevent output peaks above -0.45 dB (default)\n` +
`  -nlim, --no-limiter        Disable peak limiting\n` +
`  -o, --output FILE          Save audio instead of playing\n` +
`  -sp, --start-para N        Start at paragraph N (1-based)\n\n` +
`Management:\n` +
`  -d, --download             Download model and voice data to --model-dir\n` +
`  -ls, --list                List available Kokoro voices\n` +
`  -dbg, --debug              Show worker errors\n` +
`  -h, --help                 Show this help\n`);
}

function parseArgs(argv, cfg) {
    let inputFile = null, action = null;
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const value = () => {
            if (args[i + 1] === undefined) throw new Error(`Missing value for ${arg}`);
            return args[++i];
        };
        switch (arg) {
            case '-h': case '--help': usage(); process.exit(0); break;
            case '-md': case '--model-dir': cfg.MODEL_DIR = value(); break;
            case '-m': case '--model': cfg.MODEL_PATH = value(); break;
            case '-vs': case '--voices': cfg.VOICES_PATH = value(); break;
            case '-mp': case '--model-precision': cfg.MODEL_PRECISION = value().toLowerCase(); break;
            case '-py': case '--python-path': cfg.PYTHON_PATH = value(); break;
            case '-v': case '--voice': cfg.VOICE = value(); break;
            case '-l': case '--lang': cfg.LANG = value(); break;
            case '-s': case '--speed': cfg.SPEED = Number(value()); break;
            case '-t': case '--tempo': cfg.TEMPO = Number(value()); break;
            case '-g': case '--gain': cfg.GAIN = Number(value()); break;
            case '-vol': case '--volume': cfg.VOLUME = Number(value()); break;
            case '-f': case '--format': cfg.FORMAT = value().toLowerCase(); break;
            case '-sr': case '--sample-rate': cfg.SAMPLE_RATE = Number(value()); break;
            case '-n': case '--normalize': cfg.NORMALIZE = true; break;
            case '-nn': case '--no-normalize': cfg.NORMALIZE = false; break;
            case '-lim': case '--limiter': cfg.LIMITER = true; break;
            case '-nlim': case '--no-limiter': cfg.LIMITER = false; break;
            case '-o': case '--output': cfg.OUTPUT_FILE = value(); break;
            case '-sp': case '--start-para': cfg.START_PARA = Number(value()); break;
            case '-d': case '--download': action = 'download'; break;
            case '-ls': case '--list': action = 'list'; break;
            case '-dbg': case '--debug': cfg.DEBUG = true; break;
            case '--': inputFile = value(); break;
            default:
                if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
                inputFile = arg;
        }
    }
    for (const key of ['GAIN', 'VOLUME']) {
        if (!Number.isFinite(cfg[key])) throw new Error(`Invalid numeric value for ${key.toLowerCase()}`);
    }
    if (!Number.isFinite(cfg.SPEED) || cfg.SPEED <= 0) throw new Error('speed must be greater than zero');
    if (!Number.isFinite(cfg.TEMPO) || cfg.TEMPO < 0.5 || cfg.TEMPO > 100) throw new Error('tempo must be between 0.5 and 100');
    if (!Number.isInteger(cfg.START_PARA) || cfg.START_PARA < 0) throw new Error('start-para must be a non-negative integer');
    if (!Number.isInteger(cfg.SAMPLE_RATE) || cfg.SAMPLE_RATE < 0) throw new Error('sample-rate must be a non-negative integer');
    if (!['wav', 'mp3', 'flac', 'opus'].includes(cfg.FORMAT)) throw new Error('format must be wav, mp3, flac, or opus');
    if (!Object.hasOwn(MODEL_FILES, cfg.MODEL_PRECISION)) throw new Error('model-precision must be fp32, fp16, or int8');
    return { inputFile, action };
}

function assets(cfg) {
    return {
        model: cfg.MODEL_PATH || (cfg.MODEL_DIR && path.join(cfg.MODEL_DIR, MODEL_FILES[cfg.MODEL_PRECISION])),
        voices: cfg.VOICES_PATH || (cfg.MODEL_DIR && path.join(cfg.MODEL_DIR, VOICES_FILE)),
    };
}

function requireAssets(cfg) {
    const result = assets(cfg);
    if (!result.model || !result.voices) throw new Error('Set --model-dir, or both --model and --voices.');
    if (!fs.existsSync(result.model)) throw new Error(`Kokoro model not found: ${result.model}`);
    if (!fs.existsSync(result.voices)) throw new Error(`Kokoro voice data not found: ${result.voices}`);
    return result;
}

function stripMarkdown(text) {
    return text.replace(/^```[\s\S]*?^```\s*$/gm, '')
        .replace(/`([^`]*)`/g, '$1').replace(/^[ \t]*#+[ \t]*/gm, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]*>/g, '').replace(/\*\*([^*]*)\*\*/g, '$1')
        .replace(/__([^_]*)__/g, '$1').replace(/\*([^*]*)\*/g, '$1')
        .replace(/^[ \t]*[-*=]{3,}[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n');
}

function paragraphs(text) { return stripMarkdown(text).split(/\n\n+/).map(x => x.trim()).filter(Boolean); }

class Worker {
    constructor(cfg) {
        const { model, voices } = requireAssets(cfg);
        const python = cfg.PYTHON_PATH || process.env.KOKORO_READER_PYTHON || 'python3';
        this.proc = spawn(python, [path.join(__dirname, '..', 'python', 'kokoro_worker.py'), '--serve', '--model', model, '--voices', voices], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.pending = new Map();
        this.nextId = 1;
        this.exited = false;
        readline.createInterface({ input: this.proc.stdout }).on('line', line => this.receive(line));
        this.proc.stderr.on('data', chunk => { if (cfg.DEBUG) process.stderr.write(chunk); });
        this.proc.on('error', error => this.fail(error));
        this.proc.on('exit', (code, signal) => {
            this.exited = true;
            if (this.pending.size) this.fail(new Error(code === null ? `Kokoro worker exited from ${signal || 'a signal'}` : `Kokoro worker exited with code ${code}`));
        });
    }
    receive(line) {
        let message;
        try { message = JSON.parse(line); } catch (_) { return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message);
    }
    fail(error) { for (const { reject } of this.pending.values()) reject(error); this.pending.clear(); }
    request(message) {
        return new Promise((resolve, reject) => {
            if (this.exited || this.proc.stdin.destroyed || this.proc.stdin.writableEnded) return reject(new Error('Kokoro worker is not running'));
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            try {
                this.proc.stdin.write(JSON.stringify({ id, ...message }) + '\n', error => {
                    if (!error || !this.pending.has(id)) return;
                    this.pending.delete(id);
                    reject(error);
                });
            } catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }
    async synthesize(text, cfg) {
        const response = await this.request({ action: 'synthesize', text, voice: cfg.VOICE, lang: cfg.LANG, speed: cfg.SPEED });
        return { pcm: Buffer.from(response.pcm, 'base64'), sampleRate: response.sampleRate };
    }
    async list() { return (await this.request({ action: 'list' })).voices; }
    close() { try { this.proc.kill(); } catch (_) {} }
}

let activeFfmpeg = null;
let activeFfplay = null;
let activeWorker = null;

function killActive() {
    for (const process of [activeWorker && activeWorker.proc, activeFfmpeg, activeFfplay]) {
        try { process && process.kill(); } catch (_) {}
    }
    activeFfmpeg = activeFfplay = activeWorker = null;
}

function pausePlayback() {
    if (!activeFfplay) return;
    if (process.platform === 'win32') return processControl(activeFfplay.pid, 'Suspend');
    try { process.kill(activeFfplay.pid, 'SIGSTOP'); } catch (_) {}
}

function resumePlayback() {
    if (!activeFfplay) return;
    if (process.platform === 'win32') return processControl(activeFfplay.pid, 'Resume');
    try { process.kill(activeFfplay.pid, 'SIGCONT'); } catch (_) {}
}

function processControl(pid, verb) {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `${verb}-Process -Id ${pid}`], { stdio: 'ignore' });
}

function setupIPC() {
    readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
        if (line.trim() === 'pause') pausePlayback();
        if (line.trim() === 'resume') resumePlayback();
        if (line.trim() === 'stop') { killActive(); process.exit(0); }
    });
}

function ffmpegFilter(cfg) {
    const filters = [`volume=${cfg.VOLUME}`, `volume=${cfg.GAIN}dB`, `atempo=${cfg.TEMPO}`];
    if (cfg.NORMALIZE) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    if (cfg.LIMITER) filters.push('alimiter=limit=0.95');
    return filters.join(',');
}

function playPCM(pcm, sampleRate, cfg) {
    return new Promise((resolve, reject) => {
        const ffmpeg = activeFfmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0', '-af', ffmpegFilter(cfg), '-f', 'wav', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
        const ffplay = activeFfplay = spawn('ffplay', ['-nodisp', '-autoexit', '-f', 'wav', '-i', 'pipe:0'], { stdio: ['pipe', 'ignore', 'ignore'] });
        let ffmpegDone = false, ffplayDone = false, settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            if (error) { try { ffmpeg.kill(); } catch (_) {} try { ffplay.kill(); } catch (_) {} }
            if (activeFfmpeg === ffmpeg) activeFfmpeg = null;
            if (activeFfplay === ffplay) activeFfplay = null;
            error ? reject(error) : resolve();
        };
        ffmpeg.stdin.end(pcm);
        ffmpeg.stdout.pipe(ffplay.stdin);
        ffmpeg.on('error', finish);
        ffplay.on('error', finish);
        ffmpeg.on('exit', code => { ffmpegDone = true; if (code !== 0) finish(new Error(`ffmpeg exited with code ${code}`)); else if (ffplayDone) finish(); });
        ffplay.on('exit', code => { ffplayDone = true; if (code !== 0) finish(new Error(`ffplay exited with code ${code}`)); else if (ffmpegDone) finish(); });
    });
}

function savePCM(raw, sampleRate, cfg) {
    return new Promise((resolve, reject) => {
        const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0', '-af', ffmpegFilter(cfg)];
        if (cfg.SAMPLE_RATE) args.push('-ar', String(cfg.SAMPLE_RATE));
        args.push('-f', cfg.FORMAT, cfg.OUTPUT_FILE);
        const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'ignore'] });
        ffmpeg.stdin.end(raw);
        ffmpeg.on('error', reject);
        ffmpeg.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
    });
}

function readStdin() {
    return new Promise(resolve => { const chunks = []; process.stdin.on('data', x => chunks.push(x)); process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); });
}

async function read(inputFile, cfg) {
    const raw = inputFile ? fs.readFileSync(inputFile, 'utf8') : await readStdin();
    if (inputFile) setupIPC();
    const text = paragraphs(raw);
    if (!text.length) throw new Error('Nothing to read.');
    if (cfg.START_PARA > text.length) throw new Error(`start-para must be no greater than the number of paragraphs (${text.length})`);
    const worker = activeWorker = new Worker(cfg);
    try {
        let sampleRate = null;
        const audio = [];
        for (let index = 0; index < text.length; index++) {
            if (cfg.START_PARA && index + 1 < cfg.START_PARA) continue;
            process.stderr.write(`\r[${index + 1}/${text.length}] synthesizing...`);
            const result = await worker.synthesize(text[index], cfg);
            sampleRate = sampleRate || result.sampleRate;
            if (cfg.OUTPUT_FILE) audio.push(result.pcm);
            else { process.stderr.write(`\r[${index + 1}/${text.length}] playing...     `); await playPCM(result.pcm, result.sampleRate, cfg); }
        }
        if (cfg.OUTPUT_FILE) await savePCM(Buffer.concat(audio), sampleRate, cfg);
        process.stderr.write('\n');
    } finally {
        worker.close();
        activeWorker = null;
        if (inputFile) process.stdin.destroy();
    }
}

function download(url, destination) {
    return new Promise((resolve, reject) => {
        https.get(url, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) return resolve(download(response.headers.location, destination));
            if (response.statusCode !== 200) return reject(new Error(`download failed: HTTP ${response.statusCode}`));
            const file = fs.createWriteStream(destination);
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        }).on('error', reject);
    });
}

async function downloadAssets(cfg) {
    if (!cfg.MODEL_DIR) throw new Error('--download requires --model-dir.');
    fs.mkdirSync(cfg.MODEL_DIR, { recursive: true });
    const downloads = { [MODEL_FILES[cfg.MODEL_PRECISION]]: MODEL_URLS[cfg.MODEL_PRECISION], [VOICES_FILE]: VOICES_URL };
    for (const [name, url] of Object.entries(downloads)) {
        const target = path.join(cfg.MODEL_DIR, name);
        if (fs.existsSync(target)) { process.stdout.write(`Already present: ${target}\n`); continue; }
        const temporary = `${target}.download`;
        try { process.stdout.write(`Downloading ${name}...\n`); await download(url, temporary); fs.renameSync(temporary, target); }
        finally { try { fs.unlinkSync(temporary); } catch (_) {} }
    }
}

async function main() {
    const cfg = loadConfig();
    let parsed;
    try { parsed = parseArgs(process.argv, cfg); }
    catch (error) { process.stderr.write(`${error.message}\n`); usage(); process.exitCode = 1; return; }
    if (parsed.action === 'download') return downloadAssets(cfg);
    if (parsed.action === 'list') {
        const worker = new Worker(cfg);
        try { for (const voice of await worker.list()) process.stdout.write(`${voice}\n`); }
        finally { worker.close(); }
        return;
    }
    if (parsed.inputFile && !fs.existsSync(parsed.inputFile)) throw new Error(`file not found: ${parsed.inputFile}`);
    await read(parsed.inputFile, cfg);
}

main().catch(error => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
