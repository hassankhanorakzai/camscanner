'use strict';
const { app, BrowserWindow, protocol, net, session: eSession, safeStorage, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// node:sqlite may print an experimental warning; keep the console clean.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const imaging = require('./images');
const { Config } = require('./config');
const { Session } = require('./session');
const ipc = require('./ipc');

const RENDERER = path.join(__dirname, '..', 'renderer');
const OPENCV = path.join(path.dirname(require.resolve('@techstark/opencv-js/package.json')), 'dist', 'opencv.js');

if (process.env.SMARTSCAN_DATA_DIR) app.setPath('userData', path.resolve(process.env.SMARTSCAN_DATA_DIR));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let mainWindow = null;
let session = null;
const getWindow = () => mainWindow;
const notify = (channel, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data); };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function handleProtocol(request) {
  const url = new URL(request.url);
  if (url.host !== 'smartscan') return new Response('Not found', { status: 404 });
  const p = decodeURIComponent(url.pathname);
  // user files: /_data/<kind>/<id>
  const m = /^\/_data\/(page|thumb|original|pdf|attachment)\/(\d+)$/.exec(p);
  if (m) {
    const lib = session?.lib;
    if (!lib) return new Response('Unauthorized', { status: 401 });
    let file;
    try { file = lib.resolveFile(m[1], m[2]); } catch { file = null; }
    if (!file || !fs.existsSync(file)) {
      // thumbnail cache miss: fall back to the page itself
      if (m[1] === 'thumb') { try { file = lib.resolveFile('page', m[2]); } catch { file = null; } }
      if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).href).then((r) => new Response(r.body, { status: 200, headers: { 'Content-Type': m[1] === 'pdf' || /\.pdf$/i.test(file) ? 'application/pdf' : (/\.png$/i.test(file) ? 'image/png' : 'image/jpeg'), 'Cache-Control': 'no-cache' } }));
  }
  let file;
  if (p === '/vendor/opencv.js') file = OPENCV;
  else {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    file = path.normalize(path.join(RENDERER, rel));
    if (!file.startsWith(RENDERER + path.sep)) return new Response('Forbidden', { status: 403 });
  }
  return net.fetch(pathToFileURL(file).href).then((r) => {
    if (!r.ok) return new Response('Not found', { status: 404 });
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' };
    if (file.endsWith('.html')) {
      headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
    }
    return new Response(r.body, { status: 200, headers });
  });
}

function createWindow() {
  const bounds = session.config.get('windowBounds', { width: 1320, height: 860 });
  mainWindow = new BrowserWindow({
    ...bounds, minWidth: 980, minHeight: 640, show: false, title: 'SmartScan', backgroundColor: '#f4f6fb',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  if (session.config.get('maximized')) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => {
    if (process.argv.includes('--hidden')) { mainWindow.showInactive(); mainWindow.minimize(); } // started with Windows: stay in the taskbar
    else mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://smartscan/')) e.preventDefault(); });
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    session.config.set('maximized', mainWindow.isMaximized());
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) session.config.set('windowBounds', mainWindow.getBounds());
  };
  mainWindow.on('close', saveBounds);
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL('app://smartscan/index.html');
}

function makeUpdater() {
  let au = null;
  const send = (s) => notify('update:status', s);
  const get = () => {
    if (au) return au;
    try {
      au = require('electron-updater').autoUpdater;
      au.autoDownload = false;
      au.on('update-available', (i) => send({ state: 'available', version: i.version }));
      au.on('update-not-available', () => send({ state: 'none' }));
      au.on('download-progress', (p) => send({ state: 'downloading', percent: p.percent }));
      au.on('update-downloaded', (i) => send({ state: 'ready', version: i.version }));
      au.on('error', (e) => send({ state: 'error', message: e.message }));
    } catch { au = null; }
    return au;
  };
  return {
    async check() {
      if (!app.isPackaged) return { state: 'dev', message: 'Updates are checked in the installed app.' };
      const u = get();
      if (!u) return { state: 'error', message: 'Updater unavailable' };
      const r = await u.checkForUpdates().catch((e) => ({ error: e }));
      if (r?.error) return { state: 'error', message: 'Could not reach the update server (offline?).' };
      if (r?.isUpdateAvailable) { u.downloadUpdate().catch(() => {}); return { state: 'available', version: r.updateInfo.version }; }
      return { state: 'none', version: app.getVersion() };
    },
    install() { const u = get(); if (u) setImmediate(() => u.quitAndInstall()); return true; },
  };
}

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const dataDir = app.getPath('userData');
  const config = new Config(dataDir, safeStorage);
  session = new Session({ dataDir, config, imaging, defaultBase: process.env.SMARTSCAN_DEFAULT_BASE || app.getPath('documents'), notify });

  protocol.handle('app', handleProtocol);
  const ses = eSession.defaultSession;
  const trusted = (u) => String(u || '').startsWith('app://smartscan');
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(trusted(details.requestingUrl || wc.getURL()) && ['media', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => trusted(origin) && ['media', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
    // The UI never talks to the internet: private documents stay on this PC.
    cb({ cancel: details.webContentsId === mainWindow?.webContents.id });
  });

  ipc.register({ session, getWindow, imaging, updater: makeUpdater() });
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((e) => {
  dialog.showErrorBox('SmartScan could not start', String(e?.stack || e));
  app.quit();
});

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { try { session?.endLibrary(); session?.accounts.close(); } catch { /* ignore */ } });
