// ── run_tests.js ────────────────────────────────────────────────────────────
// Everything that can be verified WITHOUT Soak_tester.html.
//
// The one thing missing is the differential: lower a program, run it
// through the real stage2Allocate -> compileCFSource -> simulateProgram
// pipeline, and cross-check the register file at halt against the same
// program executed by KH's own interpreter. That needs Soak_tester.html
// (and core.js for the KH side). conformanceCheck() in the contract is
// already written for it; drop the files in and set ENGINE below.
//
//   node run_tests.js
'use strict';

const path = require('path');
const HERE = __dirname;
const { wordParse } = require(path.join(HERE, 'word_kh.js'));
const { lowerUAST, checkOpTable, SEER_OPS } = require(path.join(HERE, 'ivx_lower.js'));
const C = require(path.join(HERE, 'ivx_lower_contract.js'));
const A = require(path.join(HERE, 'ivx_altitude.js'));
const R = require(path.join(HERE, 'ivx_resolve.js'));

let pass = 0, fail = 0;
const failures = [];
// Async-aware. The first version called fn() without awaiting, so an async
// test's rejection escaped as an unhandled rejection AFTER the summary had
// already printed "0 failed" -- async failures were being missed entirely,
// which is exactly how a genuinely broken test sat green. Async checks are
// queued and awaited by flushAsyncChecks() before the summary prints.
const asyncChecks = [];
function check(name, fn) {
  let r;
  try { r = fn(); }
  catch (e) {
    fail++; failures.push({ name, error: e.message });
    console.log(`  FAIL ${name}\n         ${e.message}`);
    return;
  }
  if (r && typeof r.then === 'function') {
    asyncChecks.push(
      r.then(() => { pass++; console.log(`  ok   ${name}`); })
       .catch(e => {
         fail++; failures.push({ name, error: e.message });
         console.log(`  FAIL ${name}\n         ${e.message}`);
       })
    );
    return;
  }
  pass++; console.log(`  ok   ${name}`);
}
async function flushAsyncChecks() { await Promise.all(asyncChecks.splice(0)); }
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function throws(fn, needle, what) {
  try { fn(); } catch (e) {
    if (needle && !e.message.includes(needle)) throw new Error(`${what}: threw but not about "${needle}" -- ${e.message}`);
    return;
  }
  throw new Error(`${what}: expected a throw, got none`);
}

// outputMode 'liveout': the integrated engine takes a live-out set, so the
// sink epilogue is unnecessary. Falls back gracefully when unpatched --
// the lowering is identical either way apart from those extra lines.
const CTX = { metaCF: false, capabilityDiscipline: false, regDepth: 64,
              imemBudget: 16384, outputMode: 'liveout' };
// Function lowering needs the engine's STACK_CAP_* constants for the call-
// stack prologue; attached in section [10] once the engine is loaded.

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[1] Phase 1 -- specifier classification');
check('bare name is ambiguous, not guessed', () => {
  eq(R.classifySpecifier('pandas').kind, 'ambiguous', 'pandas');
  eq(R.classifySpecifier('six').kind, 'ambiguous', 'six');
});
check('explicit prefixes and scopes resolve', () => {
  eq(R.classifySpecifier('npm:lodash').kind, 'npm', 'npm:');
  eq(R.classifySpecifier('pypi:six').kind, 'pypi', 'pypi:');
  eq(R.classifySpecifier('@scope/pkg').kind, 'npm', 'scoped');
});
check('domain-shaped path is a go module', () => {
  const g = R.classifySpecifier('github.com/foo/bar@v1.2.3');
  eq([g.kind, g.name, g.version], ['go', 'github.com/foo/bar', 'v1.2.3'], 'go');
});
check('version pinning across both syntaxes', () => {
  eq(R.classifySpecifier('lodash@4.17.21').version, '4.17.21', 'npm @');
  eq(R.classifySpecifier('pandas==2.0.0').version, '2.0.0', 'pypi ==');
});

