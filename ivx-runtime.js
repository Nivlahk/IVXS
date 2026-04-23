// ivx-runtime.js — IVX Interpreter & Runtime
// Interpreter, IVXRuntime (I/O, Google services, AI, file ops)
// Depends on: ivx-core.js
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
// Copyright 2026 IVX

// ── interpreter.js ───────────────────────────────────────────────────────────

// ── Runtime values ────────────────────────────────────────────────────────────
// IVX values are plain JS values:
//   string  → JS string
//   integer → JS number (integer)
//   float   → JS number (float)
//   boolean → JS true / false
//   none    → JS null
//   list    → JS Array
//   dict    → JS Map

const NONE = null;

// ── Control flow signals ──────────────────────────────────────────────────────
// Used to unwind the call stack for 'out' (return) and loop control
class ReturnSignal  { constructor(value) { this.value = value; } }
class BreakSignal   {}
class ContinueSignal {}
class EndSignal     {}

// ── Runtime error ─────────────────────────────────────────────────────────────
class RuntimeError extends Error {
  constructor(message, line, col) {
    super(message);
    this.ivxLine = line ?? 0;
    this.ivxCol  = col  ?? 0;
  }
}

// ── Environment (scope) ───────────────────────────────────────────────────────
class Env {
  constructor(parent = null) {
    this.parent = parent;
    this.vars   = new Map();
    this.consts = new Set(); // inferred immutable bindings
  }

  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent)          return this.parent.get(name);
    return undefined;
  }

  set(name, value) {
    // Check const in this scope
    if (this.vars.has(name)) {
      if (this.consts.has(name)) {
        throw new RuntimeError(
          `Cannot reassign '${name}' — it was inferred immutable because it is never reassigned. If you meant to reassign it, use 'make ${name} ${name} + ...' or declare it with '?' to make it mutable.`,
          0
        );
      }
      this.vars.set(name, value);
      return;
    }
    // Check parent scope
    if (this.parent && this.parent.has(name)) { this.parent.set(name, value); return; }
    // New variable — define in current scope
    this.vars.set(name, value);
  }

  setConst(name, value) {
    this.vars.set(name, value);
    this.consts.add(name);
  }

  isConst(name) {
    if (this.consts.has(name)) return true;
    return this.parent?.isConst(name) ?? false;
  }

  has(name) {
    if (this.vars.has(name)) return true;
    return this.parent?.has(name) ?? false;
  }

  del(name) {
    if (this.vars.has(name)) {
      if (this.consts.has(name)) {
        throw new RuntimeError(`Cannot delete '${name}' — it is inferred immutable.`, 0);
      }
      this.vars.delete(name);
      return true;
    }
    return this.parent?.del(name) ?? false;
  }

  child() { return new Env(this); }
}

// ── IVX function (closure) ────────────────────────────────────────────────────
class IVXFunction {
  constructor(name, params, body, closure) {
    this.name    = name;
    this.params  = params;
    this.body    = body;
    this.closure = closure; // captured environment
  }
}

class IVXClass {
  constructor(name, body, closure, superclass = null) {
    this.name = name;
    this.body = body ?? [];
    this.closure = closure;
    this.superclass = superclass;
    this.methods = new Map();
    this.initStmts = [];
  }

  resolveMethod(name) {
    if (this.methods.has(name)) return this.methods.get(name);
    return this.superclass?.resolveMethod(name) ?? null;
  }

  async instantiate(args, interp) {
    const classEnv = this.closure ? this.closure.child() : interp.globals.child();
    const instance = new Map();
    instance.set('__class__', this.name);
    instance.set('__class_obj__', this);
    classEnv.set('self', instance);

    if (this.superclass) {
      classEnv.set('super', new IVXSuperProxy(instance, this));
    }

    const initMethod = this.resolveMethod('init');
    if (!initMethod && args.length > 0) {
      throw new RuntimeError(`Class '${this.name}' does not define an init() method`, 0, 0);
    }
    if (initMethod) {
      for (let i = 0; i < initMethod.params.length; i++) {
        const pRaw = initMethod.params[i];
        const pName = typeof pRaw === 'string' ? pRaw : pRaw.name;
        const value = args[i] ?? NONE;
        instance.set(pName, value);
        classEnv.set(pName, value);
      }
    }

    for (const stmt of this.initStmts) {
      await interp.execStmt(stmt, classEnv);
    }

    if (initMethod) {
      const boundInit = interp._bindMethod(initMethod, instance);
      const fnEnv = boundInit.closure.child();
      fnEnv.set('self', instance);
      if (boundInit.__boundSuper !== undefined) {
        fnEnv.set('super', boundInit.__boundSuper);
      }

      const result = await interp.execBlock(boundInit.body, fnEnv);
      if (result instanceof ReturnSignal) return instance;
    }

    return instance;
  }
}

class IVXSuperProxy {
  constructor(self, ownerClass) {
    this.__kind__ = 'super';
    this.self = self;
    this.ownerClass = ownerClass;
  }
}

