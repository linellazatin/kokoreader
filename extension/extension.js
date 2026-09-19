'use strict';

const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeProc = null;
let statusItem = null;
let paused = false;
let selectionFile = null;

function setState(playing, isPaused) {
    vscode.commands.executeCommand('setContext', 'kokoreader.isPlaying', playing);
    vscode.commands.executeCommand('setContext', 'kokoreader.isPaused', isPaused);
}

function cleanupSelection() {
    if (!selectionFile) return;
    try { fs.unlinkSync(selectionFile); } catch (_) {}
    selectionFile = null;
}

function writeTemporaryText(text) {
    selectionFile = path.join(os.tmpdir(), `kokoreader-selection-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(selectionFile, text, 'utf8');
    return selectionFile;
}

function configArgs(config) {
    const args = [];
    const add = (flag, name) => { const value = config.get(name); if (typeof value !== 'boolean' && value !== '' && value != null) args.push(flag, String(value)); };
    const addBool = (flag, name) => { if (config.get(name)) args.push(flag); };
    add('--model-dir', 'modelDir'); add('--model', 'modelPath'); add('--voices', 'voicesPath'); add('--model-precision', 'modelPrecision');
    add('--python-path', 'pythonPath'); add('--voice', 'voice'); add('--lang', 'lang');
    add('--speed', 'speed'); add('--tempo', 'tempo'); add('--gain', 'gain'); add('--volume', 'volume');
    add('--format', 'format'); add('--sample-rate', 'sampleRate');
    addBool('--normalize', 'normalize'); addBool('--limiter', 'limiter');
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
    if (activeProc) {
        try { activeProc.stdin.write('stop\n'); } catch (_) {}
        const process = activeProc;
        setTimeout(() => { try { process.kill(); } catch (_) {} }, 500);
        activeProc = null;
    }
    if (statusItem) statusItem.hide();
    cleanupSelection();
}

function updateStatus(text) {
    if (statusItem && text) statusItem.text = `$(sync~spin) ${text}  $(primitive-square)`;
}

function activate(context) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusItem.command = 'kokoreader.stop';
    context.subscriptions.push(statusItem);
    setState(false, false);

    function startReading(config, file, status) {
        updateStatus(status);
        activeProc = spawnCli([...configArgs(config), file], { stdio: ['pipe', 'ignore', 'pipe'] });
        activeProc.stderr.on('data', chunk => updateStatus(chunk.toString().replace(/\r/g, '\n').trim().split('\n').filter(Boolean).pop()));
        activeProc.on('exit', () => { activeProc = null; paused = false; cleanupSelection(); setState(false, false); statusItem.hide(); });
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
        let file;
        if (selection) {
            file = writeTemporaryText(selection);
        } else {
            file = uri ? uri.fsPath : editor && editor.document.uri.fsPath;
            if (!file) return vscode.window.showErrorMessage('Kokoreader: no file to read.');
        }
        startReading(config, file, selection ? 'selection' : path.basename(file));
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
        startReading(config, writeTemporaryText(text), `cursor line ${cursor.line + 1}`);
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
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        item.text = `$(sync~spin) Kokoreader: saving ${path.basename(target.fsPath)}...`;
        item.show();
        process.on('exit', code => { item.dispose(); vscode.window.showInformationMessage(code === 0 ? `Kokoreader: saved to ${target.fsPath}` : `Kokoreader: save failed (exit ${code})`); });
    });
    context.subscriptions.push(readCommand, cursorCommand, pauseCommand, resumeCommand, stopCommand, saveCommand);
}

function deactivate() { stop(); }

module.exports = { activate, deactivate };
