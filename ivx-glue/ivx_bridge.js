// ── ivx_bridge.js ───────────────────────────────────────────────────────────
// Phase 4, integration. Three seams:
//
//   1. resolver -> pool          : a resolved foreign module becomes a live worker
//   2. pool     -> kernel.bind() : `bind name(...) -> a, b` runs in a worker
//   3. lowered SEER externs      : analysed, and REFUSED when not hoistable
//
// ── The constraint that shapes all of this ──────────────────────────────────
// simulateProgram is SYNCHRONOUS: `function simulateProgram(text, maxSteps,
// regDepth)`, no async, no resume entry point, no initial-state parameter.
// It returns {reg, mem, steps, halted, trace, cnCount} only after the
// program halts.
//
// A worker call is asynchronous by construction -- postMessage/onmessage,
// with no synchronous variant that does not require SharedArrayBuffer plus
// Atomics.wait plus COOP/COEP headers, which a local-first page opened from
// disk will not have.
//
// Therefore: A LOWERED SEER PROGRAM CANNOT CALL A WORKER MID-EXECUTION.
// Not "does not yet" -- cannot, with this simulator entry point. The two
// honest options are:
//
//   (a) HOIST. Foreign calls run before or after the SEER program, never
//       inside it. Values cross at the boundary. This is what the IVX
//       kernel already does: ivx_kernel.js executes `word` and `bind` as
//       TOP-LEVEL statements in order, and nothing in it calls a bind from
//       inside absorbed code. Phase 4 fits the existing shape rather than
//       fighting it.
//
//   (b) SEGMENT. Split the program at each foreign call, run to a halt,
//       await the worker, resume with the saved state. This needs
//       simulateProgram to accept an initial {reg, mem} -- a small
//       additive patch in the same style as the live-out one. It is NOT
//       done here: each segment would also re-run the stack-capability
//       boot prefix, which writes registers, so resumption is not merely
//       "restore and continue" and the correctness argument deserves its
//       own pass rather than being smuggled in.
//
// This file implements (a), and DETECTS when a program needs (b) so the
// answer is a clear refusal instead of a wrong result. isHoistable() below
// is the check.
'use strict';

const { IVXWorkerPool, specFromResolved } = require('./ivx_workers.js');

// ── Hoistability ────────────────────────────────────────────────────────────
// An extern is hoistable when its call site is NOT inside any control flow:
// running it once, before the program, is then equivalent to running it
// where it appears. Inside a loop or a branch it is not -- the call might
// run zero times, or ten, or depend on a value the program computes.
//
// Indentation in the emitted CF text is the test, because that is exactly
// what parseCFSource uses to decide nesting. Using the same signal as the
// parser means this cannot disagree with the compiler about what is nested.
function isHoistable(lowerResult) {
  const reasons = [];
  for (const ext of lowerResult.externs || []) {
    const line = lowerResult.lines[ext.cfLine];
    if (line === undefined) {
      reasons.push({ extern: ext.name, why: `cfLine ${ext.cfLine} is out of range` });
      continue;
    }
    const indent = line.match(/^\s*/)[0].length;
    if (indent > 0) {
      reasons.push({
        extern: ext.name, cfLine: ext.cfLine, indent,
        why: `call site is nested (indent ${indent}) -- it is inside a loop or branch, so it `
           + `cannot be hoisted out of the program, and it cannot run in place because `
           + `simulateProgram is synchronous`,
      });
    }
  }
  return { hoistable: reasons.length === 0, reasons };
}

// ── The bridge ──────────────────────────────────────────────────────────────
class IVXBridge {
  /**
   * @param {Object} opts
   * @param {Object} opts.resolver   Phase 1 IVXResolver (optional; only needed for auto-resolve)
   * @param {Object} opts.pool       IVXWorkerPool (created if absent)
   * @param {Object} opts.runtimeOpts { indexURL, wasmExecUrl, imports } -- passed to specFromResolved
   */
  constructor(opts = {}) {
    this.resolver = opts.resolver || null;
    this.pool = opts.pool || new IVXWorkerPool(opts);
    this.runtimeOpts = opts.runtimeOpts || {};
    this.log = [];      // every crossing, for the fidelity ledger
  }

  /** Resolves a specifier (Phase 1) and brings up its worker (Phase 4). */
  async load(specifier) {
    if (!this.resolver) throw new Error('IVXBridge: no resolver configured; ' +
      'pass one, or use loadResolved() with a module you resolved yourself');
    const mod = await this.resolver.resolve(specifier);
    return this.loadResolved(mod);
  }

  async loadResolved(mod) {
    const spec = specFromResolved(mod, this.runtimeOpts);
    const key = `${mod.runtime}:${mod.name}@${mod.version || 'unpinned'}`;
    await this.pool.acquire(key, spec);
    return { key, runtime: mod.runtime, name: mod.name, version: mod.version };
  }

  async call(key, name, args) {
    const started = Date.now();
    try {
      const value = await this.pool.call(key, name, args);
      this.log.push({ key, name, args, value, ms: Date.now() - started, ok: true });
      return value;
    } catch (e) {
      this.log.push({ key, name, args, error: e.message, ms: Date.now() - started, ok: false });
      throw e;
    }
  }

