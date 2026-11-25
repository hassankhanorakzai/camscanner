'use strict';
/**
 * Backup = a single .ssbackup (zip) file with a manifest, a consistent DB
 * snapshot, original captures and every document file. Restore keeps the
 * previous state in a "Restore_Previous_<date>" folder — nothing is deleted.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const yazl = require('yazl');
const yauzl = require('yauzl');
const S = require('./storage');
const { stamp } = require('./library');

const FORMAT = 'smartscan-backup';

function walkFiles(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else if (e.isFile() && !e.name.endsWith('.tmp')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

async function createBackup(lib, destFile, { includeTrash = false, onProgress } = {}) {
  return lib.lock.run(async () => {
    lib.requireOnline();
    const tmpDb = path.join(lib.backupsDir, `.snapshot_${Date.now()}.db`);
    lib.db.snapshot(tmpDb);
    try {
      const zip = new yazl.ZipFile();
      const parts = [['Documents', lib.docsDir], ['Database/originals', lib.originalsDir]];
      if (includeTrash) parts.push(['Trash', lib.trashDir]);
      const files = [];
      for (const [prefix, dir] of parts) for (const rel of walkFiles(dir)) files.push([`${prefix}/${rel}`, path.join(dir, ...rel.split('/'))]);
      const manifest = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), libraryId: lib.libraryId, username: lib.username, files: files.length, stats: lib.stats() };
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
      zip.addFile(tmpDb, 'Database/library.db');
      let i = 0;
      for (const [name, full] of files) {
        // JPG/PDF are already compressed; store them to keep backups fast on slow PCs
        zip.addFile(full, name, { compress: !/\.(jpe?g|png|pdf)$/i.test(name) });
        if (onProgress && ++i % 25 === 0) onProgress(i / files.length);
      }
      zip.end();
      const tmpOut = destFile + '.partial';
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmpOut);
        zip.outputStream.pipe(ws).on('close', resolve).on('error', reject);
        zip.outputStream.on('error', reject);
      });
      await S.withRetry(() => fsp.rename(tmpOut, destFile));
      lib.log('backup', `Backup created: ${destFile}`);
      return { file: destFile, files: files.length, size: fs.statSync(destFile).size };
    } finally {
      fs.rmSync(tmpDb, { force: true });
    }
  });
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (e, z) => (e ? reject(e) : resolve(z))));
}

function safeEntryName(name) {
  const n = String(name).replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').some((s) => s === '..' || s === '')) return null;
  const allowed = n === 'manifest.json' || n === 'Database/library.db' || /^(Documents|Trash|Database\/originals)\/.+/.test(n);
  return allowed ? n : null;
}

async function readManifest(file) {
  const zip = await openZip(file);
  try {
    return await new Promise((resolve, reject) => {
      zip.on('entry', (entry) => {
        if (entry.fileName !== 'manifest.json') return zip.readEntry();
        zip.openReadStream(entry, (err, rs) => {
          if (err) return reject(err);
          const chunks = [];
          rs.on('data', (c) => chunks.push(c)).on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
          }).on('error', reject);
        });
      });
      zip.on('end', () => reject(new S.AppError('This file is not a SmartScan backup.')));
      zip.on('error', reject);
      zip.readEntry();
    });
  } finally { zip.close(); }
}

async function extractTo(file, dest, onProgress) {
  const zip = await openZip(file);
  let count = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        const name = safeEntryName(entry.fileName);
        if (!name) return reject(new S.AppError(`Backup contains an unsafe entry: ${entry.fileName}`));
        const out = S.resolveInside(dest, ...name.split('/'));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        zip.openReadStream(entry, (err, rs) => {
          if (err) return reject(err);
          const ws = fs.createWriteStream(out);
          rs.pipe(ws).on('close', () => { count++; if (onProgress && count % 25 === 0) onProgress(count); zip.readEntry(); }).on('error', reject);
          rs.on('error', reject);
        });
      });
      zip.on('end', resolve);
      zip.on('error', reject);
      zip.readEntry();
    });
  } finally { zip.close(); }
  return count;
}

/**
 * Restore a backup into the user's library. `reopen` closes and re-opens the
 * library around the swap (provided by the session manager).
 */
