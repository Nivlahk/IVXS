// ── ivx_resolve.js ──────────────────────────────────────────────────────────
// Phase 1: Auto-Recognition & Web Import Engine.
//
// Turns an import specifier the user typed -- `pandas`, `lodash`,
// `github.com/foo/bar`, `https://.../mod.kh` -- into a ResolvedModule
// descriptor carrying a RUNTIME TAG, an INTEGRITY PIN, and an EVIDENCE
// CHAIN explaining how the runtime was decided. It does not execute
// anything; routing a tagged module to Pyodide / Go-WASM / the SEER
// simulator is Phase 4's job.
//
// ── Three things verified against the real network before writing this,
//    because each one contradicts the obvious design:
//
// 1. CROSS-ORIGIN `HEAD` DOES NOT WORK ON PyPI ARTIFACTS.
//    files.pythonhosted.org returns access-control-allow-origin on GET
//    and on the OPTIONS preflight, but NOT on HEAD. A browser
//    fetch(url, {method:'HEAD'}) is therefore blocked by CORS even though
//    the exact same URL fetches fine with GET. "HTTP header sniffing" as
//    a probe primitive is dead on arrival for the single most important
//    registry. What IS allowed is a RANGED GET: the preflight advertises
//    `access-control-allow-headers: Range` and exposes Content-Range /
//    Accept-Ranges. So the probe primitive here is a 512-byte ranged GET
//    plus magic-byte sniffing -- which is strictly better anyway, since
//    Content-Type on these CDNs is `binary/octet-stream` and tells you
//    nothing.
//
// 2. npm IS fully CORS-open, PyPI's JSON API is fully CORS-open.
//    registry.npmjs.org returns ACAO:* on both the metadata JSON and the
//    .tgz tarball. pypi.org/pypi/<name>/json returns ACAO:*. Both are
//    directly reachable from the page with no relay.
//
// 3. THE Go PATH IS UNVERIFIED AND ASSUMED BROKEN.
//    proxy.golang.org was not reachable from the environment this was
//    written in, so its CORS posture is UNKNOWN. It is treated as
//    requiring a relay until someone actually checks. `relay` is a
//    pluggable hook, not a hardcoded third-party proxy -- routing user
//    import paths through someone else's server is exactly the egress
//    this platform claims not to do, so that choice stays explicit.
//
// ── On "zero-egress": fetching a public package IS network traffic. The
//    honest claim is that USER CODE AND USER DATA never leave the device;
//    package acquisition is a read-only GET of a public artifact, pinned
//    by hash, cached so the second run is genuinely offline. This module
//    is written to keep that claim true: it never POSTs, never sends the
//    program source anywhere, and every outbound URL it will contact is
//    derivable from the specifier the user typed.
//
// Depends on: events.js (window.IVX.bus). No other dependencies.
'use strict';

// The module has to load outside a browser too -- run_tests.js exercises the
// pure functions (classification, sniffing, manifest parsing) in node, and a
// bare `window.IVX = ...` at module scope made that a ReferenceError. Bind a
// global root instead and let the browser path attach to the real window.
const GLOBAL = (typeof window !== 'undefined') ? window
             : (typeof globalThis !== 'undefined') ? globalThis : {};
GLOBAL.IVX = GLOBAL.IVX || {};

// ── Runtime tags. What Phase 4 dispatches on. ───────────────────────────────
const RUNTIME = Object.freeze({
  IVX: 'ivx',        // KH/IVX source -- runs in the existing interpreter, or
                     // lowers to SEER via Phase 2
  JS: 'js',          // plain JS/ESM -- runs in a worker or is bridged directly
  PYTHON: 'python',  // needs Pyodide
  GO: 'go',          // needs Go-WASM
  WASM: 'wasm',      // a bare .wasm module -- instantiate directly
  UNKNOWN: 'unknown' // detection failed. Reported, never guessed.
});

const KIND = Object.freeze({
  URL: 'url', NPM: 'npm', PYPI: 'pypi', GO: 'go',
  RELATIVE: 'relative', AMBIGUOUS: 'ambiguous',
});

const DEFAULTS = {
  npmRegistry: 'https://registry.npmjs.org',
  pypiJson: 'https://pypi.org/pypi',
  goProxy: 'https://proxy.golang.org',   // UNVERIFIED for CORS -- see header
  relay: null,          // (url) => url  -- caller-supplied, opt-in only
  probeBytes: 512,
  cacheName: 'ivx-modules-v1',
  pinPrefix: 'ivx_pin_',  // generalizes runtime.js's existing `kh_hash_` TOFU
};

