// ivx-render.js — IVX Visual Rendering Engine
// SVG Renderer, Visual Style, Export Formats, Editor UI
// PROPRIETARY AND CONFIDENTIAL
// Copyright 2026 IVX. All rights reserved.
// Unauthorized reproduction or distribution of this file,
// or any portion of it, may result in severe civil and criminal penalties.




// ── script.js ────────────────────────────────────────────────────────────────


const NS = 'http://www.w3.org/2000/svg';
const BASEY = 40, YSTEP = 80, MAX_NODE_W = 260, PAD_X = 20, PAD_Y = 10;
const LINE_H = 14, CELL_PAD_X = 6, CELL_H = 22;
const BLOCK_GAP_Y = 28, BLOCK_PAD = 12, BLANK_LINE_THRESH = 2;

const NODE_FILL = { Decision:'#004b8d', Predictive:'#6a00a3', Function:'#92700a',
                    Start:'#007f00', End:'#7f0000', Input:'#007f00', Output:'#ED8936',
                    WaitBlock:'#7c4d00' };
const TYPE_FILL = { string:'#b45309', integer:'#60a5fa', float:'#14b8a6',
                    boolean:'#1e3a8a', range:'#ec4899', none:'#ef4444', list:'#6b7280', dict:'#7a4d2e' };

// State
let currentGraph, currentXSTEP = 140;
let nodePositions = new Map();
let dragOffsets   = new Map();
let blockOffsets  = new Map();
let blockState    = new Map();
let watchMap      = new Map();
let breakpoints   = new Set();
let varColorCache = new Map();
let lastRenderedBlocks = [];

let viewBox = { x:0, y:0, width:1000, height:800 };
let graphBounds   = { x:0, y:0, width:1000, height:800 };
let isFirstRender = true;

// Interaction state
let isPanning = false, panStart = {x:0,y:0}, panMoved = false, cancelNextClick = false;
let draggedId = null, dragStartMouse = {x:0,y:0}, isDragging = false;
let draggedBlockKey = null, blockDragStart = {x:0,y:0}, isBlockDragging = false;
let loopBowSign = 1;

// Edit overlay state
let activeEdit = null, activeEditInput = null, activeEditCancel = null;
const pendingEditCtx = new Map();

// Highlight/trace state
let traceEvents = [], traceIndex = 0, traceTimer;
let edgeOverlays = [], persistentOverlays = [];
let lastHighlightedId, stepIntoBtn, stepIntoCtx, persistentEdgeMode, persistentEdge;
let isVideoPlaying = false;

let showComments = false;

const svg      = /** @type {SVGSVGElement} */ (document.getElementById('canvas'));
const miniSvg  = /** @type {SVGSVGElement} */ (document.getElementById('minimap-canvas'));

// Hidden measure node for text measurement
const _measureSvg = document.createElementNS(NS, 'svg');
_measureSvg.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:2000px;height:200px;overflow:visible;visibility:hidden;pointer-events:none;';
document.body.appendChild(_measureSvg);
const measureNode = document.createElementNS(NS, 'text');
_measureSvg.appendChild(measureNode);

// Helpers
// ── Bidirectional source sync ─────────────────────────────────────────────────
// Map from graph node kind → IVX keyword (for reconstructing source lines)
const KIND_TO_KEY = {
  Decision: 'if', Input: 'take', Output: 'say', End: 'end',
  Connector: 'dot', Function: 'fun', Start: 'from'
};

function preprocessControlFlowSyntax(raw) {
  // Expand 'then' and 'so' as before, but only expand ';' as a statement
  // separator when it is outside of brackets/strings — so that 2D list
  // syntax like [1,2; 3,4] is preserved intact.
  const s = String(raw)
    .replace(/then\s+/g, '\n  ')
    .replace(/\bso\s+/g, '\n');

  // Expand ';' only outside brackets and quotes
  let result = '', depth = 0, inD = false, inS = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], prev = i > 0 ? s[i-1] : '';
    if (c === '"' && !inS && prev !== '\\') inD = !inD;
    else if (c === "'" && !inD && prev !== '\\') inS = !inS;
    else if (!inD && !inS) {
      if (c === '[' || c === '{' || c === '(') depth++;
      else if (c === ']' || c === '}' || c === ')') depth--;
    }
    if (c === ';' && depth === 0 && !inD && !inS) result += '\n';
    else result += c;
  }
  return result;
}

// Rewrite a single source line in-place, preserving indentation and keyword prefix.
function commitNodeEditToSource(line, newText) {
  const originalSrc = srcEl.value;
  const originalLines = originalSrc.split('\n');

  // Map preprocessed line index back to original source line index
  const prepToOrig = [];
  originalLines.forEach((origLine, origIdx) => {
    const expanded = preprocessControlFlowSyntax(origLine);
    const count = expanded.split('\n').length;
    for (let k = 0; k < count; k++) prepToOrig.push(origIdx);
  });

  const origLine = line >= 0 && line < prepToOrig.length ? prepToOrig[line] : line;
  const rawLines = originalLines;
  if (origLine < 0 || origLine >= rawLines.length) return;
  const raw = rawLines[origLine];
  line = origLine; // remap for the rest of the function
  const indent = raw.length - raw.trimStart().length;
  const prefix = raw.slice(0, indent);
  const trimmed = raw.trimStart();

  // Bug 1 fix: extract and preserve any trailing 'note ...' comment before tokenizing,
  // so it is re-appended after the new content and not silently dropped.
  let trailingNote = '';
  const noteIdx = trimmed.indexOf('note ');
  const workingTrimmed = noteIdx >= 0 ? trimmed.slice(0, noteIdx).trimEnd() : trimmed;
  if (noteIdx >= 0) trailingNote = ' ' + trimmed.slice(noteIdx);

  // Preserve any leading keyword tokens (incoming + nodeKey) and trailing outgoing token
  const tokens = workingTrimmed.split(/\s+/).filter(Boolean);
  const leadTokens = [];
  let ti = 0;
  if (ti < tokens.length && IN_KEYS.has(tokens[ti]))  { leadTokens.push(tokens[ti]); ti++; }
  if (ti < tokens.length && NODE_KEYS.has(tokens[ti])){ leadTokens.push(tokens[ti]); ti++; }
  const trailTokens = [];
  // Check last token for outgoing keyword
  const allTail = tokens.slice(ti);
  if (allTail.length > 0 && OUT_KEYS.has(allTail[allTail.length - 1])) {
    trailTokens.push(allTail.pop());
  }

  const parts = [...leadTokens, newText.trim(), ...trailTokens].filter(Boolean);
  rawLines[line] = prefix + parts.join(' ') + trailingNote;
  srcEl.value = rawLines.join('\n');
  if (typeof updateHighlight === 'function') updateHighlight();
  scheduleRender();
}

function insertNodeOnEdgeInSource(fromNodeId, toNodeId, nodeKind) {
  if (!currentGraph) return;
  const fromNode = currentGraph.nodes.find(n => n.id === fromNodeId);
  const toNode   = currentGraph.nodes.find(n => n.id === toNodeId);
  if (!fromNode || !toNode) return;

  const isImplicit = (n) => n.meta && (n.meta.includes('implicit start') || n.meta.includes('implicit end'));

  const originalSrc = srcEl.value;
  let originalLines = originalSrc.split('\n');

  const prepToOrig = [];
  const prepToSubLine = [];
  originalLines.forEach((origLine, origIdx) => {
    const expanded = preprocessControlFlowSyntax(origLine);
    const subLines = expanded.split('\n');
    subLines.forEach((_, k) => {
      prepToOrig.push(origIdx);
      prepToSubLine.push(k);
    });
  });

  const toOrigIdx = (prepLine) => {
    if (prepLine < 0) return -1;
    if (prepLine >= prepToOrig.length) return originalLines.length - 1;
    return prepToOrig[prepLine];
  };

  const parseLine = (raw) => {
    const indentSpaces = raw.length - raw.trimStart().length;
    const noteIdx = raw.indexOf('note ');
    const trimmed = (noteIdx >= 0 ? raw.slice(0, noteIdx) : raw).trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    let i = 0;
    let incoming = '';
    let nodeKey = '';
    if (i < tokens.length && IN_KEYS.has(tokens[i])) { incoming = tokens[i]; i++; }
    if (i < tokens.length && NODE_KEYS.has(tokens[i])) { nodeKey = tokens[i]; i++; }
    const rest = tokens.slice(i);
    let outgoing = '';
    if (rest.length > 0 && OUTGOING_KEYWORDS.includes(rest[rest.length - 1])) {
      outgoing = rest[rest.length - 1];
    }
    return { indentSpaces, incoming, nodeKey, outgoing };
  };

  const expandOrigLine = (raw) => {
    return preprocessControlFlowSyntax(raw).split('\n');
  };

  const fromOrigIdx = isImplicit(fromNode) ? -1 : toOrigIdx(fromNode.line);
  const toOrigIndex = isImplicit(toNode)   ? originalLines.length : toOrigIdx(toNode.line);
  const fromSubLine = isImplicit(fromNode) ? 0 : prepToSubLine[fromNode.line];

  let insertAfterOrig;
  let indentSpaces = 0;
  let inheritedOutgoing = '';
  let spliceAt;

  if (isImplicit(fromNode)) {
    spliceAt = 0;
  } else if (isImplicit(toNode)) {
    const fromRaw = originalLines[fromOrigIdx];
    const fp = parseLine(fromRaw);
    indentSpaces = fp.indentSpaces;
    if (fp.outgoing === 'prev' || fp.outgoing === 'next') {
      inheritedOutgoing = fp.outgoing;
      originalLines[fromOrigIdx] = fromRaw.replace(/\s+(prev|next)\s*$/, '');
    }
    spliceAt = originalLines.length;
  } else if (fromOrigIdx === toOrigIndex) {
    // fromNode and toNode on the same original line — expand it first
    const origRaw = originalLines[fromOrigIdx];
    const subLines = expandOrigLine(origRaw);
    originalLines.splice(fromOrigIdx, 1, ...subLines);
    spliceAt = fromOrigIdx + fromSubLine + 1;
    const fromSubRaw = subLines[fromSubLine];
    const fp = parseLine(fromSubRaw);
    indentSpaces = fp.indentSpaces;
    if (fp.outgoing === 'prev' || fp.outgoing === 'next') {
      inheritedOutgoing = fp.outgoing;
      originalLines[fromOrigIdx + fromSubLine] = fromSubRaw.replace(/\s+(prev|next)\s*$/, '');
    }
  } else {
    insertAfterOrig = fromOrigIdx;
    const fromRaw = originalLines[fromOrigIdx];
    const fp = parseLine(fromRaw);
    indentSpaces = fp.indentSpaces;
    if (fp.outgoing === 'prev' || fp.outgoing === 'next') {
      inheritedOutgoing = fp.outgoing;
      originalLines[fromOrigIdx] = fromRaw.replace(/\s+(prev|next)\s*$/, '');
    }
    if (toOrigIndex >= 0 && toOrigIndex < originalLines.length) {
      const toParsed = parseLine(originalLines[toOrigIndex]);
      if (toParsed.incoming === 'else') {
        indentSpaces = toParsed.indentSpaces;
        insertAfterOrig = toOrigIndex - 1;
        inheritedOutgoing = '';
      }
    }
    spliceAt = insertAfterOrig + 1;
  }

  const prefix = ' '.repeat(indentSpaces);
  const keyword = KIND_TO_KEY[nodeKind] || '';
  const placeholder = nodeKind === 'End' ? '' : 'new node';
  const outgoingSuffix = inheritedOutgoing ? ' ' + inheritedOutgoing : '';
  const newLine = keyword
    ? `${prefix}${keyword}${placeholder ? ' ' + placeholder : ''}${outgoingSuffix}`
    : `${prefix}${placeholder}${outgoingSuffix}`;

  originalLines.splice(spliceAt, 0, newLine);
  srcEl.value = originalLines.join('\n');
  _pendingInsertEditLine = spliceAt;
  if (typeof updateHighlight === 'function') updateHighlight();
  scheduleRender();
}

const sendMsg = (msg) => {
  if (msg.type === 'commitNodeEdit') {
    commitNodeEditToSource(msg.line, msg.newText);
  } else if (msg.type === 'insertNodeOnEdge') {
    insertNodeOnEdgeInSource(msg.fromNodeId, msg.toNodeId, msg.nodeKind);
  }
};

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
};
const title = (e, t) => { if (t) { const n = el('title'); n.textContent = t; e.appendChild(n); } };
const snap  = (v, s) => Math.round(v / s) * s;
const fwd   = (a, b) => b.line !== a.line ? b.line > a.line : b.segmentIndex >= a.segmentIndex;

const measureText = (s, size = 12) => {
  measureNode.setAttribute('font-size', String(size));
  measureNode.textContent = s || '';
  const _l=measureNode.getComputedTextLength();
  return _l>0?_l:(s||'').length*size*0.6;
};

function wrapText(text, maxW, fontSize = 12) {
  const lines = [];
  for (const rawLine of String(text).split(/\n/)) {
    let line = '';
    for (const w of rawLine.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + w : w;
      if (measureText(test, fontSize) > maxW && line) { lines.push(line); line = w; }
      else line = test;
    }
    lines.push(line);
  }
  return lines;
}

const classifyValue = raw => {
  const t = String(raw).trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return 'string';
  if (/^-?\d+$/.test(t))             return 'integer';
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(t)) return 'float';
  if (/^(true|false)$/i.test(t))     return 'boolean';
  if (/^none$/i.test(t))             return 'none';
  if (/^range\s*\(/.test(t))         return 'range';
  if (/^\[/.test(t))                 return 'list';
  if (/^\{/.test(t))                 return 'dict';
  return 'other';
};

const normType = raw => {
  const b = String(raw).trim().toLowerCase().replace(/[^a-z]/g,'');
  return ({int:'integer',str:'string',bool:'boolean'})[b]
    || (['integer','string','boolean','float','list','dict','range','none'].includes(b) ? b : '');
};

const normVar = raw => (String(raw ?? '').match(/^([A-Za-z_]\w*)/) || [])[1] || '';

const numericType = expr => {
  const s = String(expr);
  if (/\bfloat\s*\(/.test(s) || /\d+\.\d+/.test(s) || /\//.test(s)) return 'float';
  if (/\bint\s*\(/.test(s)   || /\d+/.test(s)       || /[+\-*%]/.test(s)) return 'integer';
  return '';
};

const extractComment = meta => {
  if (!meta) return '';
  // Only extract comments that start with 'note '
  const m = String(meta).match(/note (.*)/);
  return m ? m[1].trim() : '';
};

const fmtDecision = text => {
  const parts = String(text).split(/\s+(and|or)\s+/i).filter(Boolean);
  if (parts.length <= 1) return text;
  const lines = [parts[0]];
  for (let i = 1; i < parts.length; i += 2) lines.push(`${parts[i]||''} ${parts[i+1]||''}`.trim());
  return lines.join('\n');
};

// CSV split that respects brackets and quotes
function smartSplit(str, delim) {
  const parts = []; let cur = '', depth = 0, inS = false, inD = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i], esc = i > 0 && str[i-1] === '\\';
    if      (c === '"' && !esc && !inS) inD = !inD;
    else if (c === "'" && !esc && !inD) inS = !inS;
    else if (!inS && !inD) {
      if (c === '[') depth++;
      else if (c === ']') depth--;
    }
    if (c === delim && !depth && !inS && !inD) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur) parts.push(cur);
  return parts.map(s => s.trim()).filter(Boolean);
}

// ─── Label rendering ──────────────────────────────────────────────────────────
function createLabel(text, cx, cy, maxW, tooltip, parent = svg, colorMap = null, fontSize = 12, lineH = LINE_H, fill = '#eee') {
  const textEl = el('text', { 'text-anchor':'middle', 'dominant-baseline':'middle', 'font-size':fontSize }, parent);
  if (fill !== '#eee') textEl.style.fill = fill;
  title(textEl, tooltip);
  const lines  = wrapText(text, maxW, fontSize);
  const startY = cy - (lineH * lines.length) / 2 + lineH / 2;

  lines.forEach((line, i) => {
    const y = startY + i * lineH;
    if (!colorMap) {
      const ts = el('tspan', { x: cx, y }, textEl);
      ts.dataset.lineY = String(y);
      ts.textContent = line;
    } else {
      const re = /\w+/g; let last = 0, m, isFirst = true;
      const parts = [];
      while ((m = re.exec(line))) {
        if (m.index > last) parts.push({ t: line.slice(last, m.index), c: '' });
        parts.push({ t: m[0], c: colorMap.get(m[0]) || '' });
        last = m.index + m[0].length;
      }
      if (last < line.length) parts.push({ t: line.slice(last), c: '' });
      parts.forEach(p => {
        const ts = el('tspan', isFirst ? { x: cx, y } : {}, textEl);
        if (isFirst) { ts.dataset.lineY = String(y); isFirst = false; }
        ts.textContent = p.t;
        if (p.c) ts.style.fill = p.c;
      });
    }
  });
  return { textEl, bbox: textEl.getBBox() };
}

const shiftTextY = (textEl, delta) => {
  if (!delta) return;
  for (const ts of textEl.childNodes) {
    const b = ts.dataset?.lineY;
    if (b != null) ts.setAttribute('y', String(Number(b) + delta));
  }
};

// ─── Block bookkeeping ────────────────────────────────────────────────────────
// Stable key = sorted node IDs joined – survives re-renders
const blockKey = group => [...group].sort((a,b)=>a-b).join(',');

function getOrCreateBlockState(key) {
  if (!blockState.has(key)) blockState.set(key, { collapsed: false, label: '', color: '' });
  return blockState.get(key);
}

function isBlankLine(s) {
  return String(s ?? '').trim() === '';
}

function isValidCssColorToken(token) {
  const v = String(token ?? '').trim();
  if (!v) return false;
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return true;
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('span');
  probe.style.color = '';
  probe.style.color = v;
  return probe.style.color !== '';
}

function parseBlockDirectiveFromNoteLine(line) {
  const m = String(line ?? '').trim().match(/^note\s+(.+)$/i);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;

  const parts = body.split(/\s+/).filter(Boolean);
  let color = '';
  const labelParts = [];
  let consumedColor = false;

  for (const part of parts) {
    if (!consumedColor && isValidCssColorToken(part)) {
      color = part;
      consumedColor = true;
    } else {
      labelParts.push(part);
    }
  }

  return { color, label: labelParts.join(' ') };
}

function buildPreprocessedToOriginalMap(source) {
  const originalLines = String(source ?? '').split('\n');
  const prepToOrig = [];
  originalLines.forEach((line, idx) => {
    const expanded = preprocessControlFlowSyntax(line);
    const count = expanded.split('\n').length;
    for (let i = 0; i < count; i++) prepToOrig.push(idx);
  });
  return { originalLines, prepToOrig };
}

function readBlockDirectiveForPreprocessedLine(preLine, sourceInfo) {
  if (!sourceInfo) return null;
  const { originalLines, prepToOrig } = sourceInfo;
  if (!Array.isArray(originalLines) || !Array.isArray(prepToOrig)) return null;

  const origLine = (preLine >= 0 && preLine < prepToOrig.length) ? prepToOrig[preLine] : preLine;
  if (origLine == null || origLine < 0 || origLine >= originalLines.length) return null;

  let i = origLine - 1;
  while (i >= 0 && isBlankLine(originalLines[i])) i--;
  if (i < 0) return null;

  // If multiple note lines are stacked, use the FIRST one after the separator.
  let noteStart = i;
  while (noteStart - 1 >= 0 && /^note\b/i.test(String(originalLines[noteStart - 1]).trim())) {
    noteStart--;
  }

  const directive = parseBlockDirectiveFromNoteLine(originalLines[noteStart]);
  if (!directive) return null;

  let blanksAbove = 0;
  let j = noteStart - 1;
  while (j >= 0 && isBlankLine(originalLines[j])) { blanksAbove++; j--; }
  if (blanksAbove < 2) return null;

  return directive;
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function buildAdj(graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const childOf = new Map(), parentOf = new Map();
  for (const e of graph.edges) {
    (childOf.get(e.from) ?? (childOf.set(e.from,[]), childOf.get(e.from))).push(e);
    (parentOf.get(e.to)  ?? (parentOf.set(e.to,[]),  parentOf.get(e.to))).push(e);
  }
  return { byId, childOf, parentOf };
}

function propagate(map, parentOf, cond) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, parents] of parentOf) {
      if (map.has(id) || parents.length !== 1) continue;
      const v = cond(id, parents[0].from, map.get(parents[0].from));
      if (v !== undefined) { map.set(id, v); changed = true; }
    }
  }
}

function computeBranchInfo(graph, byId, childOf, parentOf) {
  const branchIdx = new Map(), decOf = new Map();
  for (const node of graph.nodes) {
    if (node.kind !== 'Decision') continue;
    (childOf.get(node.id) || [])
      .slice().sort((a,b) => {
        const na = byId.get(a.to), nb = byId.get(b.to);
        if (!na || !nb) return a.to - b.to;
        return na.line !== nb.line ? na.line - nb.line
             : na.segmentIndex !== nb.segmentIndex ? na.segmentIndex - nb.segmentIndex
             : na.id - nb.id;
      })
      .forEach((e, i) => { branchIdx.set(e.to, i); decOf.set(e.to, node.id); });
  }
  propagate(branchIdx, parentOf, (id, pid, pv) => pv);
  propagate(decOf,     parentOf, (id, pid, pv) => pv);
  return { branchIdx, decOf };
}

function computeLayering(graph, byId) {
  const depth = new Map(graph.nodes.map(n => [n.id, (n.kind==='Start'||n.kind==='Function'||n.kind==='WaitBlock') ? 0 : Infinity]));
  const fwdEdges = graph.edges.filter(e => { const a=byId.get(e.from),b=byId.get(e.to); return a&&b&&fwd(a,b); });
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (const e of fwdEdges) {
      const fd = depth.get(e.from), td = depth.get(e.to);
      if (fd!=null&&td!=null&&fd+1<td&&byId.get(e.to)?.kind!=='Function') { depth.set(e.to,fd+1); changed=true; }
    }
    if (!changed) break;
  }
  let fallback = Math.max(...[...depth.values()].filter(isFinite)) + 1;
  graph.nodes.slice()
    .sort((a,b) => a.line!==b.line ? a.line-b.line : a.segmentIndex!==b.segmentIndex ? a.segmentIndex-b.segmentIndex : a.id-b.id)
    .forEach(n => {
      if (n.kind==='Function' || n.kind==='WaitBlock') depth.set(n.id, 0);
      else if (!isFinite(depth.get(n.id))) depth.set(n.id, fallback++);
    });
  return depth;
}

