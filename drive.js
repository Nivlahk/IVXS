// ivx-drive.js — IVX Google Drive Integration
// Auth, file list, open, save, new file, header filename display
// Depends on: ivx-core.js, ivx-runtime.js, ivx-render.js, ivx-editor.js
// Licensed under the Apache License, Version 2.0
// Copyright 2026 IVX

'use strict';

const DRIVE_CLIENT_ID = '857056430546-3o2o9mhula9lkm1vcpidu61919h3umev.apps.googleusercontent.com';
const DRIVE_SCOPE     = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/script.projects',
].join(' ');
const DRIVE_FOLDER    = 'IVX';

let driveToken     = null;   // current access token
let driveFolderId  = null;   // ID of IVX/ folder in Drive
let driveCurrentId = null;   // ID of currently open file
let driveCurrentName = null; // name of currently open file
let driveUnsaved   = false;  // unsaved changes flag
let driveTokenClient = null; // GIS token client

const driveConnectBtn   = document.getElementById('drive-connect-btn');
const driveFileList     = document.getElementById('drive-file-list');
const driveSignedInEl   = document.getElementById('drive-hdr-signed-in');
const driveNewBtn       = document.getElementById('drive-new-btn');
const driveSaveBtn      = document.getElementById('drive-save-btn');
const driveSignoutBtn   = document.getElementById('drive-signout-btn');
const driveFilesBtn     = document.getElementById('drive-files-btn');
const driveFilename     = document.getElementById('drive-filename');

// ── Files dropdown toggle ─────────────────────────────────────────────────────
driveFilesBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = driveFileList.style.display === 'block';
  driveFileList.style.display = open ? 'none' : 'block';
  if (!open) driveListFiles();
});
document.addEventListener('click', () => { driveFileList.style.display = 'none'; });
driveFileList.addEventListener('click', e => e.stopPropagation());

// ── Auth ──────────────────────────────────────────────────────────────────────
function driveInit() {
  if (typeof google === 'undefined') {
    setTimeout(driveInit, 200);
    return;
  }
  driveTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope:     DRIVE_SCOPE,
    callback:  (resp) => {
      if (resp.error) { console.error('Drive auth error:', resp); return; }
      driveToken = resp.access_token;
      driveConnectBtn.style.display = 'none';
      driveSignedInEl.style.display = 'flex';
      driveEnsureFolder().then(driveListFiles);
    },
  });
}

driveConnectBtn.addEventListener('click', () => {
  if (!driveTokenClient) { driveInit(); setTimeout(() => driveTokenClient?.requestAccessToken(), 300); return; }
  driveTokenClient.requestAccessToken();
});

driveSignoutBtn.addEventListener('click', () => {
  if (driveToken) google.accounts.oauth2.revoke(driveToken);
  driveToken = null; driveFolderId = null;
  driveCurrentId = null; driveCurrentName = null;
  driveConnectBtn.style.display = '';
  driveSignedInEl.style.display = 'none';
  driveFileList.style.display = 'none';
  driveFileList.innerHTML = '';
  driveFilename.textContent = '';
  driveFilename.className = 'drive-filename';
});

