# IVX glue layer — status

```
node run_tests.js      # 101 passed, 0 failed   static + engine-backed + FLAT + ABI
node verify_patch.js   #  71 passed, 0 failed   patched vs original, side by side
node differential.js   # 541 passed, 0 failed   41 programs + 500 fuzz cases
                       #                        (FUZZ=n, FNFUZZ=n, MODE=liveout|bare|sink)
node worker_tests.js   #  31 passed, 0 failed   Phase 4, real workers
node abi_tests.js      #  37 passed, 0 failed   calling convention, recursion
```

**`Soak_tester.patched.html` is the deliverable engine** — drop it in and
`print` works. Everything auto-detects it and falls back to patching a
loaded copy of the original in memory if it isn't there.

`differential.js` takes `FUZZ=<n>` and `MODE=liveout|bare|sink`.

| file | what it is |
|---|---|
| `ivx_resolve.js` | Phase 1 — package resolver, runtime detection, integrity pinning |
| `ivx_lower_contract.js` | Phase 2 — type contract, dialect constraints, invariant checkers, `CFEmitter` |
| `ivx_lower.js` | Phase 2 — the lowerer (kinded UAST → CF text + source map) |
| `ivx_altitude.js` | Phase 3 — bidirectional projection over the map |
| `engine_node.js` | loads `Soak_tester.html`'s engine into node, unmodified |
| `differential.js` | lowered SEER vs an independent evaluator, plus a seeded fuzzer |
| `ivx_workers.js` | Phase 4 — worker pool, transports, lifecycle |
| `ivx_worker_runtime.js` | Phase 4 — the code that runs *inside* a worker |
| `ivx_bridge.js` | Phase 4 — resolver→pool→kernel wiring, hoistability |
| `run_tests.js` | everything else |
| `worker_tests.js` | Phase 4 suite (async, spawns real threads) |
| `abi_tests.js` | calling convention, recursion, capability memory |
| `Soak_tester.patched.html` | **the patched engine — use this one** |
| `apply_patch.py` | regenerates it from a clean `Soak_tester.html` |
| `verify_patch.js` | proves the patch is invisible when its features are unused |

---

## What changed in the engine

`Soak_tester.patched.html` — 14 anchors, +2.9KB, all additive: every new
parameter is optional, every new return field is extra.
`python3 apply_patch.py` regenerates it and **fails loudly** if any anchor
doesn't match exactly once, so it can't silently patch nothing or patch
twice.

### A. Live-out (makes `print` possible at all)

`stage2Allocate` gains an optional third argument.

```diff
-function stage2Allocate(raw, enableMetaCF) {
+function stage2Allocate(raw, enableMetaCF, liveOut) {
-  const liveInMain = s2LiveList(mainStmts, new Set(), ctx);
+  const liveInMain = s2LiveList(mainStmts, new Set(liveOut || []), ctx);
```

Without it, `s2LiveList` gets a hardcoded empty live-out set, so a name
written and never read is dead at once and its register is reused. With
`ecall` having no architectural effect, that left a compiled program with no
defined output channel.

Measured, not assumed: `MODE=bare` (unpatched, no workaround) fails
**478 of 529**. My first control run was unfair — it used the sink epilogue,
which is itself harmful — so I re-measured with a three-way mode switch.
A handful of small programs do survive unpatched by luck, which is exactly
why this needed measuring rather than asserting.

Two workarounds were tried first and both fail for reasons that generalise.
Anchoring a result in a name doesn't work: nothing reads it, so every
`__outN` correctly gets the same register. An epilogue that *reads* them
into a sink doesn't work either: the sink is written exactly when the last
output dies, so the allocator aliases them and the sink overwrites the value
it just read — which is why results came back at exactly 2× (`70000` →
`140000`). Any in-register scheme has that shape. The allocator is right
every time; what was missing is a way to state what's live at exit.

### B. Source map (makes the FLAT altitude possible)

Three side-channel arrays that chain, plus origin stamping:

- `stage2Allocate` → `raw2Map` (raw2 line → raw line)
- `compileCFSource` → `srcMap` (output line → input line), plus
  `bootPrefixLines` / `setupLineCount` so the prefix offset is visible
  rather than silently baked in
- `parseProgram` → `.srcLine` on each item
- `cfCodegenBlock` stamps `srcLine` on every emitted node (one change
  covers every node type; innermost statement wins)
- `parseStatement` stamps `lineNo` on **all** statement types — it
  previously only tagged plain instructions, so every branch and connector
  nop came out untraced, i.e. exactly the control flow a reader most wants
  to trace

Composed, this gives assembled instruction → PC/bytes/cycles → flat line →
compiled line → raw2 line → raw line → UAST node → the user's own text.
Null at any link means "the engine synthesized this" (CN-table setup, boot
prefix, spill traffic, appended `hlt`) — those rows stay visible at FLAT
altitude but are never attributed to the user.

`word_kh.js` also gained line tracking, additively; without it every traced
row reported line 0.

Sample output, real bytes from the patched engine:

```
   PC  bytes         instruction         origin
   96  21 01 00 00   li r1, 0            L1 make i 0        [Assign/body]
  100  21 00 00 04   li r0, 4            L2 loop i < 4      [Loop/const]
  109  1e 01 00 03   jge r1, r0, 3       L2 loop i < 4      [Loop/cond]
  117  1b 01 02 02   jne r1, r2, 2       L3 if i = 2        [If/cond]
  121  21 03 00 01   li r3, 1            L4 make hit 1      [Assign/body]
  130  4b 01 01 01   addi r1, r1, 1      L5 make i i + 1    [Assign/body]
  147  03            hlt                 [engine]
```

### Is it safe?

`verify_patch.js` runs both engines side by side over a corpus that includes
a **spilling** program (42 names spilled, so the `raw2Map` rewrite of the
spill loop is genuinely exercised) and asserts byte-identical output at
every stage with the new arguments omitted: allocation, `raw2`, compiled
text, assembled byte stream, step count, and the final register file.
71/71.

It also caught two of my own mistakes: an IIFE wrapper that made `continue`
a SyntaxError, and two versions of a test that failed on their own premise
by asserting register *distinctness* when the property that actually matters
is read-back *correctness*.

## Things the engine taught me that I had wrong

**`li` is a `PP` pseudo-op, not an opcode.** I had marked it *verified*
because `stage2Allocate` emits it, and marked `add`/`sub`/`mul`/`slt`
*unverified* because I'd never seen the ALU table. The check inverted both:
all four guesses were right, and `li` is not in `OPCODES` at all — `encode()`
resolves it to `li.captr` or `addi rd,zr,imm8`. "The allocator emits it, so
it must be an instruction" was the wrong inference.

**`li`'s range is 0..0xFFFF or -128..-1 and nothing else.** It throws at
*assembly* time, long after lowering looks clean — `make a 70000` compiled
fine and died in `parseProgram`. Constants outside that window are now built
by shift/accumulate over 16-bit chunks and negated from `zr`;
`assertLiRange` catches regressions.

**`div`/`mod` return 0 on a zero divisor** rather than trapping, and both
truncate toward zero. Differs from most host languages and fails silently.

**Read-back capacity is bounded by `regDepth`.** Live-out values past the
register count spill to dmem, where nothing currently reads them back —
`stage2Allocate` returns the `spilled` name list but not the slot→address
map. 24 variables is fine at depth 64; 40 (80 outputs after the harness adds
a print per variable) is not.

## Bugs found in my own code

1. `CFEmitter` spans were flat; statements nest. Rewrote as a stack with
   per-line attribution, which makes map totality structural.
2. The `or` lowering emitted **invalid CF** — condition constants for later
   arms landed between an arm's body and the following `elif`, and
   `parseCFSource` only continues a chain while the next same-indent line
   literally starts with `elif`. Pinned by a regression test.
3. `REFUSAL_CODES` values were prose, so nothing was machine-assertable.
4. `ivx_resolve.js` assumed `window` at module scope and couldn't be tested
   outside a browser.
