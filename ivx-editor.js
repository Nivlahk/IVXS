// ivx-editor.js — IVX Editor UI
// Source textarea, syntax highlighting, line numbers, render scheduling
// Depends on: ivx-core.js, ivx-runtime.js, ivx-render.js
// Licensed under the Apache License, Version 2.0
// Copyright 2026 IVX

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
  const open = helpMenu.style.display !== 'none';
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
    // Close dropdown after inserting
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
