// ivx-terminal.js — IVX Terminal Panel
// Run button, output/input/error display, resizer, minimize
// Depends on: ivx-core.js, ivx-runtime.js, ivx-render.js, ivx-editor.js
// Licensed under the Apache License, Version 2.0
// Copyright 2026 IVX

'use strict';

// ── Terminal ──────────────────────────────────────────────────────────────────
const termMsgs   = document.getElementById('term-msgs');
const termRun    = document.getElementById('term-run');
const termClear  = document.getElementById('term-clear');
const termRes    = document.getElementById('term-resizer');

// ── Terminal message helpers ──────────────────────────────────────────────────
function termAppend(text, cls) {
  const el = document.createElement('div');
  el.className = 'term-msg ' + cls;
  el.textContent = text;
  termMsgs.appendChild(el);
  termMsgs.scrollTop = termMsgs.scrollHeight;
  return el;
}

function termInfo(text)   { termAppend(text, 'info');   }
function termOutput(text) { termAppend(text, 'output'); }
function termError(text)  { termAppend(text, 'error');  }

// Show an error with line number — clicking jumps to that line in the editor
function termErrorLine(message, lineNum) {
  const el = document.createElement('div');
  el.className = 'term-msg error';
  if (lineNum != null && lineNum > 0) {
    el.innerHTML = `<span class="term-err-line">Line ${lineNum}</span><span class="term-err-msg"> — ${escHtml(message)}</span>`;
    el.style.cursor = 'pointer';
    el.title = 'Click to jump to line ' + lineNum;
    el.addEventListener('click', () => {
      const src = document.getElementById('src');
      if (!src) return;
      const lines = src.value.split('\n');
      let pos = 0;
      for (let i = 0; i < Math.min(lineNum - 1, lines.length); i++) pos += lines[i].length + 1;
      src.focus();
      src.setSelectionRange(pos, pos + (lines[lineNum - 1]?.length ?? 0));
      // Scroll the line into view
      const lineH = src.scrollHeight / (lines.length || 1);
      src.scrollTop = Math.max(0, (lineNum - 3) * lineH);
    });
  } else {
    el.textContent = 'Error: ' + message;
  }
  termMsgs.appendChild(el);
  termMsgs.scrollTop = termMsgs.scrollHeight;
}

// _escHtml: use the shared escHtml() defined in ivx-editor.js

let _cancelTermInput = null;

// ── Inline input — returns a Promise that resolves when user hits Enter ───────
function termInput(varName) {
  return new Promise((resolve, reject) => {
    const row = document.createElement('div');
    row.className = 'term-input-row';

    const label = document.createElement('span');
    label.className = 'term-input-label';
    label.textContent = varName + ' ›';

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'term-input-field';
    field.placeholder = 'type and press Enter…';

    row.appendChild(label);
    row.appendChild(field);
    termMsgs.appendChild(row);
    termMsgs.scrollTop = termMsgs.scrollHeight;
    field.focus();

    _cancelTermInput = () => {
      field.disabled = true;
      field.style.display = 'none';
      reject(new Error('Execution stopped by user'));
    };

    field.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      _cancelTermInput = null;
      const val = field.value;
      // Lock the input row and show sent bubble
      field.disabled = true;
      field.style.display = 'none';
      const sent = document.createElement('div');
      sent.className = 'term-input-sent';
      sent.textContent = val;
      row.appendChild(sent);
      termMsgs.scrollTop = termMsgs.scrollHeight;
      resolve(val);
    });
  });
}

// ── Run button ────────────────────────────────────────────────────────────────
let _running = false;
let _resumeBreakpoint = null; // module-level so the resume click can access it
let _currentInterp = null;
let _cancelWait = null;

window._ivxResumeBreakpoint = () => {
  if (_resumeBreakpoint) { _resumeBreakpoint(); _resumeBreakpoint = null; }
};