// ── API helpers ───────────────────────────────────────────────────────────────
async function driveAPI(path, opts = {}) {
  const res = await fetch('https://www.googleapis.com' + path, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + driveToken, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error('Drive API ' + res.status + ': ' + await res.text());
  return res.json();
}

async function driveEnsureFolder() {
  // Find or create the IVX/ folder
  const q = `name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await driveAPI(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  if (res.files && res.files.length > 0) {
    driveFolderId = res.files[0].id;
    return;
  }
  // Create it
  const created = await driveAPI('/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  });
  driveFolderId = created.id;
}

// ── List files ────────────────────────────────────────────────────────────────
async function driveListFiles() {
  driveFileList.innerHTML = '<div class="drive-loading">Loading...</div>';
  try {
    const q = `'${driveFolderId}' in parents and name contains '.ivx' and trashed=false`;
    const res = await driveAPI(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`);
    driveFileList.innerHTML = '';
    if (!res.files || res.files.length === 0) {
      driveFileList.innerHTML = '<div class="drive-empty">No .ivx files yet. Click ＋ New to create one.</div>';
      return;
    }
    for (const f of res.files) {
      const item = document.createElement('div');
      item.className = 'drive-file-item' + (f.id === driveCurrentId ? ' active' : '');
      item.dataset.id   = f.id;
      item.dataset.name = f.name;
      item.innerHTML = `<span class="drive-file-icon">◆</span><span class="drive-file-name">${escHtml(f.name.replace(/\.ivx$/, ''))}</span>`;
      item.addEventListener('click', () => { driveOpenFile(f.id, f.name); driveFileList.style.display = 'none'; });
      driveFileList.appendChild(item);
    }
  } catch(e) {
    driveFileList.innerHTML = `<div class="drive-empty">Error: ${e.message}</div>`;
  }
}

// ── Open file ─────────────────────────────────────────────────────────────────
async function driveOpenFile(id, name) {
  if (driveUnsaved) {
    if (!confirm('You have unsaved changes. Open this file anyway?')) return;
  }
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers: { 'Authorization': 'Bearer ' + driveToken },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode: text });
    driveCurrentId   = id;
    driveCurrentName = name;
    driveUnsaved     = false;
    driveUpdateHeader();
    // Update active state in list
    driveFileList.querySelectorAll('.drive-file-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
    });
  } catch(e) {
    alert('Could not open file: ' + e.message);
  }
}

// ── Save file ─────────────────────────────────────────────────────────────────
async function driveSaveFile() {
  if (!driveToken) return;
  if (!driveCurrentId) { driveNewFile(); return; }
  try {
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${driveCurrentId}?uploadType=media`, {
      method:  'PATCH',
      headers: { 'Authorization': 'Bearer ' + driveToken, 'Content-Type': 'text/plain' },
      body:    srcEl.value,
    });
    driveUnsaved = false;
    driveUpdateHeader();
  } catch(e) {
    alert('Save failed: ' + e.message);
  }
}

// ── New file ──────────────────────────────────────────────────────────────────
async function driveNewFile() {
  if (!driveToken || !driveFolderId) return;
  const rawName = prompt('File name:', 'untitled');
  if (!rawName) return;
  const name = rawName.endsWith('.ivx') ? rawName : rawName + '.ivx';
  try {
    // Create metadata
    const meta = await driveAPI('/drive/v3/files', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, parents: [driveFolderId], mimeType: 'text/plain' }),
    });
    // Upload empty content
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${meta.id}?uploadType=media`, {
      method:  'PATCH',
      headers: { 'Authorization': 'Bearer ' + driveToken, 'Content-Type': 'text/plain' },
      body:    '',
    });
    driveCurrentId   = meta.id;
    driveCurrentName = name;
    driveUnsaved     = false;
    if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode: '' });
    driveUpdateHeader();
    await driveListFiles();
  } catch(e) {
    alert('Could not create file: ' + e.message);
  }
}

// ── Header filename display ───────────────────────────────────────────────────
function driveUpdateHeader() {
  if (!driveCurrentName) { driveFilename.textContent = ''; return; }
  driveFilename.textContent = driveCurrentName.replace(/\.ivx$/, '');
  driveFilename.className   = 'drive-filename' + (driveUnsaved ? ' unsaved' : '');
}

// ── Track unsaved changes ─────────────────────────────────────────────────────
srcEl.addEventListener('input', () => {
  if (driveCurrentId && !driveUnsaved) {
    driveUnsaved = true;
    driveUpdateHeader();
  }
});

// ── Keyboard shortcut: Ctrl/Cmd+S to save ────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (driveToken) driveSaveFile();
  }
});

driveNewBtn .addEventListener('click', driveNewFile);
driveSaveBtn.addEventListener('click', driveSaveFile);

window.addEventListener('load', driveInit);