console.log('\n[2] Phase 1 -- magic-byte sniffing');
check('zip / gzip / wasm / json / html', () => {
  eq(R.sniffBytes(new Uint8Array([0x50,0x4B,0x03,0x04])).fmt, 'zip', 'zip');
  eq(R.sniffBytes(new Uint8Array([0x1F,0x8B,0,0])).fmt, 'gzip', 'gzip');
  eq(R.sniffBytes(new Uint8Array([0x00,0x61,0x73,0x6D])).runtimeHint, 'wasm', 'wasm');
  eq(R.sniffBytes(new TextEncoder().encode('{"a":1}')).fmt, 'json', 'json');
  eq(R.sniffBytes(new TextEncoder().encode('<!DOCTYPE html>')).fmt, 'html', 'html');
});

console.log('\n[3] Phase 1 -- runtime signature detection');
check('detects each language it claims to', () => {
  const s = t => R.signatureDetect(t).runtime;
  eq(s('import os\ndef main():\n    pass\nif __name__ == "__main__":\n    main()\n'), 'python', 'python');
  eq(s('import x from "y";\nexport const f = () => 1;\n'), 'js', 'js');
  eq(s('package main\n\nfunc main() {\n\tx := 1\n}\n'), 'go', 'go');
  eq(s('make total 0\nsay "hi"\nfun add\n  give 1\n'), 'ivx', 'ivx');
});
check('REFUSES rather than guessing on junk and on ties', () => {
  eq(R.signatureDetect('aaaa bbbb\n').runtime, 'unknown', 'junk');
  eq(R.signatureDetect('').runtime, 'unknown', 'empty');
});

console.log('\n[4] Phase 1 -- manifest parsing');
check('go.mod including a block require', () => {
  const g = R.parseGoMod('module github.com/a/b\n\ngo 1.21\n\nrequire (\n\tx/y v1.0.0\n\tp/q v2.0.0 // indirect\n)\n');
  eq([g.module, g.go, g.requires.length], ['github.com/a/b', '1.21', 2], 'go.mod');
});
check('pyproject.toml subset incl. multiline array', () => {
  const t = R.parseTomlSubset('[project]\nname = "demo"\ndependencies = [\n "numpy",\n "requests",\n]\n');
  eq(t.project.name, 'demo', 'name');
  eq(t.project.dependencies, ['numpy', 'requests'], 'deps');
});
check('wheel METADATA repeated keys become arrays', () => {
  const m = R.parseWheelMetadata('Name: six\nVersion: 1.0\nClassifier: A\nClassifier: B\n');
  eq(m.Name, 'six', 'Name');
  eq(m.Classifier, ['A', 'B'], 'repeated');
});

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[4b] Phase 1 -- relative dependency path resolution');
check('normalizePath collapses . and ..', () => {
  eq(R.normalizePath('a/./b'), 'a/b', 'dot');
  eq(R.normalizePath('a/b/../c'), 'a/c', 'dotdot');
  eq(R.normalizePath('./x'), 'x', 'leading dot');
  // Escaping above the root collapses to nothing -- the walker treats that
  // as "refuse" rather than climbing out of the entry's directory tree.
  eq(R.normalizePath('../../etc/passwd'), 'etc/passwd', 'escape collapses');
});
check('dirnameOf handles nested and bare paths', () => {
  eq(R.dirnameOf('a/b/c.js'), 'a/b', 'nested');
  eq(R.dirnameOf('c.js'), '', 'bare');
});
check('walkRelativeDeps is bounded by maxFiles', async () => {
  // No network: a fake fetch serving an infinite chain of requires. Without
  // a cap this would never terminate.
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => `require('./next${Math.random().toString(36).slice(2,8)}');`,
  });
  const r = await R.walkRelativeDeps('https://example.invalid/entry.js',
    "require('./a');", { limits: { maxFiles: 5, maxDepth: 50 }, fetchImpl });
  if (r.fetched > 5) throw new Error(`fetched ${r.fetched}, cap was 5`);
  if (!r.truncated) throw new Error('hit the cap but did not report truncation');
});
check('walkRelativeDeps reports a depth cap', async () => {
  let n = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => `require('./d${n++}');` });
  const r = await R.walkRelativeDeps('https://example.invalid/entry.js',
    "require('./a');", { limits: { maxFiles: 500, maxDepth: 3 }, fetchImpl });
  if (!r.truncated) throw new Error('hit the depth cap but did not report it');
});

