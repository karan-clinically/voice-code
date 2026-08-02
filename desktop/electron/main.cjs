// Electron main: boots the harness, shows the app window, and lives in the tray.
// The renderer talks to the harness over http://localhost:<port> (REST + WS).

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell, clipboard } = require('electron');
const { join } = require('node:path');
const { existsSync, writeFileSync } = require('node:fs');
const { HarnessManager } = require('./harnessManager.cjs');

const REPO_ROOT = join(__dirname, '..', '..');
const HARNESS_PORT = Number(process.env.PORT || 4620);
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const START_MINIMIZED = process.argv.includes('--start-minimized');

let win = null;
let tray = null;
let harness = null;
let isQuitting = false;

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayImage() {
  const assetPng = join(__dirname, '..', 'assets', 'tray.png');
  if (existsSync(assetPng)) {
    const img = nativeImage.createFromPath(assetPng);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'Claude Code Voice Harness',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(join(REPO_ROOT, 'desktop', 'dist', 'index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
    if (START_MINIMIZED) win.minimize();
  });

  // Electron is intentionally on-demand: closing the window releases Chromium's
  // memory. The independently auto-started headless harness keeps phone sessions
  // running, and the Desktop/Start-menu shortcut reopens this UI when needed.
  win.on('close', (e) => {
    if (!isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Claude Code Voice Harness');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', showWindow);
}

function startHarness() {
  harness = new HarnessManager({
    repoRoot: REPO_ROOT,
    port: HARNESS_PORT,
    onLog: (text) => win?.webContents.send('harness:log', text),
    onStatus: (status) => win?.webContents.send('harness:status', status),
  });
  harness.start();
}

// IPC surface for the renderer.
ipcMain.handle('app:info', () => ({ port: HARNESS_PORT, version: app.getVersion() }));
ipcMain.handle('dialog:pickFolder', async (_event, defaultPath) => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    ...(typeof defaultPath === 'string' && defaultPath ? { defaultPath } : {}),
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});
// Pick a local file → return its absolute path so the chat composer can hand it
// to Claude Code (which reads local paths directly, no upload needed on desktop).
ipcMain.handle('dialog:pickFile', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});
ipcMain.handle('shell:openExternal', (_e, url) => {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid external URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('External URL must use HTTP or HTTPS');
  return shell.openExternal(parsed.href);
});

// If the clipboard holds an image, write it to a temp PNG and return the path so
// the terminal can hand the path to Claude Code (which ingests images by path).
// Returns null when the clipboard has no image (caller then pastes text).
ipcMain.handle('clipboard:imageToTemp', () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    const file = join(app.getPath('temp'), `cvh-paste-${Date.now()}.png`);
    writeFileSync(file, img.toPNG());
    return file;
  } catch {
    return null;
  }
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    startHarness();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // Stay alive in the tray (Windows/Linux); do not quit on window close.
});

app.on('before-quit', () => {
  isQuitting = true;
  harness?.stop();
});
