;(function () {
// Wrapped in an IIFE because index.html loads these as CLASSIC scripts,
// which share one global scope -- top-level `const` in two files collides
// with "Identifier has already been declared" and kills the page. Exports
// go through __ivxExport onto window.IVX instead.
// ── ivx_worker_runtime.js ───────────────────────────────────────────────────
// Phase 4, worker side. This source is what actually runs INSIDE a worker:
// in the browser it is turned into a Blob URL, in node it is loaded by a
// worker_threads shim. It is written as one self-contained string-able
// module with no imports precisely so both hosts can use the same code --
// a worker that behaves differently from the one under test is worse than
// no test.
//
// ── Protocol ────────────────────────────────────────────────────────────────
// Every message is {id, op, ...}. Every reply is {id, ok, value|error}.
// Ops: 'init'   -> load a runtime (python/js/wasm/go) into this worker
//      'call'   -> invoke an exported name with args
//      'eval'   -> run a source fragment (js/python only)
//      'ping'   -> liveness
// A worker hosts exactly ONE runtime for its lifetime. Mixing Pyodide and
// a Go instance in one worker would make a hang in either one
// indistinguishable, and the pool's whole failure story is "kill the
// worker" -- which is only a proportionate response if the worker holds
// one job.
//
// ── What is and is not real here ───────────────────────────────────────────
// js   -- real, tested.
// wasm -- real, tested against a hand-assembled module.
// python (Pyodide) -- written, NOT TESTED. Requires a ~10MB CDN fetch that
//         was not reachable from the environment this was written in. The
//         call shape follows Pyodide's documented API; treat it as
//         unverified until it runs in a browser once.
// go   -- deliberately NOT a Go compiler. There is no in-browser Go
//         toolchain; this runs a PREBUILT .wasm plus the `wasm_exec.js`
//         shim from the Go distribution. Phase 1's resolver already flags
//         Go modules as needing exactly this.
'use strict';

// ── Dual-mode loading ───────────────────────────────────────────────────────
// This file has to work in TWO hosts: node (the test suites) and the
// browser as a classic <script>. It was CommonJS-only, which meant it threw
// "require is not defined" on the first line of a real page load -- the
// modules were never browser-loadable at all, which is why index.html went
// untouched for four phases.
//
// No bundler: index.html loads plain <script src> in dependency order, so
// dependencies come from window.IVX when there is no require().
const __IVX_ROOT = (typeof globalThis !== 'undefined' ? globalThis
                 : typeof window !== 'undefined' ? window : this);
__IVX_ROOT.IVX = __IVX_ROOT.IVX || {};
const __IVX_NODE = (typeof module !== 'undefined' && module.exports);
function __ivxRequire(nodePath, globalKey) {
  if (__IVX_NODE) return require(nodePath);
  const v = __IVX_ROOT.IVX[globalKey];
  if (!v) throw new Error(`IVX: ${globalKey} not loaded yet -- check <script> order in index.html`);
  return v;
}
function __ivxExport(globalKey, api) {
  __IVX_ROOT.IVX[globalKey] = api;
  if (__IVX_NODE) module.exports = api;
}


const IVX_WORKER_SOURCE = String.raw`
'use strict';

// Host abstraction: browser workers use postMessage/onmessage on self,
// node's worker_threads uses parentPort. One shim, so the adapter code
// below never knows which host it is in.
var __host = (function () {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function'
      && typeof importScripts === 'function') {
    return {
      kind: 'browser',
      send: function (m) { self.postMessage(m); },
      onMessage: function (fn) { self.onmessage = function (e) { fn(e.data); }; },
      loadScript: function (url) { importScripts(url); },
    };
  }
  var wt = require('worker_threads');
  return {
    kind: 'node',
    send: function (m) { wt.parentPort.postMessage(m); },
    onMessage: function (fn) { wt.parentPort.on('message', fn); },
    loadScript: function (url) {
      throw new Error('loadScript is browser-only (importScripts); got url ' + url);
    },
  };
})();

var RUNTIME = null;   // { kind, call(name,args), eval(src), exports() }

// ── js ──────────────────────────────────────────────────────────────────────
// Evaluates module source in the worker and exposes what it assigns to
// module.exports / exports / globalThis. No DOM, no network, no parent
// scope -- a worker is already the isolation boundary, so this does not
// pretend to be a sandbox on top of that. It is NOT safe against hostile
// code; it is isolated from the page, which is a different claim.
// Normalizes a POSIX-ish module path: resolves . and .. segments.
function jsNormalizePath(p) {
  var parts = p.split('/');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

function jsDirname(p) {
  var i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

// Resolves a require() id against a module map, trying the same extension
// candidates node does for relative requires.
function jsResolveInMap(id, fromPath, map) {
  if (id.charAt(0) !== '.') return null;   // bare id -- not a relative dep
  var base = jsNormalizePath(jsDirname(fromPath) + '/' + id);
  var candidates = [base, base + '.js', base + '.json', base + '/index.js'];
  for (var i = 0; i < candidates.length; i++) {
    if (Object.prototype.hasOwnProperty.call(map, candidates[i])) return candidates[i];
  }
  return null;
}

function makeJsRuntime(source, entryName, moduleMap, entryPath) {
  var map = moduleMap || {};
  var entry = entryPath || 'index.js';
  var cache = {};

  // A real CommonJS require over the resolver-supplied module map. The
  // cache entry is installed BEFORE the module body runs, which is what
  // makes circular dependencies terminate -- a cycle sees a partially
  // populated exports object rather than recursing forever. That is
  // exactly node's own semantics, and real packages (lodash included)
  // genuinely contain cycles.
  function makeRequire(fromPath) {
    return function (id) {
      var resolved = jsResolveInMap(id, fromPath, map);
      if (!resolved) {
        var known = Object.keys(map).length;
        throw new Error("js runtime: require('" + id + "') could not be resolved from '" +
          fromPath + "'. " + (id.charAt(0) === '.'
            ? 'The resolver fetched ' + known + ' file(s); this relative path was not among them.'
            : 'Bare package requires are not followed -- only relative paths within the fetched module.'));
      }
      if (Object.prototype.hasOwnProperty.call(cache, resolved)) return cache[resolved].exports;
      var m = { exports: {} };
      cache[resolved] = m;
      var f = new Function('module', 'exports', 'require', map[resolved] + '\n;return module.exports;');
      var r = f(m, m.exports, makeRequire(resolved));
      if (r !== undefined) m.exports = r;
      return m.exports;
    };
  }

  var module = { exports: {} };
  var exports = module.exports;
  var fn = new Function('module', 'exports', 'require', source + '\n;return module.exports;');
  var api = fn(module, exports, makeRequire(entry));
  if ((api === undefined || api === null) && entryName && typeof globalThis[entryName] !== 'undefined') {
    api = globalThis[entryName];
  }
  return {
    kind: 'js',
    exportNames: function () {
      // BUG, found wiring the real web-import path: a CJS module whose
      // module.exports IS a callable with methods attached -- lodash,
      // moment, and plenty of other real npm packages -- returned only
      // ['default'] here, because typeof api === 'function' short-
      // circuited before any of its own properties were considered. The
      // resolver's namespace-object building (runtime.js's Import case)
      // reads exportNames() to decide what to expose, so Frames.chunk(...)
      // failed with "not callable" even though w.call('chunk', ...)
      // worked the whole time -- the dispatch path was fine, only the
      // discovery path was blind to it.
      const own = api && (typeof api === 'object' || typeof api === 'function')
        ? Object.keys(api) : [];
      if (typeof api === 'function') return own.length ? own : ['default'];
      return own;
    },
    call: function (name, args) {
      var target = (name === 'default' || !name) ? api : (api && api[name]);
      if (typeof target !== 'function') {
        throw new Error("js runtime: '" + name + "' is not an exported function");
      }
      return target.apply(null, args || []);
    },
    evalSource: function (src) {
      return (new Function('api', 'return (' + src + ');'))(api);
    },
  };
}

// ── wasm ────────────────────────────────────────────────────────────────────
// Raw module bytes in, instance out. Imports are supplied by the caller as
// a plain object; anything the module needs and does not get is reported
// as a LinkError with the missing name, rather than a bare "link failed".
function makeWasmRuntime(bytes, importObject) {
  var mod = new WebAssembly.Module(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  var needed = WebAssembly.Module.imports(mod);
  var imports = importObject || {};
  var missing = needed.filter(function (i) {
    return !(imports[i.module] && imports[i.module][i.name] !== undefined);
  });
  if (missing.length) {
    throw new Error('wasm: unsatisfied imports: ' +
      missing.map(function (i) { return i.module + '.' + i.name; }).join(', '));
  }
  var inst = new WebAssembly.Instance(mod, imports);
  return {
    kind: 'wasm',
    exportNames: function () { return Object.keys(inst.exports); },
    call: function (name, args) {
      var f = inst.exports[name];
      if (typeof f !== 'function') throw new Error("wasm: '" + name + "' is not an exported function");
      var r = f.apply(null, args || []);
      // i64 results come back as BigInt and do not survive structured
      // clone into every consumer cleanly -- stringify at the boundary
      // rather than silently truncating through Number().
      return typeof r === 'bigint' ? r.toString() : r;
    },
    evalSource: function () { throw new Error('wasm runtime has no eval'); },
    memory: function () { return inst.exports.memory; },
  };
}

// ── python (Pyodide) -- UNTESTED, see the file header ──────────────────────
function makePythonRuntime(opts) {
  if (__host.kind !== 'browser') {
    throw new Error('python runtime needs a browser worker (Pyodide loads via importScripts)');
  }
  var base = opts.indexURL;
  if (!base) throw new Error('python runtime: indexURL is required; ' +
    'pass the Pyodide distribution location explicitly rather than defaulting to a CDN, ' +
    'so a self-hosted copy is the easy path and the network fetch is never implicit');
  __host.loadScript(base + 'pyodide.js');
  return loadPyodide({ indexURL: base }).then(function (py) {
    // runPython alone returns only the LAST EXPRESSION's value -- it does
    // not capture print(), which is most of what a "write Python and run
    // it" panel actually needs to show. setStdout/setStderr exist on every
    // Pyodide release since 0.24; feature-detected rather than assumed, so
    // an older bundled Pyodide degrades to expression-value-only instead of
    // throwing on a missing method.
    var stdoutBuf = [], stderrBuf = [];
    if (typeof py.setStdout === 'function') {
      py.setStdout({ batched: function (s) { stdoutBuf.push(s); } });
    }
    if (typeof py.setStderr === 'function') {
      py.setStderr({ batched: function (s) { stderrBuf.push(s); } });
    }

    // ── Synchronous input() ────────────────────────────────────────────────
    // WHY THIS IS HARD, PRECISELY: KH's take works via await this.onInput
    // (node.name) (runtime.js) because KH's whole interpreter is native
    // async JS -- pausing for a value is just an ordinary awaited Promise.
    // Python's input() is a SYNCHRONOUS CPython builtin: even compiled to
    // WASM, it expects to block on a real stdin descriptor with no await
    // mechanism at all. Monkey-patching it to an ASYNC JS function does not
    // work for plain input() call sites -- guess = int(input(...)) never
    // writes await, so an async replacement returns a coroutine object,
    // not a string, and int(coroutine) fails.
    //
    // The fix real Pyodide consoles use: a SharedArrayBuffer plus
    // Atomics.wait. This is genuine OS-thread-level blocking, invoked from
    // a plain SYNCHRONOUS JS function -- so Python's input() can call it
    // with zero await and it behaves exactly like a real blocking read.
    // Verified for real in this repo's test suite using node's
    // worker_threads (which fully implements SharedArrayBuffer/Atomics);
    // in a real BROWSER this additionally requires the page to be served
    // with COOP/COEP response headers (Cross-Origin-Opener-Policy:
    // same-origin, Cross-Origin-Embedder-Policy: require-corp) -- without
    // them SharedArrayBuffer cannot be constructed at all, which is a
    // server configuration decision, not something fixable from this file.
    if (opts.inputBuffer) {
      var flags = new Int32Array(opts.inputBuffer, 0, 2);   // [0]=ready flag, [1]=byte length
      var payload = new Uint8Array(opts.inputBuffer, 8);
      var decoder = new TextDecoder();
      py.globals.set('__ivx_sync_input', function (promptText) {
        __host.send({ op: 'input-request', prompt: promptText == null ? '' : String(promptText) });
        Atomics.store(flags, 0, 0);
        Atomics.wait(flags, 0, 0);       // genuinely blocks this thread -- see note above
        var len = Atomics.load(flags, 1);
        return decoder.decode(payload.subarray(0, len));
      });
      py.runPython(
        'import builtins\n' +
        'def _ivx_input(prompt=""):\n' +
        '    return __ivx_sync_input(prompt)\n' +
        'builtins.input = _ivx_input\n'
      );
    } else {
      // No shared buffer supplied: input() is left as CPython's own
      // builtin, which raises the OSError this file's header describes.
      // Explicit rather than silently degraded, so the failure is at least
      // attributable to a real, named cause on inspection.
    }
    return {
      kind: 'python',
      pyodide: py,
      exportNames: function () { return []; },   // python has no static export list
      call: function (name, args) {
        var f = py.globals.get(name);
        if (!f) throw new Error("python: '" + name + "' is not defined in globals");
        var r = f.apply(null, args || []);
        return (r && typeof r.toJs === 'function') ? r.toJs() : r;
      },
      evalSource: function (src) {
        stdoutBuf = []; stderrBuf = [];
        var runner = (typeof py.runPythonAsync === 'function') ? py.runPythonAsync : py.runPython;
        var finish = function (r) {
          var value = (r && typeof r.toJs === 'function') ? r.toJs() : r;
          return { value: value, stdout: stdoutBuf.slice(), stderr: stderrBuf.slice() };
        };
        var result = runner.call(py, src);
        return (result && typeof result.then === 'function') ? result.then(finish) : finish(result);
      },
      // Hosts a JS module INSIDE the Pyodide worker and registers it as an
      // importable Python module. This is what makes real interop possible:
      // Pyodide's JsProxy gives attribute access, calling, and method
      // chaining (camera.position.copy(pos)) -- but ONLY when the JS object
      // and the Python interpreter share an execution context. Across two
      // workers you get message passing and plain data, not objects.
      //
      // So a JS dependency for Python is loaded here rather than in the JS
      // worker pool. It costs the per-runtime isolation the pool normally
      // gives (a hang is now attributable to "the python worker" rather
      // than to one specific module) -- a deliberate trade for interop that
      // actually works, not an oversight.
      loadJsModule: function (name, source, moduleMap, entryPath) {
        var rt = makeJsRuntime(source, name, moduleMap, entryPath);
        var api = rt.api !== undefined ? rt.api : null;
        // makeJsRuntime does not expose its api object directly; re-derive
        // it through the same call path the js runtime uses.
        var exported = {};
        var names = rt.exportNames();
        if (names.length === 1 && names[0] === 'default') {
          exported = rt.call.bind(null, 'default');
        } else {
          names.forEach(function (n) {
            exported[n] = function () {
              return rt.call(n, Array.prototype.slice.call(arguments));
            };
          });
        }
        py.registerJsModule(name, exported);
        return names;
      },

      // Writes Python source files into Pyodide's virtual filesystem and
      // makes them importable. CPython's own import machinery then handles
      // everything -- no proxying, unlike loadJsModule, because these files
      // are already Python.
      //
      // They go inside a PACKAGE directory, not flat on sys.path. Flat was
      // the first attempt and it broke on the first real multi-file import:
      // 'from .structures import LookupDict' raised "attempted relative
      // import with no known parent package", because a relative import
      // needs a parent package to be relative TO. Verified against real
      // CPython both ways before writing this.
      //
      // The sys.modules alias then keeps the user's ordinary
      // 'import status_codes' working, rather than forcing them to write
      // the internal package name.
      loadPyModule: function (files, entryName) {
        var ROOTDIR = '/ivx_modules';
        var pkg = '_ivx_' + entryName;
        var dir = ROOTDIR + '/' + pkg;
        try { py.FS.mkdirTree(dir); } catch (e) { /* already exists */ }
        py.FS.writeFile(dir + '/__init__.py', '');
        var written = [];
        for (var fname in files) {
          if (!Object.prototype.hasOwnProperty.call(files, fname)) continue;
          py.FS.writeFile(dir + '/' + fname, files[fname]);
          written.push(fname);
        }
        var importSrc =
          'import sys, importlib\n' +
          'if "' + ROOTDIR + '" not in sys.path:\n' +
          '    sys.path.insert(0, "' + ROOTDIR + '")\n' +
          'for _n in [k for k in sys.modules if k == "' + pkg + '" or k.startswith("' + pkg + '.")]:\n' +
          '    del sys.modules[_n]\n' +
          '_ivx_m = importlib.import_module("' + pkg + '.' + entryName + '")\n' +
          'sys.modules["' + entryName + '"] = _ivx_m\n';

        // A file pulled from GitHub routinely imports third-party packages
        // (requests/compat.py wants urllib3). Pyodide ships many of them but
        // does not LOAD them until asked, and its own error message names
        // the exact remedy. Rather than making the user read a traceback and
        // hand-run micropip, catch ModuleNotFoundError, install the named
        // package, and retry -- bounded, and each name attempted only once
        // so an unavailable package fails with its real error instead of
        // looping.
        var installed = {};
        function attempt(triesLeft) {
          try {
            py.runPython(importSrc);
            return Promise.resolve({ written: written, entry: entryName,
                                     package: pkg, installed: Object.keys(installed) });
          } catch (e) {
            var m = /No module named '([^']+)'/.exec(String(e && e.message));
            if (!m || triesLeft <= 0) throw e;
            var missing = m[1].split('.')[0];
            if (installed[missing]) throw e;
            installed[missing] = true;
            __host.send({ op: 'progress', message: 'installing ' + missing + '...' });
            return Promise.resolve()
              .then(function () { return py.loadPackage(missing); })
              .catch(function () {
                // Not in the Pyodide distribution -- try PyPI via micropip.
                return Promise.resolve(py.loadPackage('micropip')).then(function () {
                  return py.pyimport('micropip').install(missing);
                });
              })
              .then(function () { return attempt(triesLeft - 1); });
          }
        }
        return attempt(8);
      },

      install: function (wheelBytes, name) {
        // A resolved wheel is handed over as bytes rather than re-fetched
        // by micropip, so Phase 1's integrity pin is the one that counts
        // and the artifact is only downloaded once.
        py.unpackArchive(wheelBytes, 'wheel');
        return name;
      },
    };
  });
}

// ── go -- runs a PREBUILT .wasm, does not compile Go ───────────────────────
function makeGoRuntime(opts) {
  if (!opts.wasmExecUrl) throw new Error('go runtime: wasmExecUrl (wasm_exec.js from the Go ' +
    'distribution) is required -- there is no in-browser Go compiler, so this runs a ' +
    'prebuilt .wasm only');
  __host.loadScript(opts.wasmExecUrl);
  var go = new Go();
  return WebAssembly.instantiate(opts.bytes, go.importObject).then(function (res) {
    // go.run() resolves only when the Go program EXITS. A Go program that
    // registers callbacks and blocks forever is the normal case, so this
    // deliberately does not await it.
    go.run(res.instance);
    return {
      kind: 'go',
      exportNames: function () { return Object.keys(res.instance.exports); },
      call: function (name, args) {
        var f = globalThis[name];
        if (typeof f !== 'function') {
          throw new Error("go: '" + name + "' was not registered on the global scope; " +
            'the Go program must js.Global().Set(...) it before this call');
        }
        return f.apply(null, args || []);
      },
      evalSource: function () { throw new Error('go runtime has no eval'); },
    };
  });
}

// ── dispatch ────────────────────────────────────────────────────────────────
function handleInit(msg) {
  if (RUNTIME) throw new Error('this worker already hosts a ' + RUNTIME.kind +
    ' runtime; one runtime per worker so a hang is attributable');
  switch (msg.runtime) {
    case 'js':     RUNTIME = makeJsRuntime(msg.source, msg.entry, msg.moduleMap, msg.entryPath); return RUNTIME.kind;
    case 'wasm':   RUNTIME = makeWasmRuntime(msg.bytes, msg.imports); return RUNTIME.kind;
    case 'python': return makePythonRuntime(msg).then(function (r) { RUNTIME = r; return r.kind; });
    case 'go':     return makeGoRuntime(msg).then(function (r) { RUNTIME = r; return r.kind; });
    default: throw new Error('unknown runtime: ' + msg.runtime);
  }
}

__host.onMessage(function (msg) {
  var id = msg && msg.id;
  Promise.resolve()
    .then(function () {
      switch (msg.op) {
        case 'ping':    return { pong: true, runtime: RUNTIME ? RUNTIME.kind : null };
        case 'init':    return handleInit(msg);
        case 'exports': return requireRuntime().exportNames();
        case 'call':    return requireRuntime().call(msg.name, msg.args);
        case 'eval':    return requireRuntime().evalSource(msg.source);
        case 'loadPyModule': {
          var prt = requireRuntime();
          if (typeof prt.loadPyModule !== 'function') {
            throw new Error('loadPyModule requires the python runtime (this worker hosts ' + prt.kind + ')');
          }
          return prt.loadPyModule(msg.files, msg.entryName);
        }
        case 'loadJsModule': {
          var rt = requireRuntime();
          if (typeof rt.loadJsModule !== 'function') {
            throw new Error('loadJsModule is only supported by the python runtime (this worker hosts ' + rt.kind + ')');
          }
          return rt.loadJsModule(msg.name, msg.source, msg.moduleMap, msg.entryPath);
        }
        default: throw new Error('unknown op: ' + msg.op);
      }
    })
    .then(function (value) { __host.send({ id: id, ok: true, value: value }); })
    .catch(function (e) {
      __host.send({ id: id, ok: false, error: (e && e.message) || String(e),
                    stack: e && e.stack });
    });
});

function requireRuntime() {
  if (!RUNTIME) throw new Error('no runtime loaded in this worker -- send op:"init" first');
  return RUNTIME;
}

__host.send({ id: null, ok: true, value: { ready: true, host: __host.kind } });
`;

__ivxExport('WorkerRuntime', { IVX_WORKER_SOURCE });

})();
