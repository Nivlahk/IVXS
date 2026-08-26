// ── ivx_lower_contract.js ───────────────────────────────────────────────────
// Phase 2: the INTERFACE CONTRACT for UAST -> SEER lowering.
//
// This file is the contract plus a conformance harness, not the lowerer
// itself. Every constraint below was read out of Soak_tester.html or
// carried over from a bug that was already paid for once -- none of it is
// stylistic preference.
//
// ════════════════════════════════════════════════════════════════════════════
// A. WHERE THE LOWERER PLUGS IN, AND WHY IT IS TEXT
// ════════════════════════════════════════════════════════════════════════════
// The real pipeline in getEffectiveSource() is:
//
//   raw source text
//     -> stage2Allocate(raw, metaCF)        -> {mapping, spilled, initNames, raw2, reserved}
//     -> compileCFSource(raw2, capDisc, metaCF) -> {text, labelCount, functionCount, mutability}
//     -> substituteSymbolicNames(text, mapping) -> flat SEER text
//     -> parseProgram(text) / simulateProgram(text)
//
// Every arrow is a STRING. There is no shared AST object handed between
// stages -- stage2Allocate and compileCFSource each call parseCFSource on
// the text independently. That is the single most important fact for this
// phase, and it has one direct consequence:
//
//   >> LOWER TO THE compileCFSource TEXT DIALECT. DO NOT EMIT FLAT IR. <<
//
// Emitting flat IR skips cfResolveMultiScope / cfGenerateSetup, which is
// where CN-table registration and absolute PC resolution happen. That is
// already a known source of runtime failures (branches emitting raw
// PC-relative offsets instead of registered CN slots). Going in at the CF
// text layer gets, for free and already-proven: the stack-capability boot
// prefix, CN registration, adjacent-node merging, the imem/IVT byte-budget
// check, CFG liveness allocation, and dmem spilling. Re-implementing any
// of that is a strictly worse position than the one already held.
//
// Corollary: emit SYMBOLIC NAMES, never physical registers. `total`, not
// `r7`. stage2Allocate is the register allocator; the lowerer that hands
// it pre-assigned registers has just turned the allocator off.
//
// ════════════════════════════════════════════════════════════════════════════
// B. THE PART THAT IS NOT OPTIONAL: THE SOURCE MAP
// ════════════════════════════════════════════════════════════════════════════
// Phase 3 ("highering") cannot be built as an extension of the existing
// materializeToggle path, because that path is ONE-WAY AND DESTRUCTIVE.
// onZoningToggleChange() does exactly this when materialize is checked:
//
//     if (effective !== ta.value) ta.value = effective;
//     ["cfToggle","symbolicRegsToggle","capabilityToggle","metaCfToggle"]
//       .forEach(id => { el.checked = false; });
//
// It overwrites the source buffer with the lowered text and unchecks the
// toggles. The higher-altitude form is gone. There is no inverse function
// anywhere in the file, and most of what would be needed to write one is
// destroyed rather than merely hidden:
//
//   - compileCFSource returns {text, labelCount, functionCount, mutability}
//     -- no line correspondence of any kind.
//   - cfResolveMultiScope assigns absolute PCs from the final layout.
//     Nothing records which statement produced which address.
//   - substituteSymbolicNames does a regex \bname\b replace, so the text
//     loses the names. (This one IS recoverable -- stage2Result.mapping
//     survives -- and is the only one that is.)
//
// So: the lowerer MUST emit a map alongside the text, and Phase 3 is a
// consumer of that map. Retrofitting it later means re-deriving
// information that this phase is the last point to still have. Build it
// now or accept that Phase 3 is a rewrite.
//
// ════════════════════════════════════════════════════════════════════════════
// C. FIDELITY: REUSE THE VOCABULARY THAT ALREADY EXISTS
// ════════════════════════════════════════════════════════════════════════════
// ivx_kernel.js already draws exactly the line this phase needs:
// ABSORBED = real IVX structure, inspectable, zoomable. HOSTED = opaque
// call, correct but not represented in IVX's own terms. A UAST node that
// lowers to SEER is ABSORBED all the way down to bytes. A node that calls
// into a Phase-1-resolved foreign module is HOSTED and stops at the
// worker boundary. Do not invent a third word for this -- tag lowering
// output with the same FIDELITY enum so the ledger stays one ledger.
'use strict';

