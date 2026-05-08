// ivx-render.js — IVX Visual Rendering Engine
// SVG layout, node/edge drawing, zoom/pan, minimap, interaction,
// trace/highlight, block UI, step controls.
// Depends on: ivx-parser.js (parseivx, preprocessControlFlowSyntax,
//             NODE_KEYS, IN_KEYS, OUT_KEYS, OUTGOING_KEYWORDS)
//             ivx-editor.js (srcEl, updateHighlight, scheduleRender, _ivxInit)
// PROPRIETARY AND CONFIDENTIAL
// Copyright 2026 IVX. All rights reserved.

'use strict';


const NS = 'http://www.w3.org/2000/svg';
const BASEY = 40, YSTEP = 80, MAX_NODE_W = 260, PAD_X = 20, PAD_Y = 10;
const LINE_H = 14, CELL_PAD_X = 6, CELL_H = 22;
const BLOCK_GAP_Y = 28, BLOCK_PAD = 12, BLANK_LINE_THRESH = 2;

const NODE_FILL = { Decision:'#004b8d', Predictive:'#6a00a3', Function:'#92700a',
                    Start:'#007f00', End:'#7f0000', Input:'#007f00', Output:'#ED8936',
                    WaitBlock:'#7c4d00', Speak:'#5b3fa8', Fork:'#5c2d91' };
const TYPE_FILL = { string:'#b45309', integer:'#60a5fa', float:'#14b8a6',
                    boolean:'#1e3a8a', range:'#ec4899', none:'#ef4444', list:'#6b7280', dict:'#7a4d2e' };

// State
let currentGraph, currentXSTEP = 140;
let currentPositions = new Map();
let _errorNodeId = null; // persists across renders so badge survives re-renders
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
  Decision: 'if', Input: 'take', Output: 'print', Speak: 'say', End: 'end',
  Fork: 'fork',
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
  // Bug fix: for 'make' nodes, the first token after 'make' is the variable name.
  // We must preserve it so that editing the value (the body text) doesn't lose the variable.
  if (leadTokens.includes('make') && tokens.length > ti) {
    leadTokens.push(tokens[ti]);
    ti++;
  }

  const trailTokens = [];
  // Check last token for outgoing keyword
  const allTail = tokens.slice(ti);
  if (allTail.length > 0 && OUT_KEYS.has(allTail[allTail.length - 1])) {
    trailTokens.push(allTail.pop());
  }

  const parts = [...leadTokens, newText.trim(), ...trailTokens].filter(Boolean);
  rawLines[line] = prefix + parts.join(' ') + trailingNote;
  const newCode = rawLines.join('\n');
  if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode });
}

