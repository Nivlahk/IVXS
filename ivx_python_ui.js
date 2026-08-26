// ── ivx_python_ui.js ────────────────────────────────────────────────────────
// Write LITERAL Python and run it. Not KH styled to look like Python via
// LensTranspiler (a cosmetic skin over the same KH semantics) -- this sends
// the buffer's actual text to a real Pyodide interpreter in a worker and
// runs it as Python.
//
// ── What is and isn't verified ──────────────────────────────────────────────
// The worker-side protocol (init handshake, importScripts call, stdout/
// stderr capture, exception surfacing) is tested in pytest2.js against a
// mocked loadPyodide -- that proves this file's own code, not Pyodide's.
// The actual ~10MB pyodide.js fetch has NOT been exercised: this sandbox's
// egress proxy returns HTTP 403 for cdn.jsdelivr.net specifically (checked
// directly with curl). That is a property of THIS TOOL SANDBOX's allowlist,
// not a prediction about your browser -- jsdelivr is one of the most widely
// used CDNs on the internet and ordinary browsers reach it fine. Still,
// "the real fetch has never succeeded here" is a fact worth stating plainly
// rather than implying more confidence than the evidence supports. Press
// Run once on a real page with real internet access to close that gap
// yourself; the status line reports exactly what happens.
'use strict';

