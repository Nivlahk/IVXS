// ── ivx_lens_ui.js ──────────────────────────────────────────────────────────
// The abstraction-lensing panel. This is the piece that was missing: phases
// 1-4 produced data, and nothing in the page consumed it, which is why
// index.html went untouched for four phases.
//
// ── Why this does NOT extend materializeToggle ──────────────────────────────
// The existing onZoningToggleChange path is one-way and DESTRUCTIVE: it
// overwrites the textarea with lowered text and unchecks the toggles, so the
// high-altitude form is gone and there is no way back. This panel never
// touches the source buffer. It renders a SEPARATE view driven by the source
// map, so switching altitude is a projection, not an edit -- which is the
// whole point of the map existing.
//
// Load order matters (classic scripts, no bundler):
//   core.js -> word_kh.js -> ivx_lower_contract.js -> ivx_altitude.js
//   -> ivx_lower.js -> ivx_lens_ui.js
//
// Degrades honestly: if the SEER engine functions are not on the page, the
// SOURCE and CF altitudes still work (they need only the lowerer) and FLAT
// reports what is missing rather than rendering an empty table.
'use strict';

;(function () {
  const ROOT = window;
  ROOT.IVX = ROOT.IVX || {};

  const $ = id => document.getElementById(id);

  // The engine lives as loose globals on the page (Soak_tester.html's script
  // block), not as a module. Probe rather than assume, so a page without it
  // gets a clear message instead of a ReferenceError.
  // `const X = ...` at the top level of a <script> creates a LEXICAL binding
  // in the global environment record -- it never becomes a window property.
  // The engine declares its capability constants that way, so ROOT.STACK_CAP_IDX
  // is undefined even though the constant exists. Indirect eval runs in
  // global scope and CAN see those bindings; function declarations do land on
  // window, so only the constants need this.
  //
  // Symptom when this was missing: abiPrologue received undefined and threw
  // "Cannot mix BigInt and other types" from the middle of the lowerer.
  function globalConst(name) {
    try {
      const geval = ROOT.eval;
      return geval(`typeof ${name} !== "undefined" ? ${name} : undefined`);
    } catch (_) { return undefined; }
  }

  function findEngine() {
    const need = ['stage2Allocate', 'compileCFSource', 'substituteSymbolicNames',
                  'simulateProgram', 'parseProgram'];
    const missing = need.filter(n => typeof ROOT[n] !== 'function');
    if (missing.length) return { ok: false, missing };

    const caps = {
      STACK_CAP_IDX: globalConst('STACK_CAP_IDX'),
      STACK_CAP_GEN: globalConst('STACK_CAP_GEN'),
      STACK_CAP_MAC: globalConst('STACK_CAP_MAC'),
      STACK_CAP_SIZE: globalConst('STACK_CAP_SIZE'),
    };
    // Report the gap rather than handing undefined to the ABI emitter.
    const capsMissing = Object.entries(caps).filter(([, v]) => v === undefined).map(([k]) => k);

    return {
      ok: true,
      stage2Allocate: ROOT.stage2Allocate,
      compileCFSource: ROOT.compileCFSource,
      substituteSymbolicNames: ROOT.substituteSymbolicNames,
      simulateProgram: ROOT.simulateProgram,
      parseProgram: ROOT.parseProgram,
      capsMissing,
      ...caps,
    };
  }

  const state = { altitude: 'source', hideSynthetic: true, last: null };

  function els() {
    return { panel: $('lens-panel'), body: $('lens-body'), status: $('lens-status') };
  }

  function setStatus(text, kind) {
    const { status } = els();
    if (!status) return;
    status.textContent = text || '';
    status.className = 'lens-status' + (kind ? ' lens-' + kind : '');
  }

  // ── Lower the current buffer ──────────────────────────────────────────────
  async function lowerCurrent() {
    const src = ($('src') || {}).value || '';
    if (!src.trim()) return { empty: true };

    const parse = (ROOT.IVX.wordParse) || ROOT.wordParse;
    if (typeof parse !== 'function') {
      return { error: 'word_kh.js is not loaded (no wordParse). Check the <script> order.' };
    }
    const Lower = ROOT.IVX.Lower;
    if (!Lower) return { error: 'ivx_lower.js is not loaded.' };

    const engine = findEngine();
    let ast;
    try { ast = parse(src); }
    catch (e) { return { error: 'parse: ' + e.message }; }

    let lowered;
    try {
      lowered = await Lower.lowerUAST(ast, {
        metaCF: false, capabilityDiscipline: false, regDepth: 64,
        imemBudget: (typeof ROOT.getImemBudget === 'function' ? ROOT.getImemBudget() : 16384),
        outputMode: 'liveout',
        // Only pass the engine when its capability constants are actually
        // readable -- the ABI prologue needs them, and a half-populated
        // engine object produced a BigInt TypeError from deep inside the
        // lowerer instead of a message anyone could act on.
        engine: (engine.ok && !engine.capsMissing.length) ? engine : undefined,
      });
    } catch (e) { return { error: 'lowering: ' + e.message }; }

    const needsStack = lowered.diagnostics.some(d => d.code === 'ABI_NEEDS_ENGINE');
    if (needsStack) {
      return { error: 'this program makes calls that need the stack-capability prologue, but '
        + (engine.ok
            ? 'the engine constants are not readable (' + engine.capsMissing.join(', ') + ')'
            : 'the SEER engine is not on the page (' + engine.missing.join(', ') + ')') };
    }

    return { src, lowered, engine };
  }

  // ── Compile through the real engine (FLAT altitude only) ─────────────────
  function compileForFlat(lowered, engine) {
    const liveOut = (lowered.outputs || []).map(o => o.name);
    // Third argument is the live-out set from the patched engine. On an
    // unpatched engine it is ignored, results read back as garbage, and the
    // caller is told rather than being shown wrong numbers.
    const patched = engine.stage2Allocate.length >= 3;
    const s2 = engine.stage2Allocate(lowered.text, false, liveOut);
    if (!s2.raw2Map) {
      return { error: 'this engine has no raw2Map -- FLAT needs Soak_tester.patched.html '
                    + '(see apply_patch.py).' };
    }
    const comp = engine.compileCFSource(s2.raw2, false, false);
    if (!comp.srcMap) {
      return { error: 'this engine has no srcMap -- FLAT needs Soak_tester.patched.html.' };
    }
    const flat = engine.substituteSymbolicNames(comp.text, s2.mapping);
    const items = engine.parseProgram(flat);
    return { s2, comp, flat, items, patched };
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderSource(A, lowered, srcLines) {
    const p = A.project(lowered, { altitude: A.ALTITUDE.SOURCE, sourceLines: srcLines });
    const t = el('table', 'lens-table');
    const head = el('tr');
    ['line', 'your code', 'kind', 'instr', ''].forEach(h => head.appendChild(el('th', null, h)));
    t.appendChild(head);
    for (const row of p.rows) {
      const tr = el('tr', 'lens-row');
      tr.appendChild(el('td', 'lens-num', row.srcLine === null ? '—' : String(row.srcLine)));
      tr.appendChild(el('td', 'lens-code', row.text));
      tr.appendChild(el('td', 'lens-kind', row.uastKind));
      tr.appendChild(el('td', 'lens-num', String(row.cost)));
      tr.appendChild(el('td', 'lens-note', row.diagnostics ? row.diagnostics.join(', ') : ''));
      t.appendChild(tr);
    }
    return { node: t, summary: `${p.rows.length} source construct(s), ${lowered.lines.length} CF lines` };
  }

  function renderCF(A, lowered) {
    const p = A.project(lowered, { altitude: A.ALTITUDE.CF, hideSynthetic: state.hideSynthetic });
    const t = el('table', 'lens-table');
    const head = el('tr');
    ['#', 'CF instruction', 'from', 'role'].forEach(h => head.appendChild(el('th', null, h)));
    t.appendChild(head);
    for (const row of p.rows) {
      const tr = el('tr', 'lens-row');
      tr.appendChild(el('td', 'lens-num', String(row.cfLine)));
      tr.appendChild(el('td', 'lens-code', row.text));
      tr.appendChild(el('td', 'lens-num',
        row.origin && row.origin.srcLine != null ? 'L' + row.origin.srcLine : '—'));
      tr.appendChild(el('td', 'lens-kind', row.origin ? row.origin.role : 'engine'));
      t.appendChild(tr);
    }
    return { node: t, summary: `${p.rows.length} shown, ${p.hidden} synthetic hidden` };
  }

  function renderFlat(A, lowered, engine) {
    const c = compileForFlat(lowered, engine);
    if (c.error) return { node: el('div', 'lens-note', c.error), summary: 'FLAT unavailable' };
    const p = A.projectFlat(lowered, {
      compiled: { items: c.items, srcMap: c.comp.srcMap, raw2Map: c.s2.raw2Map },
      hideSynthetic: state.hideSynthetic,
    });
    const t = el('table', 'lens-table');
    const head = el('tr');
    ['PC', 'bytes', 'instruction', 'cyc', 'from'].forEach(h => head.appendChild(el('th', null, h)));
    t.appendChild(head);
    for (const row of p.rows) {
      const tr = el('tr', 'lens-row' + (row.synthetic ? ' lens-synthetic' : ''));
      tr.appendChild(el('td', 'lens-num', String(row.pc)));
      tr.appendChild(el('td', 'lens-bytes', row.hex));
      tr.appendChild(el('td', 'lens-code', row.mnem + ' ' + (row.ops || []).join(', ')));
      tr.appendChild(el('td', 'lens-num', row.cycles == null ? '' : String(row.cycles)));
      tr.appendChild(el('td', 'lens-num',
        row.origin && row.origin.srcLine != null ? 'L' + row.origin.srcLine : 'engine'));
      t.appendChild(tr);
    }
    const tot = p.totals;
    return {
      node: t,
      summary: `${tot.instructions} instructions, ${tot.bytes} bytes, ${tot.cycles} cycles `
             + `— ${tot.traced} traced to source, ${tot.untraced} engine-synthesized`,
    };
  }

  // ── Refresh ───────────────────────────────────────────────────────────────
  let running = false;
  async function refresh() {
    const { body } = els();
    if (!body || running) return;
    running = true;
    try {
      setStatus('lowering…');
      const r = await lowerCurrent();
      body.innerHTML = '';
      if (r.empty) { setStatus('editor is empty'); return; }
      if (r.error) { body.appendChild(el('div', 'lens-note', r.error)); setStatus('error', 'err'); return; }

      state.last = r;
      const A = ROOT.IVX.Altitude;
      const refusals = r.lowered.diagnostics.filter(d => d.severity === 'refuse');

      let out;
      if (state.altitude === 'source') out = renderSource(A, r.lowered, r.src.split('\n'));
      else if (state.altitude === 'cf') out = renderCF(A, r.lowered);
      else if (!r.engine.ok) {
        out = { node: el('div', 'lens-note',
          'FLAT needs the SEER engine on the page. Missing: ' + r.engine.missing.join(', ')),
          summary: 'FLAT unavailable' };
      } else out = renderFlat(A, r.lowered, r.engine);

      body.appendChild(out.node);
      if (refusals.length) {
        const d = el('div', 'lens-refusals');
        d.appendChild(el('div', 'lens-note',
          `${refusals.length} construct(s) not lowered — shown as nop:`));
        for (const x of refusals.slice(0, 8)) {
          d.appendChild(el('div', 'lens-note', `• ${x.code}: ${x.message}`));
        }
        body.appendChild(d);
      }
      setStatus(out.summary);
    } catch (e) {
      setStatus('error: ' + e.message, 'err');
    } finally { running = false; }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  function init() {
    const sel = $('lens-altitude');
    const syn = $('lens-synthetic');
    const btn = $('lens-refresh');
    const min = $('lens-minimize');
    const panel = $('lens-panel');
    if (!sel || !panel) return;   // markup not present; nothing to wire

    sel.addEventListener('change', () => { state.altitude = sel.value; refresh(); });
    if (syn) syn.addEventListener('change', () => { state.hideSynthetic = syn.checked; refresh(); });
    if (btn) btn.addEventListener('click', refresh);
    if (min) min.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      min.textContent = collapsed ? '▲' : '—';
    });

    // Recompute on edit, debounced. Lowering a large program is not free and
    // the editor fires per keystroke.
    const src = $('src');
    if (src) {
      let timer = null;
      src.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(refresh, 400);
      });
    }
    if (ROOT.IVX.bus && typeof ROOT.IVX.bus.on === 'function') {
      ROOT.IVX.bus.on('source:changed', refresh);
    }
    setStatus('ready — press Refresh');
  }

  ROOT.IVX.lens = { refresh, state, init };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
