'use strict';
/**
 * End-to-end encryption for everything sent through the web portal.
 * Format: [0x01][12-byte IV][ciphertext][16-byte GCM tag]  (AES-256-GCM)
 * Same layout as WebCrypto's AES-GCM output, so phones decrypt with crypto.subtle.
 * The 32-byte key is created on the PC and reaches phones only inside the
 * pairing QR code (URL fragment, never sent to the server).
 */
const crypto = require('node:crypto');

const newKey = () => crypto.randomBytes(32);
const keyToText = (k) => Buffer.from(k).toString('base64url');
const keyFromText = (s) => { const k = Buffer.from(String(s), 'base64url'); if (k.length !== 32) throw new Error('Bad key'); return k; };

function encrypt(key, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(data)), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, body, c.getAuthTag()]);
}

function decrypt(key, blob) {
  const b = Buffer.from(blob);
  if (b.length < 29 || b[0] !== 1) throw new Error('Unknown encrypted format');
  const iv = b.subarray(1, 13);
  const tag = b.subarray(b.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()]);
}

const encryptJson = (key, obj) => encrypt(key, Buffer.from(JSON.stringify(obj)));
const decryptJson = (key, blob) => JSON.parse(decrypt(key, blob).toString('utf8'));

module.exports = { newKey, keyToText, keyFromText, encrypt, decrypt, encryptJson, decryptJson };