function insertNodeOnEdgeInSource(fromNodeId, toNodeId, nodeKind) {
  if (!currentGraph) return;
  const fromNode = currentGraph.nodes.find(n => n.id === fromNodeId);
  const toNode   = currentGraph.nodes.find(n => n.id === toNodeId);
  if (!fromNode || !toNode) return;

  const isImplicit = (n) => n.meta && (n.meta.includes('implicit start') || n.meta.includes('implicit end'));

  const originalSrc = srcEl.value;
  let originalLines = originalSrc.split('\n');

  // ── Source mapping ──────────────────────────────────────────────────────────
  const prepToOrig = [];
  const prepToSubLine = [];
  originalLines.forEach((origLine, origIdx) => {
    const expanded = preprocessControlFlowSyntax(origLine);
    expanded.split('\n').forEach((_, k) => {
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
    let i = 0, incoming = '', nodeKey = '';
    if (i < tokens.length && IN_KEYS.has(tokens[i]))   { incoming = tokens[i]; i++; }
    if (i < tokens.length && NODE_KEYS.has(tokens[i])) { nodeKey  = tokens[i]; i++; }
    const rest = tokens.slice(i);
    let outgoing = '';
    if (rest.length > 0 && OUTGOING_KEYWORDS.includes(rest[rest.length - 1]))
      outgoing = rest[rest.length - 1];
    return { indentSpaces, incoming, nodeKey, outgoing };
  };

  const expandOrigLine = (raw) => preprocessControlFlowSyntax(raw).split('\n');

  // ── Find the if Decision that owns a given node ─────────────────────────────
  // Used to locate the else line (or absence of one) for a Decision's no-edge.
  const findIfDecision = (nodeId) => {
    // Walk edges backwards from nodeId to find the Decision ancestor
    const edgesTo = currentGraph.edges.filter(e => e.to === nodeId);
    for (const e of edgesTo) {
      const src = currentGraph.nodes.find(n => n.id === e.from);
      if (src?.kind === 'Decision') return src;
      const found = findIfDecision(e.from);
      if (found) return found;
    }
    return null;
  };

  // ── Determine if this is a no-edge from a Decision ──────────────────────────
  // An edge is a "no-edge" when fromNode is a Decision and the edge label is 'no'
  const edge = currentGraph.edges.find(e => e.from === fromNodeId && e.to === toNodeId);
  const isNoEdge = fromNode.kind === 'Decision' && edge?.label === 'no';

  const keyword  = KIND_TO_KEY[nodeKind] || '';
  const placeholder = nodeKind === 'End' ? '' : 'new node';

  // ── SPECIAL CASE: no-edge of a Decision ────────────────────────────────────
  if (isNoEdge) {
    const decOrigLine = toOrigIdx(fromNode.line);
    const decRaw     = originalLines[decOrigLine];
    const decIndent  = decRaw.length - decRaw.trimStart().length;
    const prefix     = ' '.repeat(decIndent);
    const innerPfx   = ' '.repeat(decIndent + 2);

    // Scan forward to find where the true-branch body ends and whether an
    // else line already exists at this decision's indent level.
    let trueBodyEnd = decOrigLine; // last line of the true branch body
    let elseLineIdx = -1;          // index of existing else line, or -1

    for (let i = decOrigLine + 1; i < originalLines.length; i++) {
      const raw = originalLines[i];
      if (!raw.trim()) continue;
      const indent  = raw.length - raw.trimStart().length;
      const trimmed = raw.trimStart();
      if (indent === decIndent && trimmed.startsWith('else')) {
        elseLineIdx = i;
        break;
      }
      if (indent <= decIndent) break; // exited the block, no else
      trueBodyEnd = i;
    }

    const newNodeContent = keyword
      ? `${keyword}${placeholder ? ' ' + placeholder : ''}`
      : placeholder;

    if (elseLineIdx === -1) {
      // Case A: no else exists — insert "else new node" right after the true body
      const insertAt = trueBodyEnd + 1;
      originalLines.splice(insertAt, 0, `${prefix}else ${newNodeContent}`);
      srcEl.value = originalLines.join('\n');
      _pendingInsertEditLine = insertAt;
    } else {
      // Case B: else exists — prepend "else new node", bump old else content down
      const elseRaw     = originalLines[elseLineIdx];
      // Strip the "else " prefix to get the existing content
      const elseContent = elseRaw.trimStart().replace(/^else\s*/, '').trim();
      // Replace the else line with "else new node"
      originalLines[elseLineIdx] = `${prefix}else ${newNodeContent}`;
      // If there was content on the else line, push it down as an indented child
      if (elseContent) {
        originalLines.splice(elseLineIdx + 1, 0, `${innerPfx}${elseContent}`);
      }
      const newCode = originalLines.join('\n');
      _pendingInsertEditLine = elseLineIdx;
      if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode });
    }
    return;
  }

  // ── SPECIAL CASE: edge inside an else branch → tail of else → if-join ──────
  // fromNode is inside an else branch, toNode is the if-join connector.
  // Insert an indented new node at the bottom of the else branch.
  const toIsIfJoin = toNode.kind === 'Connector' && toNode.meta?.includes('if-join');
  if (toIsIfJoin) {
    const fromOrigLine = toOrigIdx(fromNode.line);
    const fromRaw      = originalLines[fromOrigLine];
    const fromParsed   = parseLine(fromRaw);

    // Check if fromNode is inside an else branch by looking for an 'else' keyword
    // at a lower indent above fromOrigLine
    const fromIndent = fromParsed.indentSpaces;
    let inElseBranch = false;
    for (let i = fromOrigLine - 1; i >= 0; i--) {
      const raw = originalLines[i];
      if (!raw.trim()) continue;
      const indent  = raw.length - raw.trimStart().length;
      const trimmed = raw.trimStart();
      if (indent < fromIndent) {
        if (trimmed.startsWith('else')) inElseBranch = true;
        break;
      }
    }

    // Whether in else branch or true branch tail → if-join:
    // always insert right after fromNode at fromNode's indent
    const insertAt   = fromOrigLine + 1;
    const prefix     = ' '.repeat(fromIndent);
    const newNodeContent = keyword
      ? `${prefix}${keyword}${placeholder ? ' ' + placeholder : ''}`
      : `${prefix}${placeholder}`;

    originalLines.splice(insertAt, 0, newNodeContent);
    const newCode = originalLines.join('\n');
    _pendingInsertEditLine = insertAt;
    if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode });
    return;
  }

  // ── GENERAL CASE ────────────────────────────────────────────────────────────
  const fromOrigIdx  = isImplicit(fromNode) ? -1 : toOrigIdx(fromNode.line);
  const toOrigIndex  = isImplicit(toNode)   ? originalLines.length : toOrigIdx(toNode.line);
  const fromSubLine  = isImplicit(fromNode) ? 0 : prepToSubLine[fromNode.line];

  let insertAfterOrig = fromOrigIdx;
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
    // Same source line (e.g. loop-head → loop-cond)
    const origRaw  = originalLines[fromOrigIdx];
    const subLines = expandOrigLine(origRaw);
    originalLines.splice(fromOrigIdx, 1, ...subLines);
    spliceAt = fromOrigIdx + fromSubLine + 1;
    const fromSubRaw = subLines[fromSubLine];
    const fp = parseLine(fromSubRaw);
    if (fp.outgoing === 'prev' || fp.outgoing === 'next') {
      inheritedOutgoing = fp.outgoing;
      originalLines[fromOrigIdx + fromSubLine] = fromSubRaw.replace(/\s+(prev|next)\s*$/, '');
    }
    // loop-head→loop-cond: new node goes inside the body at +2 indent
    indentSpaces = (fromNode.kind === 'Connector' && fromNode.meta?.includes('loop-head'))
      ? fp.indentSpaces + 2
      : fp.indentSpaces;
  } else {
    const fromRaw = originalLines[fromOrigIdx];
    const fp      = parseLine(fromRaw);
    if (fp.outgoing === 'prev' || fp.outgoing === 'next') {
      inheritedOutgoing = fp.outgoing;
      originalLines[fromOrigIdx] = fromRaw.replace(/\s+(prev|next)\s*$/, '');
    }

    if (toOrigIndex >= 0 && toOrigIndex < originalLines.length) {
      const toParsed = parseLine(originalLines[toOrigIndex]);
      if (toParsed.incoming === 'else') {
        // Edge leads into a real else branch — insert just above the else line
        indentSpaces    = toParsed.indentSpaces;
        insertAfterOrig = toOrigIndex - 1;
        inheritedOutgoing = '';
      } else if (toOrigIndex > fromOrigIdx + 1) {
        // Block body between fromNode and toNode — insert just before toNode
        indentSpaces    = toParsed.indentSpaces;
        insertAfterOrig = toOrigIndex - 1;
      } else {
        // Adjacent nodes
        indentSpaces = toParsed.indentSpaces;
      }
    } else {
      indentSpaces = fp.indentSpaces;
    }

    spliceAt = insertAfterOrig + 1;
  }

  const prefix = ' '.repeat(indentSpaces);
  const outgoingSuffix = inheritedOutgoing ? ' ' + inheritedOutgoing : '';
  const newLine = keyword
    ? `${prefix}${keyword}${placeholder ? ' ' + placeholder : ''}${outgoingSuffix}`
    : `${prefix}${placeholder}${outgoingSuffix}`;

  originalLines.splice(spliceAt, 0, newLine);
  const newCode = originalLines.join('\n');
  _pendingInsertEditLine = spliceAt;
  if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode });
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
  const depth = new Map(graph.nodes.filter(n => !n._virtual).map(n => [n.id, (n.kind==='Start'||n.kind==='Function'||n.kind==='WaitBlock') ? 0 : Infinity]));

  // Err handler nodes are side islands — give them depth 0 so they don't
  // push nodes below them in the sequential Y layout
  const errHandlerIds = new Set(
    graph.nodes.filter(n => n.meta?.includes('error-handler-of')).map(n => n.id)
  );
  for (const id of errHandlerIds) depth.set(id, 0);

  const fwdEdges = graph.edges.filter(e => {
    const a = byId.get(e.from), b = byId.get(e.to);
    return a && b && fwd(a, b);
  });

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
      else if (errHandlerIds.has(n.id)) { /* already 0 */ }
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
  currentPositions = positions;
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

  // Err handler nodes: position as a left-side island, like a function body but to the LEFT.
  // Vertically centered on the Y midpoint of the try body nodes.
  for (const n of graph.nodes) {
    const m = n.meta?.match(/error-handler-of=(\d+)/);
    if (!m) continue;
    const tryNodeId = parseInt(m[1], 10);
    const tryNode   = graph.nodes.find(nd => nd.id === tryNodeId);
    if (!tryNode) continue;
    const bodyMeta  = tryNode.meta?.match(/try-body=\[([^\]]*)\]/);
    if (!bodyMeta) continue;
    const bodyIds   = bodyMeta[1].split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
    const bodyYs    = bodyIds.map(id => positions.get(id)?.centerY).filter(v => v != null);
    const midY      = bodyYs.length ? (Math.min(...bodyYs) + Math.max(...bodyYs)) / 2 : BASEY;
    const ep        = positions.get(n.id);
    if (ep) {
      ep.centerX = ep.x = centerX0 - XSTEP * 2.5;  // left of main column
      ep.centerY = ep.y = midY;
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
  if (node.kind==='Fork')
    // Circle — visually distinct from Decision diamond
    return el('circle', {cx, cy, r: Math.min(w,h)/2});
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
  const stripped = fullText.replace(/^make\s+/, '');
  const nameMatch = stripped.match(/^([A-Za-z_]\w*)\s+([[{][\s\S]*)/);
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
    if (node._virtual) continue;  // virtual try-block records — not rendered
    const pos = positions.get(node.id);
    if (!pos) continue;
    const { centerX:cx, centerY:cy } = pos;

    // Connector dots
    if (node.kind==='Connector' || node.kind==='NextConnector') {
      const r=8, fill=node.kind==='Connector'?'#bbb':'#00bfff';
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
  const color = label==='yes'?'#4ade80':label==='no'?'#f87171':'#aaa';
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
  // Build set of err handler node ids — their edges aren't drawn as flow edges
  const errHandlerIds = new Set(
    graph.nodes.filter(n => n.meta?.includes('error-handler-of')).map(n => n.id)
  );
  loopBowSign = 1;
  for (const e of [...graph.edges,...extra]) {
    if (hidden.has(e.from)||hidden.has(e.to)) continue;
    // Skip edges connecting to/from err handler side islands
    if (errHandlerIds.has(e.from) || errHandlerIds.has(e.to)) continue;
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
  for (const tryNode of graph.nodes.filter(n => n.meta?.includes('try-block') && n._virtual)) {
    const m = tryNode.meta?.match(/try-body=\[([^\]]*)\]/);
    if (!m) continue;
    const ids = m[1].split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id) && !hidden.has(id));
    if (!ids.length) continue;
    const fp = positions.get(ids[0]);
    const lp = positions.get(ids[ids.length - 1]);
    if (!fp || !lp) continue;

    const leftEdge = Math.min(...ids.map(id => positions.get(id)?.x ?? Infinity).filter(isFinite));
    const pad  = 8;
    const bx   = leftEdge - pad - 12;
    const top  = (fp.y ?? fp.centerY) - pad;
    const bot  = ((lp.y ?? lp.centerY) + (lp.height || 40)) + pad;
    const armW = 10;

    el('path', {
      d: `M ${bx + armW} ${top} L ${bx} ${top} L ${bx} ${bot} L ${bx + armW} ${bot}`,
      fill: 'none', stroke: '#f59e0b', 'stroke-width': 2,
      style: 'pointer-events:none;'
    }, svg);

    const midBracketY = (top + bot) / 2;
    const tryLabel = el('text', {
      x: bx - 4, y: midBracketY + 4,
      'text-anchor': 'end',
      'font-family': 'monospace', 'font-size': '11',
      fill: '#f59e0b', style: 'pointer-events:none;'
    }, svg);
    tryLabel.textContent = 'try';

    const errM = tryNode.meta?.match(/err=(-?\d+)/);
    const errId = errM ? parseInt(errM[1], 10) : null;
    if (errId != null && !hidden.has(errId)) {
      const ep = positions.get(errId);
      if (ep) {
        const ex = ep.centerX + (ep.width || 120) / 2;
        const ey = ep.centerY;
        const cpX = bx - 40;
        el('path', {
          d: `M ${bx} ${midBracketY} C ${cpX} ${midBracketY} ${cpX} ${ey} ${ex} ${ey}`,
          fill: 'none', stroke: '#f59e0b', 'stroke-width': 1.5,
          'stroke-dasharray': '5 3', style: 'pointer-events:none;'
        }, svg);
      }
    }
  }
}

// ─── Main render ──────────────────────────────────────────────────────────────
function renderGraph(graph) {
  currentGraph = graph;
  svg.textContent = '';
  clearErrorNodes();

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

  // Reposition err handler nodes to the LEFT of the main column
  for (const tryNode of graph.nodes.filter(n => n.meta?.includes('try-block') && n._virtual)) {
    const m = tryNode.meta?.match(/try-body=\[([^\]]*)\]/);
    if (!m) continue;
    const bodyIds = m[1].split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
    const bodyYs  = bodyIds.map(id => positions.get(id)?.centerY).filter(v => v != null);
    if (!bodyYs.length) continue;
    const midY   = (Math.min(...bodyYs) + Math.max(...bodyYs)) / 2;
    const errM   = tryNode.meta?.match(/err=(-?\d+)/);
    const errId  = errM ? parseInt(errM[1], 10) : null;
    if (errId == null) continue;
    const errHandler = graph.nodes.find(n => n.id === errId);
    if (!errHandler) continue;

    // Derive main column X from first body node
    const firstBodyPos = positions.get(bodyIds[0]);
    const mainCX = firstBodyPos?.centerX ?? 500;
    const errCX  = mainCX - currentXSTEP * 2.2;

    const ep = positions.get(errHandler.id);
    if (ep) { ep.centerX = ep.x = errCX; ep.centerY = ep.y = midY; }

    // Walk forward from err handler and reposition body nodes
    const visited = new Set([errHandler.id]);
    const queue   = [errHandler.id];
    let errY      = midY + currentXSTEP * 1.2;
    while (queue.length) {
      const cur = queue.shift();
      for (const e of graph.edges.filter(e2 => e2.from === cur)) {
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        queue.push(e.to);
        const bp = positions.get(e.to);
        if (bp) { bp.centerX = bp.x = errCX; bp.centerY = bp.y = errY; errY += currentXSTEP * 1.2; }
      }
    }
  }

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

  // Try brackets drawn LAST so they're always on top of block backgrounds and edges
  renderTryBrackets(graph, positions, hidden);

  // Re-draw error badge if one was set — svg.textContent='' clears it each render
  if (_errorNodeId != null) _drawErrorBadge(_errorNodeId);

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

// ── Error node highlighting ────────────────────────────────────────────────────
const ERROR_BADGE_CLASS = 'ivx-error-badge';

function clearErrorNodes() {
  _errorNodeId = null;
  svg.querySelectorAll('.' + ERROR_BADGE_CLASS).forEach(el => el.remove());
}

function _drawErrorBadge(nodeId) {
  svg.querySelectorAll('.' + ERROR_BADGE_CLASS).forEach(el => el.remove());
  if (nodeId == null) return;
  const pos = currentPositions.get(nodeId);
  if (!pos || !pos.width) return; // positions not yet populated

  const bx = (pos.x ?? pos.centerX) + (pos.width  ?? 40) - 4;
  const by = (pos.y ?? pos.centerY - (pos.height ?? 30) / 2) - 4;
  const r  = 10;

  const g = el('g', { class: ERROR_BADGE_CLASS }, svg);
  el('circle', { cx: bx, cy: by, r, fill: '#ef4444', stroke: '#fca5a5', 'stroke-width': 1.5 }, g);
  const t = el('text', {
    x: bx, y: by + 4,
    'text-anchor': 'middle',
    'font-family': 'system-ui',
    'font-size': '12',
    'font-weight': 'bold',
    fill: 'white',
    style: 'pointer-events:none;'
  }, g);
  t.textContent = '!';
}

function flashErrorNode(nodeId) {
  _errorNodeId = nodeId;
  _drawErrorBadge(nodeId);
  if (nodeId == null) return;
  const pos = currentPositions.get(nodeId);
  if (!pos) return;
  const cx = pos.centerX ?? ((pos.x ?? 0) + (pos.width ?? 40) / 2);
  const cy = pos.centerY ?? ((pos.y ?? 0) + (pos.height ?? 30) / 2);
  viewBox.x = cx - viewBox.width  / 2;
  viewBox.y = cy - viewBox.height / 2;
  applyVB();
  renderMinimap();
}

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
    // Clear any stale drop target from a previous drag
    _dropHighlightFrom = null;
    _dropHighlightTo   = null;
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
    _highlightDropEdge(draggedId, e, r);
    renderGraph(currentGraph);
    _drawDropHighlight();
    return;
  }
  if (!isPanning) return;
  if (!panMoved && Math.hypot(e.clientX-panStart.x,e.clientY-panStart.y)>3) { panMoved=true; activeEditCancel?.(); }
  pan((e.clientX-panStart.x)*viewBox.width/r.width, (e.clientY-panStart.y)*viewBox.height/r.height);
  panStart={x:e.clientX,y:e.clientY};
});

