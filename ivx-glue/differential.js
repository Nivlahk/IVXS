// ── differential.js ─────────────────────────────────────────────────────────
// The test that actually matters: lower a program to SEER, run it through
// the REAL engine (stage2Allocate -> compileCFSource -> substituteSymbolicNames
// -> simulateProgram), and compare the register file at halt against an
// INDEPENDENT evaluator over the same AST.
//
// The reference evaluator below is deliberately a second implementation
// with nothing in common with the lowerer -- it walks the word_kh AST
// directly with BigInt semantics and never touches SEER. If both agree,
// the agreement means something. If the oracle were derived from the
// lowering, it would not.
//
//   node differential.js
'use strict';

const path = require('path');
const HERE = __dirname;
const loadEngine = require(path.join(HERE, 'engine_node.js'));
const { wordParse } = require(path.join(HERE, 'word_kh.js'));
const { lowerUAST, checkOpTable, SEER_OPS } = require(path.join(HERE, 'ivx_lower.js'));
const C = require(path.join(HERE, 'ivx_lower_contract.js'));

// patchLiveOut applies the two-line stage2Allocate change described in
// engine_node.js. Without it there is no output channel at all and this
// suite cannot observe anything -- see the note in ivx_lower.js's
// emitOutputEpilogue for why anchoring alone provably cannot work.
// MODE=liveout (default) : patched engine, liveOut argument passed
// MODE=bare              : UNPATCHED engine, no epilogue, no liveOut --
//                          the honest control for "does the engine need
//                          the patch, or do outputs survive by luck?"
// MODE=sink              : unpatched engine + the sink epilogue
const MODE = process.env.MODE || 'liveout';
const PATCH_LIVE_OUT = MODE === 'liveout';
// Prefer the integrated Soak_tester.patched.html when it is present; fall
// back to patching a loaded copy of the original in memory otherwise, so
// this suite runs either way.
const fs = require('fs');
const PATCHED_PATH = path.join(HERE, 'Soak_tester.patched.html');
const USING_INTEGRATED = fs.existsSync(PATCHED_PATH);
const E = loadEngine({
  htmlPath: USING_INTEGRATED ? PATCHED_PATH : path.join(HERE, 'Soak_tester.html'),
  imemIndex: 2, regIndex: 4,
  patchLiveOut: !USING_INTEGRATED && PATCH_LIVE_OUT,
});
const CTX = { metaCF: false, capabilityDiscipline: false, regDepth: 64,
              imemBudget: E.getImemBudget(),
              outputMode: MODE === 'sink' ? 'sink' : 'liveout',
              engine: E };

// ════════════════════════════════════════════════════════════════════════════
// REFERENCE EVALUATOR -- independent oracle, BigInt, no SEER anywhere.
// ════════════════════════════════════════════════════════════════════════════
// Sentinel for `give`. A thrown object rather than a flag so a return
// inside nested control flow unwinds without every construct having to
// check for it.
class RefReturn { constructor(v) { this.v = v; } }

