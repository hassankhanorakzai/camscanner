// SmartScan phone web app. Shares ui.js / scan/editor.js / scan/cv.js / cv-worker with the desktop app.
import { h, icon, fmt, toast, modal, confirmDialog, promptDialog, menu } from './ui.js';
import { api, auth } from './net.js';
import * as S from './sync.js';
import { openEditor, defaultParams } from './scan/editor.js';
import { detect, processPage, processPreview, warmup } from './scan/cv.js';

const $app = document.getElementById('app');
// append ignoring null/false (conditional content)
const put = (...xs) => main.append(...xs.flat(Infinity).filter((x) => x != null && x !== false));
let cleanup = null;

// ---------------------------------------------------------------- boot & pairing
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get('p') && frag.get('k')) {
    const pair = { code: frag.get('p'), key: frag.get('k') };
    history.replaceState(null, '', location.pathname); // remove the key from the address bar/history
    return pairScreen(pair);
  }
  if (!auth.get()) return notPaired();
  await S.loadCached();
  S.onChange((what) => {
    if (what === 'unpaired') { toast('This phone was removed from the office PC.', 'error', 6000); auth.clear(); notPaired(); return; }
    renderBar();
    if (what === 'catalog' || what === 'offline' || what === 'outbox') route(true);
  });
  window.addEventListener('hashchange', () => route());
  if (!location.hash) location.hash = '#/home';
  route();
  S.refresh();
  setInterval(() => { if (document.visibilityState === 'visible') S.refresh(); }, 10000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') S.refresh(); });
}