window.addEventListener('mouseup', e => {
  if (isPanning && panMoved) cancelNextClick=true;
  isPanning=false; svg.classList.remove('panning');

  if (isDragging && draggedId !== null) {
    cancelNextClick = true;
    const dropped = _tryDropNodeOnEdge(draggedId, e);
    if (!dropped) {
      _dropHighlightFrom = null;
      _dropHighlightTo   = null;
      dragOffsets.delete(draggedId);
      renderGraph(currentGraph);
    }
  }

  if (isBlockDragging) cancelNextClick=true;
  draggedId=null; isDragging=false;
  draggedBlockKey=null; isBlockDragging=false;
});

let _dropHighlightFrom = null, _dropHighlightTo = null;

function _highlightDropEdge(nodeId, mouseEvent, svgRect) {
  const r = svgRect ?? svg.getBoundingClientRect();
  const threshold = 20; // screen pixels

  let bestPath = null, bestDistSq = threshold * threshold;
  for (const path of svg.querySelectorAll('path[data-edge-from]')) {
    const fromId = parseInt(path.getAttribute('data-edge-from'), 10);
    const toId   = parseInt(path.getAttribute('data-edge-to'), 10);
    if (fromId === nodeId || toId === nodeId) continue;
    const len   = path.getTotalLength();
    const steps = Math.min(30, Math.ceil(len / 10));
    for (let i = 0; i <= steps; i++) {
      const pt  = path.getPointAtLength((i / steps) * len);
      const scx = r.left + (pt.x - viewBox.x) / viewBox.width  * r.width;
      const scy = r.top  + (pt.y - viewBox.y) / viewBox.height * r.height;
      const dSq = (scx - mouseEvent.clientX) ** 2 + (scy - mouseEvent.clientY) ** 2;
      if (dSq < bestDistSq) { bestDistSq = dSq; bestPath = path; }
    }
  }
  _dropHighlightFrom = bestPath ? parseInt(bestPath.getAttribute('data-edge-from'), 10) : null;
  _dropHighlightTo   = bestPath ? parseInt(bestPath.getAttribute('data-edge-to'),   10) : null;
}

