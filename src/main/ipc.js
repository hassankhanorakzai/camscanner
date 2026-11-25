'use strict';
/**
 * IPC surface between the UI and the main process. The renderer never passes
 * file paths for library content — only ids — and every handler that touches
 * documents requires a signed-in user with an open library.
 */
const { ipcMain, dialog, shell, app, BrowserWindow, clipboard } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const S = require('./storage');
const { reconcile, removeMissing } = require('./sync');
const backup = require('./backup');
const scanner = require('./scanner');
const { PhoneBridge } = require('./phone');
const { DOC_TYPES } = require('./library');

function register({ session, getWindow, imaging, updater }) {
  const handle = (channel, fn, { auth = true, lib = true } = {}) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.senderFrame && !String(event.senderFrame.url).startsWith('app://smartscan/')) throw new Error('Forbidden');
      try {
        if (auth) session.requireUser();
        const l = auth && lib ? session.requireLib() : null;
        const result = await fn(l, ...args);
        return { ok: true, result };
      } catch (e) {
        if (!e.userFacing) console.error(`[ipc:${channel}]`, e);
        return { ok: false, error: e.userFacing ? e.message : `Unexpected error: ${e.message}`, code: e.code || 'ERROR' };
      }
    });
  };
  const win = () => getWindow();
  const toBuf = (x) => (x ? Buffer.from(x) : null);
  const mapPages = (pages) => (pages || []).map((p) => ({ jpg: toBuf(p.jpg), original: toBuf(p.original), edit: p.edit || null }));
  const recycle = async (p) => {
    try { await shell.trashItem(p); } catch {
      await fsp.rm(p, { recursive: true, force: true }); // drives without a Recycle Bin (some USB sticks)
    }
  };

  // ---------- auth & account ----------
  handle('auth:status', () => session.status(), { auth: false });
  handle('auth:register', (_l, data) => session.register(data), { auth: false });
  handle('auth:login', (_l, data) => session.login(data), { auth: false });
  handle('auth:resume', () => session.resume(), { auth: false });
  handle('auth:logout', () => session.logout(), { auth: false });
  handle('auth:changePassword', async (_l, { current, next }) => {
    await session.accounts.changePassword(session.user.id, current, next);
    // keep this device signed in if it was remembered
    if (session.config.getSecret('rememberToken')) session.config.setSecret('rememberToken', session.accounts.createRememberToken(session.user.id));
    return true;
  }, { lib: false });
  handle('auth:updateProfile', (_l, data) => { session.user = session.accounts.updateProfile(session.user.id, data); return session.status(); }, { lib: false });
  handle('auth:deleteAccount', (_l, { password, deleteFiles }) => session.deleteAccount(password, { deleteFiles, removeFn: recycle }), { lib: false });
  handle('auth:setShowUserList', (_l, v) => { session.config.set('showUserList', !!v); return true; }, { lib: false });

  // ---------- dialogs ----------
  handle('dialog:chooseFolder', async (_l, { title, defaultPath } = {}) => {
    const r = await dialog.showOpenDialog(win(), { title: title || 'Choose folder', defaultPath: defaultPath || app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  }, { auth: false });

  // ---------- storage ----------
  handle('storage:info', async () => {
    const user = session.user;
    const reachable = session.lib ? session.lib.isOnline() : false;
    return {
      libraryPath: user.libraryPath, libState: session.libState, libError: session.libError, reachable,
      usage: session.lib && reachable ? await session.lib.storageUsage() : null,
      sync: session.sync ? session.sync.state : null,
    };
  }, { lib: false });
  handle('storage:retry', () => { if (!session.lib) session.openLibrary(); else session.sync?.checkOnline(); return session.status(); }, { lib: false });
  handle('storage:openFolder', async (l, which = 'root') => {
    const p = { root: l.root, documents: l.docsDir, trash: l.trashDir, backups: l.backupsDir }[which] || l.root;
    const err = await shell.openPath(p);
    if (err) throw new S.AppError(err);
    return true;
  });
  handle('storage:relocate', (_l, { baseDir, keepOld }) => session.relocate(baseDir, { keepOld, onProgress: (p) => win()?.webContents.send('progress', { task: 'relocate', p }) }), { lib: false });
  handle('storage:locate', (_l, folder) => session.locate(folder), { lib: false });
  handle('storage:createNew', (_l, baseDir) => session.createNewLibrary(baseDir), { lib: false });

  // ---------- sync ----------
  handle('sync:status', () => session.sync?.state || null);
  handle('sync:run', () => session.sync.run());
  handle('sync:removeMissing', (l) => removeMissing(l));

  // ---------- settings ----------
  handle('settings:get', (l) => ({ ...l.getSettings(), launchAtStartup: app.getLoginItemSettings().openAtLogin, docTypes: l.docTypes() }));
  handle('settings:set', (l, patch) => {
    if (patch && 'launchAtStartup' in patch) {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtStartup, args: ['--hidden'] });
      delete patch.launchAtStartup;
    }
    return l.setSettings(patch || {});
  });

  // ---------- collections ----------
  handle('collections:list', (l, q) => l.listCollections(q || {}));
  handle('collections:get', (l, id) => l.getCollection(id));
  handle('collections:create', (l, data) => l.createCollection(data));
  handle('collections:update', (l, id, patch) => l.updateCollection(id, patch));
  handle('collections:delete', (l, id) => l.deleteCollection(id));
  handle('collections:restore', (l, id) => l.restoreCollection(id));

  // ---------- documents ----------
  handle('documents:list', (l, q) => l.listDocuments(q || {}));
  handle('documents:get', (l, id) => l.getDocument(id));
  handle('documents:create', (l, data) => l.createDocument({ ...data, pages: mapPages(data.pages) }));
  handle('documents:addPages', (l, id, pages, insertAt) => l.addPages(id, mapPages(pages), insertAt));
  handle('documents:update', (l, id, patch) => l.updateDocument(id, patch));
  handle('documents:delete', (l, ids) => l.deleteDocuments(ids));
  handle('documents:restore', (l, ids) => l.restoreDocuments(ids));
  handle('documents:reorder', (l, id, order) => l.reorderPages(id, order));
  handle('documents:regeneratePdf', (l, id, opts) => l.regeneratePdf(id, opts || {}));
  handle('documents:favorite', (l, ids, fav) => l.bulkSetFavorite(ids, fav));
  handle('documents:addTag', (l, ids, tag) => l.bulkAddTag(ids, tag));
  handle('documents:types', (l) => l.docTypes());
  handle('documents:tags', (l) => l.allTags());
  handle('documents:similar', (l, jpgs) => l.findSimilar((jpgs || []).map((b) => { try { return imaging.dhash(Buffer.from(b)); } catch { return null; } })));
  handle('pages:replace', (l, id, page) => l.replacePage(id, { jpg: toBuf(page.jpg), original: toBuf(page.original), edit: page.edit }));
  handle('pages:delete', (l, ids) => l.deletePages(ids));
  handle('pages:read', async (l, id, kind = 'page') => {
    const f = l.resolveFile(kind, id);
    if (!f || !fs.existsSync(f)) throw new S.AppError('File not found on disk.');
    return fsp.readFile(f);
  });

  handle('trash:list', (l) => l.listTrash());
  handle('trash:purge', (l, sel) => l.purge(sel || {}, recycle));
  handle('trash:empty', (l) => l.emptyTrash(recycle));

  handle('stats:get', (l) => ({ ...l.stats(), activity: l.activity(12) }));
  handle('duplicates:list', (l) => l.duplicates());

  // ---------- files: open, export, print, share ----------
  const docFile = (l, docId, kind, pageId) => {
    const d = l.getDocument(docId);
    if (kind === 'pdf') {
      if (!d.pdfFile) throw new S.AppError('This document has no PDF yet.');
      return path.join(d.path, d.pdfFile);
    }
    if (kind === 'folder') return d.path;
    if (kind === 'attachment') return l.resolveFile('attachment', pageId);
    const p = d.pages.find((x) => x.id === Number(pageId)) || d.pages[0];
    if (!p) throw new S.AppError('This document has no pages.');
    return path.join(d.path, p.file);
  };
  handle('files:open', async (l, docId, kind, pageId) => {
    const f = docFile(l, docId, kind, pageId);
    if (!fs.existsSync(f)) throw new S.AppError('File not found on disk. Try "Rescan" in Local Storage.');
    const err = await shell.openPath(f);
    if (err) throw new S.AppError(err);
    return true;
  });
  handle('files:showInFolder', (l, docId, kind = 'pdf', pageId) => {
    let f;
    try { f = docFile(l, docId, kind, pageId); } catch { f = docFile(l, docId, 'folder'); }
    if (!fs.existsSync(f)) f = docFile(l, docId, 'folder');
    shell.showItemInFolder(f);
    return true;
  });
  handle('files:saveAs', async (l, docId, kind, pageId, opts = {}) => {
    const d = l.getDocument(docId);
    if (kind === 'pdf') {
      const r = await dialog.showSaveDialog(win(), { defaultPath: path.join(app.getPath('downloads'), `${d.folder}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (r.canceled) return null;
      const custom = opts.compression || opts.mode || opts.dpi || opts.pageIds;
      if (!custom && d.pdfFile && d.pdfStatus === 'ok' && fs.existsSync(path.join(d.path, d.pdfFile))) await fsp.copyFile(path.join(d.path, d.pdfFile), r.filePath);
      else await fsp.writeFile(r.filePath, await l.pdfPreviewBytes(docId, opts));
      return r.filePath;
    }
    const p = d.pages.find((x) => x.id === Number(pageId)) || d.pages[0];
    if (!p) throw new S.AppError('No page to save.');
    const r = await dialog.showSaveDialog(win(), { defaultPath: path.join(app.getPath('downloads'), p.file.replace(/\.(png|jpe?g)$/i, '.jpg')), filters: [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }] });
    if (r.canceled) return null;
    const src = path.join(d.path, p.file);
    const q = Number(opts.quality) || 100;
    if (q < 100 || !/\.jpe?g$/i.test(p.file)) await fsp.writeFile(r.filePath, imaging.reencode(await fsp.readFile(src), { quality: Math.min(100, q) }));
    else await fsp.copyFile(src, r.filePath);
    return r.filePath;
  });
  handle('files:export', async (l, ids, opts = {}) => {
    const r = await dialog.showOpenDialog(win(), { title: 'Export to folder', defaultPath: app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    const res = await l.exportDocuments(ids, r.filePaths[0], opts);
    if (opts.reveal !== false) shell.openPath(r.filePaths[0]);
    return res;
  });
  handle('files:copyToClipboard', (l, docId, kind, pageId) => {
    const f = docFile(l, docId, kind, pageId);
    if (process.platform === 'win32') {
      clipboard.writeBuffer('FileNameW', Buffer.from(`${f}\0`, 'ucs2'));
    } else if (kind !== 'pdf') {
      const { nativeImage } = require('electron');
      clipboard.writeImage(nativeImage.createFromPath(f));
    } else clipboard.writeText(f);
    return true;
  });

  // PDF preview (opens Chromium's built-in viewer in a separate window)
  const previewDir = path.join(os.tmpdir(), 'smartscan-preview');
  const openPdfWindow = (file, title) => {
    const w = new BrowserWindow({ width: 900, height: 1000, title, parent: win() || undefined, autoHideMenuBar: true, webPreferences: { plugins: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
    w.loadURL(pathToFileURL(file).href);
    return true;
  };
  handle('pdf:previewDoc', async (l, docId, opts = {}) => {
    const d = l.getDocument(docId);
    const custom = opts.compression || opts.mode || opts.dpi || opts.pageIds;
    if (!custom && d.pdfFile && d.pdfStatus === 'ok' && fs.existsSync(path.join(d.path, d.pdfFile))) return openPdfWindow(path.join(d.path, d.pdfFile), d.title);
    const bytes = await l.pdfPreviewBytes(docId, opts);
    fs.mkdirSync(previewDir, { recursive: true });
    const f = path.join(previewDir, `preview_${Date.now()}.pdf`);
    await fsp.writeFile(f, bytes);
    return { opened: openPdfWindow(f, `Preview – ${d.title}`), size: bytes.length };
  });
  handle('pdf:previewPages', async (_l, pages, opts = {}) => {
    const { buildPdf } = require('./pdf');
    const input = (pages || []).map((p) => ({ bytes: Buffer.from(p.jpg), width: p.width, height: p.height }));
    const bytes = await buildPdf(input, { title: opts.title || 'Preview', mode: opts.mode, dpi: opts.dpi, compression: opts.compression }, imaging);
    fs.mkdirSync(previewDir, { recursive: true });
    const f = path.join(previewDir, `preview_${Date.now()}.pdf`);
    await fsp.writeFile(f, bytes);
    openPdfWindow(f, `Preview – ${opts.title || 'scan'}`);
    return { size: bytes.length };
  });

  // Printing: lay out page images (each with its own size) and show the system print dialog
  handle('print:documents', async (l, ids, pageIds) => {
    const imgs = [];
    for (const id of ids) {
      const d = l.getDocument(id);
      for (const p of d.pages) if (p.status === 'ok' && (!pageIds || pageIds.includes(p.id))) imgs.push(pathToFileURL(path.join(d.path, p.file)).href + `?v=${p.version}`);
    }
    if (!imgs.length) throw new S.AppError('Nothing to print.');
    fs.mkdirSync(previewDir, { recursive: true });
    const html = path.join(previewDir, `print_${Date.now()}.html`);
    await fsp.writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><style>
      @page{margin:8mm} html,body{margin:0;padding:0} .pg{page-break-after:always;break-after:page;height:calc(100vh - 2px);display:flex;align-items:center;justify-content:center}
      .pg:last-child{page-break-after:auto;break-after:auto} img{max-width:100%;max-height:100%;object-fit:contain}
      </style></head><body>${imgs.map((s) => `<div class="pg"><img src="${s.replace(/"/g, '&quot;')}"></div>`).join('')}</body></html>`);
    const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    await pw.loadURL(pathToFileURL(html).href);
    return new Promise((resolve) => {
      pw.webContents.print({ silent: false, printBackground: false }, (success, reason) => {
        pw.destroy();
        fs.rm(html, { force: true }, () => {});
        resolve({ success, reason: success ? null : reason });
      });
    });
  });

  // ---------- backup ----------
  handle('backup:create', async (l, opts = {}) => {
    const name = `SmartScan_Backup_${session.user.username}_${new Date().toISOString().slice(0, 10)}.ssbackup`;
    const r = await dialog.showSaveDialog(win(), { title: 'Save backup', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'SmartScan backup', extensions: ['ssbackup'] }] });
    if (r.canceled) return null;
    return backup.createBackup(l, r.filePath, { includeTrash: !!opts.includeTrash, onProgress: (p) => win()?.webContents.send('progress', { task: 'backup', p }) });
  });
  handle('backup:inspect', async () => {
    const r = await dialog.showOpenDialog(win(), { title: 'Choose backup', properties: ['openFile'], filters: [{ name: 'SmartScan backup', extensions: ['ssbackup', 'zip'] }] });
    if (r.canceled) return null;
    const manifest = await backup.readManifest(r.filePaths[0]);
    if (manifest.format !== 'smartscan-backup') throw new S.AppError('This file is not a SmartScan backup.');
    return { file: r.filePaths[0], manifest };
  });
  handle('backup:restore', async (l, file) => {
    if (!file || !fs.existsSync(file)) throw new S.AppError('Backup file not found.');
    const res = await backup.restoreBackup(l, file, session.hooks());
    session.sync?.schedule(100);
    return res;
  });
  handle('backup:listAuto', (l) => backup.listAutoBackups(l));
  handle('backup:autoNow', (l) => l.autoBackup(true));
  handle('backup:restoreAuto', async (l, name) => {
    await backup.restoreAutoBackup(l, name, session.hooks());
    const nl = session.requireLib();
    await backup.rebuildThumbs(nl);
    await reconcile(nl).catch(() => {});
    return true;
  });

  // ---------- scanner & phone ----------
  handle('scanner:list', () => scanner.listScanners(), { lib: false });
  handle('scanner:acquire', (_l, opts) => scanner.acquire(opts), { lib: false });
  const phone = new PhoneBridge(({ bytes }) => win()?.webContents.send('phone:image', bytes));
  handle('phone:start', () => phone.start(), { lib: false });
  handle('phone:stop', () => phone.stop(), { lib: false });

  // ---------- phone & web portal ----------
  const portal = () => { if (!session.portal) throw new S.AppError('Your library is not available.'); return session.portal; };
  handle('portal:status', () => portal().publicState());
  handle('portal:connect', (_l, data) => portal().connect(data));
  handle('portal:disconnect', () => portal().disconnect());
  handle('portal:pairing', async () => {
    const r = await portal().pairing();
    const QRCode = require('qrcode');
    return { ...r, qr: await QRCode.toDataURL(r.link, { margin: 1, width: 300, errorCorrectionLevel: 'M' }) };
  });
  handle('portal:revoke', (_l, id) => portal().revoke(id));
  handle('portal:resetKey', () => portal().resetKey());
  handle('portal:rename', (_l, label) => portal().rename(label));
  handle('portal:syncNow', () => portal().syncNow());

  // ---------- app ----------
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron, packaged: app.isPackaged, dataDir: app.getPath('userData') }), { auth: false });
  handle('app:checkUpdates', () => updater.check(), { auth: false });
  handle('app:installUpdate', () => updater.install(), { auth: false });

  return { phone };
}

module.exports = { register, DOC_TYPES };