  /**
   * Registers a worker-backed bind() target on an IVXKernel.
   *
   * The kernel's hostFn contract is (args, readBackNames) -> value, and the
   * kernel tags every result HOSTED. That is the correct fidelity: a value
   * that crossed into Pyodide and back is correct but not representable in
   * IVX's own terms, so it is opaque and not zoomable -- the same line
   * ivx_kernel.js already draws. Phase 4 does not blur it.
   */
  registerBind(kernel, bindName, { key, entry }) {
    kernel.bind(bindName, async (args, readBackNames) => {
      const { __call, ...rest } = args;
      const fnName = __call || entry;
      const ordered = Object.keys(rest).sort().map(k => rest[k]);
      const value = await this.call(key, fnName, ordered);
      // readBack names map positionally onto a returned array, or by key
      // onto a returned object. Anything else is returned whole under the
      // first name, rather than being silently destructured into undefineds.
      const results = {};
      if (Array.isArray(value)) {
        readBackNames.forEach((n, i) => { results[n] = value[i]; });
      } else if (value && typeof value === 'object') {
        readBackNames.forEach(n => { results[n] = value[n]; });
      } else if (readBackNames.length) {
        results[readBackNames[0]] = value;
      }
      return { output: [], results, hosted: true };
    });
    return bindName;
  }

  /**
   * Runs a lowered SEER program that has foreign calls, hoisting them.
   *
   * @param {Object} lowerResult    from lowerUAST
   * @param {Object} engine         { stage2Allocate, compileCFSource, substituteSymbolicNames, simulateProgram }
   * @param {Object} opts.externValues  { externName: value } supplied by the caller,
   *                                    or resolved through this bridge when omitted
   */
  async runLowered(lowerResult, engine, opts = {}) {
    const externs = lowerResult.externs || [];
    if (externs.length) {
      const h = isHoistable(lowerResult);
      if (!h.hoistable) {
        const first = h.reasons[0];
        const e = new Error(
          `cannot run this program: foreign call '${first.extern}' is nested inside control flow. ` +
          `simulateProgram is synchronous, so a worker call cannot happen mid-execution; ` +
          `hoisting only works for top-level calls. Move the call out of the loop/branch, or ` +
          `add resume-from-state support to simulateProgram (see this file's header).`);
        e.reasons = h.reasons;
        throw e;
      }
    }

    // Hoisted phase: every foreign call runs first, in source order.
    const injected = {};
    for (const ext of externs) {
      const supplied = opts.externValues && (ext.name in opts.externValues);
      const value = supplied
        ? opts.externValues[ext.name]
        : await this.call(ext.key || ext.specifier, ext.entry || ext.name, ext.argValues || []);
      injected[ext.readBack && ext.readBack[0] ? ext.readBack[0] : ext.name] = value;
      this.log.push({ phase: 'hoist', extern: ext.name, value });
    }

    // Injected values become materialized constants at the top of the
    // program. This is where the ABSORBED/HOSTED line is drawn in practice:
    // what crosses the boundary is a VALUE, not structure. The worker's
    // computation is not represented in SEER and never becomes zoomable --
    // only its result does.
    let text = lowerResult.text;
    const prologue = [];
    for (const [name, value] of Object.entries(injected)) {
      if (!Number.isInteger(value)) {
        throw new Error(`foreign call produced ${JSON.stringify(value)} for '${name}'; ` +
          `only integers can cross into SEER (the implemented OPU tier is integer-only)`);
      }
      prologue.push(materializeInt(name, value));
    }
    if (prologue.length) text = prologue.join('\n') + '\n' + text;

    const liveOut = (lowerResult.outputs || []).map(o => o.name);
    const s2 = engine.stage2Allocate(text, false, liveOut);
    const comp = engine.compileCFSource(s2.raw2, false, false);
    const flat = engine.substituteSymbolicNames(comp.text, s2.mapping);
    const sim = engine.simulateProgram(flat, opts.maxSteps || 200000, opts.regDepth || 64);
    return { sim, s2, comp, flat, injected, text };
  }

  status() { return this.pool.status(); }
  terminate() { this.pool.terminateAll(); }
}

// Same range rules as the lowerer's CFEmitter._materialize: `li` is a PP
// pseudo-op accepting 0..0xFFFF or -128..-1 and nothing else.
function materializeInt(name, value) {
  if ((value >= 0 && value <= 0xFFFF) || (value < 0 && value >= -128)) {
    return `li ${name}, ${value}`;
  }
  const neg = value < 0;
  let mag = Math.abs(value);
  if (!Number.isSafeInteger(mag)) throw new Error(`value ${value} exceeds the safe-integer range`);
  const chunks = [];
  while (mag > 0) { chunks.unshift(mag % 0x10000); mag = Math.floor(mag / 0x10000); }
  if (!chunks.length) chunks.push(0);
  const out = [`li ${name}, ${chunks[0]}`];
  for (let i = 1; i < chunks.length; i++) {
    out.push(`slli ${name}, ${name}, 16`);
    if (chunks[i] !== 0) {
      const t = `__inj${i}`;
      out.push(`li ${t}, ${chunks[i]}`, `add ${name}, ${name}, ${t}`);
    }
  }
  if (neg) out.push(`sub ${name}, zr, ${name}`);
  return out.join('\n');
}

module.exports = { IVXBridge, isHoistable, materializeInt };
