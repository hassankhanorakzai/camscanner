// Phone ↔ portal ↔ PC sync: catalog, thumbnails, file requests, outbox, offline copies.
import { api, auth, decrypt, decryptJson, encryptJson, uploadEncrypted, fetchBlob, store, setMaxChunk, NetError } from './net.js';

export const state = {
  catalog: null, status: null, online: navigator.onLine, pcOnline: false, error: null, listeners: new Set(),
};
export function onChange(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }
function emit(what) { for (const l of state.listeners) { try { l(what); } catch (e) { console.error(e); } } }

// ---------------------------------------------------------------- catalog
export async function loadCached() {
  state.catalog = (await store.get('kv', 'catalog')) || null;
  state.status = (await store.get('kv', 'status')) || null;
  return state.catalog;
}

let refreshing = null;
export function refresh() {
  if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}
async function doRefresh() {
  try {
    const st = await api('dv.status');
    setMaxChunk(st.maxChunk);
    state.online = true; state.error = null;
    state.pcOnline = Date.now() - st.pcLastSeen < 75000;
    if (st.catalogBlob && st.catalogVersion !== state.status?.catalogVersion) {
      state.catalog = await decryptJson(await fetchBlob(st.catalogBlob));
      await store.put('kv', 'catalog', state.catalog);
    }
    state.status = { ...st, fetchedAt: Date.now() };
    await store.put('kv', 'status', state.status);
    emit('catalog');
    await flushOutbox();
    await checkOutbox();
    keepOfflineSync().catch(() => {});
  } catch (e) {
    if (e.unpaired) { state.error = e.message; emit('unpaired'); return; }
    state.online = !(e instanceof NetError);
    state.error = e.message;
    emit('status');
  }
}

export const findDoc = (id) => state.catalog?.documents.find((d) => d.id === Number(id));
export const findCol = (id) => state.catalog?.collections.find((c) => c.id === Number(id));

// ---------------------------------------------------------------- thumbnails (encrypted cache)
const urlCache = new Map();
export async function thumbUrl(pageId, version) {
  const k = `t:${pageId}:${version}`;
  if (urlCache.has(k)) return urlCache.get(k);
  let enc = await store.get('files', k);
  if (!enc) {
    const t = state.status?.thumbs?.[pageId];
    if (!t) return null;
    enc = await fetchBlob(t[1]);
    await store.put('files', k, enc);
  }
  const url = URL.createObjectURL(new Blob([await decrypt(enc)], { type: 'image/jpeg' }));
  urlCache.set(k, url);
  return url;
}

// ---------------------------------------------------------------- files (PDF / full page) via the PC
const fileKey = (kind, ref, v) => `${kind}:${ref}:${v}`;
export async function cachedFile(kind, ref, version) {
  const enc = await store.get('files', fileKey(kind, ref, version));
  return enc ? new Blob([await decrypt(enc)], { type: kind === 'pdf' ? 'application/pdf' : 'image/jpeg' }) : null;
}

/** Ask the PC for a file; resolves with a Blob when it arrives (PC must be on). */
export async function getFile(kind, ref, version, { onWait, signal } = {}) {
  const hit = await cachedFile(kind, ref, version);
  if (hit) return hit;
  const { id } = await api('dv.request', { kind, refId: ref });
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new Error('Cancelled');
    const r = await api('dv.request_status', { id });
    if (r.status === 'ready') {
      const enc = await fetchBlob(r.blobId);
      await store.put('files', fileKey(kind, ref, version), enc);
      await api('dv.request_done', { id }).catch(() => {});
      return new Blob([await decrypt(enc)], { type: kind === 'pdf' ? 'application/pdf' : 'image/jpeg' });
    }
    if (r.status === 'error') throw new Error(r.error || 'The PC could not send this file.');
    onWait?.(Date.now() - started);
    await new Promise((res) => setTimeout(res, 2500));
  }
}