const FIDELITY = Object.freeze({ ABSORBED: 'absorbed', HOSTED: 'hosted' });

// `li` is a PP pseudo-op: 0..0xFFFF assembles as li.captr, -128..-1 as
// addi rd,zr,imm8. Nothing else assembles at all.
const LI_RANGE = Object.freeze({ min: -128, max: 0xFFFF });


// ════════════════════════════════════════════════════════════════════════════
// D. TYPE CONTRACT
// ════════════════════════════════════════════════════════════════════════════
/**
 * @typedef {Object} LowerContext
 * @property {boolean} metaCF        Enables retry/succeed/onfail and `break N`.
 *                                   parseCFSource THROWS on those without it.
 * @property {boolean} capabilityDiscipline  Enables use/lend checking.
 * @property {number}  regDepth      4|8|16|32|64|128|256. r255 (zr) is always
 *                                   present; any index >= regDepth traps on
 *                                   real hardware and in the simulator.
 * @property {number}  imemBudget    Total imem bytes. Usable code budget is
 *                                   imemBudget - 2048 (fixed IVT reservation).
 * @property {(spec:string)=>Promise<Object>} resolveImport  Phase 1 resolver.
 * @property {()=>string} gensym     Fresh symbolic name, collision-free.
 */

/**
 * @typedef {Object} MapEntry
 * @property {string} uastId    Stable id of the UAST node.
 * @property {string} uastKind  'Assign' | 'If' | 'Loop' | ... (kernel kind names)
 * @property {{line:number,col:number}} uastLoc  Position in the ORIGINAL lens source.
 * @property {number} cfStart   First emitted CF line index (0-based, into LowerResult.lines).
 * @property {number} cfEnd     Last emitted CF line index, inclusive.
 * @property {'body'|'cond'|'prologue'|'epilogue'|'const'|'abi'} role
 *   Why these lines exist. 'const'/'abi'/'prologue' lines have NO
 *   counterpart in the user's source -- Phase 3 must be able to hide them,
 *   which is exactly the mistake already made and fixed once in the x86-64
 *   lens (CN registration and stack-frame setup were shown to the user as
 *   if they were their own code).
 */

/**
 * @typedef {Object} Extern
 * @property {string} name       Local binding name in the UAST.
 * @property {string} specifier  What Phase 1 was asked to resolve.
 * @property {string} runtime    RUNTIME.PYTHON | RUNTIME.JS | RUNTIME.GO | ...
 * @property {string[]} argNames Symbolic names holding arguments at the call site.
 * @property {string[]} readBack Symbolic names to receive results.
 * @property {number} cfLine     Index of the placeholder line in the emitted text.
 */

/**
 * @typedef {Object} Diagnostic
 * @property {'refuse'|'warn'} severity
 * @property {string} uastId
 * @property {string} code    Stable, machine-checkable. See REFUSAL_CODES.
 * @property {string} message Human-readable, says WHY, not just WHAT.
 */

/**
 * @typedef {Object} LowerResult
 * @property {string}   text        Joined CF-dialect source. Valid input to
 *                                  stage2Allocate() as-is.
 * @property {string[]} lines       Same content, unjoined. MapEntry indexes into this.
 * @property {MapEntry[]} map       Complete. Every emitted line is covered by
 *                                  exactly one entry -- see assertMapTotal().
 * @property {Extern[]} externs     Phase 4 dispatch list.
 * @property {Diagnostic[]} diagnostics
 * @property {string}   fidelity    FIDELITY.ABSORBED if externs is empty, else mixed.
 */

/**
 * The one function Phase 2 must provide.
 * @param {Object} uastProgram  Kinded IVX AST (kernel.make()-tagged nodes).
 * @param {LowerContext} ctx
 * @returns {Promise<LowerResult>}
 */
// async function lowerUAST(uastProgram, ctx) -> LowerResult

