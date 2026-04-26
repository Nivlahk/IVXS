# IVXS Desktop

Electron wrapper for the IVX programming language. Runs IVX programs locally without a browser or internet connection.

## What's different from ivxs.tech

| Feature | Web | Desktop |
|---------|-----|---------|
| Google Drive | ✓ | ✗ |
| Gmail (`email`) | ✓ | ✗ |
| Google Sheets (`sheets`) | ✓ | ✗ |
| Native file open/save | ✗ | ✓ |
| Offline | ✗ | ✓ |
| `save x as filename` → Downloads | ✗ | ✓ |
| Auto-save / crash recovery | ✗ | ✓ |
| Recent files | ✗ | ✓ |
| Keyboard shortcuts (Cmd+S, Cmd+O) | ✗ | ✓ |
| Standard library (`from "https://ivxs.tech/std/..."`) | ✓ | ✓ |
| Speech synthesis (`say`) | ✓ | ✓ |

## Setup

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build for your platform
npm run build:mac     # macOS .dmg
npm run build:win     # Windows .exe installer
npm run build:linux   # Linux AppImage + .deb
npm run build:all     # All platforms
```

## File structure

```
ivx-desktop/
├── src/
│   ├── main.js              ← Electron main process
│   ├── preload.js           ← Secure IPC bridge
│   ├── index.html           ← App UI (same as web, minus Drive)
│   ├── ivx-desktop-fs.js   ← Native file system integration
│   ├── ivx-core.js          ← IVX engine (copy from web)
│   ├── ivx-runtime.js       ← IVX runtime (copy from web)
│   ├── ivx-parser.js        ← IVX parser (copy from web)
│   ├── ivx-render.js        ← Flowchart renderer (copy from web)
│   ├── ivx-editor.js        ← Editor + highlighting (copy from web)
│   ├── ivx-lens.js          ← Lens/filter (copy from web)
│   ├── ivx-script.js        ← Script utilities (copy from web)
│   ├── ivx-terminal.js      ← Terminal panel (copy from web)
│   ├── ivx-ui.js            ← UI chrome (copy from web)
│   ├── ivx-demos.js         ← Keyword demos (copy from web)
│   ├── ivx-examples.js      ← Example programs (copy from web)
│   ├── styles.css           ← Styles (copy from web)
│   └── ivx-demos.css        ← Demo styles (copy from web)
├── assets/
│   ├── icon.png             ← 512×512 app icon
│   ├── icon.icns            ← macOS icon
│   └── icon.ico             ← Windows icon
├── package.json
└── README.md
```

## Copying web files into src/

After updating the web version, copy these files into `src/`:

```bash
cp ../ivx-core.js       src/
cp ../ivx-runtime.js    src/
cp ../ivx-parser.js     src/
cp ../ivx-render.js     src/
cp ../ivx-editor.js     src/
cp ../ivx-lens.js       src/
cp ../ivx-script.js     src/
cp ../ivx-terminal.js   src/
cp ../ivx-ui.js         src/
cp ../ivx-demos.js      src/
cp ../ivx-examples.js   src/
cp ../styles.css         src/
cp ../ivx-demos.css      src/
```

Do NOT copy `ivx-drive.js` — the desktop uses `ivx-desktop-fs.js` instead.

## Adding a download button to ivxs.tech

Add this to your web `index.html` header to let users download the desktop app:

```html
<a href="https://ivxs.tech/download" class="drive-btn drive-btn-hdr">
  ⬇ Desktop App
</a>
```

Host the built `.dmg` / `.exe` / `.AppImage` at `https://ivxs.tech/download`.
