'use strict';
/**
 * Full chain: MariaDB + install.php + PHP portal  ←→  desktop SmartScan (Electron)  ←→  phone web app (emulated Pixel 7).
 *   npm run build:portal && xvfb-run -a node test/e2e/portal-e2e.js
 */
const { _electron: electron, chromium, devices } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const SHOTS = path.join(ROOT, 'test', '.tmp', 'portal-shots');
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-portal-e2e-'));
const log = (m) => console.log(`  ✓ ${m}`);
let n = 0;
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 30000, what = 'condition') {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await fn()) return; } catch { /* retry */ } await sleep(400); }
  throw new Error(`Timed out waiting for ${what}`);
}

async function startMaria() {
  const dir = path.join(T, 'mysql'); fs.mkdirSync(dir);
  execFileSync('mariadb-install-db', [`--datadir=${dir}`, '--auth-root-authentication-method=normal', '--skip-test-db', '--user=root'], { stdio: 'ignore' });
  const sock = path.join(dir, 'sock');
  const proc = spawn('mariadbd', [`--datadir=${dir}`, `--socket=${sock}`, '--port=33071', '--bind-address=127.0.0.1', '--user=root', `--pid-file=${dir}/mysqld.pid`], { stdio: 'ignore' });
  await until(() => { execFileSync('mariadb', [`--socket=${sock}`, '-uroot', '-e', 'SELECT 1'], { stdio: 'ignore' }); return true; }, 60000, 'mariadb');
  execFileSync('mariadb', [`--socket=${sock}`, '-uroot', '-e', "CREATE DATABASE ssportal; CREATE USER 'ssuser'@'127.0.0.1' IDENTIFIED BY 'dbpass123'; GRANT ALL ON ssportal.* TO 'ssuser'@'127.0.0.1';"]);
  return proc;
}

