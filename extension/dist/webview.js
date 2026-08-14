"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWebviewMessage = exports.postWebviewMessage = exports.getHtml = void 0;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
async function getHtml(context) {
    const htmlPath = vscode.Uri.file(path.join(context.extensionPath, 'flow.html'));
    const content = await fs.promises.readFile(htmlPath.fsPath, 'utf8');
    return content;
}
exports.getHtml = getHtml;
function postWebviewMessage(webview, message) {
    webview.postMessage(message);
}
exports.postWebviewMessage = postWebviewMessage;
function handleWebviewMessage(msg, webview, docUri, getGraph) {
    if (msg.type === 'ready') {
        const payload = getGraph();
        if (payload) {
            postWebviewMessage(webview, { type: 'graph', ...payload });
        }
    }
}
exports.handleWebviewMessage = handleWebviewMessage;
