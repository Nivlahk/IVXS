# ivx-glue — file manifest

Everything produced in this session. `node run_tests.js` first; it needs no
arguments and skips gracefully if the engine is missing.

## Drop-in engine (the one thing you must actually install)

| file | what to do with it |
|---|---|
| `Soak_tester.patched.html` | **Replace your `Soak_tester.html` with this.** `print` does not work without it. |
| `Soak_tester.html` | Your ORIGINAL, unmodified — included only so `verify_patch.js` can compare against it. Not a deliverable. |
| `apply_patch.py` | Regenerates the patched file from a clean original. Fails loudly if any of the 14 anchors doesn't match exactly once. |

## Modified copy of a file you already own

| file | change |
|---|---|
| `word_kh.js` | **Modified.** Added `fun`/`give` (function syntax) and per-token line numbers. Diff this against yours before overwriting — the line tracking is additive, the keyword additions are not. |

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

`differential.js` takes `FUZZ=n`, `FNFUZZ=n`, `MODE=liveout\|bare\|sink`.
Counts above are at the default fuzz settings; smaller `FUZZ`/`FNFUZZ` give
proportionally smaller totals.

## Not included

Nothing is wired into your tree. `onZoningToggleChange` still overwrites the
source buffer destructively; no editor code consumes `ivx_altitude.js` yet.
None of this has run in a browser — it is all node, through a DOM shim.

See `README.md` for what's verified, what isn't, and the open items.