// ════════════════════════════════════════════════════════════════════════════
// E. HARD CONSTRAINTS OF THE TARGET DIALECT
// ════════════════════════════════════════════════════════════════════════════
// Each of these is enforced by real code in Soak_tester.html or by real
// hardware. Violating one produces either a parse error, a silent wrong
// answer, or a trap -- listed with which.
const DIALECT_CONSTRAINTS = Object.freeze([
  {
    id: 'COND_BINARY_ONLY',
    rule: 'A condition is exactly `<operand> <op> <operand>`. No `and`/`or`, no nesting.',
    source: "parseCFCondition's regex: /^(\\S+)\\s*(==|!=|<=u|>=u|<u|>u|<=|>=|<|>)\\s*(\\S+)$/",
    failureMode: 'throws "invalid condition"',
    lowering: 'Lower && to nested ifs; lower || to an if/elif chain or a short-circuit flag.',
  },
  {
    id: 'COND_REG_VS_REG',
    rule: 'Both condition operands must be REGISTERS on real hardware.',
    source: 'The `if rX == LITERAL:` sugar emits the literal directly as a BR-format '
          + 'operand; real SEER only ever compares two registers. Found the hard way '
          + 'during the x86-64 switch_test work.',
    failureMode: 'simulator may agree; real hardware does not. Silent divergence.',
    lowering: 'Materialize every comparison constant into its own symbolic name first.',
  },
  {
    id: 'COND_NATIVE_OPS',
    rule: 'Native branch ops are == != < >= <u >=u. `>`, `<=`, `>u`, `<=u` are '
        + 'operand-swap sugar resolved by parseCFCondition, not distinct instructions.',
    source: 'CF_COND_OPS + the swap block in parseCFCondition',
    failureMode: 'none -- but the map must record the swap, or Phase 3 shows the '
               + 'user a reversed comparison.',
    lowering: 'Emit whichever reads naturally; record the canonical form in MapEntry.',
  },
  {
    id: 'SUBI_IMM8',
    rule: "subi's immediate field is 8-bit SIGNED: -128..127.",
    source: 'SEER ISA. Caught when translating x86 `sub reg,imm32`: 136 silently '
          + 'wrapped to -120, corrupting the value by exactly 256.',
    failureMode: 'SILENT WRONG ANSWER. The worst class.',
    lowering: 'Range-check every immediate. Out of range -> li into a register, then subtract.',
  },
  {
    id: 'DEF_ZERO_ARG',
    rule: '`def name():` takes no parameters and returns no value. `call name()` '
        + 'optionally carries `lend r1, r2` for capability discipline only.',
    source: "parseCFSource: /^def\\s+(\\w+)\\(\\):$/ and /^call\\s+(\\w+)\\(\\)(?:\\s+lend\\s+(.+))?$/",
    failureMode: 'parse error on anything with parameters',
    lowering: 'The lowerer OWNS the calling convention. Pick fixed symbolic names '
            + '(arg0..argN, ret0) or spill slots, emit the marshaling as role:"abi" '
            + 'lines, and hide them in Phase 3. Recursion needs real spilling -- '
            + 'stage2Allocate handles the spill, but the ABI names are yours.',
  },
  {
    id: 'TERMINATORS',
    rule: 'Top-level ends with `hlt`; a function body ends with `return`.',
    source: 'compileCFSource appends `hlt` to main and `return` to each fn when '
          + '!cfEndsWithTransfer. Emitting `return` at top level is wrong.',
    failureMode: 'return-address-stack underflow trap',
    lowering: 'Let compileCFSource append them. Do not emit them yourself.',
  },
  {
    id: 'META_CF_GATE',
    rule: '`retry N:`, `succeed`, and `break N` (N>1) require metaCF enabled.',
    source: 'requireMetaCF() throws with an explicit message otherwise',
    failureMode: 'parse error',
    lowering: 'Check ctx.metaCF before emitting; otherwise lower to an explicit '
            + 'counter loop and record it in the map so Phase 3 can still show `retry`.',
  },
  {
    id: 'BYTE_BUDGET',
    rule: 'Compiled bytes must be <= imemBudget - 2048.',
    source: 'compileCFSource PROGRAM_BYTE_BUDGET check. The top 2048 bytes are the '
          + 'IVT; code overlapping it means any trap vectors into your own '
          + 'instructions. Confirmed on real RTL via VCD: a 3309-byte program '
          + 'produced a stable, silent infinite loop with no trap surfacing.',
    failureMode: 'compileCFSource throws (good). Without the check: silent corruption.',
    lowering: 'Loop unrolling and inlining are the two things most likely to blow '
            + 'this. Budget before you unroll.',
  },
  {
    id: 'REG_DEPTH',
    rule: 'Any register index >= regDepth traps. zr is r255 and is the sole exception.',
    source: "simulateProgram's reg_not_impl check, matching seer_regfile.sv",
    failureMode: 'TRAP_ILLEGAL_INSTR',
    lowering: 'Not the lowerer\'s problem IF it emits symbolic names -- stage2Allocate '
            + 'places within depth. It IS the lowerer\'s problem the moment it '
            + 'hardcodes any rN.',
  },
  {
    id: 'NO_OBSERVABLE_ECALL',
    rule: 'ecall assembles and executes but has NO architectural effect in the simulator.',
    source: 'simulateProgram: "sei/cli/sysret/ebreak/ecall/wfe: no architectural '
          + 'effect modeled". ecall is a 1-byte OB-format terminal.',
    failureMode: 'a lowered `print` runs clean and prints nothing. Looks like a '
               + 'lowering bug; is not one.',
    lowering: 'Until an ecall ABI exists, the observable channel is the register '
            + 'file at halt. Lower `print x` to "keep x live in a named register" '
            + 'and read it back from simulateProgram().reg -- which is exactly the '
            + 'readBack mechanism bind() already uses in demo.js.',
  },
  {
    id: 'INTEGER_ONLY',
    rule: 'Only the scalar OPU tier is implemented in RTL. No floats.',
    source: 'The FPU/APU/GPU tiers are real, designed parts of the ISA but nothing '
          + 'in RTL or silicon yet.',
    failureMode: 'unimplemented opcode / no hardware',
    lowering: 'REFUSE float nodes with REFUSAL_CODES.NO_FP. Do not soft-emulate '
            + 'silently -- an emulated float that is 2 ULP off is worse than a refusal.',
  },
]);