const BUILTIN_DEFS = {
  int: {
    params: ['x'],
    call: (args) => Math.trunc(Number(args[0])),
  },
  flt: {
    params: ['x'],
    call: (args) => Number(args[0]),
  },
  str: {
    params: ['x'],
    call: (args) => ivxRepr(args[0]),
  },
  bin: {
    params: ['x'],
    call: (args) => Boolean(args[0]),
  },
  list: {
    params: ['x'],
    call: (args) => Array.isArray(args[0]) ? args[0] : args[0] instanceof Map ? [...args[0].values()] : [args[0]],
  },
  dict: {
    params: ['x'],
    call: (args) => args[0] instanceof Map ? args[0] : new Map(Object.entries(args[0] ?? {})),
  },
  length: {
    params: ['x'],
    call: (args, node) => {
      const v = args[0];
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      if (v instanceof Map) return v.size;
      throw new RuntimeError(`length() requires string, list, or dict`, node?.line);
    },
  },
  keys: {
    params: ['d'],
    call: (args) => args[0] instanceof Map ? [...args[0].keys()] : [],
  },
  values: {
    params: ['d'],
    call: (args) => args[0] instanceof Map ? [...args[0].values()] : [],
  },
  has: {
    params: ['d', 'k'],
    call: (args) => args[0] instanceof Map ? args[0].has(args[1]) : false,
  },
  push: {
    params: ['list', 'val'],
    call: (args) => {
      if (Array.isArray(args[0])) args[0].push(args[1]);
      return args[0];
    },
  },
  pop: {
    params: ['list'],
    call: (args) => {
      if (Array.isArray(args[0])) return args[0].pop() ?? NONE;
      return NONE;
    },
  },
  abs: {
    params: ['x'],
    call: (args) => Math.abs(args[0]),
  },
  floor: {
    params: ['x'],
    call: (args) => Math.floor(args[0]),
  },
  ceil: {
    params: ['x'],
    call: (args) => Math.ceil(args[0]),
  },
  round: {
    params: ['x'],
    call: (args) => Math.round(args[0]),
  },
  min: {
    params: ['a', 'b'],
    call: (args) => Math.min(args[0], args[1]),
  },
  max: {
    params: ['a', 'b'],
    call: (args) => Math.max(args[0], args[1]),
  },
  sqrt: {
    params: ['x'],
    call: (args) => Math.sqrt(args[0]),
  },
  log: {
    params: ['x', 'base'],
    call: (args) => {
      const x = args[0];
      const base = args[1] ?? NONE;
      if (base === NONE) return Math.log(x);           // natural log
      if (base === 10)   return Math.log10(x);
      if (base === 2)    return Math.log2(x);
      return Math.log(x) / Math.log(base);
    },
  },
  log2:  { params: ['x'], call: (args) => Math.log2(args[0]) },
  log10: { params: ['x'], call: (args) => Math.log10(args[0]) },
  sin:   { params: ['x'], call: (args) => Math.sin(args[0]) },
  cos:   { params: ['x'], call: (args) => Math.cos(args[0]) },
  tan:   { params: ['x'], call: (args) => Math.tan(args[0]) },
  asin:  { params: ['x'], call: (args) => Math.asin(args[0]) },
  acos:  { params: ['x'], call: (args) => Math.acos(args[0]) },
  atan:  { params: ['x'], call: (args) => Math.atan(args[0]) },
  atan2: { params: ['y', 'x'], call: (args) => Math.atan2(args[0], args[1]) },
  pi:    { params: [], call: () => Math.PI },
  e:     { params: [], call: () => Math.E },
  tau:   { params: [], call: () => Math.PI * 2 },
  inf:   { params: [], call: () => Infinity },
  random:  { params: [], call: () => Math.random() },
  randint: { params: ['a', 'b'], call: (args) => Math.floor(Math.random() * (args[1] - args[0] + 1)) + args[0] },
  roll:    { params: ['a', 'b'], call: (args) => Math.floor(Math.random() * (args[1] - args[0] + 1)) + args[0] },
  sign:    { params: ['x'], call: (args) => Math.sign(args[0]) },
  clamp:   { params: ['x', 'lo', 'hi'], call: (args) => Math.min(Math.max(args[0], args[1]), args[2]) },
  lerp:    { params: ['a', 'b', 't'], call: (args) => args[0] + (args[1] - args[0]) * args[2] },
  degrees: { params: ['r'], call: (args) => args[0] * (180 / Math.PI) },
  radians: { params: ['d'], call: (args) => args[0] * (Math.PI / 180) },
  gcd: {
    params: ['a', 'b'],
    call: (args) => {
      let a = Math.abs(Math.trunc(args[0]));
      let b = Math.abs(Math.trunc(args[1]));
      while (b) { [a, b] = [b, a % b]; }
      return a;
    },
  },
  lcm: {
    params: ['a', 'b'],
    call: (args) => {
      const a = Math.abs(Math.trunc(args[0]));
      const b = Math.abs(Math.trunc(args[1]));
      let x = a, y = b;
      while (y) { [x, y] = [y, x % y]; }
      return (a * b) / x;
    },
  },
  isPrime: {
    params: ['n'],
    call: (args) => {
      const n = Math.trunc(args[0]);
      if (n < 2) return false;
      if (n === 2) return true;
      if (n % 2 === 0) return false;
      for (let i = 3; i <= Math.sqrt(n); i += 2) if (n % i === 0) return false;
      return true;
    },
  },
  upper: {
    params: ['s'],
    call: (args) => String(args[0]).toUpperCase(),
  },
  lower: {
    params: ['s'],
    call: (args) => String(args[0]).toLowerCase(),
  },
  trim: {
    params: ['s'],
    call: (args) => String(args[0]).trim(),
  },
  split: {
    params: ['s', 'sep'],
    call: (args) => String(args[0]).split(args[1] ?? ''),
  },
  join: {
    params: ['list', 'sep'],
    call: (args, node) => {
      // Relational join overload: join(left, right, leftCol, rightCol[, kind])
      if (args.length >= 4) {
        return tableJoin(args[0], args[1], args[2], args[3], args[4] ?? 'inner', node);
      }
      // Original string/list join behavior
      return (args[0] ?? []).join(args[1] ?? '');
    },
  },
  where: {
    params: ['table', 'col', 'op', 'value'],
    call: (args, node) => tableWhere(args, node),
  },
  order: {
    params: ['table', 'col', 'dir'],
    call: (args) => tableOrder(args[0], args[1], args[2] ?? 'asc'),
  },
  group: {
    params: ['table', 'cols'],
    call: (args) => tableGroup(args[0], args[1]),
  },
  agg: {
    params: ['grouped', 'col', 'fn', 'as'],
    call: (args, node) => tableAgg(args[0], args[1], args[2], args[3], node),
  },
  contains: {
    params: ['s', 'sub'],
    call: (args) => String(args[0]).includes(String(args[1])),
  },
  replace: {
    params: ['s', 'from', 'to'],
    call: (args) => String(args[0]).replaceAll(String(args[1]), String(args[2])),
  },
  starts:  { params: ['s','prefix'], call: (args) => String(args[0]).startsWith(String(args[1])) },
  ends:    { params: ['s','suffix'], call: (args) => String(args[0]).endsWith(String(args[1])) },
  index:   { params: ['s','sub'], call: (args) => { const i=String(args[0]).indexOf(String(args[1])); return i===-1?NONE:i; } },
  slice:   { params: ['s','start','end'], call: (args) => { const s=String(args[0]); return (args[2]!=null&&args[2]!==NONE)?s.slice(args[1],args[2]):s.slice(args[1]); } },
  pad:     { params: ['s','len','char'], call: (args) => String(args[0]).padStart(Number(args[1])||0,String(args[2]??' ')) },
  padend:  { params: ['s','len','char'], call: (args) => String(args[0]).padEnd(Number(args[1])||0,String(args[2]??' ')) },
  chars:   { params: ['s'], call: (args) => [...String(args[0])] },
  repeat:  { params: ['s','n'], call: (args) => String(args[0]).repeat(Math.max(0,Math.trunc(Number(args[1])))) },
  size:    { params: ['x'], call: (args) => { const v=args[0]; if(typeof v==='string')return v.length; if(Array.isArray(v))return v.length; if(v instanceof Map)return v.size; return 0; } },

  // ── List methods ──────────────────────────────────────────────────────────
  map: {
    params: ['list', 'fun'],
    call: async (args, node, interp) => {
      const list = args[0]; const fn = args[1];
      if (!Array.isArray(list)) return list;
      const result = [];
      for (const item of list) {
        if (fn && fn.body !== null) {
          const env = fn.closure.child();
          if (fn.params[0]) env.set(typeof fn.params[0] === 'string' ? fn.params[0] : fn.params[0].name, item);
          const r = await interp.execBlock(fn.body, env);
          result.push(r?.value ?? item);
        } else result.push(item);
      }
      return result;
    },
  },
  filter: {
    params: ['list', 'fun'],
    call: async (args, node, interp) => {
      const list = args[0]; const fn = args[1];
      if (!Array.isArray(list)) return list;
      const result = [];
      for (const item of list) {
        let keep = false;
        if (fn && fn.body !== null) {
          const env = fn.closure.child();
          if (fn.params[0]) env.set(typeof fn.params[0] === 'string' ? fn.params[0] : fn.params[0].name, item);
          const r = await interp.execBlock(fn.body, env);
          keep = r?.value ?? r ?? false;
        }
        if (keep) result.push(item);
      }
      return result;
    },
  },
  reduce: {
    params: ['list', 'fun', 'init'],
    call: async (args, node, interp) => {
      const list = args[0]; const fn = args[1];
      if (!Array.isArray(list)) return NONE;
      let acc = args[2] ?? NONE;
      for (const item of list) {
        if (fn && fn.body !== null) {
          const env = fn.closure.child();
          const p0 = fn.params[0]; const p1 = fn.params[1];
          if (p0) env.set(typeof p0 === 'string' ? p0 : p0.name, acc);
          if (p1) env.set(typeof p1 === 'string' ? p1 : p1.name, item);
          const r = await interp.execBlock(fn.body, env);
          acc = r?.value ?? r ?? acc;
        }
      }
      return acc;
    },
  },
  sort: {
    params: ['list', 'fun'],
    call: async (args, node, interp) => {
      const list = args[0];
      if (!Array.isArray(list)) return list;
      const copy = [...list];
      if (!args[1] || !args[1].body) {
        // Default sort: numeric if all numbers, else string
        copy.sort((a, b) => {
          if (typeof a === 'number' && typeof b === 'number') return a - b;
          return String(a).localeCompare(String(b));
        });
      } else {
        const fn = args[1];
        copy.sort(async (a, b) => {
          const env = fn.closure.child();
          const p0 = fn.params[0]; const p1 = fn.params[1];
          if (p0) env.set(typeof p0 === 'string' ? p0 : p0.name, a);
          if (p1) env.set(typeof p1 === 'string' ? p1 : p1.name, b);
          const r = await interp.execBlock(fn.body, env);
          return r?.value ?? 0;
        });
      }
      return copy;
    },
  },
  reverse: {
    params: ['list'],
    call: (args) => Array.isArray(args[0]) ? [...args[0]].reverse() : args[0],
  },
  unique: {
    params: ['list'],
    call: (args) => {
      if (!Array.isArray(args[0])) return args[0];
      const seen = new Set();
      return args[0].filter(x => {
        const k = JSON.stringify(x);
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
    },
  },
  flat: {
    params: ['list'],
    call: (args) => Array.isArray(args[0]) ? args[0].flat() : args[0],
  },
  first: {
    params: ['list'],
    call: (args) => Array.isArray(args[0]) && args[0].length > 0 ? args[0][0] : NONE,
  },
  last: {
    params: ['list'],
    call: (args) => Array.isArray(args[0]) && args[0].length > 0 ? args[0][args[0].length - 1] : NONE,
  },
  head: {
    params: ['list', 'n'],
    call: (args) => Array.isArray(args[0]) ? args[0].slice(0, args[1]) : args[0],
  },
  drop: {
    params: ['list', 'n'],
    call: (args) => Array.isArray(args[0]) ? args[0].slice(args[1]) : args[0],
  },
  zip: {
    params: ['a', 'b'],
    call: (args) => {
      const a = args[0]; const b = args[1];
      if (!Array.isArray(a) || !Array.isArray(b)) return NONE;
      const len = Math.min(a.length, b.length);
      return Array.from({length: len}, (_, i) => [a[i], b[i]]);
    },
  },
  // ── 2D list methods ───────────────────────────────────────────────────────
  col: {
    params: ['grid', 'n'],
    call: (args) => {
      const grid = args[0]; const n = args[1];
      if (!Array.isArray(grid)) return NONE;
      return grid.map(row => Array.isArray(row) ? (row[n] ?? NONE) : NONE);
    },
  },
  row: {
    params: ['grid', 'n'],
    call: (args) => {
      const grid = args[0]; const n = args[1];
      if (!Array.isArray(grid)) return NONE;
      return grid[n] ?? NONE;
    },
  },
  cols: {
    params: ['grid'],
    call: (args) => {
      const grid = args[0];
      if (!Array.isArray(grid) || !Array.isArray(grid[0])) return NONE;
      return grid[0].length;
    },
  },
  rows: {
    params: ['grid'],
    call: (args) => Array.isArray(args[0]) ? args[0].length : 0,
  },
  transpose: {
    params: ['grid'],
    call: (args) => {
      const grid = args[0];
      if (!Array.isArray(grid) || !Array.isArray(grid[0])) return NONE;
      return grid[0].map((_, ci) => grid.map(row => row[ci]));
    },
  },
  colnames: {
    params: ['table'],
    call: (args) => {
      const t = args[0];
      if (!Array.isArray(t) || !(t[0] instanceof Map)) return NONE;
      return [...t[0].keys()].filter(k => !String(k).startsWith('__'));
    },
  },
  now:       { params: [], call: () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; } },
  time:      { params: [], call: () => { const d=new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`; } },
  timestamp: { params: [], call: () => Date.now() },
  year:    { params: ['date'], call: (args) => new Date(args[0]??Date.now()).getFullYear() },
  month:   { params: ['date'], call: (args) => new Date(args[0]??Date.now()).getMonth()+1 },
  day:     { params: ['date'], call: (args) => new Date(args[0]??Date.now()).getDate() },
  hour:    { params: ['date'], call: (args) => new Date(args[0]??Date.now()).getHours() },
  minute:  { params: ['date'], call: (args) => new Date(args[0]??Date.now()).getMinutes() },
  weekday: { params: ['date'], call: (args) => ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(args[0]??Date.now()).getDay()] },
  dateadd: { params: ['date','n','unit'], call: (args) => {
    const d=new Date(args[0]); const n=Number(args[1]); const u=String(args[2]??'day').toLowerCase();
    if(u==='day'||u==='days')d.setDate(d.getDate()+n);
    else if(u==='month'||u==='months')d.setMonth(d.getMonth()+n);
    else if(u==='year'||u==='years')d.setFullYear(d.getFullYear()+n);
    else if(u==='hour'||u==='hours')d.setHours(d.getHours()+n);
    else if(u==='minute'||u==='minutes')d.setMinutes(d.getMinutes()+n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }},
  datediff: { params: ['d1','d2','unit'], call: (args) => {
    const d1=new Date(args[0]),d2=new Date(args[1]); const ms=d2-d1; const u=String(args[2]??'day').toLowerCase();
    if(u==='day'||u==='days')return Math.round(ms/86400000);
    if(u==='hour'||u==='hours')return Math.round(ms/3600000);
    if(u==='minute'||u==='minutes')return Math.round(ms/60000);
    if(u==='month'||u==='months')return (d2.getFullYear()-d1.getFullYear())*12+(d2.getMonth()-d1.getMonth());
    if(u==='year'||u==='years')return d2.getFullYear()-d1.getFullYear();
    return Math.round(ms/86400000);
  }},
  // ── Type and utility ────────────────────────────────────────────────────
  type: {
    params: ['x'],
    call: (args) => {
      const v = args[0];
      if (v === NONE || v === null) return 'none';
      if (v === true || v === false) return 'boolean';
      if (v instanceof IVXFunction) return 'function';
      if (v instanceof IVXClass)    return 'class';
      if (v instanceof Map)         return v.get('__class__') ? String(v.get('__class__')).toLowerCase() : 'dict';
      if (Array.isArray(v))         return 'list';
      if (typeof v === 'string')    return 'string';
      if (Number.isInteger(v))      return 'integer';
      if (typeof v === 'number')    return 'float';
      return 'unknown';
    },
  },
  isString:  { params: ['x'], call: (args) => typeof args[0] === 'string' },
  isInt:     { params: ['x'], call: (args) => typeof args[0] === 'number' && Number.isInteger(args[0]) },
  isFloat:   { params: ['x'], call: (args) => typeof args[0] === 'number' && !Number.isInteger(args[0]) },
  isBool:    { params: ['x'], call: (args) => args[0] === true || args[0] === false },
  isList:    { params: ['x'], call: (args) => Array.isArray(args[0]) },
  isDict:    { params: ['x'], call: (args) => args[0] instanceof Map },
  isNone:    { params: ['x'], call: (args) => args[0] === NONE || args[0] === null },
  isNum:     { params: ['x'], call: (args) => typeof args[0] === 'number' },
  range: {
    params: ['n'],
    call: (args, node) => {
      const n = Math.trunc(Number(args[0]));
      if (!isFinite(n)) throw new RuntimeError('range() requires a finite integer', node?.line);
      if (n < 0) return [];
      if (n > 100000) throw new RuntimeError('range() limit is 100000', node?.line);
      return Array.from({ length: n }, (_, i) => i);
    },
  },
  error: {
    params: ['msg'],
    call: (args, node) => { throw new RuntimeError(String(args[0] ?? 'error'), node?.line); },
  },

  // ── Dict operations ─────────────────────────────────────────────────────
  merge: {
    params: ['a', 'b'],
    call: (args) => {
      const a = args[0]; const b = args[1];
      if (!(a instanceof Map) || !(b instanceof Map)) return a ?? NONE;
      const result = new Map(a);
      for (const [k, v] of b) result.set(k, v);
      return result;
    },
  },
  pick: {
    params: ['d', 'keys'],
    call: (args) => {
      const d = args[0]; const keys = args[1];
      if (!(d instanceof Map)) return new Map();
      const result = new Map();
      const ks = Array.isArray(keys) ? keys : [keys];
      for (const k of ks) if (d.has(k)) result.set(k, d.get(k));
      return result;
    },
  },
  omit: {
    params: ['d', 'keys'],
    call: (args) => {
      const d = args[0]; const keys = args[1];
      if (!(d instanceof Map)) return new Map();
      const result = new Map(d);
      const ks = Array.isArray(keys) ? keys : [keys];
      for (const k of ks) result.delete(k);
      return result;
    },
  },
  update: {
    params: ['d', 'key', 'val'],
    call: (args) => {
      const d = args[0];
      if (!(d instanceof Map)) return d;
      const result = new Map(d);
      result.set(args[1], args[2]);
      return result;
    },
  },
  entries: {
    params: ['d'],
    call: (args) => {
      const d = args[0];
      if (!(d instanceof Map)) return [];
      return [...d.entries()]
        .filter(([k]) => !String(k).startsWith('__'))
        .map(([k, v]) => [k, v]);
    },
  },
  fromkeys: {
    params: ['keys', 'val'],
    call: (args) => {
      const keys = args[0]; const val = args[1] ?? NONE;
      if (!Array.isArray(keys)) return new Map();
      const result = new Map();
      for (const k of keys) result.set(k, val);
      return result;
    },
  },

  // ── Regular expressions ───────────────────────────────────────────────────
  match: {
    params: ['s', 'pattern'],
    call: (args, node) => {
      try {
        return new RegExp(String(args[1])).test(String(args[0]));
      } catch(e) { throw new RuntimeError(`match: invalid pattern: ${e.message}`, node?.line); }
    },
  },
  findall: {
    params: ['s', 'pattern'],
    call: (args, node) => {
      try {
        const matches = String(args[0]).match(new RegExp(String(args[1]), 'g'));
        return matches ?? [];
      } catch(e) { throw new RuntimeError(`findall: invalid pattern: ${e.message}`, node?.line); }
    },
  },
  search: {
    params: ['s', 'pattern'],
    call: (args, node) => {
      try {
        const m = String(args[0]).match(new RegExp(String(args[1])));
        if (!m) return NONE;
        const result = new Map();
        result.set('match', m[0]);
        result.set('index', m.index);
        result.set('groups', m.slice(1));
        return result;
      } catch(e) { throw new RuntimeError(`search: invalid pattern: ${e.message}`, node?.line); }
    },
  },
  sub: {
    params: ['s', 'pattern', 'replacement'],
    call: (args, node) => {
      try {
        return String(args[0]).replace(new RegExp(String(args[1]), 'g'), String(args[2]));
      } catch(e) { throw new RuntimeError(`sub: invalid pattern: ${e.message}`, node?.line); }
    },
  },
  split_re: {
    params: ['s', 'pattern'],
    call: (args, node) => {
      try {
        return String(args[0]).split(new RegExp(String(args[1])));
      } catch(e) { throw new RuntimeError(`split_re: invalid pattern: ${e.message}`, node?.line); }
    },
  },

  format: { params: ['date','pattern'], call: (args) => {
    const d=new Date(args[0]);
    return String(args[1]??'YYYY-MM-DD')
      .replace('YYYY',d.getFullYear()).replace('MM',String(d.getMonth()+1).padStart(2,'0'))
      .replace('DD',String(d.getDate()).padStart(2,'0')).replace('HH',String(d.getHours()).padStart(2,'0'))
      .replace('mm',String(d.getMinutes()).padStart(2,'0')).replace('ss',String(d.getSeconds()).padStart(2,'0'))
      .replace('ddd',['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()])
      .replace('dddd',['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]);
  }},
};

function ivxToPlain(value) {
  if (value === NONE || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(v => ivxToPlain(v));
  if (value instanceof Map) {
    const obj = {};
    for (const [k, v] of value.entries()) obj[String(k)] = ivxToPlain(v);
    return obj;
  }
  if (typeof value === 'object') {
    const obj = {};
    for (const [k, v] of Object.entries(value)) obj[k] = ivxToPlain(v);
    return obj;
  }
  return value;
}

function tableToObjectRows(table) {
  if (!Array.isArray(table)) return [];
  if (table.length === 0) return [];

  // Row objects (plain objects / maps)
  if (table.every(r => r instanceof Map || (r && typeof r === 'object' && !Array.isArray(r)))) {
    return table.map(r => (r instanceof Map ? ivxToPlain(r) : ivxToPlain(r)));
  }

  // 2D list rows -> object rows (header-aware)
  if (table.every(r => Array.isArray(r))) {
    const first = table[0] ?? [];
    const hasHeader = first.every(c => typeof c === 'string');
    const rows = hasHeader ? table.slice(1) : table;
    const headers = hasHeader
      ? first
      : Array.from({ length: Math.max(...rows.map(r => r.length), 0) }, (_, i) => `c${i}`);

    return rows.map(r => {
      const obj = {};
      for (let i = 0; i < headers.length; i++) obj[headers[i]] = ivxToPlain(r[i]);
      return obj;
    });
  }

  return table.map(v => ({ value: ivxToPlain(v) }));
}

function tableCompare(left, op, right) {
  switch (op) {
    case '=': return left === right;
    case '!=': return left !== right;
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
    case 'contains': return String(left ?? '').includes(String(right ?? ''));
    default: return left === right;
  }
}

function tableWhere(args, node) {
  const rows = tableToObjectRows(args[0]);

  // Predicate form: where(table, fn) — fn is an IVXFunction taking a row
  // This is used when the user passes a lambda: where(table, fun(r) then give r.status = "active")
  // Note: the parser rewrites where(table.col op value) into positional form at parse time,
  // so this branch handles explicit lambda predicates passed by the user.
  if (args.length === 2 && args[1] && typeof args[1] === 'object' && 'body' in args[1]) {
    // Return rows unevaluated — the async predicate case is handled in evalCall special-casing.
    // For sync builtins we can't await, so fall through to positional form.
    // (Async predicate where() is handled separately via the 'where' builtin's async path)
  }

  // Positional form: where(table, col, op?, value)
  // This is always what arrives after the parser's _rewriteWhereArg transforms
  // where(table.col op value) → where(table, "col", "op", value)
  const col = String(args[1] ?? '');
  if (!col) throw new RuntimeError("where() requires a column name or predicate", node?.line);

  let op = '=';
  let val = NONE;
  if (args.length >= 4) {
    op = String(args[2] ?? '=');
    val = ivxToPlain(args[3]);
  } else if (args.length === 3) {
    val = ivxToPlain(args[2]);
  }

  return rows.filter(r => tableCompare(r[col], op, val));
}

function tableOrder(table, col, dir = 'asc') {
  const rows = tableToObjectRows(table);
  const key = String(col ?? '');
  const sign = String(dir).toLowerCase() === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = a?.[key];
    const bv = b?.[key];
    if (av === bv) return 0;
    return av > bv ? sign : -sign;
  });
}

function tableGroup(table, cols) {
  const rows = tableToObjectRows(table);
  const keys = Array.isArray(cols) ? cols.map(String) : [String(cols ?? '')];
  const buckets = new Map();

  for (const row of rows) {
    const keyObj = {};
    for (const k of keys) keyObj[k] = row?.[k];
    const key = JSON.stringify(keyObj);
    if (!buckets.has(key)) buckets.set(key, { key: keyObj, rows: [] });
    buckets.get(key).rows.push(row);
  }

  return [...buckets.values()];
}

function tableAgg(grouped, col, fn, asName, node) {
  if (!Array.isArray(grouped)) throw new RuntimeError('agg() expects grouped rows list', node?.line);
  const key = String(col ?? '');
  const op = String(fn ?? 'count').toLowerCase();
  const outKey = String(asName ?? `${op}_${key}`);

  return grouped.map(g => {
    const rows = Array.isArray(g?.rows) ? g.rows : [];
    const values = rows.map(r => r?.[key]).filter(v => v !== null && v !== undefined);
    let value;

    if (op === 'count') value = rows.length;
    else if (op === 'sum') value = values.reduce((a, v) => a + Number(v || 0), 0);
    else if (op === 'avg') value = values.length ? values.reduce((a, v) => a + Number(v || 0), 0) / values.length : 0;
    else if (op === 'min') value = values.length ? values.reduce((a, v) => (a < v ? a : v)) : NONE;
    else if (op === 'max') value = values.length ? values.reduce((a, v) => (a > v ? a : v)) : NONE;
    else throw new RuntimeError(`agg(): unknown function '${op}'`, node?.line);

    return { ...(g?.key ?? {}), [outKey]: value };
  });
}

function tableJoin(leftTable, rightTable, leftCol, rightCol, kind = 'inner', node) {
  const left = tableToObjectRows(leftTable);
  const right = tableToObjectRows(rightTable);
  const lCol = String(leftCol ?? '');
  const rCol = String(rightCol ?? '');
  const mode = String(kind ?? 'inner').toLowerCase();

  if (!lCol || !rCol) throw new RuntimeError('join() requires left and right key columns', node?.line);

  const rIndex = new Map();
  for (const r of right) {
    const key = r?.[rCol];
    if (!rIndex.has(key)) rIndex.set(key, []);
    rIndex.get(key).push(r);
  }

  const out = [];
  const rightSeen = new Set();
  for (const l of left) {
    const key = l?.[lCol];
    const matches = rIndex.get(key) ?? [];
    if (matches.length === 0) {
      if (mode === 'left' || mode === 'full') out.push({ ...l });
      continue;
    }
    for (const r of matches) {
      rightSeen.add(r);
      const merged = { ...l };
      for (const [k, v] of Object.entries(r ?? {})) {
        if (k in merged) merged[`r_${k}`] = v;
        else merged[k] = v;
      }
      out.push(merged);
    }
  }

  if (mode === 'right' || mode === 'full') {
    for (const r of right) {
      if (rightSeen.has(r)) continue;
      out.push({ ...r });
    }
  }

  return out;
}


// ── IVXRuntime — I/O, external services, file operations ─────────────────────
// All side effects live here. The Interpreter calls this.runtime.<method>()
// To add a new integration (text, Telegram, etc.) add a method here.
class IVXRuntime {
  constructor(interp) {
    this._interp = interp;
  }

  async _executePost(node, env, { storeResponse = false } = {}) {
    const url  = await this._interp.evalExpr(node.url,  env);
    const body = await this._interp.evalExpr(node.body, env);
    const cred = node.credential
      ? await this._interp.evalExpr(node.credential, env)
      : this._interp.globals.get('__credential__') ?? null;
    const headers = { 'Content-Type': 'application/json' };
    if (cred) headers['Authorization'] = `Bearer ${cred}`;

    try {
      const res = await fetch(String(url), {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      const ct = res.headers.get('content-type') || '';
      const result = ct.includes('application/json') ? await res.json() : await res.text();
      if (storeResponse) {
        // Convenience variable for statement-form post.
        this._interp.globals.set('response', result);
      }
      return result;
    } catch (e) {
      throw new RuntimeError(`post failed: ${e.message}`, node.line);
    }
  }

  _ivxToPlain(value) {
    if (value === NONE || value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(v => this._ivxToPlain(v));
    if (value instanceof Map) {
      const obj = {};
      for (const [k, v] of value.entries()) obj[String(k)] = this._ivxToPlain(v);
      return obj;
    }
    if (typeof value === 'object') {
      const obj = {};
      for (const [k, v] of Object.entries(value)) obj[k] = this._ivxToPlain(v);
      return obj;
    }
    return value;
  }

  _escapeDelimitedCell(val, delimiter) {
    const s = String(val ?? '');
    const needsQuote = s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delimiter);
    const escaped = s.replace(/"/g, '""');
    return needsQuote ? `"${escaped}"` : escaped;
  }

  _toDelimitedText(value, delimiter) {
    const plain = this._ivxToPlain(value);

    if (Array.isArray(plain)) {
      if (plain.length === 0) return '';

      if (plain.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
        const headers = [];
        for (const row of plain) {
          for (const k of Object.keys(row)) {
            if (!headers.includes(k)) headers.push(k);
          }
        }
        const lines = [];
        lines.push(headers.map(h => this._escapeDelimitedCell(h, delimiter)).join(delimiter));
        for (const row of plain) {
          const line = headers
            .map(h => this._escapeDelimitedCell(row[h] ?? '', delimiter))
            .join(delimiter);
          lines.push(line);
        }
        return lines.join('\n');
      }

      if (plain.every(row => Array.isArray(row))) {
        return plain
          .map(row => row.map(cell => this._escapeDelimitedCell(cell, delimiter)).join(delimiter))
          .join('\n');
      }

      const header = this._escapeDelimitedCell('value', delimiter);
      const body = plain.map(v => this._escapeDelimitedCell(v, delimiter)).join('\n');
      return body ? `${header}\n${body}` : header;
    }

    if (plain && typeof plain === 'object') {
      const keys = Object.keys(plain);
      const header = keys.map(k => this._escapeDelimitedCell(k, delimiter)).join(delimiter);
      const row = keys.map(k => this._escapeDelimitedCell(plain[k], delimiter)).join(delimiter);
      return `${header}\n${row}`;
    }

    return String(plain ?? '');
  }

  _serializeForSave(value, filename) {
    const match = /\.([A-Za-z0-9]+)$/.exec(filename);
    const ext = (match?.[1] ?? 'txt').toLowerCase();

    if (ext === 'json') {
      return {
        filename,
        mimeType: 'application/json',
        content: JSON.stringify(this._ivxToPlain(value), null, 2),
      };
    }
    if (ext === 'csv') {
      return {
        filename,
        mimeType: 'text/csv',
        content: this._toDelimitedText(value, ','),
      };
    }
    if (ext === 'tsv') {
      return {
        filename,
        mimeType: 'text/tab-separated-values',
        content: this._toDelimitedText(value, '\t'),
      };
    }
    if (ext === 'xlsx') {
      this._interp.globals.set('err', "save: '.xlsx' uses CSV content in zero-dependency mode");
      return {
        filename,
        mimeType: 'text/csv',
        content: this._toDelimitedText(value, ','),
      };
    }

    return {
      filename,
      mimeType: 'text/plain',
      content: typeof value === 'string' ? value : ivxRepr(value),
    };
  }

  async _saveLocalFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async _saveDriveFile(filename, content, mimeType) {
    if (!driveToken) {
      throw new RuntimeError("save: not signed in to Google Drive", 0);
    }

    await driveEnsureFolder();
    const escapedName = String(filename).replace(/'/g, "\\'");
    const q = `'${driveFolderId}' in parents and name='${escapedName}' and trashed=false`;
    const found = await driveAPI(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    let fileId = found.files?.[0]?.id ?? null;

    if (!fileId) {
      const meta = await driveAPI('/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: filename,
          parents: [driveFolderId],
          mimeType: mimeType || 'text/plain',
        }),
      });
      fileId = meta.id;
    }

    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + driveToken,
        'Content-Type': mimeType || 'text/plain',
      },
      body: content,
    });
    if (!res.ok) {
      throw new RuntimeError(`save: Drive upload failed (${res.status})`, 0);
    }

    if (typeof driveListFiles === 'function') {
      try { await driveListFiles(); } catch (_) {}
    }
  }

  async _executeSave(node, env) {
    let value;
    if (node.valueExpr) {
      value = await this._interp.evalExpr(node.valueExpr, env);
    } else if (this._interp.globals.has('response')) {
      value = this._interp.globals.get('response');
    } else if (this._interp.globals.has('err')) {
      value = this._interp.globals.get('err');
    } else {
      value = NONE;
    }

    let rawName = await this._interp.evalExpr(node.filenameExpr, env);
    let filename = String(rawName ?? '').trim();
    if (!filename) {
      throw new RuntimeError("save: filename cannot be empty", node.line);
    }

    // Auto-name: no extension was given — pick one based on value type
    if (node.autoName && !filename.includes('.')) {
      if (Array.isArray(value) || value instanceof Map) {
        filename += '.json';
      } else {
        filename += '.txt';
      }
    }

    const payload = this._serializeForSave(value, filename);
    if (node.target === 'local') {
      await this._saveLocalFile(payload.filename, payload.content, payload.mimeType);
      return;
    }
    await this._saveDriveFile(payload.filename, payload.content, payload.mimeType);
  }


  async _evalAskExpr(node, env) {
    const prompt = await this._interp.evalExpr(node.prompt, env);
    const credential = node.credential
      ? await this._interp.evalExpr(node.credential, env)
      : this._interp.globals.get('__credential__') ?? null;
    const model = (node.model ?? 'gemini').toLowerCase();

    if (!credential) {
      throw new RuntimeError(
        `ask ${model}: no API key. Add: make key "your-key" use key`,
        node.line
      );
    }

    try {
      if (model === 'gemini' || model === 'google') {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${credential}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: String(prompt) }] }]
            }),
          }
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new RuntimeError(
            `Gemini error ${res.status}: ${err?.error?.message ?? res.statusText}`,
            node.line
          );
        }
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      }

      if (model === 'chatgpt' || model === 'gpt') {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${credential}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: String(prompt) }],
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new RuntimeError(
            `OpenAI error ${res.status}: ${err?.error?.message ?? res.statusText}`,
            node.line
          );
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content ?? '';
      }

      if (model === 'claude' || model === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': credential,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages: [{ role: 'user', content: String(prompt) }],
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new RuntimeError(
            `Claude error ${res.status}: ${err?.error?.message ?? res.statusText}`,
            node.line
          );
        }
        const data = await res.json();
        return data?.content?.[0]?.text ?? '';
      }

      throw new RuntimeError(
        `Unknown model '${model}'. Use: gemini, chatgpt, or claude`,
        node.line
      );

    } catch (e) {
      if (e instanceof RuntimeError) throw e;
      throw new RuntimeError(`ask ${model} failed: ${e.message}`, node.line);
    }
  }

  // ── Google service helpers ────────────────────────────────────────────────

  _googleToken() {
    // driveToken is the shared OAuth token for all Google services
    if (typeof driveToken !== 'undefined' && driveToken) return driveToken;
    return null;
  }

  async _googleAPI(url, opts = {}) {
    const token = this._googleToken();
    if (!token) throw new RuntimeError('Not signed in to Google. Click "Sign in to Google" first.', null);
    const res = await fetch(url, {
      ...opts,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message ?? err?.error?.status ?? res.statusText;
      throw new RuntimeError(`Google API error ${res.status}: ${msg}`, null);
    }
    return res.json();
  }

  // ── sheets <name> — returns a handle with .read and .write ───────────────
  async _evalSheetsOpenExpr(node, env) {
    const name = String(await this._interp.evalExpr(node.name, env));
    const token = this._googleToken();
    if (!token) throw new RuntimeError('Not signed in to Google. Click "Sign in to Google" first.', node.line);

    // Find the spreadsheet by name in Drive
    const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
    const listRes = await this._googleAPI(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`
    );
    const file = listRes?.files?.[0];
    if (!file) throw new RuntimeError(`Spreadsheet "${name}" not found in Drive.`, node.line);
    const spreadsheetId = file.id;
    const interp = this;

    // Return a Map-like handle with read/write methods
    const handle = new Map();
    handle.set('__type__', 'sheets');
    handle.set('__id__', spreadsheetId);
    handle.set('__name__', name);

    // handle.read("A1:C10") → 2D list
    handle.set('read', async (range) => {
      const r = encodeURIComponent(String(range));
      const data = await interp._googleAPI(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${r}`
      );
      return data?.values ?? [];
    });

    // handle.write("A1", value) or handle.write("A1:B2", [[...],[...]])
    handle.set('write', async (range, value) => {
      const r = encodeURIComponent(String(range));
      const body = Array.isArray(value) ? value : [[value]];
      await interp._googleAPI(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${r}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: JSON.stringify({ values: body }) }
      );
      return value;
    });

    // handle.append(row) — appends a row to the first sheet
    handle.set('append', async (row) => {
      const body = Array.isArray(row[0]) ? row : [row];
      await interp._googleAPI(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: body }) }
      );
      return row;
    });

    return handle;
  }

  // ── gmail to <addr> subject <subj> body <body> ────────────────────────────
  async _executeGmail(node, env) {
    const to      = node.to      ? String(await this._interp.evalExpr(node.to, env))      : '';
    const subject = node.subject ? String(await this._interp.evalExpr(node.subject, env)) : '';
    const body    = node.body    ? String(await this._interp.evalExpr(node.body, env))     : '';

    if (!to) throw new RuntimeError("email: missing recipient address", node.line);

    // Build RFC 2822 message and base64url-encode it
    const raw = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `MIME-Version: 1.0`,
      '',
      body,
    ].join('\r\n');

    const encoded = btoa(unescape(encodeURIComponent(raw)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await this._googleAPI(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { method: 'POST', body: JSON.stringify({ raw: encoded }) }
    );

    this._interp.onOutput?.(`Email sent to ${to}`);
  }

  // ── wait block: Level 1 polling execution ────────────────────────────────
  async _executeWaitBlock(node, env) {
    const POLL_MS    = 5000;  // poll every 5 seconds
    const MAX_POLLS  = 720;   // give up after 1 hour (720 × 5s)
    const trigger    = node.trigger;
    const interp     = this;

    const poll = async () => {
      if (trigger === 'email') {
        // Poll Gmail for unread messages from the source address
        const from = node.source ? String(await this._interp.evalExpr(node.source, env)) : '';
        const q    = encodeURIComponent(`is:unread${from ? ` from:${from}` : ''}`);
        const data = await this._googleAPI(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=1`
        );
        if (data?.messages?.length > 0) {
          // Fetch the message and expose it as 'request'
          const msg = await this._googleAPI(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${data.messages[0].id}`
          );
          const headers = msg?.payload?.headers ?? [];
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
          const fromAddr = headers.find(h => h.name === 'From')?.value ?? '';
          const bodyPart = msg?.payload?.parts?.[0]?.body?.data ?? msg?.payload?.body?.data ?? '';
          const bodyText = bodyPart ? atob(bodyPart.replace(/-/g,'+').replace(/_/g,'/')) : '';
          const triggerEnv = env.child();
          triggerEnv.set('request', new Map([
            ['subject', subject], ['from', fromAddr], ['body', bodyText], ['id', data.messages[0].id]
          ]));
          return triggerEnv;
        }
        return null;
      }

      if (trigger === 'sheets') {
        // Poll a sheet for new rows since last check
        const name = node.source ? String(await this._interp.evalExpr(node.source, env)) : '';
        const handle = await this._evalSheetsOpenExpr({ ...node, name: node.source }, env);
        const rows = await handle.get('read')('A1:Z1000');
        const lastSeen = this._interp.globals.get('__waitSheetRows__') ?? 0;
        const current  = (rows?.length ?? 1) - 1; // subtract header
        if (current > lastSeen) {
          this._interp.globals.set('__waitSheetRows__', current);
          const newRows = rows.slice(lastSeen + 1);
          const triggerEnv = env.child();
          triggerEnv.set('request', newRows);
          return triggerEnv;
        }
        // Initialise baseline on first poll
        if (lastSeen === 0) this._interp.globals.set('__waitSheetRows__', current);
        return null;
      }

      if (trigger === 'time') {
        // Check if current time matches (simple HH:MM match)
        const timeStr = node.source ? String(await this._interp.evalExpr(node.source, env)) : '';
        const now = new Date();
        const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        if (nowStr === timeStr) return env.child();
        return null;
      }

      return null;
    };

    this._interp.onOutput?.(`⏳ Waiting for ${trigger} trigger…`);

    let polls = 0;
    while (polls < MAX_POLLS) {
      const triggerEnv = await poll();
      if (triggerEnv) {
        this._interp.onOutput?.(`✓ ${trigger} trigger fired`);
        const r = await this._interp.execBlock(node.body, triggerEnv);
        if (r instanceof EndSignal || r instanceof ReturnSignal) return r;
        return;
      }
      polls++;
      await new Promise(res => setTimeout(res, POLL_MS));
    }

    this._interp.onOutput?.(`⚠ wait ${trigger}: timed out after ${MAX_POLLS * POLL_MS / 1000}s`);
  }

}

// ── Resolve a function parameter value (handles defaults and transforms) ──────
async function resolveParam(param, incoming, env, interp) {
  if (typeof param === 'string') return { name: param, value: incoming ?? NONE };
  const { name, lazy, defaultExpr, transformOp, transformRight } = param;
  let value;
  if (incoming !== undefined && incoming !== NONE) { value = incoming; }
  else if (defaultExpr) { value = await interp.evalExpr(defaultExpr, env); }
  else if (lazy) { value = transformOp ? 0 : NONE; }
  else { value = NONE; }
  if (transformOp && transformRight) {
    const right = await interp.evalExpr(transformRight, env);
    switch (transformOp) {
      case '+': value = value + right; break;
      case '-': value = value - right; break;
      case '*': value = value * right; break;
      case '/': value = right !== 0 ? value / right : NONE; break;
      case '//': value = right !== 0 ? Math.trunc(value / right) : NONE; break;
      case '%': value = value % right; break;
      case '^': value = Math.pow(value, right); break;
    }
  }
  return { name, value };
}


// ── Immutability inference ────────────────────────────────────────────────────
// Scan AST to find variables that are assigned exactly once and never
// reassigned — these are inferred immutable (const).
// Returns a Set of variable names that are safe to treat as const.
function inferImmutables(ast) {
  const assigned = new Map(); // name → count of assignments
  const mutated  = new Set(); // names that are explicitly mutated (make x + 1 shorthand)

  function scanExpr(node) {
    if (!node) return;
    if (node.type === 'Identifier') return;
    if (node.type === 'BinOp') { scanExpr(node.left); scanExpr(node.right); return; }
    if (node.type === 'UnaryOp') { scanExpr(node.operand); return; }
    if (node.type === 'Call') { node.args?.forEach(scanExpr); return; }
    if (node.type === 'Invoke') { scanExpr(node.callee); node.args?.forEach(scanExpr); return; }
    if (node.type === 'MemberAccess') { scanExpr(node.object); return; }
    if (node.type === 'IndexAccess') { scanExpr(node.target); scanExpr(node.index); return; }
    if (node.type === 'ListLit') { node.elements?.forEach(scanExpr); return; }
    if (node.type === 'DictLit') { node.pairs?.forEach(p => { scanExpr(p.key); scanExpr(p.value); }); return; }
  }

  function scanBlock(stmts) {
    if (!stmts) return;
    for (const node of stmts) scanStmt(node);
  }

  function scanStmt(node) {
    if (!node) return;
    if (node.type === 'Assign') {
      const name = node.name;
      if (name) {
        // Shorthand reassign (make x + 1) — the expr references name as implied left
        // Detect: BinOp where left is Identifier with same name, or implied shorthand
        const isShorthand = node.expr?.type === 'BinOp' &&
          node.expr.left?.type === 'Identifier' &&
          node.expr.left.name === name;
        const isMemberTarget = node.target?.type === 'MemberAccess';
        const isLazy = node.lazy;

        if (isShorthand || isLazy) {
          mutated.add(name);
        } else if (!isMemberTarget) {
          assigned.set(name, (assigned.get(name) ?? 0) + 1);
          if ((assigned.get(name) ?? 0) > 1) mutated.add(name);
        }
      }
      scanExpr(node.expr);
      return;
    }
    if (node.type === 'If') {
      scanExpr(node.condition);
      scanBlock(node.body);
      scanBlock(node.else_);
      return;
    }
    if (node.type === 'Loop') { scanExpr(node.condition); scanBlock(node.body); return; }
    if (node.type === 'For')  { scanBlock(node.body); return; }
    if (node.type === 'Fun')  { scanBlock(node.body); return; }
    if (node.type === 'Class') { scanBlock(node.body); return; }
    if (node.type === 'Try')  { scanBlock(node.body); scanBlock(node.errBody); return; }
    if (node.type === 'Say' || node.type === 'Give') { scanExpr(node.expr); return; }
    if (node.type === 'ExprStatement') { scanExpr(node.expr); return; }
  }

  scanBlock(ast.body);

  // A variable is immutable if assigned exactly once and never mutated
  const immutables = new Set();
  for (const [name, count] of assigned) {
    if (count === 1 && !mutated.has(name)) {
      immutables.add(name);
    }
  }
  return immutables;
}


class Interpreter {
  constructor(options = {}) {
    // I/O hooks — override these to wire up the browser UI
    this.onOutput  = options.onOutput  ?? (v => console.log(ivxRepr(v)));
    this.onInput   = options.onInput   ?? (() => { throw new RuntimeError("'take' requires an input handler"); });
    this.onError   = options.onError   ?? (e => console.error(e));
    this.onWait    = options.onWait    ?? (n => new Promise(r => setTimeout(r, n * 100)));
    // onStep(srcLine) — called before each statement executes with the 1-based source line
    this.onStep    = options.onStep    ?? null;

    // Max loop iterations — safety valve against infinite loops
    this.maxIterations = options.maxIterations ?? 100_000;

    this.globals = new Env();
    // Built-in: err starts as none
    this.globals.set('err', NONE);

    // Register built-in functions
    this._registerBuiltins();

    this.runtime = new IVXRuntime(this);
    this._immutables = new Set(); // populated before each run
    this._exprEvaluators = {
      NumberLit: (node, env) => this._evalNumberLit(node, env),
      StringLit: (node, env) => this._evalStringLit(node, env),
      BoolLit: (node, env) => this._evalBoolLit(node, env),
      Ask: (node, env) => this._evalAskExpr(node, env),
      SheetsOpen: (node, env) => this._evalSheetsOpenExpr(node, env),
      Super: (node, env) => this._evalSuperExpr(node, env),
      ListLit: (node, env) => this._evalListLit(node, env),
      DictLit: (node, env) => this._evalDictLit(node, env),
      MemberAccess: (node, env) => this._evalMemberAccessExpr(node, env),
      Identifier: (node, env) => this._evalIdentifierExpr(node, env),
      IndexAccess: (node, env) => this._evalIndexAccessExpr(node, env),
      LazyDecl: (node, env) => this._evalLazyDeclExpr(node, env),
      BinOp: (node, env) => this.evalBinOp(node, env),
      Fetch: (node, env) => this._evalFetchExpr(node, env),
      Post: (node, env) => this._evalPostExpr(node, env),
      UnaryOp: (node, env) => this._evalUnaryOpExpr(node, env),
      Call: (node, env) => this.evalCall(node, env),
      Invoke: (node, env) => this._evalInvokeExpr(node, env),
    };
  }

  // ── Execute a block of statements ─────────────────────────────────────────
  async execBlock(stmts, env) {
    for (const stmt of stmts) {
      if (!stmt) continue;
      const result = await this.execStmt(stmt, env);
      // Propagate control flow signals up
      if (result instanceof ReturnSignal)   return result;
      if (result instanceof BreakSignal)    return result;
      if (result instanceof ContinueSignal) return result;
      if (result instanceof EndSignal)      return result;
    }
  }

  // ── Execute a single statement ────────────────────────────────────────────
  async execStmt(node, env) {
    // Fire onStep so the renderer can highlight the active node
    if (this.onStep && node.line != null) this.onStep(node.line);
    switch (node.type) {

      case 'Assign': {
        // Lazy declaration: make name? + expr — hoist to global if not exists
        // Default is 0 for arithmetic context (most common), none otherwise
        if (node.lazy && node.name && !this.globals.has(node.name)) {
          // Peek at the expr to infer a better default
          // BinOp with arithmetic op on an Identifier named same as node.name
          // means the implied left is already set; infer from the right side
          let defaultVal = 0; // arithmetic shorthand implies integer
          if (node.expr?.type === 'BinOp') {
            const right = node.expr.right;
            if (right?.type === 'NumberLit') {
              defaultVal = Number.isInteger(right.value) ? 0 : 0.0;
            } else if (right?.type === 'StringLit') {
              defaultVal = '';
            } else if (right?.type === 'BoolLit') {
              defaultVal = false;
            }
          }
          this.globals.set(node.name, defaultVal);
        }
        const value = await this.evalExpr(node.expr, env);
        if (node.target?.type === 'MemberAccess') {
          const obj = await this.evalExpr(node.target.object, env);
          if (obj instanceof Map) {
            obj.set(node.target.field, value);
          } else if (obj && typeof obj === 'object') {
            obj[node.target.field] = value;
          } else {
            throw new RuntimeError(`Cannot assign field '${node.target.field}' on non-object value`, node.line);
          }
        } else {
          if (this._immutables?.has(node.name)) {
            env.setConst(node.name, value);
          } else {
            env.set(node.name, value);
          }
        }
        break;
      }

      case 'Delete': {
        if (!env.del(node.name)) {
          throw new RuntimeError(`Cannot delete undefined variable '${node.name}'`, node.line);
        }
        break;
      }

      case 'Say': {
        const value = await this.evalExpr(node.expr, env);
        await this.onOutput(value);
        break;
      }

      case 'Take': {
        const raw = await this.onInput(node.name);
        let value = raw ?? NONE;
        // Apply converter if specified
        if (node.converter && value !== NONE) {
          try { value = this._callBuiltin(node.converter, [value], node); }
          catch(e) { this.globals.set('err', e.message ?? String(e)); }
        }
        env.set(node.name, value);
        break;
      }

      case 'Give': {
        const value = await this.evalExpr(node.expr, env);
        return new ReturnSignal(value);
      }

      case 'Use': {
        // use <key> — set global credential
        const keyVal = await this.evalExpr(node.key, env);
        this.globals.set('__credential__', String(keyVal));
        break;
      }

      case 'Post': {
        // post <url> <body> [use <key>]
        // Result stored in 'response' by default, or assign via make response post ...
        return await this._executePost(node, env, { storeResponse: true });
      }

      case 'Gmail': {
        await this._executeGmail(node, env);
        break;
      }

      case 'Save': {
        await this._executeSave(node, env);
        break;
      }

      case 'TakeFile': {
        // take file.csv — browser file picker
        const result = await new Promise((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          const extMap = { csv: '.csv', json: '.json', txt: '.txt', tsv: '.tsv', xml: '.xml' };
          input.accept = extMap[node.ext] || '*';
          input.onchange = async () => {
            const file = input.files[0];
            if (!file) { resolve(NONE); return; }
            const text = await file.text();
            try {
              if (node.ext === 'json') {
                resolve(JSON.parse(text));
              } else if (node.ext === 'csv' || node.ext === 'tsv') {
                const sep = node.ext === 'tsv' ? '\t' : ',';
                const lines = text.trim().split('\n');
                const headers = lines[0].split(sep).map(h => h.trim());
                const rows = lines.slice(1).map(line => {
                  const vals = line.split(sep);
                  const row = new Map();
                  headers.forEach((h, i) => row.set(h, vals[i]?.trim() ?? ''));
                  return row;
                });
                resolve(rows);
              } else {
                resolve(text);
              }
            } catch(e) {
              reject(new RuntimeError(`Failed to parse ${node.ext}: ${e.message}`, node.line));
            }
          };
          input.click();
        });
        env.set(node.name, result);
        break;
      }

      case 'Wait': {
        if (node.condition) {
          // wait x = 5 — poll until condition is true
          let iters = 0;
          while (true) {
            const cond = await this.evalExpr(node.condition, env);
            if (cond) break;
            if (++iters > this.maxIterations) {
              throw new RuntimeError("'wait' condition never became true", node.line);
            }
            await this.onWait(1);
          }
        } else {
          const cycles = await this.evalExpr(node.expr, env);
          await this.onWait(Number(cycles) || 1);
        }
        break;
      }

      case 'WaitBlock': {
        // WaitBlock is a declaration — deployed to Apps Script automatically.
        // The browser never executes it directly, just like 'fun' doesn't run its body.
        break;
      }

      case 'If': {
        const cond = await this.evalExpr(node.condition, env);
        const bodyEnv = env.child();
        if (isTruthy(cond)) {
          const r = await this.execBlock(node.body, bodyEnv);
          if (r) return r;
        } else if (node.else_) {
          const elseEnv = env.child();
          const r = await this.execBlock(node.else_, elseEnv);
          if (r) return r;
        }
        break;
      }

      case 'Loop': {
        let iters = 0;
        while (true) {
          // Re-fire onStep so the Decision node highlights on every iteration
          if (this.onStep && node.line != null) this.onStep(node.line);
          const cond = await this.evalExpr(node.condition, env);
          if (!isTruthy(cond)) break;
          if (++iters > this.maxIterations) {
            throw new RuntimeError('Loop exceeded maximum iterations', node.line);
          }
          const loopEnv = env.child();
          const r = await this.execBlock(node.body, loopEnv);
          if (r instanceof ReturnSignal)  return r;
          if (r instanceof BreakSignal)   break;
        }
        break;
      }

      case 'For': {
        let iterable;
        if (node.targetExpr) {
          iterable = await this.evalExpr(node.targetExpr, env);
        } else {
          iterable = env.get(node.target);
          if (iterable === undefined) {
            throw new RuntimeError(`Undefined variable '${node.target}'`, node.line);
          }
        }
        const entries = toIterable(iterable, node);
        let iters = 0;
        for (const [primary, secondary] of entries) {
          // Re-fire onStep so the Decision node highlights on every iteration
          if (this.onStep && node.line != null) this.onStep(node.line);
          if (++iters > this.maxIterations) {
            throw new RuntimeError('For loop exceeded maximum iterations', node.line);
          }
          const forEnv = env.child();
          forEnv.set(node.iterVar,  primary);
          forEnv.set(node.iterVar2, secondary);
          const r = await this.execBlock(node.body, forEnv);
          if (r instanceof ReturnSignal)  return r;
          if (r instanceof BreakSignal)   break;
        }
        break;
      }

      case 'Fun': {
        const fn = new IVXFunction(node.name, node.params, node.body, env);
        env.set(node.name, fn);
        break;
      }

      case 'Class': {
        const superClass = node.superclass
          ? this._resolveClassObject(node.superclass.name, env)
          : null;
        if (node.superclass && !superClass) {
          throw new RuntimeError(`Superclass '${node.superclass.name}' is not defined`, node.superclass.line, node.superclass.col);
        }
        const cls = new IVXClass(node.name, node.body, env, superClass);
        const classEnv = env.child();
        classEnv.set('self', NONE);
        if (superClass) {
          classEnv.set('super', new IVXSuperProxy(NONE, cls));
        }
        for (const stmt of node.body ?? []) {
          if (stmt?.type === 'Fun') {
            const methodFn = new IVXFunction(stmt.name, stmt.params, stmt.body, classEnv);
            methodFn.__ownerClass = cls;
            cls.methods.set(stmt.name, methodFn);
          } else if (stmt) {
            cls.initStmts.push(stmt);
          }
        }
        env.set(node.name, cls);
        break;
      }

      case 'Try': {
        try {
          const result = await this.execBlock(node.body, env);
          if (result instanceof ReturnSignal || result instanceof EndSignal) return result;
        } catch (e) {
          const msg = e instanceof RuntimeError ? e.message : (e?.message ?? String(e));
          const errEnv = env.child();
          errEnv.set(node.errVar ?? 'err', msg);
          this.globals.set('err', msg);
          if (node.errBody?.length) {
            const result = await this.execBlock(node.errBody, errEnv);
            if (result instanceof ReturnSignal || result instanceof EndSignal) return result;
          }
        }
        break;
      }

      case 'End': {
        if (node.stmt) await this.execStmt(node.stmt, env);
        return new EndSignal();
      }

      case 'Dot':
        // Connector — no-op at runtime
        break;

      case 'Import': {
        if (!node.url) break;
        try {
          const res = await fetch(node.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const src = await res.text();
          const modEnv = this.globals.child();
          const parsed = parse(src);
          await this.execBlock(parsed.ast.body, modEnv);
          const imports = node.imports ?? [];
          if (imports.length > 0) {
            for (const { name, alias } of imports) {
              const val = modEnv.get(name);
              if (val === undefined) throw new RuntimeError(`Module does not export '${name}'`, node.line);
              env.set(alias, val);
            }
          } else if (node.names && node.names.length > 0) {
            for (const name of node.names) {
              const val = modEnv.get(name);
              if (val === undefined) throw new RuntimeError(`Module does not export '${name}'`, node.line);
              env.set(name, val);
            }
          } else {
            for (const [k, v] of modEnv.vars) env.set(k, v);
          }
        } catch (e) {
          if (e instanceof RuntimeError) throw e;
          throw new RuntimeError(`Import failed from ${node.url}: ${e.message}`, node.line);
        }
        break;
      }

      case 'ExprStatement':
        if (node.expr) await this.evalExpr(node.expr, env);
        break;

      default:
        break;
    }
  }

  // ── Evaluate an expression to a value ─────────────────────────────────────
  async evalExpr(node, env) {
    if (!node) return NONE;
    const evaluator = this._exprEvaluators[node.type];
    if (!evaluator) return NONE;
    return await evaluator(node, env);
  }

  async _evalNumberLit(node) {
    return node.value;
  }

  async _evalStringLit(node, env) {
    let sv = node.value;
    if (typeof sv === 'string' && sv.includes('{')) {
      const parts = [];
      let i = 0;
      while (i < sv.length) {
        const open = sv.indexOf('{', i);
        if (open === -1) { parts.push(sv.slice(i)); break; }
        parts.push(sv.slice(i, open));
        const close = sv.indexOf('}', open);
        if (close === -1) { parts.push(sv.slice(open)); break; }
        const expr = sv.slice(open + 1, close).trim();
        try {
          const parsed = parse(expr + '\n');
          if (parsed.ast?.body?.length > 0) {
            const exprNode = parsed.ast.body[0]?.expr ?? parsed.ast.body[0];
            if (exprNode) { parts.push(ivxRepr(await this.evalExpr(exprNode, env))); }
            else { parts.push('{' + expr + '}'); }
          } else { parts.push('{' + expr + '}'); }
        } catch { parts.push(ivxRepr(env.get(expr)) ?? '{' + expr + '}'); }
        i = close + 1;
      }
      sv = parts.join('');
    }
    // String is a plain value. Fetching is explicit via the 'fetch' keyword.
    return sv;
  }

  async _evalBoolLit(node) {
    return node.value;
  }

  // ── fetch <url> — explicit HTTP GET ───────────────────────────────────────
  async _evalFetchExpr(node, env) {
    const url = await this.evalExpr(node.url, env);
    const urlStr = String(url ?? '').trim();
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
      throw new RuntimeError(
        `fetch: expected a URL starting with http:// or https://, got: ${urlStr}`,
        node.line
      );
    }
    try {
      const res = await fetch(urlStr);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return await res.json();
      return await res.text();
    } catch (e) {
      if (e instanceof RuntimeError) throw e;
      throw new RuntimeError(`fetch failed for ${urlStr}: ${e.message}`, node.line);
    }
  }



  // ── Execute a program from source ─────────────────────────────────────────
  async run(source, options = {}) {
    const parsed = parse(source);
    const { errors: typeErrors } = typecheck(parsed);
    const hasParseErrors = parsed.errors.length > 0;
    if (typeErrors.length > 0 && (hasParseErrors || !options.ignoreTypeErrors)) {
      for (const e of typeErrors) this.onError(e);
      return;
    }
    // Infer immutable variables before execution
    this._immutables = inferImmutables(parsed.ast);
    try {
      await this.execBlock(parsed.ast.body, this.globals);
    } catch (e) {
      if (e instanceof RuntimeError) this.onError(e);
      else throw e;
    }
  }

  _resolveClassObject(name, env = this.globals) {
    const value = env?.get?.(name);
    return value instanceof IVXClass ? value : null;
  }

  _bindMethod(methodFn, selfValue) {
    const bound = new IVXFunction(methodFn.name, methodFn.params, methodFn.body, methodFn.closure);
    bound.__ownerClass = methodFn.__ownerClass ?? null;
    bound.__boundSelf = selfValue;

    const ownerClass = methodFn.__ownerClass ?? null;
    if (ownerClass?.superclass) {
      bound.__boundSuper = new IVXSuperProxy(selfValue, ownerClass);
    }

    return bound;
  }

  _resolveInstanceMember(instance, field, selfValue = instance) {
    if (!(instance instanceof Map)) return NONE;
    if (instance.has(field)) return instance.get(field);

    const classObj = instance.get('__class_obj__');
    const method = classObj?.resolveMethod?.(field) ?? null;
    if (method) {
      return this._bindMethod(method, selfValue);
    }

    return NONE;
  }

  _resolveSuperMember(proxy, field) {
    if (!(proxy instanceof IVXSuperProxy)) return NONE;
    const superClass = proxy.ownerClass?.superclass ?? null;
    const method = superClass?.resolveMethod?.(field) ?? null;
    if (method) return this._bindMethod(method, proxy.self);
    return NONE;
  }

  // ── Built-in functions ────────────────────────────────────────────────────
  _registerBuiltins() {
    const G = this.globals;
    for (const [name, spec] of Object.entries(BUILTIN_DEFS)) {
      G.set(name, new IVXFunction(name, spec.params, null, null));
    }
  }

  // ── Call a built-in function by name ──────────────────────────────────────
  _callBuiltin(name, args, node) {
    const spec = BUILTIN_DEFS[name];
    if (!spec) throw new RuntimeError(`Unknown built-in '${name}'`, node?.line);
    return spec.call(args, node, this);
  }


  // ── I/O delegation — all side effects live in IVXRuntime ─────────────────
  async _executePost(node, env, opts)         { return this.runtime._executePost(node, env, opts); }
  async _saveLocalFile(f, c, m)              { return this.runtime._saveLocalFile(f, c, m); }
  async _saveDriveFile(f, c, m)              { return this.runtime._saveDriveFile(f, c, m); }
  _ivxToPlain(v)                             { return this.runtime._ivxToPlain(v); }
  _escapeDelimitedCell(v, d)                 { return this.runtime._escapeDelimitedCell(v, d); }
  _toDelimitedText(v, d)                     { return this.runtime._toDelimitedText(v, d); }
  _serializeForSave(v, f)                    { return this.runtime._serializeForSave(v, f); }
  async _evalAskExpr(node, env)              { return this.runtime._evalAskExpr(node, env); }
  async _evalSheetsOpenExpr(node, env)       { return this.runtime._evalSheetsOpenExpr(node, env); }
  async _executeGmail(node, env)             { return this.runtime._executeGmail(node, env); }
  async _executeWaitBlock(node, env)         { return this.runtime._executeWaitBlock(node, env); }


  async _evalListLit(node, env) {
    const elements = [];
    for (const el of node.elements) elements.push(await this.evalExpr(el, env));
    return elements;
  }

  async _evalDictLit(node, env) {
    const map = new Map();
    for (const { key, value } of node.pairs) {
      const k = await this.evalExpr(key, env);
      const v = await this.evalExpr(value, env);
      map.set(k, v);
    }
    return map;
  }

  async _evalMemberAccessExpr(node, env) {
    const target = await this.evalExpr(node.object, env);
    if (target instanceof IVXSuperProxy) {
      return this._resolveSuperMember(target, node.field);
    }
    if (target instanceof Map) {
      return this._resolveInstanceMember(target, node.field, target);
    }
    if (target && typeof target === 'object') {
      return node.field in target ? target[node.field] : NONE;
    }
    return NONE;
  }

  async _evalSuperExpr(node, env) {
    const target = env.get('super');
    if (target instanceof IVXSuperProxy) return target;
    throw new RuntimeError(`'super' is only available inside a subclass method`, node.line, node.col);
  }

  async _evalIdentifierExpr(node, env) {
    const val = env.get(node.name);
    if (val === undefined) {
      throw new RuntimeError(`Undefined variable '${node.name}'`, node.line, node.col);
    }
    return val;
  }

  async _evalInvokeExpr(node, env) {
    const callee = await this.evalExpr(node.callee, env);
    const args = [];
    for (const arg of node.args) args.push(await this.evalExpr(arg, env));

    if (callee instanceof IVXFunction) {
      if (callee.body === null) {
        try {
          return this._callBuiltin(callee.name, args, node) ?? NONE;
        } catch (e) {
          this.globals.set('err', e.message ?? String(e));
          return NONE;
        }
      }
      const fnEnv = callee.closure.child();
      if (callee.__boundSelf !== undefined) {
        fnEnv.set('self', callee.__boundSelf);
      }
      if (callee.__boundSuper !== undefined) {
        fnEnv.set('super', callee.__boundSuper);
      }
      for (let i = 0; i < callee.params.length; i++) {
        const { name: pn, value: pv } = await resolveParam(callee.params[i], args[i], fnEnv, this);
        fnEnv.set(pn, pv);
      }
      try {
        const result = await this.execBlock(callee.body, fnEnv);
        if (result instanceof ReturnSignal) return result.value;
        return NONE;
      } catch (e) {
        this.globals.set('err', e.message ?? String(e));
        return NONE;
      }
    }

    if (callee instanceof IVXClass) {
      try {
        return await callee.instantiate(args, this, node);
      } catch (e) {
        this.globals.set('err', e.message ?? String(e));
        return NONE;
      }
    }

    // Native async functions stored in Maps (e.g. sheets handle methods)
    if (typeof callee === 'function') {
      try {
        return await callee(...args) ?? NONE;
      } catch (e) {
        if (e instanceof RuntimeError) throw e;
        throw new RuntimeError(e.message ?? String(e), node.line);
      }
    }

    throw new RuntimeError('Attempted to call a non-callable value', node.line);
  }

  _toArrayIndex(value, node, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new RuntimeError(`${label} index must be an integer`, node?.line);
    }
    return n;
  }

  _toSliceBound(value, node, label) {
    if (value === null || value === undefined) return null;
    return this._toArrayIndex(value, node, label);
  }

  _toExcelColumnIndex(value) {
    if (typeof value !== 'string') return null;
    const col = value.trim().toUpperCase();
    if (!/^[A-Z]+$/.test(col)) return null;
    let out = 0;
    for (let i = 0; i < col.length; i++) {
      out = out * 26 + (col.charCodeAt(i) - 64);
    }
    return out - 1;
  }

  _parseExcelCellRef(value) {
    if (typeof value !== 'string') return null;
    const m = value.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!m) return null;
    const col = this._toExcelColumnIndex(m[1]);
    const row = Number(m[2]);
    if (col == null || !Number.isInteger(row) || row < 0) return null;
    return { row, col };
  }

  _normalizeTableColumnSelector(value, node) {
    if (typeof value !== 'string') return value;
    const colIdx = this._toExcelColumnIndex(value);
    if (colIdx == null) {
      throw new RuntimeError(`Invalid table column '${value}'. Use Excel letters like A, B, AA`, node?.line);
    }
    return colIdx;
  }

  _sliceExcelRange(table, startRef, endRef) {
    const rowStart = Math.min(startRef.row, endRef.row);
    const rowEnd = Math.max(startRef.row, endRef.row);
    const colStart = Math.min(startRef.col, endRef.col);
    const colEnd = Math.max(startRef.col, endRef.col);
    const out = [];

    for (let r = rowStart; r <= rowEnd; r++) {
      const rowVal = table[r] ?? NONE;
      if (Array.isArray(rowVal)) {
        out.push(rowVal.slice(colStart, colEnd + 1));
      } else if (rowVal instanceof Map) {
        const rowOut = [];
        for (let c = colStart; c <= colEnd; c++) rowOut.push(rowVal.get(c) ?? NONE);
        out.push(rowOut);
      } else if (rowVal && typeof rowVal === 'object') {
        const rowOut = [];
        for (let c = colStart; c <= colEnd; c++) rowOut.push(rowVal[c] ?? NONE);
        out.push(rowOut);
      } else {
        out.push([]);
      }
    }

    return out;
  }

  _pickColumnFromRow(row, colIdxOrKey) {
    if (row == null) return NONE;
    if (row instanceof Map) {
      return row.has(colIdxOrKey) ? row.get(colIdxOrKey) : NONE;
    }
    if (Array.isArray(row)) {
      if (typeof colIdxOrKey === 'string') return NONE;
      return row[colIdxOrKey] ?? NONE;
    }
    if (typeof row === 'object') {
      return row[colIdxOrKey] ?? NONE;
    }
    return NONE;
  }

  _sliceColumnsFromRow(row, start, end) {
    if (Array.isArray(row)) return row.slice(start ?? undefined, end ?? undefined);
    return NONE;
  }

  // Returns the string name of an Excel-style cell/col ref if the AST node
  // is an Identifier matching /^[A-Z]+\d*$/i — e.g. A0, B2, AA, ZZ10.
  // Returns null for anything else, meaning normal evaluation should proceed.
  _excelIdentifierString(exprNode) {
    if (!exprNode || exprNode.type !== 'Identifier') return null;
    if (/^[A-Za-z]+\d*$/.test(exprNode.name) && /[A-Za-z]/.test(exprNode.name)) {
      // Must start with letters — pure-digit names are normal variables
      // Also exclude known loop vars (i, j, k, ii, etc.) when used standalone
      // with no digits, since those are almost always iteration variables.
      // But i0, j1, k2 etc. look like cell refs and should be treated as such.
      const hasDigit = /\d/.test(exprNode.name);
      const isLoopVar = /^(i{1,3}|j{1,3}|k{1,3})$/.test(exprNode.name);
      if (hasDigit || !isLoopVar) {
        return exprNode.name.toUpperCase();
      }
    }
    return null;
  }

  async _resolveIndexSpec(spec, env, node, label, { allowString = false } = {}) {
    if (!spec || spec.omitted) return { omitted: true, isSlice: false, value: null, start: null, end: null };
    if (spec.isSlice) {
      // For slices, check each bound for Excel-style identifiers before evaluating
      let startRaw, endRaw;
      if (spec.start) {
        const excelStart = this._excelIdentifierString(spec.start);
        startRaw = excelStart !== null ? excelStart : await this.evalExpr(spec.start, env);
      } else {
        startRaw = null;
      }
      if (spec.end) {
        const excelEnd = this._excelIdentifierString(spec.end);
        endRaw = excelEnd !== null ? excelEnd : await this.evalExpr(spec.end, env);
      } else {
        endRaw = null;
      }

      const start = (allowString || typeof startRaw === 'string')
        ? startRaw
        : this._toSliceBound(startRaw, node, `${label} start`);
      const end = (allowString || typeof endRaw === 'string')
        ? endRaw
        : this._toSliceBound(endRaw, node, `${label} end`);

      return {
        omitted: false,
        isSlice: true,
        start,
        end,
      };
    }

    // For single index: intercept Excel-style identifiers (A0, B2, AA10, etc.)
    // so they are treated as cell references on any 2D list, not variable lookups.
    if (spec.expr) {
      const excelStr = this._excelIdentifierString(spec.expr);
      if (excelStr !== null) {
        return { omitted: false, isSlice: false, value: excelStr, start: null, end: null };
      }
    }

    const raw = spec.expr ? await this.evalExpr(spec.expr, env) : null;
    if (allowString && typeof raw === 'string') {
      return { omitted: false, isSlice: false, value: raw, start: null, end: null };
    }
    return { omitted: false, isSlice: false, value: this._toArrayIndex(raw, node, label), start: null, end: null };
  }

  async _evalIndexAccessExpr(node, env) {
    const target = await this.evalExpr(node.target, env);
    const isArrayTarget = Array.isArray(target);

    const row = await this._resolveIndexSpec(node.rowSpec, env, node, 'Row', { allowString: isArrayTarget });
    const col = await this._resolveIndexSpec(node.colSpec, env, node, 'Column', { allowString: true });

    if (!isArrayTarget) {
      if (node.hasComma) {
        throw new RuntimeError(`2D indexing requires a list target`, node.line);
      }
      if (row.omitted) return target;
      if (row.isSlice) {
        if (typeof target === 'string') {
          return target.slice(row.start ?? undefined, row.end ?? undefined);
        }
        throw new RuntimeError(`Slice indexing requires list or string target`, node.line);
      }

      if (target instanceof Map) {
        return target.has(row.value) ? target.get(row.value) : NONE;
      }
      if (typeof target === 'object' && target !== null) {
        return target[row.value] ?? NONE;
      }
      if (typeof target === 'string') {
        const idx = this._toArrayIndex(row.value, node, 'Index');
        return target[idx] ?? NONE;
      }
      throw new RuntimeError(`Indexing requires a list/dict/string target`, node.line);
    }

    if (!node.hasComma) {
      if (row.omitted) return target;
      if (row.isSlice) {
        const startRef = this._parseExcelCellRef(row.start);
        const endRef = this._parseExcelCellRef(row.end);
        if (startRef && endRef) {
          return this._sliceExcelRange(target, startRef, endRef);
        }
        return target.slice(row.start ?? undefined, row.end ?? undefined);
      }
      if (typeof row.value === 'string') {
        const cell = this._parseExcelCellRef(row.value);
        if (cell) {
          const tableRow = target[cell.row];
          return this._pickColumnFromRow(tableRow, cell.col);
        }
      }
      return target[row.value] ?? NONE;
    }

    // t[,] -> whole table
    if (row.omitted && col.omitted) return target;

    // Build selected row set first.
    let selectedRows;
    if (row.omitted) {
      selectedRows = target.slice();
    } else if (row.isSlice) {
      selectedRows = target.slice(row.start ?? undefined, row.end ?? undefined);
    } else {
      selectedRows = [target[row.value] ?? NONE];
    }

    // Row-only access in 2D form: t[r,] or t[r1:r2,]
    if (col.omitted) {
      if (!row.omitted && !row.isSlice) return selectedRows[0] ?? NONE;
      return selectedRows;
    }

    // Column slices: t[,c1:c2], t[r,c1:c2], t[r1:r2,c1:c2]
    if (col.isSlice) {
      const cStart = this._normalizeTableColumnSelector(col.start, node);
      const cEnd = this._normalizeTableColumnSelector(col.end, node);
      const projected = selectedRows.map(r => this._sliceColumnsFromRow(r, cStart, cEnd));
      if (!row.omitted && !row.isSlice) return projected[0] ?? NONE;
      return projected;
    }

    // Single column projection: t[,c], t[r,c], t[r1:r2,c]
    const colSelector = this._normalizeTableColumnSelector(col.value, node);
    const projected = selectedRows.map(r => this._pickColumnFromRow(r, colSelector));
    if (!row.omitted && !row.isSlice) return projected[0] ?? NONE;
    return projected;
  }

  async _evalLazyDeclExpr(node) {
    if (!this.globals.has(node.name)) {
      this.globals.set(node.name, NONE);
    }
    return this.globals.get(node.name);
  }

  async _evalPostExpr(node, env) {
    return await this._executePost(node, env);
  }

  async _evalUnaryOpExpr(node, env) {
    const operand = await this.evalExpr(node.operand, env);
    if (node.op === 'not') return !isTruthy(operand);
    return operand;
  }

  // ── Binary operations ──────────────────────────────────────────────────────
  async evalBinOp(node, env) {
    // Lazy inference: if either side is a LazyDecl, infer default from the other side
    if (node.left?.type === 'LazyDecl' || node.right?.type === 'LazyDecl') {
      const lazyNode  = node.left?.type  === 'LazyDecl' ? node.left  : node.right;
      const otherNode = node.left?.type  === 'LazyDecl' ? node.right : node.left;
      if (!this.globals.has(lazyNode.name)) {
        const otherVal   = await this.evalExpr(otherNode, env);
        const defaultVal =
          typeof otherVal === 'number' && Number.isInteger(otherVal) ? 0
          : typeof otherVal === 'number'  ? 0.0
          : typeof otherVal === 'string'  ? ''
          : typeof otherVal === 'boolean' ? false
          : NONE;
        this.globals.set(lazyNode.name, defaultVal);
      }
    }

    // Short-circuit for logical operators
    if (node.op === 'and') {
      const l = await this.evalExpr(node.left, env);
      if (!isTruthy(l)) return false;
      return isTruthy(await this.evalExpr(node.right, env));
    }
    if (node.op === 'or') {
      const l = await this.evalExpr(node.left, env);
      if (isTruthy(l)) return true;
      return isTruthy(await this.evalExpr(node.right, env));
    }

    const left  = await this.evalExpr(node.left,  env);
    const right = await this.evalExpr(node.right, env);

    // Element-wise broadcasting: list op scalar, scalar op list, or list op list
    const ARITH = new Set(['+','-','*','/','//','%','^']);
    if (ARITH.has(node.op)) {
      const leftArr  = Array.isArray(left);
      const rightArr = Array.isArray(right);
      if (leftArr || rightArr) {
        const applyOp = (a, b) => {
          switch (node.op) {
            case '+':  return typeof a === 'string' ? String(a) + String(b) : a + b;
            case '-':  return a - b;
            case '*':  return a * b;
            case '/':  return b === 0 ? NONE : a / b;
            case '//': return b === 0 ? NONE : Math.trunc(a / b);
            case '%':  return a % b;
            case '^':  return Math.pow(a, b);
            default:   return NONE;
          }
        };
        if (leftArr && rightArr) {
          const len = Math.min(left.length, right.length);
          return Array.from({length: len}, (_, i) => {
            const a = left[i], b = right[i];
            // 2D: both elements are rows → recurse element-wise on the rows
            if (Array.isArray(a) && Array.isArray(b)) {
              const rowLen = Math.min(a.length, b.length);
              return Array.from({length: rowLen}, (_, j) => applyOp(a[j], b[j]));
            }
            if (Array.isArray(a)) return a.map(v => applyOp(v, b));
            if (Array.isArray(b)) return b.map(v => applyOp(a, v));
            return applyOp(a, b);
          });
        }
        if (leftArr)  return left.map(v => Array.isArray(v) ? v.map(c => applyOp(c, right)) : applyOp(v, right));
        if (rightArr) return right.map(v => Array.isArray(v) ? v.map(c => applyOp(left, c)) : applyOp(left, v));
      }
    }

    switch (node.op) {
      case '+':   return typeof left === 'string' ? String(left) + String(right) : left + right;
      case '-':   return left - right;
      case '*':   return left * right;
      case '/':   if (right === 0) throw new RuntimeError('Division by zero', node.line);
                  return left / right;
      case '//':  if (right === 0) throw new RuntimeError('Division by zero', node.line);
                  return Math.trunc(left / right);
      case '%':   return left % right;
      case '^':   return Math.pow(left, right);
      case '=':   return ivxEqual(left, right);
      case '!=':  return !ivxEqual(left, right);
      case '<':   return left < right;
      case '>':   return left > right;
      case '<=':  return left <= right;
      case '>=':  return left >= right;
      case 'is':  return ivxEqual(left, right);
      case 'in':  return ivxIn(left, right, node);
      case 'xor': return isTruthy(left) !== isTruthy(right);
      default:    throw new RuntimeError(`Unknown operator '${node.op}'`, node.line);
    }
  }

  // ── Function calls ─────────────────────────────────────────────────────────
  async evalCall(node, env) {
    const callee = env.get(node.name);

    // Evaluate arguments
    const args = [];
    for (const arg of node.args) args.push(await this.evalExpr(arg, env));

    if (!(callee instanceof IVXFunction) && !(callee instanceof IVXClass)) {
      throw new RuntimeError(`'${node.name}' is not callable`, node.line);
    }

    if (callee instanceof IVXClass) {
      try {
        return await callee.instantiate(args, this, node);
      } catch (e) {
        this.globals.set('err', e.message ?? String(e));
        return NONE;
      }
    }

    // Built-in: body is null, delegate to _callBuiltin
    if (callee.body === null) {
      try {
        return this._callBuiltin(node.name, args, node) ?? NONE;
      } catch (e) {
        this.globals.set('err', e.message ?? String(e));
        return NONE;
      }
    }

    // User-defined function
    const fnEnv = callee.closure.child();
    for (let i = 0; i < callee.params.length; i++) {
      const { name: pn, value: pv } = await resolveParam(callee.params[i], args[i], fnEnv, this);
      fnEnv.set(pn, pv);
    }

    try {
      const result = await this.execBlock(callee.body, fnEnv);
      if (result instanceof ReturnSignal) return result.value;
      return NONE;
    } catch (e) {
      // Propagate runtime errors but set err variable
      this.globals.set('err', e.message ?? String(e));
      return NONE;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isTruthy(v) {
  if (v === NONE)  return false;
  if (v === false) return false;
  return true;
}

function ivxEqual(a, b) {
  if (a === NONE && b === NONE) return true;
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) { if (!ivxEqual(b.get(k), v)) return false; }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => ivxEqual(v, b[i]));
  }
  return a === b;
}

function ivxIn(left, right, node) {
  if (Array.isArray(right))     return right.some(v => ivxEqual(v, left));
  if (right instanceof Map)     return right.has(left);
  if (typeof right === 'string') return String(right).includes(String(left));
  throw new RuntimeError(`'in' requires list, dict, or string`, node?.line);
}

// Convert an IVX value to an iterable of [primary, secondary] pairs
function toIterable(value, node) {
  if (Array.isArray(value)) {
    return value.map((v, i) => [v, i]);
  }
  if (value instanceof Map) {
    return [...value.entries()].map(([k, v]) => [k, v]);
  }
  if (typeof value === 'string') {
    return [...value].map((c, i) => [c, i]);
  }
  throw new RuntimeError(`Cannot iterate over ${typeof value}`, node?.line);
}

// Human-readable representation of an IVX value
function ivxRepr(value) {
  if (value === NONE)                return 'none';
  if (value === true)                return 'yes';
  if (value === false)               return 'no';
  if (value instanceof IVXFunction)  return `<fun ${value.name}>`;
  if (value instanceof IVXClass)     return `<class ${value.name}>`;
  if (value instanceof IVXSuperProxy) return '<super>';
  if (value instanceof Map) {
    const cls = value.get('__class__');
    if (cls) return `<${cls} instance>`;
    const entries = [...value.entries()].filter(([k]) => !String(k).startsWith('__'));
    if (entries.length === 0) return '{}';
    return '{' + entries.map(([k,v]) => `${ivxRepr(k)}: ${ivxRepr(v)}`).join(', ') + '}';
  }
  if (Array.isArray(value))          return '[' + value.map(ivxRepr).join(', ') + ']';
  if (value && typeof value === 'object') return '<object>';
  return String(value);
}

// ── Public API ────────────────────────────────────────────────────────────────
function interpret(source, options = {}) {
  const interp = new Interpreter(options);
  return interp.run(source, options);
}

async function runIVXSelfTests() {
  const results = [];
  const pass = (name, details = {}) => results.push({ name, ok: true, ...details });
  const fail = (name, details = {}) => results.push({ name, ok: false, ...details });

  try {
    const p = parse('make x 1\nsay x');
    if (p.errors.length === 0 && p.ast?.type === 'Program') {
      pass('parse-basic');
    } else {
      fail('parse-basic', { errors: p.errors });
    }
  } catch (e) {
    fail('parse-basic', { error: e.message ?? String(e) });
  }

  try {
    const tc = typecheck('say not_defined_var');
    if (tc.errors.length > 0) {
      pass('typecheck-undefined-var', { count: tc.errors.length });
    } else {
      fail('typecheck-undefined-var', { count: 0 });
    }
  } catch (e) {
    fail('typecheck-undefined-var', { error: e.message ?? String(e) });
  }

  try {
    const tc = typecheck('make t [["name","score"],["Ana",10],["Bo",11]]');
    if (tc.errors.length === 0) {
      pass('typecheck-table-header-exempt');
    } else {
      fail('typecheck-table-header-exempt', { errors: tc.errors.map(e => e.toString()) });
    }
  } catch (e) {
    fail('typecheck-table-header-exempt', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('class Dog\n  fun init(size, name)\n    make self.size size\n    make self.name name\nmake d Dog(3, "Rex")\nsay d.size\nsay d.name', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 2 && out[0] === 3 && out[1] === 'Rex') {
      pass('runtime-class-constructor');
    } else {
      fail('runtime-class-constructor', { output: out });
    }
  } catch (e) {
    fail('runtime-class-constructor', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('class Counter\n  fun init(value)\n    make self.value value\n  fun inc()\n    make self.value self.value + 1\n    give self.value\nmake c Counter(1)\nsay c.inc()\nsay c.inc()', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 2 && out[0] === 2 && out[1] === 3) {
      pass('runtime-class-methods');
    } else {
      fail('runtime-class-methods', { output: out });
    }
  } catch (e) {
    fail('runtime-class-methods', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('class Animal\n  fun init(name)\n    make self.name name\n  fun speak()\n    give self.name\nclass Dog(Animal)\n  fun init(name)\n    make self.name name\n  fun speak()\n    give super.speak() + "!"\nmake d Dog("Rex")\nsay d.speak()\nsay d.name', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 2 && out[0] === 'Rex!' && out[1] === 'Rex') {
      pass('runtime-class-inheritance');
    } else {
      fail('runtime-class-inheritance', { output: out });
    }
  } catch (e) {
    fail('runtime-class-inheritance', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('make x 2\nmake x + 3\nsay x', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 1 && out[0] === 5) {
      pass('runtime-arithmetic-output', { output: out[0] });
    } else {
      fail('runtime-arithmetic-output', { output: out });
    }
  } catch (e) {
    fail('runtime-arithmetic-output', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('make xs [1,2,3]\nsay length(xs)', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 1 && out[0] === 3) {
      pass('runtime-builtin-length', { output: out[0] });
    } else {
      fail('runtime-builtin-length', { output: out });
    }
  } catch (e) {
    fail('runtime-builtin-length', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('make t [["name","score"],["Ana",11],["Bo",22]]\nsay t[A0]\nsay t[B1]', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 2 && out[0] === 'name' && out[1] === 11) {
      pass('runtime-excel-cell-index', { output: out });
    } else {
      fail('runtime-excel-cell-index', { output: out });
    }
  } catch (e) {
    fail('runtime-excel-cell-index', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('make t [["c1","c2","c3"],[11,12,13],[21,22,23],[31,32,33]]\nsay t[A1:B2]\nsay t[2, "B"]', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    const okRange = out.length >= 1 && ivxEqual(out[0], [[11,12],[21,22]]);
    const okCell = out.length >= 2 && out[1] === 22;
    if (okRange && okCell) {
      pass('runtime-excel-range-index', { output: out });
    } else {
      fail('runtime-excel-range-index', { output: out });
    }
  } catch (e) {
    fail('runtime-excel-range-index', { error: e.message ?? String(e) });
  }

  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  const failed = total - passed;
  const summary = { total, passed, failed, results };
  if (typeof console !== 'undefined') {
    console.log('IVX self-test summary:', summary);
  }
  return summary;
}

if (typeof window !== 'undefined') {
  window.runIVXSelfTests = runIVXSelfTests;
}