5. The differential's first version read every variable's register at halt
   and reported ten mismatches — all ten were the harness reading dead
   variables. Comparison now goes through the print channel only.
6. The fuzzer generated `v1 - -85 * 72`; KH's subset has no unary minus, so
   that was invalid input to the thing under test, not a lowering failure.

---

## Phase 4 — worker bridge

Same worker source runs under browser `Worker` (via Blob URL) and node
`worker_threads`, so the node tests exercise the real thing rather than a
mock. One runtime per worker, so "the worker hung" always names which
foreign module hung.

| runtime | status |
|---|---|
| `js` | **real, tested** — 6 tests |
| `wasm` | **real, tested** against a hand-assembled module |
| `python` | written, **UNVERIFIED** — needs a ~10MB Pyodide fetch, unreachable here |
| `go` | written, **UNVERIFIED** — and deliberately *not* a Go compiler; runs a prebuilt `.wasm` plus `wasm_exec.js` |

### The constraint that shapes it

`simulateProgram` is **synchronous**: no `async`, no resume entry point, no
initial-state parameter. A worker call is asynchronous by construction.
So **a lowered SEER program cannot call a worker mid-execution** — not
"doesn't yet", *cannot*, with this entry point.

Two honest options. **(a) Hoist**: foreign calls run before or after the
SEER program, values cross at the boundary. This is already the shape
`ivx_kernel.js` uses — `word` and `bind` are top-level statements — so
Phase 4 fits the existing design rather than fighting it. **(b) Segment**:
split at each call, run to halt, await, resume from saved state. Needs
`simulateProgram` to take an initial `{reg, mem}`, in the same additive
style as the live-out patch. Not done: each segment would re-run the
stack-capability boot prefix, which writes registers, so resumption isn't
merely "restore and continue" and that correctness argument deserves its
own pass.

`isHoistable()` implements (a) and **detects** when a program needs (b),
using emitted indentation — the same signal `parseCFSource` uses to decide
nesting, so it cannot disagree with the compiler. A call inside a loop is
refused with reasons attached, rather than being hoisted and silently
running once instead of per-iteration.

Working end to end: a JS worker computes `3 * 14 = 42`, the value crosses
into SEER as a materialized constant, SEER computes `42 + 8`, and `50`
reads back out of the register file. Same path verified with a wasm worker.
Non-integer crossings are refused, not coerced — the implemented OPU tier
is integer-only.

### Design decisions worth flagging

- **Every call has a timeout, and a timeout kills the worker.** A foreign
  infinite loop cannot be interrupted from outside — a worker only checks
  for messages between tasks — so termination is the only real remedy.
- **Nothing is implicit about the network.** The pool never fetches;
  Phase 1 hands over bytes it already pinned. Pyodide's `indexURL` and Go's
  `wasm_exec.js` must be passed explicitly. On a zero-egress platform, a
  default CDN constant is how an accidental fetch ships.
- **`bind` results stay HOSTED.** A value that crossed into a worker is
  correct but not representable in IVX's terms — opaque, not zoomable.
  Same line `ivx_kernel.js` already draws.

### Bugs found in Phase 4

1. **A dead worker kept its pool slot.** `acquire()` only considered
   live-but-idle workers as eviction victims, so a pool full of timed-out
   corpses could never be recovered — every later acquire failed with
   "pool is full", the exact leak the timeout existed to prevent. Now
   reaped first; pinned by a regression test.
2. **A failed `init` left the worker alive**, which hung node at exit and
   would leak a thread in the browser. `init` now self-terminates on
   failure.

## ABI — tested, and my first decision was wrong

**Fixed slots (`__arg0..N` / `__ret0`) are unsound for recursion.**
`fact(4)` returns **8**, not 24 — 2³, because every frame reads the
innermost frame's saved value. My reasoning had been that `stage2Allocate`'s
spilling would cover re-entrancy. It cannot: a spill slot is a *fixed dmem
address per name*, not a stack, so recursion overwrites it exactly the way a
register would. "The allocator handles it" was the wrong inference.

