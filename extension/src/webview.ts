import * as vscode from 'vscode';
import { Graph } from './graph';

export type PendingGraph = { graph: Graph; title?: string };

export type WebviewOutboundMessage =
  | { type: 'graph'; graph: Graph; title?: string }
  | { type: 'error'; message: string; title?: string }
  | { type: 'highlight'; nodeId: number }
  | { type: 'clearHighlights' }
  | { type: 'traceClear' }
  | { type: 'startNodeEdit'; nodeId?: string; text: string; x?: number; y?: number; width?: number; height?: number; line?: number; segmentIndex?: number }
  | { type: 'startNodeEditByLine'; line: number; text: string };

export const postWebviewMessage = (webview: vscode.Webview, message: WebviewOutboundMessage): void => {
  void webview.postMessage(message);
};

export async function getHtml(context: vscode.ExtensionContext): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(context.extensionUri, 'flow.html'),
  );
  return new TextDecoder().decode(bytes);
}

export function handleWebviewMessage(
  msg: unknown,
  webview: vscode.Webview,
  docUri: string,
  getPendingGraph: () => PendingGraph | undefined,
): boolean {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) { return false; }
  const m = msg as { type: string } & Record<string, unknown>;

  if (m.type === 'webviewReady') {
    const pending = getPendingGraph();
    if (pending) { postWebviewMessage(webview, { type: 'graph', ...pending }); }
    return true;
  }

  if (m.type === 'commitNodeEdit') {
    const line = m['line'] as number;
    const newText = m['newText'] as string;
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri);
    if (doc && typeof newText === 'string' && typeof line === 'number' && line >= 0 && line < doc.lineCount) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, doc.lineAt(line).range, newText);
      void vscode.workspace.applyEdit(edit);
    }
    return true;
  }

  if (m.type === 'requestNodeEdit') {
    const line      = m['line']         as number;
    const nodeId    = m['nodeId']        as string | undefined;
    const x         = m['x']            as number | undefined;
    const y         = m['y']            as number | undefined;
    const width     = m['width']        as number | undefined;
    const height    = m['height']       as number | undefined;
    const segmentIndex = m['segmentIndex'] as number | undefined;
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri);
    if (doc && typeof line === 'number' && line >= 0 && line < doc.lineCount) {
      postWebviewMessage(webview, {
        type: 'startNodeEdit', nodeId, text: doc.lineAt(line).text.trim(),
        x, y, width, height, line, segmentIndex,
      });
    }
    return true;
  }

  return false;
}