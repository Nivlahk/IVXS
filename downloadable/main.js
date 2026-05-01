// src/main.js — IVX Desktop Main Process
'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Keep a global reference to the window ────────────────────────────────────
let win;

function createWindow() {
  win = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    title: 'IVXS',
    icon: path.join(__dirname, '../assets/icon.png'),
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload:         path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // Open DevTools in dev mode
  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools();
  }

  win.on('closed', () => { win = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Native file dialogs ───────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:   'Open IVX File',
    filters: [{ name: 'IVX Files', extensions: ['ivx'] }, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  return { path: filePaths[0], content: fs.readFileSync(filePaths[0], 'utf8') };
});

ipcMain.handle('fs:read', async (event, filePath) => {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
});

ipcMain.handle('dialog:saveFile', async (event, { content, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title:       'Save IVX File',
    defaultPath: defaultName || 'untitled.ivx',
    filters:     [{ name: 'IVX Files', extensions: ['ivx'] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
});

ipcMain.handle('dialog:saveExport', async (event, { content, defaultName, ext, mime }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title:       'Export',
    defaultPath: defaultName || 'flowchart.' + ext,
    filters:     [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (canceled || !filePath) return null;
  if (mime === 'image/png' || mime === 'image/jpeg') {
    // content is a base64 data URL
    const base64 = content.replace(/^data:[^;]+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  } else {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return filePath;
});

// ── Filesystem save (for IVX 'save x as filename' keyword) ───────────────────
ipcMain.handle('fs:save', async (event, { filename, content }) => {
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._\- ]/g, '_');
  const savePath = path.join(os.homedir(), 'Downloads', safeName);
  fs.writeFileSync(savePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  return savePath;
});

// ── Reveal file in finder/explorer ───────────────────────────────────────────
ipcMain.handle('shell:showItem', async (event, filePath) => {
  shell.showItemInFolder(filePath);
});

// ── Recent files (stored in userData) ────────────────────────────────────────
const RECENT_PATH = path.join(app.getPath('userData'), 'recent.json');

function loadRecent() {
  try { return JSON.parse(fs.readFileSync(RECENT_PATH, 'utf8')); }
  catch { return []; }
}

function saveRecent(list) {
  try { fs.writeFileSync(RECENT_PATH, JSON.stringify(list, null, 2), 'utf8'); }
  catch {}
}

ipcMain.handle('recent:get', () => loadRecent());

ipcMain.handle('recent:add', (event, filePath) => {
  const list = loadRecent().filter(p => p !== filePath);
  list.unshift(filePath);
  saveRecent(list.slice(0, 10));
  buildMenu(); // refresh menu with new recent list
});

// ── Auto-save to temp (crash recovery) ───────────────────────────────────────
const AUTOSAVE_PATH = path.join(app.getPath('userData'), 'autosave.ivx');

ipcMain.handle('autosave:write', (event, content) => {
  try { fs.writeFileSync(AUTOSAVE_PATH, content, 'utf8'); } catch {}
});

ipcMain.handle('autosave:read', () => {
  try { return fs.readFileSync(AUTOSAVE_PATH, 'utf8'); } catch { return null; }
});

// ── Menu ──────────────────────────────────────────────────────────────────────
function buildMenu() {
  const recent = loadRecent();

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => win?.webContents.send('menu:new'),
        },
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await ipcMain.emit('dialog:openFile');
            // Handled via renderer triggering the IPC directly
            win?.webContents.send('menu:open');
          },
        },
        {
          label: 'Open Recent',
          submenu: recent.length
            ? recent.map(p => ({
                label: path.basename(p),
                click: () => {
                  try {
                    const content = fs.readFileSync(p, 'utf8');
                    win?.webContents.send('menu:openFile', { path: p, content });
                  } catch {
                    win?.webContents.send('menu:error', `Could not open: ${p}`);
                  }
                },
              }))
            : [{ label: 'No Recent Files', enabled: false }],
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => win?.webContents.send('menu:save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => win?.webContents.send('menu:saveAs'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Run',
      submenu: [
        {
          label: 'Run Program',
          accelerator: 'CmdOrCtrl+R',
          click: () => win?.webContents.send('menu:run'),
        },
        {
          label: 'Stop',
          accelerator: 'CmdOrCtrl+.',
          click: () => win?.webContents.send('menu:stop'),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://ivxs.tech'),
        },
        {
          label: 'Standard Library',
          click: () => shell.openExternal('https://ivxs.tech/std'),
        },
        {
          label: 'Report a Bug',
          click: () => win?.webContents.send('menu:bug'),
        },
      ],
    },
  ];

  // macOS: add app menu
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
