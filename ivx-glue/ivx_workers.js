// ── ivx_workers.js ──────────────────────────────────────────────────────────
// Phase 4, host side. Spawns and supervises workers, one runtime each,
// and dispatches calls to them.
//
// Transport is abstracted because the browser (`new Worker(blobURL)`) and
// node (`worker_threads`) differ, and a pool that can only be tested
// through a mock is a pool whose failure modes are untested. The same
// worker SOURCE runs under both, so the node tests exercise the real
// thing.
//
// ── The three properties that matter ────────────────────────────────────────
// 1. EVERY call has a timeout. A foreign runtime hanging is the expected
//    failure, not the exotic one: a Python infinite loop cannot be
//    interrupted from outside, since a worker only checks for messages
//    between tasks. Termination is the only real remedy, so a timeout
//    that fires must kill the worker rather than leave a zombie holding a
//    pool slot.
// 2. FAILURE IS ATTRIBUTABLE. One runtime per worker, so "the worker
//    hung" always names which foreign module hung.
// 3. NOTHING IS IMPLICIT ABOUT THE NETWORK. The pool never fetches. The
//    resolver (Phase 1) hands over bytes it already pinned; Pyodide's
//    distribution URL must be passed explicitly. On a zero-egress
//    platform, a default CDN constant is how an accidental fetch gets
//    shipped.
'use strict';

const { IVX_WORKER_SOURCE } = require('./ivx_worker_runtime.js');

const DEFAULTS = {
  maxWorkers: 4,
  callTimeoutMs: 30000,
  initTimeoutMs: 120000,   // Pyodide's first load is genuinely slow
};

// ── Transports ──────────────────────────────────────────────────────────────
function browserTransport(source) {
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url);
  return {
    kind: 'browser',
    post: (m, transfer) => w.postMessage(m, transfer || []),
    onMessage: fn => { w.onmessage = e => fn(e.data); },
    onError: fn => { w.onerror = e => fn(new Error(e.message || 'worker error')); },
    terminate: () => { w.terminate(); URL.revokeObjectURL(url); },
  };
}

function nodeTransport(source) {
  const { Worker } = require('worker_threads');
  const w = new Worker(source, { eval: true });
  return {
    kind: 'node',
    post: m => w.postMessage(m),
    onMessage: fn => w.on('message', fn),
    onError: fn => w.on('error', fn),
    terminate: () => w.terminate(),
  };
}

function pickTransport() {
  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined'
      && typeof URL !== 'undefined' && URL.createObjectURL) return browserTransport;
  try { require('worker_threads'); return nodeTransport; }
  catch (_) { throw new Error('no worker transport available (no browser Worker, no worker_threads)'); }
}

// ── One supervised worker ───────────────────────────────────────────────────
class IVXWorker {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.id = opts.id || `w${Math.random().toString(36).slice(2, 8)}`;
    this.runtime = null;
    this.busy = false;
    this.dead = false;
    this.deathReason = null;
    this._pending = new Map();     // id -> {resolve, reject, timer, op}
    this._seq = 0;
    this._readyResolve = null;
    this.ready = new Promise(res => { this._readyResolve = res; });

    const make = opts.transport || pickTransport();
    this._t = make(IVX_WORKER_SOURCE);
    this._t.onMessage(msg => this._onMessage(msg));
    this._t.onError(err => this._die(`worker error: ${err.message}`));
  }

  _onMessage(msg) {
    if (!msg) return;
    if (msg.id === null || msg.id === undefined) {
      // The unsolicited hello the worker sends once it has installed its
      // message handler. Anything sent before this would be dropped.
      if (msg.value && msg.value.ready && this._readyResolve) {
        this._readyResolve(msg.value);
        this._readyResolve = null;
      }
      return;
    }
    const p = this._pending.get(msg.id);
    if (!p) return;                      // late reply after a timeout already fired
    clearTimeout(p.timer);
    this._pending.delete(msg.id);
    this.busy = this._pending.size > 0;
    if (msg.ok) p.resolve(msg.value);
    else {
      const e = new Error(msg.error);
      e.workerStack = msg.stack;
      e.workerId = this.id;
      p.reject(e);
    }
  }

  _die(reason) {
    if (this.dead) return;
    this.dead = true;
    this.deathReason = reason;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      const e = new Error(`${reason} (during '${p.op}')`);
      e.workerId = this.id;
      p.reject(e);
    }
    this._pending.clear();
    this.busy = false;
    try { this._t.terminate(); } catch (_) {}
    if (this._readyResolve) { this._readyResolve({ ready: false }); this._readyResolve = null; }
  }

  send(msg, timeoutMs) {
    if (this.dead) return Promise.reject(new Error(`worker ${this.id} is dead: ${this.deathReason}`));
    const id = ++this._seq;
    const ms = timeoutMs || this.opts.callTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A hung foreign runtime never returns to its message loop, so
        // there is nothing to cancel -- the worker has to go. Anything
        // else leaks a slot and, worse, leaves the caller believing the
        // pool has capacity it does not have.
        this._die(`timed out after ${ms}ms`);
      }, ms);
      if (timer.unref) timer.unref();
      this._pending.set(id, { resolve, reject, timer, op: msg.op });
      this.busy = true;
      try { this._t.post({ ...msg, id }); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }

  async init(spec) {
    await this.ready;
    try {
      const kind = await this.send({ op: 'init', ...spec }, this.opts.initTimeoutMs);
      this.runtime = kind;
      return kind;
    } catch (e) {
      // A worker whose init failed can never serve a call, and in node an
      // un-terminated worker keeps the event loop alive -- a failed init
      // used to hang the process at exit. Self-terminate so the caller
      // only has to handle the rejection.
      this._die(`init failed: ${e.message}`);
      throw e;
    }
  }

  ping()             { return this.send({ op: 'ping' }, 5000); }
  exports()          { return this.send({ op: 'exports' }); }
  call(name, args)   { return this.send({ op: 'call', name, args }); }
  evalSource(source) { return this.send({ op: 'eval', source }); }
  terminate()        { this._die('terminated by host'); }
}

