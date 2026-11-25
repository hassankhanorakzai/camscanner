'use strict';
/**
 * Image helpers for the main process. Dimension parsing is pure JS; resizing
 * and re-encoding use Electron's nativeImage (no native add-ons needed).
 */
let nativeImage = null;
function ni() {
  if (!nativeImage) nativeImage = require('electron').nativeImage;
  return nativeImage;
}

/** Read width/height from JPEG or PNG headers without decoding. */
function imageInfo(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    let orientation = 1;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { off += marker === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('ascii', off + 4, off + 8) === 'Exif') orientation = exifOrientation(buf, off + 10) || 1;
      if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        const swap = orientation >= 5 && orientation <= 8;
        return { type: 'jpeg', width: swap ? height : width, height: swap ? width : height, rawWidth: width, rawHeight: height, orientation };
      }
      off += 2 + len;
    }
  }
  return null;
}

function exifOrientation(buf, tiff) {
  try {
    const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
    const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = tiff + r32(tiff + 4);
    const n = r16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (r16(e) === 0x0112) return r16(e + 8);
    }
  } catch { /* ignore malformed EXIF */ }
  return 1;
}

function fromBuffer(buf) {
  const img = ni().createFromBuffer(Buffer.from(buf));
  if (img.isEmpty()) throw new Error('Unsupported or corrupt image');
  return img;
}

function resizeTo(img, maxDim) {
  const { width, height } = img.getSize();
  const scale = Math.min(1, maxDim / Math.max(width, height));
  if (scale >= 1) return img;
  return img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' });
}

function thumbnail(buf, maxDim = 420) {
  return resizeTo(fromBuffer(buf), maxDim).toJPEG(78);
}

function reencode(buf, { maxDim = 100000, quality = 85 } = {}) {
  return resizeTo(fromBuffer(buf), maxDim).toJPEG(quality);
}

function toJpeg(buf, quality = 92) { return fromBuffer(buf).toJPEG(quality); }

/** 64-bit difference hash, for near-duplicate detection. */
function dhash(buf) {
  const img = fromBuffer(buf).resize({ width: 9, height: 8, quality: 'good' });
  const bmp = img.toBitmap(); // BGRA
  const g = (x, y) => { const i = (y * 9 + x) * 4; return bmp[i] * 0.114 + bmp[i + 1] * 0.587 + bmp[i + 2] * 0.299; };
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g(x, y) > g(x + 1, y) ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

function hamming(a, b) {
  if (!a || !b) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

module.exports = { imageInfo, thumbnail, reencode, toJpeg, dhash, hamming };
