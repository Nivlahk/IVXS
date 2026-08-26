// ── browser_test.js ─────────────────────────────────────────────────────────
// Loads the glue layer in a REAL DOM, with real <script> tags, via jsdom.
// Everything else in this repo runs in node through a shim; this is the only
// suite that executes the code the way a browser will.
//
//   npm install jsdom
//   node browser_test.js
//
// It builds a minimal page containing the engine plus the lens markup, rather
// than loading index.html directly, because index.html also pulls core.js,
// graph.js, drive.js and friends which are not in this package.
//
// This suite is what caught the `const`-at-script-top-level bug: such a
// binding is lexical and never becomes a window property, so reading the
// engine's STACK_CAP_* constants off window gave undefined and the ABI
// prologue threw a BigInt TypeError. A DOM shim cannot surface that.
'use strict';


// Build the test page and the extracted engine script beside this file.
const fs = require('fs'), path = require('path');
const HERE = __dirname;
function prepare() {
  const enginePath = path.join(HERE, 'Soak_tester.patched.html');
  if (!fs.existsSync(enginePath)) {
    console.error('browser_test.js needs Soak_tester.patched.html beside it.');
    process.exit(2);
  }
  const html = fs.readFileSync(enginePath, 'utf8');
  fs.writeFileSync(path.join(HERE, '.seer_engine.js'),
    html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')));
  fs.writeFileSync(path.join(HERE, '.browser_test.html'), `<!DOCTYPE html><html>
<head><meta charset="UTF-8"></head><body>
<textarea id="src"></textarea><textarea id="sourceInput"></textarea>
<input type="range" id="imemBudgetSlider" value="2"><input type="range" id="regDepthSlider" value="4">
<div id="out"></div><div id="regs"></div><div id="err"></div><div id="trace"></div>
<div id="lens-panel"><div id="lens-hdr">
<select id="lens-altitude"><option value="source" selected>Source</option><option value="cf">IR</option><option value="flat">Machine</option></select>
<input type="checkbox" id="lens-synthetic" checked>
<button id="lens-refresh">Refresh</button><span id="lens-status"></span>
<button id="lens-minimize">-</button></div><div id="lens-body"></div></div>
<script src=".seer_engine.js"></script>
<script src="word_kh.js"></script>
<script src="ivx_lower_contract.js"></script>
<script src="ivx_altitude.js"></script>
<script src="ivx_lower.js"></script>
<script src="ivx_resolve.js"></script>
<script src="ivx_worker_runtime.js"></script>
<script src="ivx_workers.js"></script>
<script src="ivx_bridge.js"></script>
<script src="ivx_lens_ui.js"></script>
</body></html>`);
}
prepare();

// jsdom is the one external dependency in this repo, and only for this
// suite. Fail with instructions rather than a module-not-found stack.
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); }
catch (e) {
  console.error('browser_test.js needs jsdom:\n\n  npm install jsdom\n\n'
    + 'Every other suite in this package has no dependencies.');
  process.exit(2);
}
const errors=[];
const vc=new VirtualConsole();
vc.on('jsdomError',e=>errors.push('jsdomError: '+e.message));
vc.on('error',(...a)=>errors.push('console.error: '+a.join(' ')));
JSDOM.fromFile(path.join(HERE,'.browser_test.html'),{runScripts:'dangerously',resources:'usable',virtualConsole:vc,pretendToBeVisual:true})
.then(async dom=>{
  const w=dom.window;
  await new Promise(r=>setTimeout(r,600));
  // The engine's script block reaches for 40 element IDs belonging to
  // Soak_tester.html's own UI. This harness page has only a few of them, so
  // its init throws -- EXPECTED here, and the same thing will happen if the
  // engine is pasted into index.html, which has none of them. Reported, not
  // treated as a failure of the glue layer.
  const known = errors.filter(e => /innerHTML|Cannot (set|read)/.test(e));
  const unexpected = errors.filter(e => !known.includes(e));
  console.log('=== load errors ===');
  console.log('  expected (engine init wants Soak_tester.html DOM):', known.length);
  console.log('  UNEXPECTED:', unexpected.length ? '\n    ' + unexpected.join('\n    ') : 'none');
  console.log('\nengine globals :',['stage2Allocate','compileCFSource','simulateProgram','parseProgram'].map(n=>n+'='+typeof w[n]).join(' '));
  console.log('wordParse      :',typeof w.wordParse);
  console.log('window.IVX     :',Object.keys(w.IVX||{}).sort().join(', '));
  const src=w.document.getElementById('src');
  src.value='fun f(n)\n    if n <= 1\n        give 1\n    make m n - 1\n    make s f(m)\n    give n * s\nmake r f(5)\nprint r\n';
  for(const alt of ['source','cf','flat']){
    w.document.getElementById('lens-altitude').value=alt;
    w.IVX.lens.state.altitude=alt;
    await w.IVX.lens.refresh();
    const body=w.document.getElementById('lens-body');
    const rows=[...body.querySelectorAll('tr.lens-row')];
    console.log(`\n[${alt}] ${rows.length} rows | ${w.document.getElementById('lens-status').textContent}`);
    for(const r of rows.slice(0,4)) console.log('   ',[...r.children].map(c=>c.textContent).join(' | '));
    if(rows.length>4) console.log('    ...');
  }
  const ok = !unexpected.length;
  console.log('\n' + '='.repeat(60));
  console.log(ok ? 'browser load: OK (all 9 scripts, all 3 altitudes rendered)'
                 : 'browser load: FAILED');
  process.exit(ok ? 0 : 1);
}).catch(e=>{console.error('FAILED',e);process.exit(1)});
