#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { spawn } = require('child_process');

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
// SHA-256 of every asset in the model-files-v1.0 release, computed from the
// release itself. Without these, a truncated or stale asset is only noticed as
// an opaque failure inside onnxruntime, if at all.
const ASSET_SHA256 = {
    'kokoro-v1.0.onnx': '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5',
    'kokoro-v1.0.fp16.onnx': 'c1610a859f3bdea01107e73e50100685af38fff88f5cd8e5c56df109ec880204',
    'kokoro-v1.0.int8.onnx': '6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb',
    'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
};
const DEFAULTS = {
    MODEL_DIR: '', MODEL_PATH: '', VOICES_PATH: '', PYTHON_PATH: '',
    MODEL_PRECISION: 'fp32',
    VOICE: 'af_heart', LANG: 'en-us', SPEED: 1, TEMPO: 1, GAIN: -1,
    VOLUME: 1, FORMAT: 'wav', SAMPLE_RATE: 0, NORMALIZE: false, LIMITER: true,
    OUTPUT_FILE: '', START_PARA: 0, DEBUG: false, FORCE: false,
};

const INSTALL_DIR = path.join(__dirname, '..');
const PATH_CONFIG_KEYS = new Set(['MODEL_DIR', 'MODEL_PATH', 'VOICES_PATH']);
// Model and playback settings only: a config file must not quietly change what a
// single run does, or every editor read would overwrite the same output file.
const IGNORED_CONFIG_KEYS = new Set(['OUTPUT_FILE', 'START_PARA', 'DEBUG', 'FORCE']);

