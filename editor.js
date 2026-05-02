// ivx-editor.js — IVX Editor UI
// Source editor DOM refs, starter program, render scheduling, _ivxInit,
// export (SVG/PNG/JSON), syntax highlighting, step controls.
// Depends on: ivx-render.js (renderGraph, graphBounds, svg, currentGraph,
//             nodePositions, lastRenderedBlocks, isFirstRender, currentGraph,
//             highlightNode, startTrace, stopTrace, isVideoPlaying,
//             updateVideoButton, speedSel),
//             ivx-parser.js (parseivx)
// PROPRIETARY AND CONFIDENTIAL
// Copyright 2026 IVX. All rights reserved.

'use strict';

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

let _parseTimer;
IVX.bus.on('src_changed', ({ source }) => {
  clearTimeout(_parseTimer);
  // Color the text IMMEDIATELY so it's never invisible
  updateHighlight(); 

  _parseTimer = setTimeout(() => {
    try {
      const graph = parseivx(source);
      // Run Phase A Diagnostics on a delay
      const diagnostics = IVXDiagnostics.getDiagnostics(source);
      updateHighlight(diagnostics); // Add squiggles after pause
      
      IVX.bus.emit('ast_parsed', { 
        graph, 
        errors: graph.validationErrors || [] // Only show structural parser errors in header
      });
    } catch(err) {
      IVX.bus.emit('ast_error', { message: err.message });
    }
  }, 150);
});

IVX.bus.on('ast_parsed', ({ graph, errors }) => {
  if (errors.length) {
    errEl.innerHTML = errors.map((e, i) => `<div>${e}</div>`).join('') + (errors.length > 1 ? `<div style=\"color:#888;font-size:10px;\">(${errors.length} errors)</div>` : '');
    errEl.className = '';
  } else {
    errEl.textContent = `✓ ${graph.nodes.length} nodes, ${graph.edges.length} edges`;
    errEl.className = 'ok';
  }
  _walkOrder = getWalkOrder(graph);
  _walkIdx = 0;

  if (_pendingInsertEditLine >= 0) {
    const targetLine = _pendingInsertEditLine;
    _pendingInsertEditLine = -1;
    const inserted = graph.nodes.find(n => n.line === targetLine);
    if (inserted && typeof startNodeEditByLine === 'function') {
      startNodeEditByLine({ line: targetLine, text: inserted.text || '' });
    }
  }
});

IVX.bus.on('ast_error', ({ message }) => {
  errEl.textContent = 'Parse error: ' + message;
  errEl.className = '';
});

IVX.bus.on('code_update_requested', ({ newCode, selectionStart, selectionEnd }) => {
  srcEl.value = newCode;
  if (selectionStart != null) srcEl.selectionStart = selectionStart;
  if (selectionEnd != null) srcEl.selectionEnd = selectionEnd;
  const diagnostics = IVXDiagnostics.getDiagnostics(newCode);
  updateHighlight(diagnostics);
  IVX.bus.emit('src_changed', { source: newCode });
});

srcEl.addEventListener('input', () => {
  IVX.bus.emit('src_changed', { source: srcEl.value });
});

srcEl.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = srcEl.selectionStart, end = srcEl.selectionEnd;
    const newCode = srcEl.value.slice(0, s) + '  ' + srcEl.value.slice(end);
    srcEl.value = newCode;
    srcEl.selectionStart = srcEl.selectionEnd = s + 2;
    updateHighlight();
    IVX.bus.emit('src_changed', { source: newCode });
  }
});

// Clear button — help menu and data-ins handled by ivx-demos.js
document.getElementById('clr').addEventListener('click', function handleClearClick() {
  srcEl.value = '';
  srcEl.focus();
  updateHighlight();
  IVX.bus.emit('src_changed', { source: '' });
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
  IVX.bus.emit('src_changed', { source: srcEl.value });
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
const _KW_NODE     = new Set(['if','fork','loop','dot','con','take','say','print','give','fun','class','init','end','from','make','note','for','in','wait','download','del','ask','post','use','key','sheets','email','by','try','err']);
const _KW_FLOW     = new Set(['so','then','else']);
const _KW_OUTGOING = new Set(['prev','next']);
const _KW_LOGIC    = new Set(['not','and','or','same','is','yes','no','none']);

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

function highlightSource(src, diagnostics = []) {
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

  const errorLines = new Map();
  diagnostics.forEach(d => errorLines.set(d.line, d));

  return src.split('\n').map((line, i) => {
    const lineNum = i + 1;
    const html = highlightLine(line, allVars, allClasses);
    if (errorLines.has(lineNum)) {
      const d = errorLines.get(lineNum);
      const cls = d.severity === 'warning' ? 'kh-warn-squig' : 'kh-err-squig';
      return `<span class="${cls}" title="${d.message}">${html}</span>`;
    }
    return html;
  }).join('\n');
}

function updateHighlight(diagnostics = []) {
  const src   = srcEl.value;
  const lines = src.split('\n');
  const count = lines.length;

  // Update highlight layer
  hlEl.innerHTML = highlightSource(src, diagnostics) + '\n';

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