// Stable refusal codes. A refusal is a FIRST-CLASS RESULT, not a failure:
// word_kh.js already sets this precedent ("fail loudly rather than silently
// drop or spin"), and the x86-64 lens work established that flagging the
// untranslatable beats mistranslating it.
// The VALUE is the code, so `diagnostic.code` is a stable identifier a test
// can assert on. (First version made the values prose, which meant every
// diagnostic printed its own description in the code field and nothing was
// machine-checkable.) Prose lives in REFUSAL_DESCRIPTIONS.
const REFUSAL_CODES = Object.freeze({
  NO_FP: 'NO_FP',
  NO_HEAP: 'NO_HEAP',
  NO_CLOSURE: 'NO_CLOSURE',
  NO_DYNAMIC_CALL: 'NO_DYNAMIC_CALL',
  NO_STRING_OPS: 'NO_STRING_OPS',
  IMM_RANGE: 'IMM_RANGE',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  UNSUPPORTED_KIND: 'UNSUPPORTED_KIND',
  COMPOUND_LOOP_COND: 'COMPOUND_LOOP_COND',
  OR_BODY_DUPLICATION: 'OR_BODY_DUPLICATION',
  EXTERN_PENDING: 'EXTERN_PENDING',
  ABI_NONREENTRANT: 'ABI_NONREENTRANT',
});

const REFUSAL_DESCRIPTIONS = Object.freeze({
  NO_FP:            'no floating point in the implemented OPU tier',
  NO_HEAP:          'no allocator; dynamic allocation has no lowering',
  NO_CLOSURE:       'def is zero-arg and has no environment capture',
  NO_DYNAMIC_CALL:  'call target must be statically known (CN-table registration '
                  + 'is a compile-time act)',
  NO_STRING_OPS:    'strings beyond literal storage have no lowering yet',
  IMM_RANGE:        'immediate outside the instruction field width',
  BUDGET_EXCEEDED:  'lowered program exceeds imemBudget - 2048',
  UNSUPPORTED_KIND: 'no lowering rule registered for this UAST kind',
  COMPOUND_LOOP_COND: 'while with and/or needs a recomputed loop flag',
  OR_BODY_DUPLICATION: 'or duplicates the body once per disjunct',
  EXTERN_PENDING:   'host-boundary call awaiting Phase 1 resolution and a Phase 4 worker',
  ABI_NONREENTRANT: 'fixed-name argument slots are not re-entrant unless the allocator spills them',
});