function computeLayout(graph) {
  const { byId, childOf, parentOf } = buildAdj(graph);
  const { branchIdx, decOf } = computeBranchInfo(graph, byId, childOf, parentOf);
  const depthMap = computeLayering(graph, byId);
  const sourceInfo = (typeof srcEl !== 'undefined' && srcEl && typeof srcEl.value === 'string')
    ? buildPreprocessedToOriginalMap(srcEl.value)
    : null;
  const XSTEP = Math.max(100, Math.min(180,
    Math.max(80, ...graph.nodes.map(n => Math.min(measureText(n.text||n.kind)+PAD_X*2, MAX_NODE_W))) + 40));
  currentXSTEP = XSTEP;

  const centerX0 = snap(500, XSTEP);
  const positions = new Map();
  let fnOffset = XSTEP * 4;

  for (const node of graph.nodes) {
    const depth = isFinite(depthMap.get(node.id)) ? depthMap.get(node.id) : 0;
    const isFn   = node.kind === 'Function';
    const isWait = node.kind === 'WaitBlock';
    const cx = (isFn || isWait) ? centerX0 + fnOffset : centerX0;
    if (isFn || isWait) fnOffset += XSTEP * 3;
    positions.set(node.id, { id:node.id, kind:node.kind, centerX:cx, centerY:BASEY+depth*YSTEP, x:cx, y:BASEY+depth*YSTEP, width:0, height:0 });
  }

  // Function and WaitBlock body column alignment
  const fnXMap = new Map();
  for (const n of graph.nodes) {
    if (n.kind==='Function' || n.kind==='WaitBlock') fnXMap.set(n.id, positions.get(n.id).centerX);
  }
  for (const n of graph.nodes) {
    const mFun  = n.meta?.match(/fun-body-of=(\d+)/);
    const mWait = n.meta?.match(/wait-body-of=(\d+)/);
    const m = mFun || mWait;
    if (m && !n.meta?.includes('fun-call-inline')) {
      const p = positions.get(n.id), fnX = fnXMap.get(parseInt(m[1],10));
      if (fnX!=null && p) p.centerX = fnX;
    }
  }

  // 'from' Start nodes: place one XSTEP to the left of their merge connector,
  // at the same Y so the incoming edge reads left-to-right.
  for (const n of graph.nodes) {
    const m = n.meta?.match(/from-offset-of=(\d+)/);
    if (!m) continue;
    const connPos = positions.get(parseInt(m[1], 10));
    const fromPos = positions.get(n.id);
    if (connPos && fromPos) {
      fromPos.centerX = fromPos.x = connPos.centerX - XSTEP;
      fromPos.centerY = fromPos.y = connPos.centerY;
    }
  }

  // Branch X offsets
  const branchesPerDec = new Map();
  for (const n of graph.nodes) if (n.kind==='Decision') branchesPerDec.set(n.id, new Set());
  branchIdx.forEach((idx, nid) => { const d=decOf.get(nid); if (d!=null) branchesPerDec.get(d)?.add(idx); });
  branchIdx.forEach((idx, nid) => {
    const dId = decOf.get(nid), pos = positions.get(nid);
    if (!dId || !pos) return;
    const n = Math.max(...branchesPerDec.get(dId)) + 1;
    const slot = n%2===1 ? idx-(n-1)/2 : idx-n/2+0.5;
    pos.centerX = pos.x = snap((positions.get(dId)?.centerX ?? centerX0) + slot*XSTEP, XSTEP);
  });

  // Connector centering
  for (const node of graph.nodes) {
    if (node.kind!=='Connector' && node.kind!=='NextConnector') continue;
    const pos = positions.get(node.id), parents = parentOf.get(node.id)||[];
    if (!pos || !parents.length) continue;
    const decs = new Set(parents.map(e => decOf.get(e.from)).filter(v=>v!=null));
    if (decs.size!==1) continue;
    const xs = parents.map(e=>positions.get(e.from)?.centerX).filter(v=>v!=null);
    if (xs.length) pos.centerX = pos.x = snap((Math.min(...xs)+Math.max(...xs))/2, XSTEP);
  }

  // Collision resolution
  const byY = new Map();
  for (const pos of positions.values())
    (byY.get(pos.centerY) ?? (byY.set(pos.centerY,[]), byY.get(pos.centerY))).push(pos);
  for (const group of byY.values()) {
    if (group.length < 2) continue;
    const seen = new Map();
    for (const p of group) (seen.get(p.centerX) ?? (seen.set(p.centerX,[]), seen.get(p.centerX))).push(p);
    for (const dupes of seen.values()) {
      if (dupes.length < 2) continue;
      dupes.sort((a,b)=>a.id-b.id);
      const mid = (dupes.length-1)/2;
      dupes.forEach((p,i) => {
        const slot = i-mid;
        p.centerX = p.x = snap(p.centerX + (slot!==0 ? slot*XSTEP : (p.centerX>=centerX0?1:-1)*XSTEP), XSTEP);
      });
    }
  }

  // ── Block grouping ────────────────────────────────────────────────────────
  // Determine ownerKey per node
  const ownerOf = new Map();
  for (const n of graph.nodes) {
    const m = n.meta?.match(/fun-body-of=(\d+)/);
    ownerOf.set(n.id, m ? parseInt(m[1],10) : null);
  }

  // Bucket all nodes by owner.
  // Group function header node and its body into a single block keyed by function id.
  const buckets = new Map();
  for (const n of graph.nodes) {
    let key = null;
    if (n.kind === 'Function') {
      key = n.id;
    } else {
      const own = ownerOf.get(n.id) ?? null;
      if (own !== null) key = own;
    }
    (buckets.get(key) ?? (buckets.set(key,[]), buckets.get(key))).push(n);
  }

  // Split into groups; compute stable keys
  const segmentLines = new Set((graph.segments || []).map(s => s.physicalLine));
  const hasSegments = segmentLines.size > 0;
  const blankCountBetween = (a, b) => {
    if (!hasSegments) return Math.max(0, b - a - 1);
    let blanks = 0;
    for (let l = a + 1; l < b; l++) if (!segmentLines.has(l)) blanks++;
    return blanks;
  };
  const layoutBlocks = [];
  for (const [ownerKey, nodes] of buckets) {
    nodes.sort((a,b) => a.line!==b.line ? a.line-b.line : a.segmentIndex!==b.segmentIndex ? a.segmentIndex-b.segmentIndex : a.id-b.id);
    const splitAfter = new Set();
    for (let i=0; i<nodes.length-1; i++)
      if (blankCountBetween(nodes[i].line, nodes[i+1].line) >= BLANK_LINE_THRESH) splitAfter.add(nodes[i].id);
   
    let cur = new Set();
    for (const node of nodes) {
      cur.add(node.id);
      if (splitAfter.has(node.id)) { layoutBlocks.push({ ownerKey, group:cur }); cur=new Set(); }
    }
    if (cur.size) layoutBlocks.push({ ownerKey, group:cur });
  }

  // Apply vertical gaps per owner; build block boxes; FIX: shift applied AFTER box is measured
  const shiftByOwner = new Map();
  const blockBoxes = [];
  for (const blk of layoutBlocks) {
    const { ownerKey, group } = blk;
    const key = blockKey(group);
    const state = getOrCreateBlockState(key);
    const firstLine = Math.min(...[...group].map(id => positions.get(id)?.id != null ? byId.get(id)?.line ?? Infinity : Infinity));
    const directive = Number.isFinite(firstLine) ? readBlockDirectiveForPreprocessedLine(firstLine, sourceInfo) : null;

    const label = directive?.label ?? state.label ?? '';
    const color = directive?.color ?? state.color ?? '';

    state.label = label;
    state.color = color;
    const shift = shiftByOwner.get(ownerKey) ?? 0;

    // Apply cumulative shift from PREVIOUS blocks
    if (shift) {
      for (const id of group) {
        const p = positions.get(id);
        if (p) { p.centerY += shift; p.y = p.centerY - (p.height||0)/2; }
      }
    }

    // Measure bounding box AFTER shift
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for (const id of group) {
      const p = positions.get(id); if (!p) continue;
      const hw=(p.width||80)/2, hh=(p.height||30)/2;
      minX=Math.min(minX,p.centerX-hw); maxX=Math.max(maxX,p.centerX+hw);
      minY=Math.min(minY,p.centerY-hh); maxY=Math.max(maxY,p.centerY+hh);
    }
    if (!isFinite(minX)) continue;

    blockBoxes.push({ key, collapsed:state.collapsed, ownerKey, minX,maxX,minY,maxY, group, label, color });
    shiftByOwner.set(ownerKey, shift + BLOCK_GAP_Y);
  }

  nodePositions = positions;
  return { positions, blockBoxes, parentOf, branchIdx, decOf };
}

// ─── Hidden node computation ──────────────────────────────────────────────────
function computeHidden(graph, blockBoxes) {
  const hidden = new Set();
  // Layout-block collapse only
  for (const box of blockBoxes)
    if (box.collapsed) for (const id of box.group) hidden.add(id);
  return { hidden };
}

// ─── Block collapse: vertical compaction ─────────────────────────────────────
function applyCollapseShift(blockBoxes, positions) {
  const byOwner = new Map();
  for (const box of blockBoxes)
    (byOwner.get(box.ownerKey) ?? (byOwner.set(box.ownerKey,[]), byOwner.get(box.ownerKey))).push(box);
  for (const blocks of byOwner.values()) {
    blocks.sort((a,b)=>a.minY-b.minY);
    let removed = 0;
    for (const box of blocks) {
      if (removed) {
        for (const id of box.group) {
          const p = positions.get(id);
          if (p) { p.centerY -= removed; p.y = p.centerY - (p.height||0)/2; }
        }
      }
      if (box.collapsed) removed += (box.maxY - box.minY) + BLOCK_PAD*2;
    }
  }
}

// ─── Node shape factory ───────────────────────────────────────────────────────
function makeShape(node, cx, cy, w, h, x, y) {
  const isRet = node.kind==='Process' && node.meta?.includes('return-node');
  if (['Start','End','Function'].includes(node.kind) || isRet)
    return el('ellipse', {cx,cy,rx:w/2,ry:h/2});
  if (node.kind==='WaitBlock')
    // Stadium shape — ellipse with extra width for the trigger label
    return el('ellipse', {cx,cy,rx:w/2,ry:h/2});
  if (node.kind==='Decision')
    return el('polygon', { points:[[cx,cy-h/2],[cx+w/2,cy],[cx,cy+h/2],[cx-w/2,cy]].map(p=>p.join(',')).join(' ') });
  if (node.kind==='Input' || node.kind==='Output') {
    const s = w*0.125;
    return el('polygon', { points:[[x,y],[x+w-s,y],[x+w,y+h],[x+s,y+h]].map(p=>p.join(',')).join(' ') });
  }
  return el('rect', {x,y,width:w,height:h,rx:4,ry:4});
}

// ─── Variable color map ───────────────────────────────────────────────────────
function buildVarColorMap(graph) {
  const map = new Map();
  for (const node of graph.nodes) {
    // Param colors from function headers
    if (node.kind==='Function' || node.meta?.includes('fun-header')) {
      for (const [k,v] of buildParamColors(node.text||'', node.id, graph.nodes)) map.set(k,v);
    }
    if (!node.title) continue;
    const varName = normVar(node.title);
    if (!varName) continue;
    const meta = node.meta||'';
    let typeKey = node.meta?.match(/\btype=(\w+)\b/)?.[1] || '';
    if (!typeKey) typeKey = /\blist\b/.test(meta) ? 'list' : /\bdict\b/.test(meta) ? 'dict' : classifyValue(node.text||'');
    if (typeKey==='other') typeKey = numericType(node.text||'');
    const color = TYPE_FILL[typeKey];
    if (color) map.set(varName, color);
  }
  return map;
}

function buildParamColors(funText, headerId, nodes) {
  const map = new Map();
  const m = String(funText).match(/^[^(]*\(([^)]*)\)/);
  if (!m) return map;
  for (const raw of m[1].split(',').map(p=>p.trim()).filter(Boolean)) {
    const base = raw.replace(/^\*+/,'').trim();
    const [namePart, typePart] = base.split(':');
    if (!namePart) continue;
    const name = namePart.split('=')[0].trim();
    let typeName = typePart ? normType(typePart.split('=')[0]) : '';
    if (!typeName && headerId!=null) {
      for (const node of nodes) {
        if (!node?.meta?.includes(`fun-body-of=${headerId}`) || node.title!==name) continue;
        const tm = node.meta?.match(/\btype=(\w+)\b/);
        typeName = normType(tm?.[1]??'') || numericType(node.text||'');
        if (typeName) break;
      }
    }
    const color = TYPE_FILL[typeName];
    if (name && color) map.set(name, color);
  }
  return map;
}

