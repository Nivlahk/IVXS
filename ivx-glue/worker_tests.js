// ── worker_tests.js ─────────────────────────────────────────────────────────
// Phase 4. Separate from run_tests.js because these are async, spawn real
// OS threads, and include deliberate multi-hundred-millisecond hangs --
// mixing them into the fast suite would make it slow and flaky.
//
// Everything here runs REAL workers through the REAL worker source. The js
// and wasm runtimes are genuinely exercised; python and go are not, and
// this file says so out loud rather than mocking them into a green tick.
//
//   node worker_tests.js
'use strict';

const path = require('path');
const HERE = __dirname;
const { IVXWorker, IVXWorkerPool, specFromResolved, pickTransport } = require(path.join(HERE, 'ivx_workers.js'));
const { IVXBridge, isHoistable, materializeInt } = require(path.join(HERE, 'ivx_bridge.js'));
const { wordParse } = require(path.join(HERE, 'word_kh.js'));
const { lowerUAST } = require(path.join(HERE, 'ivx_lower.js'));

// Hand-assembled: (module (func (export "add") (param i32 i32) (result i32)
//                    local.get 0 local.get 1 i32.add))
// A real module rather than a fixture file, so the wasm path is tested
// against bytes the host actually validates and instantiates.
const WASM_ADD = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push({ name, error: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
async function rejects(p, needle, what) {
  try { await p; } catch (e) {
    if (needle && !e.message.includes(needle)) {
      throw new Error(`${what}: rejected but not about "${needle}" -- ${e.message}`);
    }
    return e;
  }
  throw new Error(`${what}: expected a rejection, got none`);
}

const LOWER_CTX = { metaCF: false, capabilityDiscipline: false, regDepth: 64,
                    imemBudget: 16384, outputMode: 'liveout' };

(async () => {
  console.log(`\ntransport: ${pickTransport().name}`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[1] js runtime');
  {
    const w = new IVXWorker({ id: 'js' });
    await check('init reports its runtime kind', async () => {
      eq(await w.init({ runtime: 'js', source: 'module.exports={double:x=>x*2,greet:n=>"hi "+n};' }), 'js', 'kind');
    });
    await check('exports are enumerable', async () => eq((await w.exports()).sort(), ['double', 'greet'], 'exports'));
    await check('call returns the value', async () => eq(await w.call('double', [21]), 42, 'double'));
    await check('string args round-trip', async () => eq(await w.call('greet', ['niv']), 'hi niv', 'greet'));
    await check('missing export is a clear error', () =>
      rejects(w.call('nope', []), "'nope' is not an exported function", 'missing export'));
    await check('an error thrown inside foreign code surfaces', async () => {
      const v = new IVXWorker({ id: 'boom' });
      await v.init({ runtime: 'js', source: 'module.exports={boom:()=>{throw new Error("inner failure")}}' });
      const e = await rejects(v.call('boom', []), 'inner failure', 'foreign throw');
      if (e.workerId !== 'boom') throw new Error('error is not attributed to its worker');
      v.terminate();
    });
    await check("require() inside a worker fails loudly, not silently", async () => {
      const v = new IVXWorker({ id: 'req' });
      await rejects(v.init({ runtime: 'js', source: 'const x=require("fs");module.exports={}' }),
        'not available inside a worker', 'require');
      v.terminate();
    });
    w.terminate();
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[2] wasm runtime (real module, not a mock)');
  {
    const w = new IVXWorker({ id: 'wasm' });
    await check('instantiates hand-assembled bytes', async () =>
      eq(await w.init({ runtime: 'wasm', bytes: WASM_ADD }), 'wasm', 'kind'));
    await check('exports are enumerable', async () => eq(await w.exports(), ['add'], 'exports'));
    await check('add(17,25) == 42', async () => eq(await w.call('add', [17, 25]), 42, 'add'));
    w.terminate();

    await check('malformed bytes reject at init', async () => {
      const v = new IVXWorker({ id: 'badwasm' });
      await rejects(v.init({ runtime: 'wasm', bytes: new Uint8Array([1, 2, 3]) }), null, 'bad wasm');
      if (!v.dead) throw new Error('worker survived a failed init -- it would leak');
    });
    await check('unsatisfied imports name what is missing', async () => {
      // Same module shape but importing env.f, which we do not supply.
      const needsImport = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
        0x02, 0x09, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
      ]);
      const v = new IVXWorker({ id: 'imp' });
      await rejects(v.init({ runtime: 'wasm', bytes: needsImport }), 'env.f', 'missing import');
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[3] lifecycle -- the failure mode that actually happens');
  {
    await check('a hung runtime is killed by its timeout', async () => {
      const w = new IVXWorker({ id: 'hang', callTimeoutMs: 400 });
      await w.init({ runtime: 'js', source: 'module.exports={spin:()=>{while(true){}}}' });
      const t = Date.now();
      await rejects(w.call('spin', []), 'timed out', 'hang');
      if (Date.now() - t > 3000) throw new Error('timeout did not fire promptly');
      if (!w.dead) throw new Error('worker survived its own timeout -- a foreign infinite loop '
        + 'cannot be interrupted, so the worker must be terminated');
    });
    await check('calls to a dead worker reject immediately', async () => {
      const w = new IVXWorker({ id: 'dead', callTimeoutMs: 300 });
      await w.init({ runtime: 'js', source: 'module.exports={spin:()=>{while(true){}}}' });
      await rejects(w.call('spin', []), null, 'first');
      await rejects(w.call('spin', []), 'is dead', 'second');
    });
    await check('a dead worker does not keep its pool slot', async () => {
      // REGRESSION: acquire() only considered live-but-idle workers as
      // eviction victims, so a pool full of timed-out corpses could never
      // be recovered -- every later acquire failed with "pool is full",
      // the exact leak the timeout was meant to prevent.
      const pool = new IVXWorkerPool({ maxWorkers: 1, callTimeoutMs: 300 });
      await rejects(pool.call('bad', 'spin', [], { runtime: 'js', source: 'module.exports={spin:()=>{while(true){}}}' }),
        'timed out', 'hang');
      const v = await pool.call('good', 'id', [7], { runtime: 'js', source: 'module.exports={id:x=>x}' });
      eq(v, 7, 'recovered call');
      eq(pool.size, 1, 'pool size after reaping');
      pool.terminateAll();
    });
    await check('one runtime per worker is enforced', async () => {
      const w = new IVXWorker({ id: 'two' });
      await w.init({ runtime: 'js', source: 'module.exports={}' });
      await rejects(w.init({ runtime: 'js', source: 'module.exports={}' }), 'already hosts', 'double init');
      w.terminate();
    });
    await check('concurrent acquires share one initialisation', async () => {
      const pool = new IVXWorkerPool({ maxWorkers: 3 });
      const spec = { runtime: 'js', source: 'module.exports={id:x=>x}' };
      const rs = await Promise.all([1, 2, 3, 4].map(n => pool.call('same', 'id', [n], spec)));
      eq(rs, [1, 2, 3, 4], 'concurrent results');
      eq(pool.size, 1, 'spawned exactly one worker');
      pool.terminateAll();
    });
    await check('a full pool of BUSY workers refuses rather than queueing silently', async () => {
      const pool = new IVXWorkerPool({ maxWorkers: 1, callTimeoutMs: 5000 });
      const spec = { runtime: 'js', source: 'module.exports={slow:()=>{const t=Date.now();while(Date.now()-t<600){}return 1}}' };
      const inflight = pool.call('busy', 'slow', [], spec);
      await new Promise(r => setTimeout(r, 100));
      await rejects(pool.acquire('other', spec), 'pool is full', 'full pool');
      await inflight;
      pool.terminateAll();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[4] resolver -> worker seam');
  {
    await check('a js ResolvedModule becomes a worker spec', () => {
      const mod = { runtime: 'js', name: 'demo', entry: 'index.js',
                    files: new Map([['index.js', new TextEncoder().encode('module.exports={f:()=>1}')]]) };
      const spec = specFromResolved(mod);
      eq(spec.runtime, 'js', 'runtime');
      if (!spec.source.includes('module.exports')) throw new Error('source not decoded');
    });
    await check('a missing entry file names what is present', () => {
      const mod = { runtime: 'js', name: 'demo', entry: 'main.js', files: new Map([['other.js', '']]) };
      try { specFromResolved(mod); } catch (e) {
        if (!e.message.includes('other.js')) throw new Error('error does not list available files');
        return;
      }
      throw new Error('expected a throw');
    });
    await check('python refuses to default its distribution URL', () => {
      try { specFromResolved({ runtime: 'python', name: 'numpy' }); }
      catch (e) {
        if (!e.message.includes('indexURL')) throw new Error(e.message);
        return;
      }
      throw new Error('python spec silently defaulted a CDN -- on a zero-egress platform that '
        + 'is how an accidental fetch ships');
    });
    await check('go says plainly that it does not compile Go', () => {
      try { specFromResolved({ runtime: 'go', name: 'github.com/x/y' }); }
      catch (e) {
        if (!e.message.includes('no in-browser Go compiler')) throw new Error(e.message);
        return;
      }
      throw new Error('expected a throw');
    });
    await check('an unknown runtime is refused, not guessed', () => {
      try { specFromResolved({ runtime: 'cobol', name: 'x' }); }
      catch (e) { if (!e.message.includes('cobol')) throw new Error(e.message); return; }
      throw new Error('expected a throw');
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[5] hoistability -- the synchronous-simulator constraint');
  {
    const top = await lowerUAST(wordParse('make a compute(3)\nprint a\n'), LOWER_CTX);
    const nested = await lowerUAST(
      wordParse('make i 0\nloop i < 3\n    make a compute(i)\n    make i i + 1\nprint a\n'), LOWER_CTX);

    await check('a top-level foreign call is hoistable', () => {
      if (!top.externs.length) throw new Error('no extern recorded');
      if (!isHoistable(top).hoistable) throw new Error('top-level call reported unhoistable');
    });
    await check('a foreign call inside a loop is NOT hoistable', () => {
      const h = isHoistable(nested);
      if (h.hoistable) throw new Error('nested call reported hoistable -- it would run once '
        + 'instead of per-iteration, silently producing a wrong answer');
      if (!h.reasons[0].why.includes('nested')) throw new Error('reason does not explain nesting');
    });
    await check('materializeInt respects the li range', () => {
      if (materializeInt('x', 500) !== 'li x, 500') throw new Error('in-range should be one li');
      const big = materializeInt('x', 70000);
      if (!big.includes('slli')) throw new Error('out-of-range should shift/accumulate');
      const neg = materializeInt('x', -500);
      if (!neg.includes('sub x, zr, x')) throw new Error('negative should negate from zr');
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[6] end to end -- a worker value crossing into SEER');
  {
    const enginePath = path.join(HERE, 'Soak_tester.patched.html');
    if (!require('fs').existsSync(enginePath)) {
      console.log('  SKIP -- Soak_tester.patched.html not found beside this file');
    } else {
      const E = require(path.join(HERE, 'engine_node.js'))({ htmlPath: enginePath, imemIndex: 2, regIndex: 4 });
      const bridge = new IVXBridge({ pool: new IVXWorkerPool({ maxWorkers: 2 }) });
      await bridge.pool.acquire('calc', { runtime: 'js', source: 'module.exports={compute:x=>x*14}' });

      await check('worker computes, SEER consumes, result reads back', async () => {
        const lo = await lowerUAST(wordParse('make total base + 8\nprint total\n'), LOWER_CTX);
        lo.externs = [{ name: 'base', key: 'calc', entry: 'compute', argValues: [3],
                        readBack: ['base'], cfLine: 0 }];
        const out = await bridge.runLowered(lo, E);
        eq(out.injected.base, 42, 'worker result');
        const got = BigInt.asIntN(64, out.sim.reg[out.s2.mapping['__out0']]).toString();
        eq(got, '50', 'SEER print (42 + 8)');
      });

      await check('a wasm worker value crosses too', async () => {
        await bridge.pool.acquire('w', { runtime: 'wasm', bytes: WASM_ADD });
        const lo = await lowerUAST(wordParse('make total base * 2\nprint total\n'), LOWER_CTX);
        lo.externs = [{ name: 'base', key: 'w', entry: 'add', argValues: [17, 25],
                        readBack: ['base'], cfLine: 0 }];
        const out = await bridge.runLowered(lo, E);
        eq(out.injected.base, 42, 'wasm result');
        eq(BigInt.asIntN(64, out.sim.reg[out.s2.mapping['__out0']]).toString(), '84', 'SEER print');
      });

      await check('a nested foreign call is REFUSED, not silently hoisted', async () => {
        const lo = await lowerUAST(
          wordParse('make i 0\nloop i < 3\n    make a compute(i)\n    make i i + 1\nprint a\n'), LOWER_CTX);
        const e = await rejects(bridge.runLowered(lo, E), 'nested inside control flow', 'nested refusal');
        if (!e.reasons || !e.reasons.length) throw new Error('refusal carries no machine-readable reasons');
      });

      await check('a non-integer crossing is refused, not coerced', async () => {
        await bridge.pool.acquire('str', { runtime: 'js', source: 'module.exports={s:()=>"hello"}' });
        const lo = await lowerUAST(wordParse('make total base + 1\nprint total\n'), LOWER_CTX);
        lo.externs = [{ name: 'base', key: 'str', entry: 's', argValues: [],
                        readBack: ['base'], cfLine: 0 }];
        await rejects(bridge.runLowered(lo, E), 'only integers can cross into SEER', 'string crossing');
      });

      await check('every crossing is logged for the fidelity ledger', () => {
        if (!bridge.log.length) throw new Error('nothing logged');
        if (!bridge.log.some(l => l.phase === 'hoist')) throw new Error('no hoist entries');
      });

      bridge.terminate();
    }
  }

  console.log('\n[7] Not tested here, and why');
  console.log('  python (Pyodide) -- needs a ~10MB distribution fetch; not reachable from this');
  console.log('                      environment. Adapter follows the documented API but is');
  console.log('                      UNVERIFIED until it runs in a browser once.');
  console.log('  go               -- needs wasm_exec.js plus a prebuilt .wasm. The adapter runs');
  console.log('                      a prebuilt module; it is not, and cannot be, a Go compiler.');

  console.log('\n' + '='.repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('RUNNER THREW:', e); process.exit(1); });
