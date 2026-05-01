// ivx-desktop-fs.js — Desktop file system integration
// Replaces ivx-drive.js. Provides Open/Save via native dialogs.
// Depends on: ivx-editor.js (srcEl, updateHighlight, scheduleRender)
// Licensed under the Apache License, Version 2.0
// Copyright 2026 IVX

'use strict';

const desktop = window.ivxDesktop;
if (!desktop) { console.warn('ivx-desktop-fs: not running in Electron'); }

// ── State ────────────────────────────────────────────────────────────────────
let _currentPath    = null;
let _currentName    = null;
let _unsaved        = false;
let _autosaveTimer  = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const filesBtn    = document.getElementById('desk-files-btn');
const fileList     = document.getElementById('drive-file-list');
const newBtn      = document.getElementById('desk-new-btn');
const openBtn     = document.getElementById('desk-open-btn');
const saveBtn     = document.getElementById('desk-save-btn');
const saveAsBtn   = document.getElementById('desk-saveas-btn');
const filenameEl  = document.getElementById('drive-filename');

// ── Filename display ──────────────────────────────────────────────────────────
function updateHeader() {
  if (!filenameEl) return;
  filenameEl.textContent  = _currentName ? _currentName.replace(/\.ivx$/, '') : 'untitled';
  filenameEl.className    = 'drive-filename' + (_unsaved ? ' unsaved' : '');
  document.title          = (_currentName || 'untitled') + (_unsaved ? ' •' : '') + ' — IVXS';
}

// ── New ───────────────────────────────────────────────────────────────────────
async function fileNew() {
  if (_unsaved && !confirm('Unsaved changes. Start a new file?')) return;
  _currentPath = null;
  _currentName = 'untitled.ivx';
  _unsaved     = false;
  if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode: '' });
  updateHeader();
}

// ── Open ──────────────────────────────────────────────────────────────────────
async function fileOpen() {
  if (_unsaved && !confirm('Unsaved changes. Open another file?')) return;
  const result = await desktop.openFile();
  if (!result) return;
  loadFile(result.path, result.content);
}

function loadFile(filePath, content) {
  _currentPath = filePath;
  _currentName = filePath.split(/[\\/]/).pop();
  _unsaved     = false;
  if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode: content });
  updateHeader();
  desktop.addRecent(filePath);
  listRecentFiles(); // refresh dropdown
}

// ── List Recent Files ─────────────────────────────────────────────────────────
async function listRecentFiles() {
  if (!fileList) return;
  fileList.innerHTML = '<div class="drive-loading">Loading...</div>';
  try {
    const recent = await desktop.getRecent();
    fileList.innerHTML = '';
    if (!recent || recent.length === 0) {
      fileList.innerHTML = '<div class="drive-empty">No recent files yet.</div>';
      return;
    }
    for (const p of recent) {
      const item = document.createElement('div');
      item.className = 'drive-file-item' + (p === _currentPath ? ' active' : '');
      const name = p.split(/[\\/]/).pop().replace(/\.ivx$/, '');
      item.innerHTML = `<span class="drive-file-icon">◆</span><span class="drive-file-name">${name}</span><div class="drive-file-path">${p}</div>`;
      item.addEventListener('click', async () => {
        if (_unsaved && !confirm('Unsaved changes. Open this file anyway?')) return;
        const content = await desktop.openFileFromPath(p);
        if (content != null) loadFile(p, content);
        fileList.style.display = 'none';
      });
      fileList.appendChild(item);
    }
  } catch(e) {
    fileList.innerHTML = `<div class="drive-empty">Error: ${e.message}</div>`;
  }
}

// Files dropdown toggle
filesBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = fileList.style.display === 'block';
  fileList.style.display = open ? 'none' : 'block';
  if (!open) listRecentFiles();
});
document.addEventListener('click', () => { if (fileList) fileList.style.display = 'none'; });
fileList?.addEventListener('click', e => e.stopPropagation());

// ── Save ──────────────────────────────────────────────────────────────────────
async function fileSave() {
  if (!_currentPath) return fileSaveAs();
  // Write directly using the saveFile IPC with current path as default
  const result = await desktop.saveFile(srcEl.value, _currentPath);
  if (!result) return;
  _currentPath = result;
  _currentName = result.split(/[\\/]/).pop();
  _unsaved     = false;
  updateHeader();
  desktop.addRecent(result);
}

async function fileSaveAs() {
  const result = await desktop.saveFile(srcEl.value, _currentName || 'untitled.ivx');
  if (!result) return;
  _currentPath = result;
  _currentName = result.split(/[\\/]/).pop();
  _unsaved     = false;
  updateHeader();
  desktop.addRecent(result);
}

// ── Auto-save (every 30s to crash-recovery slot) ──────────────────────────────
function startAutosave() {
  clearInterval(_autosaveTimer);
  _autosaveTimer = setInterval(() => {
    desktop?.autosaveWrite(srcEl.value);
  }, 30_000);
}

// ── Track unsaved changes ─────────────────────────────────────────────────────
srcEl?.addEventListener('input', () => {
  if (!_unsaved) { _unsaved = true; updateHeader(); }
});

// ── Native keyboard shortcuts (Ctrl/Cmd+S, etc.) ─────────────────────────────
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === 's' && !e.shiftKey) { e.preventDefault(); fileSave(); }
  if (e.key === 's' &&  e.shiftKey) { e.preventDefault(); fileSaveAs(); }
  if (e.key === 'o')                { e.preventDefault(); fileOpen(); }
  if (e.key === 'n')                { e.preventDefault(); fileNew(); }
});

// ── Button wiring ─────────────────────────────────────────────────────────────
newBtn?.addEventListener('click', fileNew);
openBtn?.addEventListener('click', fileOpen);
saveBtn?.addEventListener('click', fileSave);
saveAsBtn?.addEventListener('click', fileSaveAs);

// ── Menu events from main process ─────────────────────────────────────────────
desktop?.onMenuNew    (() => fileNew());
desktop?.onMenuOpen   (() => fileOpen());
desktop?.onMenuOpenFile(data => loadFile(data.path, data.content));
desktop?.onMenuSave   (() => fileSave());
desktop?.onMenuSaveAs (() => fileSaveAs());
desktop?.onMenuRun    (() => document.getElementById('term-run')?.click());
desktop?.onMenuStop   (() => document.getElementById('term-run')?.click());
desktop?.onMenuBug    (() => document.getElementById('bug-btn')?.click());
desktop?.onMenuError  (msg => alert(msg));

// ── IVX 'save x as filename' keyword override ────────────────────────────────
// The runtime calls this when a `save` statement executes
window._ivxDesktopSave = async (filename, content) => {
  const saved = await desktop?.fsSave(filename, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  if (saved) {
    await desktop?.showInFolder(saved);
    return saved;
  }
  return null;
};

// ── Restore autosave on first launch if no file ───────────────────────────────
window.addEventListener('load', async () => {
  startAutosave();
  updateHeader();

  // Offer to restore from autosave if src is empty
  if (!srcEl?.value.trim()) {
    const saved = await desktop?.autosaveRead();
    if (saved?.trim()) {
      if (confirm('Restore unsaved work from last session?')) {
        _unsaved    = true;
        if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode: saved });
        updateHeader();
      }
    }
  }
});

// Expose for export button
window._desktopSaveExport = (content, defaultName, ext, mime) =>
  desktop?.saveExport(content, defaultName, ext, mime);
