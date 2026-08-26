# How to actually load this in a browser and see it work

## If you just want to see the lens panel (no engine, no other KH files)

1. Make a folder with just these files from the zip:
   `index.html`, `word_kh.js`, `ivx_lower_contract.js`, `ivx_altitude.js`,
   `ivx_lower.js`, `ivx_resolve.js`, `ivx_worker_runtime.js`,
   `ivx_workers.js`, `ivx_bridge.js`, `ivx_lens_ui.js`.
2. Open `index.html` directly in the browser (double-click, or
   `file:///path/to/index.html`). Plain `<script src>` tags work fine over
   `file://` -- no local server needed for this part.
3. The page will look broken (no styling, no flowchart) because
   `styles.css`, `core.js`, `graph.js` etc. are missing from this folder on
   purpose -- this step is only to check the LENS loads at all.
4. Open the browser console (F12). You should see no red errors from
   `word_kh.js` or any `ivx_*.js` file. `console.log(window.IVX)` should
   show an object with `Lower`, `Altitude`, `Resolver`, `Workers`, `Bridge`,
   `wordParse`, etc.
5. Type into the `#src` textarea:
   ```
   make total 0
   make limit 10
   loop total < limit
       make total total + 3
   print total
   ```
   and click **Refresh** in the lens panel (or wait ~400ms after typing --
   it debounces). **Source** and **IR** altitudes should render a table.
   **Machine** will say "FLAT needs the SEER engine on the page" -- correct,
   expected, see below.

## To get the Machine altitude working: drop it into your real project

1. Copy `index.html`, `word_kh.js`, and every `ivx_*.js` file into your
   actual `nivlahk.com` source tree, alongside `core.js`, `runtime.js`,
   `styles.css`, etc. **Diff `word_kh.js` against your existing copy first**
   -- this one adds `fun`/`give` and changes its behavior, it does not just
   append to it.
2. `Soak_tester.patched.html`'s `<script>` block reaches for 40 element IDs
   your real page doesn't have (`sourceInput`, `cfToggle`,
   `imemBudgetSlider`, ...). You have to resolve this before Machine
   altitude will work -- see the "engine and index.html cannot share a page"
   section further down. Until you do, Source and IR still work; Machine
   reports what's missing rather than silently failing.
3. Serve it over `http://` (a real dev server, or `python3 -m http.server`),
   not `file://`, once `core.js` and friends are involved -- some of your
   other scripts may depend on things `file://` restricts (fetch, workers).
   The lens files themselves don't require it, but your full app likely
   does.
4. Open the real page, open the console, type a program, click Refresh.

## A word_kh.js bug I only just found and fixed

If you tried this and saw **"word_kh.js is not loaded (no wordParse). Check
the <script> order."** -- that was a real bug, now fixed in this file.

Every other IVX file is wrapped in an IIFE so its internals stay off the
global scope. I missed that for `word_kh.js` itself: `Node`, `wordLex`,
`WordParser`, and `wordParse` were bare top-level declarations. Classic
`<script>` tags on one page share a single global scope, and `word_kh.js`
was explicitly written to mirror your real KH parser's structure -- so a
name as generic as `Node` colliding with something in `core.js` (a `class`,
`const`, or `let` named `Node`, in particular) is a real risk, not a
theoretical one. Reproduced directly: declaring `class Node {}` in one
script tag and loading the old `word_kh.js` in a second script tag threw
`Identifier 'Node' has already been declared` before a single line of it
ran -- `wordParse` never got defined, and the lens panel's message is the
symptom three layers away from the actual cause.

Fixed by wrapping the whole file in an IIFE, the same as every other file.
Verified it now survives that exact collision (`class Node {}` declared
first, then this file loads cleanly regardless).

**If you still see that message after updating to this version**, it means
something else -- most likely the `<script src="word_kh.js">` path is wrong
for your folder layout, or the browser's Network tab will show a 404 for
it. Check Network before Console in that case.

## Quick self-test without opening a real browser at all

`browser_test.js` in the zip does the same load-and-render check
programmatically, via jsdom instead of a real browser engine. It needs one
dependency:

```
npm install jsdom
node browser_test.js
```

It builds a throwaway page with just the engine + the nine glue files (not
your full `index.html`, which needs files this package doesn't ship), loads
them with real `<script>` tags, and renders all three altitudes. This is
what caught both the capability-constant bug and the `word_kh.js` wrapping
bug -- if something is wrong with how the files load together, this will
show it before you open an actual browser.


## Two real features added, verified as far as this sandbox allows

### Web import — wired into the real interpreter, verified end to end

`runtime.js`'s `Import` case previously read `if (!node.url) break;` for the
`from Name by specifier` form — a complete, silent no-op. It now resolves
the specifier through `IVX.resolver` (Phase 1), brings up a worker through
`IVX.bridge` (Phase 4), and binds the local name to a namespace object whose
methods call into that worker. `Frames.compute(5)` works through the
EXISTING `_evalInvokeExpr` calling convention — no other change to
`runtime.js` was needed, because it already had a `typeof callee ===
'function'` fallback (used today for sheets handle methods).

Tested against the REAL `runtime.js` file (via `vm`, the same technique
`demo.js` already uses to load it), with `core.js` absent from this session's
mount — so a hand-built AST stands in for its parser output. The node shapes
match what I recorded verbatim from reading the real file earlier this
session (`Node('Import', {path, via, line, col})`); I could not re-confirm
that shape live, since the file was gone from the mount again by the time I
wrote this.

Real results, real network, real workers, real npm packages:

```
from Frames by npm:lodash
print Frames.chunk([1,2,3,4,5], 2)        -> [[1,2],[3,4],[5]]      (correct)

from M by npm:is-number
print M.default(42)                        -> true                  (correct)

from M by npm:lodash@4.17.21
print M.uniq([1,2,2,3,3,3])                -> [1,2,3]                (correct)

from M by npm:this-package-does-not-exist-xyz-123
                                            -> RuntimeError, cleanly:
   "Import failed for '...': npm registry HTTP 404"
```

**A real bug this surfaced:** `ivx_worker_runtime.js`'s `exportNames()`
returned only `['default']` for any module whose `module.exports` is itself
a callable with methods attached — which is exactly how lodash, moment, and
plenty of other real npm packages are shaped. `w.call('chunk', ...)` worked
correctly the whole time; only *discovery* of `chunk` as an available name
was blind to it, because `typeof api === 'function'` short-circuited before
its own properties were considered. Fixed: a callable export now has its own
properties enumerated too, falling back to `['default']` only when there are
none.

### Write literal Python and run it

`ivx_python_ui.js` (new) is a genuine second editor: it sends the buffer's
actual text to a Pyodide worker and runs it as Python — not KH styled to
look like Python. Captures `print()` output via Pyodide's `setStdout`/
`setStderr` (feature-detected; older bundled Pyodide without them still
returns the last expression's value).

**What's verified and what isn't, precisely:**
- The worker-side protocol — init handshake, `importScripts` call with the
  right URL, stdout/stderr capture, exception surfacing — is tested against
  a **mocked** `loadPyodide` inside a real VM context reporting as a browser
  host. That proves this file's own code.
- The actual ~10MB `pyodide.js` fetch has **never succeeded from this
  sandbox**: `curl` to `cdn.jsdelivr.net` returns HTTP 403 here, confirmed
  directly. That is this tool sandbox's own egress allowlist, not a
  prediction about your browser — jsdelivr is one of the most widely used
  CDNs on the internet and ordinary browsers reach it without issue. Still,
  worth being precise: "never verified from here" is what the evidence
  actually supports, not "confirmed working."
- In jsdom (no real `Worker`, no `require`), clicking Run correctly surfaces
  `"no worker transport available"` as a visible status/output message
  rather than hanging silently — the failure path itself is proven; only the
  successful path needs a real browser to close out.

**To verify it yourself:** open the page, type `print(1+1)` into the Python
panel, click Run. First run downloads Pyodide (a real wait, tens of seconds
on a slow connection); the status line reports exactly what's happening.


## GitHub / URL imports now follow relative dependencies

**The gap:** a bare URL fetched exactly one file. Most real source files in a
repo require their siblings, so `.../lodash/isEmpty.js` resolved fine and
then died inside the worker on `require('./_baseKeys')`. The `npm:` path
never hit this because it unpacks a whole tarball.

**Now:** the resolver walks relative requires from a URL entry point,
fetching each sibling into a module map keyed by path-relative-to-entry, and
the worker gets a real CommonJS `require` over that map.

Verified against real GitHub raw URLs, real network:

```
raw.githubusercontent.com/.../lodash.js     (self-contained UMD)
  -> 308 exports, chunk([1,2,3,4,5],2) = [[1,2],[3,4],[5]]

raw.githubusercontent.com/.../isEmpty.js    (was FAILING -- 8 require deps)
  -> 37 files fetched transitively
  -> isEmpty([]) = true   isEmpty([1,2,3]) = false
  -> isEmpty({}) = true   isEmpty({a:1})   = false

raw.githubusercontent.com/.../cloneDeep.js  (deep graph WITH cycles)
  -> 108 files fetched
  -> cloneDeep({a:{b:[1,{c:2}]}}) = {"a":{"b":[1,{"c":2}]}}
```

**Cycles work** because the worker installs a module's cache entry *before*
running its body — node's own semantics. A cycle sees a partially populated
`exports` object instead of recursing forever. Real packages contain cycles;
lodash does.

**It is bounded, and truncation is reported rather than silent.** Caps are
300 files / depth 12 by default. A partial module map fails later, deep
inside the worker, with a far worse error than "dependency limit reached" —
so hitting a cap surfaces in `mod.notes` and in the resolve evidence:

```
with maxFiles:8 -> fetched 8 | truncated: "file limit 8 reached"
notes: ["dependency walk stopped early: file limit 8 reached.
         A require() for an unfetched file will fail at call time."]
```

**Performance mattered here.** The first implementation walked depth-first,
one file at a time: cloneDeep's 108 files took **17,013ms** of purely
sequential round trips — a miserable first-import wait in a browser.
Rewritten breadth-first, fetching each level in parallel: **997ms** for the
same 108 files, same bounds, same result. 17x.

### What still does NOT work, precisely

- **Bare requires are not followed.** `require('lodash')` inside a fetched
  file is refused with a message saying so. That is a *different package*,
  not part of this module; following it would mean silently resolving a
  second dependency tree from an unknown registry.
- **Rust/Go source still cannot run.** The resolver refuses a `.rs` URL
  ("could not determine the runtime") — correctly, because nothing can
  execute it. The fetch was never the hard part; the compiler is. Precompiled
  `.wasm` from a GitHub release DOES work via the wasm runtime.
- **ESM (`import`/`export`) is not walked.** Only CommonJS `require()` is
  scanned. A file using ESM syntax will load only if self-contained.


## Bug found from a live page: `window.IVX.bridge` never existed

A user ran the exact diagnostic this doc recommends:
```js
console.log(!!window.IVX, !!window.IVX?.resolver, !!window.IVX?.bridge)
// -> true true false
```
`resolver` present, `bridge` missing. That pinpointed a real asymmetry
between the two files: `ivx_resolve.js` sets the singleton at BOTH
`window.IVX.Resolver` (the class) and `window.IVX.resolver` (the instance) --
two separate top-level assignments. `ivx_bridge.js` only ever did the first
half of that pattern: it nested the instance inside the capitalized export
(`window.IVX.Bridge.bridge`), and never set the flat `window.IVX.bridge`
that `runtime.js`'s Import wiring actually checks
(`if (!window.IVX.bridge) throw ...`).

So `window.IVX.bridge` was undefined on every real page, always -- this
would have failed for anyone, not something specific to that user's setup.
Every node-based test in this package used `require('./ivx_bridge.js').bridge`
directly, which bypassed the exact path a browser takes and never exercised
`window.IVX.bridge`. Fixed with one additive line setting the top-level
property to match `ivx_resolve.js`'s own pattern; reproduced the failure in
jsdom first (`true true false`), confirmed the fix (`true true true`), then
reran the full KH-source-to-npm-package chain to confirm nothing else moved.


## input() now works -- real synchronous blocking, not a workaround

**Why it failed:** `guess = int(input("Enter your guess: "))` raised
`OSError: [Errno 29] I/O error`. This is a real, documented Pyodide
limitation, not a bug: Python's `input()` is a SYNCHRONOUS CPython builtin
expecting a real stdin file descriptor, and the Python worker deliberately
runs inside an isolated Web Worker (so a hung script can be killed without
freezing the page) -- Workers have no stdin and no `window.prompt()`.

**Why `take` (KH) never hit this:** checked directly in `runtime.js` --
`take` is implemented as one line, `const raw = await this.onInput(node.name)`.
KH's whole interpreter is native async JS, so pausing for a value is just an
ordinary awaited Promise. Python's `input()` has no such hook: it's a plain
synchronous call, and `guess = int(input(...))` never writes `await`, so
monkey-patching it to an async JS function doesn't work -- an async
replacement returns a coroutine object, and `int(coroutine)` fails. These
are genuinely different problems, not one solved and one forgotten.

**The fix:** the same technique Pyodide's own official console uses --
`SharedArrayBuffer` + `Atomics.wait`. This is real OS-thread-level blocking,
invoked from a plain synchronous JS function, so `input()` can call it with
zero `await` and it behaves exactly like a genuine blocking read.

**Verified for real**, not mocked -- node's `worker_threads` fully implements
`SharedArrayBuffer`/`Atomics`, so this is genuine cross-thread blocking on an
actual OS thread, proven by timing:

```
worker BLOCKED, requested input with prompt: "Enter your guess: "
(main thread) providing input after 500ms delay...
eval result -> {"stdout":["got: 42"],"stderr":[]}
round trip took 504 ms -- must be >= 500ms to prove REAL blocking
```

504ms for a 500ms delay is the proof: the worker's thread was genuinely
halted on `Atomics.wait`, not polling, not racing -- it could not resume
until `Atomics.notify` was called from the other thread. Pinned as a
permanent regression test (`worker_tests.js`, section 3b) using the same
mechanism.

**What's UI-wired:** `ivx_python_ui.js` renders a real inline prompt in the
output panel when the worker blocks, and calls `worker.provideInput(text)`
on submit. Not yet run against genuine Pyodide (the mocked test above proves
the mechanism, not Pyodide's own `input` override behaving identically).

**The one requirement only your server controls:** `SharedArrayBuffer`
requires the page be served with:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
Without these headers, `SharedArrayBuffer` cannot be constructed in a real
browser at all -- this is a browser security requirement, not something
fixable from JavaScript. If `nivlahk.com` is on a static host without
header control, this may need a different hosting layer or a proxy that can
set them. The code detects absence and fails with that exact explanation
rather than a cryptic error, when `requireInput` is requested explicitly.


## Same error, twice — a real diagnostic lesson, not a failed fix

Rerunning the guessing game after the SharedArrayBuffer fix produced the
IDENTICAL `OSError: [Errno 29] I/O error`. That's not evidence the fix
didn't work -- it's evidence of a SEPARATE bug that reproduces the exact
same symptom, which is a worse failure mode than a new error would have
been, because it looks like nothing changed.

The real cause: `ivx_python_ui.js` never told `IVXWorker.init()` that input
was required. When `SharedArrayBuffer` is unavailable (missing COOP/COEP
response headers -- far more likely on a real static host than "the fix
didn't ship"), `init()` silently skipped the whole mechanism rather than
refusing, `builtins.input` was left as CPython's own, and it raised its
native OSError -- byte-for-byte the same text as before any of this work
existed.

Fixed by checking `typeof SharedArrayBuffer` BEFORE running, so the panel
explains exactly why up front:
```
input() requires this page to be served with two response headers:
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
Code with no input() calls will still run fine.
```

**A second mistake caught before shipping:** my first attempt at this fix
passed `requireInput: true` unconditionally, which made `init()` throw
*before running any code at all* whenever `SharedArrayBuffer` is missing --
breaking `print(1+1)` and every other input-free program too, not just ones
that call `input()`. Reverted: the up-front warning is enough: it tells the
user the real constraint without blocking code that never needed it.

**If your host truly cannot set custom response headers** (common on static
hosts like GitHub Pages without extra configuration), the standard
workaround is a Service Worker that intercepts the page's own request and
re-serves it with COOP/COEP injected client-side (the "coi-serviceworker"
pattern) -- achieving cross-origin isolation with no server config at all.
Not built here since it depends on confirming this is actually the
constraint on your specific host; say the word if `typeof SharedArrayBuffer`
in your console comes back `"undefined"` and I'll build it.


## "Reroute input to KH's box" -- why that doesn't work, and what does

Rerouting the *value* to come from KH's own input box doesn't help: the
problem isn't which UI element collects the text, it's that a value
collected asynchronously on the main thread has no way to reach a
synchronous call blocked on a *different thread* unless something does real
thread-blocking. KH's `take` avoids this entirely by never crossing a
thread boundary -- it's plain async JS on the main thread the whole time.
Python's `input()`, running in an isolated worker, has no such option
without `SharedArrayBuffer`.

**The real alternative: run Python on the main thread too.** A new
"interactive" checkbox in the Python panel does exactly this -- no worker at
all, Pyodide loaded directly into the page, `input()` monkey-patched to
`window.prompt()`. `window.prompt()` is a genuinely, natively synchronous
browser API: calling it actually halts JS execution (including rendering)
until answered -- the same property `Atomics.wait` provides, but needing
**zero** special headers, zero `SharedArrayBuffer`, works on any host today.

**The trade, stated plainly:** Pyodide is no longer isolated. An infinite
loop with no `input()` calls now freezes the whole tab instead of one
worker. That's why it's an opt-in checkbox, never the default.

**Verified:** the orchestration logic, via jsdom with a mocked `loadPyodide`
and a mocked `window.prompt` (the two things only a real browser/Pyodide can
supply) --

```
window.prompt was called with: ["Guess: "]
py-out contents: "68"
status: done in 4ms (main thread)
```

`input('Guess: ')` correctly reached `window.prompt`, and the returned value
flowed through stdout capture exactly as the worker-based path does. This
proves the wiring; genuine Pyodide + a real native prompt dialog still needs
one real-browser run to close out fully -- try the number-guessing game
again with "interactive" checked.


## Importing Python straight from GitHub

`#ivx-import` now handles `.py` URLs, not just JavaScript:

```python
# ivx-import: https://raw.githubusercontent.com/user/repo/main/helpers.py as helpers

import helpers
print(helpers.something())
```

The resolver fetches the file, walks its SIBLING imports, writes them all
into Pyodide's virtual filesystem, and puts that directory on `sys.path`.
From there CPython's own import machinery does the rest -- no proxying at
all, unlike the JS case, because these files are already Python.

Verified against a real GitHub file with a genuine sibling import:
```
entry: https://raw.githubusercontent.com/psf/requests/main/src/requests/status_codes.py
  source contains: from .structures import LookupDict
  -> walk fetched 3 files: status_codes.py, structures.py, compat.py
```
It followed `.structures`, then transitively picked up `compat.py`, and
skipped `os`/`sys`/stdlib automatically -- those 404 as siblings, so they
fall through to Pyodide's own resolution, which handles them correctly.

**One behaviour worth knowing:** `as <name>` is IGNORED for Python. A
module's importable name is its filename, because that is what Python's
import system keys on -- renaming it would break any `from .sibling import
x` between the fetched files. The panel prints the real name to import if it
differs from what you wrote.

**Not supported:** packages (directories with `__init__.py`), and bare
`import somepackage` for anything not sitting next to the entry file. Those
need PyPI via micropip, not a raw URL.

## Two test-harness bugs found while building this

Both made tests pass for the wrong reason -- worse than failing.

**1. `check()` in `run_tests.js` was synchronous.** It called `fn()` without
awaiting, so an async test's rejection escaped as an unhandled rejection
AFTER the summary printed "0 failed". Async tests were effectively not
running. Making it async-aware immediately surfaced **three genuinely failing
tests** that had been sitting green -- including two `walkRelativeDeps` cap
tests written earlier in this session that had never actually verified
anything.

**2. Those three tests then failed for a second, unrelated reason:** they
each assigned `global.fetch` and restored it in a `finally`. Once they
actually ran, they ran CONCURRENTLY and stomped each other's mocks -- one
test's `finally` restored the real fetch while another was still mid-walk.
Standalone, each passed; together, they didn't.

Fixed properly rather than by serializing: `walkRelativeDeps` and
`walkPythonDeps` now accept an injectable `opts.fetchImpl`, so tests never
touch shared global state at all. Better design independent of the test
problem.


## Relative imports: flat sys.path was wrong, packages are right

First real multi-file GitHub Python import failed:
```
# status_codes: 3 file(s) from .../requests/.../status_codes.py
ImportError: attempted relative import with no known parent package
  File "/ivx_modules/status_codes.py", line 21, in <module>
    from .structures import LookupDict
```

Everything up to that point worked -- directive parsed, 3 files fetched and
walked, written to Pyodide's FS, sys.path set, and `import status_codes`
FOUND the module (it reached line 21 of it). The bug was the layout: files
were written FLAT on sys.path as top-level modules, and `from .structures
import` is a RELATIVE import, which needs a parent package to be relative
to.

Reproduced and fixed against real CPython locally before touching any JS:

```
flat layout      -> ImportError: attempted relative import with no known parent package
package + alias  -> codes.ok = 200   (works)
```

Files now go inside a package directory (`_ivx_<entry>/` with an
`__init__.py`), then a `sys.modules` alias maps the entry module back to its
plain name -- so relative imports between the fetched files resolve, AND
your ordinary `import status_codes` still works rather than forcing you to
write the internal package name. Stale entries are cleared from
`sys.modules` first so re-running picks up a re-fetched module.

## A guard for a mistake I kept repeating

`ivx_worker_runtime.js` holds the worker source as a `String.raw` template.
A backtick anywhere inside it -- **including inside a comment** -- silently
terminates the literal and turns the rest of the file into garbage, showing
up as a confusing syntax error somewhere unrelated. This bit four separate
times across this session while editing comments in that region.

`run_tests.js` section [4c] now checks for it directly: it locates the
template bounds and fails with the exact line number if a backtick appears
inside. Cheap, and it converts a recurring confusing failure into an
immediate specific one.


## Third-party deps auto-install now

The package fix from the previous section WORKED -- the next traceback
proved it by getting three relative-import levels deep:

```
_ivx_status_codes/status_codes.py:21  from .structures import LookupDict
_ivx_status_codes/structures.py:14    from .compat import MutableMapping
_ivx_status_codes/compat.py:22        from urllib3 import __version__
ModuleNotFoundError: No module named 'urllib3'
```

Relative imports resolving three levels down inside the fetched package is
exactly what was broken before. What failed instead was a genuine
third-party dependency: `urllib3` ships IN the Pyodide distribution but is
not LOADED until asked, and Pyodide's own error names the remedy.

`loadPyModule` now catches `ModuleNotFoundError`, extracts the module name,
runs `pyodide.loadPackage(name)` (falling back to `micropip.install(name)`
for anything not in the distribution), and retries -- bounded at 8 attempts,
each name tried once, so a genuinely unavailable package surfaces its real
error instead of looping. Installs are reported in the output
(`# auto-installed: urllib3`) and progress shows in the status line, since a
package download is a real wait.

Verified against a mock that reproduces the exact failure shape:
```
progress -> ["installing urllib3..."]
reply    -> {written: [...], entry: "status_codes", installed: ["urllib3"]}
```

## The input() warning was printing on every run

It appeared above every single program's output, including ones that never
call `input()` -- pure noise stacked on top of real errors, which made
genuine tracebacks harder to read. Now gated on the code actually containing
an `input(` call, and it points at the "interactive" checkbox as the
alternative rather than only naming the two headers.
