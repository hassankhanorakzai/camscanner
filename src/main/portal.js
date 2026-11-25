'use strict';
/**
 * Link between a user's library (the master copy, on the PC drive) and the
 * SmartScan web portal on the user's own hosting. Phones reach the PC through
 * the portal from anywhere; all data is end-to-end encrypted (see e2e.js).
 *
 *  PC → portal : encrypted catalog (people/documents/page list) + thumbnails,
 *                requested PDFs/pages (deleted from the portal after download)
 *  phone → PC  : new scans, new pages, renames/notes/tags, delete-to-trash
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const E = require('./e2e');
const { AppError } = require('./storage');

const META = {
  url: 'portal_url', libraryId: 'portal_library_id', token: 'portal_token', key: 'portal_key', label: 'portal_label',
  catalogHash: 'portal_catalog_hash', done: 'portal_done_ids', log: 'portal_log',
};

class PortalLink {
  /**
   * @param lib   open Library
   * @param opts  { seal(str)->str, unseal(str)->str, imaging, onState(state), fetch }
   */
  constructor(lib, opts) {
    this.lib = lib;
    this.seal = opts.seal || ((s) => s);
    this.unseal = opts.unseal || ((s) => s);
    this.imaging = opts.imaging;
    this.onState = opts.onState || (() => {});
    this.fetch = opts.fetch || globalThis.fetch;
    this.timer = null;
    this.running = false;
    this.dirty = true;
    this.state = { connected: false, status: 'off', lastSync: null, error: null, devices: [], activeDevices: 0, label: null, url: null };
    this.maxChunk = 1024 * 1024;
    this.failures = 0;
    this.unlisten = null;
  }

  // ---------- persisted settings (inside the user's own library DB)
  meta(k) { const r = this.lib.db.get('SELECT value FROM meta WHERE key=$k', { k }); return r ? r.value : null; }
  setMeta(k, v) {
    if (v == null) this.lib.db.run('DELETE FROM meta WHERE key=$k', { k });
    else this.lib.db.run('INSERT INTO meta(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value', { k, v: String(v) });
  }
  get url() { return this.meta(META.url); }
  get token() { const t = this.meta(META.token); return t ? this.unseal(t) : null; }
  get key() { const k = this.meta(META.key); return k ? E.keyFromText(this.unseal(k)) : null; }
  isLinked() { return !!(this.url && this.token && this.key); }

  log(msg) {
    let arr = [];
    try { arr = JSON.parse(this.meta(META.log) || '[]'); } catch { arr = []; }
    arr.unshift({ at: Date.now(), msg: String(msg).slice(0, 300) });
    this.setMeta(META.log, JSON.stringify(arr.slice(0, 40)));
  }
  activity() { try { return JSON.parse(this.meta(META.log) || '[]'); } catch { return []; } }

  setState(patch) { this.state = { ...this.state, ...patch }; this.onState(this.publicState()); }
  publicState() { return { ...this.state, linked: this.isLinked(), url: this.url, activity: this.activity() }; }

  // ---------- HTTP
  static normaliseUrl(u) {
    let s = String(u || '').trim().replace(/\/+(api\.php|install\.php|app\/?)?$/i, '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    const url = new URL(s);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new AppError('The portal address must start with https:// (phones need HTTPS for the camera).');
    return url.href.replace(/\/+$/, '');
  }

  async api(action, body = null, { token = this.token, url = this.url, raw = null, query = '' } = {}) {
    const headers = {};
    if (token) headers['X-SS-Token'] = token;
    let payload;
    if (raw) { headers['Content-Type'] = 'application/octet-stream'; payload = raw; } else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try {
      res = await this.fetch(`${url}/api.php?a=${action}${query}`, { method: payload ? 'POST' : 'GET', headers, body: payload, signal: AbortSignal.timeout(60000) });
    } catch (e) {
      throw new AppError(`Cannot reach the portal (${e.cause?.code || e.message}). Check the internet connection and the address.`, 'PORTAL_OFFLINE');
    }
    if (action === 'blob.get' && res.ok) return Buffer.from(await res.arrayBuffer());
    let data;
    try { data = await res.json(); } catch { throw new AppError(`The portal returned an unexpected answer (HTTP ${res.status}). Is the address correct and is the portal installed?`, 'PORTAL_BAD'); }
    if (!data.ok) { const e = new AppError(data.error || `Portal error ${res.status}`, res.status === 401 ? 'PORTAL_AUTH' : 'PORTAL_ERROR'); e.status = res.status; throw e; }
    return data;
  }

  async uploadBlob(buf) {
    const { id } = await this.api('blob.create', { size: buf.length });
    for (let off = 0; off < buf.length; off += this.maxChunk) {
      await this.api('blob.append', null, { raw: buf.subarray(off, Math.min(buf.length, off + this.maxChunk)), query: `&id=${id}&offset=${off}` });
    }
    return id;
  }
  async uploadEncrypted(buf) { return this.uploadBlob(E.encrypt(this.key, buf)); }
  async downloadDecrypted(id) { return E.decrypt(this.key, await this.api('blob.get', null, { query: `&id=${encodeURIComponent(id)}` })); }

  // ---------- setup
  async connect({ url, setupKey, label }) {
    const base = PortalLink.normaliseUrl(url);
    const ping = await this.api('ping', null, { url: base, token: null });
    if (ping.app !== 'smartscan-portal') throw new AppError('That address is not a SmartScan portal.');
    const r = await this.api('pc.register', { setupKey: String(setupKey || '').trim().toUpperCase(), label: label || 'Office PC' }, { url: base, token: null });
    this.lib.db.tx(() => {
      this.setMeta(META.url, base);
      this.setMeta(META.libraryId, r.libraryId);
      this.setMeta(META.token, this.seal(r.token));
      if (!this.meta(META.key)) this.setMeta(META.key, this.seal(E.keyToText(E.newKey())));
      this.setMeta(META.label, label || 'Office PC');
      this.setMeta(META.catalogHash, null);
    });
    this.log(`Connected to ${base}`);
    this.dirty = true;
    this.start();
    return this.publicState();
  }

  async disconnect() {
    this.stop();
    try { if (this.isLinked()) await this.api('pc.revoke', { deviceId: '*' }); } catch { /* offline: still unlink locally */ }
    for (const k of [META.url, META.libraryId, META.token, META.catalogHash, META.label]) this.setMeta(k, null);
    this.setState({ connected: false, status: 'off', devices: [], error: null });
    return this.publicState();
  }

  /** New key + remove all phones (use if a phone was lost). */
  async resetKey() {
    await this.api('pc.revoke', { deviceId: '*' });
    this.setMeta(META.key, this.seal(E.keyToText(E.newKey())));
    this.setMeta(META.catalogHash, null);
    await this.api('pc.thumbs_prune', { pageIds: [] });
    this.log('Encryption key renewed; all phones removed');
    this.dirty = true;
    this.kick();
    return this.publicState();
  }

  async pairing() {
    if (!this.isLinked()) throw new AppError('Connect to your portal first.');
    const r = await this.api('pc.pairing');
    const link = `${this.url}/app/#p=${r.code}&k=${E.keyToText(this.key)}`;
    return { link, code: r.code, expiresAt: r.expiresAt };
  }

  async revoke(deviceId) { await this.api('pc.revoke', { deviceId }); this.kick(); return true; }
  async rename(label) { await this.api('pc.rename', { label }); this.setMeta(META.label, label); return true; }

  // ---------- loop
  start() {
    if (!this.isLinked() || this.running) return;
    this.running = true;
    this.unlisten = (evt) => { if (evt === 'changed') { this.dirty = true; this.kick(1500); } };
    this.lib.listeners.add(this.unlisten);
    this.kick(500);
  }
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.unlisten) this.lib.listeners.delete(this.unlisten);
    this.unlisten = null;
  }
  kick(ms = 0) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    let next = 20000;
    try {
      if (!this.lib.isOnline()) throw new AppError('Storage drive offline', 'STORAGE_OFFLINE');
      const st = await this.api('pc.status');
      this.maxChunk = st.maxChunk || this.maxChunk;
      this.setState({ connected: true, status: 'syncing', error: null, devices: st.devices, activeDevices: st.activeDevices, label: st.label });
      if (st.pendingInbox) await this.processInbox();
      if (st.pendingRequests) await this.processRequests();
      if (this.dirty || !st.catalogVersion || st.catalogVersion !== this.meta(META.catalogHash)) await this.publish();
      this.failures = 0;
      this.setState({ status: 'synced', lastSync: Date.now() });
      next = this.dirty ? 300 : st.activeDevices ? 4000 : 20000;
    } catch (e) {
      this.failures++;
      const offline = e.code === 'PORTAL_OFFLINE';
      this.setState({ connected: false, status: offline ? 'offline' : 'error', error: e.message });
      if (e.code === 'PORTAL_AUTH') { this.log(`Portal refused this PC: ${e.message}`); next = 120000; } else next = Math.min(60000, 5000 * this.failures);
    } finally {
      this.busy = false;
      this.kick(next);
    }
  }

  /** Run one full sync immediately (used by the UI and tests). */
  async syncNow() {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    const wasRunning = this.running;
    this.running = true;
    await this.tick();
    if (!wasRunning) this.stop();
    if (this.state.error) throw new AppError(this.state.error);
    return this.publicState();
  }

  // ---------- catalog & thumbnails
  buildCatalog() {
    const lib = this.lib;
    const collections = lib.listCollections({}).map((c) => ({ id: c.id, name: c.name, kind: c.kind, notes: c.notes, favorite: c.favorite, updatedAt: c.updatedAt }));
    const docs = lib.listDocuments({ limit: 10000 });
    const pages = lib.db.all("SELECT p.id, p.document_id, p.position, p.width, p.height, p.updated_at, p.file_size FROM pages p JOIN documents d ON d.id=p.document_id WHERE d.deleted_at IS NULL AND p.status='ok' ORDER BY p.document_id, p.position");
    const byDoc = new Map();
    for (const p of pages) { if (!byDoc.has(p.document_id)) byDoc.set(p.document_id, []); byDoc.get(p.document_id).push({ id: p.id, w: p.width, h: p.height, v: p.updated_at, size: p.file_size }); }
    const documents = docs.map((d) => ({ id: d.id, collectionId: d.collectionId, title: d.title, docType: d.docType, tags: d.tags, notes: d.notes, favorite: d.favorite, createdAt: d.createdAt, updatedAt: d.updatedAt, pdfSize: d.hasPdf ? d.pdfSize : null, pages: byDoc.get(d.id) || [] }));
    return { format: 1, library: this.meta(META.label) || 'Office PC', owner: lib.username, docTypes: lib.docTypes(), collections, documents };
  }

  async publish() {
    const cat = this.buildCatalog();
    const json = JSON.stringify(cat);
    const hash = crypto.createHash('sha256').update(json).update(this.meta(META.key) || '').digest('hex').slice(0, 40);
    // thumbnails first, so phones never see a page without its thumbnail
    const have = (await this.api('pc.thumbs')).thumbs || {};
    const wanted = new Map();
    for (const d of cat.documents) for (const p of d.pages) wanted.set(p.id, p.v);
    let uploaded = 0;
    for (const [pageId, v] of wanted) {
      if (have[pageId] === v) continue;
      const row = this.lib.db.get('SELECT * FROM pages WHERE id=$id', { id: pageId });
      if (!row) continue;
      let buf;
      try { buf = this.imaging.thumbnail(await fsp.readFile(this.lib.pagePath(row)), 320); } catch { continue; }
      const blobId = await this.uploadEncrypted(buf);
      await this.api('pc.thumb_set', { pageId, version: v, blobId });
      uploaded++;
      if (uploaded >= 60) { this.dirty = true; break; } // continue next round, keep things responsive
    }
    if (Object.keys(have).some((id) => !wanted.has(Number(id)))) await this.api('pc.thumbs_prune', { pageIds: [...wanted.keys()] });
    if (hash !== this.meta(META.catalogHash)) {
      const blobId = await this.uploadEncrypted(Buffer.from(json));
      await this.api('pc.catalog', { blobId, version: hash });
      this.setMeta(META.catalogHash, hash);
    }
    if (uploaded < 60) this.dirty = false;
  }

  // ---------- phone → PC
  doneIds() { try { return JSON.parse(this.meta(META.done) || '[]'); } catch { return []; } }
  markDone(id) { this.setMeta(META.done, JSON.stringify([id, ...this.doneIds()].slice(0, 500))); }

  async processInbox() {
    const { items } = await this.api('pc.inbox');
    for (const item of items) {
      let result;
      if (this.doneIds().includes(item.id)) result = { ok: true, duplicate: true };
      else {
        try {
          const meta = JSON.parse((await this.downloadDecrypted(item.meta_blob)).toString('utf8'));
          result = await this.applyOp(meta, item);
          this.markDone(item.id);
        } catch (e) {
          result = { ok: false, error: e.userFacing ? e.message : `Could not apply: ${e.message}` };
          if (e.code === 'STORAGE_OFFLINE') throw e; // keep it pending until the drive is back
        }
      }
      const enc = E.encryptJson(this.key, result).toString('base64');
      await this.api('pc.inbox_done', { id: item.id, status: result.ok ? 'done' : 'error', result: enc });
    }
    if (items.length) this.dirty = true;
  }

  async applyOp(meta, item) {
    const lib = this.lib;
    const device = this.state.devices.find((d) => d.id === item.device_id)?.label || 'phone';
    if (meta.op === 'scan') {
      const pages = [];
      for (const b of item.page_blobs) pages.push({ jpg: await this.downloadDecrypted(b) });
      if (!pages.length) throw new AppError('No pages were received.');
      let doc;
      if (meta.document?.id) {
        doc = await lib.addPages(Number(meta.document.id), pages);
      } else {
        let collectionId = Number(meta.collection?.id) || null;
        if (!collectionId) {
          const name = String(meta.collection?.name || '').trim();
          if (!name) throw new AppError('No person/collection was chosen.');
          const existing = lib.listCollections({}).find((c) => c.name.toLowerCase() === name.toLowerCase());
          collectionId = existing ? existing.id : (await lib.createCollection({ name, kind: 'person' })).id;
        }
        doc = await lib.createDocument({ collectionId, title: meta.document?.title || 'Phone scan', docType: meta.document?.docType || 'Other', tags: meta.document?.tags || [], notes: meta.document?.notes || '', pages });
      }
      this.log(`Received ${pages.length} page(s) from ${device}: “${doc.title}” (${doc.collectionName})`);
      return { ok: true, op: 'scan', documentId: doc.id, title: doc.title, collection: doc.collectionName, pages: pages.length };
    }
    if (meta.op === 'update') {
      const patch = {};
      for (const k of ['title', 'docType', 'notes', 'tags', 'favorite']) if (meta.patch && k in meta.patch) patch[k] = meta.patch[k];
      const d = await lib.updateDocument(Number(meta.documentId), patch);
      this.log(`${device} updated “${d.title}”`);
      return { ok: true, op: 'update', documentId: d.id, title: d.title };
    }
    if (meta.op === 'delete') {
      const d = lib.getDocument(Number(meta.documentId));
      await lib.deleteDocuments([d.id]);
      this.log(`${device} moved “${d.title}” to Trash`);
      return { ok: true, op: 'delete', documentId: d.id, title: d.title };
    }
    if (meta.op === 'collection') {
      const c = await lib.createCollection({ name: meta.name, kind: meta.kind === 'folder' ? 'folder' : 'person' });
      return { ok: true, op: 'collection', collectionId: c.id, name: c.name };
    }
    throw new AppError(`Unknown request from phone (${meta.op})`);
  }

  async processRequests() {
    const { items } = await this.api('pc.requests');
    for (const r of items) {
      try {
        let buf;
        if (r.kind === 'pdf') {
          const d = this.lib.getDocument(r.ref_id);
          if (d.pdfFile && d.pdfStatus === 'ok' && fs.existsSync(d.pdfPath)) buf = await fsp.readFile(d.pdfPath);
          else buf = await this.lib.pdfPreviewBytes(r.ref_id);
        } else {
          const f = this.lib.resolveFile('page', r.ref_id);
          if (!f || !fs.existsSync(f)) throw new AppError('The file is not on the PC drive.');
          buf = await fsp.readFile(f);
        }
        const blobId = await this.uploadEncrypted(buf);
        await this.api('pc.request_done', { id: r.id, blobId });
      } catch (e) {
        if (e.code === 'PORTAL_OFFLINE') throw e;
        await this.api('pc.request_done', { id: r.id, error: e.userFacing ? e.message : 'Not available' });
      }
    }
  }
}

module.exports = { PortalLink };