termRun.addEventListener('click', async () => {
  // If paused at a breakpoint, resume instead of starting a new run
  if (_running && _resumeBreakpoint) {
    window._ivxResumeBreakpoint();
    return;
  }
  if (_running) {
    if (_currentInterp) _currentInterp.abort();
    if (_cancelTermInput) { _cancelTermInput(); _cancelTermInput = null; }
    if (_cancelWait) { _cancelWait(); _cancelWait = null; }
    return;
  }
  _running = true;
  termRun.textContent = '⏹ Running';
  termRun.classList.add('running');
  termInfo('─── run started ───');

  // Build map: 0-based graph line → node ID
  // Decision nodes take priority so conditions highlight the diamond
  const lineToNodeId = new Map();
  if (currentGraph) {
    for (const n of currentGraph.nodes) {
      if (n.kind === 'Start' || n.kind === 'End' || n.kind === 'Function') continue;
      const existing = lineToNodeId.get(n.line);
      if (!existing || n.kind === 'Decision' || n.kind === 'Input' || n.kind === 'Output') {
        lineToNodeId.set(n.line, n.id);
      }
    }
  }

  // Record trace events during execution — play back after at human speed
  const recorded = [];
  const t0 = performance.now();

  let interpGlobals = null;
  let firstErrorFlagged = false;
  _resumeBreakpoint = null; // reset for this run
  if (typeof window._khClearErrors === 'function') window._khClearErrors();

  const flagErrorNode = (line, col, message) => {
    if (line != null && typeof window._khMarkError === 'function')
      window._khMarkError(line, col ?? 1, message ?? '');
    if (firstErrorFlagged || line == null || typeof flashErrorNode !== 'function') return;
    firstErrorFlagged = true;
    const nodeId = lineToNodeId.get(line - 1)
                ?? lineToNodeId.get(line)
                ?? lineToNodeId.get(line - 2);
    flashErrorNode(nodeId ?? null);
  };

  const interp = new Interpreter({
    onOutput: async (value) => {
      termOutput(ivxRepr(value));
    },
    onInput: async (varName) => {
      const raw = await termInput(varName);
      const num = Number(raw);
      return raw.trim() === '' ? null : isNaN(num) ? raw : num;
    },
    onError: (e) => {
      const line = e.ivxLine ?? e.line ?? null;
      const col  = e.col ?? null;
      termErrorLine(e.message ?? String(e), line ?? null);
      flagErrorNode(line, col, e.message ?? String(e));
    },
    onWait: (n) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, n * 100);
      _cancelWait = () => { clearTimeout(timer); reject(new Error('Execution stopped by user')); };
    }),
    onStep: async (srcLine) => {
      // srcLine is 1-based from AST; graph nodes are 0-based
      const nodeId = lineToNodeId.get(srcLine - 1);
      if (nodeId != null) {
        const last = recorded[recorded.length - 1];
        const n = currentGraph?.nodes.find(n => n.id === nodeId);
        const isDecision = n?.kind === 'Decision';
        if (!last || last.nodeId !== nodeId || isDecision) {
          recorded.push({ nodeId, ts: performance.now() - t0 });
        }

        // If this node has a breakpoint, pause execution here
        if (typeof breakpoints !== 'undefined' && breakpoints.has(nodeId)) {
          if (typeof highlightNode === 'function') highlightNode(nodeId, null);
          termInfo(`⏸ paused at breakpoint — click ▶ Run to continue`);
          termRun.textContent = '▶ Resume';
          await new Promise(resolve => { _resumeBreakpoint = resolve; });
          termRun.textContent = '⏹ Running';
          termInfo(`▶ resumed`);
        }
      }
    },
  });

  _currentInterp = interp;

  try {
    await interp.run(srcEl.value, { ignoreTypeErrors: true });
    interpGlobals = interp.globals;
  } catch(e) {
    const line = e.ivxLine ?? e.line ?? null;
    termErrorLine(e.message ?? String(e), line ?? null);
    flagErrorNode(line);
  }

  termInfo('─── run finished ───');
  termRun.textContent = '▶ Run';
  termRun.classList.remove('running');
  _running = false;
  _currentInterp = null;

  // ── Deploy wait blocks to Apps Script ──────────────────────────────────────
  try {
    const parsed = parse(srcEl.value);
    const waitBlocks = AppsScriptTranspiler.extractWaitBlocks(parsed.ast);
    if (waitBlocks.length > 0 && driveToken) {
      termInfo(`⏳ Deploying ${waitBlocks.length} trigger${waitBlocks.length > 1 ? 's' : ''} to Google Apps Script…`);
      try {
        const { scriptId, triggerCount, firstDeploy } = await AppsScriptTranspiler.deploy(
          waitBlocks, interpGlobals, driveToken
        );
        const recurring = waitBlocks.filter(b => b.recurring).length;
        const oneshot   = waitBlocks.filter(b => !b.recurring).length;
        const parts = [];
        if (oneshot)   parts.push(`${oneshot} one-shot`);
        if (recurring) parts.push(`${recurring} recurring`);
        if (firstDeploy) {
          termInfo(`✓ ${parts.join(', ')} trigger${triggerCount > 1 ? 's' : ''} deployed — open Apps Script and run ivxSetupTriggers() once to activate`);
        } else {
          termInfo(`✓ ${parts.join(', ')} trigger${triggerCount > 1 ? 's' : ''} updated and active`);
        }
      } catch(e) {
        termError(`Apps Script deploy failed: ${e.message}`);
      }
    } else if (waitBlocks.length > 0 && !driveToken) {
      termInfo(`ℹ Sign in to Google to deploy ${waitBlocks.length} wait trigger${waitBlocks.length > 1 ? 's' : ''}`);
    } else if (waitBlocks.length === 0) {
      // Debug: check if parse found any WaitBlock nodes
      const allTypes = parsed.ast?.body?.map(n => n.type) ?? [];
      if (srcEl.value.includes('wait ')) {
        termInfo(`⚠ wait block detected in source but not parsed — node types: ${allTypes.join(', ')}`);
      }
    }
  } catch(e) {
    termError(`Apps Script setup error: ${e.message}`);
    console.error('Apps Script deploy error:', e);
  }

  // Hand recorded trace to the playback system
  // Normalize timestamps to 300ms per step so playback is human-readable
  if (recorded.length > 0) {
    const STEP_MS = 300;
    const normalized = recorded.map((ev, i) => ({ nodeId: ev.nodeId, ts: i * STEP_MS }));
    isVideoPlaying = true;
    updateVideoButton();
    startTrace(normalized);
  }
});