function pairScreen(pair) {
  const isIOS = /iPhone|iPad/.test(navigator.userAgent);
  const name = h('input', { class: 'input', value: isIOS ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone', maxlength: 60 });
  const btn = h('button', { class: 'btn primary lg block' }, 'Connect this phone');
  const err = h('div', { class: 'banner err hidden' });
  btn.addEventListener('click', async () => {
    btn.disabled = true; err.classList.add('hidden');
    try {
      const r = await api('device.pair', { code: pair.code, label: name.value.trim() || 'Phone' }, { token: null });
      auth.set({ token: r.token, deviceId: r.deviceId, key: pair.key, libraryId: r.libraryId, label: r.libraryLabel, deviceName: name.value.trim() });
      location.hash = '#/home';
      location.reload();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); btn.disabled = false; }
  });
  $app.innerHTML = '';
  $app.append(h('div', { class: 'center-screen' }, h('div', { class: 'logo big' }, icon('scan')), h('h1', {}, 'SmartScan'),
    h('p', { class: 'muted' }, 'Connect this phone to your office PC. Documents are end-to-end encrypted — the website cannot read them.'),
    err, h('label', { class: 'field' }, 'Name this phone', name), btn));
}

function notPaired() {
  $app.innerHTML = '';
  $app.append(h('div', { class: 'center-screen' }, h('div', { class: 'logo big' }, icon('scan')), h('h1', {}, 'SmartScan'),
    h('p', {}, 'This phone is not connected yet.'),
    h('ol', { class: 'muted', style: { textAlign: 'left' } }, h('li', {}, 'On the office PC open SmartScan → Phone & Web.'), h('li', {}, 'Click “Connect a phone”.'), h('li', {}, 'Scan the QR code with this phone’s camera.'))));
}

// ---------------------------------------------------------------- shell
const bar = h('header', { class: 'mbar' });
const main = h('main', { class: 'mmain' });
const nav = h('nav', { class: 'mnav' });
function shell() {
  if (!$app.contains(main)) { $app.innerHTML = ''; $app.append(bar, main, nav); }
  renderBar(); renderNav();
}
function renderBar() {
  const a = auth.get();
  if (!a) return;
  const st = S.state;
  const dot = !st.online ? ['off', 'Offline'] : st.pcOnline ? ['on', 'PC online'] : ['warn', 'PC is off'];
  bar.innerHTML = '';
  bar.append(h('div', { class: 'logo' }, icon('scan')), h('div', { class: 'grow' }, h('b', {}, st.catalog?.library || a.label || 'SmartScan'), h('div', { class: 'small muted' }, st.catalog ? `${st.catalog.owner}` : 'Loading…')),
    h('span', { class: `pill ${dot[0]}`, title: st.error || '' }, h('i'), dot[1]));
}
function renderNav() {
  const cur = location.hash.split('/')[1] || 'home';
  nav.innerHTML = '';
  for (const [id, label, ic] of [['home', 'Library', 'users'], ['scan', 'Scan', 'camera'], ['outbox', 'Sent', 'upload'], ['settings', 'More', 'settings']]) {
    nav.append(h('a', { href: `#/${id}`, class: cur === id ? 'on' : '' }, icon(ic), h('span', {}, label)));
  }
}

let scanState = null; // pages being scanned survive navigation
async function route(soft = false) {
  if (!auth.get()) return;
  shell();
  const [, name = 'home', id] = location.hash.split('/');
  if (soft && name === 'scan') return; // never re-render the scanner under the user's fingers
  const keepScroll = soft ? main.scrollTop : 0;
  cleanup?.(); cleanup = null;
  main.innerHTML = '';
  const views = { home, person, doc, scan, outbox, settings };
  try { cleanup = (await (views[name] || home)(id)) || null; } catch (e) { put(h('div', { class: 'banner err' }, e.message)); }
  if (soft) main.scrollTop = keepScroll;
}

function thumbImg(page) {
  const img = h('img', { alt: '', loading: 'lazy' });
  if (page) S.thumbUrl(page.id, page.v).then((u) => { if (u) img.src = u; }).catch(() => {});
  return h('div', { class: 'mthumb' }, img);
}
function needCatalog() {
  if (S.state.catalog) return false;
  put(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', {}, S.state.error || 'Loading your library…')));
  return true;
}

// ---------------------------------------------------------------- library
let search = '';
async function home() {
  if (needCatalog()) return;
  const cat = S.state.catalog;
  const q = h('input', { class: 'input', placeholder: 'Search people or documents', value: search, type: 'search' });
  const list = h('div', { class: 'mlist' });
  const draw = () => {
    const s = search.trim().toLowerCase();
    list.innerHTML = '';
    if (s) {
      const docs = cat.documents.filter((d) => [d.title, d.docType, ...(d.tags || []), S.findCol(d.collectionId)?.name].join(' ').toLowerCase().includes(s));
      if (!docs.length) list.append(h('div', { class: 'empty' }, 'No matches'));
      docs.slice(0, 80).forEach((d) => list.append(docRow(d, true)));
      return;
    }
    const cols = [...cat.collections].sort((a, b) => a.name.localeCompare(b.name));
    if (!cols.length) list.append(h('div', { class: 'empty' }, h('p', {}, 'No people yet. Tap Scan to add the first document.')));
    for (const c of cols) {
      const docs = cat.documents.filter((d) => d.collectionId === c.id);
      const cover = docs.find((d) => d.pages.length)?.pages[0];
      list.append(h('a', { class: 'mrow', href: `#/person/${c.id}` }, thumbImg(cover), h('div', { class: 'grow' }, h('b', {}, c.name), h('div', { class: 'small muted' }, `${fmt.plural(docs.length, 'document')}${S.offline.get().people.includes(c.id) ? ' · offline' : ''}`)), icon('chevR')));
    }
  };
  q.addEventListener('input', () => { search = q.value; draw(); });
  put(h('div', { class: 'mpad col' }, q, h('button', { class: 'btn primary lg block', onclick: () => { location.hash = '#/scan'; } }, icon('camera'), 'Scan a document')),
    h('h3', { class: 'msec' }, search ? 'Results' : 'People & collections'), list);
  draw();
}

function docRow(d, showPerson) {
  return h('a', { class: 'mrow', href: `#/doc/${d.id}` }, thumbImg(d.pages[0]), h('div', { class: 'grow' }, h('b', {}, d.title),
    h('div', { class: 'small muted' }, [showPerson ? S.findCol(d.collectionId)?.name : null, d.docType, fmt.plural(d.pages.length, 'page')].filter(Boolean).join(' · ')),
    S.offline.isDoc(d) ? h('span', { class: 'badge jpg' }, 'Offline') : null), icon('chevR'));
}

async function person(id) {
  if (needCatalog()) return;
  const c = S.findCol(id);
  if (!c) { put(h('div', { class: 'empty' }, 'Not found (it may have been deleted on the PC).')); return; }
  const docs = S.state.catalog.documents.filter((d) => d.collectionId === c.id).sort((a, b) => b.updatedAt - a.updatedAt);
  const off = S.offline.get().people.includes(c.id);
  put(
    h('div', { class: 'mhead' }, h('a', { href: '#/home', class: 'btn ghost icon' }, icon('chevL')), h('h2', {}, c.name)),
    h('div', { class: 'mpad row wrap' },
      h('button', { class: 'btn primary', onclick: () => { scanState = null; location.hash = `#/scan/c${c.id}`; } }, icon('camera'), 'Scan for this person'),
      h('button', { class: `btn ${off ? 'active' : ''}`, onclick: () => S.offline.togglePerson(c.id) }, icon('download'), off ? 'Offline ✓' : 'Keep offline')),
    c.notes ? h('p', { class: 'mpad-x muted small' }, c.notes) : null,
    h('div', { class: 'mlist' }, docs.length ? docs.map((d) => docRow(d)) : h('div', { class: 'empty' }, 'No documents yet.')));
}

async function doc(id) {
  if (needCatalog()) return;
  const d = S.findDoc(id);
  if (!d) { put(h('div', { class: 'empty' }, 'Not found (it may have been deleted on the PC).')); return; }
  const c = S.findCol(d.collectionId);
  const status = h('div', { class: 'small muted mpad-x' });
  const ready = await S.offlineReady(d);
  status.textContent = ready ? 'PDF saved on this phone (works offline).' : S.state.pcOnline ? 'PDF will be fetched from the PC when you open it.' : 'PC is off — files that are not saved offline can’t be opened right now.';
  const more = h('button', { class: 'btn icon' }, icon('more'));
  more.addEventListener('click', () => menu(more, [
    { label: 'Rename', icon: 'edit', onClick: async () => { const t = await promptDialog('Rename document', 'Title', d.title); if (t && t !== d.title) { await S.ops.update(d, { title: t }); toast('Sent to PC', 'success'); } } },
    { label: 'Notes', icon: 'file', onClick: () => notesDialog(d) },
    { label: 'Add tag', icon: 'tag', onClick: async () => { const t = await promptDialog('Add tag', 'Tag', ''); if (t) { await S.ops.update(d, { tags: [...(d.tags || []), t] }); toast('Sent to PC', 'success'); } } },
    '-',
    { label: 'Move to Trash (on PC)', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog(`Delete “${d.title}”?`, 'It is moved to the Trash on the office PC and can be restored there.', { okLabel: 'Delete', danger: true })) { await S.ops.remove(d); toast('Sent to PC', 'success'); location.hash = `#/person/${d.collectionId}`; } } },
  ]));
  const grid = h('div', { class: 'mgrid' }, d.pages.map((p, i) => { const t = thumbImg(p); t.append(h('span', { class: 'n' }, i + 1)); t.addEventListener('click', () => viewPage(d, i)); return t; }));
  put(
    h('div', { class: 'mhead' }, h('a', { href: `#/person/${d.collectionId}`, class: 'btn ghost icon' }, icon('chevL')), h('div', { class: 'grow' }, h('h2', {}, d.title), h('div', { class: 'small muted' }, `${c?.name || ''} · ${d.docType} · ${fmt.plural(d.pages.length, 'page')}`)), more),
    h('div', { class: 'mpad row wrap' },
      h('button', { class: 'btn primary', disabled: !d.pages.length, onclick: (e) => openPdf(d, e.currentTarget) }, icon('file'), 'Open PDF'),
      h('button', { class: 'btn', disabled: !d.pages.length, onclick: (e) => openPdf(d, e.currentTarget, true) }, icon('share'), 'Share'),
      h('button', { class: `btn ${S.offline.isDoc(d) ? 'active' : ''}`, onclick: () => S.offline.toggleDoc(d.id) }, icon('download'), S.offline.isDoc(d) ? 'Offline ✓' : 'Keep offline'),
      h('button', { class: 'btn', onclick: () => { scanState = null; location.hash = `#/scan/d${d.id}`; } }, icon('plus'), 'Add pages')),
    status,
    (d.tags || []).length ? h('div', { class: 'mpad-x badges' }, d.tags.map((t) => h('span', { class: 'badge tag' }, t))) : null,
    d.notes ? h('p', { class: 'mpad-x small' }, d.notes) : null,
    grid);
}