function _drawDropHighlight() {
  svg.querySelectorAll('.ivx-drop-highlight').forEach(el => el.remove());
  if (_dropHighlightFrom == null || _dropHighlightTo == null) return;
  const path = svg.querySelector(
    `path[data-edge-from="${_dropHighlightFrom}"][data-edge-to="${_dropHighlightTo}"]`
  );
  if (!path) return;
  const overlay = path.cloneNode();
  overlay.setAttribute('stroke', '#f59e0b');
  overlay.setAttribute('stroke-width', '4');
  overlay.setAttribute('opacity', '0.7');
  overlay.classList.add('ivx-drop-highlight');
  overlay.style.pointerEvents = 'none';
  svg.appendChild(overlay);
}

function _tryDropNodeOnEdge(nodeId, mouseEvent) {
  if (!currentGraph || !srcEl) return false;
  const node = currentGraph.nodes.find(n => n.id === nodeId);
  if (!node) return false;

  const hasBody = currentGraph.nodes.some(n =>
    n.meta?.includes(`fun-body-of=${nodeId}`) ||
    n.meta?.includes(`wait-body-of=${nodeId}`) ||
    n.meta?.includes(`try-body-of=${nodeId}`)
  );
  if (hasBody) { _clearDropState(); return false; }

  // Block openers that are NOT yet supported for dragging (all except 'if')
  const unsupported = new Set(['loop','for','fun','class','wait','try','fork']);
  const firstWord = node.text?.trim().split(/\s+/)[0] ?? '';
  if (unsupported.has(firstWord)) { _clearDropState(); return false; }

  const fromId = _dropHighlightFrom;
  const toId   = _dropHighlightTo;
  if (fromId == null || toId == null) { _clearDropState(); return false; }

  _moveNodeToEdgeInSource(node, fromId, toId);
  return true;
}