// ── The pool ────────────────────────────────────────────────────────────────
// Keyed by module identity, not by runtime kind: two different Python
// packages get two workers. Loading both into one worker would make a hang
// unattributable, which is property 2 above.
class IVXWorkerPool {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this._workers = new Map();   // key -> IVXWorker
    this._loading = new Map();   // key -> Promise<IVXWorker>
  }

  get size() { return this._workers.size; }

  keys() { return [...this._workers.keys()]; }

  /**
   * Gets (or creates) the worker hosting `key`, initialising it with
   * `spec` on first use. Concurrent callers share one initialisation
   * rather than racing to spawn duplicates.
   */
  acquire(key, spec) {
    // Reap dead workers FIRST. Without this a worker killed by a timeout
    // keeps occupying its slot: the eviction search below only considers
    // live-but-idle workers as victims, so a full pool of corpses could
    // never be recovered and every later acquire failed with "pool is
    // full". Found by the hang test, which is the exact scenario the
    // timeout exists to survive.
    for (const [k, w] of [...this._workers]) {
      if (w.dead) this._workers.delete(k);
    }
    const existing = this._workers.get(key);
    if (existing) return Promise.resolve(existing);
    if (this._loading.has(key)) return this._loading.get(key);

    if (this._workers.size >= this.opts.maxWorkers) {
      const idle = [...this._workers.entries()].find(([, w]) => !w.busy && !w.dead);
      if (!idle) {
        return Promise.reject(new Error(
          `worker pool is full (${this.opts.maxWorkers}) and every worker is busy; ` +
          `raise maxWorkers or await the in-flight calls`));
      }
      idle[1].terminate();
      this._workers.delete(idle[0]);
    }

    const p = (async () => {
      const w = new IVXWorker({ ...this.opts, id: key });
      try {
        await w.init(spec);
        this._workers.set(key, w);
        return w;
      } catch (e) {
        w.terminate();
        throw e;
      } finally {
        this._loading.delete(key);
      }
    })();
    this._loading.set(key, p);
    return p;
  }

  async call(key, name, args, spec) {
    const w = await this.acquire(key, spec);
    return w.call(name, args);
  }

  /** Drops one worker; the next acquire re-initialises from scratch. */
  release(key) {
    const w = this._workers.get(key);
    if (w) { w.terminate(); this._workers.delete(key); }
  }

  terminateAll() {
    for (const [, w] of this._workers) w.terminate();
    this._workers.clear();
    this._loading.clear();
  }

  /** Health snapshot -- what the editor's status strip would show. */
  status() {
    return [...this._workers.entries()].map(([key, w]) => ({
      key, runtime: w.runtime, busy: w.busy, dead: w.dead, reason: w.deathReason,
    }));
  }
}

// ── Resolver -> worker spec ─────────────────────────────────────────────────
// Turns a Phase 1 ResolvedModule into an init spec. This is the seam
// between the two phases and the only place that knows both shapes.
function specFromResolved(mod, opts = {}) {
  switch (mod.runtime) {
    case 'js': {
      const entry = mod.entry || 'index.js';
      const file = mod.files && (mod.files.get(entry) || mod.files.get('<entry>'));
      if (!file) {
        throw new Error(`js module ${mod.name}: entry '${entry}' not present in the resolved files ` +
          `(have: ${mod.files ? [...mod.files.keys()].slice(0, 8).join(', ') : 'none'})`);
      }
      const source = typeof file === 'string' ? file : new TextDecoder().decode(file);
      return { runtime: 'js', source, entry: mod.name };
    }
    case 'wasm':
      if (!mod.archive) throw new Error(`wasm module ${mod.name}: no bytes on the resolved record`);
      return { runtime: 'wasm', bytes: mod.archive, imports: opts.imports || {} };
    case 'python':
      if (!opts.indexURL) {
        throw new Error(`python module ${mod.name} needs opts.indexURL (the Pyodide distribution ` +
          `location). Not defaulted on purpose: an implicit CDN constant is how a zero-egress ` +
          `platform ships an accidental fetch.`);
      }
      return { runtime: 'python', indexURL: opts.indexURL, wheel: mod.archive, name: mod.name };
    case 'go':
      if (!opts.wasmExecUrl) {
        throw new Error(`go module ${mod.name} needs opts.wasmExecUrl (wasm_exec.js from the Go ` +
          `distribution) and a PREBUILT .wasm. There is no in-browser Go compiler; the resolver ` +
          `only establishes identity and dependencies for Go.`);
      }
      if (!mod.archive) throw new Error(`go module ${mod.name}: no prebuilt .wasm bytes available`);
      return { runtime: 'go', wasmExecUrl: opts.wasmExecUrl, bytes: mod.archive };
    default:
      throw new Error(`no worker runtime for '${mod.runtime}' (module ${mod.name})`);
  }
}

module.exports = {
  IVXWorker, IVXWorkerPool, specFromResolved,
  browserTransport, nodeTransport, pickTransport, DEFAULTS,
};