(async () => {
  console.log('SmartScan portal E2E (MariaDB + PHP + desktop + phone)');
  const procs = [];
  let app; let browser;
  try {
    procs.push(await startMaria());
    log('MariaDB running (like shared hosting MySQL)');
    const web = path.join(T, 'www');
    fs.cpSync(path.join(ROOT, 'dist-portal', 'smartscan-portal'), web, { recursive: true });
    procs.push(spawn('php', ['-d', 'post_max_size=2M', '-S', '127.0.0.1:18765', '-t', web], { stdio: 'ignore' }));
    const URL = 'http://127.0.0.1:18765';
    await until(async () => (await fetch(`${URL}/install.php`)).ok, 15000, 'php server');

    // ---- install.php in a browser
    browser = await chromium.launch();
    const admin = await browser.newPage();
    await admin.goto(`${URL}/install.php`);
    await admin.fill('input[name=host]', '127.0.0.1:33071'.replace(':33071', ';port=33071'));
    await admin.fill('input[name=name]', 'ssportal');
    await admin.fill('input[name=user]', 'ssuser');
    await admin.fill('input[name=pass]', 'dbpass123');
    await admin.click('button[type=submit]');
    const setupKey = (await admin.textContent('.key')).trim();
    assert.match(setupKey, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    await shot(admin, 'install-done');
    assert.equal((await fetch(`${URL}/config.php`)).status !== 200 || !(await (await fetch(`${URL}/config.php`)).text()).includes('db_pass'), true, 'config not readable');
    log(`portal installed via install.php (setup key ${setupKey})`);

    // ---- desktop app
    const DATA = path.join(T, 'data'); const BASE = path.join(T, 'base');
    fs.mkdirSync(DATA); fs.mkdirSync(BASE);
    app = await electron.launch({ executablePath: require('electron'), args: [ROOT, '--no-sandbox'], env: { ...process.env, SMARTSCAN_DATA_DIR: DATA, SMARTSCAN_DEFAULT_BASE: BASE } });
    const pc = await app.firstWindow();
    await pc.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
    pc.on('pageerror', (e) => console.error('[pc pageerror]', e.message));
    await pc.waitForSelector('.auth-card');
    await pc.fill('input[placeholder="e.g. Ayesha Khan"]', 'Ali Raza');
    await pc.fill('input[placeholder^="letters"]', 'ali');
    await pc.fill('input[placeholder^="At least 8"]', 'secret123');
    await pc.fill('input[placeholder="Repeat password"]', 'secret123');
    await pc.click('button:has-text("Create account")');
    await pc.waitForSelector('#quickScan');
    await pc.evaluate(async () => {
      const c = await window.smartscan.call('collections:create', { name: 'Muhammad Ali' });
      return c.id;
    });
    // put one document in the library through the normal scan UI
    await pc.click('.nav-item[data-nav="scan"]');
    await pc.click('.scan-tabs .tab:has-text("Import files")');
    await pc.setInputFiles('.dropzone input[type=file]', [path.join(FIX, 'card_photo.jpg')]);
    await pc.waitForFunction(() => document.querySelectorAll('.page-item img').length === 1 && !document.querySelector('#saveScan').disabled, null, { timeout: 60000 });
    await pc.click('#saveScan');
    await pc.selectOption('#saveCollection', { label: 'Muhammad Ali' });
    await pc.fill('#saveTitle', 'CNIC');
    await pc.click('.modal-foot button:has-text("Save to library")');
    await pc.waitForSelector('.viewer', { timeout: 60000 });

    await pc.click('.nav-item[data-nav="portal"]');
    await pc.fill('#portalUrl', URL);
    await pc.fill('#portalKey', setupKey);
    await pc.click('#portalConnect');
    await pc.waitForSelector('#pairPhone', { timeout: 20000 });
    await pc.click('#pairPhone');
    await pc.waitForSelector('#pairQr');
    await shot(pc, 'pc-pair-qr');
    const pairing = await pc.evaluate(() => window.smartscan.call('portal:pairing'));
    await pc.click('.modal-foot button:has-text("Done")');
    log('desktop connected to portal; pairing QR shown');

    // ---- phone
    const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
    const phone = await ctx.newPage();
    phone.on('pageerror', (e) => console.error('[phone pageerror]', e.message));
    await phone.goto(pairing.link);
    await phone.waitForSelector('text=Connect this phone');
    assert.ok(!phone.url().includes('k='), 'key removed from address bar');
    await shot(phone, 'phone-pair');
    await phone.click('button:has-text("Connect this phone")');
    await phone.waitForSelector('.mrow:has-text("Muhammad Ali")', { timeout: 30000 });
    await phone.waitForTimeout(800);
    await shot(phone, 'phone-home');
    log('phone paired by QR link and shows the PC library (decrypted on the phone)');

    await phone.click('.mrow:has-text("Muhammad Ali")');
    await phone.click('.mrow:has-text("CNIC")');
    await phone.waitForSelector('.mgrid .mthumb img[src^="blob:"]', { timeout: 20000 });
    await shot(phone, 'phone-doc');
    const dl = phone.waitForEvent('download', { timeout: 60000 });
    await phone.click('button:has-text("Open PDF")');
    const download = await dl;
    const pdfPath = path.join(T, 'phone.pdf');
    await download.saveAs(pdfPath);
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 5).toString(), '%PDF-');
    log('phone fetched the PDF from the PC through the portal');

    // ---- phone scans a new document for a new person
    await phone.click('.mnav a:has-text("Scan")');
    await phone.setInputFiles('input[capture]', path.join(FIX, 'cert_photo.jpg'));
    await phone.waitForFunction(() => document.querySelector('.mpage .pv img'), null, { timeout: 90000 });
    await phone.waitForFunction(() => !document.querySelector('#sendScan').disabled, null, { timeout: 60000 });
    await shot(phone, 'phone-scan');
    await phone.click('.mpage button:has(svg) >> nth=1'); // crop editor
    await phone.waitForSelector('.editor canvas.crop');
    await phone.waitForFunction(() => document.querySelector('.editor img.result')?.naturalWidth > 0, null, { timeout: 60000 });
    await shot(phone, 'phone-editor');
    await phone.click('.ed-tools button:has-text("Done")');
    await phone.waitForFunction(() => !document.querySelector('#sendScan').disabled, null, { timeout: 60000 });
    await phone.click('#sendScan');
    await phone.selectOption('.modal select >> nth=0', 'new');
    await phone.fill('input[placeholder="Person name"]', 'Sara Malik');
    await phone.fill('input[placeholder="e.g. CNIC, Passport"]', 'Experience Certificate');
    await phone.click('.modal-foot button:has-text("Save")');
    await phone.waitForSelector('text=Saved on PC', { timeout: 90000 });
    await shot(phone, 'phone-outbox');
    const libRoot = path.join(BASE, 'SmartScan', 'Users', 'User_001_ali', 'Documents', 'Sara_Malik', 'Experience_Certificate');
    assert.ok(fs.existsSync(path.join(libRoot, 'Experience_Certificate.pdf')), 'phone scan saved as JPG+PDF on the PC drive');
    const { imageInfo } = require('../../src/main/images');
    const info = imageInfo(fs.readFileSync(path.join(libRoot, 'Experience_Certificate_Page_01.jpg')));
    console.log(`    phone-cropped certificate: ${info.width}x${info.height} ratio ${(info.width / info.height).toFixed(3)} (true 0.707)`);
    assert.ok(Math.abs(info.width / info.height - 0.707) < 0.05, 'auto-crop on the phone kept proportions');
    log('phone scan (auto-cropped on the phone) saved into the PC library as real files');

    // ---- two-way: rename from phone
    await phone.click('.mnav a:has-text("Library")');
    await until(async () => (await phone.$$('.mrow:has-text("Sara Malik")')).length > 0, 30000, 'catalog refresh');
    await phone.click('.mrow:has-text("Sara Malik")');
    await phone.click('.mrow:has-text("Experience Certificate")');
    await phone.click('.mhead .btn.icon >> nth=-1');
    await phone.click('.menu button:has-text("Rename")');
    await phone.fill('.modal input.input', 'Experience Letter');
    await phone.click('.modal-foot button:has-text("Save")');
    await until(() => fs.existsSync(path.join(BASE, 'SmartScan', 'Users', 'User_001_ali', 'Documents', 'Sara_Malik', 'Experience_Letter', 'Experience_Letter.pdf')), 60000, 'rename on PC');
    log('rename on the phone renamed the folder and files on the PC');

    // ---- PC shows the phone + activity
    await pc.click('.nav-item[data-nav="dashboard"]');
    await pc.click('.nav-item[data-nav="portal"]');
    await pc.waitForSelector('text=Paired phones (1)');
    await shot(pc, 'pc-portal');
    // revoke → phone is told
    await pc.click('button:has-text("Remove")');
    await pc.click('.modal-foot button:has-text("Remove")');
    await phone.reload();
    await phone.waitForSelector('text=not connected yet', { timeout: 30000 });
    log('removing the phone on the PC disconnects it');
    console.log(`\nAll portal E2E checks passed. Screenshots: ${SHOTS}`);
  } catch (e) {
    console.error('\nPORTAL E2E FAILED:', e);
    process.exitCode = 1;
  } finally {
    await app?.close().catch(() => {});
    await browser?.close().catch(() => {});
    for (const p of procs) p.kill();
  }
})();