function loadConfig() {
    const cfg = { ...DEFAULTS };
    const configPath = process.env.KOKORO_READER_CONFIG || [
        path.join(__dirname, '..', 'config', 'kokoreader.conf'),
        path.join(os.homedir(), '.config', 'kokoreader', 'config'),
    ].find(fs.existsSync);
    if (!configPath || !fs.existsSync(configPath)) return cfg;
    for (const line of fs.readFileSync(configPath, 'utf8').split('\n')) {
        const match = line.trim().match(/^([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
        if (!match || !(match[1] in DEFAULTS) || IGNORED_CONFIG_KEYS.has(match[1])) continue;
        const [_, key, value] = match;
        cfg[key] = typeof DEFAULTS[key] === 'number' ? Number(value) :
            typeof DEFAULTS[key] === 'boolean' ? /^(1|true|yes)$/i.test(value) : value;
        // Relative paths in a config file mean "relative to the install", not to
        // whatever directory the editor host or shell happens to run from.
        if (PATH_CONFIG_KEYS.has(key) && value && !path.isAbsolute(value)) cfg[key] = path.resolve(INSTALL_DIR, value);
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
`  -s, --speed N              Kokoro synthesis speed 0.5-2.0 (default: 1)\n\n` +
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
`  --force                    With --download, replace assets that fail SHA-256 checks\n` +
`  -ls, --list                List available Kokoro voices\n` +
`  -ll, --list-languages      List the espeak-ng codes --lang accepts\n` +
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
            case '--force': cfg.FORCE = true; break;
            case '-ls': case '--list': action = 'list'; break;
            case '-ll': case '--list-languages': action = 'languages'; break;
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
    if (!Number.isFinite(cfg.SPEED) || cfg.SPEED < 0.5 || cfg.SPEED > 2) throw new Error('speed must be between 0.5 and 2.0');
    if (!Number.isFinite(cfg.TEMPO) || cfg.TEMPO < 0.5 || cfg.TEMPO > 100) throw new Error('tempo must be between 0.5 and 100');
    if (!Number.isInteger(cfg.START_PARA) || cfg.START_PARA < 0) throw new Error('start-para must be a non-negative integer');
    if (!Number.isInteger(cfg.SAMPLE_RATE) || cfg.SAMPLE_RATE < 0) throw new Error('sample-rate must be a non-negative integer');
    if (!['wav', 'mp3', 'flac', 'opus'].includes(cfg.FORMAT)) throw new Error('format must be wav, mp3, flac, or opus');
    if (!Object.hasOwn(MODEL_FILES, cfg.MODEL_PRECISION)) throw new Error('model-precision must be fp32, fp16, or int8');
    if (cfg.FORCE && action !== 'download') throw new Error('--force requires --download');
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
    return text.replace(/^```[\s\S]*?^```\s*$/gm, '\n\nA code block follows. You can see the code in the document.\n\n')
        .replace(/`([^`]*)`/g, '$1').replace(/^[ \t]*#+[ \t]*/gm, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<\/?[a-zA-Z!][^>]*>/g, '').replace(/\*\*([^*]*)\*\*/g, '$1')
        .replace(/__([^_]*)__/g, '$1').replace(/\*([^*]*)\*/g, '$1')
        .replace(/^[ \t]*[-*=]{3,}[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n');
}

// Kokoro never learned a pause for dashes: espeak-ng drops spaced hyphens
// outright and renders an em dash as a phoneme stretch with no silence, so
// "a -- b" reads as "ab". A spaced dash is a spoken break, so hand the model
// ".."  which it renders as a real ~170 ms pause. Word-internal hyphens
// (local-first) stay joined. The lookbehind keeps dash-prefixed lines
// (list bullets) untouched.
function paragraphs(text) {
    return stripMarkdown(text).split(/\n\n+/)
        .map(x => x.trim().replace(/(?<=\S)[ \t]+[-–—]{1,}[ \t]+(?=\S)/g, ' .. '))
        .filter(Boolean);
}

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
    async prepare(text, cfg) {
        const response = await this.request({ action: 'prepare', text, voice: cfg.VOICE, lang: cfg.LANG });
        if (response.warning) warnOnce(response.warning);
        if (!Array.isArray(response.units) || !response.units.length) throw new Error('Kokoro worker prepared no synthesis units');
        return response.units;
    }
    async synthesize(phonemes, cfg) {
        const response = await this.request({ action: 'synthesize', phonemes, voice: cfg.VOICE, speed: cfg.SPEED });
        if (typeof response.pcm !== 'string' || !Number.isFinite(response.sampleRate)) {
            throw new Error('Kokoro worker returned an invalid synthesis response');
        }
        return { pcm: Buffer.from(response.pcm, 'base64'), sampleRate: response.sampleRate };
    }
    async list() { return (await this.request({ action: 'list' })).voices; }
    async languages() { return this.request({ action: 'languages' }); }
    close() { try { this.proc.kill(); } catch (_) {} }
}

// espeak-ng degrades a whole paragraph the same way, so one report per distinct
// message is enough; repeating it per paragraph buries the progress line.
const shownWarnings = new Set();
function warnOnce(message) {
    if (shownWarnings.has(message)) return;
    shownWarnings.add(message);
    process.stderr.write(`\nKokoreader: ${message}\n`);
}

let activeFfmpeg = null;
let activeFfplay = null;
let activeWorker = null;
let activePartFile = null;
let playbackPaused = false;
// The live paragraph's mute, and the callbacks a `resume` has to wake: paragraphs
// withheld before they started.
let activePause = null;
const onResume = new Set();

function killActive() {
    for (const child of [activeWorker && activeWorker.proc, activeFfmpeg, activeFfplay]) {
        try { child && child.kill(); } catch (_) {}
    }
    activeFfmpeg = activeFfplay = activeWorker = null;
    activePause = null;
    onResume.clear();
    playbackPaused = false;
    // process.exit skips read()'s finally, so the in-flight encoder's temporary
    // file has to be reaped here or Ctrl-C and Stop litter the user's folder.
    if (activePartFile) { try { fs.unlinkSync(activePartFile); } catch (_) {} activePartFile = null; }
}

// A signal that bypasses the stdin 'stop' line (editor reload, Ctrl-C, the
// extension's fallback kill) must still reap the resident worker and player.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { killActive(); process.exit(128); });
}

function pausePlayback() {
    if (playbackPaused) return;
    playbackPaused = true;
    if (activePause) activePause();
}

function resumePlayback() {
    if (!playbackPaused) return;
    playbackPaused = false;
    for (const wake of [...onResume]) { onResume.delete(wake); wake(); }
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

// Pause mutes by killing the paragraph's ffmpeg/ffplay pair (~10 ms to the audio device):
// a frozen ffplay stutters out the ~0.25 s already handed to SDL and CoreAudio and, after
// SIGCONT, burns its remaining input at ~6x realtime and exits. PAUSE_REWIND_MS is how far
// back Resume replays, so a resume repeats a word rather than clipping one.
const PAUSE_REWIND_MS = 800;
const PARAGRAPH_PAUSE_MS = 800;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function playPCM(pcm, sampleRate, cfg) {
    let offset = 0;
    while (offset < pcm.length) {
        while (playbackPaused) await new Promise(wake => onResume.add(wake));
        offset = await playSegment(pcm, offset, sampleRate, cfg);
    }
}

function playSegment(pcm, offset, sampleRate, cfg) {
    return new Promise((resolve, reject) => {
        const ffmpeg = activeFfmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0', '-af', ffmpegFilter(cfg), '-f', 'wav', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
        const ffplay = activeFfplay = spawn('ffplay', ['-nodisp', '-autoexit', '-f', 'wav', '-i', 'pipe:0'], { stdio: ['pipe', 'ignore', 'ignore'] });
        const started = Date.now();
        // A child that dies mid-stream makes its pipes emit EPIPE/ERR_STREAM_DESTROYED.
        // The 'exit' handlers already report the failure; this only stops an unhandled
        // stream error from replacing that report with a raw stack trace.
        for (const stream of [ffmpeg.stdin, ffmpeg.stdout, ffplay.stdin]) stream.on('error', () => {});
        let ffmpegDone = false, ffplayDone = false, settled = false;
        const settle = (next, error) => {
            if (settled) return;
            settled = true;
            if (activePause === pause) activePause = null;
            if (activeFfmpeg === ffmpeg) activeFfmpeg = null;
            if (activeFfplay === ffplay) activeFfplay = null;
            if (error) { try { ffmpeg.kill(); } catch (_) {} try { ffplay.kill(); } catch (_) {} }
            error ? reject(error) : resolve(next);
        };
        const pause = () => {
            // s16le mono: sampleRate/500 bytes of the paragraph per millisecond of
            // audio, scaled by atempo, which makes wall time and input bytes differ.
            const heard = (Date.now() - started - PAUSE_REWIND_MS) * (sampleRate / 500) * cfg.TEMPO;
            const next = Math.min(pcm.length, offset + Math.max(0, Math.trunc(heard / 2) * 2));
            try { ffmpeg.kill(); } catch (_) {}
            try { ffplay.kill(); } catch (_) {}
            settle(next);
        };
        ffmpeg.stdin.end(pcm.subarray(offset));
        ffmpeg.stdout.pipe(ffplay.stdin);
        ffmpeg.on('error', error => settle(0, error));
        ffplay.on('error', error => settle(0, error));
        ffmpeg.on('exit', code => { ffmpegDone = true; if (code !== 0) settle(0, new Error(`ffmpeg exited with code ${code}`)); else if (ffplayDone) settle(pcm.length); });
        ffplay.on('exit', code => { ffplayDone = true; if (code !== 0) settle(0, new Error(`ffplay exited with code ${code}`)); else if (ffmpegDone) settle(pcm.length); });
        activePause = pause;
    });
}

function startSaveEncoder(cfg, sampleRate) {
    // One encoder for the whole document, fed as paragraphs are synthesized: the
    // old design buffered every paragraph and encoded at the end, which cost
    // ~1.65 MB per spoken minute and lost all work if anything failed late.
    const temporary = `${cfg.OUTPUT_FILE}.part`;
    activePartFile = temporary;
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0', '-af', ffmpegFilter(cfg)];
    if (cfg.SAMPLE_RATE) args.push('-ar', String(cfg.SAMPLE_RATE));
    args.push('-f', cfg.FORMAT, temporary);
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'ignore'] });
    ffmpeg.stdin.on('error', () => {});
    const done = new Promise((resolve, reject) => {
        ffmpeg.on('error', reject);
        ffmpeg.on('exit', code => {
            if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));
            if (!fs.existsSync(temporary)) return reject(new Error(`ffmpeg produced no audio for ${cfg.OUTPUT_FILE}`));
            try { fs.renameSync(temporary, cfg.OUTPUT_FILE); if (activePartFile === temporary) activePartFile = null; resolve(); }
            catch (error) { reject(error); }
        });
    });
    // Publish atomically: a failed read must leave the previous file alone, and
    // the killed encoder must not leave a stray .part behind.
    done.catch(() => { try { fs.unlinkSync(temporary); } catch (_) {} });
    return {
        stdin: ffmpeg.stdin,
        done,
        abort() { try { ffmpeg.stdin.destroy(); ffmpeg.kill(); } catch (_) {} },
    };
}

function readStdin() {
    return new Promise(resolve => { const chunks = []; process.stdin.on('data', x => chunks.push(x)); process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); });
}

async function* preparedUnits(text, cfg, worker) {
    for (let index = 0; index < text.length; index++) {
        if (cfg.START_PARA && index + 1 < cfg.START_PARA) continue;
        process.stderr.write(`\r[${index + 1}/${text.length}] preparing...`);
        for (const phonemes of await worker.prepare(text[index], cfg)) {
            yield { phonemes, paragraph: index + 1, total: text.length };
        }
    }
}

async function playPreparedUnits(units, worker, cfg) {
    const iterator = units[Symbol.asyncIterator]();
    let current = await iterator.next();
    if (current.done) return;
    let currentAudio = await worker.synthesize(current.value.phonemes, cfg);
    while (!current.done) {
        process.stderr.write(`\r[${current.value.paragraph}/${current.value.total}] playing...     `);
        const playing = playPCM(currentAudio.pcm, currentAudio.sampleRate, cfg);
        const lookahead = (async () => {
            while (playbackPaused) await new Promise(wake => onResume.add(wake));
            const next = await iterator.next();
            if (next.done) return { next, audio: null };
            return { next, audio: await worker.synthesize(next.value.phonemes, cfg) };
        })();
        await playing;
        const { next, audio } = await lookahead;
        if (next.done) break;
        if (next.value.paragraph !== current.value.paragraph) await delay(PARAGRAPH_PAUSE_MS);
        current = next;
        currentAudio = audio;
    }
}

async function read(inputFile, cfg) {
    const raw = inputFile ? fs.readFileSync(inputFile, 'utf8') : await readStdin();
    if (inputFile) setupIPC();
    const text = paragraphs(raw);
    if (!text.length) throw new Error('Nothing to read.');
    if (cfg.START_PARA > text.length) throw new Error(`start-para must be no greater than the number of paragraphs (${text.length})`);
    const worker = activeWorker = new Worker(cfg);
    let saver = null;
    try {
        const units = preparedUnits(text, cfg, worker);
        if (cfg.OUTPUT_FILE) {
            let previousParagraph = 0;
            for await (const unit of units) {
                process.stderr.write(`\r[${unit.paragraph}/${unit.total}] synthesizing...`);
                const result = await worker.synthesize(unit.phonemes, cfg);
                if (!saver) saver = startSaveEncoder(cfg, result.sampleRate);
                if (previousParagraph && unit.paragraph !== previousParagraph) {
                    const bytes = Math.round(result.sampleRate * 2 * cfg.TEMPO * PARAGRAPH_PAUSE_MS / 1000);
                    await new Promise((resolve, reject) => saver.stdin.write(Buffer.alloc(bytes), error => error ? reject(error) : resolve()));
                }
                // The write callback fires once flushed to the OS, which is the
                // backpressure that keeps memory bounded to one synthesis unit.
                await new Promise((resolve, reject) => saver.stdin.write(result.pcm, error => error ? reject(error) : resolve()));
                previousParagraph = unit.paragraph;
            }
        } else {
            await playPreparedUnits(units, worker, cfg);
        }
        if (saver) { saver.stdin.end(); await saver.done; }
        process.stderr.write('\n');
    } catch (error) {
        if (saver) saver.abort();
        throw error;
    } finally {
        worker.close();
        activeWorker = null;
        if (inputFile) process.stdin.destroy();
    }
}

function download(url, destination, redirects = 0) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirects >= 5) return reject(new Error('download failed: too many redirects'));
                return resolve(download(new URL(response.headers.location, url).href, destination, redirects + 1));
            }
            if (response.statusCode !== 200) { response.resume(); return reject(new Error(`download failed: HTTP ${response.statusCode}`)); }
            const expected = Number(response.headers['content-length']);
            const file = fs.createWriteStream(destination);
            let received = 0;
            response.on('data', chunk => { received += chunk.length; });
            response.pipe(file);
            file.on('error', reject);
            response.on('error', reject);
            file.on('finish', () => file.close(() => {
                // A truncated asset renames to the real filename and then fails
                // opaquely at inference time, so reject it here instead.
                if (expected && received !== expected) return reject(new Error(`download failed: incomplete (${received}/${expected} bytes)`));
                resolve();
            }));
        });
        request.setTimeout(60000, () => request.destroy(new Error('download timed out')));
        request.on('error', reject);
    });
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file).on('error', reject).pipe(hash);
        hash.on('error', reject);
        hash.on('finish', () => resolve(hash.digest('hex')));
    });
}

async function downloadAssets(cfg) {
    if (!cfg.MODEL_DIR) throw new Error('--download requires --model-dir.');
    fs.mkdirSync(cfg.MODEL_DIR, { recursive: true });
    const downloads = { [MODEL_FILES[cfg.MODEL_PRECISION]]: MODEL_URLS[cfg.MODEL_PRECISION], [VOICES_FILE]: VOICES_URL };
    for (const [name, url] of Object.entries(downloads)) {
        const target = path.join(cfg.MODEL_DIR, name);
        const expected = ASSET_SHA256[name];
        if (fs.existsSync(target)) {
            if (!expected) { process.stdout.write(`Already present: ${target} (no pinned digest)\n`); continue; }
            if (await sha256File(target) === expected) { process.stdout.write(`Already present: ${target}\n`); continue; }
            // Never overwrite an asset the user may have placed deliberately, such
            // as a custom voice set; --force says "yes, replace this one".
            if (!cfg.FORCE) {
                process.stderr.write(`${target} does not match the kokoro-onnx model-files-v1.0 release. Rerun with --download --force to replace it.\n`);
                continue;
            }
            process.stdout.write(`Replacing unverified ${name}...\n`);
        }
        const temporary = `${target}.download`;
        try {
            process.stdout.write(`Downloading ${name}...\n`);
            await download(url, temporary);
            if (expected) {
                const digest = await sha256File(temporary);
                if (digest !== expected) throw new Error(`${name} is corrupt: sha256 ${digest}, expected ${expected}`);
            }
            fs.renameSync(temporary, target);
        }
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
    if (parsed.action === 'languages') {
        const worker = new Worker(cfg);
        try {
            const report = await worker.languages();
            process.stdout.write('Kokoro voices, by the espeak-ng code their initial requires:\n');
            for (const row of report.kokoro) {
                process.stdout.write(`  ${row.letter}  ${String(row.lang || '(none)').padEnd(8)} ${row.voices} voice(s)\n`);
            }
            const codes = Object.keys(report.espeak).sort();
            process.stdout.write(`\nespeak-ng codes this install accepts (${codes.length}):\n`);
            for (const code of codes) process.stdout.write(`  ${code.padEnd(12)}${report.espeak[code]}\n`);
        } finally { worker.close(); }
        return;
    }
    if (parsed.inputFile && !fs.existsSync(parsed.inputFile)) throw new Error(`file not found: ${parsed.inputFile}`);
    await read(parsed.inputFile, cfg);
}

main().catch(error => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