console.log('\n[4b] Phase 1 -- python sibling import walking');
check('walkPythonDeps follows siblings and skips stdlib', async () => {
  // Fake fetch: a.py imports b (a sibling) and os/json (stdlib, must be
  // skipped). Stdlib skipping is free -- os.py does not exist next to the
  // entry, so the fetch 404s and Pyodide resolves it normally at runtime.
  const served = { 'https://example.invalid/pkg/b.py': 'VALUE = 1\n' };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (served[u]) return { ok: true, status: 200, text: async () => served[u] };
    return { ok: false, status: 404, text: async () => '' };
  };
  const r = await R.walkPythonDeps('https://example.invalid/pkg/a.py',
    'import os\nimport json\nfrom b import VALUE\n', { fetchImpl });
  eq(r.entryName, 'a', 'entry name');
  eq(Object.keys(r.files).sort(), ['a.py', 'b.py'], 'fetched files');
  if (r.truncated) throw new Error('unexpectedly truncated');
});
check('walkPythonDeps respects the file cap', async () => {
  // The fake must chain m0 -> m1 -> m2 based on the REQUESTED url. An
  // earlier version used a bare counter, which made m0's source import m0
  // itself -- already-seen, so the walk stopped at depth 1 and the cap was
  // never exercised. That test passed for the wrong reason.
  const fetchImpl = async (url) => {
    const m = /m(\d+)\.py$/.exec(String(url));
    if (!m) return { ok: false, status: 404, text: async () => '' };
    const next = Number(m[1]) + 1;
    return { ok: true, status: 200, text: async () => `from m${next} import x\n` };
  };
  const r = await R.walkPythonDeps('https://example.invalid/e.py', 'from m0 import x\n',
    { limits: { maxFiles: 4, maxDepth: 50 }, fetchImpl });
  const n = Object.keys(r.files).length;
  if (n > 4) throw new Error(`fetched ${n}, cap was 4`);
  if (n < 2) throw new Error(`only fetched ${n} -- the chain did not walk, cap untested`);
  if (!r.truncated) throw new Error('hit the cap without reporting truncation');
});

console.log('\n[4c] ivx_worker_runtime.js template integrity');
check('no stray backtick inside the String.raw worker template', () => {
  // The worker source is a String.raw`...` template. A backtick anywhere
  // inside it -- including in a COMMENT -- silently terminates the literal
  // and turns the rest of the file into garbage. This has now bitten four
  // separate times while editing comments in that region, each time only
  // caught by a later syntax error with a confusing message. Cheap to
  // check, so check it.
  const src = require('fs').readFileSync(path.join(HERE, 'ivx_worker_runtime.js'), 'utf8');
  const open = src.indexOf('String.raw`');
  if (open < 0) throw new Error('String.raw template not found -- has the file been restructured?');
  const bodyStart = open + 'String.raw`'.length;
  const close = src.indexOf('\n`;', bodyStart);
  if (close < 0) throw new Error('template close not found');
  const body = src.slice(bodyStart, close);
  if (body.includes('`')) {
    const line = src.slice(0, bodyStart + body.indexOf('`')).split('\n').length;
    throw new Error(`backtick inside the worker template at line ${line} -- it terminates the literal early`);
  }
});

