'use strict';

const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeProc = null;
let activeSave = null;
let statusItem = null;
let paused = false;
let activeTemporary = null;

function setState(playing, isPaused) {
    vscode.commands.executeCommand('setContext', 'kokoreader.isPlaying', playing);
    vscode.commands.executeCommand('setContext', 'kokoreader.isPaused', isPaused);
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

function configArgs(config) {
    const args = [];
    const add = (flag, name) => { const value = config.get(name); if (typeof value !== 'boolean' && value !== '' && value != null) args.push(flag, String(value)); };
    const addBool = (enabled, disabled, name) => args.push(config.get(name) ? enabled : disabled);
    add('--model-dir', 'modelDir'); add('--model', 'modelPath'); add('--voices', 'voicesPath'); add('--model-precision', 'modelPrecision');
    add('--python-path', 'pythonPath'); add('--voice', 'voice'); add('--lang', 'lang');
    add('--profile', 'profile');
    add('--speed', 'speed'); add('--tempo', 'tempo'); add('--gain', 'gain'); add('--volume', 'volume');
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
    if (activeSave) { try { activeSave.kill(); } catch (_) {} activeSave = null; }
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

function activate(context) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusItem.command = 'kokoreader.stop';
    context.subscriptions.push(statusItem);
    setState(false, false);

    function startReading(config, file, status, temporary = null) {
        updateStatus(status);
        const proc = spawnCli([...configArgs(config), file], { stdio: ['pipe', 'ignore', 'pipe'] });
        let lastLine = '';
        const note = chunk => {
            const lines = chunk.toString().replace(/\r/g, '\n').trim().split('\n').filter(Boolean);
            if (lines.length) { lastLine = lines[lines.length - 1]; updateStatus(lastLine); }
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
        proc.on('error', error => { if (activeProc === proc) vscode.window.showErrorMessage(`Kokoreader: ${error.message}`); finish(); });
        proc.on('exit', code => {
            if (code && activeProc === proc) {
                // Progress is written with \r and the error with no leading newline,
                // so the two often arrive as one line: "[3/3] synthesizing...Error: …".
                const at = lastLine.indexOf('Error: ');
                const detail = at >= 0 ? lastLine.slice(at + 7).trim() : `reader failed (exit ${code})`;
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
        stop();
        const editor = vscode.window.activeTextEditor;
        const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
        let file, temporary = null;
        if (selection) {
            temporary = writeTemporaryText(selection);
            file = temporary.file;
        } else {
            file = uri ? uri.fsPath : editor && editor.document.uri.fsPath;
            if (!file) return vscode.window.showErrorMessage('Kokoreader: no file to read.');
        }
        startReading(config, file, selection ? 'selection' : path.basename(file), temporary);
    });

    const cursorCommand = vscode.commands.registerCommand('kokoreader.readFromCursor', () => {
        const config = vscode.workspace.getConfiguration('kokoreader');
        if (!validate(config)) return;
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
    const stopCommand = vscode.commands.registerCommand('kokoreader.stop', stop);
    const saveCommand = vscode.commands.registerCommand('kokoreader.saveFile', async uri => {
        const config = vscode.workspace.getConfiguration('kokoreader');
        if (!validate(config)) return;
        const file = uri ? uri.fsPath : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath;
        if (!file) return vscode.window.showErrorMessage('Kokoreader: no file to save.');
        const format = config.get('format');
        const labels = { wav: 'WAV Audio', mp3: 'MP3 Audio', flac: 'FLAC Audio', opus: 'Opus Audio' };
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.${format}`)),
            filters: { [labels[format]]: [format] }, title: 'Save Kokoro audio as...'
        });
        if (!target) return;
        const process = spawnCli([...configArgs(config), '--output', target.fsPath, file], { stdio: 'ignore' });
        activeSave = process;
        const clearSave = () => { if (activeSave === process) activeSave = null; };
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        item.text = `$(sync~spin) Kokoreader: saving ${path.basename(target.fsPath)}...`;
        item.show();
        process.on('error', error => { item.dispose(); clearSave(); vscode.window.showErrorMessage(`Kokoreader: ${error.message}`); });
        process.on('exit', code => { item.dispose(); clearSave(); vscode.window.showInformationMessage(code === 0 ? `Kokoreader: saved to ${target.fsPath}` : `Kokoreader: save failed (exit ${code})`); });
    });
    context.subscriptions.push(readCommand, cursorCommand, pauseCommand, resumeCommand, stopCommand, saveCommand);
}

function deactivate() { stop(); }

module.exports = { activate, deactivate };