async function restoreBackup(lib, file, { closeLibrary, reopenLibrary }) {
  const manifest = await readManifest(file);
  if (manifest.format !== FORMAT) throw new S.AppError('This file is not a SmartScan backup.');
  if (manifest.libraryId !== lib.libraryId && manifest.username !== lib.username) {
    // allowed (e.g. moving to a new PC) but the caller already confirmed with the user
  }
  const root = lib.root;
  const work = path.join(root, `.restore_${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    await extractTo(file, work);
    if (!fs.existsSync(path.join(work, 'Database', 'library.db'))) throw new S.AppError('Backup is missing its database.');
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true });
    throw e;
  }
  await closeLibrary();
  const prev = path.join(root, `Restore_Previous_${stamp()}`);
  fs.mkdirSync(prev, { recursive: true });
  try {
    for (const name of ['Documents', 'Database']) {
      if (fs.existsSync(path.join(root, name))) await S.moveDir(path.join(root, name), path.join(prev, name));
    }
    await S.moveDir(path.join(work, 'Documents'), path.join(root, 'Documents')).catch(() => fs.mkdirSync(path.join(root, 'Documents'), { recursive: true }));
    fs.mkdirSync(path.join(root, 'Database'), { recursive: true });
    await fsp.rename(path.join(work, 'Database', 'library.db'), path.join(root, 'Database', 'library.db'));
    if (fs.existsSync(path.join(work, 'Database', 'originals'))) await S.moveDir(path.join(work, 'Database', 'originals'), path.join(root, 'Database', 'originals'));
    if (fs.existsSync(path.join(work, 'Trash'))) {
      for (const e of fs.readdirSync(path.join(work, 'Trash'))) {
        const target = path.join(root, 'Trash', e);
        if (!fs.existsSync(target)) await S.moveDir(path.join(work, 'Trash', e), target);
      }
    }
  } catch (e) {
    // put the previous state back
    for (const name of ['Documents', 'Database']) {
      if (fs.existsSync(path.join(prev, name))) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
        await S.moveDir(path.join(prev, name), path.join(root, name));
      }
    }
    await reopenLibrary();
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  // fix the library id inside the restored DB so it matches this account
  const newLib = await reopenLibrary();
  newLib.db.run("INSERT INTO meta(key,value) VALUES('libraryId',$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value", { v: newLib.libraryId });
  // thumbnails are a cache: rebuild them for all pages
  await rebuildThumbs(newLib);
  newLib.log('backup', `Restored backup from ${manifest.createdAt}. Previous data kept in ${path.basename(prev)}`);
  return { previous: prev, manifest };
}

async function rebuildThumbs(lib) {
  for (const p of lib.db.all("SELECT * FROM pages WHERE status='ok'")) {
    try {
      const f = lib.pagePath(p);
      if (fs.existsSync(f) && !fs.existsSync(lib.thumbPath(p.id))) await lib.writeThumb(p.id, await fsp.readFile(f));
    } catch { /* ignore */ }
  }
}

function listAutoBackups(lib) {
  const dir = path.join(lib.backupsDir, 'auto');
  try {
    return fs.readdirSync(dir).filter((f) => /^library_.*\.db$/.test(f)).sort().reverse()
      .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, size: st.size, at: st.mtimeMs }; });
  } catch { return []; }
}

/** Restore only the database from an automatic snapshot, then reconcile with files. */
async function restoreAutoBackup(lib, name, { closeLibrary, reopenLibrary }) {
  if (!/^library_[\d_-]+\.db$/.test(name)) throw new S.AppError('Invalid backup name.');
  const src = S.resolveInside(path.join(lib.backupsDir, 'auto'), name);
  if (!fs.existsSync(src)) throw new S.AppError('Backup not found.');
  const dbFile = path.join(lib.dbDir, 'library.db');
  lib.autoBackup(true); // snapshot current state first
  await closeLibrary();
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  await fsp.copyFile(src, dbFile);
  return reopenLibrary();
}

module.exports = { createBackup, restoreBackup, readManifest, listAutoBackups, restoreAutoBackup, safeEntryName, rebuildThumbs };