console.log('\n[5] Phase 2 -- contract invariants catch what they claim to');
check('non-total map is rejected', () => {
  throws(() => C.assertMapTotal({ lines: ['a', 'b'], map: [{ uastId: 'x', cfStart: 0, cfEnd: 0 }] }),
    'not total', 'uncovered line');
});
check('double-covered line is rejected', () => {
  throws(() => C.assertMapTotal({ lines: ['a'], map: [
    { uastId: 'x', cfStart: 0, cfEnd: 0 }, { uastId: 'y', cfStart: 0, cfEnd: 0 }] }),
    'double-covers', 'double cover');
});
check('physical register emission is rejected', () => {
  throws(() => C.assertNoPhysicalRegs({ lines: ['addi r7, r7, 1'], map: [] }),
    'physical register', 'rN');
});
check('use/lend are allowed exceptions', () => {
  C.assertNoPhysicalRegs({ lines: ['use r3:', 'call f() lend r1, r2'], map: [] });
});
check('compound and literal-operand conditions are rejected', () => {
  throws(() => C.assertConditionsLowered({ lines: ['if x == 5 and y == 2:'], map: [] }), 'compound', 'and');
  throws(() => C.assertConditionsLowered({ lines: ['if x == 5:'], map: [] }), 'literal operand', 'literal');
});
check('out-of-range subi immediate is rejected (the silent-wrap case)', () => {
  throws(() => C.assertImmediatesInRange({ lines: ['subi a, b, 136'], map: [] }), 'outside', '136');
  C.assertImmediatesInRange({ lines: ['subi a, b, 127', 'addi a, b, -128'], map: [] });
});

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[6] Phase 2 -- real lowerings satisfy every invariant');
const PROGRAMS = {
  counted_loop: 'make total 0\nmake limit 10\nloop total < limit\n    make total total + 3\nprint total\n',
  and_else:     'make a 5\nmake b 2\nif a > 3 and b < 9\n    make r 1\nelse\n    make r 0\nprint r\n',
  or_chain:     'make a 2\nif a = 1 or a = 2\n    make r 7\nprint r\n',
  big_imm:      'make x 0\nmake y x + 500\nprint y\n',
  nested:       'make i 0\nloop i < 4\n    if i = 2\n        make hit 1\n    make i i + 1\nprint hit\n',
};
const lowered = {};