// ─── Render table nodes (list/dict) ──────────────────────────────────────────
function renderTableNode(node, pos, cx, cy, kind) {

  // ── Parse variable name and value ───────────────────────────────────────────
  const fullText = node.text.trim();
  const stripped = fullText.replace(/^makes+/, '');
  const nameMatch = stripped.match(/^([A-Za-z_]w*)s+([[{][sS]*)/);
  const varName  = nameMatch ? nameMatch[1] : null;
  const rawValue = nameMatch ? nameMatch[2].trim() : stripped;
  const inner    = rawValue.replace(/^[[{]/, '').replace(/[]}]$/, '').trim();

  // ── Build rows ───────────────────────────────────────────────────────────────
  let rows = [];
  if (kind === 'list') {
    if (inner.includes(';')) {
      // IVX 2D syntax: [1,2,3; 4,5,6]
      rows = inner.split(';').map(rowStr =>
        smartSplit(rowStr.trim(), ',').map(s => s.trim()).filter(s => s !== '')
      );
      const maxCols = Math.max(...rows.map(r => r.length), 1);
      rows.forEach(r => { while (r.length < maxCols) r.push(''); });
    } else if (inner.trimStart().startsWith('[')) {
      // Nested [[1,2],[3,4]] syntax
      rows = smartSplit(inner, ',')
        .map(s => s.trim()).filter(s => s.startsWith('['))
        .map(r => smartSplit(r.replace(/^[/,'').replace(/]$/,''), ',').map(s => s.trim()));
      const maxCols = Math.max(...rows.map(r => r.length), 1);
      rows.forEach(r => { while (r.length < maxCols) r.push(''); });
    } else {
      rows = [smartSplit(inner, ',').map(s => s.trim())];
    }
  } else {
    const pairs = smartSplit(inner, ',');
    rows = [
      pairs.map(p => smartSplit(p, ':')[0]?.trim() ?? ''),
      pairs.map(p => smartSplit(p, ':').slice(1).join(':').trim()),
    ];
  }

  if (!rows.length || !rows[0].length) {
    Object.assign(pos, { x: cx-40, y: cy-15, width: 80, height: 30, edgeTop: cy-15, edgeBottom: cy+15 });
    return;
  }

  const numCols = Math.max(...rows.map(r => r.length), 1);
  const numRows = rows.length;

  // ── Column widths ────────────────────────────────────────────────────────────
  let colWs = Array.from({ length: numCols }, (_, c) =>
    Math.max(...rows.map(r => measureText(String(r[c] ?? '')) + 2 * CELL_PAD_X), 36)
  );
  let totalW = colWs.reduce((a, b) => a + b, 0);
  const MIN_W = Math.max(MAX_NODE_W / 3, 80);
  if (totalW < MIN_W) {
    const scale = MIN_W / totalW;
    colWs = colWs.map(w => w * scale);
    totalW = MIN_W;
  }

  // ── Geometry ─────────────────────────────────────────────────────────────────
  const BADGE_H  = varName ? 18 : 0;
  const totalH   = numRows * CELL_H;
  const topOfAll = cy - (BADGE_H + totalH) / 2;
  const gridY    = topOfAll + BADGE_H;
  const x0       = cx - totalW / 2;
  const g = el('g', {}, svg);

  // ── Variable name badge — just the name, no [] or {} ─────────────────────────
  if (varName) {
    const badgeColor = kind === 'list' ? '#1e3a5f' : '#7c2d12';
    const badgeEl = el('rect', { x: x0, y: topOfAll, width: totalW, height: BADGE_H,
      rx: 4, ry: 4, fill: badgeColor, stroke: '#6b7280', 'stroke-width': 1 }, g);
    badgeEl.dataset.nodeId = node.id;
    const lbl = el('text', { x: cx, y: topOfAll + BADGE_H/2 + 1,
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': 11, fill: kind === 'list' ? '#93c5fd' : '#fcd34d' }, g);
    lbl.textContent = varName;
    lbl.setAttribute('font-weight', '600');
    lbl.dataset.nodeId = node.id;
  }

  // ── Outer border ─────────────────────────────────────────────────────────────
  const borderColor = kind === 'list' ? '#4b5563' : '#92400e';
  const bg = el('rect', { x: x0, y: gridY, width: totalW, height: totalH,
    rx: 3, ry: 3, fill: 'none', stroke: borderColor, 'stroke-width': 1.5 }, g);
  title(bg, extractComment(node.meta));
  bg.dataset.nodeId = node.id;

  // ── Cells ────────────────────────────────────────────────────────────────────
  rows.forEach((row, ri) => {
    const isDictHeader = kind === 'dict' && ri === 0;
    const rowBg    = isDictHeader ? '#7c2d12' : ri % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.15)';
    const textFill = isDictHeader ? '#fcd34d' : '#e5e7eb';
    let curX = x0;
    for (let c = 0; c < numCols; c++) {
      const cw = colWs[c], ry2 = gridY + ri * CELL_H;
      el('rect', { x: curX, y: ry2, width: cw, height: CELL_H, fill: rowBg, stroke: 'none' }, g);
      if (c < numCols-1) el('line', { x1: curX+cw, y1: ry2, x2: curX+cw, y2: ry2+CELL_H, stroke: borderColor, 'stroke-width': 0.5 }, g);
      if (ri < numRows-1) el('line', { x1: curX, y1: ry2+CELL_H, x2: curX+cw, y2: ry2+CELL_H, stroke: borderColor, 'stroke-width': 0.5 }, g);
      const cellText = String(row[c] ?? '');
      if (cellText) {
        const t = el('text', { x: curX+cw/2, y: ry2+CELL_H/2+1,
          'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-size': isDictHeader ? 11 : 12, fill: textFill }, g);
        if (isDictHeader) t.setAttribute('font-weight', '600');
        t.textContent = cellText;
        t.dataset.nodeId = node.id;
      }
      curX += cw;
    }
  });

  Object.assign(pos, {
    x: x0, y: topOfAll, width: totalW, height: BADGE_H + totalH,
    edgeTop: topOfAll, edgeBottom: gridY + totalH,
  });
}

// ─── Render nodes ─────────────────────────────────────────────────────────────
function renderNodes(graph, positions, hidden) {
  const vcMap = buildVarColorMap(graph);
  varColorCache = vcMap;
  const funFooterOf = new Map();
  for (const n of graph.nodes) {
    const m = n.meta?.match(/fun-footer-of=(\d+)/);
    if (m) funFooterOf.set(parseInt(m[1],10), n.id);
  }

  for (const node of graph.nodes) {
    if (hidden.has(node.id)) continue;
    const pos = positions.get(node.id);
    if (!pos) continue;
    const { centerX:cx, centerY:cy } = pos;

    // Connector dots
    if (node.kind==='Connector' || node.kind==='NextConnector') {
      const r=6, fill=node.kind==='Connector'?'#bbb':'#00bfff';
      const c = el('circle',{cx,cy,r,fill,stroke:'#ccc','stroke-width':1.5},svg);
      title(c, extractComment(node.meta)); c.dataset.nodeId=node.id; c.style.cursor='text';
      Object.assign(pos,{x:cx-r,y:cy-r,width:r*2,height:r*2,edgeTop:cy-r,edgeBottom:cy+r});
      continue;
    }

    const raw = node.text.trim();
    const meta = node.meta||'';
    if (/\blist\b/.test(meta)) { renderTableNode(node,pos,cx,cy,'list'); continue; }
    if (/\bdict\b/.test(meta)) { renderTableNode(node,pos,cx,cy,'dict'); continue; }

    // Strictly match 'fun' as the first token only
    const isFun = (node.kind==='Process'||node.kind==='Function') && /^fun(\s|$)/.test(raw);
    const isFunCall = node.kind==='Process' && /^[A-Za-z_]\w*\s*\(/.test(raw);
    const isElse = node.kind==='Process' && raw.startsWith('else');
    let bodyLabel = isElse ? raw.slice(5).trim() : isFun ? raw.replace(/^fun(\s|$)/,'').trim() : raw||node.kind;
    if (node.kind==='Decision') bodyLabel = fmtDecision(bodyLabel);

    const isFunHeader = node.kind==='Function' || meta.includes('fun-header');
    let labelText = bodyLabel;
    if (isFunHeader) {
      const m2 = bodyLabel.match(/^([^(]+)\(([^)]*)\)\s*$/);
      if (m2) labelText = `${m2[1].trim()}\n(${m2[2].trim()})`;
    }
    const labelMap = isFunHeader ? new Map([...vcMap, ...buildParamColors(raw,node.id,graph.nodes)]) : vcMap;

    const g = el('g',{},svg);
    const tooltip = extractComment(meta);
    const { textEl:bodyTxt, bbox:bodyBB } = createLabel(labelText,cx,cy,MAX_NODE_W-PAD_X*2,tooltip,g,labelMap);
    let bw = Math.max(bodyBB.width+PAD_X*2, 60);
    let bh = Math.max(bodyBB.height+PAD_Y*2, 30);

    if (showComments) {
      const cmtText = extractComment(meta);
      if (cmtText) {
        const { textEl:cmtEl, bbox:cmtBB } = createLabel(cmtText,cx,cy,MAX_NODE_W-PAD_X*2,tooltip,g,null,11,12,'#4ade80');
        const gap=6, totalH=bodyBB.height+gap+cmtBB.height;
        shiftTextY(bodyTxt, cy - totalH/2 + bodyBB.height/2 - cy);
        shiftTextY(cmtEl,   cy - totalH/2 + bodyBB.height + gap + cmtBB.height/2 - cy);
        bw = Math.max(Math.max(bodyBB.width,cmtBB.width)+PAD_X*2, 60);
        bh = Math.max(totalH+PAD_Y*2, 30);
        cmtEl.dataset.nodeId = node.id; cmtEl.style.cursor='text';
      }
    }

    let edgeTop = cy-bh/2;
    if (node.title) {
      const { textEl:hTxt, bbox:hBB } = createLabel(node.title,cx,cy-bh/2-10,MAX_NODE_W-PAD_X*2,tooltip,g);
      const hw=Math.max(hBB.width+PAD_X/2,40), hh2=Math.max(hBB.height+4,18);
      const hy = cy-bh/2+6-hh2;
      for (const ts of hTxt.childNodes) ts.setAttribute('y', String(Number(ts.getAttribute('y')||0)+(hy+hh2/2)-(cy-bh/2-10)));
      const titleColor = (normVar(node.title)&&vcMap.get(normVar(node.title)))||TYPE_FILL[classifyValue(bodyLabel)]||'#222831';
      const hRect = el('rect',{x:cx-hw/2,y:hy,width:hw,height:hh2,rx:4,ry:4,fill:titleColor,stroke:'#ccc','stroke-width':1});
      g.insertBefore(hRect, hTxt); hTxt.dataset.nodeId=node.id; hTxt.style.cursor='text';
      edgeTop = Math.min(edgeTop, hy);
    }

    const shape = makeShape(node,cx,cy,bw,bh,cx-bw/2,cy-bh/2);
    const isImport = node.kind==='Process' && /^(import|from)\b/.test(raw);
    shape.setAttribute('fill', isImport?'#007f00':(NODE_FILL[node.kind]||(isFun||isFunCall?'#92700a':'#333')));
    if (breakpoints.has(node.id)) {
      shape.setAttribute('stroke','#ff4444');
      shape.setAttribute('stroke-width','3');
    } else {
      shape.setAttribute('stroke','#ccc');
      shape.setAttribute('stroke-width','1.5');
    }
    title(shape,tooltip);
    shape.dataset.nodeId = node.id; shape.style.cursor='text';
    bodyTxt.dataset.nodeId = node.id; bodyTxt.style.cursor='text';
    g.insertBefore(shape, bodyTxt);
    Object.assign(pos,{x:cx-bw/2,y:cy-bh/2,width:bw,height:bh,edgeTop,edgeBottom:cy+bh/2});

    if (watchMap.has(node.id)) {
      const wt = el('text',{x:cx+bw/2+12,y:cy,'text-anchor':'start','dominant-baseline':'middle','font-size':12},g);
      wt.style.fill='#888'; wt.style.fontStyle='italic'; wt.textContent=watchMap.get(node.id);
    }
  }
  return funFooterOf;
}

// ─── Block backgrounds ────────────────────────────────────────────────────────
function renderBlockBg(blockBoxes, positions) {
  const HEADER_H = 18, BTN = 10, CLEARANCE = 4;
  for (const box of blockBoxes) {
    const { key, minX, maxX, minY, maxY } = box;
    const x = minX - BLOCK_PAD, w = (maxX-minX)+BLOCK_PAD*2;
    const headerY = minY - HEADER_H - CLEARANCE;
    const contentH = (maxY - minY) + BLOCK_PAD;
    const customColor = (box.color || '').trim();
    const hasCustomColor = !!customColor;

    const shellFill = hasCustomColor ? customColor : 'rgba(255,255,255,0.025)';
    const shellFillOpacity = hasCustomColor ? 0.07 : 1;
    const shellStroke = hasCustomColor ? customColor : 'rgba(255,255,255,0.07)';
    const shellStrokeOpacity = hasCustomColor ? 0.45 : 1;

    const headerFill = hasCustomColor ? customColor : 'rgba(40,40,70,0.9)';
    const headerFillOpacity = hasCustomColor ? 0.24 : 1;
    const headerStroke = hasCustomColor ? customColor : 'rgba(255,255,255,0.07)';
    const headerStrokeOpacity = hasCustomColor ? 0.7 : 1;

    // All block chrome goes in one group tagged for back-insertion
    const g = el('g', {
      'data-block-bg':'1',
      'data-block-key': key,
      'data-block-label': (box.label || '').trim(),
      'data-block-color': customColor,
    }, svg);

    el('rect',{x,y:headerY,width:w,height:HEADER_H+CLEARANCE+contentH,rx:8,ry:8,
      fill:shellFill,'fill-opacity':shellFillOpacity,stroke:shellStroke,'stroke-opacity':shellStrokeOpacity,'stroke-width':1,
      style:'pointer-events:none;'},g);

    el('rect',{x,y:headerY,width:w,height:HEADER_H,rx:5,ry:5,
      fill:headerFill,'fill-opacity':headerFillOpacity,stroke:headerStroke,'stroke-opacity':headerStrokeOpacity,'stroke-width':1,'data-block-key':key,style:'cursor:grab'},g);

    const lbl = el('text',{x:x+8,y:headerY+HEADER_H-5,'text-anchor':'start','font-size':10,fill:hasCustomColor?'#e5e7eb':'#9ca3af','data-block-label-key':key,style:'cursor:text;user-select:none;'},g);
    const customLabel = (box.label || '').trim();
    lbl.textContent = customLabel || `Block ${key.split(',')[0]}…`;
  }
}

// ─── Edges ────────────────────────────────────────────────────────────────────
function edgeClearance(x1,y1,x2,y2,positions,fromId,toId,hidden) {
  const MARGIN=16, dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy);
  if (!len) return 0;
  const ux=dx/len, uy=dy/len, midX=(x1+x2)/2;
  let sum=0, cnt=0;
  for (const [id,pos] of positions) {
    if (id===fromId||id===toId||hidden.has(id)||!pos.width||!pos.height) continue;
    const t=Math.max(0,Math.min(1,((pos.centerX-x1)*ux+(pos.centerY-y1)*uy)/len));
    const px=x1+t*ux*len, py=y1+t*uy*len;
    if (Math.abs(pos.centerX-px)<pos.width/2+MARGIN && Math.abs(pos.centerY-py)<pos.height/2+MARGIN)
      { sum+=pos.centerX-midX; cnt++; }
  }
  return cnt ? sum/cnt : 0;
}

function drawEdge(x1,y1,x2,y2,label,bow=0,fromId,toId) {
  const midX=(x1+x2)/2, midY=(y1+y2)/2;
  const nat = 0.3*(x2-x1);
  const avoid = bow ? -Math.sign(bow)*Math.abs(currentXSTEP*1.5) : 0;
  let loop = 0;
  if (y2<y1 && Math.abs(nat+avoid)<currentXSTEP*0.5) { loop=loopBowSign*currentXSTEP*1.5; loopBowSign*=-1; }
  const cpX = midX+nat+avoid+loop;
  const color = label==='true'?'#4ade80':label==='false'?'#f87171':'#aaa';
  const eA = fromId!=null ? {'data-edge-from':fromId,'data-edge-to':toId} : {};
  const d = `M ${x1} ${y1} Q ${cpX} ${midY} ${x2} ${y2}`;
  if (fromId!=null) el('path',{d,fill:'none',stroke:'transparent','stroke-width':12,style:'cursor:pointer;',...eA},svg);
  el('path',{d,fill:'none',stroke:color,'stroke-width':1.5,style:'pointer-events:none;',...eA},svg);
  const ang=Math.atan2(y2-midY,x2-cpX), AS=6;
  el('polygon',{points:[[x2,y2],[x2-AS*Math.cos(ang-Math.PI/6),y2-AS*Math.sin(ang-Math.PI/6)],[x2-AS*Math.cos(ang+Math.PI/6),y2-AS*Math.sin(ang+Math.PI/6)]].map(p=>p.join(',')).join(' '),fill:color,style:'pointer-events:none;',...eA},svg);
  if (label && label!=='break' && label!=='continue') {
    const t = el('text',{x:midX+avoid*0.5,y:midY-5,'text-anchor':'middle',fill:color,style:'pointer-events:none;'},svg);
    t.textContent=label;
  }
}

function renderEdges(graph, positions, hidden, extra=[], blockBoxes=[]) {
  const nodeBlock = new Map();
  for (const box of blockBoxes) for (const id of box.group) nodeBlock.set(id,box);
  loopBowSign = 1;
  for (const e of [...graph.edges,...extra]) {
    if (hidden.has(e.from)||hidden.has(e.to)) continue;
    const bF=nodeBlock.get(e.from), bT=nodeBlock.get(e.to);
    if (bF && bF===bT && bF.collapsed) continue;
    const fp=positions.get(e.from), tp=positions.get(e.to);
    if (!fp||!tp) continue;
    const x1=fp.centerX, y1=fp.edgeBottom??(fp.centerY+fp.height/2);
    const x2=tp.centerX, y2=tp.edgeTop??(tp.centerY-tp.height/2);
    drawEdge(x1,y1,x2,y2,e.label,edgeClearance(x1,y1,x2,y2,positions,e.from,e.to,hidden),e.from,e.to);
  }
}

// FIX: try-error brackets computed before edges, not after
function renderTryBrackets(graph, positions, hidden) {
  for (const tryNode of graph.nodes.filter(n=>n.meta?.includes('try-block'))) {
    const m = tryNode.meta?.match(/try-body=\[([^\]]*)\]/);
    if (!m) continue;
    const ids = m[1].split(',').map(id=>parseInt(id.trim(),10)).filter(id=>!isNaN(id)&&!hidden.has(id));
    if (!ids.length) continue;
    const fp=positions.get(ids[0]), lp=positions.get(ids[ids.length-1]);
    if (!fp||!lp) continue;

    // Reposition error handler BEFORE edges are drawn
    const errHandler = graph.nodes.find(n=>n.meta?.includes(`error-handler-of=${tryNode.id}`));
    if (errHandler) {
      const ep = positions.get(errHandler.id);
      if (ep) {
        ep.centerX=ep.x=fp.centerX-currentXSTEP*0.7-currentXSTEP*0.8;
        ep.centerY=ep.y=(fp.centerY+lp.centerY)/2;
      }
    }

    const bx=fp.centerX-currentXSTEP*0.7, top=fp.centerY, bot=lp.centerY;
    el('path',{d:`M ${bx+15} ${top} L ${bx} ${top} L ${bx} ${bot} L ${bx+15} ${bot}`,fill:'none',stroke:'#f59e0b','stroke-width':2,style:'pointer-events:none;'},svg);
    createLabel('try',bx-20,top,60,null,svg,null,11,12,'#f59e0b');
  }
}

// ─── Main render ──────────────────────────────────────────────────────────────
function renderGraph(graph) {
  currentGraph = graph;
  svg.textContent = '';

  const { positions, blockBoxes } = computeLayout(graph);

  // FIX: compute hidden BEFORE renderNodes so collapsed nodes are skipped
  const { hidden } = computeHidden(graph, blockBoxes);

  // Apply drag offsets to nodes
  for (const [id, off] of dragOffsets) {
    const p = positions.get(id);
    if (p) { p.centerX+=off.x; p.centerY+=off.y; p.x=p.centerX-p.width/2; p.y=p.centerY-p.height/2; }
  }

  // Apply block offsets to nodes within those blocks
  for (const box of blockBoxes) {
    const blockOff = blockOffsets.get(box.key);
    if (blockOff) {
      for (const nodeId of box.group) {
        const p = positions.get(nodeId);
        if (p) { p.centerX+=blockOff.x; p.centerY+=blockOff.y; p.x=p.centerX-p.width/2; p.y=p.centerY-p.height/2; }
      }
    }
  }

  // Collapse vertical compaction (shift visible nodes up past hidden blocks)
  applyCollapseShift(blockBoxes, positions);
  nodePositions = positions;

  // FIX: render try brackets BEFORE edges so error handler positions are correct
  renderTryBrackets(graph, positions, hidden);

  const funFooterOf = renderNodes(graph, positions, hidden);

  // Block backgrounds drawn AFTER renderNodes so real node sizes (width/height) are known.
  // Recompute minX/maxX/minY/maxY from actual rendered positions before drawing.
  for (const box of blockBoxes) {
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for (const id of box.group) {
      const p = positions.get(id); if (!p || !p.width) continue;
      // use edgeTop if set (accounts for title badges above the shape)
      const top = p.edgeTop ?? p.y;
      minX=Math.min(minX,p.x);      maxX=Math.max(maxX,p.x+p.width);
      minY=Math.min(minY,top);      maxY=Math.max(maxY,p.y+p.height);
    }
    if (isFinite(minX)) { box.minX=minX; box.maxX=maxX; box.minY=minY; box.maxY=maxY; }
  }

  // Keep a compact snapshot for export paths.
  lastRenderedBlocks = blockBoxes.map(box => ({
    key: box.key,
    label: (box.label || '').trim(),
    color: (box.color || '').trim(),
    collapsed: !!box.collapsed,
    ownerKey: box.ownerKey,
    nodes: [...box.group],
    bounds: {
      minX: box.minX, maxX: box.maxX,
      minY: box.minY, maxY: box.maxY,
    },
  }));

  renderBlockBg(blockBoxes, positions);
  // Push the full-bg rects AND header rects to back so they sit behind nodes.
  // We mark them with a data attribute in renderBlockBg to make selection reliable.
  const bgEls = Array.from(svg.querySelectorAll('[data-block-bg]'));
  for (const r of bgEls) svg.insertBefore(r, svg.firstChild);

  renderEdges(graph, positions, hidden, [], blockBoxes);

  // Stash blockBoxes so block label/color editing can find them
  if (currentGraph) currentGraph.__blockBoxes = blockBoxes;

  let bbox;try{bbox=svg.getBBox();}catch(e){bbox={x:0,y:0,width:800,height:600};}if(!bbox||(!bbox.width&&!bbox.height))bbox={x:0,y:0,width:800,height:600};const pad=80;
  graphBounds={x:bbox.x-pad,y:bbox.y-pad,width:bbox.width+pad*2,height:bbox.height+pad*2};
  if (isFirstRender) { viewBox={...graphBounds}; isFirstRender=false; }
  applyVB(); renderMinimap();

  if (lastHighlightedId!=null) {
    for (const e of svg.querySelectorAll(`[data-node-id="${lastHighlightedId}"]`))
      { e.dataset.highlight='true'; styleHL(e,true); }
    updateStepIntoBtn(lastHighlightedId);
  }
  redrawPersistentEdge();
}

const applyVB = () => svg.setAttribute('viewBox',`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);

// ─── Zoom / Pan ───────────────────────────────────────────────────────────────
function zoom(factor, cx, cy) {
  const ow=viewBox.width, oh=viewBox.height;
  viewBox.width*=factor; viewBox.height*=factor;
  const mn=Math.min(graphBounds.width,graphBounds.height)*0.05, mx=Math.max(graphBounds.width,graphBounds.height)*2;
  viewBox.width=Math.min(Math.max(viewBox.width,mn),mx);
  viewBox.height=viewBox.width*(svg.clientHeight/svg.clientWidth);
  if (cx!=null) {
    viewBox.x-=(viewBox.width-ow)*((cx-viewBox.x)/ow-0.5);
    viewBox.y-=(viewBox.height-oh)*((cy-viewBox.y)/oh-0.5);
  } else { viewBox.x+=(ow-viewBox.width)/2; viewBox.y+=(oh-viewBox.height)/2; }
  applyVB(); renderMinimap();
}
const pan = (dx,dy) => { viewBox.x-=dx; viewBox.y-=dy; applyVB(); renderMinimap(); };
const fitScreen = () => { viewBox={...graphBounds}; applyVB(); renderMinimap(); };

svg.addEventListener('wheel', e => {
  e.preventDefault();
  const r=svg.getBoundingClientRect();
  zoom(e.deltaY>0?1.1:0.9, viewBox.x+(e.clientX-r.left)/r.width*viewBox.width, viewBox.y+(e.clientY-r.top)/r.height*viewBox.height);
}, {passive:false});

svg.addEventListener('mousedown', e => {
  if (e.button!==0) return;
  const shape = e.target?.closest?.('ellipse,polygon,rect,circle');
  const edgePath = e.target?.closest?.('path[data-edge-from]');

  if (edgePath) {
    const from=parseInt(edgePath.getAttribute('data-edge-from')||'-1',10);
    const to  =parseInt(edgePath.getAttribute('data-edge-to')  ||'-1',10);
    if (from>-1&&to>-1) { showEdgeMenu(e,from,to); e.preventDefault(); return; }
  }

  // Check for block header drag
  const blockHeader = e.target?.getAttribute?.('data-block-key');
  if (blockHeader) {
    draggedBlockKey = blockHeader;
    blockDragStart = {x:e.clientX, y:e.clientY};
    isBlockDragging = false;
    e.preventDefault();
    return;
  }

  if (shape?.dataset.nodeId) {
    if (e.target?.tagName?.toLowerCase()==='text') return;
    draggedId=parseInt(shape.dataset.nodeId,10);
    const pos=nodePositions.get(draggedId);
    if (!pos) { draggedId=null; return; }
    dragStartMouse={x:e.clientX,y:e.clientY};
    isDragging=false; e.preventDefault(); return;
  }

  if (!e.target?.getAttribute?.('data-node-id') && !e.target?.closest?.('[data-node-id]')) {
    isPanning=true; svg.classList.add('panning');
    panStart={x:e.clientX,y:e.clientY}; panMoved=false; e.preventDefault();
  }
});

svg.addEventListener('contextmenu', e => {
  // Block header right-click → color picker
  const blockKey2 = e.target?.getAttribute?.('data-block-key');
  if (blockKey2) {
    const state = blockState.get(blockKey2);
    showBlockColorPicker(e, blockKey2, state?.color ?? '');
    return;
  }

  const shape = e.target?.closest?.('ellipse,polygon,rect,circle');
  if (shape?.dataset.nodeId) {
    const nodeId = parseInt(shape.dataset.nodeId, 10);
    if (breakpoints.has(nodeId)) {
      breakpoints.delete(nodeId);
    } else {
      breakpoints.add(nodeId);
    }
    renderGraph(currentGraph);
    e.preventDefault();
  }
});

window.addEventListener('mousemove', e => {
  const r=svg.getBoundingClientRect();
  if (draggedBlockKey!==null) {
    const dx=e.clientX-blockDragStart.x, dy=e.clientY-blockDragStart.y;
    if (!isBlockDragging && Math.hypot(dx,dy)<3) return;
    isBlockDragging=true; cancelNextClick=true;
    blockOffsets.set(draggedBlockKey,{x:dx*viewBox.width/r.width, y:dy*viewBox.height/r.height});
    renderGraph(currentGraph); return;
  }
  if (draggedId!==null) {
    const dx=e.clientX-dragStartMouse.x, dy=e.clientY-dragStartMouse.y;
    if (!isDragging && Math.hypot(dx,dy)<3) return;
    isDragging=true; cancelNextClick=true;
    dragOffsets.set(draggedId,{x:dx*viewBox.width/r.width, y:dy*viewBox.height/r.height});
    renderGraph(currentGraph); return;
  }
  if (!isPanning) return;
  if (!panMoved && Math.hypot(e.clientX-panStart.x,e.clientY-panStart.y)>3) { panMoved=true; activeEditCancel?.(); }
  pan((e.clientX-panStart.x)*viewBox.width/r.width, (e.clientY-panStart.y)*viewBox.height/r.height);
  panStart={x:e.clientX,y:e.clientY};
});

window.addEventListener('mouseup', () => {
  if (isPanning && panMoved) cancelNextClick=true;
  isPanning=false; svg.classList.remove('panning');
  // FIX: only set cancelNextClick if we actually dragged, then clear drag state
  if (isDragging) cancelNextClick=true;
  if (isBlockDragging) cancelNextClick=true;
  draggedId=null; isDragging=false;
  draggedBlockKey=null; isBlockDragging=false;
});

// ─── Minimap ──────────────────────────────────────────────────────────────────
function renderMinimap() {
  miniSvg.textContent='';
  if (!currentGraph) return;
  miniSvg.setAttribute('viewBox',`${graphBounds.x} ${graphBounds.y} ${graphBounds.width} ${graphBounds.height}`);
  for (const pos of nodePositions.values())
    if (pos.width) el('rect',{x:pos.x,y:pos.y,width:pos.width,height:pos.height,fill:'#555',stroke:'none'},miniSvg);
  el('rect',{class:'vp',x:viewBox.x,y:viewBox.y,width:viewBox.width,height:viewBox.height},miniSvg);
}
miniSvg.addEventListener('click', e => {
  const r=miniSvg.getBoundingClientRect();
  viewBox.x=graphBounds.x+(e.clientX-r.left)/r.width*graphBounds.width-viewBox.width/2;
  viewBox.y=graphBounds.y+(e.clientY-r.top)/r.height*graphBounds.height-viewBox.height/2;
  applyVB(); renderMinimap();
});

// ─── Edge insert menu ─────────────────────────────────────────────────────────
function showEdgeMenu(e, fromId, toId) {
  const menu = Object.assign(document.createElement('div'), {
    style:`position:fixed;left:${e.clientX}px;top:${e.clientY}px;background:#1e1e2e;border:1px solid #3a3a5c;border-radius:8px;padding:0;box-shadow:0 4px 16px rgba(0,0,0,.7);z-index:10000;font:12px system-ui;min-width:140px;overflow:hidden`
  });
  const header = Object.assign(document.createElement('div'), {
    textContent: 'Insert node',
    style: 'padding:6px 12px;color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #2a2a3e;background:#16161f'
  });
  menu.appendChild(header);
  const insertOptions = [
    { kind:'Process',   label:'Process',   key:'' },
    { kind:'Decision',  label:'if — Decision', key:'if' },
    { kind:'Input',     label:'take — Input',  key:'take' },
    { kind:'Output',    label:'say — Output', key:'say' },
    { kind:'Connector', label:'dot — Connector', key:'dot' },
    { kind:'End',       label:'end — End',   key:'end' },
  ];
  for (const opt of insertOptions) {
    const item = Object.assign(document.createElement('div'), {
      style:'padding:7px 14px;color:#cdd6f4;cursor:pointer;white-space:nowrap;user-select:none;display:flex;align-items:center;gap:8px'
    });
    if (opt.key) {
      const badge = Object.assign(document.createElement('span'), {
        textContent: opt.key,
        style:'font-family:monospace;font-size:10px;background:#2a2a3e;color:#89b4fa;padding:1px 5px;border-radius:3px;flex-shrink:0'
      });
      item.appendChild(badge);
    }
    item.appendChild(document.createTextNode(opt.key ? opt.label.split('—')[1].trim() : 'Process'));
    item.onmouseenter=()=>item.style.background='#313145';
    item.onmouseleave=()=>item.style.background='';
    item.onclick=()=>{ sendMsg({type:'insertNodeOnEdge',fromNodeId:fromId,toNodeId:toId,nodeKind:opt.kind}); menu.remove(); };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  // Ensure menu stays on screen
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth)  menu.style.left = (e.clientX - r.width) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = (e.clientY - r.height) + 'px';
  setTimeout(()=>document.addEventListener('mousedown',function h(ev){ if(!menu.contains(ev.target)){menu.remove();document.removeEventListener('mousedown',h);} }),0);
}

// ─── Block label + color write-back ──────────────────────────────────────────

// Find the note line that controls a block and rewrite it.
// The note line is the one immediately before the first node of the block
// (possibly separated by blank lines), following the same logic as
// readBlockDirectiveForPreprocessedLine.
function commitBlockDirectiveToSource(key, newLabel, newColor) {
  if (!currentGraph) return;
  const sourceInfo = (typeof srcEl !== 'undefined' && srcEl)
    ? buildPreprocessedToOriginalMap(srcEl.value) : null;
  if (!sourceInfo) return;

  const { originalLines, prepToOrig } = sourceInfo;

  // Find first preprocessed line belonging to this block
  const box = (currentGraph.__blockBoxes ?? []).find(b => b.key === key);
  if (!box) return;

  // Get the minimum graph line of nodes in this block
  const ids = key.split(',').map(Number);
  const lines = ids.map(id => currentGraph.nodes.find(n => n.id === id)?.line).filter(l => l != null);
  if (!lines.length) return;
  const firstPrepLine = Math.min(...lines);
  const origLine = (firstPrepLine >= 0 && firstPrepLine < prepToOrig.length)
    ? prepToOrig[firstPrepLine] : firstPrepLine;

  // Walk backwards to find the note line (skip blanks)
  let i = origLine - 1;
  while (i >= 0 && isBlankLine(originalLines[i])) i--;
  if (i < 0) return;

  // Verify it's a note line, or find the first in a stack
  let noteStart = i;
  while (noteStart - 1 >= 0 && /^note\b/i.test(String(originalLines[noteStart - 1]).trim())) {
    noteStart--;
  }
  if (!/^note\b/i.test(String(originalLines[noteStart]).trim())) return;

  // Also verify there are 2+ blank lines above the note (block separator)
  let blanksAbove = 0, j = noteStart - 1;
  while (j >= 0 && isBlankLine(originalLines[j])) { blanksAbove++; j--; }
  if (blanksAbove < 2) return;

  // Build new note line: "note [color] label"
  const parts = ['note'];
  const trimColor = (newColor || '').trim();
  const trimLabel = (newLabel || '').trim();
  if (trimColor) parts.push(trimColor);
  if (trimLabel) parts.push(trimLabel);
  originalLines[noteStart] = parts.join(' ');

  srcEl.value = originalLines.join('\n');
  updateHighlight();
  scheduleRender();

  // Also update blockState so UI is instant
  const state = blockState.get(key);
  if (state) { state.label = trimLabel; state.color = trimColor; }
}

// ─── Block label click-to-edit ────────────────────────────────────────────────

let activeBlockEdit = null;

function startBlockLabelEdit(key, labelEl, currentLabel, currentColor) {
  if (activeBlockEdit) activeBlockEdit.remove();

  // Get SVG position of the label element
  const bb = labelEl.getBBox();
  const fo = el('foreignObject', {
    x: bb.x - 4, y: bb.y - 2,
    width: Math.max(bb.width + 60, 120), height: bb.height + 8
  }, svg);

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = currentLabel;
  inp.placeholder = 'Block label…';
  Object.assign(inp.style, {
    width: '100%', height: '100%', background: '#1e1e2e',
    color: '#e5e7eb', border: '1px solid #89b4fa', borderRadius: '4px',
    padding: '1px 4px', fontSize: '11px', fontFamily: 'inherit', outline: 'none',
    boxSizing: 'border-box',
  });

  const commit = () => {
    const newLabel = inp.value.trim();
    fo.remove(); activeBlockEdit = null;
    commitBlockDirectiveToSource(key, newLabel, currentColor);
  };

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { fo.remove(); activeBlockEdit = null; }
  });
  inp.addEventListener('blur', commit);
  fo.appendChild(inp);
  activeBlockEdit = fo;
  setTimeout(() => { inp.focus(); inp.select(); }, 10);
}

// ─── Block color right-click picker ──────────────────────────────────────────

function showBlockColorPicker(e, key, currentColor) {
  e.preventDefault();
  // Remove any existing picker
  document.getElementById('block-color-picker-popup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'block-color-picker-popup';
  Object.assign(popup.style, {
    position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px',
    background: '#1e1e2e', border: '1px solid #3a3a5c', borderRadius: '10px',
    padding: '12px', boxShadow: '0 8px 24px rgba(0,0,0,.6)',
    zIndex: '10000', display: 'flex', flexDirection: 'column', gap: '10px',
    minWidth: '180px', fontFamily: 'system-ui, sans-serif',
  });

  // Title
  const title = document.createElement('div');
  title.textContent = 'Block color';
  Object.assign(title.style, { fontSize: '11px', color: '#9ca3af', fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: '.06em' });
  popup.appendChild(title);

  // Color wheel input
  const wheelRow = document.createElement('div');
  Object.assign(wheelRow.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  const wheel = document.createElement('input');
  wheel.type = 'color';
  wheel.value = currentColor && /^#/.test(currentColor) ? currentColor : '#4f46e5';
  Object.assign(wheel.style, { width: '48px', height: '48px', border: 'none',
    borderRadius: '6px', cursor: 'pointer', background: 'none' });
  wheelRow.appendChild(wheel);

  // Hex input
  const hexInp = document.createElement('input');
  hexInp.type = 'text';
  hexInp.value = wheel.value;
  hexInp.maxLength = 7;
  Object.assign(hexInp.style, { flex: '1', background: '#0f0f14', color: '#cdd6f4',
    border: '1px solid #3a3a5c', borderRadius: '4px', padding: '4px 6px',
    fontSize: '12px', fontFamily: 'monospace' });
  wheelRow.appendChild(hexInp);
  popup.appendChild(wheelRow);

  // Sync wheel ↔ hex
  wheel.addEventListener('input', () => { hexInp.value = wheel.value; });
  hexInp.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hexInp.value)) wheel.value = hexInp.value;
  });

  // Preset swatches
  const presets = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#db2777','#374151'];
  const swatchRow = document.createElement('div');
  Object.assign(swatchRow.style, { display: 'flex', flexWrap: 'wrap', gap: '5px' });
  for (const hex of presets) {
    const sw = document.createElement('div');
    Object.assign(sw.style, { width: '20px', height: '20px', borderRadius: '4px',
      background: hex, cursor: 'pointer', border: '2px solid transparent',
      transition: 'border-color .1s' });
    sw.addEventListener('mouseenter', () => sw.style.borderColor = '#fff');
    sw.addEventListener('mouseleave', () => sw.style.borderColor = 'transparent');
    sw.addEventListener('click', () => { wheel.value = hex; hexInp.value = hex; });
    swatchRow.appendChild(sw);
  }
  popup.appendChild(swatchRow);

  // Clear color option
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear color';
  Object.assign(clearBtn.style, { background: 'none', border: '1px solid #3a3a5c',
    color: '#9ca3af', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer',
    fontSize: '11px', fontFamily: 'inherit' });
  clearBtn.addEventListener('click', () => {
    const state = blockState.get(key);
    const label = state?.label ?? '';
    commitBlockDirectiveToSource(key, label, '');
    popup.remove();
  });
  popup.appendChild(clearBtn);

  // Apply button
  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  Object.assign(applyBtn.style, { background: '#1f4d6e', border: '1px solid #60a5fa',
    color: '#93c5fd', borderRadius: '5px', padding: '5px 12px', cursor: 'pointer',
    fontSize: '12px', fontFamily: 'inherit', fontWeight: '600' });
  applyBtn.addEventListener('click', () => {
    const state = blockState.get(key);
    const label = state?.label ?? '';
    commitBlockDirectiveToSource(key, label, hexInp.value.trim());
    popup.remove();
  });
  popup.appendChild(applyBtn);

  document.body.appendChild(popup);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('mousedown', function handler(ev) {
      if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('mousedown', handler); }
    });
  }, 0);
}