// ── Clear button ──────────────────────────────────────────────────────────────
termClear.addEventListener('click', () => {
  termMsgs.innerHTML = '';
  if (typeof clearErrorNodes === 'function') clearErrorNodes();
  if (typeof flashErrorNode === 'function') flashErrorNode(null); // clear _errorNodeId
});

// ── Resizer drag ──────────────────────────────────────────────────────────────
(function() {
  let startY, startTermH, dragging = false;

  termRes.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startTermH = document.getElementById('term').getBoundingClientRect().height;
    termRes.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH = Math.max(80, Math.min(startTermH + delta, window.innerHeight * 0.6));
    document.getElementById('ep').style.gridTemplateRows = `1fr 6px ${newH}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    termRes.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
})();

// ── Terminal minimize / restore ───────────────────────────────────────────────
(function() {
  const termEl      = document.getElementById('term');
  const termMinBtn  = document.getElementById('term-minimize');
  const ep          = document.getElementById('ep');
  const COLLAPSED_H = 28; // just the header bar
  let collapsed     = false;
  let savedRows     = '';  // remember last grid height before collapsing

  termMinBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    if (collapsed) {
      savedRows = document.getElementById("ep-body").style.gridTemplateRows || '1fr 6px 200px';
      document.getElementById("ep-body").style.gridTemplateRows = `1fr 6px ${COLLAPSED_H}px`;
      termEl.classList.add('collapsed');
      termMinBtn.textContent    = '▲';
      termMinBtn.title          = 'Restore terminal';
    } else {
      document.getElementById("ep-body").style.gridTemplateRows = savedRows;
      termEl.classList.remove('collapsed');
      termMinBtn.textContent    = '—';
      termMinBtn.title          = 'Minimize terminal';
    }
  });
})();
