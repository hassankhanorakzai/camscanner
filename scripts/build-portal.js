// Assembles the web portal for upload to shared hosting:
//   dist-portal/smartscan-portal/      (folder)
//   dist-portal/smartscan-portal.zip   (upload + "Extract" in cPanel/hPanel File Manager)
// The phone app reuses the desktop scanner code (crop editor, OpenCV worker).
const fs = require('fs');
const path = require('path');
const yazl = require('yazl');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-portal');
const DEST = path.join(OUT, 'smartscan-portal');
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'portal'), DEST, { recursive: true, filter: (src) => !/config\.php$/.test(src) && !/[\\/]data[\\/].+\.bin$/.test(src) });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(DEST, to)), { recursive: true }); fs.copyFileSync(path.join(ROOT, from), path.join(DEST, to)); };
copy('src/renderer/js/ui.js', 'app/js/ui.js');
copy('src/renderer/js/scan/cv.js', 'app/js/scan/cv.js');
copy('src/renderer/js/scan/editor.js', 'app/js/scan/editor.js');
copy('src/renderer/worker/cv-worker.js', 'app/worker/cv-worker.js');
copy('src/renderer/css/app.css', 'app/css/base.css');
copy(path.relative(ROOT, path.join(path.dirname(require.resolve('@techstark/opencv-js/package.json')), 'dist', 'opencv.js')), 'app/vendor/opencv.js');

if (process.argv.includes('--no-zip')) { console.log(`Portal folder: ${DEST}`); process.exit(0); }
const zip = new yazl.ZipFile();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else zip.addFile(p, path.join('smartscan-portal', path.relative(DEST, p)).split(path.sep).join('/'));
  }
})(DEST);
zip.end();
zip.outputStream.pipe(fs.createWriteStream(path.join(OUT, 'smartscan-portal.zip'))).on('close', () => {
  console.log(`Portal ready: ${path.join(OUT, 'smartscan-portal.zip')} (${(fs.statSync(path.join(OUT, 'smartscan-portal.zip')).size / 1e6).toFixed(1)} MB)`);
});
