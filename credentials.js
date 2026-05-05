// kh-credentials.js — KH Credentials Vault
// Persistent named credential store for backend servers and AI services.
// Credentials are stored in localStorage, keyed by name.
// The KH runtime reads from this store — credentials never appear in source code.
// Licensed under the Apache License, Version 2.0
// Copyright 2026 KH

'use strict';

window.IVX = window.IVX || {};

// ── Credentials store ─────────────────────────────────────────────────────────
window.IVX.credentials = (() => {
  const STORAGE_KEY = 'kh_credentials_v1';

  function _load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function _save(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      console.error('[KH Credentials] Could not persist to localStorage:', e);
    }
  }

  return {
    // Set or update a named credential
    // type: 'bearer' | 'apikey' | 'basic' | 'custom'
    // headerName: only used when type === 'custom'
    set(name, value, { type = 'bearer', headerName = null, baseUrl = null } = {}) {
      const store = _load();
      store[name] = { value, type, headerName, baseUrl, updatedAt: Date.now() };
      _save(store);
      IVX.bus?.emit('credentials_changed', { name });
    },

    get(name) {
      const store = _load();
      return store[name] ?? null;
    },

    // Returns the Authorization header value (or custom header) for a named credential
    // Used by the runtime when making fetch calls
    authHeader(name) {
      const cred = this.get(name);
      if (!cred) return null;
      switch (cred.type) {
        case 'bearer':  return { key: 'Authorization', value: `Bearer ${cred.value}` };
        case 'apikey':  return { key: 'x-api-key',     value: cred.value };
        case 'basic':   return { key: 'Authorization', value: `Basic ${btoa(cred.value)}` };
        case 'custom':  return { key: cred.headerName || 'Authorization', value: cred.value };
        default:        return { key: 'Authorization', value: `Bearer ${cred.value}` };
      }
    },

    remove(name) {
      const store = _load();
      delete store[name];
      _save(store);
      IVX.bus?.emit('credentials_changed', { name });
    },

    list() {
      const store = _load();
      // Return metadata only — never expose raw values to the UI listing
      return Object.entries(store).map(([name, cred]) => ({
        name,
        type: cred.type,
        baseUrl: cred.baseUrl,
        updatedAt: cred.updatedAt,
        // Masked preview: "sk-ab••••••••efgh"
        preview: cred.value.length > 8
          ? cred.value.slice(0, 4) + '••••••••' + cred.value.slice(-4)
          : '••••••••',
      }));
    },

    clear() {
      _save({});
      IVX.bus?.emit('credentials_changed', {});
    },
  };
})();