svg.addEventListener('click', e => {
  // FIX: reset cancelNextClick atomically so one stale flag can't eat two events
  if (cancelNextClick) { cancelNextClick=false; return; }

  // Block label text click → inline rename
  const labelKey = e.target?.getAttribute?.('data-block-label-key');
  if (labelKey) {
    const state = blockState.get(labelKey);
    startBlockLabelEdit(labelKey, e.target, state?.label ?? '', state?.color ?? '');
    return;
  }

  let el2=e.target;
  while (el2 && el2!==svg) {
    const id=el2.dataset?.nodeId;
    if (id!=null) {
      const nodeId=parseInt(id,10), node=currentGraph?.nodes.find(n=>n.id===nodeId);
      const pos=nodePositions.get(nodeId);
      if (!node||!pos) return;
      if (el2.tagName.toLowerCase()==='text' && el2.getBBox) {
        const bb=el2.getBBox(), s=window.getComputedStyle(el2);
        pendingEditCtx.set(nodeId,{textBox:{x:bb.x,y:bb.y,width:bb.width,height:bb.height},
          fontSize:s.fontSize||'12px',lineHeight:s.lineHeight||'14px',
          fontFamily:s.fontFamily||'system-ui, sans-serif',textAnchor:el2.getAttribute('text-anchor')||'middle'});
      } else pendingEditCtx.delete(nodeId);
      highlightNode(nodeId, null);
      return;
    }
    el2=el2.parentElement;
  }
});

// Double-click a node to edit its label inline and sync back to source
svg.addEventListener('dblclick', e => {
  if (cancelNextClick) return;
  let el2 = e.target;
  while (el2 && el2 !== svg) {
    const id = el2.dataset?.nodeId;
    if (id != null) {
      e.preventDefault();
      const nodeId = parseInt(id, 10);
      const node = currentGraph?.nodes.find(n => n.id === nodeId);
      const pos = nodePositions.get(nodeId);
      if (!node || !pos) return;
      // Capture text box from the text element if available
      const textEl = svg.querySelector(`[data-node-id="${nodeId}"]`);
      if (textEl?.tagName?.toLowerCase() === 'text' && textEl.getBBox) {
        const bb = textEl.getBBox(), s = window.getComputedStyle(textEl);
        pendingEditCtx.set(nodeId, {
          textBox: {x:bb.x, y:bb.y, width:bb.width, height:bb.height},
          fontSize: s.fontSize||'12px', lineHeight: s.lineHeight||'14px',
          fontFamily: s.fontFamily||'system-ui, sans-serif',
          textAnchor: textEl.getAttribute('text-anchor')||'middle'
        });
      }
      startNodeEdit({nodeId, text: node.text||'', x: pos.x, y: pos.y,
        width: pos.width, height: pos.height,
        line: node.line, segmentIndex: node.segmentIndex||0});
      return;
    }
    el2 = el2.parentElement;
  }
});

function startNodeEdit({ nodeId, text, x, y, width, height, line, segmentIndex }) {
  const ctx = nodeId!=null ? pendingEditCtx.get(Number(nodeId)) : null;
  if (nodeId!=null) pendingEditCtx.delete(Number(nodeId));
  const hideText = h => svg.querySelectorAll(`[data-node-id="${nodeId}"]`).forEach(el3=>{ if(el3.tagName.toLowerCase()==='text') el3.style.opacity=h?'0':''; });
  const cleanup = commit => {
    if (!activeEdit) return;
    if (commit) sendMsg({type:'commitNodeEdit',nodeId,newText:activeEditInput.value,line,segmentIndex});
    activeEdit.remove(); activeEdit=activeEditInput=activeEditCancel=null; hideText(false);
  };
  if (activeEdit) cleanup(false);
  hideText(true);
  const box = ctx?.textBox?.width>8&&ctx?.textBox?.height>8 ? ctx.textBox : {x,y,width,height};
  const fo = el('foreignObject',{x:box.x,y:box.y,width:box.width,height:box.height},svg);
  const div = document.createElement('div');
  Object.assign(div.style,{width:'100%',height:'100%',display:'flex',alignItems:'center',justifyContent:'center',background:'transparent'});
  const inp = document.createElement('input');
  inp.type='text'; inp.value=text;
  Object.assign(inp.style,{width:'100%',background:'transparent',color:'#eee',border:'none',outline:'none',padding:'0',margin:'0',
    textAlign:ctx?.textAnchor==='start'?'left':ctx?.textAnchor==='end'?'right':'center',
    fontFamily:ctx?.fontFamily||'system-ui, sans-serif',fontSize:ctx?.fontSize||'12px',
    lineHeight:ctx?.lineHeight||'14px',height:'100%',boxSizing:'border-box'});
  inp.addEventListener('keydown', e=>{ if(e.key==='Enter') cleanup(true); else if(e.key==='Escape') cleanup(false); });
  inp.addEventListener('blur', ()=>cleanup(false));
  div.appendChild(inp); fo.appendChild(div);
  activeEdit=fo; activeEditInput=inp; activeEditCancel=()=>cleanup(false);
  inp.focus(); inp.select();
}

function startNodeEditByLine({ line, text }) {
  if (!currentGraph) return;
  const node=currentGraph.nodes.find(n=>n.line===line); if (!node) return;
  const pos=nodePositions.get(node.id); if (!pos) return;
  const textEl=svg.querySelector(`text[data-node-id="${node.id}"]`);
  if (textEl?.getBBox) {
    const bb=textEl.getBBox(), s=window.getComputedStyle(textEl);
    pendingEditCtx.set(node.id,{textBox:{x:bb.x,y:bb.y,width:bb.width,height:bb.height},
      fontSize:s.fontSize||'12px',lineHeight:s.lineHeight||'14px',
      fontFamily:s.fontFamily||'system-ui',textAnchor:textEl.getAttribute('text-anchor')||'middle'});
  }
  startNodeEdit({nodeId:node.id,text:text||node.text||'',x:pos.x,y:pos.y,width:pos.width,height:pos.height,line,segmentIndex:node.segmentIndex||0});
}

// ─── Highlight / trace ────────────────────────────────────────────────────────
const styleHL = (el4, on) => {
  if (el4.tagName.toLowerCase()==='text') el4.style.fill=on?'#fffb66':'';
  else { el4.setAttribute('stroke',on?'#ffd54f':'#ccc'); el4.setAttribute('stroke-width',on?'3':'1.5'); el4.style.filter=on?'drop-shadow(0 0 8px #ffd54f)':''; }
};
function clearHL() {
  for (const e of svg.querySelectorAll('[data-highlight="true"]')) { e.removeAttribute('data-highlight'); styleHL(e,false); }
  for (const e of edgeOverlays) e.remove();
  edgeOverlays=[]; lastHighlightedId=null;
  if (stepIntoBtn) stepIntoBtn.style.display='none';
}
const clearPersistent = () => { for (const e of persistentOverlays) e.remove(); persistentOverlays=[]; persistentEdgeMode=persistentEdge=null; };

function flowEdge(x1,y1,x2,y2,target,color) {
  const mid=(x1+x2)/2, midY=(y1+y2)/2, cpX=mid+0.4*(x2-x1)+currentXSTEP*0.8;
  const d=`M ${x1} ${y1} Q ${cpX} ${midY} ${x2} ${y2}`;
  target.push(el('path',{d,fill:'none',stroke:color,'stroke-width':6,'stroke-opacity':.25,'stroke-linecap':'round'},svg));
  const f1=el('path',{d,fill:'none',stroke:color,'stroke-width':2.5,'stroke-dasharray':'10 8','stroke-linecap':'butt'},svg);
  f1.classList.add('flow-a'); target.push(f1);
  const f2=el('path',{d,fill:'none',stroke:color,'stroke-width':2.5,'stroke-dasharray':'2 16','stroke-linecap':'round','stroke-opacity':.85},svg);
  f2.classList.add('flow-b'); target.push(f2);
}

function highlightEdge(fromId, toId) {
  const path=svg.querySelector(`path[data-edge-from="${fromId}"][data-edge-to="${toId}"]`);
  if (!path) return;
  const d=path.getAttribute('d');
  edgeOverlays.push(el('path',{d,fill:'none',stroke:'#ffd54f','stroke-width':7,'stroke-opacity':.2,'stroke-linecap':'round'},svg));
  const f1=el('path',{d,fill:'none',stroke:'#ffd54f','stroke-width':2.5,'stroke-dasharray':'10 8','stroke-linecap':'butt'},svg);
  f1.classList.add('flow-a'); edgeOverlays.push(f1);
  const f2=el('path',{d,fill:'none',stroke:'#ffd54f','stroke-width':2.5,'stroke-dasharray':'2 16','stroke-linecap':'round','stroke-opacity':.85},svg);
  f2.classList.add('flow-b'); edgeOverlays.push(f2);
}

function drawVirtualEdge(fromId, toId, target=edgeOverlays, color='#c084fc') {
  const fp=nodePositions.get(fromId), tp=nodePositions.get(toId);
  if (fp&&tp) flowEdge(fp.centerX,fp.centerY+fp.height/2,tp.centerX,tp.centerY-tp.height/2,target,color);
}
const drawPersistentEdge = (f,t,c='#c084fc') => { clearPersistent(); drawVirtualEdge(f,t,persistentOverlays,c); persistentEdge={fromId:f,toId:t,color:c}; };
const redrawPersistentEdge = () => { if (!persistentEdge) return; for(const e of persistentOverlays) e.remove(); persistentOverlays=[]; drawVirtualEdge(persistentEdge.fromId,persistentEdge.toId,persistentOverlays,persistentEdge.color); };

const getFunCallTarget = id => { const m=currentGraph?.nodes.find(n=>n.id===id)?.meta?.match(/fun-call:(\d+)/); return m?parseInt(m[1],10):null; };
const getFunBodyHeader = n => { const m=n?.meta?.match(/fun-body-of=(\d+)/); return m?parseInt(m[1],10):null; };
const isFunExit = (node, hId) => {
  if (!node || getFunBodyHeader(node)!==hId) return false;
  if (node.meta?.includes('return-node')||node.text.trim().startsWith('return')) return true;
  return !currentGraph.edges.some(e=>e.from===node.id && getFunBodyHeader(currentGraph.nodes.find(n=>n.id===e.to))===hId);
};

function highlightNode(nodeId, nextId) {
  if (nodeId==null||nodeId===-1) {
    svg.style.transition='opacity .25s ease-out'; svg.style.opacity='.45';
    setTimeout(()=>{ clearHL(); svg.style.opacity='1'; svg.style.transition='opacity .2s ease-in'; },260);
    return;
  }
  clearHL(); lastHighlightedId=nodeId;
  for (const e of svg.querySelectorAll(`[data-node-id="${nodeId}"]`)) { e.dataset.highlight='true'; styleHL(e,true); }
  if (nextId!=null&&nextId!==-1) highlightEdge(nodeId,nextId);
  updateStepIntoBtn(nodeId);
  if (stepIntoCtx) {
    const node=currentGraph?.nodes.find(n=>n.id===nodeId);
    if (isFunExit(node,stepIntoCtx.headerNodeId)) { drawPersistentEdge(nodeId,stepIntoCtx.fromNodeId); persistentEdgeMode='return'; }
  }
  const pos=nodePositions.get(nodeId);
  if (pos) { viewBox.x=(pos.centerX??pos.x+pos.width/2)-viewBox.width/2; viewBox.y=(pos.centerY??pos.y+pos.height/2)-viewBox.height/2; applyVB(); renderMinimap(); }
}
const updateStepIntoBtn = id => { if(stepIntoBtn) stepIntoBtn.style.display=getFunCallTarget(id)!=null?'':'none'; };

// ─── Trace ────────────────────────────────────────────────────────────────────
const stopTrace = () => { clearTimeout(traceTimer); traceTimer=null; traceEvents=[]; traceIndex=0; };
function playNext() {
  if (traceIndex>=traceEvents.length) {
    if (isVideoPlaying) {
      isVideoPlaying = false;
      updateVideoButton();
    }
    return;
  }
  const speed=Number(speedSel.value)||1, ev=traceEvents[traceIndex++], nxt=traceIndex<traceEvents.length?traceEvents[traceIndex]:null;
  highlightNode(ev.nodeId, nxt?.nodeId??null);
  
  // Check if we hit a breakpoint
  if (breakpoints.has(ev.nodeId)) {
    if (isVideoPlaying) {
      isVideoPlaying = false;
      updateVideoButton();
      sendMsg({type:'seedExecFromVideo',nodeId:ev.nodeId});
    }
    return;
  }
  
  if (traceIndex<traceEvents.length) traceTimer=setTimeout(playNext, Math.max(10,(((nxt?.ts||0)-(ev.ts||0))||100)/speed));
  else if (isVideoPlaying) {
    isVideoPlaying = false;
    updateVideoButton();
  }
}
const startTrace = events => { stopTrace(); traceEvents=events.slice(); traceIndex=0; playNext(); };

// ─── Message handler ──────────────────────────────────────────────────────────
window.addEventListener('message', ({data:msg}) => {
  if (!msg) return;
  switch (msg.type) {
    case 'graph':             
      // FIX: clear drag offsets when a new graph arrives to avoid phantom offsets
      dragOffsets.clear(); blockOffsets.clear(); renderGraph(msg.graph); break;
    case 'startNodeEdit':     startNodeEdit(msg); break;
    case 'startNodeEditByLine': startNodeEditByLine(msg); break;
    case 'highlight':         highlightNode(msg.nodeId); break;
    case 'clearHighlights':   clearHL(); break;
    case 'stepAdvance':       { const pm=persistentEdgeMode; clearPersistent(); if(pm==='return') stepIntoCtx=null; break; }
    case 'trace':             if (msg.events && msg.events.length > 0) { isVideoPlaying=true; updateVideoButton(); } startTrace(msg.events||[]); break;
    case 'traceClear':        stopTrace(); isVideoPlaying=false; updateVideoButton(); break;
    case 'watchUpdate':       watchMap.clear(); (msg.items||[]).forEach(i=>watchMap.set(i.nodeId,i.text)); if(currentGraph) renderGraph(currentGraph); break;
    case 'watchClear':        watchMap.clear(); if(currentGraph) renderGraph(currentGraph); break;
    case 'stepIntoResult':    stepIntoCtx={fromNodeId:msg.fromNodeId,headerNodeId:msg.headerNodeId}; drawPersistentEdge(msg.fromNodeId,msg.headerNodeId); persistentEdgeMode='call'; setTimeout(()=>highlightNode(msg.headerNodeId),120); break;
  }
});

// ─── Controls ─────────────────────────────────────────────────────────────────
const ctrlRoot = document.getElementById('controls');
const mkBtn = (label, fn, style='') => {
  const b=Object.assign(document.createElement('button'),{textContent:label});
  if (style) b.style.cssText=style;
  if (typeof fn === 'function') b.addEventListener('click',fn);
  return b;
};

const speedSel = document.createElement('select');
for (const s of [0.25,0.5,1,1.5,2]) {
  const o=Object.assign(document.createElement('option'),{value:String(s),textContent:`${s}x`});
  if (s===1) o.selected=true; speedSel.appendChild(o);
}

const postStepNext = () => {
  if (persistentEdgeMode==='return'&&stepIntoCtx?.fromNodeId!=null)
    sendMsg({type:'stepNext',stepOutFrom:stepIntoCtx.fromNodeId});
  else sendMsg({type:'stepNext'});
};

let autoTimer;
const stopAuto = () => { clearTimeout(autoTimer); autoTimer=null; };
const startAuto = () => {
  stopAuto();
  const tick=()=>{ postStepNext(); autoTimer=setTimeout(tick, 300/(Number(speedSel.value)||1)); };
  tick();
};

let playVideoBtn;
const updateVideoButton = () => {
  if (isVideoPlaying) {
    playVideoBtn.textContent = '⏹';
    playVideoBtn.style.cssText = 'background:#6b2b2b;border-color:#f87171;color:#f87171';
  } else {
    playVideoBtn.textContent = '▶';
    playVideoBtn.style.cssText = 'background:#1f4d6e;border-color:#60a5fa;color:#60a5fa';
  }
};

const toggleVideoDebug = () => {
  if (isVideoPlaying) {
    isVideoPlaying = false;
    updateVideoButton();
    stopAuto();
    stopTrace();
    sendMsg({type:'traceClear'});
  } else {
    sendMsg({type:'playVideoDebug'});
  }
};

const sep = () => Object.assign(document.createElement('span'),{textContent:'|',style:'color:#555;margin:0 4px'});
ctrlRoot.append(
  mkBtn('<',()=>sendMsg({type:'stepPrev'})), mkBtn('Play',startAuto), mkBtn('Pause',()=>{ stopAuto(); stopTrace(); sendMsg({type:'traceClear'}); }), mkBtn('>',postStepNext)
);

stepIntoBtn = mkBtn('⤵', ()=>{ const t=getFunCallTarget(lastHighlightedId); if(t!=null) sendMsg({type:'stepInto',fromNodeId:lastHighlightedId,headerNodeId:t}); }, 'display:none;background:#3b1f6e;border-color:#c084fc;color:#c084fc');
const watchBtn = mkBtn('Watch',()=>sendMsg({type:'toggleWatchVariables'}));
playVideoBtn = mkBtn('▶',toggleVideoDebug, 'background:#1f4d6e;border-color:#60a5fa;color:#60a5fa');
ctrlRoot.append(stepIntoBtn, watchBtn, playVideoBtn, speedSel);


window.addEventListener('load', () => { if(typeof _ivxInit==='function') _ivxInit(); });

