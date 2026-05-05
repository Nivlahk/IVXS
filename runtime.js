// kh-runtime-patch.js — Credentials-Aware HTTP for the KH Runtime
//
// Must be loaded AFTER runtime.js.
// Patches Interpreter._executePost and adds Interpreter._executeGet so that:
//
//   from "https://api.example.com" use cred "my-server"
//   make users get "/users"
//   make result post "/orders" {item: "widget", qty: 3}
//
// Works by:
//   1. When the interpreter encounters `use cred "name"`, it stores the
//      credential name (not the secret) in globals.__credName__
//      and the base URL (from the credential store) in globals.__credBase__
//   2. On get/post, if a URL is relative (starts with /) it is prefixed
//      with __credBase__. The auth header is injected from IVX.credentials.
//
// Also patches execStmt to handle 'UseCred' and 'Get' AST nodes produced
// by the parser (which already emits `get` as a keyword).
//
// Licensed under the Apache License, Version 2.0
// Copyright 2026 KH

'use strict';

(function patchKHRuntime() {
  if (typeof Interpreter === 'undefined') {
    console.error('[KH runtime-patch] Interpreter not found — make sure runtime.js loads first.');
    return;
  }
  if (typeof window.IVX?.credentials === 'undefined') {
    console.error('[KH runtime-patch] IVX.credentials not found — make sure credentials.js loads first.');
    return;
  }

  const creds = window.IVX.credentials;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // Resolve a URL: if relative, prepend the stored base URL for this cred
  function resolveUrl(rawUrl, baseUrl) {
    rawUrl = String(rawUrl ?? '').trim();
    if (!rawUrl) return rawUrl;
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) return rawUrl;
    if (baseUrl) {
      const base = String(baseUrl).replace(/\/$/, '');
      const path = rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl;
      return base + path;
    }
    return rawUrl;
  }

  // Build fetch headers for a named credential (or a raw token string)
  function buildHeaders(credName, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (!credName) return headers;

    // credName may be a named credential in the store, or a raw token value
    const stored = creds.get(credName);
    if (stored) {
      const auth = creds.authHeader(credName);
      if (auth) headers[auth.key] = auth.value;
    } else if (credName) {
      // Fall back: treat as raw bearer token (backwards-compatible with existing `use key ...`)
      headers['Authorization'] = `Bearer ${credName}`;
    }
    return headers;
  }

  // Convert a JS response to an IVX value (dict or list for JSON, string otherwise)
  async function responseToIVX(res) {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const json = await res.json();
      return jsToIVX(json);
    }
    return await res.text();
  }

  // Recursively convert a plain JS value to KH runtime types
  function jsToIVX(val) {
    if (val === null || val === undefined) return null;
    if (Array.isArray(val)) return val.map(jsToIVX);
    if (typeof val === 'object') {
      const map = new Map();
      for (const [k, v] of Object.entries(val)) map.set(k, jsToIVX(v));
      return map;
    }
    return val;
  }

  // ── Patch _executePost ────────────────────────────────────────────────────────
  // The original only supports bearer via __credential__ (a raw token).
  // We extend it to also check __credName__ (a credential store entry) and
  // use the base URL from the store for relative paths.

  const _origPost = IVXRuntime.prototype._executePost;
  IVXRuntime.prototype._executePost = async function (node, env, opts = {}) {
    const credName = this._interp.globals.get('__credName__') ?? null;
    const baseUrl  = this._interp.globals.get('__credBase__') ?? null;

    // If no named cred is active, fall through to original behaviour
    if (!credName) return _origPost.call(this, node, env, opts);

    const rawUrl  = await this._interp.evalExpr(node.url, env);
    const rawBody = await this._interp.evalExpr(node.body, env);
    const url     = resolveUrl(rawUrl, baseUrl);
    const headers = buildHeaders(credName);

    let bodyStr;
    if (rawBody instanceof Map) {
      const plain = {};
      for (const [k, v] of rawBody) plain[String(k)] = v instanceof Map ? Object.fromEntries(v) : v;
      bodyStr = JSON.stringify(plain);
    } else if (typeof rawBody === 'string') {
      bodyStr = rawBody;
    } else {
      bodyStr = JSON.stringify(rawBody);
    }

    try {
      const res = await fetch(url, { method: 'POST', headers, body: bodyStr });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new RuntimeError(`post ${url} → ${res.status}: ${errText}`, node.line);
      }
      const result = await responseToIVX(res);
      if (opts.storeResponse !== false) this._interp.globals.set('response', result);
      return result;
    } catch (e) {
      if (e instanceof RuntimeError) throw e;
      throw new RuntimeError(`post failed: ${e.message}`, node.line);
    }
  };

  // ── Add _executeGet ───────────────────────────────────────────────────────────
  IVXRuntime.prototype._executeGet = async function (node, env) {
    const credName = this._interp.globals.get('__credName__') ?? null;
    const baseUrl  = this._interp.globals.get('__credBase__') ?? null;
    const rawUrl   = await this._interp.evalExpr(node.url, env);
    const url      = resolveUrl(rawUrl, baseUrl);
    const headers  = buildHeaders(credName);

    // Optional query params: get "/users" {active: yes}
    let fullUrl = url;
    if (node.params) {
      const params = await this._interp.evalExpr(node.params, env);
      if (params instanceof Map && params.size > 0) {
        const qs = new URLSearchParams();
        for (const [k, v] of params) {
          qs.set(String(k), v === true ? 'true' : v === false ? 'false' : String(v));
        }
        fullUrl += (url.includes('?') ? '&' : '?') + qs.toString();
      }
    }

    try {
      const res = await fetch(fullUrl, { method: 'GET', headers });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new RuntimeError(`get ${fullUrl} → ${res.status}: ${errText}`, node.line);
      }
      return await responseToIVX(res);
    } catch (e) {
      if (e instanceof RuntimeError) throw e;
      throw new RuntimeError(`get failed: ${e.message}`, node.line);
    }
  };

  // Expose on Interpreter too (it delegates to runtime)
  Interpreter.prototype._executeGet = async function (node, env) {
    return this.runtime._executeGet(node, env);
  };

  // ── Patch execStmt to handle new node types ───────────────────────────────────
  // The KH parser already tokenises 'get' and 'use cred' — we intercept them
  // in the statement executor. We do this by wrapping execStmt.

  const _origExecStmt = Interpreter.prototype.execStmt;
  Interpreter.prototype.execStmt = async function (node, env) {

    // use cred "my-server"  →  UseCred node from parser
    if (node.type === 'UseCred') {
      const name = await this.evalExpr(node.name, env);
      const stored = creds.get(String(name));
      if (!stored) {
        throw new RuntimeError(
          `Credential "${name}" not found — add it in the 🔑 Credentials panel`,
          node.line
        );
      }
      this.globals.set('__credName__', String(name));
      this.globals.set('__credBase__', stored.baseUrl ?? null);
      // Also set legacy __credential__ for compatibility with existing ask/post
      this.globals.set('__credential__', stored.value);
      return;
    }

    // make result get "/users"  →  handled in evalExpr via Get expr node
    // Standalone: get "/users"  →  Get statement node
    if (node.type === 'Get') {
      const result = await this.runtime._executeGet(node, env);
      this.globals.set('response', result);
      return;
    }

    return _origExecStmt.call(this, node, env);
  };

  // ── Patch evalExpr to handle Get expression ───────────────────────────────────
  // make result get "/users"  — the parser emits a Get expr for the RHS

  const _origEvalExpr = Interpreter.prototype.evalExpr;
  Interpreter.prototype.evalExpr = async function (node, env) {
    if (!node) return null;
    if (node.type === 'Get') {
      return await this.runtime._executeGet(node, env);
    }
    return _origEvalExpr.call(this, node, env);
  };

  // ── Patch _evalStringLit to skip auto-fetch for relative URLs ────────────────
  // The original _evalStringLit auto-fetches any string starting with http(s)://.
  // We don't need to change this — relative paths go through _executeGet above.
  // But we do want credentials injected when auto-fetching absolute URLs.
  const _origStringLit = Interpreter.prototype._evalStringLit;
  Interpreter.prototype._evalStringLit = async function (node, env) {
    const sv = node.value;
    // Only intercept absolute URLs and only if a credName is active
    if (typeof sv === 'string' && (sv.startsWith('https://') || sv.startsWith('http://'))) {
      const credName = this.globals.get('__credName__') ?? null;
      if (credName) {
        // Interpolate the string first (in case it has {expr})
        const interpolated = await _origStringLit.call(this, { ...node, value: sv }, env);
        if (typeof interpolated !== 'string') return interpolated; // already fetched by orig
        // Orig already fetched it — so just return it
        return interpolated;
      }
    }
    return _origStringLit.call(this, node, env);
  };

  console.log('%c[KH] runtime-patch loaded — credentials-aware get/post active', 'color:#4ade80');
})();
