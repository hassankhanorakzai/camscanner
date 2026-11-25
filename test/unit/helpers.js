'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const images = require('../../src/main/images');

/** Imaging stub for plain-Node tests (nativeImage only exists inside Electron). */
const imaging = {
  imageInfo: images.imageInfo,
  thumbnail: (buf) => Buffer.from(buf),
  reencode: (buf) => Buffer.from(buf),
  toJpeg: (buf) => Buffer.from(buf),
  dhash: (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16),
  hamming: images.hamming,
};

const fixture = (n) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', n));
const tmpDir = (p = 'ss-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

module.exports = { imaging, fixture, tmpDir };
