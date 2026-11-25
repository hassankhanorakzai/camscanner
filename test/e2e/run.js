'use strict';
/**
 * End-to-end test: drives the real Electron app with Playwright.
 *   node test/e2e/run.js            (Linux CI: wrap with xvfb-run)
 * Screenshots go to test/.tmp/shots.
 */
const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const OUT = path.join(ROOT, 'test', '.tmp');
const SHOTS = path.join(OUT, 'shots');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-data-'));
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-base-'));

let step = 0;
const log = (m) => console.log(`  ✓ ${m}`);
async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, `${String(++step).padStart(2, '0')}-${name}.png`) }); }

async function launch() {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-sandbox'],
    env: { ...process.env, SMARTSCAN_DATA_DIR: DATA, SMARTSCAN_DEFAULT_BASE: BASE },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  return { app, page };
}

async function waitUntil(page, fn, arg, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`waitUntil timed out: ${fn}`);
}

async function stubDialog(app, folder) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: `${f}/${String(o.defaultPath).split(/[\\/]/).pop()}` });
  }, folder);
}

async function register(page, username, name) {
  await page.waitForSelector('.auth-card');
  if (await page.$('text=Create an account')) await page.click('text=Create an account');
  await page.waitForSelector('input[placeholder="e.g. Ayesha Khan"]');
  await page.waitForTimeout(100);
  await page.fill('input[placeholder="e.g. Ayesha Khan"]', name);
  await page.fill('input[placeholder^="letters"]', username);
  await page.fill('input[placeholder^="At least 8"]', 'secret123');
  await page.fill('input[placeholder="Repeat password"]', 'secret123');
  await page.click('button:has-text("Create account")');
  await page.waitForSelector('#topbar .user-menu');
}

async function importAndSave(page, files, { collectionName, title, newCollection = false }) {
  await page.click('.nav-item[data-nav="scan"]');
  await page.click('.scan-tabs .tab:has-text("Import files")');
  await page.setInputFiles('.dropzone input[type=file]', files.map((f) => path.join(FIX, f)));
  await page.waitForFunction((n) => document.querySelectorAll('.page-item img').length === n && !document.querySelector('#saveScan').disabled, files.length, { timeout: 60000 });
  await page.click('#saveScan');
  await page.waitForSelector('#saveCollection');
  if (newCollection) {
    await page.selectOption('#saveCollection', 'new');
    await page.fill('#saveNewName', collectionName);
  } else {
    await page.selectOption('#saveCollection', { label: collectionName });
  }
  await page.fill('#saveTitle', title);
  await page.click('.modal-foot button:has-text("Save to library")');
  await page.waitForSelector('.viewer', { timeout: 60000 });
}