function notesDialog(d) {
  const t = h('textarea', { class: 'input', rows: 5, value: d.notes || '' });
  modal({ title: 'Notes', body: t, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => { await S.ops.update(d, { notes: t.value }); toast('Sent to PC', 'success'); } }] });
}

function waitText(ms) { return S.state.pcOnline ? `Waiting for the office PC… ${Math.round(ms / 1000)}s` : 'The office PC seems to be off. Keep this open, or try later.'; }

async function openPdf(d, btn, share = false) {
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  const ac = new AbortController();
  const m = modal({ title: 'Getting PDF', body: h('div', { class: 'col center' }, h('span', { class: 'spinner' }), h('div', { class: 'muted small', id: 'waitMsg' }, 'Contacting the office PC…')), actions: [{ label: 'Cancel', onClick: () => ac.abort() }] });
  try {
    const blob = await S.getFile('pdf', d.id, d.updatedAt, { signal: ac.signal, onWait: (ms) => { const w = document.getElementById('waitMsg'); if (w) w.textContent = waitText(ms); } });
    m.close();
    const file = new File([blob], `${d.title.replace(/[^\w\- ]+/g, '_')}.pdf`, { type: 'application/pdf' });
    if (share && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: d.title }).catch(() => {}); return; }
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: file.name, target: '_blank' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { m.close(); if (e.message !== 'Cancelled') toast(e.message, 'error', 6000); } finally { btn.disabled = false; btn.innerHTML = old; }
}