function _clearDropState() {
  _dropHighlightFrom = null;
  _dropHighlightTo   = null;
  dragOffsets.clear();
  if (currentGraph) renderGraph(currentGraph);
}

// ── Extract the full source span of an if block ───────────────────────────────
// Returns { ifLines, afterLines } where:
//   ifLines   = all lines belonging to the if block (if + true body + else + else body)
//   afterLines = lines that follow the block and should stay in place
function _extractIfBlock(lines, startLine) {
  const ifRaw    = lines[startLine] ?? '';
  const ifIndent = ifRaw.length - ifRaw.trimStart().length;
  const result   = [ifRaw]; // start with the if line itself
  let i = startLine + 1;

  // Collect true branch body
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { result.push(l); i++; continue; }
    const ind = l.length - l.trimStart().length;
    if (ind <= ifIndent) break;
    result.push(l); i++;
  }

  // Collect else branch if present (at same indent, starts with 'else')
  if (i < lines.length) {
    const l = lines[i];
    const trimmed = l.trimStart();
    if (l.length - trimmed.length === ifIndent && trimmed.startsWith('else')) {
      result.push(l); i++;
      // Collect else body
      while (i < lines.length) {
        const l2 = lines[i];
        if (!l2.trim()) { result.push(l2); i++; continue; }
        const ind = l2.length - l2.trimStart().length;
        if (ind <= ifIndent) break;
        result.push(l2); i++;
      }
    }
  }

  return { blockLines: result, blockEnd: i };
}

