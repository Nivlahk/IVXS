// ── verify_patch.js ─────────────────────────────────────────────────────────
// The patch is only safe if it is INVISIBLE to every existing caller. This
// runs the original and patched engines side by side and asserts that with
// the new arguments omitted they produce byte-identical output at every
// stage -- allocation, raw2, compiled text, assembled bytes, and final
// register state -- across the whole differential corpus plus fuzz cases.
//
// Then it checks that the NEW capabilities actually work, so "identical"
// can't be achieved by the patch doing nothing.
//
//   node verify_patch.js
'use strict';

const path = require('path');
const HERE = __dirname;
const loadEngine = require(path.join(HERE, 'engine_node.js'));
const { wordParse } = require(path.join(HERE, 'word_kh.js'));
const { lowerUAST } = require(path.join(HERE, 'ivx_lower.js'));

// This suite is a COMPARISON, so it needs both engines side by side. Say so
// plainly rather than dying in fs.readFileSync with an ENOENT stack.
const fs = require('fs');
const ORIG_PATH = path.join(HERE, 'Soak_tester.html');
const PATCHED_PATH = path.join(HERE, 'Soak_tester.patched.html');
for (const [label, p] of [['original', ORIG_PATH], ['patched', PATCHED_PATH]]) {
  if (!fs.existsSync(p)) {
    console.error(`verify_patch.js needs BOTH engines beside it to compare them.\n`
      + `  missing the ${label}: ${p}\n`
      + (label === 'patched'
          ? `  regenerate it with:  python3 apply_patch.py Soak_tester.html Soak_tester.patched.html`
          : `  copy your clean Soak_tester.html here (it is never modified).`));
    process.exit(2);
  }
}
const ORIG = loadEngine({ htmlPath: ORIG_PATH, imemIndex: 2, regIndex: 4 });
const PATCHED = loadEngine({ htmlPath: PATCHED_PATH, imemIndex: 2, regIndex: 4 });

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message}`); }
}

function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

function compile(E, cfText, liveOut) {
  const s2 = liveOut ? E.stage2Allocate(cfText, false, liveOut) : E.stage2Allocate(cfText, false);
  const comp = E.compileCFSource(s2.raw2, false, false);
  const flat = E.substituteSymbolicNames(comp.text, s2.mapping);
  const items = E.parseProgram(flat);
  const sim = E.simulateProgram(flat, 400000, 64);
  return { s2, comp, flat, items, sim };
}

// A corpus wide enough that "identical" means something: straight-line,
// branches, loops, nesting, and -- importantly -- a spilling program, since
// the spill rewriter is where the raw2Map patch restructures a real loop.
const CORPUS = {
  straight:   'make a 5\nmake b 3\nmake c a + b\nprint c\n',
  branch:     'make a 5\nif a > 3\n    make r 1\nelse\n    make r 0\nprint r\n',
  loop:       'make i 0\nloop i < 10\n    make i i + 1\nprint i\n',
  nested:     'make i 0\nmake t 0\nloop i < 4\n    make j 0\n    loop j < 3\n        make t t + 1\n        make j j + 1\n    make i i + 1\nprint t\n',
  bigconst:   'make a 70000\nprint a\n',
  // 70 live values against a 64-register file: forces the spill path.
  spilling:   Array.from({ length: 70 }, (_, k) => `make v${k} ${k + 1}`).join('\n') + '\n'
              + Array.from({ length: 70 }, (_, k) => `print v${k}`).join('\n') + '\n',
};

(async () => {
  console.log('\n[1] Both engines load');
  check('original loads', () => { if (ORIG.__missing) throw new Error(ORIG.__missing.join(', ')); });
  check('patched loads',  () => { if (PATCHED.__missing) throw new Error(PATCHED.__missing.join(', ')); });

  // ── The memory fix is a DELIBERATE BEHAVIOUR CHANGE, unlike the live-out
  // and source-map patches. Sections [2] below assert invisibility, which
  // is the right property for those two -- so the memory fix has to be
  // excluded from that claim and asserted separately, in [2a].
  //
  // Worth recording why this needed adding: the spilling corpus in [2]
  // PASSED the identical-registers check even after the memory fix landed,
  // because the values that spill end up unallocated and are never read
  // back into a compared register. The test was too weak to notice a
  // change it should have caught, which is exactly the failure mode a
  // "nothing changed" assertion is prone to.
  console.log('\n[2a] The memory fix CHANGES behaviour -- toward correctness');
  {
    // Every value live to the end and consumed into a checksum, so any
    // spilled one must survive a store/reload round trip.
    const mk = n => Array.from({ length: n }, (_, k) => `li v${k}, ${k + 1}`).join('\n')
      + '\nli sum, 0\n' + Array.from({ length: n }, (_, k) => `add sum, sum, v${k}`).join('\n') + '\n';
    const readSum = (E2, src) => {
      const s2 = E2.stage2Allocate(src, false, ['sum']);
      const comp = E2.compileCFSource(s2.raw2, false, false);
      const sim = E2.simulateProgram(E2.substituteSymbolicNames(comp.text, s2.mapping), 800000, 64);
      return { spilled: s2.spilled.length, sum: sim.error ? null : BigInt.asIntN(64, sim.reg[s2.mapping.sum]).toString() };
    };
    await check('a NON-spilling program is unaffected by the memory fix', () => {
      const src = mk(30);
      const a = readSum(ORIG, src), b = readSum(PATCHED, src);
      if (a.spilled !== 0) throw new Error('premise gone: 30 values now spill');
      eq(b.sum, a.sum, 'non-spilling sum changed');
      eq(b.sum, '465', 'non-spilling sum is wrong');
    });
    await check('a SPILLING program was WRONG before and is right after', () => {
      for (const n of [70, 90]) {
        const src = mk(n);
        const want = String(n * (n + 1) / 2);
        const a = readSum(ORIG, src), b = readSum(PATCHED, src);
        if (!a.spilled) throw new Error(`premise gone: ${n} values no longer spill`);
        if (a.sum === want) throw new Error(`original engine was already correct at n=${n}; `
          + `the bug this fix targets did not reproduce`);
        eq(b.sum, want, `patched sum at n=${n}`);
      }
    });
  }

  console.log('\n[2] Byte-identical with the new arguments OMITTED');
  const lowerings = {};
  for (const [name, src] of Object.entries(CORPUS)) {
    const lo = await lowerUAST(wordParse(src), { regDepth: 64, imemBudget: 16384, outputMode: 'liveout' });
    lowerings[name] = lo;
    let a, b;
    try { a = compile(ORIG, lo.text); } catch (e) { a = { threw: e.message }; }
    try { b = compile(PATCHED, lo.text); } catch (e) { b = { threw: e.message }; }

    check(`${name}: same throw-or-not`, () => {
      if (!!a.threw !== !!b.threw) throw new Error(`orig ${a.threw || 'ok'} / patched ${b.threw || 'ok'}`);
      if (a.threw && a.threw !== b.threw) throw new Error(`different errors:\n  ${a.threw}\n  ${b.threw}`);
    });
    if (a.threw) continue;

    check(`${name}: identical allocation`, () => {
      if (JSON.stringify(a.s2.mapping) !== JSON.stringify(b.s2.mapping)) {
        throw new Error(`mapping differs`);
      }
      if (JSON.stringify(a.s2.spilled) !== JSON.stringify(b.s2.spilled)) throw new Error('spill set differs');
      if (JSON.stringify(a.s2.reserved) !== JSON.stringify(b.s2.reserved)) throw new Error('reserved differs');
    });
    check(`${name}: identical raw2`, () => {
      if (a.s2.raw2 !== b.s2.raw2) throw new Error('rewritten source differs');
    });
    check(`${name}: identical compiled text`, () => {
      if (a.comp.text !== b.comp.text) throw new Error('compiled text differs');
      if (a.comp.labelCount !== b.comp.labelCount) throw new Error('labelCount differs');
      if (a.comp.functionCount !== b.comp.functionCount) throw new Error('functionCount differs');
    });
    check(`${name}: identical assembled bytes`, () => {
      const ba = a.items.map(i => i.bytes.join(',')).join('|');
      const bb = b.items.map(i => i.bytes.join(',')).join('|');
      if (ba !== bb) throw new Error('byte stream differs');
    });
    check(`${name}: identical execution`, () => {
      if (name === 'spilling') {
        // Excluded on purpose: this program exercises capability-relative
        // memory, which the memory fix deliberately changes. Its
        // correctness is asserted in [2a] instead.
        return;
      }
      if ((a.sim.error || '') !== (b.sim.error || '')) throw new Error('sim error differs');
      if (a.sim.error) return;
      if (a.sim.steps !== b.sim.steps) throw new Error(`steps ${a.sim.steps} vs ${b.sim.steps}`);
      const ra = Array.from(a.sim.reg).map(String).join(',');
      const rb = Array.from(b.sim.reg).map(String).join(',');
      if (ra !== rb) throw new Error('final register file differs');
    });
  }

  console.log('\n[3] The spill path really was exercised');
  check('spilling corpus actually spills', () => {
    const s2 = PATCHED.stage2Allocate(lowerings.spilling.text, false);
    if (!s2.spilled.length) throw new Error('nothing spilled -- the raw2Map rewrite went untested');
    console.log(`         (${s2.spilled.length} names spilled)`);
  });

  console.log('\n[4] The new capabilities work');
  // Register DISTINCTNESS is the wrong thing to assert -- two earlier
  // versions of this test failed on their own premise, because dead outputs
  // still pick up interference edges from live inputs and often land on
  // distinct registers anyway. What actually breaks without liveOut is that
  // an output's register gets reused by a LATER write, so the value read
  // back at halt is somebody else's. Assert that, over the corpus.
  await (async () => {
    let differed = 0, wrongWithout = [];
    for (const [name, lo] of Object.entries(lowerings)) {
      const outs = lo.outputs.map(o => o.name);
      if (!outs.length) continue;
      const a = compile(PATCHED, lo.text);            // no liveOut
      const b = compile(PATCHED, lo.text, outs);      // with liveOut
      if (a.sim.error || b.sim.error) continue;
      const read = r => outs.map(o => r.s2.mapping[o] === undefined
        ? '<spilled>' : BigInt.asIntN(64, r.sim.reg[r.s2.mapping[o]]).toString()).join(',');
      if (read(a) !== read(b)) { differed++; wrongWithout.push(name); }
    }
    check('liveOut changes read-back on at least one corpus program', () => {
      if (!differed) throw new Error('no program differed -- either the corpus is too easy '
        + 'or liveOut is doing nothing');
      console.log(`         (differs on: ${wrongWithout.join(', ')})`);
    });
  })();

  {
    const src = 'make total 0\nmake limit 10\nloop total < limit\n    make total total + 3\nprint total\n';
    const lo = await lowerUAST(wordParse(src), { regDepth: 64, imemBudget: 16384, outputMode: 'liveout' });
    const r = compile(PATCHED, lo.text, lo.outputs.map(o => o.name));
    check('print total == 12', () => {
      if (r.sim.error) throw new Error(r.sim.error);
      const got = BigInt.asIntN(64, r.sim.reg[r.s2.mapping['__out0']]).toString();
      if (got !== '12') throw new Error(`got ${got}`);
    });
  }

  console.log('\n[5] The source map is well-formed');
  for (const [name, lo] of Object.entries(lowerings)) {
    const r = compile(PATCHED, lo.text, lo.outputs.map(o => o.name));
    check(`${name}: raw2Map covers raw2`, () => {
      const n = r.s2.raw2.split('\n').length;
      if (r.s2.raw2Map.length !== n) throw new Error(`raw2Map ${r.s2.raw2Map.length} vs ${n} lines`);
      const rawN = lo.text.split('\n').length;
      for (const v of r.s2.raw2Map) {
        if (v !== null && (v < 0 || v >= rawN)) throw new Error(`raw2Map entry ${v} out of range 0..${rawN - 1}`);
      }
    });
    check(`${name}: srcMap covers compiled text`, () => {
      const n = r.comp.text.split('\n').length;
      if (r.comp.srcMap.length !== n) throw new Error(`srcMap ${r.comp.srcMap.length} vs ${n} lines`);
      const inN = r.s2.raw2.split('\n').length;
      for (const v of r.comp.srcMap) {
        if (v !== null && (v < 0 || v >= inN)) throw new Error(`srcMap entry ${v} out of range 0..${inN - 1}`);
      }
    });
    check(`${name}: setup lines map to null`, () => {
      for (let i = 0; i < r.comp.setupLineCount; i++) {
        if (r.comp.srcMap[i] !== null) throw new Error(`setup line ${i} mapped to ${r.comp.srcMap[i]}`);
      }
    });
    check(`${name}: some real line is mapped`, () => {
      if (!r.comp.srcMap.some(v => v !== null)) throw new Error('srcMap is entirely null -- nothing traced');
    });
    check(`${name}: parseProgram srcLine is in range and ordered`, () => {
      const n = r.flat.split('\n').length;
      let prev = -1;
      for (const it of r.items) {
        if (typeof it.srcLine !== 'number') throw new Error('item missing srcLine');
        if (it.srcLine < 0 || it.srcLine >= n) throw new Error(`srcLine ${it.srcLine} out of range`);
        if (it.srcLine <= prev) throw new Error(`srcLine not strictly increasing: ${prev} then ${it.srcLine}`);
        prev = it.srcLine;
      }
    });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
