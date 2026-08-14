"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const graph_1 = require("./graph");
const webview_1 = require("./webview");
const debounce_1 = require("./debounce");
const DEBOUNCE_MS = 200;
const diagnosticCollection = vscode.languages.createDiagnosticCollection('kh');
let realtimePanel = null;
let lastDocUri = null;
const webviewPanels = [];
const activeDiagnosticsDocs = new Set();
const lastGraphByDoc = new Map();
const lastGraphByPanel = new Map();
const isRealDoc = (doc) => doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled';
const isGraphable = (doc) => (0, graph_1.isIvx)(doc);
function trackPanel(panel) {
    webviewPanels.push(panel);
    panel.onDidDispose(() => {
        const i = webviewPanels.indexOf(panel);
        if (i >= 0) {
            webviewPanels.splice(i, 1);
        }
        lastGraphByPanel.delete(panel);
    });
}
const debouncedValidate = (0, debounce_1.debounceLeading)((docUri) => {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri);
    if (!doc || !isGraphable(doc)) {
        return;
    }
    if (!activeDiagnosticsDocs.has(docUri)) {
        diagnosticCollection.set(doc.uri, []);
        return;
    }
    lastDocUri = docUri;
    try {
        const { graph, errors } = (0, graph_1.buildGraph)(doc, { validate: true });
        lastGraphByDoc.set(docUri, graph);
        diagnosticCollection.set(doc.uri, (0, graph_1.createDiagnostics)(doc, errors));
        if (realtimePanel) {
            const title = (0, graph_1.getPanelTitle)(errors.length, true);
            const payload = { graph, title };
            lastGraphByPanel.set(realtimePanel, payload);
            (0, webview_1.postWebviewMessage)(realtimePanel.webview, { type: 'graph', ...payload });
            realtimePanel.title = title;
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnosticCollection.set(doc.uri, [
            new vscode.Diagnostic(new vscode.Range(0, 0, doc.lineCount - 1, 1000), `Parse error: ${msg}`, vscode.DiagnosticSeverity.Error),
        ]);
        if (realtimePanel) {
            (0, webview_1.postWebviewMessage)(realtimePanel.webview, { type: 'error', message: msg, title: 'KH Realtime Graph (Parse Error)' });
        }
    }
}, DEBOUNCE_MS);
function validateAndUpdate(doc) {
    if (!isGraphable(doc)) {
        return;
    }
    debouncedValidate(doc.uri.toString());
}
function activateDiagnostics(doc) {
    activeDiagnosticsDocs.add(doc.uri.toString());
    validateAndUpdate(doc);
}
async function showRealtimePanel(doc, context) {
    const panel = vscode.window.createWebviewPanel('khRealtimeGraph', 'KH Realtime Graph (Live)', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    realtimePanel = panel;
    trackPanel(panel);
    const docUri = doc.uri.toString();
    panel.webview.html = await (0, webview_1.getHtml)(context);
    panel.webview.onDidReceiveMessage(msg => {
        (0, webview_1.handleWebviewMessage)(msg, panel.webview, docUri, () => {
            const existing = lastGraphByDoc.get(docUri);
            if (!existing) {
                return undefined;
            }
            const pending = lastGraphByPanel.get(panel) ?? { graph: existing };
            lastGraphByPanel.set(panel, pending);
            return pending;
        });
    }, undefined, context.subscriptions);
    panel.onDidDispose(() => {
        if (realtimePanel === panel) {
            realtimePanel = null;
            lastDocUri = null;
        }
    }, undefined, context.subscriptions);
    panel.onDidChangeViewState(e => {
        if (!lastDocUri || e.webviewPanel !== panel) {
            return;
        }
        const activeDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === lastDocUri);
        if (activeDoc && isGraphable(activeDoc)) {
            validateAndUpdate(activeDoc);
        }
    }, undefined, context.subscriptions);
}
const runner_1 = require("./runner");
const outputChannel = vscode.window.createOutputChannel('KH Output');
function activate(context) {
    const subs = [
        vscode.workspace.onDidChangeTextDocument(e => validateAndUpdate(e.document)),
        vscode.workspace.onDidOpenTextDocument(doc => { if (isRealDoc(doc)) {
            validateAndUpdate(doc);
        } }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            activeDiagnosticsDocs.delete(doc.uri.toString());
            diagnosticCollection.delete(doc.uri);
        }),
        vscode.window.onDidChangeActiveTextEditor(e => {
            if (e && isRealDoc(e.document)) {
                validateAndUpdate(e.document);
            }
        }),
    ];
    subs.push(vscode.commands.registerCommand('kh.runCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isGraphable(editor.document)) {
            vscode.window.showInformationMessage('KH: Open a KH file first.');
            return;
        }
        outputChannel.clear();
        outputChannel.show(true);
        
        try {
            const { graph } = (0, graph_1.buildGraph)(editor.document);
            const interp = new runner_1.Interpreter({
                onOutput: (v) => outputChannel.appendLine(String(v)),
                onInput: async (name) => await vscode.window.showInputBox({ prompt: `Enter value for ${name}` }) ?? ""
            });
            await interp.run(graph.nodes, graph.edges);
        } catch (err) {
            outputChannel.appendLine(`❌ Error: ${err.message}`);
        }
    }), vscode.commands.registerCommand('kh.toggleRealtimeGraph', async () => {
        if (realtimePanel) {
            realtimePanel.dispose();
            realtimePanel = null;
            lastDocUri = null;
            vscode.window.showInformationMessage('KH: Realtime graph closed.');
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isGraphable(editor.document)) {
            vscode.window.showInformationMessage('KH: Open a KH file first.');
            return;
        }
        activateDiagnostics(editor.document);
        lastDocUri = editor.document.uri.toString();
        await showRealtimePanel(editor.document, context);
    }), vscode.commands.registerCommand('kh.showGraph', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isGraphable(editor.document)) {
            vscode.window.showInformationMessage('KH: Open a KH file first.');
            return;
        }
        activateDiagnostics(editor.document);
        if (realtimePanel) {
            realtimePanel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        void (async () => {
            const { graph, errors } = (0, graph_1.buildGraph)(editor.document);
            const panel = vscode.window.createWebviewPanel('khGraph', (0, graph_1.getPanelTitle)(errors.length, false), vscode.ViewColumn.Beside, { enableScripts: true });
            trackPanel(panel);
            panel.webview.html = await (0, webview_1.getHtml)(context);
            const payload = { graph };
            lastGraphByPanel.set(panel, payload);
            (0, webview_1.postWebviewMessage)(panel.webview, { type: 'graph', ...payload });
            panel.webview.onDidReceiveMessage(msg => {
                (0, webview_1.handleWebviewMessage)(msg, panel.webview, editor.document.uri.toString(), () => lastGraphByPanel.get(panel));
            }, undefined, context.subscriptions);
        })();
    }), vscode.commands.registerCommand('kh.dumpGraph', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isGraphable(editor.document)) {
            vscode.window.showInformationMessage('KH: Open a KH file first.');
            return;
        }
        const { graph } = (0, graph_1.buildGraph)(editor.document);
        console.log(JSON.stringify(graph, null, 2));
        vscode.window.showInformationMessage(`KH: Dumped (${graph.nodes.length}n / ${graph.edges.length}e). See console.`);
    }), vscode.commands.registerCommand('kh.clearDiagnostics', () => {
        activeDiagnosticsDocs.clear();
        diagnosticCollection.clear();
        vscode.window.showInformationMessage('KH: Diagnostics cleared.');
    }));
    vscode.workspace.textDocuments.forEach(validateAndUpdate);
    context.subscriptions.push(...subs, diagnosticCollection);
}
exports.activate = activate;
function deactivate() {
    realtimePanel?.dispose();
}
exports.deactivate = deactivate;
