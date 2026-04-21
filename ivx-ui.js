// ivx-ui.js — IVX UI Chrome
// Panel collapse, mobile tabs, bug report modal
// Depends on: ivx-render.js, ivx-editor.js
// Licensed under the Apache License, Version 2.0
// Copyright 2026 IVX

'use strict';

// ── Panel collapse (editor + graph) ──────────────────────────────────────────
(function() {
  const COLLAPSED_HDR = 32;

  // Editor panel
  const epEl       = document.getElementById('ep');
  const epMinBtn   = document.getElementById('ep-minimize');
  let epCollapsed  = false;

  epMinBtn.addEventListener('click', () => {
    epCollapsed = !epCollapsed;
    epEl.classList.toggle('collapsed', epCollapsed);
    epMinBtn.textContent = epCollapsed ? '▶' : '—';
    epMinBtn.title = epCollapsed ? 'Expand editor' : 'Collapse editor';
    window.dispatchEvent(new Event('resize')); // trigger SVG resize
  });

  // Graph panel
  const gpEl       = document.getElementById('gp');
  const gpMinBtn   = document.getElementById('gp-minimize');
  let gpCollapsed  = false;

  gpMinBtn.addEventListener('click', () => {
    gpCollapsed = !gpCollapsed;
    gpEl.classList.toggle('collapsed', gpCollapsed);
    gpMinBtn.textContent = gpCollapsed ? '◀' : '—';
    gpMinBtn.title = gpCollapsed ? 'Expand flowchart' : 'Collapse flowchart';
    window.dispatchEvent(new Event('resize'));
  });
})();

// ── Mobile tabs ───────────────────────────────────────────────────────────────
(function() {
  const tabs = document.querySelectorAll('.mob-tab');
  const epEl = document.getElementById('ep');
  const gpEl = document.getElementById('gp');

  function switchTab(panel) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === panel));
    epEl.classList.toggle('mob-hidden', panel !== 'ep');
    gpEl.classList.toggle('mob-hidden', panel !== 'gp');
    if (panel === 'gp') window.dispatchEvent(new Event('resize'));
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.panel));
  });

  // Default: show editor on mobile
  if (window.innerWidth <= 700) switchTab('ep');
})();

// ── Bug report ────────────────────────────────────────────────────────────────
document.getElementById('bug-btn').addEventListener('click', () => {
  // Remove any existing modal
  document.getElementById('bug-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'bug-modal';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,.6)',
    zIndex: '20000', display: 'flex', alignItems: 'center', justifyContent: 'center',
  });

  const box = document.createElement('div');
  Object.assign(box.style, {
    background: '#1c1c28', border: '1px solid #3a3a5c', borderRadius: '10px',
    padding: '20px', width: '460px', maxWidth: '90vw',
    display: 'flex', flexDirection: 'column', gap: '12px',
    fontFamily: 'system-ui, sans-serif', boxShadow: '0 16px 48px rgba(0,0,0,.6)',
  });

  // Title
  const title = document.createElement('div');
  title.textContent = '🐛 Report a Bug';
  Object.assign(title.style, { fontSize: '15px', fontWeight: '700', color: '#cdd6f4' });
  box.appendChild(title);

  // Description label + textarea
  const lbl = document.createElement('label');
  lbl.textContent = 'What went wrong?';
  Object.assign(lbl.style, { fontSize: '12px', color: '#9ca3af' });
  box.appendChild(lbl);

  const desc = document.createElement('textarea');
  desc.placeholder = 'Describe the bug — what you did, what you expected, what happened instead…';
  desc.rows = 5;
  Object.assign(desc.style, {
    background: '#0f0f14', color: '#cdd6f4', border: '1px solid #3a3a5c',
    borderRadius: '6px', padding: '8px 10px', fontSize: '12px',
    fontFamily: 'inherit', resize: 'vertical', outline: 'none', width: '100%',
    boxSizing: 'border-box',
  });
  box.appendChild(desc);

  // Include source checkbox
  const srcRow = document.createElement('label');
  Object.assign(srcRow.style, { display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '12px', color: '#9ca3af', cursor: 'pointer' });
  const srcCheck = document.createElement('input');
  srcCheck.type = 'checkbox';
  srcCheck.checked = true;
  srcRow.appendChild(srcCheck);
  srcRow.appendChild(document.createTextNode('Include current program source'));
  box.appendChild(srcRow);

  // Buttons
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, {
    background: 'none', border: '1px solid #3a3a5c', color: '#6b7280',
    borderRadius: '5px', padding: '6px 14px', cursor: 'pointer', fontSize: '12px',
    fontFamily: 'inherit',
  });
  cancelBtn.addEventListener('click', () => overlay.remove());

  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Open in Email';
  Object.assign(sendBtn.style, {
    background: '#1f4d6e', border: '1px solid #60a5fa', color: '#93c5fd',
    borderRadius: '5px', padding: '6px 14px', cursor: 'pointer', fontSize: '12px',
    fontFamily: 'inherit', fontWeight: '600',
  });

  sendBtn.addEventListener('click', () => {
    const userDesc  = desc.value.trim() || '(no description provided)';
    const ivxSource = srcCheck.checked && typeof srcEl !== 'undefined'
      ? srcEl.value.trim() : '';
    const browserInfo = `Browser: ${navigator.userAgent}`;
    const ivxVersion  = 'IVX Build v3';

    let body = `Bug Report\n${'─'.repeat(40)}\n\n${userDesc}\n\n`;
    body += `${browserInfo}\n${ivxVersion}\n`;
    if (ivxSource) body += `\nProgram Source:\n${'─'.repeat(40)}\n${ivxSource}\n`;

    const subject = encodeURIComponent('IVX Bug Report');
    const bodyEnc = encodeURIComponent(body);
    window.location.href = `mailto:iceboltstartup@gmail.com?subject=${subject}&body=${bodyEnc}`;
    overlay.remove();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(sendBtn);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Close on outside click
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  setTimeout(() => desc.focus(), 50);
});