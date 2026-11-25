'use strict';
/** Small app-level JSON config in the app data folder (not per user). */
const fs = require('node:fs');
const path = require('node:path');

class Config {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'config.json');
    this.safe = safeStorage;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }
  get(k, d) { return this.data[k] ?? d; }
  set(k, v) {
    if (v === undefined) delete this.data[k]; else this.data[k] = v;
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  /** Store a secret encrypted with the OS (DPAPI on Windows) when available. */
  setSecret(k, value) {
    if (value == null) return this.set(k, undefined);
    if (this.safe?.isEncryptionAvailable()) this.set(k, { enc: true, v: this.safe.encryptString(value).toString('base64') });
    else this.set(k, { enc: false, v: Buffer.from(value).toString('base64') });
  }
  getSecret(k) {
    const e = this.data[k];
    if (!e) return null;
    try {
      return e.enc ? this.safe.decryptString(Buffer.from(e.v, 'base64')) : Buffer.from(e.v, 'base64').toString();
    } catch { return null; }
  }
}

module.exports = { Config };