// ── Free the else branch to the main flow ─────────────────────────────────────
// Given blockLines (the full if block), separate:
//   movedLines   = if + true body (to insert at target)
//   freedLines   = else body promoted to if's indent (to leave behind)
function _splitIfBlock(blockLines, ifIndent) {
  const movedLines  = [];
  const freedLines  = [];
  let inElse = false;

  for (const l of blockLines) {
    if (!l.trim()) { (inElse ? freedLines : movedLines).push(l); continue; }
    const ind     = l.length - l.trimStart().length;
    const trimmed = l.trimStart();

    if (!inElse && ind === ifIndent && trimmed.startsWith('else')) {
      // Found the else line — switch to collecting freed lines
      // Strip "else" keyword and promote children to if's indent
      inElse = true;
      // If inline else: "else say x" → "say x" at ifIndent
      const afterElse = trimmed.slice(trimmed.startsWith('else ') ? 5 : 4).trimStart();
      if (afterElse) freedLines.push(' '.repeat(ifIndent) + afterElse);
      continue;
    }

    if (inElse) {
      // Else body — dedent to ifIndent
      const dedent = ind - ifIndent;
      freedLines.push(dedent > 0 ? l.slice(dedent) : l);
    } else {
      movedLines.push(l);
    }
  }

  return { movedLines, freedLines };
}

