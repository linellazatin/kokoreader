'use strict';

const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeProc = null;
let activeSave = null;
let activeSaveTemporary = null;
let pendingSave = false;
let saveGeneration = 0;
let statusItem = null;
let paused = false;
let activeTemporary = null;
const ERROR_LOG_MAX_BYTES = 1024 * 1024;

function setState(playing, isPaused) {
    vscode.commands.executeCommand('setContext', 'kokoreader.isPlaying', playing);
    vscode.commands.executeCommand('setContext', 'kokoreader.isPaused', isPaused);
}

function setSaving(saving) {
    vscode.commands.executeCommand('setContext', 'kokoreader.isSaving', saving);
}

function cleanupTemporary(temporary) {
    if (!temporary) return;
    try { fs.rmSync(temporary.dir, { recursive: true, force: true }); } catch (_) {}
}

function writeTemporaryText(text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoreader-'));
    const file = path.join(dir, 'input.txt');
    try { fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 }); }
    catch (error) { cleanupTemporary({ dir }); throw error; }
    return { dir, file };
}

function inputForEditor(editor, uri) {
    if (!editor || (uri && editor.document.uri.toString() !== uri.toString())) return null;
    const text = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);
    const temporary = writeTemporaryText(text);
    return { file: temporary.file, temporary, name: path.basename(editor.document.fileName || 'kokoreader.txt') };
}

function hasEditorInput(editor, uri) {
    return Boolean(editor && (!uri || editor.document.uri.toString() === uri.toString()));
}

function configArgs(config) {
    const args = [];
    const add = (flag, name) => { const value = config.get(name); if (typeof value !== 'boolean' && value !== '' && value != null) args.push(flag, String(value)); };
    const addBool = (enabled, disabled, name) => args.push(config.get(name) ? enabled : disabled);
    add('--model-dir', 'modelDir'); add('--model', 'modelPath'); add('--voices', 'voicesPath'); add('--model-precision', 'modelPrecision');
    add('--python-path', 'pythonPath'); add('--voice', 'voice'); add('--lang', 'lang');
    add('--profile', 'profile');
    add('--speed', 'speed'); add('--tempo', 'tempo'); add('--gain', 'gain'); add('--volume', 'volume');
    add('--threads', 'threads'); add('--pronunciations', 'pronunciationsPath');
    add('--format', 'format'); add('--sample-rate', 'sampleRate');
    addBool('--normalize', '--no-normalize', 'normalize'); addBool('--limiter', '--no-limiter', 'limiter');
    if (config.get('debug')) args.push('--debug');
    return args;
}

function validate(config) {
    if (!config.get('pythonPath')) return showSetup('pythonPath');
    if (!config.get('modelDir') && !(config.get('modelPath') && config.get('voicesPath'))) return showSetup('modelDir');
    return true;
}

function showSetup(setting) {
    vscode.window.showErrorMessage(`Kokoreader: set kokoreader.${setting} first.`, 'Open Settings').then(action => {
        if (action === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', `kokoreader.${setting}`);
    });
    return false;
}

function spawnCli(args, options) {
    return spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'kokoreader.js'), ...args], options);
}

function stop() {
    paused = false;
    setState(false, false);
    const saveTemporary = activeSaveTemporary;
    activeSaveTemporary = null;
    pendingSave = false;
    saveGeneration++;
    if (activeSave) { try { activeSave.kill(); } catch (_) {} activeSave = null; }
    setSaving(false);
    cleanupTemporary(saveTemporary);
    const reader = activeProc;
    const temporary = activeTemporary;
    activeProc = null;
    activeTemporary = null;
    if (reader) {
        try { reader.stdin.write('stop\n'); } catch (_) {}
        setTimeout(() => { try { reader.kill(); } catch (_) {} }, 500);
    }
    if (statusItem) statusItem.hide();
    cleanupTemporary(temporary);
}

function updateStatus(text) {
    if (statusItem && text) statusItem.text = `$(sync~spin) ${text}  $(primitive-square)`;
}

function appendErrorLog(context, entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    const files = [path.join(context.extensionPath, 'logs', 'err.jsonl')];
    if (context.logUri && context.logUri.fsPath) files.push(path.join(context.logUri.fsPath, 'err.jsonl'));
    for (const file of files) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            if (fs.existsSync(file) && fs.statSync(file).size >= ERROR_LOG_MAX_BYTES) {
                const archived = `${file}.1`;
                try { fs.unlinkSync(archived); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                fs.renameSync(file, archived);
            }
            fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
            return;
        } catch (_) {}
    }
}

