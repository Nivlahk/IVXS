// ── engine_node.js ──────────────────────────────────────────────────────────
// Loads Soak_tester.html's engine into node so the differential half of the
// conformance suite can run against the REAL parseProgram / compileCFSource /
// stage2Allocate / simulateProgram rather than a stand-in.
//
// The engine is one <script> block that assumes a DOM. Rather than editing
// it (it is the operational engine; forking it to test it defeats the
// point), this shims just enough document/window for the top-level code to
// evaluate, and sets the two slider elements the compiler genuinely reads:
// imemBudgetSlider (drives the imemBudget-2048 code budget) and
// regDepthSlider (drives register-depth legality). Both default to NaN
// through the shim otherwise, which silently selects a different budget
// than intended -- worth setting explicitly rather than inheriting a
// fallback.
//
// Usage: const E = require('./engine_node.js')(); E.compileCFSource(...)
'use strict';

const fs = require('fs');
const path = require('path');

const EXPORTS = [
  'parseProgram', 'assembleLine', 'encode', 'compileCFSource', 'parseCFSource',
  'parseCFCondition', 'stage2Allocate', 'substituteSymbolicNames',
  'simulateProgram', 'allocateRegisters', 'cyclesFor', 'getImemBudget',
  'getRegDepth', 'OPCODES', 'FORMAT', 'OB_MNEMS', 'SPILL_BASE_ADDR',
  // Capability constants: needed to build a stack-capability TOKEN from CF
  // source. The boot prefix installs the capability in the cap table but
  // leaves no token in any register, and generateStackCapTokenLines emits
  // one using only li/sll/or -- all of which the CF dialect has. So a real
  // call stack is reachable without patching the engine, provided these
  // constants are readable.
  'STACK_CAP_IDX', 'STACK_CAP_GEN', 'STACK_CAP_KEY', 'STACK_CAP_BASE',
  'STACK_CAP_SIZE', 'STACK_CAP_PERMS', 'STACK_CAP_MAC', 'capMacV1', 'CTRL_ID',
];

function stubElement(id) {
  return {
    id, value: '', innerHTML: '', textContent: '', checked: false,
    style: {}, dataset: {},
    addEventListener() {}, appendChild() {}, remove() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

/**
 * @param {Object} opts
 * @param {number} opts.imemIndex  Index into IMEM_BUDGET_VALUES [4K,8K,16K,32K,64K]. Default 2 (16KB).
 * @param {number} opts.regIndex   Index into REG_DEPTH_VALUES [4,8,16,32,64,128,256]. Default 4 (64).
 * @param {string} opts.htmlPath   Path to Soak_tester.html.
 */
function loadEngine(opts = {}) {
  const htmlPath = opts.htmlPath || path.join(__dirname, 'Soak_tester.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  if (start < 0 || end < 0) throw new Error(`no <script> block found in ${htmlPath}`);
  let src = html.slice(start + '<script>'.length, end);

  // ── PROPOSED ENGINE PATCH (opt-in, applied to the loaded copy only) ──────
  // stage2Allocate calls s2LiveList(mainStmts, new Set(), ctx) with a
  // HARDCODED EMPTY live-out set, so a name that is written and never read
  // is dead at once and its register is immediately reused. Combined with
  // ecall having no architectural effect, that means a compiled program has
  // no defined output channel at all: every attempt to anchor a result in a
  // register is legitimately optimized on top of.
  //
  // This adds an optional third parameter. Two lines, no behaviour change
  // when it is omitted. Verified below by differential.js, which goes from
  // 0/20 to passing with it applied.
  if (opts.patchLiveOut) {
    const before = src;
    src = src.replace('function stage2Allocate(raw, enableMetaCF) {',
                      'function stage2Allocate(raw, enableMetaCF, liveOut) {');
    src = src.replace('const liveInMain = s2LiveList(mainStmts, new Set(), ctx);',
                      'const liveInMain = s2LiveList(mainStmts, new Set(liveOut || []), ctx);');
    if (src === before) throw new Error('patchLiveOut: neither anchor matched -- '
      + 'stage2Allocate has changed since this patch was written');
    if (src.includes('function stage2Allocate(raw, enableMetaCF) {')
     || src.includes('const liveInMain = s2LiveList(mainStmts, new Set(), ctx);')) {
      throw new Error('patchLiveOut: only one of the two anchors matched');
    }
  }

  const store = {};
  const doc = {
    getElementById: id => store[id] || (store[id] = stubElement(id)),
    querySelectorAll: () => [], querySelector: () => null,
    createElement: () => stubElement('created'),
    addEventListener() {}, body: stubElement('body'),
  };
  doc.getElementById('imemBudgetSlider').value = String(opts.imemIndex ?? 2);
  doc.getElementById('regDepthSlider').value  = String(opts.regIndex ?? 4);

  const win = { addEventListener() {}, location: { href: '' }, setTimeout, clearTimeout };
  const nav = { userAgent: 'node', serial: undefined };
  const ls = { getItem: () => null, setItem() {}, removeItem() {} };

  const tail = '\n;return {' + EXPORTS
    .map(n => `${n}: (typeof ${n} !== "undefined" ? ${n} : undefined)`).join(', ') + '};';

  const factory = new Function('document', 'window', 'navigator', 'localStorage',
                               'setTimeout', 'clearTimeout', 'console', src + tail);
  const api = factory(doc, win, nav, ls, setTimeout, clearTimeout, console);

  const missing = EXPORTS.filter(n => api[n] === undefined);
  if (missing.length) api.__missing = missing;
  api.__store = store;
  api.__scriptLines = src.split('\n').length;
  return api;
}

module.exports = loadEngine;