function _moveNodeToEdgeInSource(node, fromEdgeNodeId, toEdgeNodeId) {
  if (!currentGraph || !srcEl) return;
  const fromNode = currentGraph.nodes.find(n => n.id === fromEdgeNodeId);
  const toNode   = currentGraph.nodes.find(n => n.id === toEdgeNodeId);
  if (!fromNode || !toNode) return;

  const isImplicit = n => n.meta?.includes('implicit start') || n.meta?.includes('implicit end');
  const lines = srcEl.value.split('\n');

  const prepToOrig = [];
  lines.forEach((raw, idx) => {
    preprocessControlFlowSyntax(raw).split('\n').forEach(() => prepToOrig.push(idx));
  });
  const toOrigIdx = pl => (pl < 0 ? -1 : pl >= prepToOrig.length ? lines.length - 1 : prepToOrig[pl]);

  const nodeOrigLine = isImplicit(node)     ? -1           : toOrigIdx(node.line);
  const fromOrigIdx  = isImplicit(fromNode) ? -1           : toOrigIdx(fromNode.line);
  const toOrigIndex  = isImplicit(toNode)   ? lines.length : toOrigIdx(toNode.line);

  if (nodeOrigLine < 0 || nodeOrigLine >= lines.length) return;

  const rawLine     = lines[nodeOrigLine] ?? '';
  const rawTrimmed  = rawLine.trimStart();
  const nodeIndent  = rawLine.length - rawTrimmed.length;
  const isIfNode    = rawTrimmed.startsWith('if ') || rawTrimmed === 'if';

  // ── Detect if this is the no-edge of an if Decision ─────────────────────
  // If so, insertion means creating/extending an else branch — not inserting
  // at the raw position between fromNode and toNode line numbers.
  const isIfJoin  = n => n.kind === 'Connector' && n.meta?.includes('if-join');
  const edgeLabel = currentGraph.edges.find(e => e.from === fromNode.id && e.to === toNode.id)?.label;
  const isNoEdge  = fromNode.kind === 'Decision' && (edgeLabel === 'no' || isIfJoin(toNode));

  // ── Compute insert position BEFORE modifying source ───────────────────────
  let spliceAt = fromOrigIdx + 1;
  let indentSpaces = 0;
  let insertAsElse = false;

  if (isNoEdge) {
    // Find the if line and scan forward to end of true branch body
    const ifIndent = (lines[fromOrigIdx] ?? '').length - (lines[fromOrigIdx] ?? '').trimStart().length;
    let i = fromOrigIdx + 1;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const ind = l.length - l.trimStart().length;
      if (ind <= ifIndent) break;
      i++;
    }
    // i now points to the line after the true body (where else would go)
    // Check if there's already an else there
    const nextRaw = lines[i] ?? '';
    const nextTrimmed = nextRaw.trimStart();
    const hasElse = nextTrimmed.startsWith('else') &&
                    (nextRaw.length - nextTrimmed.length) === ifIndent;
    spliceAt     = i;
    indentSpaces = ifIndent;
    insertAsElse = true;
    // If else already exists, insert inside it (after the else line)
    if (hasElse) {
      // Insert as an additional line inside the existing else block
      // Find end of else body
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) { j++; continue; }
        if ((l.length - l.trimStart().length) <= ifIndent) break;
        j++;
      }
      spliceAt     = j;
      indentSpaces = ifIndent + 2;
      insertAsElse = false;
    }
  } else if (isImplicit(fromNode)) {
    spliceAt = 0; indentSpaces = 0;
  } else if (isImplicit(toNode)) {
    indentSpaces = (lines[fromOrigIdx] ?? '').length - (lines[fromOrigIdx] ?? '').trimStart().length;
    spliceAt = lines.length;
  } else if (toOrigIndex > fromOrigIdx + 1) {
    indentSpaces = (lines[toOrigIndex] ?? '').length - (lines[toOrigIndex] ?? '').trimStart().length;
    spliceAt = toOrigIndex;
  } else {
    indentSpaces = (lines[toOrigIndex] ?? '').length - (lines[toOrigIndex] ?? '').trimStart().length;
    spliceAt = fromOrigIdx + 1;
  }

  const indentDelta = indentSpaces - nodeIndent;

  if (isIfNode) {
    // ── If block: extract block, free else branch, move if+true to target ──
    const { blockLines, blockEnd } = _extractIfBlock(lines, nodeOrigLine);
    const { movedLines, freedLines } = _splitIfBlock(blockLines, nodeIndent);

    // Re-indent moved lines to match target position
    const reindented = movedLines.map(l => {
      if (!l.trim()) return l;
      return ' '.repeat(Math.max(0, (l.length - l.trimStart().length) + indentDelta)) + l.trimStart();
    });

    // Remove the entire block from source
    const removeCount = blockEnd - nodeOrigLine;
    lines.splice(nodeOrigLine, removeCount);
    if (nodeOrigLine < spliceAt) spliceAt = Math.max(0, spliceAt - removeCount);

    // Insert freed else-body lines in place (they stay at original position)
    lines.splice(nodeOrigLine, 0, ...freedLines);
    if (nodeOrigLine < spliceAt) spliceAt += freedLines.length;

    // Insert moved if-block at target
    lines.splice(spliceAt, 0, ...reindented);

  } else {
    // ── Single-line node (existing logic) ─────────────────────────────────
    let rawContent = rawTrimmed;
    if (typeof IN_KEYS !== 'undefined') {
      const firstToken = rawContent.split(/\s+/)[0];
      if (IN_KEYS.has(firstToken)) rawContent = rawContent.slice(firstToken.length).trimStart();
    }
    if (typeof OUTGOING_KEYWORDS !== 'undefined') {
      for (const kw of OUTGOING_KEYWORDS) {
        if (rawContent.endsWith(' ' + kw)) { rawContent = rawContent.slice(0, -(kw.length + 1)).trimEnd(); break; }
      }
    }

    const newLine = insertAsElse
      ? ' '.repeat(indentSpaces) + 'else ' + rawContent
      : ' '.repeat(indentSpaces) + rawContent;
    const removedIndent  = nodeIndent;
    const startsWithElse = rawTrimmed.startsWith('else');

    lines.splice(nodeOrigLine, 1);
    if (nodeOrigLine < spliceAt) spliceAt = Math.max(0, spliceAt - 1);

    // Handle children left behind
    const hasChildren = (() => {
      for (let i = nodeOrigLine; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) continue;
        return (l.length - l.trimStart().length) > removedIndent;
      }
      return false;
    })();

    if (hasChildren) {
      if (startsWithElse) {
        const children = [];
        for (let i = nodeOrigLine; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) continue;
          if ((l.length - l.trimStart().length) <= removedIndent) break;
          children.push(l.trimStart());
        }
        if (children.length === 1) {
          lines.splice(nodeOrigLine, 0, ' '.repeat(removedIndent) + 'else ' + children[0]);
          if (nodeOrigLine < spliceAt) spliceAt++;
          const childIdx = nodeOrigLine + 1;
          if (childIdx < lines.length) {
            lines.splice(childIdx, 1);
            if (childIdx < spliceAt) spliceAt--;
          }
        } else {
          lines.splice(nodeOrigLine, 0, ' '.repeat(removedIndent) + 'else');
          if (nodeOrigLine < spliceAt) spliceAt++;
        }
      } else {
        let ci = nodeOrigLine;
        while (ci < lines.length) {
          const l = lines[ci];
          if (!l.trim()) { ci++; continue; }
          const ind = l.length - l.trimStart().length;
          if (ind <= removedIndent) break;
          lines[ci] = l.slice(ind - removedIndent);
          ci++;
        }
      }
    }

    lines.splice(spliceAt, 0, newLine);
  }

  const newCode = lines.join('\n');
  _dropHighlightFrom = null;
  _dropHighlightTo   = null;
  dragOffsets.clear();
  if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode });
}

