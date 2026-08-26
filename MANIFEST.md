# ivx-glue — file manifest

Everything produced in this session. `node run_tests.js` first; it needs no
arguments and skips gracefully if the engine is missing.

## Drop-in engine (the one thing you must actually install)

| file | what to do with it |
|---|---|
| `Soak_tester.patched.html` | **Replace your `Soak_tester.html` with this.** `print` does not work without it. |
| `Soak_tester.html` | Your ORIGINAL, unmodified — included only so `verify_patch.js` can compare against it. Not a deliverable. |
| `apply_patch.py` | Regenerates the patched file from a clean original. Fails loudly if any of the 14 anchors doesn't match exactly once. |

## Modified copies of files you already own

| file | change |
|---|---|
| `index.html` | **Modified.** +71 lines, **0 deletions**: inline `<style>`, the `#lens-panel` markup inside `#ep-body`, and 9 `<script>` tags. CRLF endings preserved, so `diff` shows only the additions. |
| `word_kh.js` | **Modified.** Added `fun`/`give`, per-token line numbers, dual-mode export, AND (fixed in this revision) wrapped the whole file in an IIFE — it was the one file left leaking `Node`/`wordLex`/`WordParser` onto the global scope, which could silently break loading if `core.js` declares any colliding name. Diff before overwriting. |

## Browser UI

| file | what it is |
|---|---|
| `ivx_lens_ui.js` | The lens panel: Source / IR / Machine altitudes. A **projection**, never an edit — it does not write to `#src`. |
| `ivx_python_ui.js` | Write literal Python, run it in a real Pyodide worker. A second, real editor — not KH styled to look like Python. |

## New modules

| file | phase |
|---|---|
| `ivx_resolve.js` | 1 — package resolver, runtime detection, integrity pinning |
| `ivx_lower_contract.js` | 2 — type contract, dialect constraints, invariant checkers, `CFEmitter` |
| `ivx_lower.js` | 2 — the lowerer (UAST → CF text + source map + ABI) |
| `ivx_altitude.js` | 3 — bidirectional altitude projection (SOURCE / CF / FLAT) |
| `ivx_workers.js` | 4 — worker pool, transports, lifecycle |
| `ivx_worker_runtime.js` | 4 — code that runs *inside* a worker |
| `ivx_bridge.js` | 4 — resolver → pool → kernel wiring, hoistability |
| `engine_node.js` | test harness — loads the engine into node with a DOM shim |

## Test suites

| command | count | covers |
|---|---|---|
| `node run_tests.js` | 101 | static invariants, engine-backed checks, FLAT, functions |
| `node verify_patch.js` | 73 | patched vs original, side by side (needs BOTH html files) |
| `node abi_tests.js` | 37 | calling convention, recursion, mutual recursion, depth limits |
| `node worker_tests.js` | 31 | real workers, js + wasm runtimes, pool lifecycle |
| `node differential.js` | 941 | 41 programs + 900 fuzz cases vs an independent evaluator |
| `node browser_test.js` | — | loads all 9 scripts in a REAL DOM via jsdom, renders all 3 altitudes. Needs `npm install jsdom`; the only suite with a dependency. |

`differential.js` takes `FUZZ=n`, `FNFUZZ=n`, `MODE=liveout\|bare\|sink`.
Counts above are at the default fuzz settings; smaller `FUZZ`/`FNFUZZ` give
proportionally smaller totals.

See `BROWSER_TESTING.md` for exact steps to load this in a real browser,
including the `word_kh.js` collision bug and how it was confirmed fixed.

## Read this before dropping the engine into index.html

The script block in `Soak_tester.patched.html` reaches for **40 element IDs
and `index.html` has none of them** (`sourceInput`, `cfToggle`,
`materializeToggle`, `imemBudgetSlider`, …). Its init will throw on load.

The lens degrades honestly: **Source** and **IR** altitudes need only the
lowerer and work without the engine; **Machine** names exactly which
functions are missing. To get Machine on the live site, pick one of: keep the
engine on its own page; add the 40 elements (hidden is fine); or guard the
engine's init to skip absent elements. The last is smallest, but it edits a
file you run in production, so I left that call to you.

## Still not wired

Phases 1 and 4 have no UI — `ivx_resolve` / `ivx_workers` / `ivx_bridge` load
and are reachable as `window.IVX.*`, but nothing in the page calls them. The
old destructive `onZoningToggleChange` path is untouched and still there
alongside the new panel.

See `README.md` for what's verified, what isn't, and the open items.