function activate(context) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusItem.command = 'kokoreader.stop';
    context.subscriptions.push(statusItem);
    setState(false, false);
    setSaving(false);

    function startReading(config, file, status, temporary = null) {
        updateStatus(status);
        const proc = spawnCli([...configArgs(config), file], { stdio: ['pipe', 'ignore', 'pipe'] });
        let lastError = '';
        const note = chunk => {
            const lines = chunk.toString().replace(/\r/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
            const error = lines.find(line => line.includes('Error: '));
            if (error) lastError = error.slice(error.indexOf('Error: ') + 7).trim();
            const statusLine = lines.filter(line => /^\[\d+\/\d+\] (preparing|synthesizing|playing)\.\.\.\s*$/.test(line) || line.startsWith('Kokoreader: ')).at(-1);
            if (statusLine) updateStatus(statusLine);
        };
        activeProc = proc;
        activeTemporary = temporary;
        const finish = () => {
            if (activeProc !== proc) return;
            activeProc = null;
            const ownedTemporary = activeTemporary;
            activeTemporary = null;
            paused = false;
            cleanupTemporary(ownedTemporary);
            setState(false, false);
            statusItem.hide();
        };
        proc.stderr.on('data', note);
        proc.on('error', error => {
            if (activeProc === proc) {
                appendErrorLog(context, { kind: 'reader', event: 'spawn', detail: 'reader process failed to start' });
                vscode.window.showErrorMessage(`Kokoreader: ${error.message}`);
            }
            finish();
        });
        proc.on('exit', (code, signal) => {
            if ((code !== 0 || signal) && activeProc === proc) {
                // Progress is written with \r and the error with no leading newline,
                // so the two often arrive as one line: "[3/3] synthesizing...Error: …".
                const detail = (lastError || (signal ? `reader stopped by ${signal}` : `reader failed (exit ${code})`)).slice(0, 1000);
                appendErrorLog(context, { kind: 'reader', event: 'exit', code, signal: signal || null, detail: signal ? `reader stopped by ${signal}` : `reader failed (exit ${code})` });
                vscode.window.showErrorMessage(`Kokoreader: reader failed: ${detail}`);
            }
            finish();
        });
        setState(true, false);
        statusItem.tooltip = 'Click to stop Kokoreader';
        statusItem.show();
    }

    const readCommand = vscode.commands.registerCommand('kokoreader.readFile', uri => {
        const config = vscode.workspace.getConfiguration('kokoreader');
        if (!validate(config)) return;
        if (activeSave || pendingSave) return vscode.window.showInformationMessage('Kokoreader: stop the active export before reading.');
        stop();
        const editor = vscode.window.activeTextEditor;
        const input = inputForEditor(editor, uri) || (uri && uri.fsPath ? { file: uri.fsPath, temporary: null, name: path.basename(uri.fsPath) } : null);
        if (!input) return vscode.window.showErrorMessage('Kokoreader: no file to read.');
        startReading(config, input.file, editor && !editor.selection.isEmpty ? 'selection' : input.name, input.temporary);
    });

    const cursorCommand = vscode.commands.registerCommand('kokoreader.readFromCursor', () => {
        const config = vscode.workspace.getConfiguration('kokoreader');
        if (!validate(config)) return;
        if (activeSave || pendingSave) return vscode.window.showInformationMessage('Kokoreader: stop the active export before reading.');
        const editor = vscode.window.activeTextEditor;
        if (!editor) return vscode.window.showErrorMessage('Kokoreader: no active editor.');
        const cursor = editor.selection.active;
        const end = editor.document.positionAt(editor.document.getText().length);
        const text = editor.document.getText(new vscode.Range(cursor, end));
        if (!text) return vscode.window.showInformationMessage('Kokoreader: cursor is at the end of the document.');
        stop();
        const temporary = writeTemporaryText(text);
        startReading(config, temporary.file, `cursor line ${cursor.line + 1}`, temporary);
    });

    const pauseCommand = vscode.commands.registerCommand('kokoreader.pause', () => {
        if (!activeProc || paused) return;
        paused = true; activeProc.stdin.write('pause\n'); setState(false, true);
        statusItem.text = '$(debug-pause) Paused  $(primitive-square)';
    });
    const resumeCommand = vscode.commands.registerCommand('kokoreader.resume', () => {
        if (!activeProc || !paused) return;
        paused = false; activeProc.stdin.write('resume\n'); setState(true, false); updateStatus('playing...');
    });
    const navigate = action => () => {
        if (!activeProc) return;
        activeProc.stdin.write(`${action}\n`);
        updateStatus(paused ? 'paused...' : 'playing...');
    };
    const previousCommand = vscode.commands.registerCommand('kokoreader.previousParagraph', navigate('previous'));
    const replayCommand = vscode.commands.registerCommand('kokoreader.replayParagraph', navigate('replay'));
    const nextCommand = vscode.commands.registerCommand('kokoreader.nextParagraph', navigate('next'));
    const stopCommand = vscode.commands.registerCommand('kokoreader.stop', stop);
    const saveCommand = vscode.commands.registerCommand('kokoreader.saveFile', async uri => {
        const config = vscode.workspace.getConfiguration('kokoreader');
        if (!validate(config)) return;
        const editor = vscode.window.activeTextEditor;
        if (activeSave || pendingSave) return vscode.window.showInformationMessage('Kokoreader: an export is already running.');
        if (activeProc) return vscode.window.showInformationMessage('Kokoreader: stop the active reader before exporting.');
        if (!hasEditorInput(editor, uri) && !(uri && uri.fsPath)) return vscode.window.showErrorMessage('Kokoreader: no file to save.');
        const format = config.get('format');
        const labels = { wav: 'WAV Audio', mp3: 'MP3 Audio', flac: 'FLAC Audio', opus: 'Opus Audio' };
        const sourcePath = uri && uri.fsPath ? uri.fsPath : editor && editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : null;
        const generation = ++saveGeneration;
        pendingSave = true;
        setSaving(true);
        let target;
        try {
            target = await vscode.window.showSaveDialog({
                defaultUri: sourcePath ? vscode.Uri.file(path.join(path.dirname(sourcePath), `${path.basename(sourcePath, path.extname(sourcePath))}.${format}`)) : undefined,
                filters: { [labels[format]]: [format] }, title: 'Save Kokoro audio as...'
            });
        } catch (error) {
            if (generation !== saveGeneration) return;
            pendingSave = false;
            setSaving(false);
            return vscode.window.showErrorMessage(`Kokoreader: ${error.message}`);
        }
        if (!pendingSave || generation !== saveGeneration) return;
        pendingSave = false;
        if (!target) { setSaving(false); return; }
        let input;
        try {
            input = inputForEditor(editor, uri) || (uri && uri.fsPath ? { file: uri.fsPath, temporary: null, name: path.basename(uri.fsPath) } : null);
        } catch (error) {
            setSaving(false);
            return vscode.window.showErrorMessage(`Kokoreader: ${error.message}`);
        }
        const process = spawnCli([...configArgs(config), '--output', target.fsPath, input.file], { stdio: 'ignore' });
        activeSave = process;
        activeSaveTemporary = input.temporary;
        setSaving(true);
        let cleaned = false;
        const clearSave = () => {
            if (cleaned) return;
            cleaned = true;
            cleanupTemporary(input.temporary);
            if (activeSave === process) {
                activeSave = null;
                activeSaveTemporary = null;
                setSaving(false);
            }
        };
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        item.text = `$(sync~spin) Kokoreader: saving ${path.basename(target.fsPath)}...`;
        item.show();
        process.on('error', error => {
            if (activeSave === process) appendErrorLog(context, { kind: 'export', event: 'spawn', detail: 'export process failed to start' });
            item.dispose(); clearSave(); vscode.window.showErrorMessage(`Kokoreader: ${error.message}`);
        });
        process.on('exit', (code, signal) => {
            if (activeSave === process && (code !== 0 || signal)) {
                appendErrorLog(context, { kind: 'export', event: 'exit', code, signal: signal || null, detail: signal ? `export stopped by ${signal}` : `export failed (exit ${code})` });
            }
            item.dispose(); clearSave(); vscode.window.showInformationMessage(code === 0 ? `Kokoreader: saved to ${target.fsPath}` : `Kokoreader: save failed (${signal || `exit ${code}`})`);
        });
    });
    context.subscriptions.push(readCommand, cursorCommand, pauseCommand, resumeCommand, previousCommand, replayCommand, nextCommand, stopCommand, saveCommand);
}

function deactivate() { stop(); }

module.exports = { activate, deactivate };