function refEval(ast) {
  const env = new Map();
  const fns = new Map();
  const outs = [];
  const truthy = v => v !== 0n;
  const num = v => (typeof v === 'bigint' ? v : BigInt(v));

  function ev(n) {
    switch (n.type) {
      case 'NumberLit': return BigInt(n.value);
      case 'BoolLit':   return n.value ? 1n : 0n;
      case 'Identifier': {
        if (!env.has(n.name)) return 0n;   // matches the allocator's zero-init
        return env.get(n.name);
      }
      case 'Call': {
        const f = fns.get(n.name);
        if (!f) throw new Error(`ref: unknown function ${n.name}`);
        if (f.params.length !== n.args.length) throw new Error(`ref: arity ${n.name}`);
        // Call by value with a fresh frame -- the reference semantics the
        // stack ABI is supposed to implement.
        const saved = new Map(env);
        const argv = n.args.map(a => ev(a));
        f.params.forEach((p, i) => env.set(p, argv[i]));
        let result = 0n;
        try { run(f.body, { n: 200000 }); }
        catch (e) { if (e instanceof RefReturn) result = e.v; else throw e; }
        env.clear();
        for (const [k, v] of saved) env.set(k, v);
        return result;
      }
      case 'UnaryOp':
        if (n.op === 'not') return truthy(ev(n.operand)) ? 0n : 1n;
        throw new Error(`ref: unary ${n.op}`);
      case 'BinOp': {
        const op = n.op;
        if (op === 'and') return (truthy(ev(n.left)) && truthy(ev(n.right))) ? 1n : 0n;
        if (op === 'or')  return (truthy(ev(n.left)) || truthy(ev(n.right))) ? 1n : 0n;
        const a = num(ev(n.left)), b = num(ev(n.right));
        switch (op) {
          case '+': return BigInt.asIntN(64, a + b);
          case '-': return BigInt.asIntN(64, a - b);
          case '*': return BigInt.asIntN(64, a * b);
          case '/': return b === 0n ? 0n : BigInt.asIntN(64, a / b);
          case '=':  return a === b ? 1n : 0n;
          case '!=': return a !== b ? 1n : 0n;
          case '<':  return a <  b ? 1n : 0n;
          case '>':  return a >  b ? 1n : 0n;
          case '<=': return a <= b ? 1n : 0n;
          case '>=': return a >= b ? 1n : 0n;
          default: throw new Error(`ref: binop ${op}`);
        }
      }
      default: throw new Error(`ref: expr ${n.type}`);
    }
  }

  function run(stmts, fuel = { n: 2000000 }) {
    for (const s of stmts) {
      if (--fuel.n < 0) throw new Error('ref: fuel exhausted (infinite loop?)');
      switch (s.type) {
        case 'Assign': env.set(s.name, ev(s.expr)); break;
        case 'Print':  outs.push(ev(s.expr)); break;
        case 'If':
          if (truthy(ev(s.condition))) run(s.body, fuel);
          else if (s.else_) run(s.else_, fuel);
          break;
        case 'Loop':
          while (truthy(ev(s.condition))) {
            if (--fuel.n < 0) throw new Error('ref: fuel exhausted');
            run(s.body, fuel);
          }
          break;
        case 'FunctionDef': fns.set(s.name, { params: s.params || [], body: s.body || [] }); break;
        case 'Give': throw new RefReturn(s.expr ? ev(s.expr) : 0n);
        case 'End': break;
        default: throw new Error(`ref: stmt ${s.type}`);
      }
    }
  }
  // Hoist function definitions so a call can precede its `fun`, matching
  // cfLinkCalls' eager resolution.
  for (const st of ast.body) {
    if (st.type === 'FunctionDef') fns.set(st.name, { params: st.params || [], body: st.body || [] });
  }
  run(ast.body);
  return { env, outs };
}

// ════════════════════════════════════════════════════════════════════════════
// THE DIFFERENTIAL
// ════════════════════════════════════════════════════════════════════════════
/**
 * Appends `print <var>` for every variable the program assigns, in first-
 * assignment order, so no value is dead at halt. Returns the rewritten
 * source; the reference evaluator runs on the same rewritten source, so
 * both sides see identical programs.
 */
function keepAllLive(src) {
  const seen = [];
  for (const line of src.split('\n')) {
    // Only TOP-LEVEL assignments: a name assigned inside a function body is
    // scoped to that frame, and printing it at the end would be reading a
    // dead local.
    if (/^\s/.test(line)) continue;
    const m = /^\s*make\s+([A-Za-z_]\w*)\b/.exec(line);
    if (m && !seen.includes(m[1])) seen.push(m[1]);
  }
  const tail = seen.map(v => `print ${v}`).join('\n');
  return src.replace(/\n*$/, '\n') + tail + (tail ? '\n' : '');
}