// ════════════════════════════════════════════════════════════════════════════
// F. INVARIANTS -- CHECKED, NOT ASSERTED IN PROSE
// ════════════════════════════════════════════════════════════════════════════
// The map is the deliverable Phase 3 depends on, so it gets a real
// checker. Partial maps are the failure mode that would not surface until
// Phase 3 is half-built.

/** Every emitted line is covered by exactly one MapEntry. */
function assertMapTotal(result) {
  const cover = new Array(result.lines.length).fill(0);
  for (const e of result.map) {
    if (e.cfStart < 0 || e.cfEnd >= result.lines.length || e.cfEnd < e.cfStart) {
      throw new Error(`map entry ${e.uastId} has out-of-range span [${e.cfStart},${e.cfEnd}] `
        + `(emitted ${result.lines.length} lines)`);
    }
    for (let i = e.cfStart; i <= e.cfEnd; i++) cover[i]++;
  }
  const uncovered = cover.map((c, i) => c === 0 ? i : -1).filter(i => i >= 0);
  const doubled  = cover.map((c, i) => c > 1 ? i : -1).filter(i => i >= 0);
  if (uncovered.length) {
    throw new Error(`map is not total: ${uncovered.length} uncovered line(s), first at `
      + `${uncovered[0]}: ${JSON.stringify(result.lines[uncovered[0]])}`);
  }
  if (doubled.length) {
    throw new Error(`map double-covers line ${doubled[0]}: ${JSON.stringify(result.lines[doubled[0]])} `
      + `-- Phase 3 would have two candidate origins and no rule to pick one`);
  }
  return true;
}

/** No physical register may appear in emitted text except zr. */
function assertNoPhysicalRegs(result) {
  const offenders = [];
  result.lines.forEach((ln, i) => {
    // `use rN:` and explicit lend lists are the legitimate exceptions -- both
    // are capability-discipline syntax that names a physical register by design.
    if (/^\s*use\s+(r\d+|zr)\s*:/.test(ln)) return;
    if (/\blend\s+/.test(ln)) return;
    const m = ln.match(/\br(\d+)\b/g);
    if (m) offenders.push({ line: i, text: ln, regs: m });
  });
  if (offenders.length) {
    throw new Error(`lowerer emitted ${offenders.length} physical register reference(s), `
      + `first at line ${offenders[0].line}: ${JSON.stringify(offenders[0].text)}. `
      + `Emit symbolic names -- stage2Allocate is the allocator.`);
  }
  return true;
}

/** Every condition is binary and register-vs-register. */
function assertConditionsLowered(result) {
  const bad = [];
  result.lines.forEach((ln, i) => {
    const m = /^\s*(?:if|elif|while)\s+(.+):\s*$/.exec(ln);
    if (!m) return;
    const cond = m[1];
    if (/\b(and|or|not)\b/.test(cond)) bad.push({ line: i, cond, why: 'compound' });
    const parts = /^(\S+)\s*(==|!=|<=u|>=u|<u|>u|<=|>=|<|>)\s*(\S+)$/.exec(cond.trim());
    if (!parts) { bad.push({ line: i, cond, why: 'not binary' }); return; }
    if (/^-?\d+$/.test(parts[1]) || /^-?\d+$/.test(parts[3])) {
      bad.push({ line: i, cond, why: 'literal operand -- real hardware compares registers only' });
    }
  });
  if (bad.length) {
    throw new Error(`${bad.length} condition(s) violate the dialect, first at line `
      + `${bad[0].line}: "${bad[0].cond}" (${bad[0].why})`);
  }
  return true;
}

/** Immediates fit their fields. */
const IMM_WIDTHS = Object.freeze({ subi: [-128, 127], addi: [-128, 127] });
function assertImmediatesInRange(result) {
  const bad = [];
  result.lines.forEach((ln, i) => {
    const m = /^\s*(subi|addi)\s+\S+\s*,\s*\S+\s*,\s*(-?\d+)\s*$/.exec(ln);
    if (!m) return;
    const [lo, hi] = IMM_WIDTHS[m[1]];
    const v = parseInt(m[2], 10);
    if (v < lo || v > hi) bad.push({ line: i, text: ln, mnem: m[1], value: v, lo, hi });
  });
  if (bad.length) {
    const b = bad[0];
    throw new Error(`${bad.length} out-of-range immediate(s), first at line ${b.line}: `
      + `${b.mnem} ${b.value} outside [${b.lo},${b.hi}] -- this WRAPS SILENTLY. `
      + `li the value into a register instead.`);
  }
  return true;
}

