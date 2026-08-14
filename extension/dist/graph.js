"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPanelTitle = exports.createDiagnostics = exports.buildGraph = exports.isIvx = exports.validNodeIO = exports.NODE_ARITY = void 0;
const vscode = require("vscode");
const parser_1 = require("./parser");
exports.NODE_ARITY = {
    Start: { minIn: 0, maxIn: 0, minOut: 1, maxOut: 1 },
    End: { minIn: 1, maxIn: Infinity, minOut: 0, maxOut: 0 },
    Process: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
    Decision: { minIn: 1, maxIn: Infinity, minOut: 2, maxOut: Infinity },
    Connector: { minIn: 1, maxIn: Infinity, minOut: 1, maxOut: 1 },
    Input: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
    Output: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
    Function: { minIn: 0, maxIn: 1, minOut: 0, maxOut: 1 },
    WaitBlock: { minIn: 0, maxIn: 1, minOut: 0, maxOut: 1 },
    Speak: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
};
function validNodeIO(nodes, edges) {
    const errors = [];
    const inDeg = new Map();
    const outDeg = new Map();
    for (const e of edges) {
        outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
        inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    }
    for (const n of nodes) {
        const rules = exports.NODE_ARITY[n.kind];
        const ins = inDeg.get(n.id) ?? 0;
        const outs = outDeg.get(n.id) ?? 0;
        const info = `N${n.id} [${n.kind}] L${n.line + 1}`;
        if (ins < rules.minIn)
            errors.push(`${info}: ${ins} inputs < min ${rules.minIn}`);
        if (rules.maxIn !== Infinity && ins > rules.maxIn)
            errors.push(`${info}: ${ins} inputs > max ${rules.maxIn}`);
        if (outs < rules.minOut)
            errors.push(`${info}: ${outs} outputs < min ${rules.minOut}`);
        if (rules.maxOut !== Infinity && outs > rules.maxOut)
            errors.push(`${info}: ${outs} outputs > max ${rules.maxOut}`);
    }
    return errors;
}
exports.validNodeIO = validNodeIO;
function isIvx(doc) {
    return doc.languageId === 'kh' || doc.fileName.endsWith('.kh');
}
exports.isIvx = isIvx;
function buildGraph(doc, options) {
    const graph = (0, parser_1.parsekh)(doc.getText());
    const errors = (options?.validate ?? true) ? (graph.validationErrors ?? []) : [];
    return { graph, errors };
}
exports.buildGraph = buildGraph;
function createDiagnostics(doc, errors) {
    return errors.map(msg => {
        const lineMatch = msg.match(/L(\d+)/) || msg.match(/Line (\d+)/);
        const range = lineMatch
            ? new vscode.Range(parseInt(lineMatch[1], 10) - 1, 0, parseInt(lineMatch[1], 10) - 1, 1000)
            : new vscode.Range(0, 0, doc.lineCount - 1, 1000);
        return new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error);
    });
}
exports.createDiagnostics = createDiagnostics;
function getPanelTitle(errorCount, live) {
    const base = `KH ${live ? 'Realtime Graph' : 'Graph'}`;
    return errorCount > 0
        ? `${base} (${errorCount} error${errorCount === 1 ? '' : 's'})`
        : live ? `${base} (Live)` : base;
}
exports.getPanelTitle = getPanelTitle;
