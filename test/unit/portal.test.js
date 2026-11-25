'use strict';
/**
 * Integration test: PHP portal (php -S + SQLite) ↔ desktop library ↔ simulated phone.
 * The phone side uses WebCrypto (crypto.subtle) exactly like the phone web app.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { Library } = require('../../src/main/library');
const { PortalLink } = require('../../src/main/portal');
const { imaging, fixture, tmpDir } = require('./helpers');

let hasPhp = true;
try { execFileSync('php', ['-v']); } catch { hasPhp = false; }

const PORTAL = path.join(__dirname, '..', '..', 'portal');
const SETUP_KEY = 'ABCD-1234-EF56-7890';

async function startPortal() {
  const dir = tmpDir('ss-portal-');
  const cfg = path.join(dir, 'config.php');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(cfg, `<?php return ${JSON.stringify({ dsn: `sqlite:${dir}/portal.db`, setup_key_hash: crypto.createHash('sha256').update(SETUP_KEY).digest('hex'), data_dir: `${dir}/data`, max_blob_mb: 60, blob_ttl_days: 7 }).replace(/^\{/, '[').replace(/\}$/, ']').replace(/":/g, '" =>')};`);
  execFileSync('php', ['-r', `putenv("SS_PORTAL_CONFIG=${cfg}"); require "${PORTAL}/inc/core.php"; foreach (ss_schema("sqlite") as $s) ss_db()->exec($s);`]);
  const port = 18000 + Math.floor(Math.random() * 2000);
  const proc = spawn('php', ['-d', 'post_max_size=1M', '-S', `127.0.0.1:${port}`, '-t', PORTAL], { env: { ...process.env, SS_PORTAL_CONFIG: cfg }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${url}/api.php?a=ping`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  return { url, proc, dir };
}

// ---- phone helpers (WebCrypto, same as portal/app)
const subtle = crypto.webcrypto.subtle;
async function phoneKey(text) { return subtle.importKey('raw', Buffer.from(text, 'base64url'), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function pEnc(key, bytes) { const iv = crypto.randomBytes(12); const c = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)); return Buffer.concat([Buffer.from([1]), iv, c]); }
async function pDec(key, buf) { return Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(1, 13) }, key, buf.subarray(13))); }
function phoneApi(url, token) {
  return async (a, body, { raw, query = '' } = {}) => {
    const headers = { 'X-SS-Token': token || '' };
    const r = await fetch(`${url}/api.php?a=${a}${query}`, { method: body || raw ? 'POST' : 'GET', headers: { ...headers, 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }, body: raw || (body ? JSON.stringify(body) : undefined) });
    if (a === 'blob.get') return Buffer.from(await r.arrayBuffer());
    return r.json();
  };
}
async function phoneUpload(api, buf) {
  const { id } = await api('blob.create', { size: buf.length });
  for (let o = 0; o < buf.length; o += 500000) await api('blob.append', null, { raw: buf.subarray(o, o + 500000), query: `&id=${id}&offset=${o}` });
  return id;
}

test('portal relay: connect PC, pair phone, browse, scan from phone, fetch PDF, revoke', { skip: !hasPhp && 'php not installed' }, async () => {
  const portal = await startPortal();
  const lib = new Library({ root: path.join(tmpDir(), 'lib'), userId: 1, libraryId: 'L1', username: 'ali' }, imaging).open();
  const link = new PortalLink(lib, { imaging });
  try {
    const col = await lib.createCollection({ name: 'Muhammad Ali' });
    const doc = await lib.createDocument({ collectionId: col.id, title: 'CNIC', pages: [{ jpg: fixture('cnic.jpg') }, { jpg: fixture('passport.jpg') }] });

    await assert.rejects(link.connect({ url: portal.url, setupKey: 'WRONG', label: 'Office' }), /setup key/);
    await link.connect({ url: portal.url, setupKey: SETUP_KEY, label: 'Head Office' });
    link.stop();
    assert.ok(link.isLinked());
    await link.syncNow();

    // pairing QR → phone
    const pair = await link.pairing();
    const frag = new URLSearchParams(pair.link.split('#')[1]);
    assert.ok(!pair.link.split('#')[0].includes(frag.get('k')), 'key only in URL fragment');
    let api = phoneApi(portal.url, null);
    const paired = await api('device.pair', { code: frag.get('p'), label: 'Ali phone' });
    assert.ok(paired.ok, JSON.stringify(paired));
    assert.equal((await api('device.pair', { code: frag.get('p'), label: 'again' })).ok, false, 'code is single-use');
    api = phoneApi(portal.url, paired.token);
    const key = await phoneKey(frag.get('k'));

    // browse catalog + thumbnail (decrypted on the phone)
    const st = await api('dv.status');
    assert.ok(st.ok && st.catalogBlob);
    const catalog = JSON.parse(await pDec(key, await api('blob.get', null, { query: `&id=${st.catalogBlob}` })));
    assert.equal(catalog.collections[0].name, 'Muhammad Ali');
    assert.equal(catalog.documents[0].pages.length, 2);
    const thumbBlob = st.thumbs[String(doc.pages[0].id)][1];
    const thumb = await pDec(key, await api('blob.get', null, { query: `&id=${thumbBlob}` }));
    assert.equal(thumb[0], 0xff, 'thumbnail is a JPEG after decryption');

    // the server only stores ciphertext
    const stored = fs.readdirSync(path.join(portal.dir, 'data'), { recursive: true }).filter((f) => String(f).endsWith('.bin'));
    for (const f of stored) assert.ok(!fs.readFileSync(path.join(portal.dir, 'data', f)).includes(Buffer.from('Muhammad')), 'no plaintext on server');

    // phone scans a new document for a NEW person (2 pages, chunked upload > 1 chunk)
    const big = fixture('photo.png'); // ~160 KB
    const pages = [];
    for (const img of [fixture('receipt.jpg'), fixture('cnic.jpg')]) pages.push(await phoneUpload(api, await pEnc(key, img)));
    const metaBlob = await phoneUpload(api, await pEnc(key, Buffer.from(JSON.stringify({ op: 'scan', collection: { name: 'Sara Malik' }, document: { title: 'Receipt', docType: 'Receipt', tags: ['phone'] } }))));
    const sub = await api('dv.submit', { metaBlob, pageBlobs: pages });
    assert.ok(sub.ok);
    assert.ok(big.length > 0);
    await link.syncNow();
    const sara = lib.listDocuments({ search: 'Receipt' });
    assert.equal(sara.length, 1);
    assert.equal(sara[0].collectionName, 'Sara Malik');
    assert.equal(sara[0].pageCount, 2);
    assert.ok(fs.existsSync(path.join(lib.docsDir, 'Sara_Malik', 'Receipt', 'Receipt.pdf')), 'saved as real files on the PC');
    const res = (await api('dv.submissions', { ids: [sub.id] })).items[sub.id];
    assert.equal(res.status, 'done');
    const result = JSON.parse(await pDec(key, Buffer.from(res.result, 'base64')));
    assert.equal(result.documentId, sara[0].id);

    // phone edits (two-way): rename + note
    const upd = await phoneUpload(api, await pEnc(key, Buffer.from(JSON.stringify({ op: 'update', documentId: doc.id, patch: { title: 'CNIC Card', notes: 'from phone' } }))));
    await api('dv.submit', { metaBlob: upd, pageBlobs: [] });
    await link.syncNow();
    assert.equal(lib.getDocument(doc.id).title, 'CNIC Card');
    assert.ok(fs.existsSync(path.join(lib.docsDir, 'Muhammad_Ali', 'CNIC_Card', 'CNIC_Card.pdf')));

    // phone requests the PDF; PC uploads it encrypted; phone downloads + acks (deleted from server)
    const req = await api('dv.request', { kind: 'pdf', refId: doc.id });
    await link.syncNow();
    const rs = await api('dv.request_status', { id: req.id });
    assert.equal(rs.status, 'ready');
    const pdf = await pDec(key, await api('blob.get', null, { query: `&id=${rs.blobId}` }));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    await api('dv.request_done', { id: req.id });
    assert.equal((await api('blob.get', null, { query: `&id=${rs.blobId}` })).length < 200, true, 'blob removed after download');

    // catalog updated after phone changes
    const st2 = await api('dv.status');
    const cat2 = JSON.parse(await pDec(key, await api('blob.get', null, { query: `&id=${st2.catalogBlob}` })));
    assert.ok(cat2.documents.some((d) => d.title === 'CNIC Card'));
    assert.ok(cat2.collections.some((c) => c.name === 'Sara Malik'));

    // revoke the phone from the PC
    await link.syncNow();
    assert.equal(link.state.devices.length, 1);
    await link.revoke(paired.deviceId);
    const denied = await api('dv.status');
    assert.equal(denied.ok, false);
  } finally {
    link.stop();
    lib.close();
    portal.proc.kill();
  }
});