function renderMinimap() {
  miniSvg.textContent='';
  if (!currentGraph) return;
  miniSvg.setAttribute('viewBox',`${graphBounds.x} ${graphBounds.y} ${graphBounds.width} ${graphBounds.height}`);
  for (const [id, pos] of nodePositions) {
    if (!pos.width) continue;
    const node = currentGraph.nodes.find(n => n.id === id);
    const kind = node?.kind;
    const isFun = kind === 'Process' && /^fun(\s|$)/.test(node?.text || '');
    const fill = NODE_FILL[kind] || (isFun ? '#92700a' : '#333');
    if (kind === 'Connector' || kind === 'NextConnector') {
      const cx = pos.x + pos.width / 2;
      const cy = pos.y + pos.height / 2;
      const r = Math.max(pos.width, pos.height) * 1.5;
      const circleFill = kind === 'Connector' ? '#bbb' : '#00bfff';
      el('circle',{cx,cy,r,fill:circleFill,stroke:'none','fill-opacity':'0.9'},miniSvg);
    } else {
      el('rect',{x:pos.x,y:pos.y,width:pos.width,height:pos.height,fill,stroke:'none','fill-opacity':'0.8'},miniSvg);
    }
  }
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
    { kind:'Output',    label:'print — Output', key:'print' },
    { kind:'Speak',     label:'say — Speak', key:'say' },
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

  const newCode = originalLines.join('\n');
  if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode });

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


if (window.IVX && IVX.bus) {
  IVX.bus.on('ast_parsed', ({ graph }) => {
    dragOffsets.clear();
    blockOffsets.clear();
    isFirstRender = !currentGraph;
    renderGraph(graph);
  });
}

window.addEventListener('load', () => { if(typeof _ivxInit==='function') _ivxInit(); });

