// ── abi_tests.js ────────────────────────────────────────────────────────────
// Tests the calling convention against the real engine.
//
// Tested at the CF-dialect level, which IS the ABI layer: `def name():` is
// strictly zero-arg with no return value, so the convention is entirely the
// lowerer's invention and lives in the text it emits. Testing it here rather
// than through KH source also means it is not blocked on the word parser
// gaining function syntax.
//
// ── What this found ─────────────────────────────────────────────────────────
// 1. The fixed-slot ABI (__arg0..N / __ret0) works for non-recursive calls
//    and IS BROKEN FOR RECURSION, exactly as flagged. fact(4) returns 8
//    instead of 24 -- 2^3, because every frame reads the innermost frame's
//    saved value. Depth-2 passes by luck, which is the dangerous part.
// 2. Recursion IS achievable without an engine change: the stack-capability
//    token can be built from CF source using only li/sll/or, giving real
//    re-entrant frames in dmem. fact(5) = 120.
// 3. Getting (2) working exposed a REAL ENGINE BUG unrelated to the ABI:
//    capability-relative addresses were computed as
//    Number(RD(cap)) + Number(RD(ptr)), and a full capability token has a
//    magnitude where float64 spacing is 2048 -- so every 8-byte slot
//    aliased. SPILLING SILENTLY PRODUCED WRONG ANSWERS. See section [4].
//
//   node abi_tests.js
'use strict';

const path = require('path');
const HERE = __dirname;
const loadEngine = require(path.join(HERE, 'engine_node.js'));
const E = loadEngine({ htmlPath: path.join(HERE, 'Soak_tester.patched.html'), imemIndex: 2, regIndex: 4 });