(async () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    const r = await lowerUAST(wordParse(src), CTX);
    lowered[name] = { r, src };
    check(`${name}: map total`,        () => C.assertMapTotal(r));
    check(`${name}: no physical regs`, () => C.assertNoPhysicalRegs(r));
    check(`${name}: conditions legal`, () => C.assertConditionsLowered(r));
    check(`${name}: immediates fit`,   () => C.assertImmediatesInRange(r));
  }

  console.log('\n[6b] Register-namespace collision');
  // A user variable named r0 is indistinguishable from physical register 0:
  // stage2Allocate does not allocate it and substituteSymbolicNames leaves
  // it alone, so it silently collides with whatever the allocator puts
  // there. Found by the function fuzzer generating r0/r1/r2 as variable
  // names. Colliding names are mangled; ordinary ones are untouched.
  for (const [name, src] of Object.entries({
    reg_shaped:  'make r0 5\nmake r1 7\nmake t r0 + r1\nprint t\n',
    zr_shaped:   'make zr 7\nmake t zr + 1\nprint t\n',
  })) {
    const r = await lowerUAST(wordParse(src), CTX);
    check(`${name}: no physical register escapes`, () => C.assertNoPhysicalRegs(r));
    check(`${name}: map still total`, () => C.assertMapTotal(r));
  }
  check('ordinary names are NOT mangled', async () => {
    const r = await lowerUAST(wordParse('make total 1\nprint total\n'), CTX);
    if (!r.text.includes('total')) throw new Error('a non-colliding name was rewritten');
  });

  console.log('\n[7] Phase 2 -- refusals are refusals, not approximations');
  const REFUSE = {
    'print "hi"\n':                    'NO_STRING_OPS',
    'for x in items\n    print x\n':   'NO_HEAP',
    'make i 0\nmake n 5\nloop i < n and i < 3\n    make i i + 1\n': 'COMPOUND_LOOP_COND',
  };
  for (const [src, code] of Object.entries(REFUSE)) {
    const r = await lowerUAST(wordParse(src), CTX);
    check(`refuses with ${code}`, () => {
      if (!r.diagnostics.some(d => d.code === code)) {
        throw new Error(`expected ${code}, got [${r.diagnostics.map(d => d.code).join(', ')}]`);
      }
      C.assertMapTotal(r);   // a refusal must still leave a well-formed map
    });
  }

  console.log('\n[8] Phase 2 -- the or-chain regression');
  // The first `or` lowering emitted a condition-constant BETWEEN an arm's
  // body and the following `elif`. parseCFSource only continues an elif
  // chain while the next same-indent line literally starts with `elif`, so
  // one intervening instruction silently detached the rest of the chain.
  check('no instruction sits between a body and its elif', () => {
    const lines = lowered.or_chain.r.lines;
    for (let i = 1; i < lines.length; i++) {
      if (!/^\s*elif\b/.test(lines[i])) continue;
      const prevIndent = lines[i - 1].match(/^\s*/)[0].length;
      const thisIndent = lines[i].match(/^\s*/)[0].length;
      if (prevIndent <= thisIndent && !/^\s*(if|elif)\b/.test(lines[i - 1])) {
        throw new Error(`line ${i - 1} (${JSON.stringify(lines[i - 1])}) detaches the elif at line ${i}`);
      }
    }
  });

  console.log('\n[9] Phase 3 -- the map is sufficient for bidirectional projection');
  for (const [name, { r, src }] of Object.entries(lowered)) {
    check(`${name}: round-trip origin <-> lines`, () => A.assertRoundTrip(r));
    check(`${name}: SOURCE altitude reconstructs`, () => {
      const p = A.project(r, { altitude: A.ALTITUDE.SOURCE, sourceLines: src.split('\n') });
      if (!p.rows.length) throw new Error('no rows');
      const covered = p.rows.reduce((s, row) => s + row.cost, 0);
      if (covered !== r.lines.length) {
        throw new Error(`SOURCE rows account for ${covered} of ${r.lines.length} CF lines`);
      }
    });
    check(`${name}: synthetic rows are hideable`, () => {
      const shown = A.project(r, { altitude: A.ALTITUDE.CF, hideSynthetic: true });
      const all   = A.project(r, { altitude: A.ALTITUDE.CF, hideSynthetic: false });
      if (all.rows.length < shown.rows.length) throw new Error('hiding increased the row count');
      if (shown.hidden !== all.rows.length - shown.rows.length) throw new Error('hidden count disagrees');
    });
    check(`${name}: gutter payload is well-formed`, () => {
      const g = A.gutter(r);
      if (g.perCfLine.length !== r.lines.length) throw new Error('perCfLine length mismatch');
      const total = g.perNode.reduce((s, n) => s + n.instructions, 0);
      if (total !== r.lines.length) throw new Error(`perNode totals ${total}, expected ${r.lines.length}`);
    });
  }
  check('FLAT altitude is honestly stubbed, not faked', () => {
    const p = A.project(lowered.counted_loop.r, { altitude: A.ALTITUDE.FLAT });
    if (p.rows.length !== 0 || !p.note) throw new Error('FLAT should return no rows and a note');
  });

  console.log('\n[10] Engine-backed checks');
  const fs = require('fs');
  const patchedPath = path.join(HERE, 'Soak_tester.patched.html');
  const enginePath = fs.existsSync(patchedPath) ? patchedPath : path.join(HERE, 'Soak_tester.html');
  const integrated = fs.existsSync(patchedPath);
  if (!fs.existsSync(enginePath)) {
    console.log('  SKIP -- Soak_tester.html not found next to this file.');
    console.log('  SKIP    checkOpTable, and the whole differential suite (see differential.js).');
  } else {
    const loadEngine = require(path.join(HERE, 'engine_node.js'));
    const E = loadEngine({ htmlPath: enginePath, imemIndex: 2, regIndex: 4 });
    check('engine loads in node with every needed export', () => {
      if (E.__missing) throw new Error(`missing exports: ${E.__missing.join(', ')}`);
    });
    check('every SEER_OPS mnemonic resolves against OPCODES or FORMAT', () => {
      const r = checkOpTable(E.OPCODES, E.FORMAT);
      if (!r.ok) throw new Error(r.message);
    });
    check('li is a PP pseudo-op, not a real opcode', () => {
      if ('li' in E.OPCODES) throw new Error('li is in OPCODES after all; SEER_OPS is stale');
      if (E.FORMAT['li'] !== 'PP') throw new Error(`FORMAT.li is ${E.FORMAT['li']}, expected PP`);
    });
    CTX.engine = E;
    const P = integrated ? E : loadEngine({ htmlPath: enginePath, imemIndex: 2, regIndex: 4, patchLiveOut: true });
    check('stage2Allocate accepts a live-out set', () => {
      const prog = 'li a, 5\nli b, 3\nadd o0, a, zr\nadd o1, b, zr\n';
      const s2 = P.stage2Allocate(prog, false, ['o0', 'o1']);
      if (!s2.raw2Map) throw new Error('raw2Map missing -- engine is not patched');
    });
    check('compileCFSource returns a srcMap covering its output', () => {
      const s2 = P.stage2Allocate('li a, 5\nli b, 3\nadd c, a, b\n', false, ['c']);
      const comp = P.compileCFSource(s2.raw2, false, false);
      if (!comp.srcMap) throw new Error('srcMap missing');
      if (comp.srcMap.length !== comp.text.split('\n').length) throw new Error('srcMap length mismatch');
    });
    check('a lowered program survives the real pipeline end to end', () => {
      const lo = lowered.counted_loop.r;
      const liveOut = lo.outputs.map(o => o.name);
      const s2 = P.stage2Allocate(lo.text, false, liveOut);
      const comp = P.compileCFSource(s2.raw2, false, false);
      const flat = P.substituteSymbolicNames(comp.text, s2.mapping);
      const sim = P.simulateProgram(flat, 200000, 64);
      if (sim.error) throw new Error(sim.error);
      const got = BigInt.asIntN(64, sim.reg[s2.mapping['__out0']]).toString();
      if (got !== '12') throw new Error(`counted_loop printed ${got}, expected 12`);
    });

    console.log('\n[11] Phase 3 -- FLAT altitude against real bytes');
    for (const [name, { r, src }] of Object.entries(lowered)) {
      const liveOut = r.outputs.map(o => o.name);
      const s2 = P.stage2Allocate(r.text, false, liveOut);
      const comp = P.compileCFSource(s2.raw2, false, false);
      const flat = P.substituteSymbolicNames(comp.text, s2.mapping);
      const items = P.parseProgram(flat);
      const fp = A.projectFlat(r, { compiled: { items, srcMap: comp.srcMap, raw2Map: s2.raw2Map } });
      check(`${name}: FLAT row per assembled instruction`, () => {
        if (fp.rows.length !== items.length) throw new Error(`${fp.rows.length} rows vs ${items.length} items`);
      });
      check(`${name}: PCs are contiguous and byte totals agree`, () => {
        let pc = 0;
        for (let i = 0; i < fp.rows.length; i++) {
          if (fp.rows[i].pc !== pc) throw new Error(`row ${i} pc ${fp.rows[i].pc}, expected ${pc}`);
          pc += fp.rows[i].bytes.length;
        }
        if (pc !== fp.totals.bytes) throw new Error(`byte total ${fp.totals.bytes} vs ${pc}`);
      });
      check(`${name}: every real instruction traces to a source line`, () => {
        const srcLines = src.split('\n');
        // A synthetic row may carry an origin with srcLine null (the
        // lowerer's own scaffolding). Only a NUMERIC line has to be real.
        const bad = fp.rows.filter(r2 => r2.origin && r2.origin.srcLine !== null
          && !(r2.origin.srcLine >= 1 && r2.origin.srcLine <= srcLines.length));
        if (bad.length) throw new Error(`${bad.length} rows point outside the source, `
          + `first at pc ${bad[0].pc} -> line ${bad[0].origin.srcLine}`);
        if (!fp.totals.traced) throw new Error('nothing traced at all');
      });
      check(`${name}: synthetic instructions are marked, not misattributed`, () => {
        for (const r2 of fp.rows) {
          if (!r2.origin && !r2.synthetic) throw new Error(`pc ${r2.pc} has no origin but is not synthetic`);
          if (r2.origin && r2.origin.srcLine === null && !r2.synthetic) {
            throw new Error(`pc ${r2.pc} has an origin with no line but is not marked synthetic`);
          }
        }
      });
    }
    console.log('\n[12] Functions and the stack ABI, end to end');
    CTX.engine = P;
    for (const [name, [src, want]] of Object.entries({
      fn_simple: ['fun d(x)\n    give x * 2\nmake r d(5)\nprint r\n', '10'],
      fn_nested: ['fun i(x)\n    give x + 1\nfun t(y)\n    make m i(y)\n    give m + m\nmake r t(4)\nprint r\n', '10'],
      recursion: ['fun f(n)\n    if n <= 1\n        give 1\n    make m n - 1\n    make s f(m)\n    give n * s\nmake r f(6)\nprint r\n', '720'],
      two_recur: ['fun fb(n)\n    if n <= 1\n        give n\n    make a n - 1\n    make x fb(a)\n    make b n - 2\n    make y fb(b)\n    give x + y\nmake r fb(9)\nprint r\n', '34'],
    })) {
      const lo = await lowerUAST(wordParse(src), CTX);
      check(`${name}: lowers without refusal`, () => {
        const hard = lo.diagnostics.filter(d => d.severity === 'refuse');
        if (hard.length) throw new Error(hard.map(d => d.code).join(', '));
        C.assertMapTotal(lo); C.assertNoPhysicalRegs(lo); C.assertLiRange(lo);
      });
      check(`${name}: runs correctly on the real engine`, () => {
        const s2 = P.stage2Allocate(lo.text, false, lo.outputs.map(o => o.name));
        const comp = P.compileCFSource(s2.raw2, false, false);
        const sim = P.simulateProgram(P.substituteSymbolicNames(comp.text, s2.mapping), 400000, 64);
        if (sim.error) throw new Error(sim.error);
        const got = BigInt.asIntN(64, sim.reg[s2.mapping['__out0']]).toString();
        if (got !== want) throw new Error(`got ${got}, expected ${want}`);
      });
    }
    check('the call-stack prologue is only emitted when needed', async () => {
      const none = await lowerUAST(wordParse('make a 1\nprint a\n'), CTX);
      if (none.usesCallStack) throw new Error('a program with no calls paid for the stack prologue');
      const rec = await lowerUAST(wordParse('fun f(n)\n    if n <= 1\n        give 1\n    make m n - 1\n    make s f(m)\n    give n * s\nmake r f(3)\nprint r\n'), CTX);
      if (!rec.usesCallStack) throw new Error('a recursive program did not get the stack prologue');
    });

    console.log('  NOTE  the full differential (20 programs + 500 fuzz cases) is `node differential.js`');
  }

  await flushAsyncChecks();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`)); process.exit(1); }
})().catch(e => { console.error('\nRUNNER THREW:', e); process.exit(1); });
