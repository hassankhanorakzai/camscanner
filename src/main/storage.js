'use strict';
/**
 * Safe file-system helpers. Every path that touches a user's library goes
 * through these functions so that names are sanitised for Windows, paths can
 * never escape the library root, and writes are atomic.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class AppError extends Error {
  constructor(message, code = 'APP_ERROR') {
    super(message);
    this.code = code;
    this.userFacing = true;
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Turn arbitrary user text into a single, Windows-safe path segment. */
function safeSegment(name, fallback = 'Untitled', maxLen = 60) {
  let s = String(name ?? '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ');
  s = s.replace(/\s+/g, '_').replace(/_+/g, '_');
  s = s.replace(/^[._\s]+|[._\s]+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[._\s]+$/g, '');
  if (!s) s = fallback;
  if (RESERVED.test(s.split('.')[0])) s = '_' + s;
  return s;
}

/** Pick a name not present in `taken` (case-insensitive) and not on disk in `dir`. */
function uniqueSegment(dir, base, taken = [], ext = '') {
  const lower = new Set(taken.map((t) => String(t).toLowerCase()));
  for (let i = 1; i < 10000; i++) {
    const candidate = i === 1 ? base : `${base}_${i}`;
    const full = candidate + ext;
    if (lower.has(full.toLowerCase())) continue;
    if (dir && fs.existsSync(path.join(dir, full))) continue;
    return candidate;
  }
  return `${base}_${crypto.randomBytes(3).toString('hex')}`;
}

/** Resolve segments under root and guarantee the result stays inside root. */
function resolveInside(root, ...segments) {
  const base = path.resolve(root);
  for (const seg of segments) {
    if (seg == null) continue;
    const str = String(seg);
    if (path.isAbsolute(str) || str.split(/[\\/]/).some((p) => p === '..')) {
      throw new AppError('Invalid path', 'PATH_TRAVERSAL');
    }
  }
  const full = path.resolve(base, ...segments.filter((s) => s != null).map(String));
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new AppError('Invalid path', 'PATH_TRAVERSAL');
  return full;
}

/** Additional symlink-aware check for existing paths. */
function assertRealInside(root, full) {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(full);
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new AppError('Invalid path', 'PATH_TRAVERSAL');
  } catch (e) {
    if (e.code === 'PATH_TRAVERSAL') throw e;
  }
  return full;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      await sleep(80 * (i + 1));
    }
  }
  if (last && ['EBUSY', 'EPERM', 'EACCES'].includes(last.code)) {
    throw new AppError(`File is in use or not writable: ${last.path || ''}. Close it in other programs and try again.`, 'FILE_LOCKED');
  }
  throw last;
}

/** Atomic write: temp file in same dir, fsync, rename over target. */
async function atomicWrite(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await withRetry(() => fsp.rename(tmp, file));
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function moveDir(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await withRetry(() => fsp.rename(from, to));
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}
const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function dirSize(dir) {
  let total = 0; let files = 0;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try { total += (await fsp.stat(p)).size; files++; } catch { /* ignore */ }
      }
    }
  }
  await walk(dir);
  return { bytes: total, files };
}

async function freeSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}

function isReachable(dir) {
  try { fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK); return fs.statSync(dir).isDirectory(); } catch { return false; }
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
const isImageFile = (n) => IMAGE_EXT.has(path.extname(n).toLowerCase());
const isPdfFile = (n) => path.extname(n).toLowerCase() === '.pdf';
const isHiddenName = (n) => n.startsWith('.') || n.startsWith('~$') || /^(thumbs\.db|desktop\.ini)$/i.test(n);

/** Validate magic bytes of image payloads coming from the renderer / phone. */
function detectImageType(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

module.exports = {
  AppError, safeSegment, uniqueSegment, resolveInside, assertRealInside, atomicWrite, moveDir, withRetry,
  sha256File, sha256Buf, dirSize, freeSpace, isReachable, isImageFile, isPdfFile, isHiddenName, detectImageType, sleep,
};
