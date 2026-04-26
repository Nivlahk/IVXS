// src/preload.js — Secure context bridge
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ivxDesktop', {
  // ── File operations ─────────────────────────────────────────────────────
  openFile:    ()                    => ipcRenderer.invoke('dialog:openFile'),
  saveFile:    (content, defaultName) => ipcRenderer.invoke('dialog:saveFile', { content, defaultName }),
  saveExport:  (content, defaultName, ext, mime) => ipcRenderer.invoke('dialog:saveExport', { content, defaultName, ext, mime }),

  // ── IVX runtime file save (for 'save x as filename') ───────────────────
  fsSave:      (filename, content)   => ipcRenderer.invoke('fs:save', { filename, content }),
  showInFolder:(filePath)            => ipcRenderer.invoke('shell:showItem', filePath),

  // ── Recent files ────────────────────────────────────────────────────────
  getRecent:   ()                    => ipcRenderer.invoke('recent:get'),
  addRecent:   (filePath)            => ipcRenderer.invoke('recent:add', filePath),

  // ── Auto-save ───────────────────────────────────────────────────────────
  autosaveWrite: (content)           => ipcRenderer.invoke('autosave:write', content),
  autosaveRead:  ()                  => ipcRenderer.invoke('autosave:read'),

  // ── Menu events (main → renderer) ───────────────────────────────────────
  onMenuNew:      (cb) => ipcRenderer.on('menu:new',      cb),
  onMenuOpen:     (cb) => ipcRenderer.on('menu:open',     cb),
  onMenuOpenFile: (cb) => ipcRenderer.on('menu:openFile', (_, data) => cb(data)),
  onMenuSave:     (cb) => ipcRenderer.on('menu:save',     cb),
  onMenuSaveAs:   (cb) => ipcRenderer.on('menu:saveAs',   cb),
  onMenuRun:      (cb) => ipcRenderer.on('menu:run',      cb),
  onMenuStop:     (cb) => ipcRenderer.on('menu:stop',     cb),
  onMenuBug:      (cb) => ipcRenderer.on('menu:bug',      cb),
  onMenuError:    (cb) => ipcRenderer.on('menu:error',    (_, msg) => cb(msg)),

  // ── Platform info ────────────────────────────────────────────────────────
  platform: process.platform,
  isDesktop: true,
});
