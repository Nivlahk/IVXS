import * as vscode from 'vscode';
import { Graph } from './graph';
import { buildGraph, createDiagnostics, getPanelTitle, isIvx } from './graph';
import { getHtml, postWebviewMessage, handleWebviewMessage, PendingGraph } from './webview';
import { debounceLeading } from './debounce';

const DEBOUNCE_MS = 200;

const diagnosticCollection = vscode.languages.createDiagnosticCollection('ivx');
let realtimePanel: vscode.WebviewPanel | null = null;
let lastDocUri: string | null = null;
const webviewPanels: vscode.WebviewPanel[] = [];
const activeDiagnosticsDocs = new Set<string>();
const lastGraphByDoc   = new Map<string, Graph>();
const lastGraphByPanel = new Map<vscode.WebviewPanel, PendingGraph>();

const isRealDoc    = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled';
const isGraphable  = (doc: vscode.TextDocument) => isIvx(doc);

function trackPanel(panel: vscode.WebviewPanel): void {
  webviewPanels.push(panel);
  panel.onDidDispose(() => {
    const i = webviewPanels.indexOf(panel);
    if (i >= 0) { webviewPanels.splice(i, 1); }
    lastGraphByPanel.delete(panel);
  });
}

const debouncedValidate = debounceLeading((docUri: string) => {
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri);
  if (!doc || !isGraphable(doc)) { return; }

  if (!activeDiagnosticsDocs.has(docUri)) { diagnosticCollection.set(doc.uri, []); return; }

  lastDocUri = docUri;

  try {
    const { graph, errors } = buildGraph(doc, { validate: true });
    lastGraphByDoc.set(docUri, graph);
    diagnosticCollection.set(doc.uri, createDiagnostics(doc, errors));

    if (realtimePanel) {
      const title   = getPanelTitle(errors.length, true);
      const payload: PendingGraph = { graph, title };
      lastGraphByPanel.set(realtimePanel, payload);
      postWebviewMessage(realtimePanel.webview, { type: 'graph', ...payload });
      realtimePanel.title = title;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnosticCollection.set(doc.uri, [
      new vscode.Diagnostic(new vscode.Range(0, 0, doc.lineCount - 1, 1000), `Parse error: ${msg}`, vscode.DiagnosticSeverity.Error),
    ]);
    if (realtimePanel) {
      postWebviewMessage(realtimePanel.webview, { type: 'error', message: msg, title: 'IVXS Realtime Graph (Parse Error)' });
    }
  }
}, DEBOUNCE_MS);

function validateAndUpdate(doc: vscode.TextDocument): void {
  if (!isGraphable(doc)) { return; }
  debouncedValidate(doc.uri.toString());
}

function activateDiagnostics(doc: vscode.TextDocument): void {
  activeDiagnosticsDocs.add(doc.uri.toString());
  validateAndUpdate(doc);
}

async function showRealtimePanel(doc: vscode.TextDocument, context: vscode.ExtensionContext): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'ivxRealtimeGraph', 'IVXS Realtime Graph (Live)', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  realtimePanel = panel;
  trackPanel(panel);

  const docUri = doc.uri.toString();
  panel.webview.html = await getHtml(context);

  panel.webview.onDidReceiveMessage(msg => {
    handleWebviewMessage(msg, panel.webview, docUri, () => {
      const existing = lastGraphByDoc.get(docUri);
      if (!existing) { return undefined; }
      const pending = lastGraphByPanel.get(panel) ?? { graph: existing };
      lastGraphByPanel.set(panel, pending);
      return pending;
    });
  }, undefined, context.subscriptions);

  panel.onDidDispose(() => {
    if (realtimePanel === panel) { realtimePanel = null; lastDocUri = null; }
  }, undefined, context.subscriptions);

  panel.onDidChangeViewState(e => {
    if (!lastDocUri || e.webviewPanel !== panel) { return; }
    const activeDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === lastDocUri);
    if (activeDoc && isGraphable(activeDoc)) { validateAndUpdate(activeDoc); }
  }, undefined, context.subscriptions);
}

export function activate(context: vscode.ExtensionContext): void {
  const subs: vscode.Disposable[] = [
    vscode.workspace.onDidChangeTextDocument(e => validateAndUpdate(e.document)),
    vscode.workspace.onDidOpenTextDocument(doc => { if (isRealDoc(doc)) { validateAndUpdate(doc); } }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      activeDiagnosticsDocs.delete(doc.uri.toString());
      diagnosticCollection.delete(doc.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor(e => {
      if (e && isRealDoc(e.document)) { validateAndUpdate(e.document); }
    }),
  ];

  subs.push(
    vscode.commands.registerCommand('ivx.toggleRealtimeGraph', async () => {
      if (realtimePanel) {
        realtimePanel.dispose(); realtimePanel = null; lastDocUri = null;
        vscode.window.showInformationMessage('IVXS: Realtime graph closed.');
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isGraphable(editor.document)) {
        vscode.window.showInformationMessage('IVXS: Open an IVX file first.');
        return;
      }
      activateDiagnostics(editor.document);
      lastDocUri = editor.document.uri.toString();
      await showRealtimePanel(editor.document, context);
    }),

    vscode.commands.registerCommand('ivx.showGraph', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isGraphable(editor.document)) {
        vscode.window.showInformationMessage('IVXS: Open an IVX file first.');
        return;
      }
      activateDiagnostics(editor.document);
      if (realtimePanel) { realtimePanel.reveal(vscode.ViewColumn.Beside); return; }
      void (async () => {
        const { graph, errors } = buildGraph(editor.document);
        const panel = vscode.window.createWebviewPanel(
          'ivxGraph', getPanelTitle(errors.length, false), vscode.ViewColumn.Beside, { enableScripts: true },
        );
        trackPanel(panel);
        panel.webview.html = await getHtml(context);
        const payload: PendingGraph = { graph };
        lastGraphByPanel.set(panel, payload);
        postWebviewMessage(panel.webview, { type: 'graph', ...payload });
        panel.webview.onDidReceiveMessage(msg => {
          handleWebviewMessage(msg, panel.webview, editor.document.uri.toString(), () => lastGraphByPanel.get(panel));
        }, undefined, context.subscriptions);
      })();
    }),

    vscode.commands.registerCommand('ivx.dumpGraph', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isGraphable(editor.document)) {
        vscode.window.showInformationMessage('IVXS: Open an IVX file first.');
        return;
      }
      const { graph } = buildGraph(editor.document);
      console.log(JSON.stringify(graph, null, 2));
      vscode.window.showInformationMessage(`IVXS: Dumped (${graph.nodes.length}n / ${graph.edges.length}e). See console.`);
    }),

    vscode.commands.registerCommand('ivx.clearDiagnostics', () => {
      activeDiagnosticsDocs.clear();
      diagnosticCollection.clear();
      vscode.window.showInformationMessage('IVXS: Diagnostics cleared.');
    }),
  );

  vscode.workspace.textDocuments.forEach(validateAndUpdate);
  context.subscriptions.push(...subs, diagnosticCollection);
}

export function deactivate(): void {
  realtimePanel?.dispose();
}