// ────────────────────────────────────────────────────────────────────────────
// 1. SPECIFIER CLASSIFICATION
// ────────────────────────────────────────────────────────────────────────────
// Purely syntactic. Decides WHERE to look, never WHAT the thing is -- that
// is always settled by evidence from the bytes, not by the shape of the
// string. A bare `pandas` is deliberately AMBIGUOUS rather than assumed
// Python: `six`, `attrs`, `yaml`, `redis`, `ws` and plenty more exist on
// both registries, and picking by vibes is how you silently load the wrong
// language's package.
function classifySpecifier(spec) {
  const raw = String(spec).trim().replace(/^["']|["']$/g, '');

  if (/^https?:\/\//i.test(raw)) return { raw, kind: KIND.URL, url: raw };
  if (/^\.{1,2}\//.test(raw))    return { raw, kind: KIND.RELATIVE, path: raw };

  // Explicit registry prefixes always win -- this is the escape hatch for
  // the ambiguous-bare-name case below.
  let m;
  if ((m = /^(npm|pypi|go):(.+)$/i.exec(raw))) {
    const kind = { npm: KIND.NPM, pypi: KIND.PYPI, go: KIND.GO }[m[1].toLowerCase()];
    return { raw, kind, ...splitNameVersion(m[2]) };
  }

  // A Go module path is a domain-shaped prefix with at least one slash.
  // `github.com/foo/bar`, `golang.org/x/net`. Distinguished from an npm
  // scoped package by the leading '@' being absent and a dot in segment 0.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(raw)) {
    return { raw, kind: KIND.GO, ...splitNameVersion(raw) };
  }

  // Scoped npm is unambiguous -- nothing else uses @scope/name.
  if (raw.startsWith('@')) return { raw, kind: KIND.NPM, ...splitNameVersion(raw) };

  return { raw, kind: KIND.AMBIGUOUS, ...splitNameVersion(raw) };
}

function splitNameVersion(s) {
  // `lodash@4.17.21`, `pandas==2.0.0`, `github.com/foo/bar@v1.2.3`
  let m;
  if ((m = /^(@?[^@]+)@(.+)$/.exec(s)))  return { name: m[1], version: m[2] };
  if ((m = /^(.+?)(?:==|>=|~=)(.+)$/.exec(s))) return { name: m[1], version: m[2] };
  return { name: s, version: null };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. BYTE-LEVEL PROBE (replaces header sniffing -- see header note 1)
// ────────────────────────────────────────────────────────────────────────────
const MAGIC = [
  { runtimeHint: null,          fmt: 'zip',  bytes: [0x50, 0x4B, 0x03, 0x04] }, // .whl / .jar / .zip
  { runtimeHint: null,          fmt: 'gzip', bytes: [0x1F, 0x8B] },             // npm .tgz
  { runtimeHint: RUNTIME.WASM,  fmt: 'wasm', bytes: [0x00, 0x61, 0x73, 0x6D] }, // \0asm
];

function sniffBytes(u8) {
  for (const sig of MAGIC) {
    if (u8.length >= sig.bytes.length && sig.bytes.every((b, i) => u8[i] === b)) {
      return { fmt: sig.fmt, runtimeHint: sig.runtimeHint };
    }
  }
  // Text: decode leniently and let the AST-signature pass decide.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(0, 256)).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return { fmt: 'json', runtimeHint: null };
  // A '<' first byte from a package CDN is almost always an error page
  // served with 200, not real content. Naming it explicitly turns a
  // confusing downstream parse failure into a clear one.
  if (head.startsWith('<')) return { fmt: 'html', runtimeHint: null };
  return { fmt: 'text', runtimeHint: null };
}

// Ranged GET. Falls back to a full GET if the server ignores Range --
// some CDNs do, and a 200-with-everything is a correct response to a
// range request, not an error.
async function probeHead(url, n) {
  const res = await fetch(url, { headers: { Range: `bytes=0-${n - 1}` } });
  if (!res.ok && res.status !== 206) throw new Error(`probe ${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    bytes: buf.subarray(0, n),
    partial: res.status === 206,
    contentType: res.headers.get('content-type') || '',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. AST-SIGNATURE FALLBACK
// ────────────────────────────────────────────────────────────────────────────
// Only consulted when nothing authoritative was found: no registry hit, no
// manifest, no magic bytes. Deliberately scores rather than matches, and
// deliberately refuses on a weak margin. A wrong confident answer here
// means silently handing Python to a JS worker.
const SIGNATURES = [
  { runtime: RUNTIME.PYTHON, weight: 3, re: /^\s*(def|class)\s+\w+\s*\(.*\)\s*:\s*$/m },
  { runtime: RUNTIME.PYTHON, weight: 3, re: /^\s*from\s+[\w.]+\s+import\s+/m },
  { runtime: RUNTIME.PYTHON, weight: 2, re: /^\s*import\s+[\w.]+\s*$/m },
  { runtime: RUNTIME.PYTHON, weight: 2, re: /\bif\s+__name__\s*==\s*['"]__main__['"]/ },
  { runtime: RUNTIME.PYTHON, weight: 1, re: /\b(elif|None|True|False|self)\b/ },

  { runtime: RUNTIME.JS,     weight: 3, re: /^\s*(export\s+(default|const|function|class)|import\s+.*\s+from\s+['"])/m },
  { runtime: RUNTIME.JS,     weight: 3, re: /\bmodule\.exports\s*=/ },
  { runtime: RUNTIME.JS,     weight: 2, re: /\brequire\s*\(\s*['"]/ },
  { runtime: RUNTIME.JS,     weight: 2, re: /\b(const|let)\s+\w+\s*=.*=>/ },
  { runtime: RUNTIME.JS,     weight: 1, re: /[;{}]\s*$/m },

  { runtime: RUNTIME.GO,     weight: 4, re: /^\s*package\s+\w+\s*$/m },
  { runtime: RUNTIME.GO,     weight: 3, re: /\bfunc\s+\w+\s*\([^)]*\)\s*[\w*\[\]]*\s*\{/ },
  { runtime: RUNTIME.GO,     weight: 2, re: /:=/ },

  // KH/IVX. Anchored on the real keyword set from core.js, not guessed.
  { runtime: RUNTIME.IVX,    weight: 4, re: /^\s*make\s+\w+\s+/m },
  { runtime: RUNTIME.IVX,    weight: 3, re: /^\s*(fun|note|say|give|take)\s+/m },
  { runtime: RUNTIME.IVX,    weight: 3, re: /^\s*from\s+\S+\s+(by|use)\s+/m },
  { runtime: RUNTIME.IVX,    weight: 2, re: /^\s*(if|loop|for)\s+.+[^:]\s*$/m },
];

const SIG_MIN_SCORE  = 4;  // below this: no opinion at all
const SIG_MIN_MARGIN = 2;  // runner-up must be this far behind, or we refuse

function signatureDetect(text) {
  const scores = {};
  const hits = [];
  for (const s of SIGNATURES) {
    if (s.re.test(text)) {
      scores[s.runtime] = (scores[s.runtime] || 0) + s.weight;
      hits.push({ runtime: s.runtime, weight: s.weight, pattern: String(s.re) });
    }
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { runtime: RUNTIME.UNKNOWN, reason: 'no signature matched', hits };
  const [top, topScore] = ranked[0];
  const runnerUp = ranked[1] ? ranked[1][1] : 0;
  if (topScore < SIG_MIN_SCORE) {
    return { runtime: RUNTIME.UNKNOWN, reason: `top score ${topScore} below floor ${SIG_MIN_SCORE}`, hits };
  }
  if (topScore - runnerUp < SIG_MIN_MARGIN) {
    return { runtime: RUNTIME.UNKNOWN,
             reason: `ambiguous: ${ranked.map(([r, v]) => `${r}=${v}`).join(', ')}`, hits };
  }
  return { runtime: top, score: topScore, margin: topScore - runnerUp, hits };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. ARCHIVE READERS
// ────────────────────────────────────────────────────────────────────────────
// Both use DecompressionStream, which is native in current Chrome/Firefox/
// Safari -- 'gzip' is broadly available, 'deflate-raw' is newer. Neither is
// polyfilled here; an unsupported browser gets a clear error rather than a
// silent wrong result.
async function inflateGzip(u8) {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable (gzip)');
  const ds = new DecompressionStream('gzip');
  const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

async function inflateRaw(u8) {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable (deflate-raw)');
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

// Minimal tar reader: regular files only, plus GNU long-name ('L') records,
// which npm tarballs do produce for deep paths. Every other typeflag is
// skipped rather than misread as a file.
function untar(u8) {
  const files = new Map();
  const dec = new TextDecoder();
  let off = 0, pendingLongName = null;
  while (off + 512 <= u8.length) {
    const header = u8.subarray(off, off + 512);
    if (header.every(b => b === 0)) break;                 // end-of-archive block
    let name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const sizeOct = dec.decode(header.subarray(124, 136)).replace(/[\0 ]/g, '');
    const size = parseInt(sizeOct, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const prefix = dec.decode(header.subarray(345, 500)).replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;
    const dataStart = off + 512;
    const padded = Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {
      pendingLongName = dec.decode(u8.subarray(dataStart, dataStart + size)).replace(/\0.*$/, '');
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const finalName = pendingLongName || name;
      pendingLongName = null;
      files.set(finalName, u8.subarray(dataStart, dataStart + size));
    } else {
      pendingLongName = null;                              // dirs, links, pax headers
    }
    off = dataStart + padded;
  }
  return files;
}

// Minimal ZIP reader over the central directory. Used for wheels (.whl).
// Extracts one named entry at a time rather than expanding the archive --
// a wheel's METADATA is a few KB inside what can be a 40MB file.
function u16(v, o) { return v[o] | (v[o + 1] << 8); }
function u32(v, o) { return (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0; }

function zipCentralDirectory(u8) {
  // Scan backwards for the End Of Central Directory signature. The comment
  // field is <=64KB, so the EOCD is within the last 64KB+22 bytes.
  const scanFrom = Math.max(0, u8.length - (0xFFFF + 22));
  let eocd = -1;
  for (let i = u8.length - 22; i >= scanFrom; i--) {
    if (u32(u8, i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = u16(u8, eocd + 10);
  let p = u32(u8, eocd + 16);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let i = 0; i < count && p + 46 <= u8.length; i++) {
    if (u32(u8, p) !== 0x02014B50) break;
    const method  = u16(u8, p + 10);
    const compSz  = u32(u8, p + 20);
    const nameLen = u16(u8, p + 28);
    const extraLen = u16(u8, p + 30);
    const cmtLen  = u16(u8, p + 32);
    const localOff = u32(u8, p + 42);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSz, localOff });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

async function zipExtract(u8, entry) {
  const lo = entry.localOff;
  if (u32(u8, lo) !== 0x04034B50) throw new Error('zip: bad local file header');
  const nameLen = u16(u8, lo + 26), extraLen = u16(u8, lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const raw = u8.subarray(dataStart, dataStart + entry.compSz);
  if (entry.method === 0) return raw;             // stored
  if (entry.method === 8) return inflateRaw(raw); // deflate
  throw new Error(`zip: unsupported compression method ${entry.method}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 5. MANIFEST PARSERS
// ────────────────────────────────────────────────────────────────────────────
// package.json is real JSON. go.mod is line-structured. pyproject.toml is
// TOML, and this is NOT a TOML parser -- it is a deliberate subset that
// reads top-level tables, string values, and inline/multiline string
// arrays, which is all `[project]` and `[build-system]` need. Anything it
// cannot represent is left out of the result rather than approximated.
function parseGoMod(text) {
  const out = { module: null, go: null, requires: [] };
  let inRequireBlock = false;
  for (const line of text.split('\n')) {
    const t = line.replace(/\/\/.*$/, '').trim();
    if (!t) continue;
    if (t === 'require (') { inRequireBlock = true; continue; }
    if (inRequireBlock && t === ')') { inRequireBlock = false; continue; }
    if (inRequireBlock) {
      const [path, version] = t.split(/\s+/);
      if (path) out.requires.push({ path, version: version || null });
      continue;
    }
    let m;
    if ((m = /^module\s+(\S+)/.exec(t))) out.module = m[1];
    else if ((m = /^go\s+(\S+)/.exec(t))) out.go = m[1];
    else if ((m = /^require\s+(\S+)\s+(\S+)/.exec(t))) out.requires.push({ path: m[1], version: m[2] });
  }
  return out;
}

function parseTomlSubset(text) {
  const root = {};
  let table = root;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    let m;
    if ((m = /^\[([^\]]+)\]$/.exec(line))) {
      table = m[1].split('.').reduce((acc, k) => (acc[k] = acc[k] || {}), root);
      continue;
    }
    if ((m = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line))) {
      const key = m[1];
      let rhs = m[2];
      if (rhs.startsWith('[') && !rhs.includes(']')) {          // multiline array
        while (i + 1 < lines.length && !rhs.includes(']')) {
          rhs += ' ' + lines[++i].replace(/(^|\s)#.*$/, '').trim();
        }
      }
      table[key] = parseTomlValue(rhs);
    }
  }
  return root;
}

function parseTomlValue(rhs) {
  rhs = rhs.trim();
  if (rhs.startsWith('[')) {
    const inner = rhs.slice(1, rhs.lastIndexOf(']'));
    return inner.split(',').map(s => s.trim()).filter(Boolean)
                .map(s => s.replace(/^["']|["']$/g, ''));
  }
  if (/^["']/.test(rhs)) return rhs.replace(/^["']|["']$/g, '');
  if (/^(true|false)$/.test(rhs)) return rhs === 'true';
  if (/^-?\d+(\.\d+)?$/.test(rhs)) return Number(rhs);
  return rhs;
}

// Wheel METADATA is RFC822-ish key: value with repeated keys.
function parseWheelMetadata(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1], v = m[2].trim();
    if (out[k] === undefined) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 6. INTEGRITY / TOFU PINNING
// ────────────────────────────────────────────────────────────────────────────
// Generalizes the TOFU scheme already live in runtime.js's Import handler
// (`kh_hash_<url>` in localStorage). Two changes: it pins by SPECIFIER +
// RESOLVED VERSION rather than by URL, so a redirect or CDN change doesn't
// read as tampering; and where the registry publishes its own digest --
// npm's `dist.integrity`, PyPI's `digests.sha256` -- that digest is
// checked FIRST, so first use is verified rather than merely trusted.
async function sha256Hex(u8) {
  const buf = await crypto.subtle.digest('SHA-256', u8);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function pinKey(prefix, specifier, version) {
  return `${prefix}${specifier}@${version || 'unpinned'}`;
}

// Returns {status: 'verified'|'pinned'|'matched', ...} or throws on mismatch.
// Throwing is the point: a changed artifact under the same version is either
// a registry compromise or a mutable-tag mistake, and neither should load.
async function verifyAndPin(opts, specifier, version, bytes, publishedSha256) {
  const actual = await sha256Hex(bytes);
  if (publishedSha256 && publishedSha256.toLowerCase() !== actual) {
    throw new Error(`integrity mismatch for ${specifier}@${version}: registry published `
      + `${publishedSha256.slice(0, 16)}..., downloaded artifact hashes ${actual.slice(0, 16)}...`);
  }
  const key = pinKey(opts.pinPrefix, specifier, version);
  let stored = null;
  try { stored = localStorage.getItem(key); } catch (_) { /* storage disabled; skip TOFU */ }
  if (stored === null) {
    try { localStorage.setItem(key, actual); } catch (_) {}
    return { sha256: actual, status: publishedSha256 ? 'verified' : 'pinned' };
  }
  if (stored !== actual) {
    throw new Error(`SECURITY: ${specifier}@${version} changed since first use `
      + `(pinned ${stored.slice(0, 16)}..., now ${actual.slice(0, 16)}...). `
      + `Use a versioned specifier, or clear the pin to accept the change.`);
  }
  return { sha256: actual, status: 'matched' };
}

// ────────────────────────────────────────────────────────────────────────────
// 7. THE RESOLVER
// ────────────────────────────────────────────────────────────────────────────
class IVXResolver {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.memo = new Map();   // specifier -> Promise<ResolvedModule>
  }

  _emit(event, payload) {
    if (GLOBAL.IVX && GLOBAL.IVX.bus) GLOBAL.IVX.bus.emit(event, payload);
  }

  // Single public entry point. Memoized per specifier so a program with
  // ten `from pandas ...` lines does one resolution, not ten.
  resolve(specifier) {
    const key = String(specifier).trim();
    if (!this.memo.has(key)) {
      this.memo.set(key, this._resolve(key).catch(err => {
        this.memo.delete(key);   // don't cache failures -- transient network
        throw err;
      }));
    }
    return this.memo.get(key);
  }

  async _resolve(specifier) {
    const cls = classifySpecifier(specifier);
    const evidence = [{ step: 'classify', kind: cls.kind, name: cls.name, version: cls.version }];
    this._emit('resolve:start', { specifier, kind: cls.kind });

    const cached = await this._cacheGet(specifier);
    if (cached) {
      this._emit('resolve:cached', { specifier, runtime: cached.runtime });
      return cached;
    }

    let mod;
    switch (cls.kind) {
      case KIND.URL:        mod = await this._resolveUrl(cls, evidence); break;
      case KIND.RELATIVE:   mod = await this._resolveUrl({ ...cls, url: cls.path }, evidence); break;
      case KIND.NPM:        mod = await this._resolveNpm(cls, evidence); break;
      case KIND.PYPI:       mod = await this._resolvePypi(cls, evidence); break;
      case KIND.GO:         mod = await this._resolveGo(cls, evidence); break;
      case KIND.AMBIGUOUS:  mod = await this._resolveAmbiguous(cls, evidence); break;
      default: throw new Error(`unhandled specifier kind: ${cls.kind}`);
    }

    mod.specifier = specifier;
    mod.evidence = evidence;
    await this._cachePut(specifier, mod);
    this._emit('resolve:done', { specifier, runtime: mod.runtime, version: mod.version });
    return mod;
  }

  // ── Ambiguous bare name: ask both CORS-open registries in parallel.
  // If both answer, that is a REAL COLLISION and the user is asked to
  // disambiguate rather than being handed whichever one replied first.
  async _resolveAmbiguous(cls, evidence) {
    const [npm, pypi] = await Promise.all([
      this._npmMeta(cls.name).catch(e => ({ __err: e.message })),
      this._pypiMeta(cls.name).catch(e => ({ __err: e.message })),
    ]);
    const npmOk = npm && !npm.__err;
    const pypiOk = pypi && !pypi.__err;
    evidence.push({ step: 'registry-probe', npm: npmOk ? 'hit' : 'miss', pypi: pypiOk ? 'hit' : 'miss' });

    if (npmOk && pypiOk) {
      const err = new Error(`'${cls.name}' exists on BOTH npm and PyPI. Disambiguate the import: `
        + `npm:${cls.name} or pypi:${cls.name}.`);
      err.ambiguous = { specifier: cls.raw, candidates: ['npm', 'pypi'] };
      throw err;
    }
    if (npmOk)  return this._resolveNpm({ ...cls, kind: KIND.NPM }, evidence, npm);
    if (pypiOk) return this._resolvePypi({ ...cls, kind: KIND.PYPI }, evidence, pypi);
    throw new Error(`'${cls.name}' not found on npm or PyPI `
      + `(npm: ${npm.__err}; pypi: ${pypi.__err})`);
  }

  // ── npm ──────────────────────────────────────────────────────────────────
  async _npmMeta(name) {
    const url = `${this.opts.npmRegistry}/${name.replace('/', '%2F')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`);
    return res.json();
  }

  async _resolveNpm(cls, evidence, meta) {
    meta = meta || await this._npmMeta(cls.name);
    const version = cls.version && meta.versions[cls.version]
      ? cls.version
      : meta['dist-tags'] && meta['dist-tags'].latest;
    const v = meta.versions[version];
    if (!v) throw new Error(`npm: no version ${cls.version || 'latest'} for ${cls.name}`);
    evidence.push({ step: 'npm-metadata', version, tarball: v.dist.tarball, integrity: v.dist.integrity || null });

    const tgz = new Uint8Array(await (await fetch(v.dist.tarball)).arrayBuffer());
    const integrity = await verifyAndPin(this.opts, `npm:${cls.name}`, version, tgz,
      v.dist.shasum && v.dist.shasum.length === 64 ? v.dist.shasum : null);
    evidence.push({ step: 'integrity', ...integrity });

    const files = untar(await inflateGzip(tgz));
    // npm tarballs are rooted at 'package/'.
    const strip = new Map();
    for (const [p, b] of files) strip.set(p.replace(/^package\//, ''), b);

    const pkgRaw = strip.get('package.json');
    const manifest = pkgRaw ? JSON.parse(new TextDecoder().decode(pkgRaw)) : null;
    evidence.push({ step: 'manifest', found: !!manifest, kind: 'package.json' });

    // Real detail worth surfacing rather than discovering at runtime: a
    // package with `gypfile`/binding.gyp needs a native toolchain and has
    // no browser story at all.
    const native = !!(manifest && (manifest.gypfile || strip.has('binding.gyp')));
    const entry = manifest ? (manifest.module || manifest.main || 'index.js') : 'index.js';

    return {
      kind: KIND.NPM, runtime: RUNTIME.JS, name: cls.name, version,
      resolvedUrl: v.dist.tarball, integrity, manifest, files: strip, entry,
      native, needsWorker: !native,
      notes: native ? ['package declares a native (node-gyp) build; no browser path'] : [],
    };
  }

  // ── PyPI ─────────────────────────────────────────────────────────────────
  async _pypiMeta(name) {
    const res = await fetch(`${this.opts.pypiJson}/${encodeURIComponent(name)}/json`);
    if (!res.ok) throw new Error(`PyPI HTTP ${res.status}`);
    return res.json();
  }

  async _resolvePypi(cls, evidence, meta) {
    meta = meta || await this._pypiMeta(cls.name);
    const version = cls.version && meta.releases[cls.version] ? cls.version : meta.info.version;
    const urls = (meta.releases[version] || []).filter(u => u.packagetype === 'bdist_wheel');
    if (!urls.length) throw new Error(`PyPI: ${cls.name}==${version} publishes no wheel (sdist only) -- `
      + `it would need a build step, which has no browser path`);

    // Pure-Python wheels (`py3-none-any`) work under Pyodide unconditionally.
    // Anything else carries compiled extensions built for a specific
    // platform ABI and will NOT load in Pyodide unless Pyodide itself ships
    // a build of it. Flagged, not silently attempted.
    const pure = urls.find(u => /-py3-none-any\.whl$/.test(u.filename) || /-py2\.py3-none-any\.whl$/.test(u.filename));
    const chosen = pure || urls[0];
    const isPure = !!pure;
    evidence.push({ step: 'pypi-metadata', version, wheel: chosen.filename, pure: isPure });

    // Byte-probe before committing to a full download -- confirms the CDN
    // is actually serving a ZIP and not an error page (see header note 1;
    // this is the ranged GET that replaces the impossible HEAD).
    const probe = await probeHead(chosen.url, this.opts.probeBytes);
    const sniff = sniffBytes(probe.bytes);
    evidence.push({ step: 'byte-probe', fmt: sniff.fmt, partial: probe.partial, contentType: probe.contentType });
    if (sniff.fmt !== 'zip') throw new Error(`PyPI artifact for ${cls.name} is not a zip archive `
      + `(sniffed '${sniff.fmt}') -- refusing rather than guessing`);

    const whl = new Uint8Array(await (await fetch(chosen.url)).arrayBuffer());
    const integrity = await verifyAndPin(this.opts, `pypi:${cls.name}`, version, whl,
      chosen.digests && chosen.digests.sha256);
    evidence.push({ step: 'integrity', ...integrity });

    // Read METADATA out of the wheel without expanding it.
    const cd = zipCentralDirectory(whl);
    let manifest = null;
    for (const [entryName, e] of cd) {
      if (/\.dist-info\/METADATA$/.test(entryName)) {
        manifest = parseWheelMetadata(new TextDecoder().decode(await zipExtract(whl, e)));
        evidence.push({ step: 'manifest', found: true, kind: 'wheel METADATA', entry: entryName });
        break;
      }
    }
    if (!manifest) evidence.push({ step: 'manifest', found: false, kind: 'wheel METADATA' });

    return {
      kind: KIND.PYPI, runtime: RUNTIME.PYTHON, name: cls.name, version,
      resolvedUrl: chosen.url, integrity, manifest,
      files: null,          // handed to micropip as a blob in Phase 4, not expanded here
      archive: whl, entry: cls.name.replace(/-/g, '_'),
      native: !isPure, needsWorker: true,
      notes: isPure ? [] : [`wheel '${chosen.filename}' is platform-specific (compiled extensions); `
        + `Pyodide can only load it if Pyodide itself ships a build`],
    };
  }

  // ── Go ───────────────────────────────────────────────────────────────────
  // proxy.golang.org's CORS posture is UNVERIFIED (see header note 3). This
  // path fails loudly with an actionable message unless a relay is
  // configured, rather than producing a mystery CORS error in the console.
  async _resolveGo(cls, evidence) {
    const via = this.opts.relay;
    const base = `${this.opts.goProxy}/${cls.name.toLowerCase()}/@v`;
    const listUrl = via ? via(`${base}/list`) : `${base}/list`;
    let version = cls.version;
    try {
      if (!version) {
        const res = await fetch(listUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const versions = (await res.text()).trim().split('\n').filter(Boolean);
        version = versions.sort().pop();
      }
    } catch (e) {
      throw new Error(`Go module resolution failed for ${cls.name}: ${e.message}. `
        + `proxy.golang.org is not confirmed CORS-accessible from a browser; configure `
        + `resolver.opts.relay to route this, or vendor the module.`);
    }
    const modUrl = via ? via(`${base}/${version}.mod`) : `${base}/${version}.mod`;
    const modText = await (await fetch(modUrl)).text();
    const manifest = parseGoMod(modText);
    evidence.push({ step: 'manifest', found: true, kind: 'go.mod', module: manifest.module, go: manifest.go });

    return {
      kind: KIND.GO, runtime: RUNTIME.GO, name: cls.name, version,
      resolvedUrl: modUrl, integrity: null, manifest, files: null, entry: null,
      native: true,        // Go source is not runnable without a Go-WASM toolchain
      needsWorker: true,
      notes: ['Go source requires compilation; Phase 4 must supply a Go-WASM toolchain '
        + 'or a prebuilt .wasm artifact. This resolver only establishes identity and deps.'],
    };
  }

  // ── Direct URL ───────────────────────────────────────────────────────────
  // The one case where the AST-signature fallback genuinely earns its keep:
  // there is no registry and often no manifest, just bytes.
  async _resolveUrl(cls, evidence) {
    const url = cls.url;
    if (/^http:/i.test(url)) throw new Error('Insecure protocol: HTTPS is mandatory for IVX modules.');
    const probe = await probeHead(url, this.opts.probeBytes);
    const sniff = sniffBytes(probe.bytes);
    evidence.push({ step: 'byte-probe', fmt: sniff.fmt, contentType: probe.contentType });

    if (sniff.fmt === 'html') throw new Error(`${url} returned HTML, not a module `
      + `-- likely a 404 or login page served with status 200`);

    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const integrity = await verifyAndPin(this.opts, url, null, bytes, null);
    evidence.push({ step: 'integrity', ...integrity });

    if (sniff.runtimeHint === RUNTIME.WASM) {
      return { kind: KIND.URL, runtime: RUNTIME.WASM, name: url, version: null,
               resolvedUrl: url, integrity, manifest: null, files: null,
               archive: bytes, entry: null, native: false, needsWorker: true, notes: [] };
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // Extension is a hint, not authority -- checked, then corroborated.
    const extHint = /\.(mjs|cjs|js)(\?|$)/i.test(url) ? RUNTIME.JS
                  : /\.py(\?|$)/i.test(url) ? RUNTIME.PYTHON
                  : /\.(kh|ivx)(\?|$)/i.test(url) ? RUNTIME.IVX
                  : /\.go(\?|$)/i.test(url) ? RUNTIME.GO : null;
    const sig = signatureDetect(text);
    evidence.push({ step: 'ast-signature', runtime: sig.runtime, score: sig.score,
                    margin: sig.margin, reason: sig.reason, hitCount: sig.hits.length });

    let runtime = sig.runtime;
    const notes = [];
    if (extHint && sig.runtime === RUNTIME.UNKNOWN) {
      runtime = extHint;
      notes.push(`content signature was inconclusive (${sig.reason}); fell back to the '${extHint}' file extension`);
    } else if (extHint && sig.runtime !== extHint) {
      // Do not silently prefer one. This is a genuine conflict and the
      // user should see it.
      notes.push(`CONFLICT: extension suggests '${extHint}' but content signature says `
        + `'${sig.runtime}' (score ${sig.score}, margin ${sig.margin}). Using the content signature.`);
    }
    if (runtime === RUNTIME.UNKNOWN) {
      throw new Error(`could not determine the runtime for ${url}: ${sig.reason}. `
        + `Disambiguate with an explicit prefix or a recognized file extension.`);
    }

    return { kind: KIND.URL, runtime, name: url, version: null, resolvedUrl: url,
             integrity, manifest: null, files: new Map([['<entry>', bytes]]),
             entry: '<entry>', source: text, native: false,
             needsWorker: runtime !== RUNTIME.IVX, notes };
  }

  // ── Cache: Cache API, keyed by specifier. This is what makes the second
  // run genuinely offline, which is what makes the zero-egress claim more
  // than a slogan. Binary payloads are stored separately from the JSON
  // descriptor so a large wheel isn't base64-inflated into a string.
  async _cacheGet(specifier) {
    if (typeof caches === 'undefined') return null;
    try {
      const c = await caches.open(this.opts.cacheName);
      const res = await c.match(new Request(`https://ivx.local/mod/${encodeURIComponent(specifier)}`));
      if (!res) return null;
      const rec = await res.json();
      if (rec.filesEncoded) {
        rec.files = new Map(rec.filesEncoded.map(([k, v]) => [k, Uint8Array.from(atob(v), ch => ch.charCodeAt(0))]));
        delete rec.filesEncoded;
      }
      return rec;
    } catch (_) { return null; }
  }

  async _cachePut(specifier, mod) {
    if (typeof caches === 'undefined') return;
    try {
      const c = await caches.open(this.opts.cacheName);
      const rec = { ...mod };
      delete rec.archive;   // too large to round-trip through JSON; re-fetched on demand
      if (rec.files instanceof Map) {
        rec.filesEncoded = [...rec.files].map(([k, v]) =>
          [k, btoa(String.fromCharCode(...v))]);
        delete rec.files;
      }
      await c.put(new Request(`https://ivx.local/mod/${encodeURIComponent(specifier)}`),
                  new Response(JSON.stringify(rec), { headers: { 'content-type': 'application/json' } }));
    } catch (_) { /* cache is an optimization, never load-bearing */ }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 8. THE HOOK INTO THE EXISTING GRAMMAR
// ────────────────────────────────────────────────────────────────────────────
// core.js ALREADY parses `from <module> by <package>` into
// Node('Import', {path, via}) -- and runtime.js's Import case begins with
// `if (!node.url) break;`, so today that form parses cleanly and then does
// absolutely nothing. No grammar change is needed for Phase 1; the entry
// point exists and is a silent no-op. This is the shim that fills it.
//
//   from Frames by pandas      -> resolve('pandas'),  bind local name 'Frames'
//   from Util by npm:lodash    -> resolve('npm:lodash')
//   from "https://x/y.kh" use a, b   -> existing URL path, unchanged
//
// Deliberately NOT patched in automatically on load: replacing a method on
// a live interpreter behind the user's back is the kind of thing that makes
// a bug take three hours to find. Call it explicitly from ivx.js init.
function installImportResolver(InterpreterClass, resolver) {
  if (!InterpreterClass || !InterpreterClass.prototype) throw new Error('installImportResolver: bad Interpreter class');
  InterpreterClass.prototype.resolveForeignImport = async function (node, env) {
    if (!node.via) return false;                 // not a foreign import; caller falls through
    const mod = await resolver.resolve(node.via);
    const localName = node.path || mod.name;
    env.set(localName, {
      __ivxForeignModule: true,
      runtime: mod.runtime, name: mod.name, version: mod.version,
      needsWorker: mod.needsWorker, native: mod.native,
      // Phase 4 replaces this stub with a live worker proxy. Until then it
      // fails with a specific message instead of `undefined is not a function`.
      __invoke: () => { throw new Error(`'${localName}' resolved to a ${mod.runtime} module `
        + `(${mod.name}@${mod.version}) but no ${mod.runtime} worker is running yet (Phase 4).`); },
    });
    return true;
  };
}

GLOBAL.IVX.RUNTIME = RUNTIME;
GLOBAL.IVX.KIND = KIND;
GLOBAL.IVX.Resolver = IVXResolver;
GLOBAL.IVX.resolver = new IVXResolver();
GLOBAL.IVX.installImportResolver = installImportResolver;
GLOBAL.IVX.__resolveInternals = {   // exported for tests, not for callers
  classifySpecifier, sniffBytes, signatureDetect, untar, parseGoMod,
  parseTomlSubset, parseWheelMetadata, zipCentralDirectory,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IVXResolver, RUNTIME, KIND, classifySpecifier, sniffBytes,
                     signatureDetect, untar, parseGoMod, parseTomlSubset,
                     parseWheelMetadata, zipCentralDirectory, zipExtract,
                     inflateGzip, inflateRaw, sha256Hex, installImportResolver };
}