/**
 * `li` is a PP PSEUDO-OP, not a real opcode, and its range is narrow and
 * asymmetric: 0..0xFFFF (assembles as li.captr) or -128..-1 (assembles as
 * addi rd,zr,imm8). Anything else throws at ASSEMBLY time, well after
 * lowering looks fine. Found by the real engine rejecting `li a, 70000`
 * from a two-line program.
 */
function assertLiRange(result) {
  const bad = [];
  result.lines.forEach((ln, i) => {
    const m = /^\s*li\s+\S+\s*,\s*(-?(?:0x[0-9a-fA-F]+|0b[01]+|\d+))\s*$/.exec(ln);
    if (!m) return;
    const raw = m[1];
    const v = /^-?0x/i.test(raw) ? parseInt(raw, 16)
            : /^-?0b/i.test(raw) ? parseInt(raw.replace(/0b/i, ''), 2)
            : parseInt(raw, 10);
    if (!(v >= 0 && v <= LI_RANGE.max) && !(v < 0 && v >= LI_RANGE.min)) {
      bad.push({ line: i, text: ln, value: v });
    }
  });
  if (bad.length) {
    const b = bad[0];
    throw new Error(`${bad.length} out-of-range li immediate(s), first at line ${b.line}: `
      + `${b.value} outside 0..${LI_RANGE.max} and ${LI_RANGE.min}..-1. `
      + `Build it with a shift/accumulate sequence instead.`);
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// G. THE CONFORMANCE HARNESS
// ════════════════════════════════════════════════════════════════════════════
// Any candidate lowerUAST implementation is run through this. It checks the
// static invariants, then does the thing that actually matters: runs the
// lowered program through the REAL pipeline and cross-checks the result
// against the same program executed by the guest language's own
// interpreter via bind(). That differential is the whole test -- the same
// shape already used to verify the emit path and the x86-64 lens.
//
// `env` supplies the real functions from Soak_tester.html. They are passed
// in rather than imported so this file stays runnable in node for the
// static half of the suite.
async function conformanceCheck(lowerUAST, uastProgram, ctx, env, expectations) {
  const report = { static: {}, dynamic: null, passed: false };

  const result = await lowerUAST(uastProgram, ctx);

  report.static.mapTotal        = safely(() => assertMapTotal(result));
  report.static.noPhysicalRegs  = safely(() => assertNoPhysicalRegs(result));
  report.static.conditions      = safely(() => assertConditionsLowered(result));
  report.static.immediates      = safely(() => assertImmediatesInRange(result));
  report.static.liRange         = safely(() => assertLiRange(result));

  const staticOk = Object.values(report.static).every(r => r.ok);
  if (!staticOk || !env) { report.result = result; return report; }

  // Real pipeline, in the real order getEffectiveSource() uses.
  const s2 = env.stage2Allocate(result.text, ctx.metaCF);
  const compiled = env.compileCFSource(s2.raw2, ctx.capabilityDiscipline, ctx.metaCF);
  const flat = env.substituteSymbolicNames(compiled.text, s2.mapping);
  const sim = env.simulateProgram(flat, 200000, ctx.regDepth);

  if (sim.error) {
    report.dynamic = { ok: false, stage: 'simulate', error: sim.error };
    report.result = result;
    return report;
  }

  // Read back the named values through the allocation mapping. This is the
  // observable channel -- see NO_OBSERVABLE_ECALL above.
  const observed = {};
  for (const name of Object.keys(expectations)) {
    const reg = s2.mapping[name];
    if (reg === undefined) {
      report.dynamic = { ok: false, stage: 'readback',
        error: `'${name}' was never allocated a register -- it may have been spilled `
             + `(spilled: ${s2.spilled.join(', ') || 'none'}) or optimized away` };
      report.result = result;
      return report;
    }
    observed[name] = sim.reg[reg];
  }

  const mismatches = Object.entries(expectations)
    .filter(([k, v]) => BigInt(observed[k]) !== BigInt(v))
    .map(([k, v]) => ({ name: k, expected: String(v), got: String(observed[k]) }));

  report.dynamic = {
    ok: mismatches.length === 0, mismatches, observed, steps: sim.steps,
    cnCount: sim.cnCount, compiledBytes: compiled.text.length,
    labelCount: compiled.labelCount, spilled: s2.spilled,
  };
  report.passed = report.dynamic.ok;
  report.result = result;
  return report;
}

function safely(fn) {
  try { fn(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ════════════════════════════════════════════════════════════════════════════
// H. EMITTER HELPER
// ════════════════════════════════════════════════════════════════════════════
// Not the lowerer -- the bookkeeping the lowerer would otherwise get wrong.
// Its only real job is making the map total by construction: you cannot
// emit a line through this without saying which UAST node it came from and
// what role it plays. That is the difference between a map that exists and
// a map Phase 3 can trust.
// Spans NEST, because statements nest: an assignment inside a loop body is
// attributed to the assignment, not the loop, while the loop's own `while`
// line is attributed to the loop. A flat begin/close cannot express that --
// the first version of this class was flat and the first real lowering
// threw on it immediately, which is the harness doing its job.
//
// So: begin/close are push/pop, every emitted line records the INNERMOST
// open span, and finish() coalesces runs of identically-attributed lines
// into MapEntries. Totality stops being a discipline the lowerer has to
// maintain and becomes a property of the data structure.
class CFEmitter {
  constructor() {
    this.lines = [];
    this._attrib = [];   // parallel to lines: the span each line belongs to
    this.externs = [];
    this.diagnostics = [];
    this._indent = 0;
    this._gensym = 0;
    this._stack = [];
  }

  gensym(hint = 't') { return `__${hint}${this._gensym++}`; }

  /** Pushes a map span. Lines emitted until the matching close() belong to it. */
  begin(uastId, uastKind, uastLoc, role = 'body') {
    this._stack.push({ uastId, uastKind, uastLoc, role });
    return this;
  }

  close() {
    if (!this._stack.length) throw new Error('CFEmitter.close() with no open span');
    this._stack.pop();
    return this;
  }

  /** Emits one line at the current indent. Requires at least one open span. */
  emit(text) {
    if (!this._stack.length) throw new Error(`CFEmitter.emit(${JSON.stringify(text)}) outside any span `
      + `-- every emitted line must be attributable, or the map is not total`);
    this.lines.push('  '.repeat(this._indent) + text);
    this._attrib.push(this._stack[this._stack.length - 1]);
    return this;
  }

  /**
   * Materializes a constant into a fresh symbolic name. See COND_REG_VS_REG.
   * Tagged role:'const' so Phase 3 can hide it -- these lines have no
   * counterpart in the user's source, and showing them is the exact mistake
   * already made and fixed once in the x86-64 lens.
   *
   * `li` is a PP pseudo whose range is 0..0xFFFF or -128..-1 and NOTHING
   * else -- it throws at assembly time, long after lowering looks clean.
   * Outside that window the value is built by shift/accumulate over 16-bit
   * chunks and negated from zr if needed. Verified against the real engine:
   * 70000 and -500 both round-trip exactly.
   */
  constant(value, hint = 'k') {
    if (!Number.isInteger(value)) throw new Error(`constant(${value}): ${REFUSAL_CODES.NO_FP}`);
    const name = this.gensym(hint);
    const outer = this._stack[this._stack.length - 1]
      || { uastId: '<root>', uastKind: 'Const', uastLoc: { line: null, col: null } };
    this.begin(outer.uastId, outer.uastKind, outer.uastLoc, 'const');
    this._materialize(name, value);
    this.close();
    return name;
  }

  /** Emits the instruction sequence that puts `value` into `name`. */
  _materialize(name, value) {
    if ((value >= 0 && value <= LI_RANGE.max) || (value < 0 && value >= LI_RANGE.min)) {
      this.emit(`li ${name}, ${value}`);
      return;
    }
    const neg = value < 0;
    let mag = Math.abs(value);
    if (!Number.isSafeInteger(mag)) {
      throw new Error(`constant ${value} exceeds the safe-integer range; `
        + `64-bit literals beyond 2^53 need a BigInt path that does not exist yet`);
    }
    // High-to-low 16-bit chunks, leading zeros dropped.
    const chunks = [];
    let m = mag;
    while (m > 0) { chunks.unshift(m % 0x10000); m = Math.floor(m / 0x10000); }
    if (!chunks.length) chunks.push(0);

    this.emit(`li ${name}, ${chunks[0]}`);
    for (let i = 1; i < chunks.length; i++) {
      this.emit(`slli ${name}, ${name}, 16`);
      if (chunks[i] !== 0) {
        const t = this.gensym('kc');
        this.emit(`li ${t}, ${chunks[i]}`);
        this.emit(`add ${name}, ${name}, ${t}`);
      }
    }
    if (neg) this.emit(`sub ${name}, zr, ${name}`);
  }

  indent()  { this._indent++; return this; }
  dedent()  { if (this._indent > 0) this._indent--; return this; }

  refuse(uastId, code, message) {
    this.diagnostics.push({ severity: 'refuse', uastId, code, message });
    return this;
  }

  /** A warning does NOT block lowering -- the program is still emitted. */
  warn(uastId, code, message) {
    this.diagnostics.push({ severity: 'warn', uastId, code, message });
    return this;
  }

  extern(rec) { this.externs.push(rec); return this; }

  finish() {
    if (this._stack.length) {
      throw new Error(`CFEmitter.finish() with ${this._stack.length} span(s) still open, `
        + `innermost ${this._stack[this._stack.length - 1].uastId}`);
    }
    const map = [];
    for (let i = 0; i < this.lines.length; i++) {
      const a = this._attrib[i];
      const last = map[map.length - 1];
      if (last && last.uastId === a.uastId && last.role === a.role && last.cfEnd === i - 1) {
        last.cfEnd = i;
      } else {
        map.push({ uastId: a.uastId, uastKind: a.uastKind, uastLoc: a.uastLoc,
                   role: a.role, cfStart: i, cfEnd: i });
      }
    }
    return {
      text: this.lines.join('\n'),
      lines: this.lines,
      map,
      externs: this.externs,
      diagnostics: this.diagnostics,
      fidelity: this.externs.length ? 'mixed' : FIDELITY.ABSORBED,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// I. COVERAGE TABLE -- WHAT PHASE 2 OWES, EXPLICITLY
// ════════════════════════════════════════════════════════════════════════════
// Honest, not aspirational. `refuse` here means the lowerer must produce a
// Diagnostic, never a best-effort emission.
const COVERAGE = Object.freeze({
  Assign:   { status: 'lower', note: 'integer only; RHS via expression lowering' },
  BinOp:    { status: 'lower', note: '+ - * and the six native comparisons; / needs a routine' },
  UnaryOp:  { status: 'lower', note: 'not -> comparison inversion; neg -> sub from zr' },
  If:       { status: 'lower', note: 'elif chain maps to CF elif directly' },
  Loop:     { status: 'lower', note: 'while cond: -- CF native' },
  For:      { status: 'lower', note: 'integer-range form only; iteration over a collection is NO_HEAP' },
  Print:    { status: 'lower', note: 'see NO_OBSERVABLE_ECALL -- keeps the value live, does not emit output' },
  Call:     { status: 'lower', note: 'static targets only; the lowerer owns the ABI (DEF_ZERO_ARG)' },
  Import:   { status: 'extern', note: 'Phase 1 resolves it, Phase 4 runs it; HOSTED fidelity' },
  Speak:    { status: 'refuse', code: 'NO_STRING_OPS' },
  Closure:  { status: 'refuse', code: 'NO_CLOSURE' },
  FloatLit: { status: 'refuse', code: 'NO_FP' },
  ListLit:  { status: 'refuse', code: 'NO_HEAP' },
});

module.exports = {
  FIDELITY, DIALECT_CONSTRAINTS, REFUSAL_CODES, REFUSAL_DESCRIPTIONS, COVERAGE, IMM_WIDTHS,
  CFEmitter, conformanceCheck, LI_RANGE,
  assertMapTotal, assertNoPhysicalRegs, assertConditionsLowered, assertImmediatesInRange,
  assertLiRange,
};
