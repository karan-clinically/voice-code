// Electron main: boots the harness, shows the app window, and lives in the tray.
// The renderer talks to the harness over http://localhost:<port> (REST + WS).

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell } = require('electron');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const { HarnessManager } = require('./harnessManager.cjs');

const REPO_ROOT = join(__dirname, '..', '..');
const HARNESS_PORT = Number(process.env.PORT || 4620);
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

let win = null;
let tray = null;
let harness = null;
let isQuitting = false;

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

  win.once('ready-to-show', () => win.show());

  // Close hides to tray; the harness keeps running.
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Claude Code Voice Harness');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => (win ? win.show() : createWindow()) },
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
  tray.on('click', () => (win ? win.show() : createWindow()));
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
ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});
ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));

app.whenReady().then(() => {
  startHarness();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Stay alive in the tray (Windows/Linux); do not quit on window close.
});

app.on('before-quit', () => {
  isQuitting = true;
  harness?.stop();
});
