// Renders build/icon.png (512px) and build/icon.ico from src/renderer/assets/icon.svg using Chromium.
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/assets/icon.svg'), 'utf8');
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 512, height: 512 } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`);
  await p.screenshot({ path: path.join(__dirname, '..', 'build/icon.png'), omitBackground: true });
  await b.close();
  try { execFileSync('convert', ['build/icon.png', '-define', 'icon:auto-resize=256,128,64,48,32,16', 'build/icon.ico'], { cwd: path.join(__dirname, '..') }); } catch { console.warn('ImageMagick not found: build/icon.ico not regenerated'); }
})();