async function differential(name, rawSrc, opts = {}) {
  const src = opts.noKeepAlive ? rawSrc : keepAllLive(rawSrc);
  const rec = { name, src, stage: null, ok: false };
  try {
    const ast = wordParse(src);

    // --- oracle
    const ref = refEval(ast);
    // HARNESS BUG, FOUND ON THE FIRST RUN: the original version read every
    // named variable out of s2.mapping[name] at halt and reported ten
    // mismatches. All ten were the harness. stage2Allocate is a LIVENESS
    // allocator: once a name is dead its register is reused, so
    // `make a 5 / make b 3` legitimately maps BOTH a and b to r0, and
    // reading `a` at halt reads b's value. Register reuse after death is
    // correct allocation, not a lowering fault.
    //
    // The fix is to compare through the only channel that is defined at
    // halt: the __outN print anchors, which the lowerer keeps live by
    // construction. Each test program is rewritten to print every variable
    // it assigns, so everything observable is live to the end.
    rec.expected = Object.fromEntries([...ref.env].map(([k, v]) => [k, v.toString()]));
    rec.expectedOuts = ref.outs.map(String);

    // --- lower
    rec.stage = 'lower';
    const lo = await lowerUAST(ast, CTX);
    rec.cfText = lo.text;
    rec.refusals = lo.diagnostics.map(d => d.code);
    rec.warnings = lo.diagnostics.filter(d => d.severity === 'warn').map(d => d.code);
    const hardRefusals = lo.diagnostics.filter(d => d.severity === 'refuse');
    if (hardRefusals.length && !opts.allowRefusals) {
      rec.skipped = `refused: ${hardRefusals.map(d => d.code).join(', ')}`;
      return rec;
    }

    // --- static invariants (must hold before we bother the engine)
    rec.stage = 'invariants';
    C.assertMapTotal(lo); C.assertNoPhysicalRegs(lo);
    C.assertConditionsLowered(lo); C.assertImmediatesInRange(lo);
    C.assertLiRange(lo);

    // --- real engine, in getEffectiveSource()'s own order
    rec.stage = 'stage2Allocate';
    const liveOut = lo.outputs ? lo.outputs.map(o => o.name) : [];
    const s2 = PATCH_LIVE_OUT ? E.stage2Allocate(lo.text, CTX.metaCF, liveOut)
                              : E.stage2Allocate(lo.text, CTX.metaCF);
    rec.mapping = s2.mapping; rec.spilled = s2.spilled; rec.initNames = s2.initNames;

    rec.stage = 'compileCFSource';
    const comp = E.compileCFSource(s2.raw2, CTX.capabilityDiscipline, CTX.metaCF);
    rec.labelCount = comp.labelCount;

    rec.stage = 'substitute+assemble';
    const flat = E.substituteSymbolicNames(comp.text, s2.mapping);
    rec.bytes = E.parseProgram(flat).reduce((n, it) => n + it.bytes.length, 0);
    rec.budget = CTX.imemBudget - 2048;

    rec.stage = 'simulateProgram';
    const sim = E.simulateProgram(flat, 200000, CTX.regDepth);
    if (sim.error) { rec.error = sim.error; return rec; }
    rec.steps = sim.steps; rec.halted = sim.halted; rec.cnCount = sim.cnCount;

    // --- compare, through the print channel only (see the note above)
    rec.stage = 'compare';
    const gotOuts = [];
    for (let i = 0; i < rec.expectedOuts.length; i++) {
      const reg = s2.mapping[`__out${i}`];
      if (reg === undefined) {
        gotOuts.push(s2.spilled.includes(`__out${i}`) ? '<spilled>' : '<unallocated>');
      } else {
        gotOuts.push(BigInt.asIntN(64, sim.reg[reg]).toString());
      }
    }
    rec.observedOuts = gotOuts;
    rec.mismatches = [];
    for (let i = 0; i < rec.expectedOuts.length; i++) {
      if (gotOuts[i] !== rec.expectedOuts[i]) {
        rec.mismatches.push({ name: `print#${i}`, want: rec.expectedOuts[i], got: gotOuts[i] });
      }
    }
    rec.ok = rec.mismatches.length === 0;
    return rec;
  } catch (e) {
    rec.error = e.message;
    return rec;
  }
}

