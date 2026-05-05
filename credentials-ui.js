// kh-credentials-ui.js — Credentials Panel UI
// Renders the modal credentials manager and wires up the header button.
// Depends on: kh-events.js, kh-credentials.js
// Licensed under the Apache License, Version 2.0
// Copyright 2026 KH

'use strict';

(() => {

  // ── Inject styles ────────────────────────────────────────────────────────────
  const STYLES = `
  #creds-btn { position: relative; }
  #creds-btn.has-creds::after {
    content: '';
    position: absolute;
    top: 4px; right: 4px;
    width: 6px; height: 6px;
    background: #4ade80;
    border-radius: 50%;
  }

  #creds-modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.55);
    z-index: 9000;
    align-items: center;
    justify-content: center;
  }
  #creds-modal-overlay.open { display: flex; }

  #creds-modal {
    background: #1a1f2e;
    border: 1px solid #2e3650;
    border-radius: 10px;
    width: min(520px, 96vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 40px rgba(0,0,0,0.5);
    overflow: hidden;
  }

  #creds-modal-hdr {
    display: flex;
    align-items: center;
    padding: 14px 18px;
    border-bottom: 1px solid #2e3650;
    gap: 10px;
  }
  #creds-modal-hdr h2 {
    font-size: 14px;
    font-weight: 600;
    color: #cdd6f4;
    margin: 0;
    flex: 1;
  }
  #creds-modal-close {
    background: none;
    border: none;
    color: #6b7280;
    font-size: 18px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
  }
  #creds-modal-close:hover { background: #2e3650; color: #cdd6f4; }

  #creds-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 18px;
    min-height: 60px;
  }
  #creds-list:empty::before {
    content: 'No credentials saved yet. Add one below.';
    color: #6b7280;
    font-size: 12px;
    display: block;
    padding: 8px 0;
  }

  .cred-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    margin-bottom: 4px;
    background: #12151f;
    border: 1px solid #2e3650;
  }
  .cred-row-info { flex: 1; min-width: 0; }
  .cred-row-name {
    font-size: 13px;
    font-weight: 500;
    color: #cdd6f4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cred-row-meta {
    font-size: 11px;
    color: #6b7280;
    margin-top: 2px;
  }
  .cred-row-preview {
    font-size: 11px;
    color: #4a9eff;
    font-family: monospace;
  }
  .cred-del-btn {
    background: none;
    border: 1px solid #3b1e28;
    color: #f87171;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    padding: 3px 8px;
    flex-shrink: 0;
  }
  .cred-del-btn:hover { background: #3b1e28; }

  #creds-add-form {
    border-top: 1px solid #2e3650;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  #creds-add-form label {
    font-size: 11px;
    color: #6b7280;
    display: block;
    margin-bottom: 3px;
  }
  #creds-add-form input,
  #creds-add-form select {
    width: 100%;
    background: #12151f;
    border: 1px solid #2e3650;
    border-radius: 5px;
    color: #cdd6f4;
    font-size: 12px;
    padding: 7px 10px;
    box-sizing: border-box;
    outline: none;
    font-family: monospace;
  }
  #creds-add-form input:focus,
  #creds-add-form select:focus { border-color: #4a9eff; }
  #creds-add-form select { font-family: system-ui, sans-serif; }

  .creds-row2 { display: flex; gap: 10px; }
  .creds-row2 > div { flex: 1; }

  #creds-custom-header-wrap { display: none; }

  #creds-add-btn {
    background: #1e3a5f;
    border: 1px solid #4a9eff;
    color: #4a9eff;
    border-radius: 5px;
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    align-self: flex-end;
  }
  #creds-add-btn:hover { background: #4a9eff; color: #fff; }

  #creds-error {
    font-size: 11px;
    color: #f87171;
    min-height: 16px;
  }

  .creds-type-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: #1e2d3e;
    color: #4a9eff;
    border: 1px solid #2e3a50;
    margin-right: 4px;
  }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLES;
  document.head.appendChild(styleEl);

  // ── Inject HTML ───────────────────────────────────────────────────────────────
  document.body.insertAdjacentHTML('beforeend', `
  <div id="creds-modal-overlay">
    <div id="creds-modal">
      <div id="creds-modal-hdr">
        <h2>🔑 Credentials</h2>
        <button id="creds-modal-close" title="Close">✕</button>
      </div>
      <div id="creds-list"></div>
      <div id="creds-add-form">
        <div class="creds-row2">
          <div>
            <label>Name (used in KH code)</label>
            <input id="cred-name" type="text" placeholder="my-server" autocomplete="off" spellcheck="false" />
          </div>
          <div>
            <label>Auth type</label>
            <select id="cred-type">
              <option value="bearer">Bearer token</option>
              <option value="apikey">API key (x-api-key)</option>
              <option value="basic">Basic auth (user:pass)</option>
              <option value="custom">Custom header</option>
            </select>
          </div>
        </div>
        <div id="creds-custom-header-wrap">
          <label>Header name</label>
          <input id="cred-header-name" type="text" placeholder="X-My-Auth" autocomplete="off" />
        </div>
        <div>
          <label>Base URL (optional — auto-prefixed on get/post)</label>
          <input id="cred-base-url" type="text" placeholder="https://api.example.com" autocomplete="off" spellcheck="false" />
        </div>
        <div>
          <label>Secret value</label>
          <input id="cred-value" type="password" placeholder="Paste your key or token" autocomplete="off" spellcheck="false" />
        </div>
        <div id="creds-error"></div>
        <button id="creds-add-btn">Save credential</button>
      </div>
    </div>
  </div>
  `);

  // ── Wire up the header button ─────────────────────────────────────────────────
  // Insert the button into the header controls next to the Google sign-in button
  const hdrControls = document.getElementById('drive-hdr-controls');
  if (hdrControls) {
    const btn = document.createElement('button');
    btn.id = 'creds-btn';
    btn.className = 'drive-btn drive-btn-hdr';
    btn.textContent = '🔑 Credentials';
    hdrControls.insertBefore(btn, hdrControls.firstChild);
  }

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  const overlay   = document.getElementById('creds-modal-overlay');
  const closeBtn  = document.getElementById('creds-modal-close');
  const listEl    = document.getElementById('creds-list');
  const nameEl    = document.getElementById('cred-name');
  const typeEl    = document.getElementById('cred-type');
  const valueEl   = document.getElementById('cred-value');
  const baseUrlEl = document.getElementById('cred-base-url');
  const headerNameEl     = document.getElementById('cred-header-name');
  const customHeaderWrap = document.getElementById('creds-custom-header-wrap');
  const addBtn    = document.getElementById('creds-add-btn');
  const errorEl   = document.getElementById('creds-error');
  const credsBtn  = document.getElementById('creds-btn');

  // ── Render list ───────────────────────────────────────────────────────────────
  function renderList() {
    const creds = window.IVX.credentials.list();

    // Green dot on header button if any creds exist
    credsBtn?.classList.toggle('has-creds', creds.length > 0);

    listEl.innerHTML = '';
    for (const c of creds) {
      const row = document.createElement('div');
      row.className = 'cred-row';
      row.innerHTML = `
        <div class="cred-row-info">
          <div class="cred-row-name">${escHtmlUI(c.name)}</div>
          <div class="cred-row-meta">
            <span class="creds-type-badge">${escHtmlUI(c.type)}</span>
            <span class="cred-row-preview">${escHtmlUI(c.preview)}</span>
            ${c.baseUrl ? `<span style="color:#6b7280"> · ${escHtmlUI(c.baseUrl)}</span>` : ''}
          </div>
        </div>
        <button class="cred-del-btn" data-name="${escHtmlUI(c.name)}">Remove</button>
      `;
      listEl.appendChild(row);
    }

    listEl.querySelectorAll('.cred-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.IVX.credentials.remove(btn.dataset.name);
        renderList();
      });
    });
  }

  // ── Open / close ─────────────────────────────────────────────────────────────
  function openModal() {
    renderList();
    nameEl.value    = '';
    valueEl.value   = '';
    baseUrlEl.value = '';
    errorEl.textContent = '';
    overlay.classList.add('open');
    nameEl.focus();
  }

  function closeModal() {
    overlay.classList.remove('open');
  }

  credsBtn?.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // ── Show/hide custom header field ─────────────────────────────────────────────
  typeEl.addEventListener('change', () => {
    customHeaderWrap.style.display = typeEl.value === 'custom' ? 'block' : 'none';
  });

  // ── Save credential ───────────────────────────────────────────────────────────
  addBtn.addEventListener('click', () => {
    const name    = nameEl.value.trim();
    const value   = valueEl.value.trim();
    const type    = typeEl.value;
    const baseUrl = baseUrlEl.value.trim() || null;
    const headerName = headerNameEl.value.trim() || null;

    errorEl.textContent = '';

    if (!name) { errorEl.textContent = 'Name is required.'; return; }
    if (!/^[\w\-]+$/.test(name)) { errorEl.textContent = 'Name must only contain letters, numbers, hyphens, underscores.'; return; }
    if (!value) { errorEl.textContent = 'Secret value is required.'; return; }
    if (type === 'custom' && !headerName) { errorEl.textContent = 'Custom header name is required.'; return; }

    window.IVX.credentials.set(name, value, { type, headerName, baseUrl });
    renderList();

    // Reset form
    nameEl.value    = '';
    valueEl.value   = '';
    baseUrlEl.value = '';
    headerNameEl.value = '';
    nameEl.focus();
  });

  // Allow Enter key on name/value fields to submit
  [nameEl, valueEl, baseUrlEl].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
  });

  // ── Refresh list when credentials change (e.g. from runtime) ─────────────────
  window.IVX.bus?.on('credentials_changed', () => renderList());

  // ── Utility ──────────────────────────────────────────────────────────────────
  function escHtmlUI(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Initial badge state
  renderList();

})();