async function viewPage(d, i) {
  const p = d.pages[i];
  const img = h('img', { alt: '' });
  const msg = h('div', { class: 'muted small center' });
  const box = h('div', { class: 'mviewer' }, img, msg);
  const m = modal({ title: `${d.title} – page ${i + 1}/${d.pages.length}`, size: 'full', body: box, actions: [
    { label: '‹ Prev', onClick: () => { m.close(); if (i > 0) viewPage(d, i - 1); } },
    { label: 'Next ›', onClick: () => { m.close(); if (i < d.pages.length - 1) viewPage(d, i + 1); } },
    { label: 'Close', primary: true }] });
  S.thumbUrl(p.id, p.v).then((u) => { if (u && !img.dataset.full) img.src = u; });
  const ac = new AbortController();
  try {
    msg.textContent = 'Loading full quality…';
    const blob = await S.getFile('page', p.id, p.v, { signal: ac.signal, onWait: (ms) => { msg.textContent = waitText(ms); } });
    img.dataset.full = '1'; img.src = URL.createObjectURL(blob); msg.textContent = '';
  } catch (e) { msg.textContent = `Showing preview only — ${e.message}`; }
}

// ---------------------------------------------------------------- scan
async function scan(target = '') {
  warmup().catch(() => {});
  const cat = S.state.catalog;
  if (!scanState || scanState.target !== target) scanState = { target, pages: [] };
  const pages = scanState.pages;
  const tDoc = target.startsWith('d') ? S.findDoc(target.slice(1)) : null;
  const tCol = target.startsWith('c') ? S.findCol(target.slice(1)) : tDoc ? S.findCol(tDoc.collectionId) : null;
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
  const gal = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden' });
  const list = h('div', { class: 'mpages' });
  const send = h('button', { class: 'btn primary lg block', id: 'sendScan' }, icon('upload'), 'Save to office PC');
  const filter = localStorage.getItem('ss.filter') || 'enhance';

  async function add(files) {
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue;
      const p = { blob: f, params: defaultParams(filter), preview: null, busy: true };
      pages.push(p); draw();
      try {
        const bmp = await createImageBitmap(f);
        const det = await detect(bmp);
        if (det && det.confidence > 0.3) p.params.quad = det.quad;
        await refreshPreview(p);
      } catch (e) { toast(`Could not read photo: ${e.message}`, 'error'); pages.splice(pages.indexOf(p), 1); }
      p.busy = false; draw();
    }
  }
  async function refreshPreview(p) { const r = await processPreview(p.blob, p.params, 500); if (p.preview) URL.revokeObjectURL(p.preview); p.preview = r.url; }
  function draw() {
    list.innerHTML = '';
    pages.forEach((p, i) => list.append(h('div', { class: 'mpage' },
      h('div', { class: 'pv' }, p.preview ? h('img', { src: p.preview }) : h('span', { class: 'spinner' })),
      h('div', { class: 'grow small' }, h('b', {}, `Page ${i + 1}`), p.busy ? ' processing…' : ''),
      h('button', { class: 'btn icon sm', disabled: i === 0, onclick: () => { [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; draw(); } }, icon('chevL')),
      h('button', { class: 'btn icon sm', onclick: async () => { await openEditor(pages, i, { title: 'Crop & enhance' }); for (const q of pages) await refreshPreview(q); draw(); } }, icon('crop')),
      h('button', { class: 'btn icon sm', onclick: () => { pages.splice(i, 1); draw(); } }, icon('trash')))));
    send.disabled = !pages.length || pages.some((p) => p.busy);
    send.classList.toggle('hidden', !pages.length);
  }
  cam.addEventListener('change', () => { add([...cam.files]); cam.value = ''; });
  gal.addEventListener('change', () => { add([...gal.files]); gal.value = ''; });
  send.addEventListener('click', () => saveDialog());

  async function saveDialog() {
    const cols = [...(cat?.collections || [])].sort((a, b) => a.name.localeCompare(b.name));
    const colSel = h('select', { class: 'input' }, h('option', { value: 'new' }, '＋ New person…'), cols.map((c) => h('option', { value: c.id, selected: tCol?.id === c.id }, c.name)));
    const newName = h('input', { class: 'input', placeholder: 'Person name' });
    const title = h('input', { class: 'input', placeholder: 'e.g. CNIC, Passport', list: 'mtypes' });
    const types = cat?.docTypes || ['Other'];
    const type = h('select', { class: 'input' }, types.map((t) => h('option', { value: t, selected: t === 'Other' }, t)));
    title.addEventListener('input', () => { const t = types.find((x) => x.toLowerCase() === title.value.trim().toLowerCase()); if (t) type.value = t; });
    const sync = () => newName.parentElement.classList.toggle('hidden', colSel.value !== 'new');
    colSel.addEventListener('change', sync);
    const body = tDoc
      ? h('div', {}, `Add ${fmt.plural(pages.length, 'page')} to “${tDoc.title}” (${tCol?.name || ''}).`)
      : h('div', { class: 'col' }, h('label', { class: 'field' }, 'Person / collection', colSel), h('label', { class: 'field' }, 'New person name', newName), h('label', { class: 'field' }, 'Document title', title), h('label', { class: 'field' }, 'Type', type), h('datalist', { id: 'mtypes' }, types.map((t) => h('option', { value: t }))));
    if (!tDoc) setTimeout(sync);
    modal({ title: 'Save to office PC', body, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
      if (!tDoc && colSel.value === 'new' && !newName.value.trim()) { toast('Enter the person’s name', 'error'); return false; }
      if (!tDoc && !title.value.trim()) { toast('Enter a document title', 'error'); return false; }
      const out = [];
      for (let i = 0; i < pages.length; i++) {
        toast(`Preparing page ${i + 1}/${pages.length}…`, 'info', 1200);
        const r = await processPage(pages[i].blob, pages[i].params, { maxDim: 3200, quality: 0.9 });
        out.push(new Blob([r.bytes], { type: 'image/jpeg' }));
      }
      await S.ops.scan({
        collection: tDoc ? null : colSel.value === 'new' ? { name: newName.value.trim() } : { id: Number(colSel.value) },
        document: tDoc ? { id: tDoc.id, title: tDoc.title } : { title: title.value.trim(), docType: type.value },
        pages: out,
      });
      pages.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
      scanState = null;
      toast('Saved to the outbox — uploading to your PC', 'success');
      location.hash = '#/outbox';
    } }] });
  }

  put(
    h('div', { class: 'mhead' }, h('h2', {}, tDoc ? `Add pages · ${tDoc.title}` : tCol ? `Scan for ${tCol.name}` : 'Scan')),
    h('div', { class: 'mpad col' },
      h('button', { class: 'btn primary lg block', id: 'takePhoto', onclick: () => cam.click() }, icon('camera'), 'Take photo'),
      h('button', { class: 'btn block', onclick: () => gal.click() }, icon('image'), 'Choose from gallery'),
      h('div', { class: 'small muted' }, 'Hold the phone above the document. Edges are found automatically; tap ✂ to adjust the crop or filter.'),
      cam, gal),
    list, h('div', { class: 'mpad' }, send));
  draw();
}

