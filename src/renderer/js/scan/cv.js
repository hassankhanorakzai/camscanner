// Client for the OpenCV worker. A single worker is shared by the app.
let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../worker/cv-worker.js', import.meta.url));
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Image worker failed')); pending.clear(); worker = null; };
  return worker;
}

function call(type, payload, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, ...payload }, transfer);
  });
}

export const warmup = () => call('ping', {});

/** Detect document corners. Returns { quad:[[x,y]...] normalised, confidence } or null. */
export async function detect(source) {
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  return call('detect', { bitmap }, [bitmap]);
}

/** Process a page: crop/warp, rotate, filter → JPEG bytes + size. */
export async function processPage(blob, params, options = {}) {
  const bitmap = await createImageBitmap(blob);
  const r = await call('process', { bitmap, params, options }, [bitmap]);
  return { bytes: new Uint8Array(r.buffer), width: r.width, height: r.height };
}

export async function processPreview(blob, params, maxDim = 900) {
  const r = await processPage(blob, params, { maxDim, quality: 0.85 });
  return { url: URL.createObjectURL(new Blob([r.bytes], { type: 'image/jpeg' })), width: r.width, height: r.height };
}

export const FULL_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];
