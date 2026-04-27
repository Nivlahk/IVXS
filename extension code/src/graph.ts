import * as vscode from 'vscode';
import { parseivx } from './parser';

export type NodeKind =
  | 'Start'
  | 'End'
  | 'Process'
  | 'Decision'
  | 'Connector'
  | 'Input'
  | 'Output'
  | 'Function'
  | 'WaitBlock'
  | 'Speak';

export interface Node {
  id: number;
  kind: NodeKind;
  line: number;
  segmentIndex: number;
  indent: number;
  text: string;
  meta?: string;
}

export interface Edge {
  from: number;
  to: number;
  label?: string;
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
  startNodeId: number | null;
  segments?: any[];
  validationErrors?: string[];
}

export const NODE_ARITY: Record<NodeKind, { minIn: number; maxIn: number; minOut: number; maxOut: number }> = {
  Start:    { minIn: 0, maxIn: 0,        minOut: 1, maxOut: 1        },
  End:      { minIn: 1, maxIn: Infinity, minOut: 0, maxOut: 0        },
  Process:  { minIn: 1, maxIn: 1,        minOut: 1, maxOut: 1        },
  Decision: { minIn: 1, maxIn: Infinity, minOut: 2, maxOut: Infinity },
  Connector:{ minIn: 1, maxIn: Infinity, minOut: 1, maxOut: 1        },
  Input:    { minIn: 1, maxIn: 1,        minOut: 1, maxOut: 1        },
  Output:   { minIn: 1, maxIn: 1,        minOut: 1, maxOut: 1        },
  Function: { minIn: 0, maxIn: 1,        minOut: 0, maxOut: 1        },
  WaitBlock:{ minIn: 0, maxIn: 1,        minOut: 0, maxOut: 1        },
  Speak:    { minIn: 1, maxIn: 1,        minOut: 1, maxOut: 1        },
};

export function validNodeIO(nodes: Node[], edges: Edge[]): string[] {
  const errors: string[] = [];
  const inDeg  = new Map<number, number>();
  const outDeg = new Map<number, number>();

  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to,   (inDeg.get(e.to)   ?? 0) + 1);
  }

  for (const n of nodes) {
    const rules = NODE_ARITY[n.kind];
    const ins  = inDeg.get(n.id)  ?? 0;
    const outs = outDeg.get(n.id) ?? 0;
    const info = `N${n.id} [${n.kind}] L${n.line + 1}`;
    if (ins  < rules.minIn)                               errors.push(`${info}: ${ins} inputs < min ${rules.minIn}`);
    if (rules.maxIn  !== Infinity && ins  > rules.maxIn)  errors.push(`${info}: ${ins} inputs > max ${rules.maxIn}`);
    if (outs < rules.minOut)                              errors.push(`${info}: ${outs} outputs < min ${rules.minOut}`);
    if (rules.maxOut !== Infinity && outs > rules.maxOut) errors.push(`${info}: ${outs} outputs > max ${rules.maxOut}`);
  }
  return errors;
}

export function isIvx(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'ivx' || doc.fileName.endsWith('.ivx');
}

export function buildGraph(
  doc: vscode.TextDocument,
  options?: { validate?: boolean },
): { graph: Graph; errors: string[] } {
  const graph  = parseivx(doc.getText());
  const errors = (options?.validate ?? true) ? (graph.validationErrors ?? []) : [];
  return { graph, errors };
}

export function createDiagnostics(
  doc: vscode.TextDocument,
  errors: string[],
): vscode.Diagnostic[] {
  return errors.map(msg => {
    const lineMatch = msg.match(/L(\d+)/) || msg.match(/Line (\d+)/);
    const range = lineMatch
      ? new vscode.Range(parseInt(lineMatch[1]!, 10) - 1, 0, parseInt(lineMatch[1]!, 10) - 1, 1000)
      : new vscode.Range(0, 0, doc.lineCount - 1, 1000);
    return new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error);
  });
}

export function getPanelTitle(errorCount: number, live: boolean): string {
  const base = `IVXS ${live ? 'Realtime Graph' : 'Graph'}`;
  return errorCount > 0
    ? `${base} (${errorCount} error${errorCount === 1 ? '' : 's'})`
    : live ? `${base} (Live)` : base;
}