// ════════════════════════════════════════════════════════════════════════════
const PROGRAMS = {
  const_assign:  'make a 5\nmake b 3\n',
  arith_add:     'make a 5\nmake b 3\nmake c a + b\nprint c\n',
  arith_chain:   'make a 7\nmake b a * 3\nmake c b - 2\nprint c\n',
  imm_in_range:  'make x 10\nmake y x + 100\nprint y\n',
  imm_out_range: 'make x 10\nmake y x + 500\nprint y\n',
  counted_loop:  'make total 0\nmake limit 10\nloop total < limit\n    make total total + 3\nprint total\n',
  loop_accum:    'make i 0\nmake s 0\nloop i < 5\n    make s s + i\n    make i i + 1\nprint s\n',
  if_else:       'make a 5\nif a > 3\n    make r 1\nelse\n    make r 0\nprint r\n',
  if_else_false: 'make a 1\nif a > 3\n    make r 1\nelse\n    make r 0\nprint r\n',
  and_cond:      'make a 5\nmake b 2\nif a > 3 and b < 9\n    make r 1\nelse\n    make r 0\nprint r\n',
  and_short:     'make a 1\nmake b 2\nif a > 3 and b < 9\n    make r 1\nelse\n    make r 0\nprint r\n',
  or_first:      'make a 1\nmake r 0\nif a = 1 or a = 2\n    make r 7\nprint r\n',
  or_second:     'make a 2\nmake r 0\nif a = 1 or a = 2\n    make r 7\nprint r\n',
  or_neither:    'make a 9\nmake r 0\nif a = 1 or a = 2\n    make r 7\nprint r\n',
  nested_if:     'make i 0\nmake hit 0\nloop i < 4\n    if i = 2\n        make hit 1\n    make i i + 1\nprint hit\n',
  neg_small:     'make a 10\nmake b a - 15\nprint b\n',
  cmp_ge:        'make a 4\nmake r 0\nif a >= 4\n    make r 1\nprint r\n',
  cmp_ne:        'make a 4\nmake r 0\nif a != 5\n    make r 1\nprint r\n',
  big_const:     'make a 70000\nprint a\n',
  neg_const:     'make a 0\nmake b a - 500\nprint b\n',
  huge_const:    'make a 4000000000\nprint a\n',
  div_exact:     'make a 20\nmake b 4\nmake q a / b\nprint q\n',
  div_trunc:     'make a 17\nmake b 5\nmake q a / b\nprint q\n',
  div_negative:  'make a 0\nmake n a - 17\nmake b 5\nmake q n / b\nprint q\n',
  mul_chain:     'make a 3\nmake b a * 7\nmake c b * 11\nprint c\n',
  deep_nest:     'make i 0\nmake acc 0\nloop i < 6\n    if i > 1\n        if i < 5\n            make acc acc + i\n    make i i + 1\nprint acc\n',
  loop_in_loop:  'make i 0\nmake t 0\nloop i < 4\n    make j 0\n    loop j < 3\n        make t t + 1\n        make j j + 1\n    make i i + 1\nprint t\n',
  // CAPACITY LIMIT, not a bug: read-back through the register file is
  // bounded by regDepth. keepAllLive() adds a print per variable, so N
  // variables means N live-out values; past the register count they spill
  // to dmem and this harness (which reads sim.reg only) sees '<spilled>'.
  // 40 vars became 80 outputs against a 64-deep file and failed for exactly
  // that reason. 24 stays comfortably inside it; reading spilled outputs
  // back needs the slot->address map, which stage2Allocate does not return.
  many_vars:     Array.from({length: 24}, (_, k) => `make v${k} ${k * 3}`).join('\n') + '\n',
  long_loop:     'make i 0\nloop i < 300\n    make i i + 1\nprint i\n',

  // ── functions and the stack ABI ──────────────────────────────────────────
  fn_simple:     'fun d(x)\n    give x * 2\nmake r d(5)\nprint r\n',
  fn_two_params: 'fun a2(a, b)\n    give a + b\nmake r a2(20, 22)\nprint r\n',
  fn_zero_arg:   'fun k()\n    give 99\nmake r k()\nprint r\n',
  fn_two_calls:  'fun d(x)\n    give x * 2\nmake a d(3)\nmake b d(5)\nmake t a + b\nprint t\n',
  fn_calls_fn:   'fun inc(x)\n    give x + 1\nfun tw(y)\n    make m inc(y)\n    give m + m\nmake r tw(4)\nprint r\n',
  fn_branch:     'fun sgn(x)\n    if x > 0\n        give 1\n    give 0\nmake a sgn(7)\nmake b sgn(0)\nmake t a + b\nprint t\n',
  fn_loop_inside:'fun tri(n)\n    make s 0\n    make i 0\n    loop i <= n\n        make s s + i\n        make i i + 1\n    give s\nmake r tri(10)\nprint r\n',
  rec_fact5:     'fun f(n)\n    if n <= 1\n        give 1\n    make m n - 1\n    make s f(m)\n    give n * s\nmake r f(5)\nprint r\n',
  rec_fact8:     'fun f(n)\n    if n <= 1\n        give 1\n    make m n - 1\n    make s f(m)\n    give n * s\nmake r f(8)\nprint r\n',
  rec_sum:       'fun c(n)\n    if n = 0\n        give 0\n    make m n - 1\n    make s c(m)\n    give n + s\nmake r c(6)\nprint r\n',
  rec_fib:       'fun fb(n)\n    if n <= 1\n        give n\n    make a n - 1\n    make x fb(a)\n    make b n - 2\n    make y fb(b)\n    give x + y\nmake r fb(10)\nprint r\n',
  rec_mutual_ish:'fun g(n)\n    if n = 0\n        give 100\n    make m n - 1\n    make s g(m)\n    give s + 1\nmake r g(7)\nprint r\n',
};

