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
function makeJsRuntime(source, entryName) {
  var module = { exports: {} };
  var exports = module.exports;
  var fn = new Function('module', 'exports', 'require', source + '\n;return module.exports;');
  var api = fn(module, exports, function (id) {
    throw new Error("js runtime: require('" + id + "') is not available inside a worker; " +
                    'the resolver must flatten dependencies before dispatch');
  });
  if ((api === undefined || api === null) && entryName && typeof globalThis[entryName] !== 'undefined') {
    api = globalThis[entryName];
  }
  return {
    kind: 'js',
    exportNames: function () {
      if (typeof api === 'function') return ['default'];
      return api && typeof api === 'object' ? Object.keys(api) : [];
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
        var r = py.runPython(src);
        return (r && typeof r.toJs === 'function') ? r.toJs() : r;
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
    case 'js':     RUNTIME = makeJsRuntime(msg.source, msg.entry); return RUNTIME.kind;
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

module.exports = { IVX_WORKER_SOURCE };
