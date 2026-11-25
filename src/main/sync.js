'use strict';
/**
 * Two-way synchronisation between the library database and the real folders
 * on disk. Handles files/folders that were added, renamed or deleted outside
 * the app (e.g. in Windows Explorer). Never deletes user files: missing items
 * are only flagged, and the user decides whether to drop their records.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const S = require('./storage');
const { now } = require('./db');

const SETTLE_MS = 1500; // ignore files modified in the last moment (still being copied)

function listEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !S.isHiddenName(e.name) && !e.name.endsWith('.renaming') && !e.name.endsWith('.tmp'));
  } catch { return []; }
}
const humanName = (folder) => folder.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || folder;

function emptyReport() {
  return {
    startedAt: now(), finishedAt: null,
    addedCollections: [], addedDocuments: [], addedPages: 0, updatedPages: 0, renamed: [], missingPages: [], restoredPages: 0,
    missingFolders: [], duplicatesSkipped: [], skipped: [], pdfRegenerated: 0, attachmentsAdded: 0, errors: [],
  };
}

class SyncEngine {
  constructor(lib, onState) {
    this.lib = lib;
    this.onState = onState || (() => {});
    this.state = { status: 'idle', lastRun: null, report: null, watching: false };
    this.watcher = null; this.timer = null; this.poll = null; this.periodic = null;
    this.unsub = null;
  }

  setState(patch) { this.state = { ...this.state, ...patch }; this.onState(this.state); }

  start() {
    this.startWatcher();
    this.poll = setInterval(() => this.checkOnline(), 5000);
    this.periodic = setInterval(() => this.schedule(0), 10 * 60 * 1000);
    this.schedule(300);
  }

  stop() {
    clearTimeout(this.timer); clearInterval(this.poll); clearInterval(this.periodic);
    this.closeWatcher();
  }

  startWatcher() {
    this.closeWatcher();
    if (!this.lib.isOnline()) { this.setState({ status: 'offline', watching: false }); return; }
    try {
      this.watcher = fs.watch(this.lib.docsDir, { recursive: true }, (_evt, file) => {
        if (file && S.isHiddenName(path.basename(String(file)))) return;
        this.schedule(2000);
      });
      this.watcher.on('error', () => { this.closeWatcher(); this.checkOnline(); });
      this.setState({ watching: true });
    } catch {
      this.setState({ watching: false }); // fall back to periodic + manual rescan
    }
  }
  closeWatcher() { if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } this.watcher = null; } }

  checkOnline() {
    const online = this.lib.isOnline();
    if (!online && this.state.status !== 'offline') { this.closeWatcher(); this.setState({ status: 'offline', watching: false }); }
    else if (online && this.state.status === 'offline') { this.startWatcher(); this.schedule(200); }
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run().catch(() => {}), ms);
  }

  async run(opts = {}) {
    if (!this.lib.isOnline()) { this.setState({ status: 'offline' }); return { status: 'offline' }; }
    this.setState({ status: 'syncing' });
    try {
      const report = await reconcile(this.lib, opts);
      const attention = report.missingPages.length + report.missingFolders.length + report.errors.length;
      this.setState({ status: attention ? 'attention' : 'synced', lastRun: report.finishedAt, report });
      if (!this.watcher) this.startWatcher();
      return report;
    } catch (e) {
      const offline = !this.lib.isOnline();
      this.setState({ status: offline ? 'offline' : 'attention', report: { ...emptyReport(), errors: [e.message] } });
      throw e;
    }
  }
}

/** Find directories in `candidates` that hold any file with one of the given hashes. */
async function matchDirByContent(dir, candidates, wanted, sizes, depth = 2) {
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (await dirHasHash(p, wanted, sizes, depth)) return name;
  }
  return null;
}
async function dirHasHash(p, wanted, sizes, depth) {
  for (const e of listEntries(p)) {
    const full = path.join(p, e.name);
    if (e.isDirectory() && depth > 1) { if (await dirHasHash(full, wanted, sizes, depth - 1)) return true; }
    else if (e.isFile() && S.isImageFile(e.name)) {
      try {
        const st = fs.statSync(full);
        if (!sizes.has(st.size)) continue;
        if (wanted.has(await S.sha256File(full))) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

async function reconcile(lib, { regeneratePdfs = true } = {}) {
  return lib.lock.run(async () => {
    lib.requireOnline();
    const db = lib.db;
    const report = emptyReport();
    let changedAnything = false;

    // ---- 1. collection folders ----
    const cols = db.all('SELECT * FROM collections WHERE deleted_at IS NULL');
    const dirs = listEntries(lib.docsDir).filter((e) => e.isDirectory()).map((e) => e.name);
    const dirLower = new Map(dirs.map((d) => [d.toLowerCase(), d]));
    const mapped = new Set();
    const missingCols = [];
    for (const c of cols) {
      const actual = dirLower.get(c.folder.toLowerCase());
      if (actual) {
        mapped.add(actual.toLowerCase());
        if (actual !== c.folder) db.run('UPDATE collections SET folder=$f WHERE id=$id', { f: actual, id: c.id });
      } else missingCols.push(c);
    }
    let unknownDirs = dirs.filter((d) => !mapped.has(d.toLowerCase()));
    for (const c of missingCols) {
      const pages = db.all('SELECT p.sha256, p.file_size FROM pages p JOIN documents d ON d.id=p.document_id WHERE d.collection_id=$c AND p.sha256 IS NOT NULL', { c: c.id });
      const match = pages.length ? await matchDirByContent(lib.docsDir, unknownDirs, new Set(pages.map((p) => p.sha256)), new Set(pages.map((p) => p.file_size)), 2) : null;
      if (match) {
        db.run('UPDATE collections SET folder=$f, updated_at=$t WHERE id=$id', { f: match, t: now(), id: c.id });
        report.renamed.push(`Collection folder “${c.folder}” → “${match}”`);
        lib.log('sync', `Detected renamed folder ${c.folder} → ${match}`);
        unknownDirs = unknownDirs.filter((d) => d !== match);
        changedAnything = true;
      } else report.missingFolders.push(`Documents/${c.folder}`);
    }
    for (const dir of unknownDirs) {
      const name = humanName(dir);
      lib._createCollection({ name, kind: 'person', folder: dir, source: 'sync' });
      report.addedCollections.push(name);
      changedAnything = true;
    }

    // ---- 2. document folders inside each collection ----
    const liveCols = db.all('SELECT * FROM collections WHERE deleted_at IS NULL');
    for (const c of liveCols) {
      const colDir = path.join(lib.docsDir, c.folder);
      if (!fs.existsSync(colDir)) continue;
      const entries = listEntries(colDir);
      const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const loose = entries.filter((e) => e.isFile() && (S.isImageFile(e.name) || S.isPdfFile(e.name))).map((e) => e.name);
      for (const f of loose) report.skipped.push(`Documents/${c.folder}/${f} — put files inside a document folder to import them`);
      const sdLower = new Map(subdirs.map((d) => [d.toLowerCase(), d]));
      const docs = db.all('SELECT * FROM documents WHERE collection_id=$c AND deleted_at IS NULL', { c: c.id });
      const used = new Set();
      const missingDocs = [];
      for (const d of docs) {
        const actual = sdLower.get(d.folder.toLowerCase());
        if (actual) { used.add(actual.toLowerCase()); if (actual !== d.folder) db.run('UPDATE documents SET folder=$f WHERE id=$id', { f: actual, id: d.id }); }
        else missingDocs.push(d);
      }
      let unknown = subdirs.filter((s) => !used.has(s.toLowerCase()));
      for (const d of missingDocs) {
        const pages = db.all('SELECT sha256, file_size FROM pages WHERE document_id=$d AND sha256 IS NOT NULL', { d: d.id });
        const match = pages.length ? await matchDirByContent(colDir, unknown, new Set(pages.map((p) => p.sha256)), new Set(pages.map((p) => p.file_size)), 1) : null;
        if (match) {
          db.run('UPDATE documents SET folder=$f, updated_at=$t WHERE id=$id', { f: match, t: now(), id: d.id });
          report.renamed.push(`Document folder “${c.folder}/${d.folder}” → “${match}”`);
          unknown = unknown.filter((u) => u !== match);
          changedAnything = true;
        } else report.missingFolders.push(`Documents/${c.folder}/${d.folder}`);
      }
      for (const sub of unknown) {
        const files = listEntries(path.join(colDir, sub)).filter((e) => e.isFile() && (S.isImageFile(e.name) || S.isPdfFile(e.name)));
        if (!files.length) continue; // empty folders are ignored until they hold something
        const d = lib._insertDocument(c, { title: humanName(sub), docType: 'Other', source: 'imported', folder: sub });
        report.addedDocuments.push(`${c.name} / ${d.title}`);
        lib.log('sync', `Imported folder ${c.folder}/${sub} as a document`);
        changedAnything = true;
      }
    }

    // ---- 3. files inside each document folder ----
    const liveDocs = db.all('SELECT d.* FROM documents d JOIN collections c ON c.id=d.collection_id WHERE d.deleted_at IS NULL AND c.deleted_at IS NULL');
    for (const d of liveDocs) {
      try {
        const changed = await reconcileDocument(lib, d, report);
        if (changed.pages) await lib._afterPagesChanged(d.id, { pdf: regeneratePdfs });
        else if (changed.pdfMissing && regeneratePdfs && lib.getSettings().autoPdf) { await lib._buildPdf(d.id); report.pdfRegenerated++; }
        if (changed.pages || changed.pdfMissing) changedAnything = true;
      } catch (e) { report.errors.push(`${d.title}: ${e.message}`); }
    }

    report.finishedAt = now();
    if (changedAnything) {
      lib.log('sync', `Sync: +${report.addedPages} pages, ${report.addedDocuments.length} documents, ${report.addedCollections.length} collections, ${report.missingPages.length} missing`);
      lib.emit('changed');
    }
    return report;
  });
}

async function reconcileDocument(lib, d, report) {
  const db = lib.db;
  const dir = lib.documentPath(d);
  const result = { pages: false, pdfMissing: false };
  if (!fs.existsSync(dir)) {
    const n = db.run("UPDATE pages SET status='missing' WHERE document_id=$d AND status<>'missing'", { d: d.id }).changes;
    if (n) result.pages = false;
    return result;
  }
  const files = listEntries(dir).filter((e) => e.isFile()).map((e) => e.name);
  const fileLower = new Map(files.map((f) => [f.toLowerCase(), f]));
  const pages = db.all('SELECT * FROM pages WHERE document_id=$d ORDER BY position', { d: d.id });
  const claimed = new Set();
  const missing = [];
  const t = now();

  for (const p of pages) {
    const actual = fileLower.get(p.file.toLowerCase());
    if (!actual) { missing.push(p); continue; }
    claimed.add(actual.toLowerCase());
    const full = path.join(dir, actual);
    let st;
    try { st = fs.statSync(full); } catch { missing.push(p); continue; }
    const changedOnDisk = st.size !== p.file_size || Math.abs(Math.round(st.mtimeMs) - (p.mtime || 0)) > 2000;
    if (p.status === 'missing' || changedOnDisk || actual !== p.file) {
      if (t - st.mtimeMs < SETTLE_MS) continue;
      const buf = await fsp.readFile(full);
      const sha = S.sha256Buf(buf);
      const info = lib.imaging.imageInfo(buf) || {};
      if (sha !== p.sha256) { await lib.writeThumb(p.id, buf); report.updatedPages++; result.pages = true; }
      if (p.status === 'missing') { report.restoredPages++; result.pages = true; }
      db.run(`UPDATE pages SET file=$f, status='ok', file_size=$s, mtime=$m, sha256=$sha, width=$w, height=$h, phash=CASE WHEN $sha=sha256 THEN phash ELSE $ph END, updated_at=CASE WHEN $sha=sha256 THEN updated_at ELSE $t END WHERE id=$id`, {
        f: actual, s: st.size, m: Math.round(st.mtimeMs), sha, w: info.width || p.width, h: info.height || p.height, ph: sha !== p.sha256 ? lib.safeHash(buf) : p.phash, t, id: p.id,
      });
    }
  }

  // unknown images in folder: renamed pages, duplicates or new pages
  const unknownImgs = files.filter((f) => S.isImageFile(f) && !claimed.has(f.toLowerCase()));
  const hashes = new Map();
  for (const f of unknownImgs) {
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (t - st.mtimeMs < SETTLE_MS || st.size === 0) continue;
      hashes.set(f, { sha: await S.sha256File(full), st });
    } catch { /* vanished */ }
  }
  for (const p of missing) {
    const cands = [...hashes.entries()].filter(([, h]) => h.sha === p.sha256);
    // a rename keeps the modification time, a copy usually doesn't: prefer the matching one
    const hit = cands.find(([, h]) => Math.abs(Math.round(h.st.mtimeMs) - (p.mtime || 0)) < 2000) || cands[0];
    if (hit) {
      const [f, h] = hit;
      db.run("UPDATE pages SET file=$f, managed=0, status='ok', mtime=$m, file_size=$s WHERE id=$id", { f, m: Math.round(h.st.mtimeMs), s: h.st.size, id: p.id });
      hashes.delete(f);
      report.renamed.push(`${d.folder}/${p.file} → ${f}`);
      result.pages = true;
    } else if (p.status !== 'missing') {
      db.run("UPDATE pages SET status='missing' WHERE id=$id", { id: p.id });
      report.missingPages.push(`${d.folder}/${p.file}`);
      result.pages = true;
    } else report.missingPages.push(`${d.folder}/${p.file}`);
  }
  const existingShas = new Set(db.all("SELECT sha256 FROM pages WHERE document_id=$d AND status='ok'", { d: d.id }).map((r) => r.sha256));
  let pos = db.get('SELECT COALESCE(MAX(position),0) n FROM pages WHERE document_id=$d', { d: d.id }).n;
  const sortedNew = [...hashes.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const f of sortedNew) {
    const h = hashes.get(f);
    if (existingShas.has(h.sha)) { report.duplicatesSkipped.push(`${d.folder}/${f}`); continue; }
    const full = path.join(dir, f);
    const buf = await fsp.readFile(full);
    const type = S.detectImageType(buf);
    if (type !== 'jpeg' && type !== 'png') { report.skipped.push(`${d.folder}/${f} — not a valid JPG/PNG`); continue; }
    const info = lib.imaging.imageInfo(buf) || {};
    pos += 1;
    const r = db.run(`INSERT INTO pages(document_id,position,file,managed,width,height,file_size,mtime,sha256,phash,status,created_at,updated_at)
      VALUES($d,$p,$f,0,$w,$h,$s,$m,$sha,$ph,'ok',$t,$t)`, { d: d.id, p: pos, f, w: info.width || null, h: info.height || null, s: h.st.size, m: Math.round(h.st.mtimeMs), sha: h.sha, ph: lib.safeHash(buf), t });
    await lib.writeThumb(r.id, buf);
    existingShas.add(h.sha);
    report.addedPages++;
    result.pages = true;
  }

  // PDFs: our generated PDF, plus any other PDFs as attachments
  const pdfName = d.pdf_file;
  const pdfs = files.filter((f) => S.isPdfFile(f));
  const ourPdf = pdfName ? fileLower.get(pdfName.toLowerCase()) : null;
  if (pdfName && !ourPdf && d.pdf_status !== 'none') {
    db.run("UPDATE documents SET pdf_status='missing' WHERE id=$id", { id: d.id });
    result.pdfMissing = true;
  } else if (!pdfName && !pages.length && pdfs.length === 0) { /* nothing */ }
  const atts = db.all('SELECT * FROM attachments WHERE document_id=$d', { d: d.id });
  const attLower = new Map(atts.map((a) => [a.file.toLowerCase(), a]));
  for (const f of pdfs) {
    if (ourPdf && f.toLowerCase() === ourPdf.toLowerCase()) continue;
    if (!pdfName && f.toLowerCase() === `${d.folder}.pdf`.toLowerCase() && !db.get('SELECT 1 FROM pages WHERE document_id=$d', { d: d.id })) {
      // a document folder holding only its PDF: adopt it as the document's PDF
      const st = fs.statSync(path.join(dir, f));
      db.run("UPDATE documents SET pdf_file=$f, pdf_size=$s, pdf_status='ok' WHERE id=$id", { f, s: st.size, id: d.id });
      continue;
    }
    if (attLower.has(f.toLowerCase())) { attLower.delete(f.toLowerCase()); continue; }
    const st = fs.statSync(path.join(dir, f));
    db.run("INSERT INTO attachments(document_id,file,file_size,mtime,status,created_at) VALUES($d,$f,$s,$m,'ok',$t)", { d: d.id, f, s: st.size, m: Math.round(st.mtimeMs), t });
    report.attachmentsAdded++;
  }
  for (const a of attLower.values()) db.run('DELETE FROM attachments WHERE id=$id', { id: a.id }); // the user removed it
  if (report.attachmentsAdded) db.run('UPDATE documents SET updated_at=$t WHERE id=$id', { t, id: d.id });
  return result;
}

/** Drop database records for pages whose files were deleted outside the app. */
function removeMissing(lib) {
  return lib.mutate(async () => {
    const rows = lib.db.all("SELECT p.* FROM pages p WHERE p.status='missing'");
    const docs = new Set();
    for (const p of rows) {
      lib.db.run('DELETE FROM pages WHERE id=$id', { id: p.id });
      fs.rmSync(lib.thumbPath(p.id), { force: true });
      docs.add(p.document_id);
    }
    for (const id of docs) { const d = lib.getDocRow(id); if (d && !d.deleted_at && fs.existsSync(lib.documentPath(d))) await lib._afterPagesChanged(id); }
    lib.log('sync', `Removed ${rows.length} missing page record(s)`);
    return rows.length;
  });
}

module.exports = { SyncEngine, reconcile, removeMissing };