// ════════════════════════════════════════════════════════════════════════════
// FUZZER
// ════════════════════════════════════════════════════════════════════════════
// Random programs over the integer subset, checked against the same
// independent evaluator. Handwritten cases only cover what I already
// thought of; this covers combinations I did not. Seeded so a failure is
// reproducible from its seed alone.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genProgram(seed) {
  const rnd = mulberry32(seed);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const vars = [];
  const lines = [];

  // Values stay small enough that the oracle's 64-bit wrap and the
  // machine's agree trivially; range edges are covered by the handwritten
  // big_const/huge_const cases instead of being buried in random noise.
  const expr = depth => {
    // NON-NEGATIVE literals only. The first fuzz run generated `v1 - -85 * 72`
    // and died in wordParse -- KH's subset has no unary minus, so a bare
    // negative literal in operand position is not valid input to the thing
    // under test. Negative values still get exercised, via subtraction and
    // via the handwritten neg_* cases.
    if (depth <= 0 || !vars.length || rnd() < 0.35) return String(int(0, 400));
    if (rnd() < 0.4) return pick(vars);
    return `${expr(depth - 1)} ${pick(['+', '-', '*'])} ${expr(depth - 1)}`;
  };
  const cond = () => {
    const l = vars.length ? pick(vars) : String(int(0, 10));
    return `${l} ${pick(["<", ">", "=", "!=", "<=", ">="])} ${int(0, 15)}`;
  };

  const stmt = (indent, depth) => {
    const pad = '    '.repeat(indent);
    const r = rnd();
    if (r < 0.5 || depth <= 0) {
      const v = `v${vars.length}`;
      lines.push(`${pad}make ${v} ${expr(2)}`);
      vars.push(v);
    } else if (r < 0.75) {
      lines.push(`${pad}if ${cond()}`);
      const n = int(1, 2);
      for (let i = 0; i < n; i++) stmt(indent + 1, depth - 1);
      if (rnd() < 0.5) {
        lines.push(`${pad}else`);
        stmt(indent + 1, depth - 1);
      }
    } else {
      // Bounded counter loop: a fresh induction variable with a literal
      // bound and a guaranteed +1 step, so the oracle always terminates.
      const iv = `v${vars.length}`;
      lines.push(`${pad}make ${iv} 0`);
      vars.push(iv);
      lines.push(`${pad}loop ${iv} < ${int(1, 6)}`);
      const n = int(0, 2);
      for (let i = 0; i < n; i++) stmt(indent + 1, depth - 1);
      lines.push(`${pad}    make ${iv} ${iv} + 1`);
    }
  };

  const n = int(2, 6);
  for (let i = 0; i < n; i++) stmt(0, 2);
  return lines.join('\n') + '\n';
}