// ---------------------------------------------------------------- outbox
async function outbox() {
  const items = await S.outboxAll();
  const label = { queued: '⏳ Waiting for internet', uploading: '⬆ Uploading', sent: '📨 Delivered to portal — waiting for PC', done: '✅ Saved on PC', error: '⚠ Failed' };
  put(h('div', { class: 'mhead' }, h('h2', {}, 'Sent to PC')),
    h('div', { class: 'mpad small muted' }, 'Scans and changes go to your office PC. They wait here if you are offline or the PC is off.'),
    h('div', { class: 'mlist' }, items.length ? items.map((it) => h('div', { class: 'mrow' }, h('div', { class: 'grow' }, h('b', {}, it.title || it.kind),
      h('div', { class: 'small' }, label[it.status] || it.status, it.status === 'uploading' ? ` ${Math.round((it.progress || 0) * 100)}%` : ''),
      it.result?.collection ? h('div', { class: 'small muted' }, `${it.result.collection} · ${fmt.plural(it.result.pages || 0, 'page')}`) : null,
      it.error ? h('div', { class: 'small', style: { color: 'var(--danger)' } }, it.error) : it.lastError ? h('div', { class: 'small muted' }, it.lastError) : null,
      h('div', { class: 'small muted' }, fmt.rel(it.created))),
    it.status === 'error' || it.status === 'done' ? h('button', { class: 'btn icon sm', onclick: async () => { const { store } = await import('./net.js'); await store.del('outbox', it.id); route(true); } }, icon('x')) : null)) : h('div', { class: 'empty' }, 'Nothing sent yet.')));
  S.flushOutbox();
}