// ── Parser + Graph ──────────────────────────────────────────────────────────
const NODE_ARITY = {
    Start: { minIn: 0, maxIn: 0, minOut: 1, maxOut: 1 },
    End: { minIn: 1, maxIn: 1, minOut: 0, maxOut: 0 },
    Process: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
    Decision: { minIn: 1, maxIn: 1, minOut: 2, maxOut: Infinity },
    Connector: { minIn: 1, maxIn: Infinity, minOut: 1, maxOut: 1 },
    Input: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
    Output: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
    Function: { minIn: 0, maxIn: 1, minOut: 0, maxOut: 1 },
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
        const rules = NODE_ARITY[n.kind];
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

// --- Keyword groups ---
const INCOMING_KEYWORDS = ['then', 'else']; // 'then' is accepted but has no effect
// Bug 5 fix: 'note' is a comment marker, not a node keyword.  It must NOT be
// in NODE_KEYWORDS, otherwise parseLine sets nodeKey='note' and the main loop's
// else-branch silently creates a spurious Process node for every standalone
// 'note ...' line, and KIND_TO_KEY has no entry for it so round-trips break.
const NODE_KEYWORDS = ['if', 'fork', 'loop', 'dot', 'take', 'say', 'give', 'fun', 'end', 'from', 'wait', 'try'];
const OUTGOING_KEYWORDS = ['prev', 'next'];
const NODE_KEYS = new Set(NODE_KEYWORDS);
const IN_KEYS = new Set(INCOMING_KEYWORDS);
const OUT_KEYS = new Set(OUTGOING_KEYWORDS);
const makeCtx = (baseIndent, firstLast, savedLast = null) => ({
  scopeStack: [{ indent: baseIndent, lastExec: firstLast }],
  decStack: [], pendingElse: null, baseIndent, savedLastExec: savedLast,
});
function parseivx(source) {
  // Treat ';' as a line break and 'then ' as a newline with indent
  const preprocessed = preprocessControlFlowSyntax(source);
  const rawLines = preprocessed.split('\n');

  // Pass 1: parse lines and collect indent info
  const parsedLines = rawLines.map((raw, i) => {
    const commentIdx = raw.indexOf('note ');
    const trimmed = (commentIdx >= 0 ? raw.slice(0, commentIdx) : raw).trim();
    if (!trimmed) return { lineNum: i, indent: 0, raw: '', incoming: '', nodeKey: '', content: '', outgoing: '' };
    const indent = Math.floor((raw.length - raw.trimStart().length) / 2);
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    let j = 0;
    let incoming = '';
    let nodeKey = '';
    if (j < tokens.length && IN_KEYS.has(tokens[j])) { incoming = tokens[j]; j++; }
    if (!nodeKey && j < tokens.length && NODE_KEYS.has(tokens[j])) { nodeKey = tokens[j]; j++; }
    const remaining = tokens.slice(j);
    let outgoing = '';
    if (remaining.length > 0 && OUT_KEYS.has(remaining[remaining.length - 1])) outgoing = remaining.pop();
    return { lineNum: i, indent, raw: trimmed, incoming, nodeKey, content: remaining.join(' '), outgoing };
  });

  // Pass 2: assign fun-body-of and wait-body-of meta based on indentation
  let funStack = [];
  let lastFun = null;
  let lastFunIndent = -1;
  let waitStack = [];
  let lastWait = null;
  let lastWaitIndent = -1;
  for (let i = 0; i < parsedLines.length; i++) {
    const pl = parsedLines[i];
    // Fun tracking
    if (pl.nodeKey === 'fun' || pl.nodeKey === 'Function') {
      lastFun = i;
      lastFunIndent = pl.indent;
      funStack.push({ funLine: i, indent: pl.indent });
      pl._funHeader = true;
    } else if (lastFun !== null && pl.indent > lastFunIndent) {
      pl._funBodyOf = lastFun;
    } else if (lastFun !== null && pl.indent <= lastFunIndent) {
      funStack.pop();
      if (funStack.length > 0) {
        lastFun = funStack[funStack.length - 1].funLine;
        lastFunIndent = funStack[funStack.length - 1].indent;
      } else {
        lastFun = null;
        lastFunIndent = -1;
      }
    }
    // Try block tracking
    if (pl.nodeKey === 'try') {
      pl._tryHeader = true;
      pl._tryId = i;
    } else if (pl.raw === 'err' || pl.raw?.startsWith('err ')) {
      pl._errHandler = true;
      // Find most recent try header at same or lower indent
      for (let k = i - 1; k >= 0; k--) {
        if (parsedLines[k]._tryHeader && parsedLines[k].indent <= pl.indent) {
          pl._errHandlerOf = k;
          parsedLines[k]._errHandlerLine = i;
          break;
        }
      }
    } else {
      // Check if inside a try block
      for (let k = i - 1; k >= 0; k--) {
        if (parsedLines[k]._tryHeader && parsedLines[k].indent < pl.indent) {
          pl._tryBodyOf = k;
          break;
        }
        if (parsedLines[k].indent <= pl.indent) break;
      }
    }

    // Wait block tracking — detect wait with a trigger keyword after it
    const isWaitBlock = pl.nodeKey === 'wait' &&
      /^(email|sheets|time|http)\b/.test(pl.content);
    if (isWaitBlock) {
      lastWait = i;
      lastWaitIndent = pl.indent;
      waitStack.push({ waitLine: i, indent: pl.indent });
      pl._waitHeader = true;
    } else if (lastWait !== null && pl.indent > lastWaitIndent) {
      pl._waitBodyOf = lastWait;
    } else if (lastWait !== null && pl.indent <= lastWaitIndent) {
      waitStack.pop();
      if (waitStack.length > 0) {
        lastWait = waitStack[waitStack.length - 1].waitLine;
        lastWaitIndent = waitStack[waitStack.length - 1].indent;
      } else {
        lastWait = null;
        lastWaitIndent = -1;
      }
    }
  }

  // The rest of the parser should use parsedLines instead of re-parsing rawLines
  // (You may need to adapt the rest of the function to use parsedLines)
    const nodes = [];
    const edges = [];
    const validationErrors = [];
    let nextId = 1;
    const startNode = { id: 0, kind: 'Start', line: 0, segmentIndex: 0, indent: 0, text: '', meta: 'implicit start' };
    nodes.push(startNode);
    const connectors = [];
    const pendingNext = new Map();
    let ctx = makeCtx(-1, null);
    const ctxStack = [];
    const curScope = () => ctx.scopeStack[ctx.scopeStack.length - 1];
    const getLastExec = () => curScope().lastExec;
    const setLastExec = (n) => { curScope().lastExec = n; };
    const setLastExecAtIndent = (indent, n) => {
        // Update all scope entries whose indent is <= the target indent.
        // This matters for if-joins inside loop bodies: the loop body scope
        // sits on the stack with a lower indent than the if, but as a higher
        // stack index. We must update it so getLastExec() returns the if-join,
        // not the stale loop-body lastExec.
        let updated = false;
        for (let i = ctx.scopeStack.length - 1; i >= 0; i--) {
            if (ctx.scopeStack[i].indent <= indent) {
                ctx.scopeStack[i].lastExec = n;
                updated = true;
                // Continue updating enclosing scopes that are still active
                // and whose lastExec is stale (i.e. predates the if-join)
            }
        }
        if (!updated) ctx.scopeStack[0].lastExec = n;
    };
    const addNode = (kind, line, text, meta = '') => {
        const n = { id: nextId++, kind, line, segmentIndex: 0, indent: 0, text, meta: meta || undefined };
        nodes.push(n);
        return n;
    };
    const pushEdge = (from, to, label) => {
        if (from === to) {
            return;
        }
        if (edges.some(e => e.from === from && e.to === to && (e.label ?? '') === (label ?? ''))) {
            return;
        }
        edges.push({ from, to, label });
    };
    const wireSeq = (from, to) => { if (from) {
        pushEdge(from.id, to.id);
    } };
    // Wire sequentially and replace 'from' with 'to' in all decStack branchTails,
    // so the tail always points to the last node in a branch.
    const wireSeqAndUpdateTails = (from, to) => {
        wireSeq(from, to);
        if (from) {
            for (const d of ctx.decStack) {
                const idx = d.branchTails.indexOf(from);
                if (idx !== -1) d.branchTails[idx] = to;
            }
        }
    };
    const prevConn = (beforeLine) => {
        for (let i = connectors.length - 1; i >= 0; i--) {
            if (connectors[i].line < beforeLine) {
                return connectors[i];
            }
        }
        return null;
    };
    const consumePendingNext = (targetNode) => {
      if (!targetNode || targetNode.kind !== 'Connector') return;
      for (const id of pendingNext.keys()) {
        pushEdge(id, targetNode.id);
      }
      pendingNext.clear();
    };
    const hasEdgesFrom = (id) => edges.some(e => e.from === id);
    const isEnd = (n) => n.kind === 'End';
    const replaceBranchTail = (orig, rep) => {
        for (const d of ctx.decStack) {
            const idx = d.branchTails.indexOf(orig);
            if (idx !== -1) {
                d.branchTails[idx] = rep;
            }
        }
    };
    const makeDecisionCtx = (decNode, kind, indent, parentBranchDc = null, autoConnector = null) => ({
      decNode,
      autoConnector,
      branchTails: [],
      trueBranchHead: null,
      kind,
      indent,
      parentBranchDc
    });
    const promoteExitToParentBranch = (dc, exitNode) => {
        const parent = dc.parentBranchDc;
        if (!parent || !exitNode || isEnd(exitNode)) return;
        const oldIdx = parent.branchTails.indexOf(dc.decNode);
        if (oldIdx !== -1) parent.branchTails.splice(oldIdx, 1);
        if (!parent.branchTails.includes(exitNode)) {
            parent.branchTails.push(exitNode);
        }
    };
    const applyOutgoingDirective = (node, outgoing, lineNum, handlers = {}) => {
      if (!node) return '';
      if (outgoing === 'next') {
        pendingNext.set(node.id, node);
        handlers.onNext?.(node);
        return 'next';
      }
      if (outgoing === 'prev') {
        const t = prevConn(lineNum);
        if (t) pushEdge(node.id, t.id);
        handlers.onPrev?.(node);
        return 'prev';
      }
      return '';
    };
    const tryWireAsBranch = (node) => {
        if (ctx.pendingElse) {
            const { ctx: dc, edgeLabel } = ctx.pendingElse;
            ctx.pendingElse = null;
            pushEdge(dc.decNode.id, node.id, edgeLabel);
            if (!isEnd(node)) {
                dc.branchTails.push(node);
            }
            return true;
        }
        const dc = ctx.decStack[ctx.decStack.length - 1];
        if (dc && !hasEdgesFrom(dc.decNode.id)) {
            pushEdge(dc.decNode.id, node.id, (dc.kind === 'if' || dc.kind === 'loop') ? 'true' : undefined);
            if (!isEnd(node)) {
                dc.branchTails.push(node);
                if (dc.kind === 'if' && dc.trueBranchHead === null) dc.trueBranchHead = node;
            }
            return true;
        }
        return false;
    };
    const flushOne = (dc, trigger) => {
        while (ctx.scopeStack.length > 1 &&
               ctx.scopeStack[ctx.scopeStack.length - 1].indent > dc.indent) {
            ctx.scopeStack.pop();
        }

        if (dc.kind === 'if') {
            // Deduplicate branchTails: remove any node that already has a
            // sequential outgoing edge to another node in branchTails, since
            // only the final node of each branch should wire to the connector.
            // Also ensure the current lastExec (true tail of the active branch)
            // is included — nodes added deep in an else scope may not have been
            // added to branchTails via tryWireAsBranch.
            const curTail = getLastExec();
            if (curTail && !isEnd(curTail) && !dc.branchTails.includes(curTail)) {
                dc.branchTails.push(curTail);
            }
            const branchTailSet = new Set(dc.branchTails.map(t => t.id));
            const dedupedTails = dc.branchTails.filter(t =>
              !edges.some(e => e.from === t.id && branchTailSet.has(e.to))
            );
            dc.branchTails = dedupedTails;
            const live = dc.branchTails.filter(t => !isEnd(t));
          let exitNode = dc.decNode;

            // Always create an autoConnector when there's a trigger (next sequential node),
            // even if all branch tails are End nodes. This prevents the trigger from being
            // mistakenly added to an enclosing loop's branchTails as a loop-back candidate.
            if ((live.length || trigger) && !dc.autoConnector) {
                dc.autoConnector = addNode('Connector', dc.decNode.line, 'if-join', 'if-join');
                connectors.push(dc.autoConnector);
            }

            if (!edges.some(e => e.from === dc.decNode.id && e.label === 'true')) {
                const trueDest = dc.trueBranchHead ?? dc.autoConnector ?? trigger ?? dc.decNode;
                pushEdge(dc.decNode.id, trueDest.id, 'true');
            }

            if (!edges.some(e => e.from === dc.decNode.id && e.label === 'false')) {
                const falseDest = dc.autoConnector ?? trigger ?? dc.decNode;
                pushEdge(dc.decNode.id, falseDest.id, 'false');
            }

            if (dc.autoConnector) {
                for (const t of live) {
                    pushEdge(t.id, dc.autoConnector.id);
                }

                replaceBranchTail(dc.decNode, dc.autoConnector);
                setLastExecAtIndent(dc.indent, dc.autoConnector);

                if (trigger) {
                    pushEdge(dc.autoConnector.id, trigger.id);
                    // Don't setLastExecAtIndent(trigger) here — caller sets lastExec after flushUntil
                  exitNode = trigger;
                } else {
                  exitNode = dc.autoConnector;
                }
            } else if (trigger) {
                replaceBranchTail(dc.decNode, trigger);
                // Don't setLastExecAtIndent(trigger) here — caller sets lastExec after flushUntil
                exitNode = trigger;
            } else {
                setLastExecAtIndent(dc.indent, dc.decNode);
                exitNode = dc.decNode;
            }

              promoteExitToParentBranch(dc, exitNode);

            return;
        }

        if (dc.kind === 'loop') {
            dc.branchTails.forEach(t => pushEdge(t.id, dc.autoConnector.id));
          let exitNode = dc.decNode;
            if (!edges.some(e => e.from === dc.decNode.id && e.label === 'false')) {
                if (trigger) {
                    pushEdge(dc.decNode.id, trigger.id, 'false');
                    replaceBranchTail(dc.decNode, trigger);
                    setLastExecAtIndent(dc.indent, trigger);
              exitNode = trigger;
                } else {
                    // No following node: loop false-edge will be wired to End later in final pass
                    setLastExecAtIndent(dc.indent, dc.decNode);
              exitNode = dc.decNode;
                }
            }
          promoteExitToParentBranch(dc, exitNode);
        }
    };
    const flushUntil = (minIndent, trigger) => {
        while (ctx.decStack.length > 0 && ctx.decStack[ctx.decStack.length - 1].indent >= minIndent) {
            flushOne(ctx.decStack[ctx.decStack.length - 1], trigger);
            ctx.decStack.pop();
        }
    };
    const closeFunCtx = () => {
        flushUntil(-Infinity, null);
        const saved = ctx.savedLastExec;
        ctx = ctxStack.pop();
        ctx.scopeStack[0].lastExec = saved;
    };
    // ── Main loop (using parsedLines) ─────────────────────────────────────────────
    let processedLine = new Set();
    for (const pl of parsedLines) {
        const { lineNum, incoming, nodeKey, content, outgoing, _funHeader, _funBodyOf, _waitHeader, _waitBodyOf, _tryHeader, _tryBodyOf, _errHandler, _errHandlerOf } = pl;
        const indent = pl.indent;
        if (processedLine.has(lineNum)) continue;
        // Set fun-body-of / wait-body-of / try meta if in scope
        let meta = '';
        if (_funHeader) meta = 'fun-header';
        if (_funBodyOf !== undefined) meta = `fun-body-of=${_funBodyOf}`;
        if (_waitHeader) meta = 'wait-header';
        if (_waitBodyOf !== undefined) meta = `wait-body-of=${_waitBodyOf}`;
        if (_tryHeader) meta = `try-block`;
        if (_tryBodyOf !== undefined) meta = `try-body-of=${_tryBodyOf}`;
        if (_errHandler) meta = `error-handler-of=${_errHandlerOf ?? ''}`;
        while (ctxStack.length > 0 && indent <= ctx.baseIndent) {
            closeFunCtx();
        }
        if (incoming === 'else') {
            let dcIdx = ctx.decStack.length - 1;
            if (nodeKey !== 'if') {
                for (let i = ctx.decStack.length - 1; i >= 0; i--) {
                    if (ctx.decStack[i].indent === indent) { dcIdx = i; break; }
                }
            }
            const dc = ctx.decStack[dcIdx];
            // Only reject 'else' if the decision context at the MATCHING indent is a loop.
            // An 'else' inside an 'if' that is nested inside a 'loop' is perfectly valid —
            // it belongs to the 'if', not the 'loop'.
            if (dc && dc.kind === 'loop' && dc.indent === indent) {
                validationErrors.push(`Line ${lineNum + 1}: 'else' is not valid after 'loop'. Loops have no branches — the false path exits sequentially.`);
                processedLine.add(lineNum);
                continue;
            }
            if (dc) {
              // Graph-collapse behavior: treat `else if <cond>` as a labeled
              // middle branch on the parent `if` (Python `elif` style), rather
              // than creating a nested Decision node.
              if (nodeKey === 'if' && dc.kind === 'if') {
                const edgeLabel = (content || '').trim() || 'else-if';
                ctx.pendingElse = { ctx: dc, edgeLabel };
                processedLine.add(lineNum);
                continue;
              }

                const edgeLabel = dc.kind === 'fork' ? undefined : 'false';
                let bn;
                if (nodeKey === 'if') {
                    bn = addNode('Decision', lineNum, content, 'if-cond');
                } else if (nodeKey === 'dot') {
                    bn = addNode('Connector', lineNum, content || 'dot', 'explicit-con');
                    connectors.push(bn);
                } else if (nodeKey === 'end') {
                    bn = addNode('End', lineNum, content);
                } else if (nodeKey === 'take') {
                    bn = addNode('Input', lineNum, content);
                } else if (nodeKey === 'say') {
                    bn = addNode('Output', lineNum, content);
                } else {
                    bn = addNode('Process', lineNum, content, meta);
                }
                pushEdge(dc.decNode.id, bn.id, edgeLabel);
                // Before recording the new else-branch tail, consolidate the
                // previous branch's tails down to just the actual last node
                // (getLastExec). Intermediate nodes accumulate in branchTails
                // via tryWireAsBranch but only the final sequential node matters.
                const prevTail = getLastExec();
                dc.branchTails.length = 0;
                if (prevTail && !isEnd(prevTail)) dc.branchTails.push(prevTail);
                if (!isEnd(bn)) {
                    dc.branchTails.push(bn);
                }
                if (bn.kind === 'Decision') {
                  const nestedDc = makeDecisionCtx(bn, 'if', indent, dc);
                    ctx.decStack.push(nestedDc);
                    ctx.scopeStack.push({ indent: indent + 1, lastExec: bn });
                    setLastExec(null);
                    processedLine.add(lineNum);
                    continue;
                }
                consumePendingNext(bn);
                applyOutgoingDirective(bn, outgoing, bn.line, {
                  onNext: () => {
                    const idx = dc.branchTails.indexOf(bn);
                    if (idx !== -1) dc.branchTails.splice(idx, 1);
                  },
                  onPrev: () => {
                    const idx = dc.branchTails.indexOf(bn);
                    if (idx !== -1) dc.branchTails.splice(idx, 1);
                  }
                });
                setLastExec(bn);
            }
            processedLine.add(lineNum);
            continue;
        }
        const hasAnyKeyword = incoming || nodeKey || outgoing;
        if (nodeKey) {
            let node;
            if (nodeKey === 'if') {
                node = addNode('Decision', lineNum, content, 'if-cond');
                flushUntil(indent, node);
              const parentBranchDc = ctx.decStack[ctx.decStack.length - 1] ?? null;
              const wiredAsBranch = tryWireAsBranch(node);
              if (!wiredAsBranch) {
                    wireSeqAndUpdateTails(getLastExec(), node);
                }
              ctx.decStack.push(makeDecisionCtx(node, 'if', indent, wiredAsBranch ? parentBranchDc : null));
                setLastExec(null);
                ctx.scopeStack.push({ indent: indent + 1, lastExec: node });
                continue;
            }
            else if (nodeKey === 'fork') {
                node = addNode('Decision', lineNum, content || 'fork', 'fork');
                flushUntil(indent, node);
              const parentBranchDc = ctx.decStack[ctx.decStack.length - 1] ?? null;
              const wiredAsBranch = tryWireAsBranch(node);
              if (!wiredAsBranch) {
                    wireSeqAndUpdateTails(getLastExec(), node);
                }
              ctx.decStack.push(makeDecisionCtx(node, 'fork', indent, wiredAsBranch ? parentBranchDc : null));
                setLastExec(null);
                ctx.scopeStack.push({ indent: indent + 1, lastExec: node });
                continue;
            }
            else if (nodeKey === 'loop') {
                const head = addNode('Connector', lineNum, 'loop-head', 'loop-head');
                connectors.push(head);
                flushUntil(indent, head);
              const parentBranchDc = ctx.decStack[ctx.decStack.length - 1] ?? null;
              const wiredAsBranch = tryWireAsBranch(head);
              if (!wiredAsBranch) {
                    wireSeqAndUpdateTails(getLastExec(), head);
                }
                node = addNode('Decision', lineNum, content, 'loop-cond');
                pushEdge(head.id, node.id);
              ctx.decStack.push(makeDecisionCtx(node, 'loop', indent, wiredAsBranch ? parentBranchDc : null, head));
                setLastExec(null);
                ctx.scopeStack.push({ indent: indent + 1, lastExec: node });
                continue;
            }
            else if (nodeKey === 'dot') {
                node = addNode('Connector', lineNum, content || 'dot', 'explicit-con');
                connectors.push(node);
                flushUntil(indent, node);
                flushUntil(-Infinity, node);
                if (!tryWireAsBranch(node)) {
                    wireSeq(getLastExec(), node);
                }
              consumePendingNext(node);
                setLastExec(node);
            }
            else if (nodeKey === 'end') {
                node = addNode('End', lineNum, content);
                flushUntil(indent, node);
                // Remove the current branch tail before wiring — end terminates
                // the branch so nothing should flow from it into the auto-connector.
                const deadTail = getLastExec();
                if (deadTail) {
                    for (const d of ctx.decStack) {
                        const idx = d.branchTails.indexOf(deadTail);
                        if (idx !== -1) d.branchTails.splice(idx, 1);
                    }
                }
                if (!tryWireAsBranch(node)) {
                    wireSeq(deadTail, node);
                }
                setLastExec(null);
            }
            else if (nodeKey === 'take') {
                node = addNode('Input', lineNum, content);
                flushUntil(indent, node);
                if (!tryWireAsBranch(node)) {
                    wireSeqAndUpdateTails(getLastExec(), node);
                }
                setLastExec(node);
            }
            else if (nodeKey === 'say') {
                node = addNode('Output', lineNum, content);
                flushUntil(indent, node);
                if (!tryWireAsBranch(node)) {
                    wireSeqAndUpdateTails(getLastExec(), node);
                }
                setLastExec(node);
            }
            else if (nodeKey === 'from') {
                // 'from' creates an external Start node offset to the left of the main
                // column, then merges it with the current sequential flow into a new
                // Connector placed where this line sits in the flow.
                const fromStart = addNode('Start', lineNum, content, 'from-node');
                const mergeConn = addNode('Connector', lineNum, 'from-join', 'from-join');
                connectors.push(mergeConn);
                flushUntil(indent, mergeConn);
                // Wire previous sequential node → merge connector
                const prev = getLastExec();
                if (prev) wireSeq(prev, mergeConn);
                // Wire the external Start → merge connector
                pushEdge(fromStart.id, mergeConn.id);
                // Mark the Start as offset-left so layout can place it correctly
                fromStart.meta = (fromStart.meta ? fromStart.meta + ' ' : '') + `from-offset-of=${mergeConn.id}`;
                consumePendingNext(mergeConn);
                setLastExec(mergeConn);
                node = mergeConn;
            }
            else if (nodeKey === 'fun') {
                node = addNode('Function', lineNum, content, 'fun-header');
                const savedBeforeFun = getLastExec();
                flushUntil(indent, null);
                ctxStack.push(ctx);
                ctx = makeCtx(indent, node, savedBeforeFun);
                continue;
            }
            else if (nodeKey === 'wait' && /^(email|sheets|time|http)\b/.test(content)) {
                // Wait block — like fun, sits outside sequential flow
                // Build a display label: "wait email by addr" etc.
                node = addNode('WaitBlock', lineNum, `wait ${content}`, 'wait-header');
                const savedBeforeWait = getLastExec();
                flushUntil(indent, null);
                ctxStack.push(ctx);
                ctx = makeCtx(indent, node, savedBeforeWait);
                continue;
            }
            else {
                // Detect list/dict literals in make assignments so renderTableNode
                // can render them as mini-sheets in the flowchart.
                let nodeMeta = meta;
                const makeRhs = content.replace(/^make\s+[A-Za-z_]\w*\s*/, '').trimStart();
                if (makeRhs.startsWith('[')) nodeMeta = (nodeMeta ? nodeMeta + ' ' : '') + 'list';
                else if (makeRhs.startsWith('{')) nodeMeta = (nodeMeta ? nodeMeta + ' ' : '') + 'dict';
                node = addNode('Process', lineNum, content, nodeMeta);
                // Title badge: variable name for any make assignment
                const _makeM1 = content.match(/^make\s+([A-Za-z_]\w*)/);
                if (_makeM1 && !nodeMeta.includes('list') && !nodeMeta.includes('dict')) node.title = _makeM1[1];
                flushUntil(indent, node);
                if (!tryWireAsBranch(node)) {
                    wireSeq(getLastExec(), node);
                }
                setLastExec(node);
            }
            // A prior 'next' should connect to whichever node starts next, including
            // decision/IO/process nodes used as fork branch starters.
            if (node) {
              consumePendingNext(node);
            }
            if (node) {
                const outKind = applyOutgoingDirective(node, outgoing, lineNum, {
                    onNext: () => {
                        for (const d of ctx.decStack) {
                            const idx = d.branchTails.indexOf(node);
                            if (idx !== -1) d.branchTails.splice(idx, 1);
                        }
                    }
                });
                if (outKind) {
                    setLastExec(null);
                }
            }
            continue;
        }
        const hasNonIncomingKeyword = nodeKey || outgoing;
        if (content || hasNonIncomingKeyword) {
            // Detect list/dict literals on make lines (make is not a nodeKey)
            let fallMeta = meta;
            const fallRhs = content.replace(/^make\s+[A-Za-z_]\w*\s*/, '').trimStart();
            if (fallRhs.startsWith('[')) fallMeta = (fallMeta ? fallMeta + ' ' : '') + 'list';
            else if (fallRhs.startsWith('{')) fallMeta = (fallMeta ? fallMeta + ' ' : '') + 'dict';
            const n = addNode('Process', lineNum, content, fallMeta);
            // Title badge: variable name for any make assignment
            const _makeM2 = content.match(/^make\s+([A-Za-z_]\w*)/);
            if (_makeM2 && !fallMeta.includes('list') && !fallMeta.includes('dict')) n.title = _makeM2[1];
          // Respect branch scope by indent: dedenting out of a branch must flush
          // enclosing decisions before wiring this node.
          flushUntil(indent, n);
            if (!tryWireAsBranch(n)) {
                wireSeqAndUpdateTails(getLastExec(), n);
            }
          consumePendingNext(n);
          setLastExec(n);
          const outKind = applyOutgoingDirective(n, outgoing, lineNum, {
            onNext: () => {
              for (const d of ctx.decStack) {
                const idx = d.branchTails.indexOf(n);
                if (idx !== -1) d.branchTails.splice(idx, 1);
              }
            }
          });
          if (outKind) {
                setLastExec(null);
          }
        }
        continue;
    }
    while (ctxStack.length > 0) {
        closeFunCtx();
    }
    
    // Create implicit End node before final flush so loops can wire to it
    const implEnd = addNode('End', rawLines.length - 1, '', 'implicit end');
    flushUntil(-Infinity, implEnd);
    pendingNext.clear();
    // Pass 2 stamps _funBodyOf as a source-line index (e.g. 3) because it runs
    // before the main loop and doesn't know each Function node's assigned id yet.
    // computeLayout builds ownerOf by parsing "fun-body-of=N" and buckets the
    // Function header node by its node.id.  When N is a line index and node.id
    // is a different number the two buckets never merge → two separate blocks per
    // function instead of one.  Now that Function nodes exist with real ids we
    // patch every body-node meta so both sides of the comparison use the same id.
    const funLineToId = new Map();
    for (const n of nodes) {
        if (n.kind === 'Function') funLineToId.set(n.line, n.id);
    }
    for (const n of nodes) {
        if (!n.meta) continue;
        const m = n.meta.match(/^fun-body-of=(\d+)$/);
        if (!m) continue;
        const lineIdx = parseInt(m[1], 10);
        const nodeId  = funLineToId.get(lineIdx);
        if (nodeId != null && nodeId !== lineIdx) {
            n.meta = `fun-body-of=${nodeId}`;
        }
    }

    // ── Connector merging for graph simplicity ──
    let didMerge;
    do {
      didMerge = false;
      // Find a connector whose only outgoing edge is to another connector
      const connectorNodes = nodes.filter(n => n.kind === 'Connector');
      for (const c1 of connectorNodes) {
        const outEdges1 = edges.filter(e => e.from === c1.id);
        // Count only edges to other connectors
        const edgesToConnectors = outEdges1.filter(e => nodes.some(n => n.id === e.to && n.kind === 'Connector'));
        if (edgesToConnectors.length === 1) {
          const c2 = nodes.find(n => n.id === edgesToConnectors[0].to && n.kind === 'Connector');
          // Don't merge if-join connectors into loop-head connectors — the if-join
          // is a meaningful visual node (branch merge point) and merging it would
          // make the false branch appear to jump directly to the loop-back.
          const c1IsIfJoin   = c1.meta?.includes('if-join');
          const c2IsLoopHead = c2?.meta?.includes('loop-head');
          if (c2 && !c2.meta?.includes('explicit-con') && !(c1IsIfJoin && c2IsLoopHead)) {
            // Redirect all incoming edges to c1 → go to c2 instead
            for (let i = edges.length - 1; i >= 0; i--) {
              if (edges[i].to === c1.id) {
                edges[i].to = c2.id;
              }
            }
            // Remove the c1→c2 edge
            for (let i = edges.length - 1; i >= 0; i--) {
              if (edges[i].from === c1.id && edges[i].to === c2.id) {
                edges.splice(i, 1);
              }
            }
            // Remove c1 from nodes
            for (let i = nodes.length - 1; i >= 0; i--) {
              if (nodes[i].id === c1.id) {
                nodes.splice(i, 1);
              }
            }
            didMerge = true;
          }
        }
      }
    } while (didMerge);

    // implEnd was already created before flushUntil above
    if (!edges.some(e => e.from === startNode.id)) {
      const first = nodes.find(n => n.id !== startNode.id && n.kind !== 'End' && n.kind !== 'Function' && !n.meta?.includes('from-node') && !n.meta?.includes('fun-body-of') && !n.meta?.includes('fun-header') && !n.meta?.includes('fun-footer'));
      if (first) {
        pushEdge(startNode.id, first.id);
      } else {
        // Empty file (or only function definitions): wire Start directly to implicit End
        pushEdge(startNode.id, implEnd.id);
      }
    }
    const finalLast = ctx.scopeStack[0].lastExec;
    if (finalLast && !edges.some(e => e.from === finalLast.id) && finalLast.kind !== 'End') {
      const imp = nodes.find(n => n.meta === 'implicit end');
      if (imp) pushEdge(finalLast.id, imp.id);
    }

    // Post-process: build try-body=[ids] on each try-block node
    for (const n of nodes) {
      if (n.meta === 'try-block') {
        const bodyIds = nodes
          .filter(b => b.meta === `try-body-of=${n.id}` || b.meta?.startsWith(`try-body-of=${n.id}`))
          .map(b => b.id);
        if (bodyIds.length) n.meta = `try-block try-body=[${bodyIds.join(',')}]`;
      }
    }

    return { nodes, edges, startNodeId: startNode.id, segments: [], validationErrors };
}

// ── DOM refs for editor UI ────────────────────────────────────────────────────
const srcEl  = /** @type {HTMLTextAreaElement} */ (document.getElementById('src'));
const errEl  = document.getElementById('err');

const STARTER = `make name "World"
make count 3
loop y? < count
  say "Hello {name}! (message {y + 1})"
  make y + 1
if count > 1
  say "Sent {count} greetings"
else
  say "Sent one greeting"`;

srcEl.value = STARTER;

// Bug 4 fix: line number of a newly-inserted node waiting for its edit overlay,
let _pendingInsertEditLine = -1;

let _dt;
function scheduleRender() {
  clearTimeout(_dt);
  _dt = setTimeout(doRender, 150);
}

function doRender() {
  const src = srcEl.value;
  try {
    const graph = parseivx(src);
    const errs = graph.validationErrors || [];
    if (errs.length) {
      errEl.innerHTML = errs.map((e, i) => `<div>${e}</div>`).join('') + (errs.length > 1 ? `<div style=\"color:#888;font-size:10px;\">(${errs.length} errors)</div>` : '');
      errEl.className = '';
    } else {
      errEl.textContent = `✓ ${graph.nodes.length} nodes, ${graph.edges.length} edges`;
      errEl.className = 'ok';
    }
    _walkOrder = getWalkOrder(graph);
    _walkIdx = 0;
    // Feed directly into renderer (same script scope, so renderGraph is available)
    dragOffsets.clear();
    blockOffsets.clear();
    isFirstRender = !currentGraph;
    renderGraph(graph);

    // Bug 4 fix: open the inline editor for a newly inserted node now that the
    // graph is guaranteed to be up to date, instead of relying on a fixed timeout.
    if (_pendingInsertEditLine >= 0) {
      const targetLine = _pendingInsertEditLine;
      _pendingInsertEditLine = -1;
      const inserted = graph.nodes.find(n => n.line === targetLine);
      if (inserted) startNodeEditByLine({ line: targetLine, text: inserted.text || '' });
    }
  } catch(e) {
    errEl.textContent = 'Parse error: ' + e.message;
    errEl.className = '';
  }
}

srcEl.addEventListener('input', scheduleRender);

srcEl.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = srcEl.selectionStart, end = srcEl.selectionEnd;
    srcEl.value = srcEl.value.slice(0, s) + '  ' + srcEl.value.slice(end);
    srcEl.selectionStart = srcEl.selectionEnd = s + 2;
    updateHighlight();
    scheduleRender();
  }
});


