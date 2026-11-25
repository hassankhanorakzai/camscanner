'use strict';
/**
 * "Scan with phone": a temporary, token-protected web page on the local
 * network. The phone opens it (QR code), takes photos with its camera and they
 * arrive in the scan session on the PC. Nothing leaves the local network; the
 * server only runs while the Phone panel is open.
 */
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { detectImageType } = require('./storage');

const MAX_UPLOAD = 30 * 1024 * 1024;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push({ name, address: a.address });
    }
  }
  // prefer typical home/office ranges
  return out.sort((a, b) => score(b.address) - score(a.address));
}
const score = (ip) => (/^192\.168\./.test(ip) ? 3 : /^10\./.test(ip) ? 2 : /^172\./.test(ip) ? 1 : 0);

const PAGE = (token) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SmartScan – Phone camera</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;min-height:100vh}
h1{font-size:20px;margin:28px 0 6px}p{color:#94a3b8;text-align:center;margin:0 24px 20px}
label{display:block;background:#2563eb;color:#fff;padding:22px 28px;border-radius:16px;font-size:20px;font-weight:600;margin:10px}
label.alt{background:#334155;font-size:16px;padding:14px 22px}input{display:none}#log{margin-top:18px;width:90%;max-width:420px}
.it{background:#1e293b;border-radius:10px;padding:10px 14px;margin:6px 0;font-size:14px}.ok{color:#4ade80}.err{color:#f87171}
</style></head><body><h1>SmartScan</h1><p>Take a photo of each page. Photos are sent straight to your PC over your local network.</p>
<label>📷 Take photo<input id="cam" type="file" accept="image/*" capture="environment"></label>
<label class="alt">Choose from gallery<input id="gal" type="file" accept="image/jpeg,image/png" multiple></label>
<div id="log"></div><script>
const log=document.getElementById('log');
async function send(files){for(const f of files){const d=document.createElement('div');d.className='it';d.textContent='Sending '+(f.name||'photo')+'…';log.prepend(d);
try{const r=await fetch('/upload?t=${token}',{method:'POST',headers:{'Content-Type':f.type||'image/jpeg'},body:f});
if(!r.ok)throw new Error(await r.text());d.textContent='✓ Received by PC';d.classList.add('ok')}catch(e){d.textContent='✗ '+e.message;d.classList.add('err')}}}
for(const id of ['cam','gal'])document.getElementById(id).addEventListener('change',e=>{send([...e.target.files]);e.target.value=''});
</script></body></html>`;

class PhoneBridge {
  constructor(onImage) { this.onImage = onImage; this.server = null; this.token = null; this.received = 0; }

  async start() {
    if (this.server) return this.info();
    this.token = crypto.randomBytes(18).toString('base64url');
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.headersTimeout = 20000;
    this.server.requestTimeout = 120000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '0.0.0.0', resolve); });
    return this.info();
  }

  async info() {
    const ips = lanAddresses();
    const port = this.server.address().port;
    const urls = ips.map((ip) => `http://${ip.address}:${port}/?t=${this.token}`);
    const qr = urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 260 }) : null;
    return { running: true, urls, qr, received: this.received };
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const given = Buffer.from(String(url.searchParams.get('t') || ''));
    const want = Buffer.from(this.token || '');
    const tokOk = want.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (!tokOk) { res.writeHead(403); return res.end('Link expired. Scan the QR code on your PC again.'); }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
      return res.end(PAGE(this.token));
    }
    if (req.method === 'POST' && url.pathname === '/upload') {
      const chunks = []; let size = 0; let aborted = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_UPLOAD) { aborted = true; res.writeHead(413); res.end('Image too large'); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        const buf = Buffer.concat(chunks);
        const type = detectImageType(buf);
        if (type !== 'jpeg' && type !== 'png') { res.writeHead(415); return res.end('Only JPG/PNG photos are accepted'); }
        this.received++;
        this.onImage({ bytes: buf, type });
        res.writeHead(200); res.end('ok');
      });
      return undefined;
    }
    res.writeHead(404); return res.end('Not found');
  }

  stop() {
    if (this.server) { this.server.close(); this.server.closeAllConnections?.(); }
    this.server = null; this.token = null; this.received = 0;
    return { running: false };
  }
}

module.exports = { PhoneBridge, lanAddresses };
