'use strict';
/**
 * A user's document library: one folder on a local/external drive containing
 *   Database/   library.db, thumbs/, originals/
 *   Documents/  <Collection>/<Document>/<Document>_Page_01.jpg, <Document>.pdf
 *   Trash/      items deleted in the app (restorable)
 *   Backups/    automatic database snapshots and manual backups
 * Every JPG/PDF is a real file the user can open from Windows Explorer.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Database, now } = require('./db');
const S = require('./storage');
const { buildPdf } = require('./pdf');

const { AppError } = S;

const MIGRATIONS = [
  `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE collections(
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'person',
     folder TEXT NOT NULL,
     notes TEXT NOT NULL DEFAULT '',
     favorite INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     trash_folder TEXT
   );
   CREATE TABLE documents(
     id INTEGER PRIMARY KEY,
     collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     doc_type TEXT NOT NULL DEFAULT 'Other',
     folder TEXT NOT NULL,
     pdf_file TEXT,
     pdf_size INTEGER,
     pdf_status TEXT NOT NULL DEFAULT 'none',
     pdf_mode TEXT NOT NULL DEFAULT 'dpi',
     pdf_dpi INTEGER NOT NULL DEFAULT 200,
     pdf_compression TEXT NOT NULL DEFAULT 'original',
     notes TEXT NOT NULL DEFAULT '',
     favorite INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL DEFAULT 'scan',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     trash_folder TEXT
   );
   CREATE TABLE pages(
     id INTEGER PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     file TEXT NOT NULL,
     managed INTEGER NOT NULL DEFAULT 1,
     original TEXT,
     width INTEGER, height INTEGER,
     file_size INTEGER, mtime INTEGER,
     sha256 TEXT, phash TEXT,
     edit TEXT,
     status TEXT NOT NULL DEFAULT 'ok',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE attachments(
     id INTEGER PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     file TEXT NOT NULL,
     file_size INTEGER, mtime INTEGER, sha256 TEXT,
     status TEXT NOT NULL DEFAULT 'ok',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
   CREATE TABLE document_tags(
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
     PRIMARY KEY(document_id, tag_id)
   );
   CREATE TABLE activity(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
   CREATE INDEX idx_docs_collection ON documents(collection_id);
   CREATE INDEX idx_pages_doc ON pages(document_id, position);
   CREATE INDEX idx_pages_sha ON pages(sha256);
   CREATE INDEX idx_att_doc ON attachments(document_id);`,
];

const DEFAULT_SETTINGS = {
  jpgQuality: 92,
  autoPdf: true,
  defaultFilter: 'enhance',
  pdfMode: 'dpi',
  pdfDpi: 200,
  pdfCompression: 'original',
  autoCapture: false,
  cameraResolution: '1080',
  autoBackup: true,
  autoBackupKeep: 10,
  theme: 'light',
  defaultSort: 'updated',
};

const DOC_TYPES = ['CNIC Front', 'CNIC Back', 'CNIC', 'ID Card', 'Passport', 'Driving License', 'Educational Certificate', 'Experience Certificate', 'Certificate', 'Receipt', 'Invoice', 'Bank Statement', 'Letter', 'Contract', 'Medical', 'Photo', 'Other'];

const MARKER = '.smartscan-library.json';

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const r = this.p.then(fn, fn);
    this.p = r.catch(() => {});
    return r;
  }
}

class Library {
  /** @param {{root:string,userId:number,libraryId:string,username:string}} opts */
  constructor({ root, userId, libraryId, username }, imaging) {
    this.root = path.resolve(root);
    this.userId = userId;
    this.libraryId = libraryId;
    this.username = username;
    this.imaging = imaging;
    this.lock = new Mutex();
    this.db = null;
    this.listeners = new Set();
  }

  // ---------- lifecycle ----------
  get docsDir() { return path.join(this.root, 'Documents'); }
  get dbDir() { return path.join(this.root, 'Database'); }
  get thumbsDir() { return path.join(this.dbDir, 'thumbs'); }
  get originalsDir() { return path.join(this.dbDir, 'originals'); }
  get trashDir() { return path.join(this.root, 'Trash'); }
  get backupsDir() { return path.join(this.root, 'Backups'); }

  /** Check the library folder exists and belongs to this user. Returns 'ok' | 'offline' | 'foreign'. */
  static probe(root, libraryId) {
    const parent = path.dirname(root);
    const markerFile = path.join(root, MARKER);
    if (fs.existsSync(markerFile)) {
      try {
        const m = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        return m.libraryId === libraryId ? 'ok' : 'foreign';
      } catch { return 'foreign'; }
    }
    if (fs.existsSync(root)) {
      const entries = fs.readdirSync(root).filter((n) => !S.isHiddenName(n));
      return entries.length === 0 ? 'new' : 'foreign';
    }
    // Folder doesn't exist: can we create it (drive present)?
    let p = parent;
    while (p && !fs.existsSync(p)) { const up = path.dirname(p); if (up === p) break; p = up; }
    return S.isReachable(p) ? 'new' : 'offline';
  }

  open() {
    const state = Library.probe(this.root, this.libraryId);
    if (state === 'offline') throw new AppError(`Storage location is not available: ${this.root}`, 'STORAGE_OFFLINE');
    if (state === 'foreign') throw new AppError(`The folder ${this.root} belongs to a different SmartScan library.`, 'STORAGE_FOREIGN');
    for (const d of [this.root, this.docsDir, this.dbDir, this.thumbsDir, this.originalsDir, this.trashDir, this.backupsDir]) fs.mkdirSync(d, { recursive: true });
    const markerFile = path.join(this.root, MARKER);
    if (!fs.existsSync(markerFile)) {
      fs.writeFileSync(markerFile, JSON.stringify({ app: 'SmartScan', format: 1, libraryId: this.libraryId, userId: this.userId, username: this.username, createdAt: new Date().toISOString() }, null, 2));
      if (process.platform === 'win32') { try { require('node:child_process').execFile('attrib', ['+h', markerFile]); } catch { /* cosmetic */ } }
    }
    const readme = path.join(this.root, 'README.txt');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, 'SmartScan library\r\n\r\nDocuments\\  Your scanned documents (JPG + PDF), organised by person/collection.\r\nTrash\\      Items deleted inside SmartScan (restore them from the Trash screen).\r\nBackups\\    Automatic database backups.\r\nDatabase\\   SmartScan index, thumbnails and original captures. Do not edit.\r\n\r\nYou may add images (.jpg/.png) or PDFs into a document folder; use "Rescan" in SmartScan to pick them up.\r\n');
    }
    this.db = new Database(path.join(this.dbDir, 'library.db'), MIGRATIONS);
    if (!this.db.get("SELECT value FROM meta WHERE key='libraryId'")) {
      this.db.run("INSERT INTO meta(key,value) VALUES('libraryId',$v)", { v: this.libraryId });
    }
    return this;
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
  isOnline() { return S.isReachable(this.root) && S.isReachable(this.docsDir); }
  requireOnline() {
    if (!this.isOnline()) throw new AppError('Your storage drive is not connected. Reconnect it and try again.', 'STORAGE_OFFLINE');
  }
  emit(evt, data) { for (const l of this.listeners) { try { l(evt, data); } catch { /* ignore */ } } }
  log(kind, message) {
    this.db.run('INSERT INTO activity(at,kind,message) VALUES($a,$k,$m)', { a: now(), k: kind, m: String(message).slice(0, 500) });
    this.db.run('DELETE FROM activity WHERE id < (SELECT MAX(id) - 1000 FROM activity)');
  }
  /** Run a mutating operation: serialised, online-checked, emits a change event. */
  mutate(fn) {
    return this.lock.run(async () => {
      this.requireOnline();
      const r = await fn();
      this.emit('changed');
      return r;
    });
  }

  // ---------- settings ----------
  getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const r of this.db.all('SELECT key, value FROM settings')) {
      if (r.key in DEFAULT_SETTINGS) { try { out[r.key] = JSON.parse(r.value); } catch { /* ignore */ } }
    }
    return out;
  }
  setSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    this.db.tx(() => {
      for (const [k, v] of Object.entries(patch || {})) {
        if (!allowed.includes(k)) continue;
        if (typeof v !== typeof DEFAULT_SETTINGS[k]) throw new AppError(`Invalid value for ${k}`);
        this.db.run('INSERT INTO settings(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value', { k, v: JSON.stringify(v) });
      }
    });
    return this.getSettings();
  }

  // ---------- path helpers ----------
  collectionPath(c) { return S.resolveInside(this.docsDir, c.folder); }
  documentPath(d, c) {
    c = c || this.db.get('SELECT * FROM collections WHERE id=$id', { id: d.collection_id });
    return S.resolveInside(this.docsDir, c.folder, d.folder);
  }
  pagePath(p, d, c) {
    d = d || this.db.get('SELECT * FROM documents WHERE id=$id', { id: p.document_id });
    return S.resolveInside(this.documentPath(d, c), p.file);
  }
  thumbPath(pageId) { return path.join(this.thumbsDir, `p${Number(pageId)}.jpg`); }
  originalPath(p) { return p.original ? S.resolveInside(this.originalsDir, p.original) : null; }

  /** Resolve a file for the app:// protocol. Only ids from this user's DB are accepted. */
  resolveFile(kind, id) {
    id = Number(id);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (kind === 'pdf') {
      const d = this.getDocRow(id);
      if (!d?.pdf_file || d.deleted_at) return null;
      return S.resolveInside(this.documentPath(d), d.pdf_file);
    }
    if (kind === 'attachment') {
      const a = this.db.get('SELECT * FROM attachments WHERE id=$id', { id });
      if (!a) return null;
      return S.resolveInside(this.documentPath(this.getDocRow(a.document_id)), a.file);
    }
    const p = this.db.get('SELECT * FROM pages WHERE id=$id', { id });
    if (!p) return null;
    if (kind === 'thumb') return this.thumbPath(id);
    if (kind === 'original') return this.originalPath(p) && fs.existsSync(this.originalPath(p)) ? this.originalPath(p) : this.pagePath(p);
    return this.pagePath(p);
  }

  getDocRow(id) { return this.db.get('SELECT * FROM documents WHERE id=$id', { id: Number(id) }); }
  getColRow(id) { return this.db.get('SELECT * FROM collections WHERE id=$id', { id: Number(id) }); }
  mustDoc(id) { const d = this.getDocRow(id); if (!d || d.deleted_at) throw new AppError('Document not found.'); return d; }
  mustCol(id) { const c = this.getColRow(id); if (!c || c.deleted_at) throw new AppError('Collection not found.'); return c; }

  // ---------- collections ----------
  listCollections({ search = '', favorites = false, kind = '' } = {}) {
    const q = `%${String(search).trim()}%`;
    const rows = this.db.all(`
      SELECT c.*,
        (SELECT COUNT(*) FROM documents d WHERE d.collection_id=c.id AND d.deleted_at IS NULL) doc_count,
        (SELECT COUNT(*) FROM pages p JOIN documents d ON d.id=p.document_id WHERE d.collection_id=c.id AND d.deleted_at IS NULL) page_count,
        (SELECT p.id FROM pages p JOIN documents d ON d.id=p.document_id WHERE d.collection_id=c.id AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, p.position LIMIT 1) cover_page_id,
        (SELECT MAX(d.updated_at) FROM documents d WHERE d.collection_id=c.id AND d.deleted_at IS NULL) last_doc_at
      FROM collections c
      WHERE c.deleted_at IS NULL
        AND ($q = '%%' OR c.name LIKE $q OR c.notes LIKE $q OR EXISTS (SELECT 1 FROM documents d WHERE d.collection_id=c.id AND d.deleted_at IS NULL AND (d.title LIKE $q OR d.doc_type LIKE $q)))
        AND ($fav = 0 OR c.favorite = 1)
        AND ($kind = '' OR c.kind = $kind)
      ORDER BY c.name COLLATE NOCASE`, { q, fav: favorites ? 1 : 0, kind });
    return rows.map((r) => this.colOut(r));
  }

  colOut(c) {
    return {
      id: c.id, name: c.name, kind: c.kind, folder: c.folder, notes: c.notes, favorite: !!c.favorite,
      createdAt: c.created_at, updatedAt: Math.max(c.updated_at, c.last_doc_at || 0), deletedAt: c.deleted_at,
      docCount: c.doc_count ?? 0, pageCount: c.page_count ?? 0, coverPageId: c.cover_page_id ?? null,
    };
  }

  getCollection(id) {
    const c = this.mustCol(id);
    return { ...this.colOut({ ...c, ...this.db.get(`SELECT
      (SELECT COUNT(*) FROM documents d WHERE d.collection_id=$id AND d.deleted_at IS NULL) doc_count,
      (SELECT COUNT(*) FROM pages p JOIN documents d ON d.id=p.document_id WHERE d.collection_id=$id AND d.deleted_at IS NULL) page_count`, { id: c.id }) }), path: this.collectionPath(c) };
  }

  takenCollectionFolders() { return this.db.all('SELECT folder FROM collections WHERE deleted_at IS NULL').map((r) => r.folder); }

  createCollection({ name, kind = 'person', notes = '' }) {
    return this.mutate(() => this._createCollection({ name, kind, notes }));
  }
  _createCollection({ name, kind = 'person', notes = '', folder = null, source = 'app' }) {
    const clean = String(name || '').trim().slice(0, 120);
    if (!clean) throw new AppError('Please enter a name.');
    if (!['person', 'folder'].includes(kind)) kind = 'person';
    if (!folder) folder = S.uniqueSegment(this.docsDir, S.safeSegment(clean), this.takenCollectionFolders());
    fs.mkdirSync(S.resolveInside(this.docsDir, folder), { recursive: true });
    const t = now();
    const r = this.db.run('INSERT INTO collections(name,kind,folder,notes,created_at,updated_at) VALUES($n,$k,$f,$no,$t,$t)', { n: clean, k: kind, f: folder, no: String(notes).slice(0, 5000), t });
    this.log('collection', `${source === 'sync' ? 'Imported' : 'Created'} collection “${clean}”`);
    return this.getCollection(r.id);
  }

  updateCollection(id, patch) {
    return this.mutate(async () => {
      const c = this.mustCol(id);
      const t = now();
      if (patch.name != null && String(patch.name).trim() !== c.name) {
        const name = String(patch.name).trim().slice(0, 120);
        if (!name) throw new AppError('Name cannot be empty.');
        const seg = S.safeSegment(name);
        let folder = c.folder;
        if (seg.toLowerCase() !== c.folder.toLowerCase()) {
          folder = S.uniqueSegment(this.docsDir, seg, this.takenCollectionFolders().filter((f) => f !== c.folder));
          const from = this.collectionPath(c);
          const to = S.resolveInside(this.docsDir, folder);
          if (fs.existsSync(from)) await S.withRetry(() => fsp.rename(from, to));
          else fs.mkdirSync(to, { recursive: true });
        } else if (seg !== c.folder) {
          // case-only rename (Windows is case-insensitive): go through a temp name
          const from = this.collectionPath(c);
          const tmp = from + '.renaming';
          await S.withRetry(() => fsp.rename(from, tmp));
          await S.withRetry(() => fsp.rename(tmp, S.resolveInside(this.docsDir, seg)));
          folder = seg;
        }
        this.db.run('UPDATE collections SET name=$n, folder=$f, updated_at=$t WHERE id=$id', { n: name, f: folder, t, id: c.id });
        this.log('collection', `Renamed “${c.name}” to “${name}”`);
      }
      if (patch.notes != null) this.db.run('UPDATE collections SET notes=$n, updated_at=$t WHERE id=$id', { n: String(patch.notes).slice(0, 5000), t, id: c.id });
      if (patch.favorite != null) this.db.run('UPDATE collections SET favorite=$f WHERE id=$id', { f: patch.favorite ? 1 : 0, id: c.id });
      if (patch.kind && ['person', 'folder'].includes(patch.kind)) this.db.run('UPDATE collections SET kind=$k WHERE id=$id', { k: patch.kind, id: c.id });
      return this.getCollection(c.id);
    });
  }

  trashName(seg) { return S.uniqueSegment(this.trashDir, `${stamp()}_${seg}`); }

  deleteCollection(id) {
    return this.mutate(async () => {
      const c = this.mustCol(id);
      const from = this.collectionPath(c);
      const trash = this.trashName(c.folder);
      if (fs.existsSync(from)) await S.moveDir(from, S.resolveInside(this.trashDir, trash));
      this.db.run('UPDATE collections SET deleted_at=$t, trash_folder=$tf WHERE id=$id', { t: now(), tf: trash, id: c.id });
      this.log('trash', `Moved collection “${c.name}” to Trash`);
      return true;
    });
  }

  async _restoreCollectionRow(c) {
    const folder = S.uniqueSegment(this.docsDir, c.folder, this.takenCollectionFolders());
    const src = c.trash_folder ? S.resolveInside(this.trashDir, c.trash_folder) : null;
    const dest = S.resolveInside(this.docsDir, folder);
    if (src && fs.existsSync(src)) await S.moveDir(src, dest); else fs.mkdirSync(dest, { recursive: true });
    this.db.run('UPDATE collections SET deleted_at=NULL, trash_folder=NULL, folder=$f, updated_at=$t WHERE id=$id', { f: folder, t: now(), id: c.id });
  }

  restoreCollection(id) {
    return this.mutate(async () => {
      const c = this.getColRow(id);
      if (!c || !c.deleted_at) throw new AppError('Collection is not in Trash.');
      await this._restoreCollectionRow(c);
      this.log('trash', `Restored collection “${c.name}”`);
      return this.getCollection(c.id);
    });
  }

  // ---------- documents ----------
  docOut(d) {
    return {
      id: d.id, collectionId: d.collection_id, collectionName: d.collection_name, collectionKind: d.collection_kind,
      title: d.title, docType: d.doc_type, folder: d.folder, notes: d.notes, favorite: !!d.favorite, source: d.source,
      pdfFile: d.pdf_file, pdfSize: d.pdf_size, pdfStatus: d.pdf_status, pdfMode: d.pdf_mode, pdfDpi: d.pdf_dpi, pdfCompression: d.pdf_compression,
      createdAt: d.created_at, updatedAt: d.updated_at, deletedAt: d.deleted_at,
      pageCount: d.page_count ?? 0, missingCount: d.missing_count ?? 0, coverPageId: d.cover_page_id ?? null, coverVersion: d.cover_version ?? 0,
      attachmentCount: d.attachment_count ?? 0,
      tags: d.tag_list ? String(d.tag_list).split('\u001f') : [],
      hasJpg: (d.page_count ?? 0) > 0, hasPdf: d.pdf_status === 'ok' || d.pdf_status === 'stale',
    };
  }

  listDocuments({ collectionId = null, search = '', docType = '', tag = '', favorites = false, sort = 'updated', hasPdf = null, sinceDays = 0, limit = 5000, ids = null } = {}) {
    const q = `%${String(search).trim()}%`;
    const order = {
      updated: 'd.updated_at DESC', created: 'd.created_at DESC', title: 'd.title COLLATE NOCASE ASC', name: 'c.name COLLATE NOCASE ASC, d.title COLLATE NOCASE',
      pages: 'page_count DESC', type: 'd.doc_type COLLATE NOCASE, d.title COLLATE NOCASE',
    }[sort] || 'd.updated_at DESC';
    const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : null;
    const rows = this.db.all(`
      SELECT d.*, c.name collection_name, c.kind collection_kind,
        (SELECT COUNT(*) FROM pages p WHERE p.document_id=d.id) page_count,
        (SELECT COUNT(*) FROM pages p WHERE p.document_id=d.id AND p.status='missing') missing_count,
        (SELECT p.id FROM pages p WHERE p.document_id=d.id ORDER BY p.position LIMIT 1) cover_page_id,
        (SELECT p.updated_at FROM pages p WHERE p.document_id=d.id ORDER BY p.position LIMIT 1) cover_version,
        (SELECT COUNT(*) FROM attachments a WHERE a.document_id=d.id) attachment_count,
        (SELECT group_concat(t.name, char(31)) FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id) tag_list
      FROM documents d JOIN collections c ON c.id=d.collection_id
      WHERE d.deleted_at IS NULL AND c.deleted_at IS NULL
        AND ($cid = 0 OR d.collection_id = $cid)
        AND ($q = '%%' OR d.title LIKE $q OR c.name LIKE $q OR d.doc_type LIKE $q OR d.notes LIKE $q
             OR EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id AND t.name LIKE $q))
        AND ($type = '' OR d.doc_type = $type)
        AND ($tag = '' OR EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id AND t.name = $tag))
        AND ($fav = 0 OR d.favorite = 1)
        AND ($pdf = -1 OR ($pdf = 1 AND d.pdf_status IN ('ok','stale')) OR ($pdf = 0 AND d.pdf_status NOT IN ('ok','stale')))
        AND ($since = 0 OR d.created_at >= $since OR d.updated_at >= $since)
        AND ($ids = '' OR d.id IN (SELECT value FROM json_each($ids)))
      ORDER BY ${order} LIMIT $limit`, {
      cid: Number(collectionId) || 0, q, type: docType || '', tag: tag || '', fav: favorites ? 1 : 0,
      pdf: hasPdf === null || hasPdf === undefined ? -1 : hasPdf ? 1 : 0,
      since: sinceDays ? now() - sinceDays * 864e5 : 0, limit: Math.min(10000, Number(limit) || 5000),
      ids: idList ? JSON.stringify(idList) : '',
    });
    return rows.map((r) => this.docOut(r));
  }

  getDocument(id) {
    const [d] = this.listDocuments({ ids: [Number(id)] });
    if (!d) throw new AppError('Document not found.');
    const row = this.getDocRow(id);
    const pages = this.db.all('SELECT * FROM pages WHERE document_id=$id ORDER BY position', { id: d.id }).map((p) => this.pageOut(p));
    const attachments = this.db.all('SELECT * FROM attachments WHERE document_id=$id ORDER BY file', { id: d.id }).map((a) => ({ id: a.id, file: a.file, size: a.file_size, status: a.status }));
    return { ...d, pages, attachments, path: this.documentPath(row), pdfPath: row.pdf_file ? path.join(this.documentPath(row), row.pdf_file) : null };
  }

  pageOut(p) {
    let edit = null;
    try { edit = p.edit ? JSON.parse(p.edit) : null; } catch { /* ignore */ }
    return { id: p.id, documentId: p.document_id, position: p.position, file: p.file, width: p.width, height: p.height, size: p.file_size, status: p.status, hasOriginal: !!p.original, edit, version: p.updated_at };
  }

  docTypes() {
    const used = this.db.all('SELECT DISTINCT doc_type FROM documents WHERE deleted_at IS NULL').map((r) => r.doc_type);
    return [...new Set([...DOC_TYPES, ...used])];
  }

  takenDocFolders(collectionId) { return this.db.all('SELECT folder FROM documents WHERE collection_id=$c AND deleted_at IS NULL', { c: collectionId }).map((r) => r.folder); }

  _insertDocument(c, { title, docType = 'Other', notes = '', source = 'scan', folder = null, pdf = {} }) {
    const clean = String(title || '').trim().slice(0, 150);
    if (!clean) throw new AppError('Please enter a document title.');
    const colDir = this.collectionPath(c);
    if (!folder) folder = S.uniqueSegment(colDir, S.safeSegment(clean), this.takenDocFolders(c.id));
    fs.mkdirSync(S.resolveInside(colDir, folder), { recursive: true });
    const st = this.getSettings();
    const t = now();
    const r = this.db.run(`INSERT INTO documents(collection_id,title,doc_type,folder,notes,source,pdf_mode,pdf_dpi,pdf_compression,created_at,updated_at)
      VALUES($c,$ti,$ty,$f,$n,$s,$pm,$pd,$pc,$t,$t)`, {
      c: c.id, ti: clean, ty: String(docType || 'Other').trim().slice(0, 60) || 'Other', f: folder, n: String(notes).slice(0, 10000), s: source,
      pm: ['dpi', 'id1', 'id2', 'passport'].includes(pdf.mode) ? pdf.mode : st.pdfMode,
      pd: Math.min(1200, Math.max(36, Number(pdf.dpi) || st.pdfDpi)),
      pc: ['original', 'high', 'balanced', 'small'].includes(pdf.compression) ? pdf.compression : st.pdfCompression, t,
    });
    this.db.run('UPDATE collections SET updated_at=$t WHERE id=$id', { t, id: c.id });
    return this.getDocRow(r.id);
  }

  /**
   * Create a document and write its pages.
   * pages: [{ jpg: Uint8Array, original?: Uint8Array, edit?: object }]
   */
  createDocument({ collectionId, title, docType, notes, tags, pages = [], pdf = {} }) {
    return this.mutate(async () => {
      const c = this.mustCol(collectionId);
      const d = this._insertDocument(c, { title, docType, notes, pdf });
      try {
        await this._writePages(d, pages);
      } catch (e) {
        // roll back an empty document so we don't leave half-created records
        if (!this.db.get('SELECT 1 FROM pages WHERE document_id=$id', { id: d.id })) {
          this.db.run('DELETE FROM documents WHERE id=$id', { id: d.id });
          fs.rmSync(this.documentPath(d, c), { recursive: true, force: true });
        }
        throw e;
      }
      if (tags) this._setTags(d.id, tags);
      await this._afterPagesChanged(d.id);
      this.log('scan', `Saved “${d.title}” (${pages.length} page${pages.length === 1 ? '' : 's'}) to ${c.name}`);
      return this.getDocument(d.id);
    });
  }

  addPages(docId, pages, insertAt = null) {
    return this.mutate(async () => {
      const d = this.mustDoc(docId);
      await this._writePages(d, pages, insertAt);
      await this._afterPagesChanged(d.id);
      this.log('scan', `Added ${pages.length} page(s) to “${d.title}”`);
      return this.getDocument(d.id);
    });
  }

  validateJpeg(buf, what = 'Image') {
    const b = Buffer.from(buf || []);
    if (b.length > 80 * 1024 * 1024) throw new AppError(`${what} is too large.`);
    const type = S.detectImageType(b);
    if (type !== 'jpeg' && type !== 'png') throw new AppError(`${what} is not a valid JPG/PNG image.`);
    return b;
  }

  async _writePages(d, pages, insertAt = null) {
    if (!Array.isArray(pages) || !pages.length) throw new AppError('No pages to save.');
    const dir = this.documentPath(d);
    fs.mkdirSync(dir, { recursive: true });
    const existing = this.db.all('SELECT id, position FROM pages WHERE document_id=$id ORDER BY position', { id: d.id });
    let pos = insertAt == null ? existing.length : Math.max(0, Math.min(existing.length, Number(insertAt)));
    if (insertAt != null) {
      // make room for the new pages
      this.db.run('UPDATE pages SET position = position + $n WHERE document_id=$id AND position > $p', { n: pages.length, id: d.id, p: pos });
    }
    for (const pg of pages) {
      const jpg = this.validateJpeg(pg.jpg, 'Page image');
      const orig = pg.original ? this.validateJpeg(pg.original, 'Original image') : null;
      const info = this.imaging.imageInfo(jpg) || {};
      pos += 1;
      const tmpName = S.uniqueSegment(dir, `${d.folder}_Page_new_${crypto.randomBytes(3).toString('hex')}`, [], '.jpg') + '.jpg';
      const file = path.join(dir, tmpName);
      await S.atomicWrite(file, jpg);
      const st = fs.statSync(file);
      const t = now();
      const r = this.db.run(`INSERT INTO pages(document_id,position,file,managed,width,height,file_size,mtime,sha256,phash,edit,status,created_at,updated_at)
        VALUES($d,$p,$f,1,$w,$h,$s,$m,$sha,$ph,$e,'ok',$t,$t)`, {
        d: d.id, p: pos, f: tmpName, w: info.width || null, h: info.height || null, s: st.size, m: Math.round(st.mtimeMs),
        sha: S.sha256Buf(jpg), ph: this.safeHash(jpg), e: pg.edit ? JSON.stringify(pg.edit).slice(0, 4000) : null, t,
      });
      if (orig) {
        const oname = `p${r.id}.jpg`;
        await S.atomicWrite(path.join(this.originalsDir, oname), orig);
        this.db.run('UPDATE pages SET original=$o WHERE id=$id', { o: oname, id: r.id });
      }
      await this.writeThumb(r.id, jpg);
    }
  }

  safeHash(buf) { try { return this.imaging.dhash(buf); } catch { return null; } }
  async writeThumb(pageId, buf) {
    try { await S.atomicWrite(this.thumbPath(pageId), this.imaging.thumbnail(buf)); } catch { /* thumbnail is a cache */ }
  }

  /** Renumber positions, rename managed files to <Doc>_Page_NN.jpg, rebuild PDF. */
  async _afterPagesChanged(docId, { pdf = true } = {}) {
    const d = this.getDocRow(docId);
    const dir = this.documentPath(d);
    const pages = this.db.all('SELECT * FROM pages WHERE document_id=$id ORDER BY position, id', { id: d.id });
    const width = pages.length > 99 ? 3 : 2;
    const targets = pages.map((p, i) => ({ p, pos: i + 1, name: p.managed ? `${d.folder}_Page_${String(i + 1).padStart(width, '0')}.jpg` : p.file }));
    const changing = targets.filter((t) => t.p.managed && t.p.status === 'ok' && t.p.file !== t.name);
    for (const t of targets) if (!changing.includes(t)) t.name = t.p.file; // missing/unmanaged files keep their names
    // phase 1: move to temp names
    for (const t of changing) {
      const tmp = `.renumber_${t.p.id}_${crypto.randomBytes(2).toString('hex')}.jpg`;
      await S.withRetry(() => fsp.rename(path.join(dir, t.p.file), path.join(dir, tmp)));
      t.tmp = tmp;
    }
    // phase 2: final names (avoid clobbering unmanaged files)
    const keep = new Set(targets.filter((t) => !changing.includes(t)).map((t) => t.p.file.toLowerCase()));
    for (const t of changing) {
      let final = t.name;
      if (keep.has(final.toLowerCase()) || fs.existsSync(path.join(dir, final))) {
        final = S.uniqueSegment(dir, final.replace(/\.jpg$/i, ''), [...keep], '.jpg') + '.jpg';
      }
      await S.withRetry(() => fsp.rename(path.join(dir, t.tmp), path.join(dir, final)));
      keep.add(final.toLowerCase());
      t.name = final;
    }
    this.db.tx(() => {
      for (const t of targets) this.db.run('UPDATE pages SET position=$p, file=$f WHERE id=$id', { p: t.pos, f: t.name, id: t.p.id });
      this.db.run('UPDATE documents SET updated_at=$t WHERE id=$id', { t: now(), id: d.id });
    });
    if (pdf && this.getSettings().autoPdf) await this._buildPdf(d.id);
    else if (d.pdf_status === 'ok') this.db.run("UPDATE documents SET pdf_status='stale' WHERE id=$id", { id: d.id });
  }

  pdfFileName(d) { return `${d.folder}.pdf`; }

  async _pdfBytes(d, options = {}) {
    const pages = this.db.all("SELECT * FROM pages WHERE document_id=$id AND status='ok' ORDER BY position", { id: d.id });
    const order = Array.isArray(options.pageIds) && options.pageIds.length ? options.pageIds.map(Number) : null;
    const list = order ? order.map((id) => pages.find((p) => p.id === id)).filter(Boolean) : pages;
    if (!list.length) return null;
    const input = [];
    for (const p of list) input.push({ bytes: await fsp.readFile(this.pagePath(p, d)), width: p.width, height: p.height });
    return buildPdf(input, {
      title: `${d.title}`, subject: d.doc_type,
      mode: options.mode || d.pdf_mode, dpi: options.dpi || d.pdf_dpi, compression: options.compression || d.pdf_compression,
    }, this.imaging);
  }

  async _buildPdf(docId) {
    const d = this.getDocRow(docId);
    const dir = this.documentPath(d);
    const name = d.pdf_file || this.pdfFileName(d);
    try {
      const bytes = await this._pdfBytes(d);
      if (!bytes) {
        // no pages: move old generated PDF out of the way (to Trash, never hard-delete)
        if (d.pdf_file && fs.existsSync(path.join(dir, d.pdf_file))) await this._trashFile(path.join(dir, d.pdf_file), d.folder);
        this.db.run("UPDATE documents SET pdf_file=NULL, pdf_size=NULL, pdf_status='none' WHERE id=$id", { id: d.id });
        return;
      }
      await S.atomicWrite(path.join(dir, name), bytes);
      this.db.run("UPDATE documents SET pdf_file=$f, pdf_size=$s, pdf_status='ok' WHERE id=$id", { f: name, s: bytes.length, id: d.id });
    } catch (e) {
      this.db.run("UPDATE documents SET pdf_status='stale' WHERE id=$id", { id: d.id });
      this.log('error', `PDF for “${d.title}” could not be written: ${e.message}`);
      if (e.code === 'FILE_LOCKED') return; // keep going; user can regenerate later
      throw e;
    }
  }

  regeneratePdf(docId, options = {}) {
    return this.mutate(async () => {
      const d = this.mustDoc(docId);
      const patch = {};
      if (options.mode && ['dpi', 'id1', 'id2', 'passport'].includes(options.mode)) patch.pdf_mode = options.mode;
      if (options.dpi) patch.pdf_dpi = Math.min(1200, Math.max(36, Number(options.dpi)));
      if (options.compression && ['original', 'high', 'balanced', 'small'].includes(options.compression)) patch.pdf_compression = options.compression;
      for (const [k, v] of Object.entries(patch)) this.db.run(`UPDATE documents SET ${k}=$v WHERE id=$id`, { v, id: d.id });
      if (Array.isArray(options.pageIds) && options.pageIds.length) await this._reorder(d, options.pageIds);
      await this._buildPdf(d.id);
      const after = this.getDocRow(d.id);
      if (after.pdf_status !== 'ok') throw new AppError('The PDF could not be written. If it is open in another program, close it and try again.');
      return this.getDocument(d.id);
    });
  }

  /** Build a PDF in memory for preview/export (does not touch the library). */
  async pdfPreviewBytes(docId, options = {}) {
    const d = this.mustDoc(docId);
    const bytes = await this._pdfBytes(d, options);
    if (!bytes) throw new AppError('This document has no pages.');
    return bytes;
  }

  replacePage(pageId, { jpg, original = null, edit = null }) {
    return this.mutate(async () => {
      const p = this.db.get('SELECT * FROM pages WHERE id=$id', { id: Number(pageId) });
      if (!p) throw new AppError('Page not found.');
      const d = this.mustDoc(p.document_id);
      const buf = this.validateJpeg(jpg);
      // preserve the very first source image so later edits never degrade quality
      if (!p.original) {
        const src = original ? this.validateJpeg(original) : (fs.existsSync(this.pagePath(p, d)) ? await fsp.readFile(this.pagePath(p, d)) : null);
        if (src) {
          const oname = `p${p.id}.jpg`;
          await S.atomicWrite(path.join(this.originalsDir, oname), src);
          this.db.run('UPDATE pages SET original=$o WHERE id=$id', { o: oname, id: p.id });
        }
      }
      let file = p.file;
      if (p.status === 'missing' || !/\.jpe?g$/i.test(file)) {
        // re-create missing or convert png to a managed jpg
        file = `${d.folder}_Page_${String(p.position).padStart(2, '0')}_${crypto.randomBytes(2).toString('hex')}.jpg`;
      }
      const full = S.resolveInside(this.documentPath(d), file);
      await S.atomicWrite(full, buf);
      if (file !== p.file && p.status === 'ok' && fs.existsSync(this.pagePath(p, d))) await this._trashFile(this.pagePath(p, d), d.folder);
      const info = this.imaging.imageInfo(buf) || {};
      const st = fs.statSync(full);
      this.db.run(`UPDATE pages SET file=$f, managed=CASE WHEN $f=file THEN managed ELSE 1 END, width=$w, height=$h, file_size=$s, mtime=$m, sha256=$sha, phash=$ph,
        edit=$e, status='ok', updated_at=$t WHERE id=$id`, {
        f: file, w: info.width || null, h: info.height || null, s: st.size, m: Math.round(st.mtimeMs), sha: S.sha256Buf(buf), ph: this.safeHash(buf),
        e: edit ? JSON.stringify(edit).slice(0, 4000) : p.edit, t: now(), id: p.id,
      });
      await this.writeThumb(p.id, buf);
      await this._afterPagesChanged(d.id);
      return this.getDocument(d.id);
    });
  }

  async _trashFile(full, label = 'file') {
    const dir = S.resolveInside(this.trashDir, '_Removed_pages', stamp().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const base = `${label}_${path.basename(full)}`;
    const ext = path.extname(base);
    const name = S.uniqueSegment(dir, base.slice(0, base.length - ext.length), [], ext) + ext;
    await S.withRetry(() => fsp.rename(full, path.join(dir, name))).catch(async (e) => {
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(full, path.join(dir, name)); await fsp.rm(full);
    });
  }

  deletePages(pageIds) {
    return this.mutate(async () => {
      const ids = (Array.isArray(pageIds) ? pageIds : [pageIds]).map(Number);
      const touched = new Set();
      for (const id of ids) {
        const p = this.db.get('SELECT * FROM pages WHERE id=$id', { id });
        if (!p) continue;
        const d = this.mustDoc(p.document_id);
        const f = this.pagePath(p, d);
        if (fs.existsSync(f)) await this._trashFile(f, d.folder);
        this.db.run('DELETE FROM pages WHERE id=$id', { id });
        fs.rmSync(this.thumbPath(id), { force: true });
        if (p.original) { const o = this.originalPath(p); if (o) fs.rmSync(o, { force: true }); }
        touched.add(d.id);
      }
      for (const docId of touched) await this._afterPagesChanged(docId);
      return touched.size === 1 ? this.getDocument([...touched][0]) : true;
    });
  }

  async _reorder(d, orderedIds) {
    const pages = this.db.all('SELECT id FROM pages WHERE document_id=$id', { id: d.id }).map((r) => r.id);
    const order = orderedIds.map(Number).filter((id) => pages.includes(id));
    for (const id of pages) if (!order.includes(id)) order.push(id);
    this.db.tx(() => order.forEach((id, i) => this.db.run('UPDATE pages SET position=$p WHERE id=$id', { p: i + 1, id })));
  }

  reorderPages(docId, orderedIds) {
    return this.mutate(async () => {
      const d = this.mustDoc(docId);
      await this._reorder(d, orderedIds);
      await this._afterPagesChanged(d.id);
      return this.getDocument(d.id);
    });
  }

  updateDocument(id, patch = {}) {
    return this.mutate(async () => {
      const d = this.mustDoc(id);
      const t = now();
      if (patch.title != null && String(patch.title).trim() && String(patch.title).trim() !== d.title) {
        await this._renameDocument(d, String(patch.title).trim().slice(0, 150));
      }
      if (patch.docType != null) this.db.run('UPDATE documents SET doc_type=$v, updated_at=$t WHERE id=$id', { v: String(patch.docType).trim().slice(0, 60) || 'Other', t, id: d.id });
      if (patch.notes != null) this.db.run('UPDATE documents SET notes=$v, updated_at=$t WHERE id=$id', { v: String(patch.notes).slice(0, 10000), t, id: d.id });
      if (patch.favorite != null) this.db.run('UPDATE documents SET favorite=$v WHERE id=$id', { v: patch.favorite ? 1 : 0, id: d.id });
      if (patch.tags) this._setTags(d.id, patch.tags);
      if (patch.collectionId && Number(patch.collectionId) !== d.collection_id) await this._moveDocument(this.getDocRow(d.id), this.mustCol(patch.collectionId));
      return this.getDocument(d.id);
    });
  }

  async _renameDocument(d, title) {
    const c = this.mustCol(d.collection_id);
    const colDir = this.collectionPath(c);
    const seg = S.safeSegment(title);
    let folder = d.folder;
    if (seg.toLowerCase() !== d.folder.toLowerCase()) {
      folder = S.uniqueSegment(colDir, seg, this.takenDocFolders(c.id).filter((f) => f !== d.folder));
    } else folder = seg;
    if (folder !== d.folder) {
      const from = this.documentPath(d, c);
      const tmp = from + '.renaming';
      if (fs.existsSync(from)) {
        await S.withRetry(() => fsp.rename(from, tmp));
        await S.withRetry(() => fsp.rename(tmp, S.resolveInside(colDir, folder)));
      }
      // rename our generated PDF along with the folder
      if (d.pdf_file === this.pdfFileName(d)) {
        const dir = S.resolveInside(colDir, folder);
        const newPdf = `${folder}.pdf`;
        if (fs.existsSync(path.join(dir, d.pdf_file)) && !fs.existsSync(path.join(dir, newPdf))) await S.withRetry(() => fsp.rename(path.join(dir, d.pdf_file), path.join(dir, newPdf)));
        this.db.run('UPDATE documents SET pdf_file=$p WHERE id=$id', { p: newPdf, id: d.id });
      }
    }
    this.db.run('UPDATE documents SET title=$t, folder=$f, updated_at=$now WHERE id=$id', { t: title, f: folder, now: now(), id: d.id });
    this.log('document', `Renamed “${d.title}” to “${title}”`);
    await this._afterPagesChanged(d.id, { pdf: false });
  }

  async _moveDocument(d, target) {
    const from = this.documentPath(d);
    const folder = S.uniqueSegment(this.collectionPath(target), d.folder, this.takenDocFolders(target.id));
    const to = S.resolveInside(this.collectionPath(target), folder);
    if (fs.existsSync(from)) await S.moveDir(from, to); else fs.mkdirSync(to, { recursive: true });
    this.db.run('UPDATE documents SET collection_id=$c, folder=$f, updated_at=$t WHERE id=$id', { c: target.id, f: folder, t: now(), id: d.id });
    if (folder !== d.folder) {
      if (d.pdf_file === this.pdfFileName(d)) {
        const np = `${folder}.pdf`;
        if (fs.existsSync(path.join(to, d.pdf_file))) await fsp.rename(path.join(to, d.pdf_file), path.join(to, np));
        this.db.run('UPDATE documents SET pdf_file=$p WHERE id=$id', { p: np, id: d.id });
      }
      await this._afterPagesChanged(d.id, { pdf: false });
    }
    this.log('document', `Moved “${d.title}” to ${target.name}`);
  }

  _setTags(docId, tags) {
    const names = [...new Set((Array.isArray(tags) ? tags : String(tags).split(',')).map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
    this.db.tx(() => {
      this.db.run('DELETE FROM document_tags WHERE document_id=$d', { d: docId });
      for (const n of names) {
        this.db.run('INSERT INTO tags(name) VALUES($n) ON CONFLICT(name) DO NOTHING', { n });
        const t = this.db.get('SELECT id FROM tags WHERE name=$n', { n });
        this.db.run('INSERT OR IGNORE INTO document_tags(document_id, tag_id) VALUES($d,$t)', { d: docId, t: t.id });
      }
      this.db.run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM document_tags)');
    });
  }
  allTags() { return this.db.all('SELECT t.name, COUNT(*) n FROM tags t JOIN document_tags dt ON dt.tag_id=t.id JOIN documents d ON d.id=dt.document_id WHERE d.deleted_at IS NULL GROUP BY t.id ORDER BY t.name COLLATE NOCASE'); }

  bulkSetFavorite(ids, fav) {
    return this.mutate(async () => { for (const id of ids) this.db.run('UPDATE documents SET favorite=$f WHERE id=$id', { f: fav ? 1 : 0, id: Number(id) }); return true; });
  }
  bulkAddTag(ids, tag) {
    return this.mutate(async () => {
      for (const id of ids) {
        const cur = this.listDocuments({ ids: [Number(id)] })[0];
        if (cur) this._setTags(cur.id, [...cur.tags, tag]);
      }
      return true;
    });
  }

  deleteDocuments(ids) {
    return this.mutate(async () => {
      for (const id of (Array.isArray(ids) ? ids : [ids])) {
        const d = this.getDocRow(id);
        if (!d || d.deleted_at) continue;
        const from = this.documentPath(d);
        const trash = this.trashName(d.folder);
        if (fs.existsSync(from)) await S.moveDir(from, S.resolveInside(this.trashDir, trash));
        this.db.run('UPDATE documents SET deleted_at=$t, trash_folder=$tf WHERE id=$id', { t: now(), tf: trash, id: d.id });
        this.log('trash', `Moved “${d.title}” to Trash`);
      }
      return true;
    });
  }

  restoreDocuments(ids) {
    return this.mutate(async () => {
      for (const id of (Array.isArray(ids) ? ids : [ids])) {
        const d = this.getDocRow(id);
        if (!d || !d.deleted_at) continue;
        const c = this.getColRow(d.collection_id);
        if (c.deleted_at) await this._restoreCollectionRow(c);
        const c2 = this.getColRow(d.collection_id);
        const folder = S.uniqueSegment(this.collectionPath(c2), d.folder, this.takenDocFolders(c2.id));
        const src = d.trash_folder ? S.resolveInside(this.trashDir, d.trash_folder) : null;
        const dest = S.resolveInside(this.collectionPath(c2), folder);
        if (src && fs.existsSync(src)) await S.moveDir(src, dest); else fs.mkdirSync(dest, { recursive: true });
        this.db.run('UPDATE documents SET deleted_at=NULL, trash_folder=NULL, folder=$f, updated_at=$t WHERE id=$id', { f: folder, t: now(), id: d.id });
        if (folder !== d.folder) await this._afterPagesChanged(d.id, { pdf: false });
        this.log('trash', `Restored “${d.title}”`);
      }
      return true;
    });
  }

  listTrash() {
    const docs = this.db.all(`SELECT d.*, c.name collection_name, (SELECT COUNT(*) FROM pages p WHERE p.document_id=d.id) page_count,
      (SELECT p.id FROM pages p WHERE p.document_id=d.id ORDER BY p.position LIMIT 1) cover_page_id
      FROM documents d JOIN collections c ON c.id=d.collection_id WHERE d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC`).map((r) => this.docOut(r));
    const cols = this.db.all(`SELECT c.*, (SELECT COUNT(*) FROM documents d WHERE d.collection_id=c.id AND d.deleted_at IS NULL) doc_count
      FROM collections c WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC`).map((r) => this.colOut(r));
    return { documents: docs, collections: cols };
  }

  /** Permanently delete trashed items. Files go to the OS recycle bin when possible. */
  purge({ documentIds = [], collectionIds = [] }, removeFn) {
    return this.mutate(async () => {
      const removeTree = async (p) => { if (p && fs.existsSync(p)) await removeFn(p); };
      for (const id of documentIds) {
        const d = this.getDocRow(id);
        if (!d || !d.deleted_at) continue;
        await removeTree(d.trash_folder ? S.resolveInside(this.trashDir, d.trash_folder) : null);
        this._dropDocRecord(d.id);
      }
      for (const id of collectionIds) {
        const c = this.getColRow(id);
        if (!c || !c.deleted_at) continue;
        await removeTree(c.trash_folder ? S.resolveInside(this.trashDir, c.trash_folder) : null);
        for (const d of this.db.all('SELECT * FROM documents WHERE collection_id=$c', { c: c.id })) {
          if (d.deleted_at && d.trash_folder) await removeTree(S.resolveInside(this.trashDir, d.trash_folder));
          this._dropDocRecord(d.id);
        }
        this.db.run('DELETE FROM collections WHERE id=$id', { id: c.id });
      }
      this.log('trash', 'Permanently deleted items from Trash');
      return true;
    });
  }

  _dropDocRecord(docId) {
    for (const p of this.db.all('SELECT * FROM pages WHERE document_id=$d', { d: docId })) {
      fs.rmSync(this.thumbPath(p.id), { force: true });
      const o = this.originalPath(p); if (o) fs.rmSync(o, { force: true });
    }
    this.db.run('DELETE FROM documents WHERE id=$id', { id: docId });
  }

  async emptyTrash(removeFn) {
    const t = this.listTrash();
    return this.purge({ documentIds: t.documents.map((d) => d.id), collectionIds: t.collections.map((c) => c.id) }, removeFn);
  }

  // ---------- export ----------
  /**
   * Copy JPG and/or PDF files of documents to destDir/<Collection>/<Document>/.
   * quality < 100 re-encodes JPGs.
   */
  exportDocuments(ids, destDir, { jpg = true, pdf = true, quality = 100, flat = false } = {}) {
    return this.lock.run(async () => {
      this.requireOnline();
      if (!destDir || !path.isAbsolute(destDir)) throw new AppError('Choose a destination folder.');
      let files = 0;
      for (const id of ids) {
        const d = this.mustDoc(id);
        const c = this.getColRow(d.collection_id);
        const outDir = flat ? destDir : path.join(destDir, c.folder, d.folder);
        fs.mkdirSync(outDir, { recursive: true });
        const pick = (name) => { const ext = path.extname(name); return S.uniqueSegment(outDir, name.slice(0, name.length - ext.length), [], ext) + ext; };
        if (jpg) {
          for (const p of this.db.all("SELECT * FROM pages WHERE document_id=$id AND status='ok' ORDER BY position", { id: d.id })) {
            const src = this.pagePath(p, d);
            const base = flat ? `${c.folder}_${p.file}` : p.file;
            if (quality < 100) {
              const out = this.imaging.reencode(await fsp.readFile(src), { quality });
              await fsp.writeFile(path.join(outDir, pick(base.replace(/\.(png|jpe?g)$/i, '.jpg'))), out);
            } else await fsp.copyFile(src, path.join(outDir, pick(base)));
            files++;
          }
        }
        if (pdf) {
          let src = d.pdf_file ? path.join(this.documentPath(d), d.pdf_file) : null;
          if (!src || !fs.existsSync(src) || d.pdf_status !== 'ok') {
            const bytes = await this._pdfBytes(d);
            if (bytes) { await fsp.writeFile(path.join(outDir, pick(flat ? `${c.folder}_${d.folder}.pdf` : this.pdfFileName(d))), bytes); files++; }
          } else { await fsp.copyFile(src, path.join(outDir, pick(flat ? `${c.folder}_${d.pdf_file}` : d.pdf_file))); files++; }
        }
      }
      this.log('export', `Exported ${files} file(s) to ${destDir}`);
      return { files, destDir };
    });
  }

  // ---------- stats, duplicates ----------
  stats() {
    const g = (sql) => this.db.get(sql);
    const live = 'd.deleted_at IS NULL AND c.deleted_at IS NULL';
    const docs = g(`SELECT COUNT(*) n FROM documents d JOIN collections c ON c.id=d.collection_id WHERE ${live}`).n;
    const pages = g(`SELECT COUNT(*) n, COALESCE(SUM(p.file_size),0) s FROM pages p JOIN documents d ON d.id=p.document_id JOIN collections c ON c.id=d.collection_id WHERE ${live} AND p.status='ok'`);
    const pdfs = g(`SELECT COUNT(*) n, COALESCE(SUM(d.pdf_size),0) s FROM documents d JOIN collections c ON c.id=d.collection_id WHERE ${live} AND d.pdf_status IN ('ok','stale')`);
    const cols = g('SELECT COUNT(*) n FROM collections WHERE deleted_at IS NULL').n;
    const people = g("SELECT COUNT(*) n FROM collections WHERE deleted_at IS NULL AND kind='person'").n;
    const missing = g(`SELECT COUNT(*) n FROM pages p JOIN documents d ON d.id=p.document_id JOIN collections c ON c.id=d.collection_id WHERE ${live} AND p.status='missing'`).n;
    const trash = g('SELECT (SELECT COUNT(*) FROM documents WHERE deleted_at IS NOT NULL) + (SELECT COUNT(*) FROM collections WHERE deleted_at IS NOT NULL) n').n;
    const favs = g(`SELECT COUNT(*) n FROM documents d JOIN collections c ON c.id=d.collection_id WHERE ${live} AND d.favorite=1`).n;
    const last7 = g(`SELECT COUNT(*) n FROM documents d JOIN collections c ON c.id=d.collection_id WHERE ${live} AND d.created_at > ${now() - 7 * 864e5}`).n;
    return { documents: docs, pages: pages.n, jpgFiles: pages.n, jpgBytes: pages.s, pdfFiles: pdfs.n, pdfBytes: pdfs.s, collections: cols, people, missing, trash, favorites: favs, last7 };
  }

  activity(limit = 30) { return this.db.all('SELECT * FROM activity ORDER BY id DESC LIMIT $l', { l: limit }); }

  /** Exact (same SHA-256) and near (perceptual hash) duplicate pages. */
  duplicates() {
    const rows = this.db.all(`SELECT p.id, p.document_id, p.sha256, p.phash, p.position, d.title, c.name collection_name
      FROM pages p JOIN documents d ON d.id=p.document_id JOIN collections c ON c.id=d.collection_id
      WHERE d.deleted_at IS NULL AND c.deleted_at IS NULL AND p.status='ok'`);
    const groups = [];
    const used = new Set();
    const bySha = new Map();
    for (const r of rows) { if (!r.sha256) continue; if (!bySha.has(r.sha256)) bySha.set(r.sha256, []); bySha.get(r.sha256).push(r); }
    for (const list of bySha.values()) if (list.length > 1) { groups.push({ kind: 'exact', pages: list }); list.forEach((r) => used.add(r.id)); }
    const rest = rows.filter((r) => r.phash && !used.has(r.id));
    for (let i = 0; i < rest.length; i++) {
      if (used.has(rest[i].id)) continue;
      const g = [rest[i]];
      for (let j = i + 1; j < rest.length; j++) {
        if (!used.has(rest[j].id) && this.imaging.hamming(rest[i].phash, rest[j].phash) <= 4) { g.push(rest[j]); used.add(rest[j].id); }
      }
      if (g.length > 1) { used.add(rest[i].id); groups.push({ kind: 'similar', pages: g }); }
    }
    return groups.map((g) => ({ kind: g.kind, pages: g.pages.map((p) => ({ pageId: p.id, documentId: p.document_id, title: p.title, collection: p.collection_name, position: p.position })) }));
  }

  /** Before saving new pages, report pages that look the same as existing ones. */
  findSimilar(hashes) {
    const rows = this.db.all(`SELECT p.id, p.phash, d.id doc_id, d.title, c.name collection_name FROM pages p JOIN documents d ON d.id=p.document_id
      JOIN collections c ON c.id=d.collection_id WHERE d.deleted_at IS NULL AND p.phash IS NOT NULL`);
    const out = [];
    for (const h of hashes) {
      const m = rows.find((r) => this.imaging.hamming(r.phash, h) <= 3);
      out.push(m ? { documentId: m.doc_id, title: m.title, collection: m.collection_name } : null);
    }
    return out;
  }

  async storageUsage() {
    const [docs, db, trash, backups] = await Promise.all([this.docsDir, this.dbDir, this.trashDir, this.backupsDir].map((d) => S.dirSize(d)));
    return { documents: docs, database: db, trash, backups, total: docs.bytes + db.bytes + trash.bytes + backups.bytes, disk: await S.freeSpace(this.root) };
  }

  /** Automatic DB snapshot (keeps the newest N). */
  autoBackup(force = false) {
    const dir = path.join(this.backupsDir, 'auto');
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).filter((f) => /^library_.*\.db$/.test(f)).sort();
    const today = stamp().slice(0, 10);
    if (!force && files.some((f) => f.startsWith(`library_${today}`))) return null;
    const target = path.join(dir, `library_${stamp()}.db`);
    this.db.snapshot(target);
    const keep = Math.max(2, this.getSettings().autoBackupKeep || 10);
    const all = fs.readdirSync(dir).filter((f) => /^library_.*\.db$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
    return target;
  }
}

module.exports = { Library, DEFAULT_SETTINGS, DOC_TYPES, MARKER, stamp };