// ---------------------------------------------------------------- settings
async function settings() {
  const a = auth.get();
  const est = await (await import('./net.js')).storageEstimate();
  put(h('div', { class: 'mhead' }, h('h2', {}, 'More')),
    h('div', { class: 'card pad mpad-x' }, h('div', { class: 'kv' },
      h('div', { class: 'k' }, 'Office'), h('div', { class: 'v' }, S.state.catalog?.library || a.label),
      h('div', { class: 'k' }, 'This phone'), h('div', { class: 'v' }, a.deviceName || 'Phone'),
      h('div', { class: 'k' }, 'Office PC'), h('div', { class: 'v' }, S.state.pcOnline ? 'Online' : `Last seen ${fmt.rel(S.state.status?.pcLastSeen)}`),
      h('div', { class: 'k' }, 'Encryption'), h('div', { class: 'v' }, 'End-to-end (AES-256)'),
      est ? [h('div', { class: 'k' }, 'Space used'), h('div', { class: 'v' }, fmt.bytes(est.usage))] : null)),
    h('div', { class: 'mpad col' },
      h('label', { class: 'field' }, 'Default scan filter', (() => { const s = h('select', { class: 'input' }, [['enhance', 'Magic colour'], ['original', 'Original'], ['gray', 'Grayscale'], ['bw', 'Black & white']].map(([v, l]) => h('option', { value: v, selected: v === (localStorage.getItem('ss.filter') || 'enhance') }, l))); s.addEventListener('change', () => localStorage.setItem('ss.filter', s.value)); return s; })()),
      h('button', { class: 'btn block', onclick: () => { S.refresh(); toast('Refreshing…', 'info', 1200); } }, icon('refresh'), 'Refresh now'),
      h('button', { class: 'btn block', onclick: async () => { const { store } = await import('./net.js'); await store.clear('files'); toast('Offline copies removed', 'success'); } }, icon('trash'), 'Remove offline copies'),
      h('button', { class: 'btn block danger', onclick: async () => {
        if (!(await confirmDialog('Disconnect this phone?', 'Unsent scans and offline copies on this phone are deleted.', { okLabel: 'Disconnect', danger: true }))) return;
        await api('dv.unpair').catch(() => {});
        const { store } = await import('./net.js');
        await store.clear('files'); await store.clear('outbox'); await store.clear('kv');
        auth.clear(); localStorage.removeItem('ss.offline'); location.hash = ''; location.reload();
      } }, 'Disconnect this phone'),
      h('p', { class: 'small muted center' }, 'Tip: add this page to your home screen (browser menu → “Add to Home screen”) to use it like an app.')));
}

window.addEventListener('unhandledrejection', (e) => { if (e.reason?.message) toast(e.reason.message, 'error'); });
boot();
