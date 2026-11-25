// Phone app data layer: portal API, end-to-end encryption (WebCrypto), chunked
// uploads, and an IndexedDB store for the offline copy and the outbox.

const API = new URL('../api.php', location.href).href;

// ---------------------------------------------------------------- pairing state
export const auth = {
  get() { try { return JSON.parse(localStorage.getItem('ss.auth') || 'null'); } catch { return null; } },
  set(v) { localStorage.setItem('ss.auth', JSON.stringify(v)); cryptoKey = null; },
  clear() { localStorage.removeItem('ss.auth'); cryptoKey = null; },
};

let cryptoKey = null;
async function key() {
  if (cryptoKey) return cryptoKey;
  const a = auth.get();
  if (!a) throw new Error('This phone is not paired.');
  const raw = Uint8Array.from(atob(a.key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return cryptoKey;
}

/** [0x01][12-byte IV][ciphertext + GCM tag] — identical to the PC (src/main/e2e.js). */
export async function encrypt(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), bytes));
  const out = new Uint8Array(13 + c.length);
  out[0] = 1; out.set(iv, 1); out.set(c, 13);
  return out;
}
export async function decrypt(buf) {
  const b = new Uint8Array(buf);
  if (b[0] !== 1) throw new Error('Unknown data format');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(1, 13) }, await key(), b.subarray(13)));
}
const te = new TextEncoder(); const td = new TextDecoder();
export const encryptJson = (o) => encrypt(te.encode(JSON.stringify(o)));
export const decryptJson = async (buf) => JSON.parse(td.decode(await decrypt(buf)));

// ---------------------------------------------------------------- API
export class NetError extends Error {}
export async function api(action, body = null, { raw = null, query = '', token } = {}) {
  const headers = {};
  const tok = token !== undefined ? token : auth.get()?.token;
  if (tok) headers['X-SS-Token'] = tok;
  if (raw) headers['Content-Type'] = 'application/octet-stream';
  else if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${API}?a=${action}${query}`, { method: raw || body ? 'POST' : 'GET', headers, body: raw || (body ? JSON.stringify(body) : undefined), cache: 'no-store' });
  } catch { throw new NetError('No internet connection'); }
  if (action === 'blob.get' && res.ok) return new Uint8Array(await res.arrayBuffer());
  let data;
  try { data = await res.json(); } catch { throw new NetError(`Portal error (HTTP ${res.status})`); }
  if (!data.ok) {
    const e = new Error(data.error || 'Portal error');
    e.status = res.status;
    if (res.status === 401) e.unpaired = true;
    throw e;
  }
  return data;
}

let maxChunk = 512 * 1024;
export function setMaxChunk(n) { if (n) maxChunk = Math.min(n, 2 * 1024 * 1024); }

export async function uploadEncrypted(bytes, onProgress) {
  const enc = await encrypt(bytes);
  const { id } = await api('blob.create', { size: enc.length });
  for (let off = 0; off < enc.length; off += maxChunk) {
    await api('blob.append', null, { raw: enc.subarray(off, Math.min(enc.length, off + maxChunk)), query: `&id=${id}&offset=${off}` });
    onProgress?.(Math.min(1, (off + maxChunk) / enc.length));
  }
  return id;
}
export const fetchBlob = (id) => api('blob.get', null, { query: `&id=${encodeURIComponent(id)}` });

// ---------------------------------------------------------------- IndexedDB
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open('smartscan', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      d.createObjectStore('files'); // key -> encrypted bytes (thumbs, PDFs, pages)
      d.createObjectStore('outbox', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((r) => { out = r; });
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage full?'));
  });
}
export const store = {
  get: (st, k) => tx(st, 'readonly', (s) => s.get(k)),
  put: (st, k, v) => tx(st, 'readwrite', (s) => (st === 'outbox' ? s.put(v) : s.put(v, k))),
  del: (st, k) => tx(st, 'readwrite', (s) => s.delete(k)),
  keys: (st) => tx(st, 'readonly', (s) => s.getAllKeys()),
  all: (st) => tx(st, 'readonly', (s) => s.getAll()),
  clear: (st) => tx(st, 'readwrite', (s) => s.clear()),
};

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