// ---------------------------------------------------------------- keep offline (two-way copy)
export const offline = {
  get() { try { return JSON.parse(localStorage.getItem('ss.offline') || '{"docs":[],"people":[]}'); } catch { return { docs: [], people: [] }; } },
  set(v) { localStorage.setItem('ss.offline', JSON.stringify(v)); emit('offline'); },
  isDoc(d) { const o = offline.get(); return o.docs.includes(d.id) || o.people.includes(d.collectionId); },
  toggleDoc(id) { const o = offline.get(); o.docs = o.docs.includes(id) ? o.docs.filter((x) => x !== id) : [...o.docs, id]; offline.set(o); keepOfflineSync().catch(() => {}); },
  togglePerson(id) { const o = offline.get(); o.people = o.people.includes(id) ? o.people.filter((x) => x !== id) : [...o.people, id]; offline.set(o); keepOfflineSync().catch(() => {}); },
};
let offlineRunning = false;
export async function keepOfflineSync() {
  if (offlineRunning || !state.catalog) return;
  offlineRunning = true;
  try {
    const want = new Set();
    for (const d of state.catalog.documents) {
      if (!offline.isDoc(d) || !d.pages.length) continue;
      want.add(fileKey('pdf', d.id, d.updatedAt));
      if (!(await store.get('files', fileKey('pdf', d.id, d.updatedAt))) && state.pcOnline) {
        await getFile('pdf', d.id, d.updatedAt).catch(() => {});
        emit('offline');
      }
    }
    // drop outdated offline PDFs (keep pages/thumbnails cache)
    for (const k of await store.keys('files')) if (String(k).startsWith('pdf:') && !want.has(k)) await store.del('files', k);
  } finally { offlineRunning = false; }
}
export async function offlineReady(d) { return !!(await store.get('files', fileKey('pdf', d.id, d.updatedAt))); }

// ---------------------------------------------------------------- outbox: phone → PC
export async function queue(item) {
  const rec = { id: `o${Date.now()}${Math.random().toString(36).slice(2, 6)}`, created: Date.now(), status: 'queued', ...item };
  await store.put('outbox', null, rec);
  emit('outbox');
  flushOutbox().catch(() => {});
  return rec;
}
export const outboxAll = async () => (await store.all('outbox')).sort((a, b) => b.created - a.created);

let flushing = false;
export async function flushOutbox() {
  if (flushing || !auth.get()) return;
  flushing = true;
  try {
    for (const it of (await store.all('outbox')).filter((x) => x.status === 'queued' || x.status === 'uploading').sort((a, b) => a.created - b.created)) {
      it.status = 'uploading'; it.progress = 0; await store.put('outbox', null, it); emit('outbox');
      const pageBlobs = [];
      const n = it.pages?.length || 0;
      for (let i = 0; i < n; i++) {
        const bytes = new Uint8Array(await it.pages[i].arrayBuffer());
        pageBlobs.push(await uploadEncrypted(bytes, (p) => { it.progress = (i + p) / n; emit('outbox'); }));
      }
      const metaBlob = await uploadEncrypted(new TextEncoder().encode(JSON.stringify(it.meta)));
      const r = await api('dv.submit', { metaBlob, pageBlobs });
      it.status = 'sent'; it.serverId = r.id; it.sentAt = Date.now(); it.progress = 1;
      await store.put('outbox', null, it); emit('outbox');
    }
  } catch (e) {
    for (const it of await store.all('outbox')) if (it.status === 'uploading') { it.status = 'queued'; it.lastError = e.message; await store.put('outbox', null, it); }
    emit('outbox');
  } finally { flushing = false; }
}

export async function checkOutbox() {
  const sent = (await store.all('outbox')).filter((x) => x.status === 'sent');
  if (!sent.length) return;
  const { items } = await api('dv.submissions', { ids: sent.map((s) => s.serverId) });
  let changed = false;
  for (const it of sent) {
    const r = items[it.serverId];
    if (!r || r.status === 'pending') continue;
    if (r.status === 'unknown') { it.status = 'error'; it.error = 'Lost on the portal — please send again.'; }
    else {
      let res = null;
      try { res = r.result ? await decryptJson(Uint8Array.from(atob(r.result), (c) => c.charCodeAt(0))) : null; } catch { res = null; }
      it.status = r.status === 'done' ? 'done' : 'error';
      it.result = res; it.error = res?.error || (r.status === 'error' ? 'The PC could not save this.' : null);
    }
    it.pages = []; // free phone storage once the PC has it
    it.doneAt = Date.now();
    await store.put('outbox', null, it);
    changed = true;
  }
  if (changed) { emit('outbox'); refreshSoon(); }
  // keep only the last 50 finished items
  const fin = (await outboxAll()).filter((x) => x.status === 'done' || x.status === 'error');
  for (const old of fin.slice(50)) await store.del('outbox', old.id);
}
let soon = null;
function refreshSoon() { clearTimeout(soon); soon = setTimeout(() => refresh(), 1500); }

// ---------------------------------------------------------------- operations
export const ops = {
  scan: ({ collection, document, pages }) => queue({ kind: 'scan', title: document.title || `+${pages.length} pages`, meta: { op: 'scan', collection, document }, pages }),
  update: (doc, patch) => queue({ kind: 'update', title: `Edit “${doc.title}”`, meta: { op: 'update', documentId: doc.id, patch }, pages: [] }),
  remove: (doc) => queue({ kind: 'delete', title: `Delete “${doc.title}”`, meta: { op: 'delete', documentId: doc.id }, pages: [] }),
};

window.addEventListener('online', () => { state.online = true; refresh(); });
window.addEventListener('offline', () => { state.online = false; emit('status'); });