Worse, **`fact(2)` passes** — only one frame ever needs preserving and it's
the last one written. A shallow smoke test would have shipped this.

**Corrected ABI: a real call stack in dmem.** The stack-capability token can
be built from CF source using only `li`/`sll`/`or` — the same 12
instructions `generateStackCapTokenLines` emits, but with symbolic names
instead of the spill machinery's reserved registers. So this needed **no
engine change**. `__sp` starts at the top of dmem and grows down; spill
slots grow up from `SPILL_BASE_ADDR`, so they only meet after a few hundred
frames. Verified `fact(8) = 40320`, and a recursive program that *also*
spills keeps both regions intact.

**The front end now reaches it.** `word_kh` gained `fun name(a, b)` and
`give expr` (names taken from the editor's own tutorial buttons), and the
lowerer emits `def`/`call` against the stack ABI. Working end to end from KH
source: `fact(8) = 40320`, and `fib(10) = 55` — two recursive calls per
frame, the hardest case.

### Caller-saves: liveness-driven

First version pushed every function-local before every call. Correct, but
ABI scaffolding was **64%** of a recursive program and recursion capped at
**~149 frames**. Now a local is pushed only if something reads it after the
call:

| shape | v1 (save all) | v2 (reads-after) | v3 (+ kill-tracking) |
|---|---|---|---|
| `fact` | 3 /frame | 2 | **1** |
| `fib` | 4 /frame | 4 | **2** |
| depth limit | ~149 frames | — | **~447 frames** |

v2 wasn't enough on its own: it counted a read even when the value was
overwritten first, so `make y fb(b)` pushed `y` whose only later read comes
*after* `y` is reassigned. v3 tracks kills — a name is live only if its
**first** event after the call is a read — and excludes the call
statement's own assignment target, since the result overwrites it anyway.

It is a syntactic approximation, not a real CFG pass, and every
approximation only ever **adds** names: a call inside a loop saves anything
read anywhere in that loop (the back edge makes "later in the text" the
wrong question), and branches aren't distinguished. Under-saving is the
fixed-slot failure — silent and wrong — so the bias is deliberate.
`abi_tests.js` pins the per-frame save counts as budgets, so a regression
that re-broadens the set shows up as a number rather than a vague slowdown.

**Mutual recursion works**, and so do forward references — a call may
precede its `fun`. That holds by construction: function bodies are emitted
after main, so every name is registered before any body is lowered, and
`cfLinkCalls` resolves eagerly regardless. Tested: `f↔g` even/odd, a
three-way `a→b→c→a` cycle, and mutual accumulation.

Refused rather than half-handled: nested calls in an argument
(`NESTED_CALL_ARG` — assign to a variable first), arity mismatches, nested
`fun` (`NO_CLOSURE`), and `give` at the top level.

### Register-namespace collision (found by the function fuzzer)

A user variable named `r0` is **indistinguishable from physical register 0**.
`stage2Allocate` doesn't allocate it (it looks already-allocated) and
`substituteSymbolicNames` leaves it alone, so it silently collides with
whatever the allocator puts there — confirmed: `make r0 5` produced a
program where `r0` and another variable shared the register.

Colliding names (`r\d+`, `zr`) are now mangled to `__u_<name>`; ordinary
names are untouched, so emitted CF and the Phase 3 altitude views stay
readable. The fuzzer found this on its very first seed by generating `r0` as
a variable name — a case I would not have thought to write.

## Engine bug found: capability addresses lost precision

**Independent of the ABI, and it made spilling silently wrong.**

`sts64`/`ld64`/`ld.s32`/`sts32` computed the effective address as
`Number(RD(cap)) + Number(RD(ptr))`. The interpreter's own comment at
`li.64` says it models `cap.base + offset` — i.e. `RD(cap)` is meant to be a
*base*. But `generateStackCapTokenLines` puts a full **authenticated token**
there (`idx | gen<<16 | mac<<32`), which for the stack capability is
`8230353620671987712`. At that magnitude float64 spacing is **2048**, so
every address within 2048 bytes of another collapsed onto it.

Spill slots are 8 bytes apart (512, 520, 528…), so they all aliased:

```
sum v0..v69 where v_k = k+1     expected 2485   actual 2695
sum v0..v89                     expected 4095   actual 4915
```

Values that stay in registers are correct; only spilled ones are wrong,
which is why it went unnoticed. My own earlier `many_vars` test used 24
variables and never spilled, and `verify_patch.js` compared original against
patched — both were equally wrong, so they matched.

**Fix** (section C of `apply_patch.py`): compute the address in BigInt and
mask to 32 bits, giving an exact, `Number`-safe key. Each installed
capability keeps its own region and offsets within it stay distinct.
Store/load round-trips are preserved, which is all the soak scenarios depend
on — they assert on **register** values after a load, not absolute
addresses.

**This one is a deliberate behaviour change**, unlike the live-out and
source-map patches. `verify_patch.js` now asserts that explicitly in section
`[2a]`: a non-spilling program is unaffected, and a spilling program was
wrong before and is right after. That section exists because the original
"identical execution" test *passed* after the fix landed — the spilled
values end up unallocated and were never read back into a compared register,
so the test was too weak to notice a change it should have caught.

**Not a full capability model.** This does not decode base/bounds or check
permissions, so the simulator still cannot catch a capability violation on a
memory op. That is a separate and larger decision — your call.

### Recursion depth is bounded, and the simulator won't tell you

Usable stack is `dmem - 8 - SPILL_BASE_ADDR` = 3576 bytes → 447 pushes →
**447 frames at 1 save/frame**. Past that, `__sp` runs below the capability
base.

The simulator does not bounds-check capabilities, so it keeps going and
returns the **right answer** — `f(600)` produced the correct 180300 while
touching 1797 addresses outside the 4KB dmem region. Real hardware would
trap. That is a simulator/hardware divergence, and `abi_tests.js` asserts it
as a known behaviour rather than letting it read as a pass.

Recursion and heavy spilling do coexist correctly: 200 spilling locals
alongside a recursive call keeps both the call stack and the spill region
intact (156 names spilled, both checksums exact). An earlier version *did*
break here — `stage2Allocate` rejected `sts64 s, __cap, __sp` with "uses 3
spilled names in one instruction" once `__cap` and `__sp` were themselves
spilled. Fewer saves relieved the pressure, but the underlying fragility is
real: **`__cap` and `__sp` are live for the whole program and there is no
way to pin them**, so a sufficiently register-hungry program could hit it
again.

## Open

- **Pinning `__cap`/`__sp`.** They must stay in registers for the whole
  program, but nothing enforces it; a register-hungry program can spill
  them and `stage2Allocate` then rejects the ABI's own push instruction.
  A `reserved`-style mechanism (like the spill machinery already has) would
  close it.
- **Stack-overflow detection.** Nothing checks `__sp` against the spill
  region. A guard costs a comparison per call; alternatively the simulator
  could bounds-check capabilities, which would also close the
  simulator/hardware divergence above.
- **Capability enforcement in the simulator.** Memory ops now address
  correctly but still aren't bounds- or permission-checked.
- **Reading spilled outputs.** `raw2Map` landed but the slot→address map
  did not, so an output that spills still reads back `<spilled>`. Bounded
  by `regDepth`; 24 variables is fine at depth 64.
- **Wiring FLAT into the editor.** `projectFlat` returns the rows;
  `onZoningToggleChange` still overwrites the buffer destructively and
  should become a projection instead.
- **`while a and b`.** Refused, not approximated. Needs a recomputed flag at
  the top of each iteration; the correctness argument is about where the
  recomputation lands relative to the back edge.
- **Phase 1 is untested against the network from a browser.** The pure
  functions are covered and the archive readers were verified against a real
  npm tarball and a real PyPI wheel, but `IVXResolver.resolve()` itself has
  only been exercised by hand. The Go path is unverified end to end and
  assumes a relay.
- **Pyodide and Go need one browser run each** to move from written to
  verified. Everything else in Phase 4 is tested.
- **Segmented execution** (option (b) above) if you ever want a foreign
  call inside a loop.