// ── Function/recursion fuzzer ───────────────────────────────────────────────
// Generated separately from genProgram because recursion needs a
// STRUCTURALLY GUARANTEED base case -- a random recursive body would mostly
// produce non-terminating programs, and "the oracle ran out of fuel" tells
// you nothing about the ABI. Every generated function decreases its
// argument by a positive amount and returns a constant at or below zero, so
// termination is a property of the generator, not of luck.
function genFunctionProgram(seed) {
  const rnd = mulberry32(seed ^ 0x5eed);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const L = [];
  const nFns = int(1, 2);
  const names = [];

  for (let f = 0; f < nFns; f++) {
    const name = `f${f}`;
    const recursive = rnd() < 0.6;
    const base = int(0, 3);
    const step = int(1, 2);
    const combine = pick(['+', '-', '*']);
    if (recursive) {
      L.push(`fun ${name}(n)`);
      L.push(`    if n <= ${base}`);
      L.push(`        give ${int(1, 3)}`);
      L.push(`    make m n - ${step}`);
      L.push(`    make s ${name}(m)`);
      // '*' on a deep recursion overflows fast; the oracle wraps to 64 bits
      // and so does the machine, so they still agree -- but keep depths
      // modest so the comparison is about the ABI, not about overflow.
      L.push(`    give n ${combine} s`);
    } else {
      const p2 = rnd() < 0.5;
      L.push(`fun ${name}(n${p2 ? ', k' : ''})`);
      L.push(`    make t n ${pick(['+', '-', '*'])} ${int(1, 9)}`);
      if (p2) L.push(`    make t t + k`);
      L.push(`    give t`);
      names.push({ name, arity: p2 ? 2 : 1, recursive: false });
      continue;
    }
    names.push({ name, arity: 1, recursive: true });
  }

  const calls = int(1, 3);
  const outs = [];
  for (let c = 0; c < calls; c++) {
    const f = pick(names);
    const depth = f.recursive ? int(0, 7) : int(0, 40);
    const args = f.arity === 2 ? `${depth}, ${int(0, 9)}` : `${depth}`;
    L.push(`make r${c} ${f.name}(${args})`);
    outs.push(`r${c}`);
  }
  for (const o of outs) L.push(`print ${o}`);
  return L.join('\n') + '\n';
}