// Help menu dropdown toggle
const helpMenuBtn = document.getElementById('help-menu-btn');
const helpMenu    = document.getElementById('help-menu');
helpMenuBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = helpMenu.style.display === 'flex';
  helpMenu.style.display = open ? 'none' : 'flex';
  helpMenuBtn.classList.toggle('active', !open);
});
document.addEventListener('click', e => {
  if (!helpMenuBtn.contains(e.target) && !helpMenu.contains(e.target)) {
    helpMenu.style.display = 'none';
    helpMenuBtn.classList.remove('active');
  }
});

document.querySelectorAll('[data-ins]').forEach(function(btn) {
  btn.addEventListener('click', function handleInsertClick() {
    const ins = btn.dataset.ins;
    const s = srcEl.selectionStart, e2 = srcEl.selectionEnd;
    srcEl.value = srcEl.value.slice(0, s) + ins + srcEl.value.slice(e2);
    srcEl.selectionStart = srcEl.selectionEnd = s + ins.length;
    srcEl.focus();
    updateHighlight();
    scheduleRender();
    helpMenu.style.display = 'none';
    helpMenuBtn.classList.remove('active');
  });
});
document.getElementById('clr').addEventListener('click', function handleClearClick() {
  srcEl.value = '';
  srcEl.focus();
  updateHighlight();
  scheduleRender();
});

// ── Step controls ─────────────────────────────────────────────────────────────
let _walkOrder = [], _walkIdx = 0, _stepTimer = null, _stepRunning = false;

function getWalkOrder(graph) {
  const visited = new Set(), order = [], adj = new Map();
  for (const e of graph.edges)
    (adj.get(e.from) ?? (adj.set(e.from, []), adj.get(e.from))).push(e.to);
  const q = [graph.startNodeId];
  while (q.length) {
    const id = q.shift();
    if (id == null || visited.has(id)) continue;
    visited.add(id);
    const n = graph.nodes.find(n => n.id === id);
    if (n && n.kind !== 'Function') order.push(id);
    for (const nxt of (adj.get(id) || [])) if (!visited.has(nxt)) q.push(nxt);
  }
  return order;
}

function stepTo(idx) {
  if (!_walkOrder.length) return;
  _walkIdx = Math.max(0, Math.min(idx, _walkOrder.length - 1));
  highlightNode(_walkOrder[_walkIdx], _walkOrder[_walkIdx + 1] ?? null);
}
function stepNext() { if (_walkIdx < _walkOrder.length - 1) stepTo(_walkIdx + 1); }
function stepPrev() { if (_walkIdx > 0) stepTo(_walkIdx - 1); }

function stepStartAuto() {
  if (_stepRunning) return; _stepRunning = true;
  const tick = () => {
    if (!_stepRunning || _walkIdx >= _walkOrder.length - 1) { stepStopAuto(); return; }
    stepNext();
    _stepTimer = setTimeout(tick, 300 / (Number(document.getElementById('spd').value) || 1));
  };
  tick();
}
function stepStopAuto() { _stepRunning = false; clearTimeout(_stepTimer); }

document.getElementById('sprev').addEventListener('click', () => { stepStopAuto(); stepPrev(); });
document.getElementById('snext').addEventListener('click', () => { stepStopAuto(); stepNext(); });
document.getElementById('splay').addEventListener('click', stepStartAuto);
document.getElementById('spause').addEventListener('click', stepStopAuto);
// ── Comments toggle ──────────────────────────────────────────────────────────
document.getElementById('cmtbtn').addEventListener('click', function toggleComments() {
  showComments = !showComments;
  const cmtBtnEl = document.getElementById('cmtbtn');
  if (cmtBtnEl) cmtBtnEl.classList.toggle('on', showComments);
  if (currentGraph) renderGraph(currentGraph);
});

// ── Called by renderer after load ─────────────────────────────────────────────
function _ivxInit() {
  doRender();
  // Dismiss loading screen
  const loader = document.getElementById('ivx-loader');
  const app    = document.getElementById('app');
  if (loader) {
    setTimeout(() => {
      loader.classList.add('done');
      app.style.opacity = '1';
      setTimeout(() => loader.remove(), 450);
    }, 200);
  } else {
    app.style.opacity = '1';
  }
}

// ── Lenses: AST → target language transpiler ──────────────────────────────────
//
// Architecture: template-driven, one render() dispatch per AST node type.
// Each language is a registry of node-type → render function.
// Adding a new language = adding a new key to LENS_LANGS.
//
// The lens is a *view* of the program, not a replacement for it.
// IVX source is always the source of truth.

