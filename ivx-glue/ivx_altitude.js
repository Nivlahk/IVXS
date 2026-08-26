// ── ivx_altitude.js ─────────────────────────────────────────────────────────
// Phase 3, first half: the consumer that proves the Phase 2 source map is
// sufficient.
//
// The architectural claim in ivx_lower_contract.js §B was that
// materializeToggle is one-way and destructive, so "highering" has to be
// built on a map emitted at lowering time rather than recovered afterward.
// A claim like that is cheap to make and easy to be wrong about, so this
// file is the check: it implements bidirectional projection using NOTHING
// but LowerResult. If it works, the map is sufficient. If it needed one
// extra field, the contract was wrong and this is where that shows up.
//
// It deliberately does NOT touch the DOM, materializeToggle, or the source
// textarea. Wiring is a separate, reversible step -- the existing toggle
// path overwrites the buffer, and the whole point here is to stop doing
// that.
//
// STATUS: all three altitudes are live. FLAT was previously stubbed
// because nothing downstream of codegen recorded origin; the engine patch
// (see apply_patch.py) adds three side-channel arrays that chain:
//
//   parseProgram item .srcLine  ->  flat text line
//   flat text line              ->  compiled line   (1:1 -- substituteSymbolicNames
//                                                    is a whole-text regex replace
//                                                    that never adds or removes a
//                                                    newline)
//   compiled line -> raw2 line  (compileCFSource .srcMap)
//   raw2 line     -> raw line   (stage2Allocate  .raw2Map)
//   raw line      -> UAST node  (this file's own originOf over LowerResult.map)
//
// Any link may be null, and null is load-bearing: it means "the engine
// synthesized this" (CN-table setup, the stack-capability boot prefix,
// spill loads/stores, the appended hlt). Those rows are real machine code
// the user should be able to SEE at FLAT altitude while never being told
// they wrote it.
'use strict';

const ALTITUDE = Object.freeze({
  SOURCE: 'source',  // the user's own lens syntax, one row per UAST node
  CF:     'cf',      // compileCFSource dialect, one row per emitted line
  FLAT:   'flat',    // post-compile SEER with PCs and bytes -- NOT YET REACHABLE
});

// Roles with no counterpart in the user's source. Phase 3 must be able to
// hide these: showing CN registration and stack-frame setup as if it were
// the user's own code is a mistake this project already made once and
// fixed once, in the x86-64 lens.
const SYNTHETIC_ROLES = new Set(['const', 'abi', 'prologue', 'epilogue']);

// ── Downward: which CF lines did this UAST node produce? ────────────────────
function linesFor(result, uastId) {
  const idx = [];
  for (const e of result.map) {
    if (e.uastId === uastId) for (let i = e.cfStart; i <= e.cfEnd; i++) idx.push(i);
  }
  return idx.sort((a, b) => a - b);
}

// ── Upward: which UAST node produced this CF line? ──────────────────────────
// This is the direction that does not exist anywhere in the current engine.
function originOf(result, cfLineIndex) {
  for (const e of result.map) {
    if (cfLineIndex >= e.cfStart && cfLineIndex <= e.cfEnd) {
      return { uastId: e.uastId, uastKind: e.uastKind, uastLoc: e.uastLoc, role: e.role };
    }
  }
  return null;   // impossible if assertMapTotal passed; checked anyway
}

// ── Round-trip check ────────────────────────────────────────────────────────
// For every emitted line: origin resolves, and that origin's own line set
// contains the line we started from. A map can be total and still be
// inconsistent -- this catches the difference.
function assertRoundTrip(result) {
  const failures = [];
  for (let i = 0; i < result.lines.length; i++) {
    const o = originOf(result, i);
    if (!o) { failures.push({ line: i, why: 'no origin' }); continue; }
    if (!linesFor(result, o.uastId).includes(i)) {
      failures.push({ line: i, why: `origin ${o.uastId} does not claim line ${i}` });
    }
  }
  if (failures.length) {
    throw new Error(`round-trip failed on ${failures.length} line(s), first: `
      + `line ${failures[0].line} -- ${failures[0].why}`);
  }
  return true;
}

// ── Projection ──────────────────────────────────────────────────────────────
/**
 * Renders the lowered program at a chosen altitude.
 * @param {Object} result   LowerResult from lowerUAST()
 * @param {Object} opts
 * @param {string} opts.altitude        ALTITUDE.*
 * @param {boolean} opts.hideSynthetic  Hide const/abi/prologue rows (default true)
 * @param {string[]} opts.sourceLines    Original lens source, for SOURCE altitude
 * @returns {{altitude:string, rows:Array, hidden:number, note?:string}}
 */