(async () => {
  console.log('opcode table check:', checkOpTable(E.OPCODES, E.FORMAT).message);
  console.log('imemBudget', E.getImemBudget(), 'regDepth', E.getRegDepth(),
              '| mode:', MODE, '| engine:', USING_INTEGRATED ? 'integrated patch' : 'in-memory patch');
  console.log('='.repeat(72));

  let pass = 0, fail = 0, skip = 0;
  const failed = [];
  for (const [name, src] of Object.entries(PROGRAMS)) {
    const r = await differential(name, src);
    if (r.skipped) { skip++; console.log(`SKIP ${name.padEnd(15)} ${r.skipped}`); continue; }
    if (r.ok) {
      pass++;
      console.log(`ok   ${name.padEnd(15)} ${String(r.steps).padStart(5)} steps, `
        + `${String(r.bytes).padStart(4)}B/${r.budget}, ${r.labelCount} CN`
        + (r.spilled.length ? `, spilled ${r.spilled.join(',')}` : '')
        + (r.warnings && r.warnings.length ? `  [warn: ${r.warnings.join(',')}]` : ''));
    } else {
      fail++; failed.push(r);
      console.log(`FAIL ${name.padEnd(15)} stage=${r.stage} ${r.error ? '\n       ' + r.error : ''}`);
      if (r.mismatches) for (const m of r.mismatches) {
        console.log(`       ${m.name}: expected ${m.want}, got ${m.got}` + (m.note ? ` (${m.note})` : ''));
      }
      if (r.expectedOuts) console.log(`       prints: expected ${JSON.stringify(r.expectedOuts)}\n                got ${JSON.stringify(r.observedOuts)}`);
    }
  }
  // ── fuzz: functions and recursion
  const FN_FUZZ_N = Number(process.env.FNFUZZ || 200);
  console.log('-'.repeat(72));
  console.log(`fuzzing ${FN_FUZZ_N} random function/recursion programs...`);
  let gpass = 0, gfail = 0, gskip = 0;
  const gFails = [];
  for (let seed = 1; seed <= FN_FUZZ_N; seed++) {
    const prog = genFunctionProgram(seed);
    let r;
    try { r = await differential(`fnfuzz#${seed}`, prog); }
    catch (e) { gfail++; gFails.push({ seed, prog, error: e.message }); continue; }
    if (r.skipped) { gskip++; continue; }
    if (r.ok) gpass++; else { gfail++; gFails.push({ seed, prog, rec: r }); }
  }
  console.log(`fn-fuzz: ${gpass} passed, ${gfail} failed, ${gskip} skipped`);
  if (gFails.length) {
    const f = gFails[0];
    console.log(`\n--- smallest-seed fn-fuzz failure (seed ${f.seed}) ---`);
    console.log(f.prog);
    if (f.error) console.log('threw:', f.error);
    else {
      console.log('lowered:\n' + f.rec.cfText);
      console.log('stage:', f.rec.stage, 'error:', f.rec.error || '(none)');
      console.log('expected', JSON.stringify(f.rec.expectedOuts));
      console.log('got     ', JSON.stringify(f.rec.observedOuts));
    }
  }
  pass += gpass; fail += gfail; skip += gskip;

  // ── fuzz
  const FUZZ_N = Number(process.env.FUZZ || 300);
  console.log('-'.repeat(72));
  console.log(`fuzzing ${FUZZ_N} random programs...`);
  let fpass = 0, ffail = 0, fskip = 0;
  const fuzzFails = [];
  for (let seed = 1; seed <= FUZZ_N; seed++) {
    const prog = genProgram(seed);
    let r;
    try { r = await differential(`fuzz#${seed}`, prog); }
    catch (e) { ffail++; fuzzFails.push({ seed, prog, error: e.message }); continue; }
    if (r.skipped) { fskip++; continue; }
    if (r.ok) fpass++;
    else { ffail++; fuzzFails.push({ seed, prog, rec: r }); }
  }
  console.log(`fuzz: ${fpass} passed, ${ffail} failed, ${fskip} skipped`);
  if (fuzzFails.length) {
    const f = fuzzFails[0];
    console.log(`\n--- smallest-seed fuzz failure (seed ${f.seed}) ---`);
    console.log(f.prog);
    if (f.error) console.log('threw:', f.error);
    else {
      console.log('lowered:\n' + f.rec.cfText);
      console.log('stage:', f.rec.stage, 'error:', f.rec.error || '(none)');
      console.log('expected', JSON.stringify(f.rec.expectedOuts));
      console.log('got     ', JSON.stringify(f.rec.observedOuts));
    }
  }
  fail += ffail; pass += fpass; skip += fskip;

  console.log('='.repeat(72));
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped`);
  if (failed.length) {
    console.log('\n--- first failure, in full ---');
    const f = failed[0];
    console.log(`program ${f.name}:\n${f.src}\nlowered:\n${f.cfText}\n`);
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS THREW:', e); process.exit(1); });
