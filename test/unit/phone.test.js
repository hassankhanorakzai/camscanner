'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PhoneBridge } = require('../../src/main/phone');
const { fixture } = require('./helpers');

test('phone bridge: token required, only images accepted, image delivered', async () => {
  const got = [];
  const pb = new PhoneBridge((img) => got.push(img));
  const info = await pb.start();
  const port = pb.server.address().port;
  const token = pb.token;
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/?t=wrong`)).status, 403);
  assert.equal((await fetch(`${base}/`)).status, 403);
  const page = await fetch(`${base}/?t=${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Take photo/);
  assert.equal((await fetch(`${base}/upload?t=${token}`, { method: 'POST', body: 'hello' })).status, 415);
  assert.equal((await fetch(`${base}/upload?t=${token}`, { method: 'POST', body: fixture('cnic.jpg') })).status, 200);
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'jpeg');
  if (info.urls.length) assert.match(info.qr, /^data:image\/png;base64,/);
  pb.stop();
  await assert.rejects(fetch(`${base}/?t=${token}`));
});