;(function () {
  const ROOT = window;
  const $ = id => document.getElementById(id);

  // Pyodide's real, official CDN. Overridable via #py-index-url for anyone
  // self-hosting a copy or using a mirror.
  const DEFAULT_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
  const WORKER_KEY = 'python-repl';

  function els() {
    return {
      panel: $('py-panel'), src: $('py-src'), out: $('py-out'),
      run: $('py-run'), status: $('py-status'), urlInput: $('py-index-url'),
      min: $('py-minimize'), interactive: $('py-interactive'),
    };
  }

  function setStatus(text, kind) {
    const { status } = els();
    if (!status) return;
    status.textContent = text || '';
    status.className = 'py-status' + (kind ? ' py-' + kind : '');
  }

  function appendOut(text, cls) {
    const { out } = els();
    if (!out) return;
    const line = document.createElement('div');
    line.className = 'py-line' + (cls ? ' py-' + cls : '');
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  }

  /**
   * Renders a real, inline text prompt in the output area and resolves
   * `onSubmit(text)` when the user answers -- the UI-side half of the
   * SharedArrayBuffer/Atomics.wait blocking mechanism in ivx_workers.js.
   * The worker's OS thread is genuinely halted on the other end of this;
   * nothing runs there again until onSubmit is called.
   */
  function showInlinePrompt(promptText, onSubmit) {
    const { out } = els();
    if (!out) { onSubmit(''); return; }   // no UI to prompt in -- answer empty rather than hang forever
    const row = document.createElement('div');
    row.className = 'py-line py-prompt-row';
    const label = document.createElement('span');
    label.className = 'py-prompt-label';
    label.textContent = promptText || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'py-prompt-input';
    row.appendChild(label);
    row.appendChild(input);
    out.appendChild(row);
    out.scrollTop = out.scrollHeight;
    input.focus();

    const submit = () => {
      const val = input.value;
      row.classList.add('py-prompt-answered');
      input.disabled = true;
      appendOut((promptText || '') + val, 'echo');
      row.remove();
      onSubmit(val);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  }

  let pool = null;
  function getPool() {
    // Reuses the Phase 4 pool that ships in this package rather than
    // spinning up a second one -- one process-wide worker budget.
    if (ROOT.IVX && ROOT.IVX.Bridge && ROOT.IVX.Bridge.bridge) pool = ROOT.IVX.Bridge.bridge.pool;
    else if (ROOT.IVX && ROOT.IVX.Workers) pool = pool || new ROOT.IVX.Workers.IVXWorkerPool({ maxWorkers: 4 });
    if (!pool) throw new Error('ivx_workers.js is not loaded.');
    return pool;
  }

  // ── Main-thread interactive mode ────────────────────────────────────────
  // Runs Pyodide directly on the page's JS thread instead of in a worker,
  // and monkey-patches input() to window.prompt(). window.prompt() is a
  // genuinely, natively synchronous browser API -- calling it actually
  // halts JS execution (including rendering) until answered, the same
  // property Atomics.wait gives, but it needs NO SharedArrayBuffer, no
  // COOP/COEP headers, works on any host today.
  //
  // The trade this makes explicit: Pyodide is no longer isolated in a
  // worker, so an infinite loop with no input() calls now freezes the
  // whole tab instead of just one worker. Opt-in for that reason -- never
  // the default path.
  let _mainThreadPyodide = null;
  async function loadMainThreadPyodide(indexURL) {
    if (_mainThreadPyodide) return _mainThreadPyodide;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = indexURL + 'pyodide.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error(`failed to load ${s.src}`));
      document.head.appendChild(s);
    });
    const py = await ROOT.loadPyodide({ indexURL });
    const stdoutBuf = [];
    if (typeof py.setStdout === 'function') py.setStdout({ batched: s => stdoutBuf.push(s) });
    py.globals.set('__ivx_main_input', promptText => {
      const v = ROOT.prompt(promptText == null ? '' : String(promptText));
      return v === null ? '' : v;   // Cancel returns null; input() never does
    });
    py.runPython(
      'import builtins\n' +
      'def _ivx_main_input(prompt=""):\n' +
      '    return __ivx_main_input(prompt)\n' +
      'builtins.input = _ivx_main_input\n'
    );
    _mainThreadPyodide = { py, stdoutBuf };
    return _mainThreadPyodide;
  }

  // ── #ivx-import directives ──────────────────────────────────────────────
  // Python's own import grammar only accepts dotted module names --
  // import "https://..." is a SyntaxError in real CPython, which is what
  // Pyodide runs. So the URL lives in a comment (still valid Python) and the
  // module is loaded BEFORE the program runs. Your code then uses an
  // ordinary import.
  //
  // Shared by BOTH execution paths. The worker path and the main-thread
  // interactive path load modules by completely different mechanisms
  // (postMessage vs. direct calls), so they pass their own loaders in --
  // otherwise directives silently did nothing in interactive mode, which is
  // exactly the bug this refactor exists to prevent.
  const DIRECTIVE_RE = /^\s*#\s*ivx-import:\s*(\S+)\s+as\s+([A-Za-z_]\w*)\s*$/;

  function parseDirectives(code) {
    const out = [];
    for (const line of code.split('\n')) {
      const m = DIRECTIVE_RE.exec(line);
      if (m) out.push({ specifier: m[1], name: m[2] });
    }
    return out;
  }

  async function applyDirectives(directives, loaders) {
    for (const d of directives) {
      setStatus(`resolving ${d.specifier}…`);
      if (!ROOT.IVX || !ROOT.IVX.resolver) throw new Error('ivx_resolve.js is not loaded.');
      const mod = await ROOT.IVX.resolver.resolve(d.specifier);

      if (mod.runtime === 'python') {
        // A .py file off GitHub: fetch it plus any sibling modules it
        // imports, write them into Pyodide's virtual filesystem, and put
        // that directory on sys.path. CPython's own import machinery does
        // the rest -- no proxying needed, unlike the JS case, because these
        // files are already Python.
        //
        // The `as <name>` is IGNORED for Python: a module's importable name
        // is its filename, which is what Python's import system keys on.
        // Renaming would break any `from .sibling import x` between the
        // fetched files.
        const src = mod.source
          || (mod.files && mod.files.get('<entry>') && new TextDecoder().decode(mod.files.get('<entry>')));
        if (!src) throw new Error(`could not read source for ${d.specifier}`);
        setStatus(`walking python imports for ${d.specifier}…`);
        const walked = await ROOT.IVX.walkPythonDeps(mod.resolvedUrl || d.specifier, src);
        const res = await loaders.loadPy(walked.files, walked.entryName);
        const written = (res && res.written) ? res.written.length : Object.keys(walked.files).length;
        if (res && res.installed && res.installed.length) {
          appendOut(`# auto-installed: ${res.installed.join(', ')}`, 'note');
        }
        appendOut(`# ${walked.entryName}: ${written} file(s) from ${d.specifier}`
          + (walked.entryName !== d.name ? ` — import it as "${walked.entryName}", not "${d.name}"` : ''), 'note');
        if (walked.truncated) appendOut(`# warning: ${walked.truncated}`, 'stderr');
        continue;
      }

      if (mod.runtime !== 'js') {
        throw new Error(`#ivx-import supports JavaScript and Python modules; `
          + `'${d.specifier}' resolved as '${mod.runtime}'.`);
      }

      const entryFile = mod.entry || '<entry>';
      const raw = mod.files && (mod.files.get(entryFile) || mod.files.get('<entry>'));
      const jsSrc = mod.source || (typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      setStatus(`loading ${d.name} into Python…`);
      const names = await loaders.loadJs(d.name, jsSrc, mod.moduleMap || null, mod.entryPath || null);
      appendOut(`# ${d.name}: ${Array.isArray(names) ? names.length : 0} export(s) from ${d.specifier}`, 'note');
    }
  }

  async function runMainThread(code, indexURL) {
    const { py, stdoutBuf } = await loadMainThreadPyodide(indexURL);
    stdoutBuf.length = 0;
    const runner = typeof py.runPythonAsync === 'function' ? py.runPythonAsync : py.runPython;
    const result = await runner.call(py, code);
    const value = result && typeof result.toJs === 'function' ? result.toJs() : result;
    return { value, stdout: stdoutBuf.slice(), stderr: [] };
  }

  let running = false;
  async function run() {
    const { src, run: runBtn, urlInput } = els();
    if (!src || running) return;
    const code = src.value;
    if (!code.trim()) { setStatus('nothing to run'); return; }

    running = true;
    if (runBtn) runBtn.disabled = true;
    setStatus('starting Python…');
    const started = Date.now();

    try {
      const { interactive } = els();
      const indexURL = (urlInput && urlInput.value.trim()) || DEFAULT_INDEX_URL;

      if (interactive && interactive.checked) {
        // No SharedArrayBuffer needed at all -- input() is answered by a
        // genuinely, natively synchronous browser API. The cost: Pyodide
        // now shares the main thread with the page, so an infinite loop
        // with no input() calls freezes the tab instead of one worker.
        const { py } = await loadMainThreadPyodide(indexURL);
        await applyDirectives(parseDirectives(code), {
          loadPy: async (files, entryName) => {
            // Must mirror the worker's loadPyModule exactly -- files go
            // inside a PACKAGE so relative imports (from .sibling import x)
            // resolve, then a sys.modules alias keeps the user's plain
            // `import name` working. Flat-on-sys.path fails on the first
            // real multi-file module.
            const ROOTDIR = '/ivx_modules';
            const pkg = '_ivx_' + entryName;
            const dir = ROOTDIR + '/' + pkg;
            try { py.FS.mkdirTree(dir); } catch (e) { /* exists */ }
            py.FS.writeFile(dir + '/__init__.py', '');
            const written = [];
            for (const fname of Object.keys(files)) {
              py.FS.writeFile(dir + '/' + fname, files[fname]);
              written.push(fname);
            }
            const importSrc =
              'import sys, importlib\n'
              + 'if "' + ROOTDIR + '" not in sys.path:\n'
              + '    sys.path.insert(0, "' + ROOTDIR + '")\n'
              + 'for _n in [k for k in sys.modules if k == "' + pkg + '" or k.startswith("' + pkg + '.")]:\n'
              + '    del sys.modules[_n]\n'
              + '_ivx_m = importlib.import_module("' + pkg + '.' + entryName + '")\n'
              + 'sys.modules["' + entryName + '"] = _ivx_m\n';
            // Mirrors the worker's auto-install: a GitHub file routinely
            // imports third-party packages Pyodide ships but has not loaded.
            const installed = {};
            const attempt = async (triesLeft) => {
              try { py.runPython(importSrc); return; }
              catch (e) {
                const m = /No module named '([^']+)'/.exec(String(e && e.message));
                if (!m || triesLeft <= 0) throw e;
                const missing = m[1].split('.')[0];
                if (installed[missing]) throw e;
                installed[missing] = true;
                setStatus(`installing ${missing}…`);
                try { await py.loadPackage(missing); }
                catch (_) {
                  await py.loadPackage('micropip');
                  await py.pyimport('micropip').install(missing);
                }
                return attempt(triesLeft - 1);
              }
            };
            await attempt(8);
            return { written, entry: entryName, package: pkg, installed: Object.keys(installed) };
          },
          loadJs: (name, source, moduleMap, entryPath) => {
            const mod = { exports: {} };
            const fn = new Function('module', 'exports', 'require', source + '\n;return module.exports;');
            const api = fn(mod, mod.exports, (id) => {
              const key = String(id).replace(/^\.\//, '');
              const map = moduleMap || {};
              const hit = map[key] || map[key + '.js'];
              if (!hit) throw new Error(`require('${id}') not available in main-thread mode`);
              const m2 = { exports: {} };
              new Function('module', 'exports', hit + '\n;return module.exports;')(m2, m2.exports);
              return m2.exports;
            });
            py.registerJsModule(name, api);
            return api && typeof api === 'object' ? Object.keys(api) : ['default'];
          },
        });
        setStatus('running (main thread, no isolation)…');
        const evalResult = await runMainThread(code, indexURL);
        for (const line of evalResult.stdout) appendOut(line);
        if (evalResult.value !== undefined && evalResult.value !== null) {
          appendOut('=> ' + JSON.stringify(evalResult.value));
        }
        setStatus(`done in ${Date.now() - started}ms (main thread)`, 'ok');
        return;
      }

      const p = getPool();
      // BUG, found from a live page: this called acquire() with no
      // `requireInput`, so when SharedArrayBuffer is unavailable (no
      // COOP/COEP response headers -- the far more likely case on a real
      // static host than "the fix didn't ship"), init() silently skipped
      // the whole input mechanism and Python's OWN input() raised its
      // native OSError -- IDENTICAL text to before the fix existed. A
      // second, unrelated failure mode produced the exact same symptom as
      // the first, which is the worst possible diagnostic signal. Checking
      // up front and passing requireInput:true closes both: a clear reason
      // appears before Python ever runs, not the same cryptic trace again.
      // Only warn when the code ACTUALLY calls input(). The first version
      // printed this on every single run, including programs that never
      // read input at all -- noise on top of whatever the real output was,
      // and it made genuine errors harder to spot.
      if (typeof SharedArrayBuffer === 'undefined' && /\binput\s*\(/.test(code)) {
        appendOut('This code calls input(), which needs the page served with:', 'stderr');
        appendOut('  Cross-Origin-Opener-Policy: same-origin', 'stderr');
        appendOut('  Cross-Origin-Embedder-Policy: require-corp', 'stderr');
        appendOut('Or tick "interactive" above to run on the main thread instead.', 'note');
      }
      const w = await p.acquire(WORKER_KEY, { runtime: 'python', indexURL });

      // ── input() support ────────────────────────────────────────────────
      // Wired per-run rather than once at panel init, since the worker
      // itself may be recreated (e.g. after a timeout kills it) and a new
      // instance needs the handler re-attached.
      w.onInputRequest = (prompt) => showInlinePrompt(prompt, text => w.provideInput(text));
      w.onProgress = (m) => setStatus(m);

      await applyDirectives(parseDirectives(code), {
        loadPy: (files, entryName) => w.send({ op: 'loadPyModule', files, entryName }),
        loadJs: (name, source, moduleMap, entryPath) =>
          w.send({ op: 'loadJsModule', name, source, moduleMap, entryPath }),
      });

      setStatus('running…');
      const evalResult = await w.evalSource(code);
      const ms = Date.now() - started;

      if (evalResult && Array.isArray(evalResult.stdout)) {
        for (const line of evalResult.stdout) appendOut(line);
        for (const line of evalResult.stderr || []) appendOut(line, 'stderr');
        if (evalResult.value !== undefined && evalResult.value !== null) {
          appendOut('=> ' + JSON.stringify(evalResult.value));
        }
      } else if (evalResult !== undefined) {
        // Older Pyodide without setStdout: only the last expression's value.
        appendOut('=> ' + JSON.stringify(evalResult));
      }
      setStatus(`done in ${ms}ms`, 'ok');
    } catch (e) {
      appendOut(e.message, 'stderr');
      setStatus('error — see output', 'err');
    } finally {
      running = false;
      if (runBtn) runBtn.disabled = false;
    }
  }

  function init() {
    const { panel, run: runBtn, min } = els();
    if (!panel) return;   // markup not present on this page; nothing to wire
    if (runBtn) runBtn.addEventListener('click', run);
    if (min) min.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      min.textContent = collapsed ? '▲' : '—';
    });
    setStatus('ready — Pyodide loads on first Run (large download, first time only)');
  }

  ROOT.IVX = ROOT.IVX || {};
  ROOT.IVX.python = { run, init, DEFAULT_INDEX_URL };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