(async () => {
  console.log('SmartScan E2E');
  let { app, page } = await launch();
  try {
    // ---- registration & dashboard
    await page.waitForSelector('.auth-card');
    await shot(page, 'register');
    await register(page, 'ali', 'Ali Raza');
    await page.waitForSelector('#quickScan');
    log('registered first user, dashboard visible');
    const userRoot = path.join(BASE, 'SmartScan', 'Users', 'User_001_ali');
    assert.ok(fs.existsSync(path.join(userRoot, 'Documents')), 'library folder created');
    assert.ok(fs.existsSync(path.join(userRoot, 'Database', 'library.db')), 'library db created');
    await shot(page, 'dashboard-empty');

    // ---- collection
    await page.click('.nav-item[data-nav="collections"]');
    await page.click('#newCollection');
    await page.fill('input[placeholder="e.g. Muhammad Ali"]', 'Muhammad Ali');
    await page.click('.modal-foot button:has-text("Create")');
    await page.waitForSelector('#scanHere');
    assert.ok(fs.existsSync(path.join(userRoot, 'Documents', 'Muhammad_Ali')));
    log('created collection “Muhammad Ali” (folder on disk)');

    // ---- camera (fake device) renders
    await page.click('.nav-item[data-nav="scan"]');
    await page.click('.scan-tabs .tab:has-text("Camera")');
    await page.waitForFunction(() => { const v = document.querySelector('.video-wrap video'); return v && v.videoWidth > 0; }, null, { timeout: 20000 });
    await page.click('.shutter');
    await page.waitForFunction(() => document.querySelectorAll('.page-item img').length === 1, null, { timeout: 30000 });
    await shot(page, 'camera');
    log('camera capture works (fake device)');
    await page.click('.page-item button[title="Delete page"]');

    // ---- import a photographed card: edge detection + perspective correction
    await page.click('.scan-tabs .tab:has-text("Import files")');
    await page.setInputFiles('.dropzone input[type=file]', [path.join(FIX, 'card_photo.jpg'), path.join(FIX, 'cert_photo.jpg')]);
    await page.waitForFunction(() => document.querySelectorAll('.page-item img').length === 2 && !document.querySelector('#saveScan').disabled, null, { timeout: 60000 });
    await shot(page, 'scan-pages');
    // open editor to verify crop UI
    await page.click('button:has-text("Edit")');
    await page.waitForSelector('.editor canvas.crop');
    await page.waitForFunction(() => document.querySelector('.editor img.result')?.naturalWidth > 0, null, { timeout: 30000 });
    await shot(page, 'editor');
    await page.click('.filters button:has-text("B & W")');
    await page.waitForTimeout(1200);
    await shot(page, 'editor-bw');
    await page.click('.filters button:has-text("Magic colour")');
    await page.click('.ed-tools button:has-text("Done")');
    await page.waitForFunction(() => !document.querySelector('#saveScan').disabled, null, { timeout: 30000 });

    await page.click('#saveScan');
    await page.waitForSelector('#saveCollection');
    await page.selectOption('#saveCollection', { label: 'Muhammad Ali' });
    await page.fill('#saveTitle', 'CNIC');
    await shot(page, 'save-dialog');
    await page.click('.modal-foot button:has-text("Save to library")');
    await page.waitForSelector('.viewer', { timeout: 60000 });
    await page.waitForTimeout(500);
    await shot(page, 'viewer');
    const docDir = path.join(userRoot, 'Documents', 'Muhammad_Ali', 'CNIC');
    const files = fs.readdirSync(docDir).sort();
    assert.deepStrictEqual(files, ['CNIC.pdf', 'CNIC_Page_01.jpg', 'CNIC_Page_02.jpg']);
    log(`saved real files: ${files.join(', ')}`);

    // Verify that the card kept its real proportions and the PDF pages differ in size
    const { imageInfo } = require('../../src/main/images');
    const card = imageInfo(fs.readFileSync(path.join(docDir, 'CNIC_Page_01.jpg')));
    const cert = imageInfo(fs.readFileSync(path.join(docDir, 'CNIC_Page_02.jpg')));
    const cardRatio = card.width / card.height;
    console.log(`    card ${card.width}x${card.height} ratio ${cardRatio.toFixed(3)} (true 1.585); certificate ${cert.width}x${cert.height} ratio ${(cert.width / cert.height).toFixed(3)} (true 0.707)`);
    assert.ok(Math.abs(cardRatio - 856 / 540) < 0.08, 'card ratio preserved');
    assert.ok(Math.abs(cert.width / cert.height - 1240 / 1754) < 0.06, 'certificate ratio preserved');
    assert.ok(card.width < 1300 && card.width > 700, 'card cropped (no background)');
    const pdf = await PDFDocument.load(fs.readFileSync(path.join(docDir, 'CNIC.pdf')));
    const sizes = pdf.getPages().map((p) => p.getSize());
    assert.strictEqual(sizes.length, 2);
    assert.ok(Math.abs(sizes[0].width / sizes[0].height - cardRatio) < 0.01, 'PDF page 1 = card proportions');
    assert.ok(Math.abs(sizes[1].width / sizes[1].height - cert.width / cert.height) < 0.01, 'PDF page 2 = certificate proportions');
    log('edge detection + perspective correction kept true proportions; PDF pages have individual sizes (not A4)');

    // ---- viewer actions: rename, reorder, export JPG/PDF
    await stubDialog(app, OUT);
    await page.click('#downloadBtn');
    await page.click('.menu button:has-text("PDF"):not(:has-text("options"))');
    await page.waitForTimeout(800);
    assert.ok(fs.existsSync(path.join(OUT, 'CNIC.pdf')), 'PDF downloaded');
    await page.click('#downloadBtn');
    await page.click('.menu button:has-text("This page as JPG")');
    await page.waitForTimeout(800);
    assert.ok(fs.existsSync(path.join(OUT, 'CNIC_Page_01.jpg')), 'JPG downloaded');
    log('download JPG and PDF');

    await page.click('#docTitle');
    await page.fill('.modal input.input', 'CNIC Card');
    await page.click('.modal-foot button:has-text("Save")');
    await page.waitForFunction(() => document.querySelector('#docTitle')?.textContent === 'CNIC Card');
    const renamedDir = path.join(userRoot, 'Documents', 'Muhammad_Ali', 'CNIC_Card');
    assert.ok(fs.existsSync(path.join(renamedDir, 'CNIC_Card.pdf')), 'renamed folder + pdf');
    log('rename updates folder and files on disk');

    // reorder via API used by drag & drop
    const before = fs.readFileSync(path.join(renamedDir, 'CNIC_Card_Page_01.jpg')).length;
    await page.evaluate(async () => {
      const d = await window.smartscan.call('documents:list', { search: 'CNIC Card' });
      const doc = await window.smartscan.call('documents:get', d[0].id);
      await window.smartscan.call('documents:reorder', doc.id, doc.pages.map((p) => p.id).reverse());
    });
    const after = fs.readFileSync(path.join(renamedDir, 'CNIC_Card_Page_02.jpg')).length;
    assert.strictEqual(before, after, 'files renumbered after reorder');
    log('reordering renumbers files');

    // ---- second document via new collection
    await importAndSave(page, ['passport.jpg', 'receipt.jpg'], { collectionName: 'Ahmed Khan', title: 'Passport', newCollection: true });
    assert.ok(fs.existsSync(path.join(userRoot, 'Documents', 'Ahmed_Khan', 'Passport', 'Passport.pdf')));
    log('new collection created from the save dialog');

    // ---- external file sync: drop a file into a folder in "Explorer"
    const extDir = path.join(userRoot, 'Documents', 'Ahmed_Khan', 'Driving License');
    fs.mkdirSync(extDir, { recursive: true });
    fs.copyFileSync(path.join(FIX, 'cnic.jpg'), path.join(extDir, 'license front.jpg'));
    const old = Date.now() / 1000 - 30; fs.utimesSync(path.join(extDir, 'license front.jpg'), old, old);
    await page.click('.nav-item[data-nav="storage"]');
    await page.click('#rescanBtn');
    await waitUntil(page, async () => { const d = await window.smartscan.call('documents:list', { search: 'Driving License' }); return d.length === 1 && d[0].hasPdf && d[0].pageCount === 1; });
    assert.ok(fs.existsSync(path.join(extDir, 'Driving_License.pdf')) || fs.readdirSync(extDir).some((f) => f.endsWith('.pdf')), 'PDF generated for externally added folder');
    await shot(page, 'storage');
    log('externally added folder/image imported by rescan (+PDF generated)');

    // ---- documents grid, search
    await page.fill('#globalSearch', 'passport');
    await page.press('#globalSearch', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('.grid .doc-card').length === 1);
    await page.fill('#globalSearch', '');
    await page.click('.nav-item[data-nav="documents"]');
    await page.waitForFunction(() => document.querySelectorAll('.grid .doc-card').length === 3);
    await shot(page, 'documents');
    log('search and document grid');

    // ---- delete & restore via trash
    const listed = await page.evaluate(() => window.smartscan.call('documents:list', { search: 'Passport' }));
    await page.evaluate((id) => window.smartscan.call('documents:delete', [id]), listed[0].id);
    assert.ok(!fs.existsSync(path.join(userRoot, 'Documents', 'Ahmed_Khan', 'Passport')));
    await page.click('.nav-item[data-nav="trash"]');
    await page.waitForSelector('button:has-text("Restore")');
    await shot(page, 'trash');
    await page.click('button:has-text("Restore")');
    await page.waitForTimeout(600);
    assert.ok(fs.existsSync(path.join(userRoot, 'Documents', 'Ahmed_Khan', 'Passport', 'Passport.pdf')));
    log('trash + restore moves files back');

    // ---- backup
    await page.click('.nav-item[data-nav="storage"]');
    await page.click('button:has-text("Create backup")');
    for (let i = 0; i < 40 && !fs.readdirSync(OUT).some((f) => f.endsWith('.ssbackup')); i++) await page.waitForTimeout(250);
    const backups = fs.readdirSync(OUT).filter((f) => f.endsWith('.ssbackup'));
    assert.strictEqual(backups.length, 1, 'backup file written');
    log(`backup created (${backups[0]})`);

    // ---- collections + dashboard screenshots
    await page.click('.nav-item[data-nav="collections"]');
    await page.waitForSelector('.col-card');
    await shot(page, 'collections');
    await page.click('.nav-item[data-nav="dashboard"]');
    await page.waitForSelector('.grid .doc-card');
    await shot(page, 'dashboard');
    await page.click('.nav-item[data-nav="settings"]');
    await page.waitForSelector('.settings-grid');
    await shot(page, 'settings');

    // ---- second user is isolated
    await page.click('.user-menu');
    await page.click('.menu button:has-text("Sign out")');
    await register(page, 'sara', 'Sara Malik');
    const docsSara = await page.evaluate(() => window.smartscan.call('documents:list', {}));
    assert.strictEqual(docsSara.length, 0, 'second user sees no documents of the first');
    const leak = await page.evaluate(async () => { const r = await fetch('app://smartscan/_data/page/1'); return r.status; });
    assert.strictEqual(leak, 404, 'cannot load first user page by id');
    assert.ok(fs.existsSync(path.join(BASE, 'SmartScan', 'Users', 'User_002_sara', 'Documents')));
    log('second user has an isolated, empty library');

    await page.click('.user-menu');
    await page.click('.menu button:has-text("Sign out")');
    await page.waitForSelector('.auth-card');
    await page.click('.user-chip:has-text("Ali Raza")');
    await page.fill('input[type=password]', 'wrongpass1');
    await page.click('button:has-text("Sign in")');
    await page.waitForSelector('.auth-err:not(.hidden)');
    await page.fill('input[type=password]', 'secret123');
    await page.check('.auth-card input[type=checkbox]');
    await page.click('button:has-text("Sign in")');
    await page.waitForSelector('#quickScan');
    log('login rejects wrong password, accepts correct one');
    await app.close();

    // ---- remember me: relaunch → signed in automatically
    ({ app, page } = await launch());
    await page.waitForSelector('#quickScan', { timeout: 20000 });
    log('“keep me signed in” restores session after restart');

    // ---- offline drive handling: move library away → offline screen → locate
    await app.close();
    const moved = path.join(BASE, 'MovedDrive');
    fs.mkdirSync(moved, { recursive: true });
    fs.renameSync(path.join(BASE, 'SmartScan'), path.join(moved, 'SmartScan'));
    fs.writeFileSync(path.join(BASE, 'SmartScan'), 'not a folder'); // simulate a drive that is gone
    ({ app, page } = await launch());
    await page.waitForSelector('text=Your storage drive is not available', { timeout: 20000 });
    await shot(page, 'offline');
    await stubDialog(app, moved);
    await page.click('button:has-text("Locate library")');
    await page.waitForSelector('#quickScan', { timeout: 20000 });
    log('disconnected storage shows recovery screen; “Locate library” reconnects');
    await app.close();
    console.log(`\nAll E2E checks passed. Screenshots: ${SHOTS}`);
  } catch (e) {
    console.error('\nE2E FAILED:', e);
    await shot(page, 'failure').catch(() => {});
    await app.close().catch(() => {});
    process.exit(1);
  }
})();