function project(result, opts = {}) {
  const altitude = opts.altitude || ALTITUDE.CF;
  const hideSynthetic = opts.hideSynthetic !== false;

  if (altitude === ALTITUDE.FLAT) {
    if (!opts.compiled) {
      return { altitude, rows: [], hidden: 0,
        note: 'FLAT altitude needs the engine artifacts. Pass opts.compiled = '
            + '{ items, srcMap, raw2Map } from parseProgram/compileCFSource/'
            + 'stage2Allocate on a patched engine (see apply_patch.py).' };
    }
    return projectFlat(result, opts);
  }

  if (altitude === ALTITUDE.CF) {
    const rows = [];
    let hidden = 0;
    result.lines.forEach((text, i) => {
      const o = originOf(result, i);
      if (hideSynthetic && o && SYNTHETIC_ROLES.has(o.role)) { hidden++; return; }
      rows.push({
        cfLine: i, text,
        origin: o && { uastId: o.uastId, uastKind: o.uastKind, srcLine: o.uastLoc.line, role: o.role },
      });
    });
    return { altitude, rows, hidden };
  }

  // SOURCE: collapse every CF line back onto its originating node, in
  // source order, so the editor gutter can show "this one line of yours
  // became these six".
  const byNode = new Map();
  result.lines.forEach((text, i) => {
    const o = originOf(result, i);
    if (!o) return;
    if (!byNode.has(o.uastId)) {
      byNode.set(o.uastId, { uastId: o.uastId, uastKind: o.uastKind,
                             srcLine: o.uastLoc.line, cfLines: [], synthetic: 0 });
    }
    const rec = byNode.get(o.uastId);
    rec.cfLines.push(i);
    if (SYNTHETIC_ROLES.has(o.role)) rec.synthetic++;
  });

  const rows = [...byNode.values()].sort((a, b) =>
    (a.srcLine - b.srcLine) || (a.cfLines[0] - b.cfLines[0]));

  for (const r of rows) {
    r.cost = r.cfLines.length;
    r.text = (opts.sourceLines && r.srcLine > 0 && opts.sourceLines[r.srcLine - 1] !== undefined)
      ? opts.sourceLines[r.srcLine - 1].trim()
      : `<${r.uastKind}>`;
    const d = result.diagnostics.filter(x => x.uastId === r.uastId);
    if (d.length) r.diagnostics = d.map(x => x.code);
  }
  return { altitude, rows, hidden: 0 };
}

/**
 * FLAT: one row per ASSEMBLED INSTRUCTION, with its PC, encoded bytes, and
 * cycle count, traced back through the whole chain to the user's own line.
 *
 * @param {Object} opts.compiled
 *   .items    parseProgram(flatText) -- each has .srcLine, .bytes, .mnem, .cycles
 *   .srcMap   compileCFSource(...).srcMap
 *   .raw2Map  stage2Allocate(...).raw2Map
 */
function projectFlat(result, opts) {
  const { items, srcMap, raw2Map } = opts.compiled;
  const hideSynthetic = opts.hideSynthetic === true;   // FLAT defaults to SHOWING
  const rows = [];
  let pc = 0, hidden = 0, traced = 0;

  for (const it of items) {
    const bytes = it.bytes || [];
    const compiledLine = it.srcLine;
    const raw2Line = (srcMap && compiledLine != null) ? srcMap[compiledLine] : null;
    const rawLine  = (raw2Map && raw2Line != null) ? raw2Map[raw2Line] : null;
    const origin   = rawLine != null ? originOf(result, rawLine) : null;
    if (origin) traced++;

    const row = {
      pc, bytes, hex: bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
      mnem: it.mnem, ops: it.ops, fmt: it.fmt, cycles: it.cycles,
      cyclesUnconfirmed: !!it.unconfirmed,
      cfLine: rawLine,
      // null origin = engine-synthesized (CN setup, boot prefix, spill
      // traffic, appended hlt). Distinguished from user code, never
      // silently attributed to it.
      origin: origin && { uastId: origin.uastId, uastKind: origin.uastKind,
                          srcLine: origin.uastLoc.line, role: origin.role },
      synthetic: !origin || SYNTHETIC_ROLES.has(origin.role),
    };
    pc += bytes.length;
    if (hideSynthetic && row.synthetic) { hidden++; continue; }
    rows.push(row);
  }

  return {
    altitude: ALTITUDE.FLAT, rows, hidden,
    totals: {
      instructions: items.length, bytes: pc,
      cycles: items.reduce((s, it) => s + (it.cycles || 0), 0),
      traced, untraced: items.length - traced,
    },
  };
}

// ── Editor gutter payload ───────────────────────────────────────────────────
// What an editor actually needs to render the zoom affordance: for each CF
// line, how deep it is and where it came from; for each source node, its
// instruction cost. This is the shape script.js/editor.js would consume.
function gutter(result) {
  const cost = new Map();
  for (const e of result.map) {
    const n = e.cfEnd - e.cfStart + 1;
    cost.set(e.uastId, (cost.get(e.uastId) || 0) + n);
  }
  return {
    perCfLine: result.lines.map((text, i) => {
      const o = originOf(result, i);
      return { cfLine: i, srcLine: o ? o.uastLoc.line : null,
               role: o ? o.role : null, synthetic: o ? SYNTHETIC_ROLES.has(o.role) : false };
    }),
    perNode: [...cost.entries()].map(([uastId, instructions]) => {
      const e = result.map.find(m => m.uastId === uastId);
      return { uastId, uastKind: e.uastKind, srcLine: e.uastLoc.line, instructions };
    }),
    totals: {
      cfLines: result.lines.length,
      synthetic: result.map.filter(e => SYNTHETIC_ROLES.has(e.role))
                           .reduce((s, e) => s + (e.cfEnd - e.cfStart + 1), 0),
      refusals: result.diagnostics.length,
      externs: result.externs.length,
    },
  };
}

module.exports = { ALTITUDE, SYNTHETIC_ROLES, project, projectFlat, originOf,
                   linesFor, assertRoundTrip, gutter };
