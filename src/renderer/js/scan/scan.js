import { h, icon, toast, modal, fmt, confirmDialog, progressModal, sortable, $ } from '../ui.js';
import { api, state, navigate, onEvent, loadSettings } from '../core.js';
import { detect, processPage, processPreview, warmup, FULL_QUAD } from './cv.js';
import { openEditor, defaultParams } from './editor.js';
import { leaveGuard } from '../app.js';

const RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };
let uidSeq = 0;

export default async function scan(view, _params, query) {
  view.className = 'flush';
  if (!state.settings) await loadSettings();
  const settings = state.settings;
  warmup().catch(() => {});

  // ---------- target (where pages will be saved)
  let target = { collection: null, doc: null, replacePageId: query.replace ? Number(query.replace) : null };
  try {
    if (query.doc) { target.doc = await api('documents:get', Number(query.doc)); target.collection = await api('collections:get', target.doc.collectionId); }
    else if (query.collection) target.collection = await api('collections:get', Number(query.collection));
  } catch { /* ignore stale ids */ }

  const pages = [];
  let saved = false;
  let source = localStorage.getItem('scanSource') || 'camera';
  let retakeIndex = -1;
  const cleanups = [];

  // ---------- layout
  const tabs = h('div', { class: 'scan-tabs' });
  const stageBody = h('div', { class: 'stage-body' });
  const controls = h('div', { class: 'stage-controls' });
  const stage = h('div', { class: 'scan-stage' }, tabs, stageBody, controls);
  const list = h('div', { class: 'pages' });
  const countEl = h('span', { class: 'muted small' });
  const saveBtn = h('button', { class: 'btn primary lg', id: 'saveScan', onclick: () => saveDialog() }, icon('check'), 'Save');
  const pdfBtn = h('button', { class: 'btn', onclick: () => previewPdf() }, icon('file'), 'Preview PDF');
  const editAll = h('button', { class: 'btn sm', onclick: () => edit(0) }, icon('edit'), 'Edit');
  const side = h('div', { class: 'scan-side' },
    h('div', { class: 'head' }, h('h3', {}, 'Pages in this scan'), countEl, editAll),
    list,
    h('div', { class: 'foot' },
      h('div', { class: 'small muted' }, target.doc ? `Adding to “${target.doc.title}” (${target.collection.name})` : target.collection ? `Saving to ${target.collection.name}` : 'Choose person & title when saving'),
      h('div', { class: 'row' }, pdfBtn, h('div', { class: 'spacer' }), saveBtn)));
  view.append(h('div', { class: 'scan' }, stage, side));

  sortable(list, '.page-item', (ids) => {
    const order = ids.map((id) => pages.find((p) => String(p.uid) === id));
    pages.splice(0, pages.length, ...order);
    renderList();
  });

  leaveGuard.fn = async () => {
    if (saved || !pages.length) return true;
    return confirmDialog('Discard this scan?', `You have ${fmt.plural(pages.length, 'unsaved page')}. Leave and discard them?`, { okLabel: 'Discard', danger: true });
  };

  // ---------- pages
  async function addPage(blob, origin, { autoDetect = true, minConfidence = 0 } = {}) {
    const p = { uid: ++uidSeq, blob, origin, params: defaultParams(settings.defaultFilter), preview: null, busy: true };
    if (retakeIndex >= 0 && retakeIndex < pages.length) {
      const old = pages[retakeIndex];
      if (old.preview) URL.revokeObjectURL(old.preview);
      p.params = { ...old.params, quad: FULL_QUAD.map((q) => [...q]) };
      pages[retakeIndex] = p;
      retakeIndex = -1;
    } else pages.push(p);
    renderList();
    try {
      const bmp = await createImageBitmap(blob);
      p.width = bmp.width; p.height = bmp.height;
      if (autoDetect) {
        const d = await detect(bmp);
        if (d && d.confidence >= minConfidence) p.params.quad = d.quad;
        p.detected = !!d;
      } else bmp.close();
      await refreshPreview(p);
    } catch (e) {
      toast(`Could not read image: ${e.message}`, 'error');
      pages.splice(pages.indexOf(p), 1);
    }
    p.busy = false;
    renderList();
    return p;
  }

  async function refreshPreview(p) {
    const r = await processPreview(p.blob, p.params, 360);
    if (p.preview) URL.revokeObjectURL(p.preview);
    p.preview = r.url; p.outW = r.width; p.outH = r.height;
  }

  function renderList() {
    list.innerHTML = '';
    countEl.textContent = pages.length ? fmt.plural(pages.length, 'page') : '';
    saveBtn.disabled = !pages.length || pages.some((p) => p.busy);
    pdfBtn.disabled = saveBtn.disabled;
    editAll.disabled = saveBtn.disabled;
    if (!pages.length) {
      list.append(h('div', { class: 'empty', style: { padding: '40px 10px' } }, icon('layers'), h('h3', {}, 'No pages yet'), h('p', { class: 'small' }, 'Capture or import pages. Each page keeps its own size — cards stay card-sized, receipts stay long.')));
      return;
    }
    pages.forEach((p, i) => {
      list.append(h('div', { class: `page-item ${retakeIndex === i ? 'retake' : ''}`, draggable: 'true', dataset: { id: p.uid } },
        h('div', { class: 'pv' }, p.preview ? h('img', { src: p.preview, alt: '' }) : h('span', { class: 'spinner' })),
        h('div', { class: 'info' }, h('b', {}, `Page ${i + 1}`), p.busy ? 'Processing…' : `${p.outW}×${p.outH}px`, h('br'), p.detected === false ? 'No edges found' : p.origin),
        h('div', { class: 'acts' },
          h('button', { class: 'btn ghost icon sm', title: 'Edit / crop', onclick: () => edit(i) }, icon('crop')),
          h('button', { class: 'btn ghost icon sm', title: 'Rotate right', onclick: async () => { p.params.rotation = (p.params.rotation + 90) % 360; p.busy = true; renderList(); await refreshPreview(p); p.busy = false; renderList(); } }, icon('rotR')),
          h('button', { class: 'btn ghost icon sm', title: 'Retake this page', onclick: () => { retakeIndex = retakeIndex === i ? -1 : i; if (retakeIndex >= 0) { setSource(source === 'phone' || source === 'scanner' ? source : 'camera'); toast(`Next capture replaces page ${i + 1}`, 'info'); } renderList(); } }, icon('camera')),
          h('button', { class: 'btn ghost icon sm', title: 'Delete page', onclick: () => { if (p.preview) URL.revokeObjectURL(p.preview); pages.splice(i, 1); if (retakeIndex === i) retakeIndex = -1; renderList(); } }, icon('trash')))));
    });
    list.scrollTop = list.scrollHeight;
  }

  async function edit(i) {
    await openEditor(pages, i, { title: 'Edit pages' });
    for (const p of pages) { p.busy = true; }
    renderList();
    for (const p of pages) { await refreshPreview(p).catch(() => {}); p.busy = false; }
    renderList();
  }

  // ---------- sources
  function setSource(s) {
    if (s === source && stageBody.childElementCount) return;
    source = s; localStorage.setItem('scanSource', s);
    while (cleanups.length) cleanups.pop()();
    stageBody.innerHTML = ''; controls.innerHTML = '';
    renderTabs();
    ({ camera: cameraSource, scanner: scannerSource, phone: phoneSource, import: importSource }[s] || cameraSource)();
  }
  function renderTabs() {
    tabs.innerHTML = '';
    for (const [id, label, ic] of [['camera', 'Camera', 'camera'], ['scanner', 'Scanner', 'printerScan'], ['phone', 'Phone', 'phone'], ['import', 'Import files', 'upload']]) {
      tabs.append(h('button', { class: `tab ${source === id ? 'on' : ''}`, onclick: () => setSource(id) }, icon(ic), label));
    }
    tabs.append(h('div', { class: 'scan-target' }, icon(target.doc ? 'file' : 'user', 14), target.doc ? `${target.collection.name} / ${target.doc.title}` : target.collection ? target.collection.name : 'New scan'));
  }

  // ---- camera
  function cameraSource() {
    const video = h('video', { autoplay: true, playsinline: true, muted: true });
    const overlay = h('canvas');
    const flash = h('div', { class: 'flash' });
    const hint = h('div', { class: 'detect-hint' }, h('span', { class: 'spinner' }), 'Starting camera…');
    const wrap = h('div', { class: 'video-wrap' }, video, overlay, flash);
    stageBody.append(wrap, hint);
    const devSel = h('select', { class: 'input', title: 'Camera' });
    const resSel = h('select', { class: 'input', title: 'Resolution' }, Object.keys(RES).map((k) => h('option', { value: k, selected: k === settings.cameraResolution }, `${RES[k][1]}p`)));
    const auto = h('input', { type: 'checkbox', checked: settings.autoCapture });
    const detectOn = h('input', { type: 'checkbox', checked: true });
    const shutter = h('button', { class: 'shutter', title: 'Capture (Space)', disabled: true }, icon('camera'));
    controls.append(devSel, resSel, h('label', { class: 'check' }, detectOn, 'Edge detection'), h('label', { class: 'check' }, auto, 'Auto-capture'), shutter,
      h('span', { class: 'small', style: { color: '#94a3b8' } }, 'Space = capture · pages are added continuously'));
    let stream = null; let alive = true; let lastQuad = null; let lastConf = 0; let stable = 0; let armed = true; let detecting = false; let timer = null;

    async function start() {
      stop();
      try {
        const [w, hh] = RES[resSel.value] || RES[1080];
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: devSel.value ? { exact: devSel.value } : undefined, width: { ideal: w }, height: { ideal: hh }, facingMode: 'environment' }, audio: false });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream;
        await video.play().catch(() => {});
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        const cur = stream.getVideoTracks()[0]?.getSettings().deviceId;
        devSel.innerHTML = '';
        devices.forEach((d, i) => devSel.append(h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label || `Camera ${i + 1}`)));
        shutter.disabled = false;
        hint.innerHTML = ''; hint.append(icon('scan', 16), 'Place the document on a contrasting surface');
        loop();
      } catch (e) {
        hint.remove();
        wrap.replaceWith(h('div', { class: 'stage-msg' }, icon('camera'), h('h3', {}, 'No camera available'),
          h('p', {}, e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow camera access for SmartScan in Windows Settings → Privacy → Camera.' : e.name === 'NotFoundError' ? 'Connect a webcam (or use a phone as webcam), or use the Scanner, Phone or Import tabs.' : e.message),
          h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn', onclick: () => { stageBody.innerHTML = ''; controls.innerHTML = ''; cameraSource(); } }, icon('refresh'), 'Try again'), h('button', { class: 'btn primary', onclick: () => setSource('phone') }, icon('phone'), 'Use phone camera'))));
        controls.innerHTML = '';
      }
    }
    function stop() { clearTimeout(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }

    function drawOverlay(q, good) {
      const r = video.getBoundingClientRect();
      overlay.width = r.width; overlay.height = r.height;
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (!q) return;
      const pts = q.map(([x, y]) => [x * overlay.width, y * overlay.height]);
      ctx.beginPath(); ctx.moveTo(...pts[0]); pts.slice(1).forEach((p) => ctx.lineTo(...p)); ctx.closePath();
      ctx.fillStyle = good ? 'rgba(34,197,94,.18)' : 'rgba(59,130,246,.16)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = good ? '#22c55e' : '#3b82f6'; ctx.stroke();
      for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
    }
    async function loop() {
      if (!alive || !stream) return;
      if (detectOn.checked && !detecting && video.videoWidth && document.visibilityState === 'visible') {
        detecting = true;
        try {
          const sw = 480; const sh = Math.round((video.videoHeight / video.videoWidth) * sw);
          const bmp = await createImageBitmap(video, { resizeWidth: sw, resizeHeight: sh, resizeQuality: 'low' });
          const d = await detect(bmp);
          const q = d?.quad || null;
          const moved = (a, b) => (!a || !b ? 1 : Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]))));
          const m = moved(q, lastQuad);
          stable = q && m < 0.02 ? stable + 1 : 0;
          if (!q || m > 0.12) armed = true;
          lastQuad = q; lastConf = d?.confidence || 0;
          const ready = stable >= 5 && lastConf > 0.2;
          drawOverlay(q, ready);
          hint.innerHTML = '';
          if (q) hint.append(icon(ready ? 'check' : 'scan', 16), auto.checked ? (armed ? (ready ? 'Hold still…' : 'Document found — hold steady') : 'Captured — place the next page') : 'Document found — press capture');
          else hint.append(icon('scan', 16), 'Looking for document edges…');
          if (auto.checked && armed && ready) { armed = false; stable = 0; await capture(); }
        } catch { /* skip frame */ } finally { detecting = false; }
      } else if (!detectOn.checked) { drawOverlay(null); lastQuad = null; }
      timer = setTimeout(loop, 220);
    }
    async function capture() {
      if (!video.videoWidth) return;
      flash.classList.add('on'); setTimeout(() => flash.classList.remove('on'), 60);
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
      addPage(blob, 'camera', { autoDetect: detectOn.checked });
    }
    shutter.addEventListener('click', capture);
    devSel.addEventListener('change', start);
    resSel.addEventListener('change', start);
    const onKey = (e) => { if (e.code === 'Space' && !e.target.matches('input,textarea,select,button') && !document.querySelector('.overlay')) { e.preventDefault(); capture(); } };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => { alive = false; stop(); document.removeEventListener('keydown', onKey); });
    start();
  }

  // ---- scanner (WIA)
  function scannerSource() {
    const panel = h('div', { class: 'panel-dark' });
    stageBody.append(panel);
    panel.append(h('div', { class: 'row' }, h('span', { class: 'spinner' }), 'Looking for scanners…'));
    let alive = true;
    cleanups.push(() => { alive = false; });
    (async () => {
      let info;
      try { info = await api('scanner:list'); } catch (e) { info = { supported: true, devices: [], error: e.message }; }
      if (!alive) return;
      panel.innerHTML = '';
      panel.append(h('h3', { style: { margin: 0, color: '#fff' } }, 'USB / network scanner'));
      if (!info.supported) { panel.append(h('p', { class: 'muted' }, info.message), h('p', { class: 'small muted' }, 'Tip: scanning software can save images to a folder — use “Import files” to bring them in.')); return; }
      const dev = h('select', { class: 'input' }, info.devices.length ? info.devices.map((d) => h('option', { value: d.id }, d.name)) : h('option', { value: '' }, 'No WIA scanner found'));
      const dpi = h('select', { class: 'input' }, [150, 200, 300, 400, 600].map((v) => h('option', { value: v, selected: v === 300 }, `${v} dpi`)));
      const color = h('select', { class: 'input' }, [['color', 'Colour'], ['gray', 'Grayscale'], ['bw', 'Black & white']].map(([v, l]) => h('option', { value: v }, l)));
      const src = h('select', { class: 'input' }, h('option', { value: 'flatbed' }, 'Flatbed (one page)'), h('option', { value: 'feeder' }, 'Document feeder (all pages)'));
      const dialog = h('input', { type: 'checkbox', checked: !info.devices.length });
      const crop = h('input', { type: 'checkbox', checked: true });
      const go = h('button', { class: 'btn primary lg' }, icon('printerScan'), 'Scan');
      const status = h('div', { class: 'small muted' }, info.error || (info.devices.length ? `${fmt.plural(info.devices.length, 'scanner')} found` : 'Connect a scanner and refresh, or use the Windows scan dialog.'));
      panel.append(
        h('label', { class: 'field' }, 'Scanner', h('div', { class: 'row' }, dev, h('button', { class: 'btn', title: 'Refresh', onclick: () => { stageBody.innerHTML = ''; scannerSource(); } }, icon('refresh')))),
        h('div', { class: 'two-col' }, h('label', { class: 'field' }, 'Resolution', dpi), h('label', { class: 'field' }, 'Colour', color)),
        h('label', { class: 'field' }, 'Paper source', src),
        h('label', { class: 'check', style: { color: '#cbd5e1' } }, crop, 'Auto-crop to the document'),
        h('label', { class: 'check', style: { color: '#cbd5e1' } }, dialog, 'Use the scanner’s own dialog (preview & area selection)'),
        go, status);
      go.addEventListener('click', async () => {
        go.disabled = true; status.textContent = 'Scanning… do not unplug the scanner.';
        try {
          const imgs = await api('scanner:acquire', { deviceId: dev.value, dpi: Number(dpi.value), color: color.value, feeder: src.value === 'feeder', dialog: dialog.checked });
          for (const img of imgs) {
            let blob = new Blob([img.bytes], { type: /\.png$/i.test(img.name) ? 'image/png' : /\.bmp$/i.test(img.name) ? 'image/bmp' : 'image/jpeg' });
            if (blob.type === 'image/bmp') blob = await toJpeg(blob);
            await addPage(blob, 'scanner', { autoDetect: crop.checked, minConfidence: 0.35 });
          }
          status.textContent = `Received ${fmt.plural(imgs.length, 'page')}.`;
        } catch (e) { status.textContent = e.message; toast(e.message, 'error'); } finally { go.disabled = false; }
      });
    })();
  }

  // ---- phone camera over Wi-Fi
  function phoneSource() {
    const panel = h('div', { class: 'panel-dark', style: { alignItems: 'center', textAlign: 'center' } }, h('span', { class: 'spinner' }));
    stageBody.append(panel);
    let alive = true;
    const off = onEvent('phone:image', async (bytes) => {
      const u8 = new Uint8Array(bytes);
      const type = u8[0] === 0x89 ? 'image/png' : 'image/jpeg';
      toast('Photo received from phone', 'success', 1500);
      await addPage(new Blob([u8], { type }), 'phone');
    });
    cleanups.push(() => { alive = false; off(); api('phone:stop').catch(() => {}); });
    api('phone:start').then((info) => {
      if (!alive) return;
      panel.innerHTML = '';
      if (!info.urls.length) { panel.append(h('h3', {}, 'No network connection'), h('p', { class: 'muted' }, 'Connect this PC and your phone to the same Wi-Fi network.')); return; }
      panel.append(h('h3', { style: { margin: 0, color: '#fff' } }, 'Scan with your phone'),
        h('p', { class: 'small muted', style: { margin: 0 } }, 'Connect your phone to the same Wi-Fi, then scan this code with its camera.'),
        h('img', { class: 'qr', src: info.qr, alt: 'QR code' }),
        h('code', { style: { userSelect: 'text', fontSize: '12px', color: '#93c5fd' } }, info.urls[0]),
        h('p', { class: 'small muted', style: { margin: 0, maxWidth: '360px' } }, 'Photos go straight to this PC over your local network and appear in the page list. Auto-crop runs here. The link stops working when you leave this tab. Windows may ask to allow SmartScan through the firewall (private networks).'));
    }).catch((e) => { panel.innerHTML = ''; panel.append(h('p', {}, e.message)); });
  }

  // ---- import images
  function importSource() {
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/bmp,image/gif', multiple: true, class: 'hidden' });
    const crop = h('input', { type: 'checkbox', checked: true });
    const zone = h('div', { class: 'dropzone' }, icon('upload', 46), h('h3', { style: { color: '#fff' } }, 'Drop images here or click to choose'),
      h('p', { class: 'muted' }, 'JPG, PNG, WEBP or BMP — photos from a phone, or files saved by scanner software.'), input);
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); handle([...e.dataTransfer.files]); });
    input.addEventListener('change', () => { handle([...input.files]); input.value = ''; });
    stageBody.append(zone);
    controls.append(h('label', { class: 'check' }, crop, 'Auto-crop imported images'));
    async function handle(files) {
      const imgs = files.filter((f) => /^image\//.test(f.type));
      if (imgs.length < files.length) toast('Some files were skipped (only images can be imported).', 'info');
      for (const f of imgs) {
        if (f.size > 60 * 1024 * 1024) { toast(`${f.name} is too large`, 'error'); continue; }
        let blob = f;
        if (!/^image\/(jpeg|png)$/.test(f.type)) blob = await toJpeg(f);
        await addPage(blob, 'import', { autoDetect: crop.checked, minConfidence: 0.3 });
      }
    }
  }

  async function toJpeg(blob) {
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  }

  // ---------- render final pages
  async function renderAll(quality, pm) {
    const out = [];
    for (let i = 0; i < pages.length; i++) {
      pm?.set(i / pages.length, `Processing page ${i + 1} of ${pages.length}…`);
      const p = pages[i];
      const r = await processPage(p.blob, p.params, { quality: quality / 100 });
      out.push({ jpg: r.bytes, width: r.width, height: r.height, original: new Uint8Array(await p.blob.arrayBuffer()), edit: p.params });
    }
    return out;
  }

  async function previewPdf(opts = {}) {
    const pm = progressModal('Preparing PDF preview…');
    try {
      const out = await renderAll(settings.jpgQuality, pm);
      pm.set(1, 'Building PDF…');
      const r = await api('pdf:previewPages', out.map((o) => ({ jpg: o.jpg, width: o.width, height: o.height })), { title: 'Scan preview', mode: opts.mode || settings.pdfMode, dpi: settings.pdfDpi, compression: opts.compression || settings.pdfCompression });
      toast(`Preview opened (${fmt.bytes(r.size)})`, 'info', 2500);
    } catch (e) { toast(e.message, 'error'); } finally { pm.close(); }
  }

  // ---------- save
  async function saveDialog() {
    if (!pages.length) return;
    const cols = await api('collections:list', {});
    const types = state.docTypes.length ? state.docTypes : ['Other'];
    const colSel = h('select', { class: 'input', id: 'saveCollection' }, h('option', { value: 'new' }, '＋ New person / collection…'), cols.map((c) => h('option', { value: c.id, selected: target.collection?.id === c.id }, c.name)));
    if (!target.collection && cols.length) colSel.value = String(cols[0].id);
    const newName = h('input', { class: 'input', placeholder: 'Person name, e.g. Muhammad Ali', id: 'saveNewName' });
    const newWrap = h('label', { class: 'field' }, 'New collection name', newName);
    const mode = h('select', { class: 'input' }, h('option', { value: 'new' }, 'New document'), h('option', { value: 'existing' }, 'Add to an existing document'));
    const existing = h('select', { class: 'input' });
    const title = h('input', { class: 'input', placeholder: 'e.g. CNIC, Passport, Degree', id: 'saveTitle', list: 'typeList' });
    const typeSel = h('select', { class: 'input' }, types.map((t) => h('option', { value: t, selected: t === 'Other' }, t)));
    const tags = h('input', { class: 'input', placeholder: 'Comma separated, optional' });
    const notes = h('textarea', { class: 'input', rows: 2, placeholder: 'Optional notes' });
    const quality = h('select', { class: 'input' }, [[98, 'Maximum'], [92, 'High'], [85, 'Good'], [75, 'Compact']].map(([v, l]) => h('option', { value: v, selected: v === settings.jpgQuality }, `${l} (${v})`)));
    const pdfMode = h('select', { class: 'input' }, [['dpi', 'Match image (keeps proportions)'], ['id1', 'Real ID-card size'], ['passport', 'Real passport-page size']].map(([v, l]) => h('option', { value: v, selected: v === settings.pdfMode }, l)));
    const comp = h('select', { class: 'input' }, [['original', 'None (best quality)'], ['high', 'Light'], ['balanced', 'Balanced'], ['small', 'Small file']].map(([v, l]) => h('option', { value: v, selected: v === settings.pdfCompression }, l)));
    title.addEventListener('input', () => { const t = types.find((x) => x.toLowerCase() === title.value.trim().toLowerCase()); if (t) typeSel.value = t; });

    const docRow = h('div', { class: 'col' });
    async function syncFields() {
      newWrap.classList.toggle('hidden', colSel.value !== 'new');
      const docs = colSel.value === 'new' ? [] : await api('documents:list', { collectionId: Number(colSel.value), sort: 'title' });
      existing.innerHTML = '';
      docs.forEach((d) => existing.append(h('option', { value: d.id, selected: target.doc?.id === d.id }, `${d.title} (${fmt.plural(d.pageCount, 'page')})`)));
      mode.disabled = !docs.length;
      if (!docs.length) mode.value = 'new';
      docRow.innerHTML = '';
      if (mode.value === 'existing') docRow.append(h('label', { class: 'field' }, 'Document', existing), h('div', { class: 'muted small' }, `The ${fmt.plural(pages.length, 'page')} will be appended and the PDF updated.`));
      else docRow.append(h('div', { class: 'two-col' }, h('label', { class: 'field' }, 'Document title', title), h('label', { class: 'field' }, 'Document type', typeSel)), h('label', { class: 'field' }, 'Tags', tags), h('label', { class: 'field' }, 'Notes', notes));
    }
    colSel.addEventListener('change', syncFields);
    mode.addEventListener('change', syncFields);
    if (target.doc) mode.value = 'existing';
    await syncFields();
    if (target.doc) { mode.value = 'existing'; await syncFields(); existing.value = String(target.doc.id); }
    if (target.replacePageId) mode.disabled = true;

    modal({
      title: target.replacePageId ? 'Replace page' : `Save ${fmt.plural(pages.length, 'page')}`,
      size: 'wide',
      body: h('div', { class: 'col' },
        target.replacePageId ? h('div', { class: 'banner info' }, icon('info'), 'The captured image will replace the selected page.') : [
          h('div', { class: 'two-col' }, h('label', { class: 'field' }, 'Person / collection', colSel), h('label', { class: 'field' }, 'Save as', mode)),
          newWrap, docRow],
        h('datalist', { id: 'typeList' }, types.map((t) => h('option', { value: t }))),
        h('div', { class: 'three-col' }, h('label', { class: 'field' }, 'JPG quality', quality), h('label', { class: 'field' }, 'PDF page size', pdfMode), h('label', { class: 'field' }, 'PDF compression', comp)),
        h('div', { class: 'muted small' }, 'Files are written to your library as JPG pages plus a PDF. Each page keeps its real cropped proportions.'),
        h('button', { class: 'btn', style: { alignSelf: 'flex-start' }, onclick: () => previewPdf({ mode: pdfMode.value, compression: comp.value }) }, icon('file'), 'Preview PDF')),
      actions: [{ label: 'Cancel' }, { label: 'Save to library', primary: true, onClick: async () => {
        let collectionId = colSel.value === 'new' ? null : Number(colSel.value);
        if (!target.replacePageId) {
          if (colSel.value === 'new' && !newName.value.trim()) { newName.focus(); toast('Enter a name for the new collection', 'error'); return false; }
          if (mode.value === 'new' && !title.value.trim()) { title.focus(); toast('Enter a document title', 'error'); return false; }
        }
        const pm = progressModal('Saving scan…');
        try {
          const out = await renderAll(Number(quality.value), pm);
          pm.set(0.95, 'Checking for duplicates…');
          const sim = await api('documents:similar', out.map((o) => o.jpg)).catch(() => []);
          const dup = sim.map((s, i) => (s ? `Page ${i + 1} looks like “${s.title}” (${s.collection})` : null)).filter(Boolean);
          if (dup.length) {
            pm.close();
            if (!(await confirmDialog('Possible duplicate', `${dup.join('\n')}\n\nSave anyway?`, { okLabel: 'Save anyway' }))) return false;
          }
          pm.set(0.97, 'Writing files…');
          let doc;
          if (target.replacePageId) {
            doc = await api('pages:replace', target.replacePageId, out[0]);
            if (out.length > 1) doc = await api('documents:addPages', doc.id, out.slice(1));
          } else {
            if (!collectionId) collectionId = (await api('collections:create', { name: newName.value.trim(), kind: 'person' })).id;
            const pdf = { mode: pdfMode.value, compression: comp.value };
            if (mode.value === 'existing') doc = await api('documents:addPages', Number(existing.value), out);
            else doc = await api('documents:create', { collectionId, title: title.value.trim(), docType: typeSel.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean), notes: notes.value, pages: out, pdf });
          }
          saved = true;
          pages.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
          toast(`Saved “${doc.title}” — ${fmt.plural(doc.pages.length, 'page')}${doc.pdfFile ? ' + PDF' : ''}`, 'success');
          leaveGuard.fn = null;
          navigate(`#/doc/${doc.id}`);
          return true;
        } finally { pm.close(); }
      } }],
    });
  }

  renderTabs();
  renderList();
  setSource(source);
  return () => { while (cleanups.length) cleanups.pop()(); pages.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)); if (leaveGuard.fn && saved) leaveGuard.fn = null; };
}
