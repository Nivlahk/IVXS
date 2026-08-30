# KH — a browser-native IDE that speaks every language, down to the metal

Write code and run it instantly, with nothing installed. KH runs its own
language, real Python, and real JavaScript side by side, can pull in a
package from npm, PyPI, or a GitHub repo by URL, and can show you the same
program at every level of abstraction at once — from the line you typed
down to the actual machine bytes a custom CPU executes.

No installer, no terminal, no "works on my machine." Open a tab, write
code, press run.

## What you can do with it

**Write KH**, a language built for this environment, with real functions
and recursion, compiling to SEER — a CPU instruction set designed
alongside it, with a working simulator and a path toward real hardware:

```
from _ by "npm:lodash"
make scores [88, 92, 79, 92, 61, 88, 95]
print _.takeRight(_.sortBy(scores), 3)   # [92,92,95] — a real npm package, really running
```

**Or write real Python** — actual CPython compiled to WebAssembly, not a
subset:

```python
# ivx-import: https://raw.githubusercontent.com/psf/requests/main/src/requests/status_codes.py as status_codes
import status_codes
print(status_codes.codes.ok)   # 200 — a real file pulled straight off GitHub
```

Python and JavaScript can even call into each other in the same program.

**Zoom into any program** with a live panel showing your source, the
intermediate instructions it becomes, and the real machine bytes and cycle
counts a CPU would execute — each traced back to the line responsible.

**Import from anywhere**: npm, PyPI, a CDN, or a raw GitHub URL, all
resolved the same way, following multi-file dependencies automatically.
Everything fetched is hashed and pinned so it can't silently change later.

## How it fits together

| Layer | What it does |
|---|---|
| **KH** | Language: parser, interpreter, compiler targeting SEER |
| **SEER** | Custom CPU instruction set, assembler, simulator |
| **The Lens** | Live abstraction viewer — source ↔ IR ↔ machine code |
| **Import Resolver** | Turns a package name or URL into runnable, integrity-checked code |
| **Runtime Bridge** | Runs Python/JS in isolated workers; lets them talk when asked |

## Try it

Open `index.html`. Use the main editor for KH, the Python panel for real
CPython. Import external code with KH's `from Name by <specifier>` or a
`# ivx-import:` comment at the top of a Python file.

## Honest status

**Working:** the KH language and its compiler to real SEER machine code,
including recursion; the live abstraction lens; real Python and JS
execution; imports from npm/PyPI/GitHub/CDNs, multi-file included; calling
JS from Python.

**Works, with setup:** interactive `input()` in Python needs either two
server response headers or an alternate mode that trades isolation for
simplicity.

**Not supported:** compiling Rust/Go source — no in-browser compiler
exists for them (a precompiled WebAssembly build works fine). The SEER
simulator doesn't yet enforce memory bounds or permissions.

**Rough edges:** the import resolver and worker bridge work but have no
dedicated UI yet. The old destructive "materialize" view still exists
alongside the newer, non-destructive lens.

## Contributing

Issues and PRs welcome. Detailed engineering notes live alongside the
source for anyone digging into internals — this file is the map, not the
terrain.