let pass = 0, fail = 0;
const failures = [];
// Some checks are async (they lower KH source); queue them so the summary
// prints after everything has actually run.
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try { await fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { fail++; failures.push({ name, error: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
  });
}

function run(src, liveOut) {
  const s2 = E.stage2Allocate(src, false, liveOut);
  const comp = E.compileCFSource(s2.raw2, false, false);
  const flat = E.substituteSymbolicNames(comp.text, s2.mapping);
  const sim = E.simulateProgram(flat, 400000, 64);
  if (sim.error) return { error: sim.error };
  const vals = {};
  for (const n of liveOut) {
    vals[n] = s2.mapping[n] === undefined ? '<spilled>' : BigInt.asIntN(64, sim.reg[s2.mapping[n]]).toString();
  }
  return { vals, steps: sim.steps, mapping: s2.mapping, spilled: s2.spilled, fns: comp.functionCount };
}

function expect(src, liveOut, want, label) {
  const r = run(src, liveOut);
  if (r.error) throw new Error(`${label}: ${r.error}`);
  for (const [k, v] of Object.entries(want)) {
    if (r.vals[k] !== String(v)) {
      throw new Error(`${label}: ${k} = ${r.vals[k]}, expected ${v}`);
    }
  }
  return r;
}

// ── The stack-capability prologue, in CF-dialect form ───────────────────────
// generateStackCapTokenLines emits this into the spill machinery's reserved
// registers. The same 12 instructions work with symbolic names, which is
// what makes a real call stack reachable without patching the engine.
const macLo = Number(E.STACK_CAP_MAC & 0xFFFFn);
const macHi = Number((E.STACK_CAP_MAC >> 16n) & 0xFFFFn);
const CAP_PROLOGUE = [
  `li __cap, ${E.STACK_CAP_IDX}`,
  `li __cs1, ${E.STACK_CAP_GEN}`,
  `li __cs2, 16`,
  `sll __cs1, __cs1, __cs2`,
  `or __cap, __cap, __cs1`,
  `li __cs1, ${macHi}`,
  `sll __cs1, __cs1, __cs2`,
  `li __cs2, ${macLo}`,
  `or __cs1, __cs1, __cs2`,
  `li __cs2, 32`,
  `sll __cs1, __cs1, __cs2`,
  `or __cap, __cap, __cs1`,
].join('\n');

// Call stack grows DOWN from the top of the 4KB dmem region. Spill slots
// grow UP from SPILL_BASE_ADDR (512), so the two only meet if a program
// spills ~430 names, which would fail allocation first.
const STACK_TOP = E.STACK_CAP_SIZE - 8;

console.log(`engine: imem ${E.getImemBudget()}, regDepth ${E.getRegDepth()}, `
  + `dmem ${E.STACK_CAP_SIZE}, spill base ${E.SPILL_BASE_ADDR}, stack top ${STACK_TOP}`);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[1] Non-recursive calls -- the fixed-slot ABI');

check('one argument, one return', () =>
  expect(`li __arg0, 7
call double()
add out, __ret0, zr
def double():
  add __ret0, __arg0, __arg0
`, ['out'], { out: 14 }, 'one arg'));

check('def placement does not matter (cfLinkCalls is eager)', () => {
  const after = expect(`li __arg0, 7
call double()
add out, __ret0, zr
def double():
  add __ret0, __arg0, __arg0
`, ['out'], { out: 14 }, 'def after');
  const before = expect(`def double():
  add __ret0, __arg0, __arg0
li __arg0, 7
call double()
add out, __ret0, zr
`, ['out'], { out: 14 }, 'def before');
  if (after.steps !== before.steps) throw new Error('placement changed the instruction count');
});

check('two arguments', () =>
  expect(`li __arg0, 20
li __arg1, 22
call add2()
add out, __ret0, zr
def add2():
  add __ret0, __arg0, __arg1
`, ['out'], { out: 42 }, 'two args'));

check('argument slots are reusable across sequential calls', () =>
  expect(`li __arg0, 3
call double()
add a, __ret0, zr
li __arg0, 5
call double()
add b, __ret0, zr
add out, a, b
def double():
  add __ret0, __arg0, __arg0
`, ['out'], { out: 16 }, 'two calls'));

check('nested calls (f -> g) preserve the return path', () =>
  expect(`li __arg0, 5
call outer()
add out, __ret0, zr
def outer():
  add __arg0, __arg0, __arg0
  call inner()
def inner():
  addi __ret0, __arg0, 1
`, ['out'], { out: 11 }, 'nested'));

check('the call mechanism itself recurses correctly', () =>
  // No data to preserve -- purely: does the return-address stack handle
  // depth? It does. So recursion failures below are ABI failures, not
  // control-flow ones.
  expect(`li n, 0
li __arg0, 3
call f()
add out, n, zr
def f():
  li __z, 0
  addi n, n, 1
  if __arg0 == __z:
    return
  subi __arg0, __arg0, 1
  call f()
`, ['out'], { out: 4 }, 'recursion depth'));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[2] Fixed slots under recursion -- ABI_NONREENTRANT, confirmed');

const FIXED_FACT = n => `li __arg0, ${n}
call fact()
add out, __ret0, zr
def fact():
  li __one, 1
  if __arg0 <= __one:
    li __ret0, 1
    return
  add __save, __arg0, zr
  subi __arg0, __arg0, 1
  call fact()
  mul __ret0, __save, __ret0
`;

check('fixed slots give the WRONG answer for fact(4)', () => {
  const r = run(FIXED_FACT(4), ['out']);
  if (r.error) throw new Error(r.error);
  if (r.vals.out === '24') throw new Error('fixed slots were re-entrant after all -- '
    + 'the ABI_NONREENTRANT warning would be wrong');
  if (r.vals.out !== '8') throw new Error(`expected the specific failure 8 (=2^3, every frame `
    + `reading the innermost __save), got ${r.vals.out}`);
});

check('fixed slots pass at depth 2 -- which is why this is dangerous', () => {
  // Only one frame ever needs its value preserved, and it is the last one
  // written. A depth-2 smoke test would have shipped this.
  const r = run(FIXED_FACT(2), ['out']);
  if (r.vals.out !== '2') throw new Error(`expected the misleading pass, got ${r.vals.out}`);
});

check('the same arithmetic is correct when written iteratively', () =>
  // Control: proves the failure is the ABI, not mul/subi/branching.
  expect(`li acc, 1
li i, 4
li one, 1
while i >= one:
  mul acc, acc, i
  subi i, i, 1
add out, acc, zr
`, ['out'], { out: 24 }, 'iterative'));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[3] Stack-based ABI -- recursion works');

check('a capability token can be built from CF source', () =>
  expect(CAP_PROLOGUE + `
li __sp, ${STACK_TOP}
li v, 1234
sts64 v, __cap, __sp
li v, 0
ld64 v, __cap, __sp
add out, v, zr
`, ['out'], { out: 1234 }, 'cap round trip'));

check('distinct slots stay distinct', () =>
  // The check that would have caught the address-aliasing bug immediately.
  expect(CAP_PROLOGUE + `
li p1, ${STACK_TOP}
li p2, ${STACK_TOP - 8}
li v, 777
sts64 v, __cap, p1
li v, 111
sts64 v, __cap, p2
ld64 a, __cap, p1
ld64 b, __cap, p2
add out, a, zr
add out2, b, zr
`, ['out', 'out2'], { out: 777, out2: 111 }, 'distinct slots'));

const STACK_FACT = n => CAP_PROLOGUE + `
li __sp, ${STACK_TOP}
li __arg0, ${n}
call fact()
add out, __ret0, zr
def fact():
  li __one, 1
  if __arg0 <= __one:
    li __ret0, 1
    return
  sts64 __arg0, __cap, __sp
  subi __sp, __sp, 8
  subi __arg0, __arg0, 1
  call fact()
  addi __sp, __sp, 8
  ld64 __save, __cap, __sp
  mul __ret0, __save, __ret0
`;

for (const [n, want] of [[1, 1], [2, 2], [3, 6], [4, 24], [5, 120], [8, 40320]]) {
  check(`stack ABI: fact(${n}) == ${want}`, () => expect(STACK_FACT(n), ['out'], { out: want }, `fact(${n})`));
}

check('stack ABI: accumulate down a recursion', () =>
  expect(CAP_PROLOGUE + `
li __sp, ${STACK_TOP}
li __arg0, 4
call cd()
add out, __ret0, zr
def cd():
  li __z, 0
  if __arg0 == __z:
    li __ret0, 0
    return
  sts64 __arg0, __cap, __sp
  subi __sp, __sp, 8
  subi __arg0, __arg0, 1
  call cd()
  addi __sp, __sp, 8
  ld64 __k, __cap, __sp
  add __ret0, __ret0, __k
`, ['out'], { out: 10 }, 'sum 4+3+2+1'));

check('the stack pointer is balanced across a call', () => {
  const r = expect(STACK_FACT(5) + `add spOut, __sp, zr\n`, ['out', 'spOut'],
    { out: 120, spOut: STACK_TOP }, 'sp balance');
  return r;
});

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[4] The engine bug this exposed -- capability address precision');
console.log('     sts64/ld64 computed Number(RD(cap)) + Number(RD(ptr)). A capability');
console.log('     token is ~8.23e18, where float64 spacing is 2048, so every 8-byte');
console.log('     slot aliased. Spilling silently returned wrong values.');

const spillSum = n => Array.from({ length: n }, (_, k) => `li v${k}, ${k + 1}`).join('\n')
  + '\nli sum, 0\n' + Array.from({ length: n }, (_, k) => `add sum, sum, v${k}`).join('\n') + '\n';

for (const n of [70, 90]) {
  check(`spilled values survive a store/reload round trip (n=${n})`, () => {
    const r = run(spillSum(n), ['sum']);
    if (r.error) throw new Error(r.error);
    if (!r.spilled.length) throw new Error(`premise gone: ${n} values no longer spill`);
    const want = String(n * (n + 1) / 2);
    if (r.vals.sum !== want) throw new Error(`sum = ${r.vals.sum}, expected ${want} `
      + `(${r.spilled.length} names spilled)`);
  });
}

check('a program with no spilling is unaffected', () => {
  const r = run(spillSum(30), ['sum']);
  if (r.spilled.length) throw new Error('premise gone: 30 values now spill');
  if (r.vals.sum !== '465') throw new Error(`sum = ${r.vals.sum}`);
});

check('the call stack does not collide with the spill region', () => {
  // Spill slots grow UP from 512; the call stack grows DOWN from 4088.
  // A recursive program that also spills must keep both intact.
  const depth = 6;
  const filler = Array.from({ length: 70 }, (_, k) => `li f${k}, ${k + 1}`).join('\n');
  const consume = 'li fsum, 0\n' + Array.from({ length: 70 }, (_, k) => `add fsum, fsum, f${k}`).join('\n');
  const r = run(CAP_PROLOGUE + `
li __sp, ${STACK_TOP}
${filler}
li __arg0, ${depth}
call fact()
add out, __ret0, zr
${consume}
add out2, fsum, zr
def fact():
  li __one, 1
  if __arg0 <= __one:
    li __ret0, 1
    return
  sts64 __arg0, __cap, __sp
  subi __sp, __sp, 8
  subi __arg0, __arg0, 1
  call fact()
  addi __sp, __sp, 8
  ld64 __save, __cap, __sp
  mul __ret0, __save, __ret0
`, ['out', 'out2']);
  if (r.error) throw new Error(r.error);
  if (r.vals.out !== '720') throw new Error(`fact(6) = ${r.vals.out}, expected 720 `
    + `(spilled ${r.spilled.length})`);
  if (r.vals.out2 !== '2485') throw new Error(`spill checksum = ${r.vals.out2}, expected 2485`);
});

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[5] Limits worth knowing');

check('recursion depth is bounded by the dmem stack', () => {
  // 4KB region, 8 bytes per frame, minus the spill area: a few hundred
  // frames. Deep recursion is a real limit, not an abstract one.
  const r = run(STACK_FACT(20), ['out']);
  if (r.error) throw new Error(r.error);
  // 20! overflows int64 -- the point here is that it RUNS, and wraps the
  // same way the hardware would, rather than faulting.
  if (r.vals.out === '<spilled>') throw new Error('output spilled');
});

check('a zero-arg call still works (the ABI is optional)', () =>
  expect(`call k()
add out, __ret0, zr
def k():
  li __ret0, 99
`, ['out'], { out: 99 }, 'zero-arg'));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[6] Mutual recursion and forward references (via the lowerer)');
{
  const { wordParse } = require(path.join(HERE, 'word_kh.js'));
  const { lowerUAST } = require(path.join(HERE, 'ivx_lower.js'));
  const CTX = { regDepth: 64, imemBudget: 16384, outputMode: 'liveout', engine: E };

  const runKH = async (src) => {
    const lo = await lowerUAST(wordParse(src), CTX);
    const hard = lo.diagnostics.filter(d => d.severity === 'refuse');
    if (hard.length) throw new Error(`refused: ${hard.map(d => d.code).join(', ')}`);
    const outs = lo.outputs.map(o => o.name);
    const s2 = E.stage2Allocate(lo.text, false, outs);
    const comp = E.compileCFSource(s2.raw2, false, false);
    const sim = E.simulateProgram(E.substituteSymbolicNames(comp.text, s2.mapping), 4000000, 64);
    if (sim.error) throw new Error(sim.error);
    return {
      lo, s2,
      vals: outs.map(o => s2.mapping[o] === undefined ? '<spilled>'
        : BigInt.asIntN(64, sim.reg[s2.mapping[o]]).toString()),
      savesPerFrame: (lo.text.match(/sts64 \S+, __cap, __sp/g) || []).length,
    };
  };

  const cases = {
    // A call can precede its `fun`. Works by construction: function bodies
    // are emitted after main, so every name is registered before any body
    // is lowered -- and cfLinkCalls resolves eagerly anyway.
    forward_ref: ['fun f(n)\n    make s g(n)\n    give s + 1\nfun g(n)\n    give n * 10\nmake r f(3)\nprint r\n', ['31']],
    mutual_even: ['fun ev(n)\n    if n = 0\n        give 1\n    make m n - 1\n    make s od(m)\n    give s\nfun od(n)\n    if n = 0\n        give 0\n    make m n - 1\n    make s ev(m)\n    give s\nmake a ev(6)\nmake b ev(7)\nprint a\nprint b\n', ['1', '0']],
    cycle_of_three: ['fun a(n)\n    if n = 0\n        give 0\n    make m n - 1\n    make s b(m)\n    give s + 1\nfun b(n)\n    if n = 0\n        give 0\n    make m n - 1\n    make s c(m)\n    give s + 1\nfun c(n)\n    if n = 0\n        give 0\n    make m n - 1\n    make s a(m)\n    give s + 1\nmake r a(9)\nprint r\n', ['9']],
    mutual_accum: ['fun p(n)\n    if n <= 0\n        give 0\n    make m n - 1\n    make s q(m)\n    give s + n\nfun q(n)\n    if n <= 0\n        give 0\n    make m n - 1\n    make s p(m)\n    give s + n\nmake r p(6)\nprint r\n', ['21']],
  };
  for (const [name, [src, want]] of Object.entries(cases)) {
    check(name, async () => {
      const r = await runKH(src);
      if (JSON.stringify(r.vals) !== JSON.stringify(want)) {
        throw new Error(`got ${JSON.stringify(r.vals)}, expected ${JSON.stringify(want)}`);
      }
    });
  }

  console.log('\n[7] Caller-saves: load-bearing, and no heavier than it must be');

  check('stripping the saves breaks recursion (they are load-bearing)', async () => {
    const src = 'fun f(n)\n    if n <= 1\n        give 1\n    make m n - 1\n    make s f(m)\n    give n * s\nmake r f(5)\nprint r\n';
    const lo = await lowerUAST(wordParse(src), CTX);
    const outs = lo.outputs.map(o => o.name);
    const stripped = lo.text.split('\n')
      .filter(l => !/^\s*(sts64|ld64) /.test(l) && !/^\s*(subi|addi) __sp, __sp, 8$/.test(l))
      .join('\n');
    const s2 = E.stage2Allocate(stripped, false, outs);
    const comp = E.compileCFSource(s2.raw2, false, false);
    const sim = E.simulateProgram(E.substituteSymbolicNames(comp.text, s2.mapping), 400000, 64);
    const got = sim.error ? 'error' : BigInt.asIntN(64, sim.reg[s2.mapping[outs[0]]]).toString();
    if (got === '120') throw new Error('recursion still worked without any saves -- '
      + 'the caller-saves machinery is not doing anything');
  });

  // Liveness-driven, with kill-tracking. The first version saved every
  // local unconditionally (3 per frame for fact), the second missed kills
  // (2 per frame). These numbers are the floor for this shape, so a
  // regression that re-broadens the save set shows up here as a number,
  // not as a vague slowdown.
  const SAVE_BUDGET = {
    'fun f(n)\n    if n <= 1\n        give 1\n    make m n - 1\n    make s f(m)\n    give n * s\nmake r f(5)\nprint r\n': 1,
    'fun fb(n)\n    if n <= 1\n        give n\n    make a n - 1\n    make x fb(a)\n    make b n - 2\n    make y fb(b)\n    give x + y\nmake r fb(8)\nprint r\n': 2,
  };
  let bi = 0;
  for (const [src, budget] of Object.entries(SAVE_BUDGET)) {
    const label = ['fact', 'fib'][bi++];
    check(`${label}: saves no more than ${budget} value(s) per frame`, async () => {
      const r = await runKH(src);
      if (r.savesPerFrame > budget) {
        throw new Error(`${r.savesPerFrame} saves emitted, budget ${budget} -- `
          + `the liveness analysis has re-broadened`);
      }
    });
  }

  check('a call inside a loop saves conservatively (back edge)', async () => {
    // "Later in the text" is the wrong question inside a loop, so anything
    // read anywhere in the loop is saved. Correctness over economy here.
    const r = await runKH('fun d(x)\n    give x * 2\nfun t(n)\n    make s 0\n    make i 0\n    loop i < n\n        make v d(i)\n        make s s + v\n        make i i + 1\n    give s\nmake r t(5)\nprint r\n');
    if (r.vals[0] !== '20') throw new Error(`got ${r.vals[0]}, expected 20`);
  });

  console.log('\n[8] Recursion depth is bounded by dmem -- and the simulator will not tell you');
  // Usable stack is (dmem - 8 - SPILL_BASE_ADDR) bytes, so the frame limit
  // is that over 8 * saves-per-frame. Past it, __sp runs below the
  // capability base. The simulator does not bounds-check capabilities, so
  // it keeps going and returns the RIGHT answer; real hardware would trap.
  // That is a simulator/hardware divergence, not a passing test.
  const CAPBASE = 1 << 16;   // the stack capability's low 32 bits: idx | gen<<16
  const minOffsetFor = async (depth) => {
    const src = `fun f(n)\n    if n <= 1\n        give 1\n    make m n - 1\n    make s f(m)\n    give n + s\nmake r f(${depth})\nprint r\n`;
    const lo = await lowerUAST(wordParse(src), CTX);
    const outs = lo.outputs.map(o => o.name);
    const s2 = E.stage2Allocate(lo.text, false, outs);
    const comp = E.compileCFSource(s2.raw2, false, false);
    const sim = E.simulateProgram(E.substituteSymbolicNames(comp.text, s2.mapping), 4000000, 64);
    if (sim.error) throw new Error(sim.error);
    const offs = [...sim.mem.keys()].map(k => k - CAPBASE);
    return { min: Math.min(...offs), got: BigInt.asIntN(64, sim.reg[s2.mapping[outs[0]]]).toString() };
  };

  check('shallow recursion stays inside dmem', async () => {
    const r = await minOffsetFor(50);
    if (r.got !== '1275') throw new Error(`wrong result ${r.got}`);
    if (r.min < E.SPILL_BASE_ADDR) throw new Error(`reached offset ${r.min}, inside the spill region`);
  });
  check('deep recursion runs off the end of dmem, silently', async () => {
    const r = await minOffsetFor(600);
    if (r.min >= 0) throw new Error(`premise gone: depth 600 now stays within dmem (min ${r.min})`);
    if (r.got !== '180300') throw new Error(`wrong result ${r.got}`);
    // The point: the answer is CORRECT and the program overran memory.
  });

  console.log('\n[9] Recursion coexisting with heavy spilling');
  for (const nf of [70, 200]) {
    check(`recursion + ${nf} spilling locals`, async () => {
      const filler = Array.from({ length: nf }, (_, k) => `make z${k} ${k + 1}`).join('\n');
      const consume = 'make zs 0\n' + Array.from({ length: nf }, (_, k) => `make zs zs + z${k}`).join('\n');
      const src = `fun f(n)\n    if n <= 1\n        give 1\n    make m n - 1\n    make s f(m)\n    give n + s\n${filler}\nmake r f(10)\n${consume}\nprint r\nprint zs\n`;
      const r = await runKH(src);
      if (!r.s2.spilled.length) throw new Error(`premise gone: ${nf} locals no longer spill`);
      if (r.vals[0] !== '55') throw new Error(`recursion result ${r.vals[0]}, expected 55`);
      const wantZ = String(nf * (nf + 1) / 2);
      if (r.vals[1] !== wantZ) throw new Error(`spill checksum ${r.vals[1]}, expected ${wantZ} `
        + `-- the call stack and the spill region collided`);
    });
  }
}

(async () => {
  for (const t of queue) await t();
  console.log('\n' + '='.repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`)); process.exit(1); }
})();