const LensTranspiler = (() => {

  // ── Shared helpers ───────────────────────────────────────────────────────────

  function indent(code, n = 1) {
    const pad = '    '.repeat(n);
    return code.split('\n').map(l => l ? pad + l : l).join('\n');
  }

  function renderExpr(node, lang) {
    if (!node) return '???';
    const r = (n) => renderExpr(n, lang);
    switch (node.type) {
      case 'NumberLit':  return String(node.value);
      case 'BoolLit':    return lang.bool(node.value);
      case 'StringLit':  return lang.string(node.value);
      case 'Identifier': return node.name;
      case 'LazyDecl':   return node.name;
      case 'ListLit':    return '[' + node.elements.map(r).join(', ') + ']';
      case 'DictLit':    return '{' + node.pairs.map(p => r(p.key) + ': ' + r(p.value)).join(', ') + '}';
      case 'BinOp': {
        const op = lang.op ? lang.op(node.op) : mapOp(node.op, lang.id);
        return r(node.left) + ' ' + op + ' ' + r(node.right);
      }
      case 'UnaryOp': {
        const op = lang.op ? lang.op(node.op) : mapOp(node.op, lang.id);
        return op + ' ' + r(node.operand);
      }
      case 'Call': {
        const name = lang.builtinCall ? (lang.builtinCall(node.name) ?? node.name) : node.name;
        return name + '(' + node.args.map(r).join(', ') + ')';
      }
      case 'Invoke':
        return r(node.callee) + '(' + node.args.map(r).join(', ') + ')';
      case 'MemberAccess':
        return r(node.object) + '.' + node.field;
      case 'Super':
        return 'super';
      case 'IndexAccess': {
        const { rowSpec, colSpec, hasComma } = node;
        if (!hasComma || colSpec.omitted) {
          return r(node.target) + '[' + specStr(rowSpec, r) + ']';
        }
        return r(node.target) + '[' + specStr(rowSpec, r) + '][' + specStr(colSpec, r) + ']';
      }
      case 'Ask':
        return lang.ask ? lang.ask(node) : `ask_${node.model}(${r(node.prompt)})`;
      default:
        return '/* ?' + node.type + ' */';
    }
  }

  function specStr(spec, r) {
    if (spec.omitted) return ':';
    if (spec.isSlice) {
      const s = spec.start ? r(spec.start) : '';
      const e = spec.end   ? r(spec.end)   : '';
      return s + ':' + e;
    }
    return r(spec.expr);
  }

  function mapOp(op, langId) {
    // Default operator mapping (Python-style); langs can override via lang.op()
    const MAP = {
      '=':   '==',
      '!=':  '!=',
      'and': 'and',
      'or':  'or',
      'not': 'not',
      'xor': '^',
      'is':  'is',
      'in':  'in',
      '^':   '**',
      '//':  '//',
    };
    return MAP[op] ?? op;
  }

  function renderBlock(stmts, lang, extraIndent = 1) {
    const lines = stmts.flatMap(s => renderStmt(s, lang).split('\n'));
    return indent(lines.join('\n'), extraIndent);
  }

  function renderStmt(node, lang) {
    if (!node) return '';
    if (lang.stmt) {
      const result = lang.stmt(node, (n) => renderStmt(n, lang), (n) => renderExpr(n, lang));
      if (result !== null && result !== undefined) return result;
    }
    // Fallback generic render
    return genericStmt(node, lang);
  }

  function genericStmt(node, lang) {
    const E = (n) => renderExpr(n, lang);
    const S = (n) => renderStmt(n, lang);
    const B = (stmts) => renderBlock(stmts, lang);

    switch (node.type) {
      case 'Assign': {
        const target = node.target ? E(node.target) : node.name;
        return lang.assign(target, E(node.expr), node.lazy);
      }
      case 'Say':
        return lang.say(E(node.expr));
      case 'Take':
        return lang.take(node.name, node.converter);
      case 'TakeFile':
        return lang.takeFile ? lang.takeFile(node.name, node.ext) : `# take file: ${node.name}.${node.ext}`;
      case 'Give':
        return lang.give(E(node.expr));
      case 'Delete':
        return lang.del(node.name);
      case 'If': {
        const cond = E(node.condition);
        let out = lang.ifHead(cond) + '\n' + B(node.body);
        if (node.else_ && node.else_.length > 0) {
          // Check if it's an else-if chain
          if (node.else_.length === 1 && node.else_[0].type === 'If') {
            const inner = S(node.else_[0]);
            out += '\n' + lang.elseifJoin(inner);
          } else {
            out += '\n' + lang.elseHead() + '\n' + B(node.else_);
            out += '\n' + (lang.blockEnd ? lang.blockEnd() : '');
          }
        } else {
          out += '\n' + (lang.blockEnd ? lang.blockEnd() : '');
        }
        return out.replace(/\n+$/, '');
      }
      case 'Loop': {
        // Collect lazy declarations from condition and emit them before the loop
        const lazyDecls = [];
        function collectLazy(n) {
          if (!n) return;
          if (n.type === 'LazyDecl') {
            const name = n.name;
            if (lang._declared && !lang._declared.has(name)) {
              lang._declared.add(name);
              // Infer default: 0 for arithmetic context, none otherwise
              const defaultVal = lang.id === 'typescript' || lang.id === 'javascript' ? '0' :
                                 lang.id === 'python' ? '0' : '0';
              const decl = lang.id === 'typescript' ? `let ${name} = ${defaultVal};` :
                           lang.id === 'javascript' ? `let ${name} = ${defaultVal};` :
                           lang.id === 'python' ? `${name} = ${defaultVal}` :
                           `SET ${name} ← ${defaultVal}`;
              lazyDecls.push(decl);
            }
          }
          if (n.left) collectLazy(n.left);
          if (n.right) collectLazy(n.right);
          if (n.operand) collectLazy(n.operand);
        }
        collectLazy(node.condition);
        const cond = E(node.condition);
        const loopCode = lang.loopHead(cond) + '\n' + B(node.body) + (lang.blockEnd ? '\n' + lang.blockEnd() : '');
        return lazyDecls.length ? lazyDecls.join('\n') + '\n' + loopCode : loopCode;
      }
      case 'For': {
        return lang.forHead(node.iterVar, node.target) + '\n' + B(node.body) + (lang.blockEnd ? '\n' + lang.blockEnd() : '');
      }
      case 'Fun': {
        return lang.funHead(node.name, node.params) + '\n' + B(node.body) + (lang.blockEnd ? '\n' + lang.blockEnd() : '');
      }
      case 'Class': {
        const methods = node.body.map(S).join('\n\n');
        return lang.classHead(node.name, node.superclass?.name) + '\n' +
               indent(methods || lang.pass(), 1) +
               (lang.blockEnd ? '\n' + lang.blockEnd() : '');
      }
      case 'ExprStatement':
        return E(node.expr);
      case 'End':
        return lang.end ? lang.end(node.message) : (node.message ? `# end: ${node.message}` : '# end');
      case 'Wait':
        return lang.wait ? lang.wait(node, E) : `# wait`;
      case 'Use':
        return lang.use ? lang.use(E(node.key)) : `# key ${E(node.key)}`;
      case 'Post':
        return lang.post ? lang.post(node, E) : `# post ${E(node.url)}`;
      case 'Import':
        return lang.importStmt ? lang.importStmt(node.path) : `# from ${node.path}`;
      case 'Save':
        return lang.save ? lang.save(node, E) : `# save ${E(node.filenameExpr)}`;
      case 'Delete':
        return lang.del(node.name);
      case 'Dot':
        return '# (connector)';
      default:
        return `# ${node.type}`;
    }
  }

  function renderProgram(ast, lang) {
    if (!ast || !ast.body) return '';
    const header = lang.header ? lang.header() : '';
    const body = ast.body.map(s => renderStmt(s, lang)).filter(Boolean).join('\n');
    return (header ? header + '\n\n' : '') + body;
  }

  // ── String escaping ──────────────────────────────────────────────────────────

  function escapeString(val, quote = '"') {
    return quote + String(val)
      .replace(/\\/g, '\\\\')
      .replace(/"/g,  '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t') + quote;
  }

  // ── Language definitions ─────────────────────────────────────────────────────

  const PYTHON = {
    id: 'python',
    bool:      v => v === null ? 'None' : v ? 'True' : 'False',
    string:    v => {
      // Preserve {var} interpolation as f-string if present
      if (/\{[A-Za-z_]\w*\}/.test(v)) return 'f"' + v.replace(/"/g, '\\"') + '"';
      return escapeString(v);
    },
    op: op => {
      const M = { '=': '==', 'xor': '^', 'is': 'is', 'in': 'in', '^': '**', '//': '//' };
      return M[op] ?? op;
    },
    assign:    (t, v, lazy) => lazy ? `if '${t}' not in dir():\n    ${t} = ${v}\n${t} = ${v}` : `${t} = ${v}`,
    say:       v => `print(${v})`,
    take:      (name, conv) => {
      const raw = `input("${name}: ")`;
      if (!conv || conv === 'str') return `${name} = ${raw}`;
      const convMap = { int: 'int', flt: 'float', bin: 'bin', list: 'list', dict: 'dict' };
      return `${name} = ${convMap[conv] ?? conv}(${raw})`;
    },
    takeFile:  (name, ext) => `${name} = open("${name}.${ext}").read()  # load ${ext} file`,
    give:      v => `return ${v}`,
    del:       name => `del ${name}`,
    ifHead:    cond => `if ${cond}:`,
    elseHead:  () => 'else:',
    elseifJoin: inner => 'el' + inner,  // "elif ..."
    loopHead:  cond => `while ${cond}:`,
    forHead:   (iterVar, target) => `for ${iterVar} in ${target}:`,
    funHead:   (name, params) => `def ${name}(${params.join(', ')}):`,
    classHead: (name, superclass) => superclass ? `class ${name}(${superclass}):` : `class ${name}:`,
    blockEnd:  () => '',  // Python uses indentation — no 'end' keyword
    pass:      () => 'pass',
    end:       msg => msg ? `raise SystemExit("${msg}")` : 'raise SystemExit()',
    wait:      (node, E) => node.condition
      ? `while not (${E(node.condition).replace('==', '==')}):\n    pass`
      : `import time; time.sleep(${E(node.expr)})`,
    use:       key => `_api_key = ${key}  # key`,
    post:      (node, E) => `import requests\nresponse = requests.post(${E(node.url)}, json=${E(node.body)})`,
    ask:       node => `ask_ai("${node.model}", ${renderExpr(node.prompt, PYTHON)})`,
    header:    () => '',
    builtinCall: name => {
      const M = { 'int': 'int', 'str': 'str', 'flt': 'float', 'len': 'len', 'list': 'list', 'dict': 'dict' };
      return M[name] ?? name;
    },
  };

  const JAVASCRIPT = {
    id: 'javascript',
    bool:   v => v === null ? 'null' : v ? 'true' : 'false',
    string: v => {
      if (/\{[^}]+\}/.test(v)) {
        // Convert {expr} → ${expr} for template literals
        const tpl = v.replace(/`/g, '\\`').replace(/\{([^}]+)\}/g, '$${$1}');
        return '`' + tpl + '`';
      }
      return escapeString(v);
    },
    op: op => {
      const M = { '=': '===', '!=': '!==', 'and': '&&', 'or': '||', 'not': '!',
                  'xor': '^', 'is': '===', 'in': 'in', '^': '**', '//': '/' };
      return M[op] ?? op;
    },
    assign:    function(t, v, lazy) {
      if (lazy) return `let ${t} = typeof ${t} !== 'undefined' ? ${t} : ${v};`;
      const isConst = this._immutables && this._immutables.has(t);
      if (this._declared && this._declared.has(t)) {
        return `${t} = ${v};`;  // reassignment — no let/const
      }
      if (this._declared) this._declared.add(t);
      return isConst ? `const ${t} = ${v};` : `let ${t} = ${v};`;
    },
    say:       v => `console.log(${v});`,
    take:      (name, conv) => {
      const raw = `prompt("${name}")`;
      if (!conv || conv === 'str') return `let ${name} = ${raw};`;
      const cMap = { int: `parseInt(${raw})`, flt: `parseFloat(${raw})` };
      return `let ${name} = ${cMap[conv] ?? raw};`;
    },
    give:      v => `return ${v};`,
    del:       name => `delete ${name};`,
    ifHead:    cond => `if (${cond}) {`,
    elseHead:  () => '} else {',
    elseifJoin: inner => '} else ' + inner,
    loopHead:  cond => `while (${cond}) {`,
    forHead:   (iterVar, target) => `for (const ${iterVar} of ${target}) {`,
    funHead:   (name, params) => `function ${name}(${params.join(', ')}) {`,
    classHead: (name, sup) => sup ? `class ${name} extends ${sup} {` : `class ${name} {`,
    blockEnd:  () => '}',
    pass:      () => '// (empty)',
    end:       msg => msg ? `throw new Error("${msg}");` : 'process.exit(0);',
    wait:      (node, E) => node.condition
      ? `// wait until: ${E(node.condition)}`
      : `await new Promise(r => setTimeout(r, ${E(node.expr)} * 1000));`,
    use:       key => `const _apiKey = ${key}; // key`,
    post:      (node, E) => `const response = await fetch(${E(node.url)}, { method: 'POST', body: JSON.stringify(${E(node.body)}) });`,
    ask:       node => `await askAI("${node.model}", ${renderExpr(node.prompt, JAVASCRIPT)})`,
    header:    () => `'use strict';`,
    builtinCall: name => {
      const M = { 'int': 'parseInt', 'flt': 'parseFloat', 'str': 'String', 'len': '/* len */' };
      return M[name] ?? name;
    },
  };

  const TYPESCRIPT = {
    ...JAVASCRIPT,
    id: 'typescript',
    assign:    function(t, v, lazy) {
      if (lazy) return `let ${t}: any = typeof ${t} !== 'undefined' ? ${t} : ${v};`;
      if (this._declared && this._declared.has(t)) {
        return `${t} = ${v};`;  // reassignment — no let/const
      }
      if (this._declared) this._declared.add(t);
      const isMutable = this._immutables && !this._immutables.has(t);
      return isMutable ? `let ${t} = ${v};` : `const ${t} = ${v};`;
    },
    funHead:   (name, params) => `function ${name}(${params.map(p => p + ': any').join(', ')}): any {`,
    classHead: (name, sup) => sup ? `class ${name} extends ${sup} {` : `class ${name} {`,
    header:    () => `// TypeScript`,
  };

  const PSEUDOCODE = {
    id: 'pseudocode',
    bool:      v => v === null ? 'NONE' : v ? 'TRUE' : 'FALSE',
    string:    v => `"${v}"`,
    op: op => {
      const M = { '=': '=', '!=': '≠', '<=': '≤', '>=': '≥', 'and': 'AND', 'or': 'OR',
                  'not': 'NOT', 'xor': 'XOR', 'is': 'IS', 'in': 'IN', '^': '^', '//': 'DIV', '%': 'MOD' };
      return M[op] ?? op;
    },
    assign:    (t, v) => `SET ${t} ← ${v}`,
    say:       v => `OUTPUT ${v}`,
    take:      (name, conv) => `INPUT ${name}${conv ? ` (as ${conv})` : ''}`,
    give:      v => `RETURN ${v}`,
    del:       name => `DELETE ${name}`,
    ifHead:    cond => `IF ${cond} THEN`,
    elseHead:  () => 'ELSE',
    elseifJoin: inner => 'ELSE ' + inner,
    loopHead:  cond => `WHILE ${cond} DO`,
    forHead:   (iterVar, target) => `FOR EACH ${iterVar} IN ${target}`,
    funHead:   (name, params) => `PROCEDURE ${name}(${params.join(', ')})`,
    classHead: (name, sup) => sup ? `CLASS ${name} INHERITS ${sup}` : `CLASS ${name}`,
    blockEnd:  () => 'END',
    pass:      () => '(empty)',
    end:       msg => msg ? `STOP "${msg}"` : 'STOP',
    wait:      (node, E) => node.condition ? `WAIT UNTIL ${E(node.condition)}` : `WAIT ${E(node.expr)}`,
    use:       key => `KEY ${key}`,
    post:      (node, E) => `POST ${E(node.url)} WITH ${E(node.body)}`,
    ask:       node => `ASK ${node.model.toUpperCase()} "${renderExpr(node.prompt, PSEUDOCODE)}"`,
    header:    () => '',
  };

  // ── Language registry ────────────────────────────────────────────────────────

  const LANGS = { python: PYTHON, javascript: JAVASCRIPT, typescript: TYPESCRIPT, pseudocode: PSEUDOCODE };

  // ── Public API ───────────────────────────────────────────────────────────────

  function transpile(source, langId) {
    const lang = LANGS[langId];
    if (!lang) return `// Unknown lens: ${langId}`;
    try {
      const { ast, errors } = parse(source);
      // Run immutability inference so TypeScript/JS can emit const vs let
      const immutables = typeof inferImmutables === 'function' ? inferImmutables(ast) : new Set();
      // Thread immutables + declared tracking into lang for assign decisions
      const langWithImmutables = { ...lang, _immutables: immutables, _declared: new Set() };
      let out = renderProgram(ast, langWithImmutables);
      if (errors.length > 0) {
        const errLines = errors.map(e => `# Parse error (line ${e.line}): ${e.message}`).join('\n');
        out = errLines + '\n\n' + out;
      }
      return out || `# (empty program)`;
    } catch(e) {
      return `# Transpile error: ${e.message}`;
    }
  }

  return { transpile, langs: Object.keys(LANGS) };
})();

// ── Lens panel UI ─────────────────────────────────────────────────────────────

// ── Reverse Transpiler: target language → IVX ────────────────────────────────
//
// Each language returns an array of line results:
//   { ivx: string, stub: boolean, original: string }
// stub=true means the line couldn't be converted cleanly — it gets highlighted.

const ReverseTranspiler = (() => {

  // ── Shared expression converters ─────────────────────────────────────────────

  function convertExpr(expr, lang) {
    if (!expr) return expr;
    // Booleans / null
    expr = expr
      .replace(/\bTrue\b/g,  'yes')
      .replace(/\bFalse\b/g, 'no')
      .replace(/\bNone\b/g,  'none')
      .replace(/\bnull\b/g,  'none')
      .replace(/\bundefined\b/g, 'none')
      .replace(/\btrue\b/g,  'yes')
      .replace(/\bfalse\b/g, 'no');
    // Operators
    expr = expr
      .replace(/\*\*/g,  '^')
      .replace(/===|==/g, '=')
      .replace(/!==/g,    '!=')
      .replace(/&&/g,     'and')
      .replace(/\|\|/g,   'or')
      .replace(/!/g,      'not ')
      .replace(/\bMath\.pow\s*\(([^,]+),\s*([^)]+)\)/g, '($1 ^ $2)');
    // JS/TS typeof guards → just the variable
    expr = expr.replace(/typeof\s+\w+\s*!==?\s*['"][^'"]+['"]/g, m => {
      const v = m.match(/typeof\s+(\w+)/);
      return v ? v[1] : m;
    });
    // Python floor div stays as //
    // f-strings / template literals → IVX interpolation
    if (lang === 'python') {
      expr = expr.replace(/^f["'](.*)["']$/, (_, inner) => `"${inner}"`);
    }
    if (lang === 'javascript' || lang === 'typescript') {
      expr = expr.replace(/^`(.*)`$/, (_, inner) => `"${inner.replace(/\$\{([^}]+)\}/g, '{$1')}"`);
    }
    return expr;
  }

  function convertCondition(expr, lang) {
    // Strip wrapping parens from JS/TS if statements
    expr = expr.trim().replace(/^\((.*)\)$/, '$1');
    return convertExpr(expr, lang);
  }

  function stripTrailingColon(s) { return s.replace(/:$/, '').trim(); }
  function stripSemicolon(s)     { return s.replace(/;$/, '').trim(); }
  function getIndent(line)       { return line.match(/^(\s*)/)[1]; }
  function dedent(s)             { return s.replace(/^    /, '').replace(/^\t/, ''); }

  // ── Stub result helpers ───────────────────────────────────────────────────────

  function ok(ivx, original)   { return { ivx, stub: false, original }; }
  function stub(ivx, original) { return { ivx, stub: true,  original }; }

  // ── Python reverse ────────────────────────────────────────────────────────────

  function reversePythonLine(raw) {
    const line    = raw;
    const trimmed = raw.trim();
    const indent  = getIndent(raw);
    const E       = s => convertExpr(s, 'python');
    const C       = s => convertCondition(s, 'python');

    if (!trimmed || trimmed.startsWith('#')) {
      const txt = trimmed.startsWith('#') ? trimmed.slice(1).trim() : '';
      return ok(indent + (txt ? `note ${txt}` : ''), raw);
    }

    // import → stub
    if (/^import\s|^from\s+\S+\s+import/.test(trimmed))
      return stub(indent + `note import: ${trimmed}`, raw);

    // decorator → stub
    if (trimmed.startsWith('@'))
      return stub(indent + `note decorator: ${trimmed}`, raw);

    // try / except / finally / with → stub
    if (/^(try:|except(\s|:)|finally:|with\s)/.test(trimmed))
      return stub(indent + `note ${trimmed}`, raw);

    // raise → end
    if (/^raise\s+SystemExit/.test(trimmed)) {
      const msg = trimmed.match(/SystemExit\(["'](.+?)["']\)/);
      return ok(indent + (msg ? `end ${msg[1]}` : 'end'), raw);
    }
    if (/^raise\b/.test(trimmed))
      return stub(indent + `note ${trimmed}`, raw);

    // assert → stub
    if (/^assert\b/.test(trimmed))
      return stub(indent + `note ${trimmed}`, raw);

    // pass → (empty comment)
    if (trimmed === 'pass') return ok('', raw);

    // class Foo: / class Foo(Bar):
    const classM = trimmed.match(/^class\s+(\w+)(?:\((\w+)\))?\s*:/);
    if (classM) return ok(indent + `class ${classM[1]}${classM[2] ? `(${classM[2]})` : ''}`, raw);

    // def foo(params):
    const defM = trimmed.match(/^def\s+(\w+)\s*\(([^)]*)\)\s*(?:->[^:]+)?:/);
    if (defM) {
      const params = defM[2].split(',').map(p => p.trim().replace(/\s*=.*$/, '').replace(/:\s*\w+/, '')).filter(Boolean);
      return ok(indent + `fun ${defM[1]}(${params.join(', ')})`, raw);
    }

    // return
    const retM = trimmed.match(/^return\s+(.*)/);
    if (retM) return ok(indent + `give ${E(retM[1])}`, raw);

    // del
    const delM = trimmed.match(/^del\s+(\w+)/);
    if (delM) return ok(indent + `del ${delM[1]}`, raw);

    // print(...)
    const printM = trimmed.match(/^print\s*\((.*)\)$/);
    if (printM) return ok(indent + `say ${E(printM[1])}`, raw);

    // input assignment: x = input(...) / x = int(input(...))
    const inputM = trimmed.match(/^(\w+)\s*=\s*(int|float|str|list|dict)?\(?\s*input\s*\([^)]*\)\s*\)?/);
    if (inputM) {
      const conv = inputM[2] ? inputM[2].replace('float', 'flt') : null;
      return ok(indent + `take ${conv ? `${conv}(${inputM[1]})` : inputM[1]}`, raw);
    }

    // while cond:
    const whileM = trimmed.match(/^while\s+(.+):/);
    if (whileM) return ok(indent + `loop ${C(whileM[1])}`, raw);

    // for x in y:
    const forInM = trimmed.match(/^for\s+(\w+)\s+in\s+(\w+)\s*:/);
    if (forInM) return ok(indent + `for ${forInM[1]} in ${forInM[2]}`, raw);

    // for i, x in enumerate(y):
    const forEnumM = trimmed.match(/^for\s+(\w+)\s*,\s*(\w+)\s+in\s+enumerate\s*\((\w+)\)\s*:/);
    if (forEnumM) return ok(indent + `for ${forEnumM[2]} in ${forEnumM[3]}`, raw);

    // if cond:
    const ifM = trimmed.match(/^if\s+(.+):/);
    if (ifM) return ok(indent + `if ${C(ifM[1])}`, raw);

    // elif cond:
    const elifM = trimmed.match(/^elif\s+(.+):/);
    if (elifM) return ok(indent + `else if ${C(elifM[1])}`, raw);

    // else:
    if (trimmed === 'else:') return ok(indent + 'else', raw);

    // augmented assignment: x += 1 → make x + 1
    const augM = trimmed.match(/^(\w+(?:\.\w+)*)\s*([+\-*/%])=\s*(.+)/);
    if (augM) return ok(indent + `make ${augM[1]} ${augM[2]} ${E(augM[3])}`, raw);

    // assignment: x = expr  (skip type annotations like x: int = 5)
    const assignM = trimmed.match(/^(\w+(?:\.\w+)*)\s*(?::\s*\w+)?\s*=\s*(?!=)(.+)/);
    if (assignM) return ok(indent + `make ${assignM[1]} ${E(assignM[2])}`, raw);

    // bare function call
    const callM = trimmed.match(/^(\w+)\s*\((.*)?\)$/);
    if (callM) return ok(indent + `${callM[1]}(${E(callM[2] ?? '')})`, raw);

    // anything else → stub with note
    return stub(indent + `note ✗ ${trimmed}`, raw);
  }

  function reversePython(source) {
    return source.split('\n').map(reversePythonLine);
  }

  // ── JavaScript / TypeScript reverse ──────────────────────────────────────────

  function reverseJSLine(raw, lang) {
    const trimmed = stripSemicolon(raw.trim());
    const indent  = getIndent(raw);
    const E       = s => convertExpr(s, lang);
    const C       = s => convertCondition(s, lang);

    if (!trimmed || trimmed.startsWith('//')) {
      const txt = trimmed.startsWith('//') ? trimmed.slice(2).trim() : '';
      return ok(indent + (txt ? `note ${txt}` : ''), raw);
    }

    // 'use strict' / type annotations top → skip
    if (trimmed === "'use strict'" || trimmed === '"use strict"' || trimmed === '// TypeScript')
      return ok('', raw);

    // import → stub
    if (/^import\s/.test(trimmed))
      return stub(indent + `note import: ${trimmed}`, raw);

    // export → stub
    if (/^export\s/.test(trimmed))
      return stub(indent + `note export: ${trimmed}`, raw);

    // closing brace alone → dedent signal (handled by block logic, skip)
    if (trimmed === '}') return ok('', raw);

    // class Foo / class Foo extends Bar
    const classM = trimmed.match(/^class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{?/);
    if (classM) return ok(indent + `class ${classM[1]}${classM[2] ? `(${classM[2]})` : ''}`, raw);

    // function foo(params) {
    const fnM = trimmed.match(/^(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*\w+)?\s*\{?/);
    if (fnM) {
      const params = fnM[2].split(',').map(p => p.trim().replace(/:\s*\w+/, '').replace(/\s*=.*$/, '')).filter(Boolean);
      return ok(indent + `fun ${fnM[1]}(${params.join(', ')})`, raw);
    }

    // arrow function: const foo = (params) => {
    const arrowM = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
    if (arrowM) {
      const params = arrowM[2].split(',').map(p => p.trim().replace(/:\s*\w+/, '')).filter(Boolean);
      return ok(indent + `fun ${arrowM[1]}(${params.join(', ')})`, raw);
    }

    // return
    const retM = trimmed.match(/^return\s+(.*)/);
    if (retM) return ok(indent + `give ${E(retM[1])}`, raw);

    // delete
    const delM = trimmed.match(/^delete\s+(\w+)/);
    if (delM) return ok(indent + `del ${delM[1]}`, raw);

    // console.log(...)
    const logM = trimmed.match(/^console\.log\s*\((.*)\)$/);
    if (logM) return ok(indent + `say ${E(logM[1])}`, raw);

    // prompt assignment
    const promptM = trimmed.match(/^(?:let|const|var)\s+(\w+)\s*=\s*(?:parseInt|parseFloat|Number)?\(?\s*prompt\s*\([^)]*\)\s*\)?/);
    if (promptM) return ok(indent + `take ${promptM[1]}`, raw);

    // while
    const whileM = trimmed.match(/^while\s*\((.+)\)\s*\{?/);
    if (whileM) return ok(indent + `loop ${C(whileM[1])}`, raw);

    // for...of
    const forOfM = trimmed.match(/^for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+(\w+)\s*\)\s*\{?/);
    if (forOfM) return ok(indent + `for ${forOfM[1]} in ${forOfM[2]}`, raw);

    // for (let i = 0; ...) → stub, too varied
    const forM = trimmed.match(/^for\s*\(/);
    if (forM) return stub(indent + `note ✗ ${trimmed}`, raw);

    // if (cond) {
    const ifM = trimmed.match(/^if\s*\((.+)\)\s*\{?/);
    if (ifM) return ok(indent + `if ${C(ifM[1])}`, raw);

    // } else if (cond) {
    const elifM = trimmed.match(/^(?:\}\s*)?else\s+if\s*\((.+)\)\s*\{?/);
    if (elifM) return ok(indent + `else if ${C(elifM[1])}`, raw);

    // } else {
    if (/^(?:\}\s*)?else\s*\{?$/.test(trimmed)) return ok(indent + 'else', raw);

    // throw new Error → end
    const throwM = trimmed.match(/^throw\s+new\s+Error\s*\(\s*["'](.+?)["']\s*\)/);
    if (throwM) return ok(indent + `end ${throwM[1]}`, raw);
    if (/^throw\b/.test(trimmed)) return stub(indent + `note ${trimmed}`, raw);

    // augmented: x += 1
    const augM = trimmed.match(/^(\w+(?:\.\w+)*)\s*([+\-*/%])=\s*(.+)/);
    if (augM) return ok(indent + `make ${augM[1]} ${augM[2]} ${E(augM[3])}`, raw);

    // const/let/var x = expr
    const varM = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(.+)/);
    if (varM) return ok(indent + `make ${varM[1]} ${E(varM[2])}`, raw);

    // x = expr (reassignment)
    const assignM = trimmed.match(/^(\w+(?:\.\w+)*)\s*=\s*(?!=)(.+)/);
    if (assignM) return ok(indent + `make ${assignM[1]} ${E(assignM[2])}`, raw);

    // bare call
    const callM = trimmed.match(/^(?:await\s+)?(\w+)\s*\((.*)?\)$/);
    if (callM) return ok(indent + `${callM[1]}(${E(callM[2] ?? '')})`, raw);

    return stub(indent + `note ✗ ${trimmed}`, raw);
  }

  function reverseJS(source, lang) {
    return source.split('\n').map(line => reverseJSLine(line, lang));
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  // Returns { lines: [{ivx, stub, original}], stubCount: number }

  function reverse(source, langId) {
    let lines;
    if      (langId === 'python')     lines = reversePython(source);
    else if (langId === 'javascript') lines = reverseJS(source, 'javascript');
    else if (langId === 'typescript') lines = reverseJS(source, 'typescript');
    else return { lines: [stub(`note Reverse not supported for ${langId}`, source)], stubCount: 1 };

    // Filter out runs of blank lines from skipped constructs (closing braces etc.)
    const cleaned = [];
    let lastBlank = false;
    for (const l of lines) {
      const isBlank = !l.ivx.trim();
      if (isBlank && lastBlank) continue;
      cleaned.push(l);
      lastBlank = isBlank;
    }

    const stubCount = cleaned.filter(l => l.stub).length;
    return { lines: cleaned, stubCount };
  }

  return { reverse };
})();

// ── Lens panel UI ─────────────────────────────────────────────────────────────

(function() {
  const ep        = document.getElementById('ep');
  const editorSub = document.getElementById('editor-sub');
  const srcEl     = document.getElementById('src');

  // ── Lens panel DOM ──────────────────────────────────────────────────────────
  const lensPanel = document.createElement('div');
  lensPanel.id = 'lens-panel';
  lensPanel.style.display = 'none';
  lensPanel.innerHTML = `
    <div id="lens-hdr">
      <span id="lens-title">Python Lens</span>
      <div id="lens-import-wrap" style="display:none">
        <div class="gs"></div>
        <button class="kb lens-import-btn" id="lens-import">← Import to IVX</button>
        <span id="lens-stub-count"></span>
      </div>
      <div style="flex:1"></div>
      <button class="kb" id="lens-copy">Copy</button>
      <button class="kb" id="lens-close">✕</button>
    </div>
    <div id="lens-body">
      <div id="lens-gutter"><div id="lens-gutter-inner"></div></div>
      <div id="lens-scroll">
        <div id="lens-code" spellcheck="false"></div>
      </div>
    </div>
    <div id="lens-import-confirm" style="display:none">
      <span id="lens-import-msg"></span>
      <button class="kb lens-import-btn" id="lens-import-ok">Replace IVX source</button>
      <button class="kb" id="lens-import-cancel">Cancel</button>
    </div>
  `;

  ep.appendChild(lensPanel);

  // ── Lens controls — inject into editor panel header ────────────────────────
  const epHdr = document.getElementById('ep-hdr');
  const epMinimizeBtn = document.getElementById('ep-minimize');

  // Insert a separator then the lens controls before the spacer div
  const lensSep = document.createElement('div');
  lensSep.className = 'panel-hdr-sep';

  const lensWrap = document.createElement('div');
  lensWrap.id = 'lens-wrap';
  lensWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
  lensWrap.innerHTML = `
    <select class="gsel panel-hdr-sel" id="lens-lang-sel">
      <option value="python">Python</option>
      <option value="javascript">JavaScript</option>
      <option value="typescript">TypeScript</option>
      <option value="pseudocode">Pseudocode</option>
    </select>
    <button class="kb panel-hdr-btn" id="lens-btn">Lens</button>
  `;

  // Insert before the flex spacer (second-to-last child) and minimize button
  const spacer = epHdr.querySelector('div[style*="flex:1"]');
  epHdr.insertBefore(lensSep, spacer);
  epHdr.insertBefore(lensWrap, spacer);

  // ── Element refs ────────────────────────────────────────────────────────────
  const lensBtn        = document.getElementById('lens-btn');
  const langSel        = document.getElementById('lens-lang-sel');
  const lensCode       = document.getElementById('lens-code');
  const lensGutter     = document.getElementById('lens-gutter-inner');
  const lensScroll     = document.getElementById('lens-scroll');
  const lensClose      = document.getElementById('lens-close');
  const lensCopy       = document.getElementById('lens-copy');
  const lensTitleEl    = document.getElementById('lens-title');
  const lensImportWrap = document.getElementById('lens-import-wrap');
  const lensImportBtn  = document.getElementById('lens-import');
  const lensStubCount  = document.getElementById('lens-stub-count');
  const lensConfirm    = document.getElementById('lens-import-confirm');
  const lensImportMsg  = document.getElementById('lens-import-msg');
  const lensImportOk   = document.getElementById('lens-import-ok');
  const lensImportCancel = document.getElementById('lens-import-cancel');

  // ── State ───────────────────────────────────────────────────────────────────
  let lensOpen    = false;
  let lensLang    = 'python';
  let lensEdited  = false;  // user has manually edited the lens content
  let lensMode    = 'forward';  // 'forward' = IVX→lang, 'import' = user pasted foreign code

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const LANG_LABELS = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', pseudocode: 'Pseudocode' };
  const IMPORT_SUPPORTED = new Set(['python', 'javascript', 'typescript']);

  function escHtmlLens(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function updateGutter(lineCount) {
    let g = '';
    for (let i = 1; i <= lineCount; i++) g += i + '\n';
    lensGutter.textContent = g;
  }

  function syncGutter() {
    lensGutter.style.top = -lensScroll.scrollTop + 'px';
  }
  lensScroll.addEventListener('scroll', syncGutter);

  // ── Forward render: IVX → language ──────────────────────────────────────────
  function renderLens() {
    if (!lensOpen) return;
    const code  = LensTranspiler.transpile(srcEl.value, lensLang);
    // Plain text — no stubs in forward direction
    lensCode.innerHTML = escHtmlLens(code);
    updateGutter(code.split('\n').length);
    lensTitleEl.textContent = LANG_LABELS[lensLang] + ' Lens';
    // Show import button only for supported languages
    lensImportWrap.style.display = IMPORT_SUPPORTED.has(lensLang) ? 'flex' : 'none';
    lensStubCount.textContent = '';
    lensConfirm.style.display = 'none';
    lensMode   = 'forward';
    lensEdited = false;
  }

  // ── Import render: parse lens content → show annotated IVX preview ──────────
  function runImport() {
    // Grab raw text from the editable lens div
    const raw = lensCode.innerText;
    const { lines, stubCount } = ReverseTranspiler.reverse(raw, lensLang);

    // Build highlighted HTML — stub lines get a warning highlight
    let html = '';
    for (const l of lines) {
      if (l.stub) {
        html += `<span class="lens-stub-line" title="Could not convert: ${escHtmlLens(l.original.trim())}">${escHtmlLens(l.ivx)}</span>\n`;
      } else {
        html += escHtmlLens(l.ivx) + '\n';
      }
    }
    lensCode.innerHTML = html;
    updateGutter(lines.length);

    // Update header
    lensTitleEl.textContent = '← IVX Preview';
    lensMode = 'import';

    // Stub count badge
    if (stubCount > 0) {
      lensStubCount.textContent = `${stubCount} line${stubCount > 1 ? 's' : ''} need review`;
      lensStubCount.className   = 'lens-stub-badge';
    } else {
      lensStubCount.textContent = '✓ clean';
      lensStubCount.className   = 'lens-stub-badge lens-stub-ok';
    }

    // Confirmation bar
    const msg = stubCount > 0
      ? `${stubCount} highlighted line${stubCount > 1 ? 's' : ''} couldn't convert — they'll appear as notes in IVX.`
      : 'All lines converted cleanly.';
    lensImportMsg.textContent = msg;
    lensConfirm.style.display = 'flex';

    // Store converted lines for the confirm step
    lensCode._pendingLines = lines;
  }

  // ── Confirm: write converted IVX into the source editor ─────────────────────
  lensImportOk.addEventListener('click', () => {
    const lines = lensCode._pendingLines;
    if (!lines) return;
    const ivxSource = lines.map(l => l.ivx).join('\n').trimEnd();
    srcEl.value = ivxSource;
    updateHighlight();
    scheduleRender();
    lensConfirm.style.display = 'none';
    closeLens();
  });

  lensImportCancel.addEventListener('click', () => {
    lensConfirm.style.display = 'none';
    renderLens(); // go back to forward view
  });

  lensImportBtn.addEventListener('click', runImport);

  // ── Open / close ────────────────────────────────────────────────────────────
  function openLens() {
    lensOpen = true;
    lensBtn.classList.add('on');
    // Hide ep-body entirely, show lens panel in its place
    document.getElementById('ep-body').style.display = 'none';
    lensPanel.style.display   = 'flex';
    lensPanel.style.flex      = '1';
    lensPanel.style.minHeight = '0';
    lensCode.contentEditable  = 'true';
    lensEdited = false;
    renderLens();
  }

  function closeLens() {
    lensOpen   = false;
    lensEdited = false;
    lensBtn.classList.remove('on');
    lensPanel.style.display  = 'none';
    lensPanel.style.flex     = '';
    lensCode.contentEditable = 'false';
    document.getElementById('ep-body').style.display = '';
    lensConfirm.style.display = 'none';
    srcEl.focus();
  }

  lensBtn.addEventListener('click', () => { if (lensOpen) closeLens(); else openLens(); });
  lensClose.addEventListener('click', closeLens);

  langSel.addEventListener('change', () => {
    lensLang = langSel.value;
    if (lensOpen) renderLens();
  });

  lensCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(lensCode.innerText).then(() => {
      lensCopy.textContent = 'Copied!';
      setTimeout(() => { lensCopy.textContent = 'Copy'; }, 1500);
    });
  });

  // contentEditable is enabled in openLens and disabled in closeLens
  // to prevent focus stealing when the lens panel is hidden
  lensCode.contentEditable = 'false';
  lensCode.addEventListener('input', () => {
    lensEdited = true;
    // If they're editing, go back to showing the import button (not confirm bar)
    if (lensMode === 'import') {
      lensConfirm.style.display = 'none';
      lensTitleEl.textContent   = LANG_LABELS[lensLang] + ' (edited)';
      lensStubCount.textContent = '';
    }
  });

  // Re-render on IVX source change, but only if user hasn't manually edited the lens
  srcEl.addEventListener('input', () => {
    if (lensOpen && !lensEdited) renderLens();
  });

  window._lensRender = renderLens;
  window._lensOpen   = () => lensOpen;
})();

// ── Apps Script transpiler + deployment ──────────────────────────────────────
//
// Converts WaitBlock AST nodes to Google Apps Script trigger functions.
// Called automatically from the Run button when WaitBlock nodes are present.

const AppsScriptTranspiler = (() => {

  // ── Value serializer: IVX runtime value → JS literal string ──────────────
  function jsLiteral(value) {
    if (value === null || value === undefined) return 'null';
    if (value === true)  return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(jsLiteral).join(', ') + ']';
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .filter(([k]) => !String(k).startsWith('__'))
        .map(([k, v]) => `${JSON.stringify(String(k))}: ${jsLiteral(v)}`);
      return '{' + entries.join(', ') + '}';
    }
    return JSON.stringify(String(value));
  }

  // ── AST node → JS string, resolving identifiers against globals snapshot ──
  function emitExpr(node, globals) {
    if (!node) return 'null';
    switch (node.type) {
      case 'NumberLit':  return String(node.value);
      case 'BoolLit':    return node.value === null ? 'null' : node.value ? 'true' : 'false';
      case 'StringLit':  return JSON.stringify(node.value);
      case 'ListLit':    return '[' + node.elements.map(e => emitExpr(e, globals)).join(', ') + ']';
      case 'DictLit':    return '{' + node.pairs.map(p =>
        `${emitExpr(p.key, globals)}: ${emitExpr(p.value, globals)}`).join(', ') + '}';
      case 'Identifier': {
        // If we have a snapshot value, bake it in as a literal
        if (globals && globals.has(node.name)) return jsLiteral(globals.get(node.name));
        return node.name;
      }
      case 'BinOp': {
        const opMap = { '=': '===', '!=': '!==', 'and': '&&', 'or': '||',
                        'not': '!', '^': '**', '//': 'Math.floor', 'xor': '^' };
        const op = opMap[node.op] ?? node.op;
        if (node.op === '//') return `Math.floor(${emitExpr(node.left, globals)} / ${emitExpr(node.right, globals)})`;
        return `${emitExpr(node.left, globals)} ${op} ${emitExpr(node.right, globals)}`;
      }
      case 'UnaryOp':
        return `!${emitExpr(node.operand, globals)}`;
      case 'Call':
        return `${node.name}(${node.args.map(a => emitExpr(a, globals)).join(', ')})`;
      case 'Invoke':
        return `${emitExpr(node.callee, globals)}(${node.args.map(a => emitExpr(a, globals)).join(', ')})`;
      case 'MemberAccess':
        return `${emitExpr(node.object, globals)}.${node.field}`;
      default:
        return '/* ? */';
    }
  }

  function emitStmt(node, globals, indent = '') {
    if (!node) return '';
    const E = n => emitExpr(n, globals);
    const S = (n, ind) => emitStmt(n, globals, ind ?? indent);
    const B = (stmts, ind) => (Array.isArray(stmts) ? stmts : []).map(s => emitStmt(s, globals, ind ?? indent + '  ')).join('\n');

    switch (node.type) {
      case 'Assign': {
        const target = node.target ? E(node.target) : node.name;
        return `${indent}var ${target} = ${E(node.expr)};`;
      }
      case 'Say':
        return `${indent}Logger.log(${E(node.expr)});`;
      case 'Gmail': {
        const to      = node.to      ? E(node.to)      : '""';
        const subject = node.subject ? E(node.subject) : '""';
        const body    = node.body    ? E(node.body)     : '""';
        return `${indent}GmailApp.sendEmail(${to}, ${subject}, ${body});`;
      }
      case 'If': {
        let out = `${indent}if (${E(node.condition)}) {\n${B(node.body)}\n${indent}}`;
        if (node.else_?.length) out += ` else {\n${B(node.else_)}\n${indent}}`;
        return out;
      }
      case 'Loop':
        return `${indent}while (${E(node.condition)}) {\n${B(node.body)}\n${indent}}`;
      case 'For':
        return `${indent}for (var ${node.iterVar} of ${node.target}) {\n${B(node.body)}\n${indent}}`;
      case 'Give':
        return `${indent}return ${E(node.expr)};`;
      case 'ExprStatement':
        return `${indent}${E(node.expr)};`;
      case 'SheetsOpen': {
        // Expand to Apps Script Sheets API calls
        const name = E(node.name);
        return `${indent}var _ss = SpreadsheetApp.openByName(${name});\n${indent}var _sheet = _ss.getActiveSheet();`;
      }
      default:
        return `${indent}// (${node.type})`;
    }
  }

  function transpileBodyToJS(stmts, globals) {
    if (!Array.isArray(stmts) || !stmts.length) return '  // (empty body)';
    return stmts.map(s => {
      try { return emitStmt(s, globals, '  '); }
      catch(e) { return `  // (could not transpile ${s?.type}: ${e.message})`; }
    }).filter(Boolean).join('\n');
  }

  // Transpile a single WaitBlock node to a .gs function + trigger registration
  function transpileWaitBlock(node, index, globals) {
    const fnName    = `ivxTrigger_${index}`;
    const trigger   = node.trigger;
    const recurring = node.recurring;

    const jsBody = transpileBodyToJS(node.body, globals);

    // Trigger installation
    let triggerSetup = '';
    if (trigger === 'time') {
      const timeStr = node.source?.value ?? '09:00';
      const [hh, mm] = timeStr.split(':');
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (recurring) {
        triggerSetup = `  ScriptApp.newTrigger('${fnName}')
    .timeBased()
    .atHour(${parseInt(hh,10)})
    .nearMinute(${parseInt(mm||'0',10)})
    .everyDays(1)
    .create();`;
      } else {
        // Build the target date string in the user's local timezone
        // so Apps Script schedules it correctly regardless of server timezone
        triggerSetup = `  // Target: ${timeStr} in ${tz}
  var _now = new Date();
  var _tzOffset = new Date().toLocaleString('en-US', {timeZone: '${tz}', hour12: false, hour: '2-digit', minute: '2-digit'});
  var _d = new Date();
  _d.setHours(${parseInt(hh,10)}, ${parseInt(mm||'0',10)}, 0, 0);
  // Adjust for timezone offset between UTC and ${tz}
  var _localNow = new Date(_now.toLocaleString('en-US', {timeZone: '${tz}'}));
  var _tzDiff = _now - _localNow;
  _d = new Date(_d.getTime() + _tzDiff);
  if (_d < new Date()) _d.setDate(_d.getDate() + 1);
  ScriptApp.newTrigger('${fnName}').timeBased().at(_d).create();`;
      }
    } else if (trigger === 'sheets') {
      const sheetName = globals && node.source?.type === 'Identifier' && globals.has(node.source.name)
        ? jsLiteral(globals.get(node.source.name))
        : (node.source ? emitExpr(node.source, globals) : '""');
      triggerSetup = `  var _ss = SpreadsheetApp.openByName(${sheetName});
  ScriptApp.newTrigger('${fnName}').forSpreadsheet(_ss).onEdit().create();`;
    } else if (trigger === 'email') {
      triggerSetup = `  ScriptApp.newTrigger('${fnName}')
    .timeBased().everyMinutes(${recurring ? 5 : 1}).create();`;
    }

    // One-shot self-deletion
    const deleteSelf = recurring ? '' : `
  // One-shot: remove this trigger after firing
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === '${fnName}')
    .forEach(t => ScriptApp.deleteTrigger(t));`;

    // Trigger-specific preamble
    let preamble = '';
    if (trigger === 'email') {
      const addr = node.source ? emitExpr(node.source, globals) : '""';
      preamble = `  var _threads = GmailApp.search('is:unread from:' + ${addr}, 0, 1);
  if (!_threads.length) return;
  var _msg = _threads[0].getMessages()[0];
  var request = { subject: _msg.getSubject(), from: _msg.getFrom(), body: _msg.getPlainBody() };
  _msg.markRead();`;
    } else if (trigger === 'sheets') {
      preamble = `  var request = e;`;
    }

    const fn = `function ${fnName}(e) {
${preamble}
${jsBody}
${deleteSelf}
}`;

    return { fnName, fn, triggerSetup };
  }

  // Build the full Apps Script project
  function buildProject(waitBlocks, globals) {
    const functions = [], setups = [];
    const services  = new Set();

    waitBlocks.forEach((node, i) => {
      const { fn, fnName, triggerSetup } = transpileWaitBlock(node, i, globals);
      functions.push(fn);
      if (triggerSetup) setups.push(triggerSetup);

      // Scan trigger type AND entire body recursively for every service used
      const scanNode = n => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(scanNode); return; }
        switch (n.type) {
          case 'Gmail':       services.add('gmail');  break;
          case 'SheetsOpen':  services.add('sheets'); break;
          case 'Save':        services.add('drive');  break;
        }
        // Recurse into all child arrays
        if (Array.isArray(n.body))    n.body.forEach(scanNode);
        if (Array.isArray(n.else_))   n.else_.forEach(scanNode);
        if (Array.isArray(n.params))  n.params.forEach(scanNode);
        if (n.expr)      scanNode(n.expr);
        if (n.condition) scanNode(n.condition);
        if (n.left)      scanNode(n.left);
        if (n.right)     scanNode(n.right);
      };

      // Trigger type adds its own service
      if (node.trigger === 'email')  services.add('gmail');
      if (node.trigger === 'sheets') services.add('sheets');

      // Scan body for everything else
      scanNode(node.body);
    });

    const oauthScopes = [
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/script.projects',
    ];
    if (services.has('gmail'))  oauthScopes.push('https://www.googleapis.com/auth/gmail.modify');
    if (services.has('sheets')) oauthScopes.push('https://www.googleapis.com/auth/spreadsheets');
    if (services.has('drive'))  oauthScopes.push('https://www.googleapis.com/auth/drive.file');

    const setupFn = `function ivxSetupTriggers() {
  // Remove existing IVX triggers
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction().startsWith('ivxTrigger_'))
    .forEach(t => ScriptApp.deleteTrigger(t));
  // Install new triggers
${setups.join('\n')}
}`;

    const code = [
      '// Auto-generated by IVX — do not edit manually',
      '// Re-run your IVX program to regenerate',
      '',
      setupFn,
      '',
      ...functions,
    ].join('\n');

    // Scopes populated by body scanner above

    const manifest = JSON.stringify({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dependencies: {},
      exceptionLogging: 'STACKDRIVER',
      runtimeVersion: 'V8',
      oauthScopes,
    }, null, 2);

    return { code, manifest };
  }

  // Deploy to Apps Script REST API
  async function deploy(waitBlocks, globals, token) {
    if (!token) throw new Error('Not signed in to Google');

    const { code, manifest } = buildProject(waitBlocks, globals);

    const API    = 'https://script.googleapis.com/v1/projects';
    const DRIVE  = 'https://www.googleapis.com/drive/v3';
    const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    // Get or create the persistent IVX script project
    if (!localStorage.getItem('ivx_script_id')) {
      localStorage.setItem('ivx_script_id', '1ozcWRzBjlR8fltP3yM5WK2EJryw57mKJq9xgKdaq6iMOjK1spLib1VJf');
    }
    let scriptId = localStorage.getItem('ivx_script_id');

    // Try to update existing project — if it fails with 404, create a new one
    let upRes = await fetch(API + '/' + scriptId + '/content', {
      method: 'PUT', headers,
      body: JSON.stringify({
        files: [
          { name: 'ivx_triggers', type: 'SERVER_JS', source: code },
          { name: 'appsscript',   type: 'JSON',       source: manifest },
        ],
      }),
    });

    if (!upRes.ok) {
      const err = await upRes.json().catch(() => ({}));
      if (err?.error?.code === 404 || err?.error?.status === 'NOT_FOUND') {
        // Project was deleted — create a new one
        const createRes = await fetch(API, {
          method: 'POST', headers,
          body: JSON.stringify({ title: 'IVX Triggers' }),
        });
        if (!createRes.ok) {
          const cerr = await createRes.json().catch(() => ({}));
          throw new Error('Apps Script create failed: ' + (cerr?.error?.message ?? createRes.statusText));
        }
        scriptId = (await createRes.json()).scriptId;
        localStorage.setItem('ivx_script_id', scriptId);

        // Retry the update with the new project
        upRes = await fetch(API + '/' + scriptId + '/content', {
          method: 'PUT', headers,
          body: JSON.stringify({
            files: [
              { name: 'ivx_triggers', type: 'SERVER_JS', source: code },
              { name: 'appsscript',   type: 'JSON',       source: manifest },
            ],
          }),
        });
        if (!upRes.ok) {
          const uerr = await upRes.json().catch(() => ({}));
          throw new Error('Apps Script update failed: ' + (uerr?.error?.message ?? upRes.statusText));
        }
      } else {
        throw new Error('Apps Script update failed: ' + (err?.error?.message ?? upRes.statusText));
      }
    }

    // Check if this is the first deploy (no triggers installed yet)
    const triggersRes = await fetch('https://script.googleapis.com/v1/projects/' + scriptId + '/triggers', { headers });
    const triggersData = triggersRes.ok ? await triggersRes.json() : {};
    const existingTriggers = (triggersData.triggers || []).filter(t => t.functionName && t.functionName.startsWith('ivxTrigger_'));
    const firstDeploy = existingTriggers.length === 0;

    return { scriptId, triggerCount: waitBlocks.length, firstDeploy };
  }

  // Persist script ID — localStorage first (reliable), Drive as backup
  async function _loadScriptId(token, DRIVE) {
    // Try localStorage first — fastest and most reliable
    const local = localStorage.getItem('ivx_script_id');
    if (local) return local;

    // Fall back to Drive
    const h = { 'Authorization': 'Bearer ' + token };
    const q = encodeURIComponent("name='ivx_config.json' and trashed=false");
    const res = await fetch(DRIVE + '/files?q=' + q + '&fields=files(id)&spaces=drive', { headers: h });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.files || !data.files.length) return null;
    const content = await fetch(DRIVE + '/files/' + data.files[0].id + '?alt=media', { headers: h });
    if (!content.ok) return null;
    try {
      const j = await content.json();
      if (j.scriptId) {
        localStorage.setItem('ivx_script_id', j.scriptId); // cache locally
        return j.scriptId;
      }
      return null;
    } catch(e) { return null; }
  }

  async function _saveScriptId(scriptId, token, DRIVE, UPLOAD) {
    // Always save to localStorage immediately
    if (scriptId) {
      localStorage.setItem('ivx_script_id', scriptId);
    } else {
      localStorage.removeItem('ivx_script_id');
    }

    // Also persist to Drive for cross-device/cross-browser access
    const h = { 'Authorization': 'Bearer ' + token };
    const body = JSON.stringify({ scriptId: scriptId });
    const q = encodeURIComponent("name='ivx_config.json' and trashed=false");
    const res = await fetch(DRIVE + '/files?q=' + q + '&fields=files(id)&spaces=drive', { headers: h });
    const data = res.ok ? await res.json() : {};
    if (data.files && data.files.length) {
      await fetch(UPLOAD + '/files/' + data.files[0].id + '?uploadType=media', {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body,
      });
    } else {
      const meta = JSON.stringify({ name: 'ivx_config.json', mimeType: 'application/json' });
      const boundary = 'ivxboundary';
      const form = '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + meta +
                   '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + body +
                   '\r\n--' + boundary + '--';
      await fetch(UPLOAD + '/files?uploadType=multipart', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: form,
      });
    }
  }

  function extractWaitBlocks(ast) {
    const blocks = [];
    const walk = stmts => {
      if (!Array.isArray(stmts)) return;
      for (const stmt of stmts) {
        if (!stmt) continue;
        if (stmt.type === 'WaitBlock') blocks.push(stmt);
        if (Array.isArray(stmt.body))  walk(stmt.body);
        if (Array.isArray(stmt.else_)) walk(stmt.else_);
      }
    };
    walk(ast?.body);
    return blocks;
  }

  return { deploy, extractWaitBlocks, buildProject };
})();

// ── Export ────────────────────────────────────────────────────────────────────
function exportSVG() {
  const bbox = graphBounds;
  const pad = 20;
  // Clone the canvas SVG and set a clean viewBox covering the full graph
  const clone = svg.cloneNode(true);
  clone.setAttribute('viewBox', `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad*2} ${bbox.height + pad*2}`);
  clone.setAttribute('width',  String(bbox.width  + pad*2));
  clone.setAttribute('height', String(bbox.height + pad*2));
  clone.style.background = '#0f0f14';
  // Inline the CSS animation keyframes so the exported SVG is self-contained
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `
    text { font-family: system-ui, sans-serif; font-size: 12px; fill: #eee; }
    @keyframes flow-a { to { stroke-dashoffset: -18 } }
    @keyframes flow-b { from { stroke-dashoffset: -9 } to { stroke-dashoffset: -27 } }
    .flow-a { animation: flow-a .45s linear infinite; }
    .flow-b { animation: flow-b .45s linear infinite; }
  `;
  clone.insertBefore(style, clone.firstChild);

  const meta = document.createElementNS('http://www.w3.org/2000/svg', 'metadata');
  meta.setAttribute('id', 'ivx-metadata');
  meta.textContent = JSON.stringify({
    format: 'ivx.graph.v1',
    exportedAt: new Date().toISOString(),
    blocks: lastRenderedBlocks,
  });
  clone.insertBefore(meta, clone.firstChild);

  return new XMLSerializer().serializeToString(clone);
}

function downloadFile(filename, content, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportJSON() {
  if (!currentGraph) return;
  const nodeInfo = new Map(currentGraph.nodes.map(n => [n.id, n]));
  const map = {};
  for (const node of currentGraph.nodes) {
    map[node.id] = { type: node.kind, to: [] };
  }
  for (const edge of currentGraph.edges) {
    if (map[edge.from]) {
      const target = nodeInfo.get(edge.to);
      map[edge.from].to.push({
        id: edge.to,
        type: target ? target.kind : 'Unknown',
        label: edge.label ?? null
      });
    }
  }
  const payload = {
    format: 'ivx.graph.v1',
    graph: map,
    blocks: lastRenderedBlocks,
  };
  downloadFile('graph.json', JSON.stringify(payload, null, 2), 'application/json');
}

function exportAsSVG() {
  downloadFile('graph.svg', exportSVG(), 'image/svg+xml');
}

function exportAsPNG() {
  const svgStr = exportSVG();
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const url  = URL.createObjectURL(blob);
  const img  = new Image();
  const pad  = 20;
  img.onload = () => {
    const w = graphBounds.width  + pad*2;
    const h = graphBounds.height + pad*2;
    const canvas = document.createElement('canvas');
    // Render at 2x for crisp export on high-DPI screens
    canvas.width  = w * 2;
    canvas.height = h * 2;
    const ctx2d = canvas.getContext('2d');
    ctx2d.scale(2, 2);
    ctx2d.fillStyle = '#0f0f14';
    ctx2d.fillRect(0, 0, w, h);
    ctx2d.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    canvas.toBlob(b => downloadFile('graph.png', b, 'image/png'), 'image/png');
  };
  img.src = url;
}

document.getElementById('export-btn').addEventListener('click', () => {
  const fmt = document.getElementById('export-fmt').value;
  if      (fmt === 'json') exportJSON();
  else if (fmt === 'svg')  exportAsSVG();
  else if (fmt === 'png')  exportAsPNG();
});
// ── Syntax highlighting ───────────────────────────────────────────────────────
const hlEl     = document.getElementById('src-hl');
const gutterEl = document.getElementById('src-gutter-inner');
const scrollEl = document.getElementById('src-scroll');

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Keyword sets for the tokenizing highlighter
const _KW_NODE     = new Set(['if','fork','loop','dot','con','take','say','give','fun','class','init','end','from','make','note','for','in','wait','del','ask','post','use','key','sheets','email','by','try','err']);
const _KW_FLOW     = new Set(['so','then','else']);
const _KW_OUTGOING = new Set(['prev','next']);
const _KW_LOGIC    = new Set(['not','and','or','xor','is','yes','no','none']);

// Tokenize a raw source line into typed spans, then emit HTML.
// Handles strings, numbers, lists, dicts, keywords — all before HTML escaping
// so bracket/quote characters are never corrupted by &amp; etc.
function highlightLine(line, allVars = new Set(), allClasses = new Set()) {
  // Split off trailing 'note ...' comment first
  const noteMatch = line.match(/^(.*?)\b(note\s.*)$/);
  const code = noteMatch ? noteMatch[1] : line;
  const note = noteMatch ? noteMatch[2] : '';

  // Tokenizer: walk the code string producing {text, cls} segments
  const segs = [];
  let i = 0;
  let prevWasMake = false;
  const push = (text, cls) => { if (text) segs.push({ text, cls }); };

  while (i < code.length) {
    // String literal — detect URL type and highlight {interpolations}
    if (code[i] === '"') {
      // Check for triple quote
      if (code[i+1] === '"' && code[i+2] === '"') {
        let j = i + 3;
        while (j < code.length && !(code[j] === '"' && code[j+1] === '"' && code[j+2] === '"')) j++;
        if (j < code.length) j += 3;
        push(code.slice(i, j), 'kw-string');
        i = j; continue;
      }
      let j = i + 1;
      while (j < code.length && !(code[j] === '"' && code[j-1] !== '\\')) j++;
      if (j < code.length) j++;
      const raw     = code.slice(i, j);
      const strVal  = raw.slice(1, -1);
      const isUrl   = strVal.startsWith('http://') || strVal.startsWith('https://');
      const baseCls = isUrl ? 'kw-url' : 'kw-string';
      // Split on {expr} patterns and highlight interpolations semantically
      const parts = strVal.split(/(\{[^}]+\})/);
      if (parts.length > 1) {
        push('"', baseCls);
        for (const part of parts) {
          if (/^\{[^}]+\}$/.test(part)) {
            // Highlight the inside of {expr} semantically
            const inner = part.slice(1, -1);
            push('{', 'kw-dict');
            // Tokenize: split on dots, parens, brackets, commas
            const innerSegs = inner.split(/([.()\[\],])/);
            let prevInnerSeg = '';
            for (const seg of innerSegs) {
              if (!seg) continue;
              if (seg === '.' || seg === ',' ) { push(seg, 'kw-dict'); prevInnerSeg = seg; continue; }
              if (seg === '(' || seg === ')')  { push(seg, 'kw-funcall'); prevInnerSeg = seg; continue; }
              if (seg === '[' || seg === ']')  { push(seg, 'kw-list'); prevInnerSeg = seg; continue; }
              if (/^\d/.test(seg))             { push(seg, 'kw-number'); prevInnerSeg = seg; continue; }
              if (allClasses.has(seg))          { push(seg, 'kw-classname'); prevInnerSeg = seg; continue; }
              if (seg === 'self' || seg === 'super') { push(seg, 'kw-classname'); prevInnerSeg = seg; continue; }
              // If followed by ( it's a method call, if preceded by . it's a field, otherwise a variable
              const nextIdx = innerSegs.indexOf(seg) + 1;
              const nextSeg = innerSegs[nextIdx] ?? '';
              if (nextSeg === '(')      push(seg, 'kw-funcall');
              else if (prevInnerSeg === '.') push(seg, 'kw-var');
              else if (allVars.has(seg)) push(seg, 'kw-var');
              else push(seg, 'kw-var');
              prevInnerSeg = seg;
            }
            push('}', 'kw-dict');
          }
          else if (part) push(part, baseCls);
        }
        push('"', baseCls);
      } else {
        push(raw, baseCls);
      }
      i = j; continue;
    }
    // List literal  [...]
    if (code[i] === '[') {
      let depth = 0, j = i;
      while (j < code.length) {
        if (code[j] === '[') depth++;
        else if (code[j] === ']') { depth--; if (depth === 0) { j++; break; } }
        j++;
      }
      push(code.slice(i, j), 'kw-list'); i = j; continue;
    }
    // Dict literal  {...}
    if (code[i] === '{') {
      let depth = 0, j = i;
      while (j < code.length) {
        if (code[j] === '{') depth++;
        else if (code[j] === '}') { depth--; if (depth === 0) { j++; break; } }
        j++;
      }
      push(code.slice(i, j), 'kw-dict'); i = j; continue;
    }
    // Number literal (integer or float)
    if (/[\d]/.test(code[i]) || (code[i] === '-' && /\d/.test(code[i+1]||''))) {
      let j = i;
      if (code[j] === '-') j++;
      while (j < code.length && /[\d.]/.test(code[j])) j++;
      push(code.slice(i, j), 'kw-number'); i = j; continue;
    }
    // Word token — check against keyword sets, or function call if followed by (
    if (/[A-Za-z_]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[\w]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const isFunCall = code[j] === '(';
      const isLazy    = code[j] === '?' && !isFunCall;
      let cls = '';
      if (allClasses.has(word))            cls = 'kw-classname';
      else if (isFunCall)                  cls = 'kw-funcall';
      else if (word === 'self' || word === 'super') cls = 'kw-classname';
      else if (_KW_NODE.has(word))         cls = 'kw-node';
      else if (_KW_FLOW.has(word))         cls = 'kw-flow';
      else if (_KW_OUTGOING.has(word))     cls = 'kw-outgoing';
      else if (_KW_LOGIC.has(word))        cls = 'kw-logic';
      else if (allVars.has(word))          cls = 'kw-var';
      prevWasMake = (word === 'make') && !isFunCall;
      push(word, cls); i = j;
      // ? suffix — same color as the variable, just marks lazy declaration
      if (isLazy) { push('?', cls || 'kw-var'); i++; }
      continue;
    }
    // Dot — color the following identifier as kw-var (field) or kw-funcall (method)
    if (code[i] === '.') {
      push('.', '');
      i++;
      let j = i;
      while (j < code.length && /[\w]/.test(code[j])) j++;
      if (j > i) {
        const isMethod = code[j] === '(';
        push(code.slice(i, j), isMethod ? 'kw-funcall' : 'kw-var');
        i = j;
      }
      continue;
    }
    // Everything else — pass through as plain text (accumulate runs)
    let j = i + 1;
    while (j < code.length && !/[A-Za-z_\d\-"\[{]/.test(code[j])) j++;
    push(code.slice(i, j), ''); i = j;
  }

  let html = segs.map(({ text, cls }) => {
    const e = escHtml(text);
    return cls ? `<span class="${cls}">${e}</span>` : e;
  }).join('');

  if (note) html += `<span class="kw-note">${escHtml(note)}</span>`;
  return html;
}

function highlightSource(src) {
  // Pre-scan entire source for all make-declared variable names
  // so every occurrence gets colored, not just the token after 'make'
  const allVars = new Set();
  const makeMatches = src.match(/\bmake\s+([A-Za-z_]\w*)/g);
  if (makeMatches) makeMatches.forEach(m => { const v = m.match(/make\s+(\w+)/); if (v) allVars.add(v[1]); });
  const takeMatches = src.match(/\btake\s+(?:(?:int|flt|str|bin|list|dict)\s*\(\s*)?([A-Za-z_]\w*)/g);
  if (takeMatches) takeMatches.forEach(m => { const v = m.match(/([A-Za-z_]\w*)(?:\s*\))?$/); if (v) allVars.add(v[1]); });
  // Also collect lazy-declared variables (name?) so they color as vars
  const lazyMatches = src.match(/\b([A-Za-z_]\w*)\?/g);
  if (lazyMatches) lazyMatches.forEach(m => { allVars.add(m.slice(0, -1)); });
  // Loop iterators always color as variables — they act like variables
  ['i','ii','iii','j','jj','jjj','k','kk','kkk'].forEach(v => allVars.add(v));
  // Function parameters color as variables (handles name, name?, name * 3, name? 100)
  const funMatches = src.match(/\b(?:fun\s+\w+|init)\s*\(([^)]+)\)/g);
  if (funMatches) funMatches.forEach(m => {
    const inner = m.match(/\(([^)]+)\)/);
    if (inner) inner[1].split(',').forEach(p => {
      const v = p.trim().match(/^([A-Za-z_]\w*)/);
      if (v) allVars.add(v[1]);
    });
  });

  // Collect declared class names so both declarations and constructor calls
  // share one visual identity.
  const allClasses = new Set();
  const classMatches = src.match(/\bclass\s+([A-Za-z_]\w*)/g);
  if (classMatches) classMatches.forEach(m => { const c = m.match(/class\s+([A-Za-z_]\w*)/); if (c) allClasses.add(c[1]); });

  return src.split('\n').map(line => highlightLine(line, allVars, allClasses)).join('\n');
}

function updateHighlight() {
  const src   = srcEl.value;
  const lines = src.split('\n');
  const count = lines.length;

  // Update highlight layer
  hlEl.innerHTML = highlightSource(src) + '\n';

  // Update line number gutter
  let gutter = '';
  for (let i = 1; i <= count; i++) gutter += i + '\n';
  gutterEl.textContent = gutter;

  // Size the highlight and textarea to content so scroll container works
  const lineH   = 13 * 1.7; // font-size * line-height
  const padV    = 10 * 2;   // top + bottom padding
  const minH    = scrollEl.clientHeight || 300;
  const contentH = Math.max(minH, count * lineH + padV);
  hlEl.style.height    = contentH + 'px';
  srcEl.style.height   = contentH + 'px';

  // Sync gutter scroll position with scroll container
  gutterEl.style.top = -scrollEl.scrollTop + 'px';
}

// Sync scroll: when src-scroll scrolls, move gutter too
scrollEl.addEventListener('scroll', () => {
  gutterEl.style.top = -scrollEl.scrollTop + 'px';
});

// Textarea scroll should be ignored — scrollEl handles it
srcEl.addEventListener('scroll', () => { srcEl.scrollTop = 0; srcEl.scrollLeft = 0; });

srcEl.addEventListener('input', updateHighlight);
updateHighlight();

