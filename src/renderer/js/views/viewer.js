import { h, icon, fmt, toast, menu, modal, confirmDialog, promptDialog, sortable, progressModal } from '../ui.js';
import { api, state, fileUrl, thumbUrl, navigate, subscribe } from '../core.js';
import { moveDialog, exportDialog } from '../components.js';
import { openEditor, defaultParams } from '../scan/editor.js';
import { processPage } from '../scan/cv.js';

export default async function viewer(view, [id]) {
  view.className = 'flush';
  let doc;
  let index = 0;
  let zoom = 'fit';
  let rot = 0; // quick visual rotation, persisted on demand
  const canvas = h('div', { class: 'viewer-canvas fit' });
  const img = h('img', { alt: '', draggable: 'false' });
  canvas.append(img);
  const bar = h('div', { class: 'viewer-bar' });
  const nav = h('div', { class: 'viewer-nav' });
  const side = h('div', { class: 'viewer-side' });
  const main = h('div', { class: 'viewer-main' }, bar, canvas, nav);
  view.append(h('div', { class: 'viewer' }, main, side));

  async function load(keepIndex = true) {
    const curId = doc?.pages[index]?.id;
    doc = await api('documents:get', Number(id));
    if (keepIndex && curId) { const i = doc.pages.findIndex((p) => p.id === curId); index = i >= 0 ? i : Math.min(index, doc.pages.length - 1); }
    index = Math.max(0, Math.min(index, doc.pages.length - 1));
    renderBar(); renderPage(); renderSide();
  }
  const page = () => doc.pages[index];

  // ---------------- toolbar
  function renderBar() {
    bar.innerHTML = '';
    const dl = h('button', { class: 'btn', id: 'downloadBtn' }, icon('download'), 'Download', icon('chevD'));
    dl.addEventListener('click', () => menu(dl, [
      { label: 'This page as JPG', icon: 'image', disabled: !page(), onClick: () => saveAs('jpg', page().id) },
      { label: 'This page as JPG (choose quality)…', icon: 'image', disabled: !page(), onClick: jpgQualityDialog },
      { label: 'PDF', icon: 'file', disabled: !doc.pages.length && !doc.pdfFile, onClick: () => saveAs('pdf') },
      { label: 'PDF with options…', icon: 'settings', disabled: !doc.pages.length, onClick: pdfOptionsDialog },
      '-',
      { label: 'Export JPG + PDF to folder…', icon: 'folder', onClick: () => exportDialog([doc.id]) },
    ]));
    const share = h('button', { class: 'btn icon', title: 'Share' }, icon('share'));
    share.addEventListener('click', () => menu(share, [
      { label: 'Share PDF…', icon: 'share', disabled: !doc.pdfFile, onClick: () => systemShare('pdf') },
      { label: 'Share this page (JPG)…', icon: 'share', disabled: !page(), onClick: () => systemShare('jpg') },
      '-',
      { label: 'Copy PDF file (paste in email/chat)', icon: 'copy', disabled: !doc.pdfFile, onClick: () => copyFile('pdf') },
      { label: 'Copy page image', icon: 'copy', disabled: !page(), onClick: () => copyFile('page') },
      { label: 'Show file in folder', icon: 'folderOpen', onClick: () => api('files:showInFolder', doc.id, 'pdf') },
    ]));
    const more = h('button', { class: 'btn icon', title: 'More' }, icon('more'));
    more.addEventListener('click', () => menu(more, [
      { label: 'Rename', icon: 'edit', onClick: rename },
      { label: 'Move to another collection…', icon: 'move', onClick: async () => { if (await moveDialog([doc.id])) load(); } },
      { label: 'Open PDF in default app', icon: 'external', disabled: !doc.pdfFile, onClick: () => api('files:open', doc.id, 'pdf').catch((e) => toast(e.message, 'error')) },
      { label: 'Open page in default app', icon: 'external', disabled: !page(), onClick: () => api('files:open', doc.id, 'page', page().id).catch((e) => toast(e.message, 'error')) },
      { label: 'Regenerate PDF', icon: 'refresh', disabled: !doc.pages.length, onClick: async () => { await api('documents:regeneratePdf', doc.id); toast('PDF regenerated', 'success'); load(); } },
      '-',
      { label: 'Move to Trash', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmDialog(`Delete “${doc.title}”?`, 'Its folder (JPG + PDF) will be moved to Trash. You can restore it later.', { okLabel: 'Move to Trash', danger: true }))) return;
        await api('documents:delete', [doc.id]); toast('Moved to Trash', 'success'); navigate(`#/collection/${doc.collectionId}`);
      } },
    ]));
    const fav = h('button', { class: `btn icon ${doc.favorite ? 'active' : ''}`, title: 'Favorite', onclick: async () => { await api('documents:favorite', [doc.id], !doc.favorite); load(); } }, icon('star'));
    if (doc.favorite) fav.querySelector('svg').style.fill = 'currentColor';
    bar.append(
      h('button', { class: 'btn ghost icon', title: 'Back', onclick: () => history.length > 1 ? history.back() : navigate(`#/collection/${doc.collectionId}`) }, icon('chevL')),
      h('div', {}, h('h2', { title: 'Click to rename', onclick: rename, id: 'docTitle' }, doc.title), h('a', { class: 'small', href: `#/collection/${doc.collectionId}` }, doc.collectionName), h('span', { class: 'muted small' }, ` · ${doc.docType}`)),
      fav, h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => navigate(`#/scan?doc=${doc.id}`) }, icon('plus'), 'Add pages'),
      dl,
      h('button', { class: 'btn icon', title: 'Print', onclick: () => printDialog() }, icon('printer')),
      share,
      h('button', { class: 'btn icon', title: 'Open file location', onclick: () => api('files:showInFolder', doc.id, 'page', page()?.id) }, icon('folderOpen')),
      more);
  }

  // ---------------- page view
  function renderPage() {
    nav.innerHTML = '';
    const p = page();
    if (!p) {
      img.removeAttribute('src');
      canvas.innerHTML = '';
      canvas.append(h('div', { class: 'empty', style: { color: '#cbd5e1' } }, icon('file'), h('h3', { style: { color: '#fff' } }, doc.pdfFile ? 'PDF-only document' : 'No pages'),
        h('p', {}, doc.pdfFile ? 'This document holds a PDF that was added outside SmartScan.' : 'Add pages by scanning.'),
        h('div', { class: 'row', style: { justifyContent: 'center' } }, doc.pdfFile ? h('button', { class: 'btn', onclick: () => api('pdf:previewDoc', doc.id) }, 'Open PDF') : null, h('button', { class: 'btn primary', onclick: () => navigate(`#/scan?doc=${doc.id}`) }, icon('camera'), 'Scan pages'))));
      return;
    }
    if (!canvas.contains(img)) { canvas.innerHTML = ''; canvas.append(img); }
    img.src = p.status === 'missing' ? '' : fileUrl('page', p.id, p.version);
    img.title = p.file;
    applyZoom();
    nav.append(
      h('button', { class: 'btn icon sm', disabled: index === 0, onclick: () => go(index - 1), title: 'Previous (←)' }, icon('chevL')),
      h('span', {}, `Page ${index + 1} / ${doc.pages.length}`),
      h('button', { class: 'btn icon sm', disabled: index >= doc.pages.length - 1, onclick: () => go(index + 1), title: 'Next (→)' }, icon('chevR')),
      h('span', { style: { width: '18px' } }),
      h('button', { class: 'btn icon sm', title: 'Zoom out (−)', onclick: () => setZoom(-1) }, icon('zoomOut')),
      h('button', { class: 'btn sm', title: 'Fit / 100%', onclick: () => { zoom = zoom === 'fit' ? 1 : 'fit'; applyZoom(); } }, zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`),
      h('button', { class: 'btn icon sm', title: 'Zoom in (+)', onclick: () => setZoom(1) }, icon('zoomIn')),
      h('button', { class: 'btn icon sm', title: 'Rotate left', onclick: () => rotate(-90) }, icon('rotL')),
      h('button', { class: 'btn icon sm', title: 'Rotate right', onclick: () => rotate(90) }, icon('rotR')),
      h('button', { class: 'btn icon sm', title: 'Full screen (F)', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : main.requestFullscreen()) }, icon('maximize')),
      h('span', { style: { width: '18px' } }),
      h('button', { class: 'btn sm', onclick: () => editPage() }, icon('crop'), 'Edit page'),
      h('span', { class: 'small', style: { color: '#64748b' } }, `${p.width || '?'}×${p.height || '?'}px · ${fmt.bytes(p.size)}`),
      p.status === 'missing' ? h('span', { class: 'badge warn' }, 'File missing on disk') : '');
  }
  function applyZoom() {
    canvas.classList.toggle('fit', zoom === 'fit');
    const r = canvas.getBoundingClientRect();
    const p = page(); if (!p) return;
    const quarter = Math.abs(rot % 180) === 90;
    const iw = quarter ? p.height : p.width; const ih = quarter ? p.width : p.height;
    let s = zoom === 'fit' ? Math.min((r.width - 48) / (iw || 1), (r.height - 48) / (ih || 1), 4) : zoom;
    if (!Number.isFinite(s) || s <= 0) s = 1;
    img.style.width = `${(p.width || 800) * s}px`;
    img.style.height = `${(p.height || 1000) * s}px`;
    img.style.transform = rot ? `rotate(${rot}deg)` : '';
    img.style.margin = quarter ? `${Math.abs((p.width - p.height) * s) / 2}px ${Math.abs((p.height - p.width) * s) / 2}px` : '0';
  }
  function setZoom(dir) {
    const cur = zoom === 'fit' ? (img.getBoundingClientRect().width / (page()?.width || 1)) : zoom;
    zoom = Math.max(0.1, Math.min(6, cur * (dir > 0 ? 1.25 : 0.8)));
    applyZoom(); renderPage();
  }
  function go(i) { if (i < 0 || i >= doc.pages.length) return; index = i; rot = 0; renderPage(); renderSide(); }

  let rotTimer = null;
  function rotate(deg) {
    rot = (rot + deg) % 360;
    applyZoom();
    clearTimeout(rotTimer);
    rotTimer = setTimeout(() => persistRotation(), 900);
  }
  async function persistRotation() {
    if (!rot) return;
    const p = page();
    const delta = ((rot % 360) + 360) % 360;
    rot = 0;
    try {
      const src = await (await fetch(fileUrl('original', p.id, p.version))).blob();
      const params = { ...(p.edit || defaultParams('original')), rotation: (((p.edit?.rotation || 0) + delta) % 360) };
      if (!p.edit) params.quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
      const r = await processPage(src, params, { quality: (state.settings?.jpgQuality || 92) / 100 });
      doc = await api('pages:replace', p.id, { jpg: r.bytes, edit: params });
      toast('Rotation saved to file', 'success', 1500);
      load();
    } catch (e) { toast(e.message, 'error'); applyZoom(); }
  }

  async function editPage() {
    const p = page();
    const pm = progressModal('Loading original…');
    let blob;
    try { blob = await (await fetch(fileUrl('original', p.id, p.version))).blob(); } finally { pm.close(); }
    const ep = { blob, params: p.edit ? JSON.parse(JSON.stringify(p.edit)) : { ...defaultParams('original'), sharpen: 0 } };
    const before = JSON.stringify(ep.params);
    await openEditor([ep], 0, { title: `Edit page ${index + 1}` });
    if (JSON.stringify(ep.params) === before) return;
    const pm2 = progressModal('Saving page…');
    try {
      const r = await processPage(blob, ep.params, { quality: (state.settings?.jpgQuality || 92) / 100 });
      await api('pages:replace', p.id, { jpg: r.bytes, edit: ep.params });
      toast('Page updated — JPG and PDF rewritten', 'success');
      await load();
    } catch (e) { toast(e.message, 'error'); } finally { pm2.close(); }
  }

  // ---------------- side panel
  function renderSide() {
    side.innerHTML = '';
    // pages strip
    const strip = h('div', { class: 'strip' });
    doc.pages.forEach((p, i) => {
      const s = h('div', { class: `s ${i === index ? 'on' : ''} ${p.status === 'missing' ? 'missing' : ''}`, draggable: 'true', dataset: { id: p.id }, title: p.file, onclick: () => go(i) },
        h('img', { src: thumbUrl(p.id, p.version), alt: '', loading: 'lazy' }), h('span', { class: 'n' }, i + 1));
      s.addEventListener('contextmenu', (e) => { e.preventDefault(); pageMenu(s, p, i); });
      strip.append(s);
    });
    sortable(strip, '.s', async (ids) => {
      try { doc = await api('documents:reorder', doc.id, ids.map(Number)); toast('Page order saved (files renumbered, PDF updated)', 'success', 2000); load(); } catch (e) { toast(e.message, 'error'); load(); }
    }, { horizontal: true });
    const pageMore = h('button', { class: 'btn ghost icon sm', title: 'Page actions', disabled: !page() }, icon('more'));
    pageMore.addEventListener('click', () => pageMenu(pageMore, page(), index));
    side.append(h('div', {}, h('h4', {}, icon('layers', 14), `Pages (${doc.pages.length})`, h('span', { class: 'spacer' }), pageMore), strip,
      h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'Drag to reorder · right-click a page for more')));

    // details
    const typeSel = h('select', { class: 'input' }, [...new Set([...(state.docTypes || []), doc.docType])].map((t) => h('option', { value: t, selected: t === doc.docType }, t)));
    typeSel.addEventListener('change', async () => { await api('documents:update', doc.id, { docType: typeSel.value }); toast('Type updated', 'success', 1200); });
    side.append(h('div', {}, h('h4', {}, icon('info', 14), 'Details'), h('div', { class: 'col' }, h('label', { class: 'field' }, 'Document type', typeSel), tagsEditor(), notesEditor())));

    // PDF settings
    const mode = h('select', { class: 'input' }, [['dpi', 'Match image'], ['id1', 'ID card (85.6 mm)'], ['passport', 'Passport (125 mm)']].map(([v, l]) => h('option', { value: v, selected: v === doc.pdfMode }, l)));
    const dpi = h('select', { class: 'input' }, [150, 200, 300].map((v) => h('option', { value: v, selected: v === doc.pdfDpi }, `${v} dpi`)));
    const comp = h('select', { class: 'input' }, [['original', 'No compression'], ['high', 'Light'], ['balanced', 'Balanced'], ['small', 'Small file']].map(([v, l]) => h('option', { value: v, selected: v === doc.pdfCompression }, l)));
    const apply = async () => { const pm = progressModal('Rebuilding PDF…'); try { await api('documents:regeneratePdf', doc.id, { mode: mode.value, dpi: Number(dpi.value), compression: comp.value }); toast('PDF updated', 'success'); load(); } catch (e) { toast(e.message, 'error'); } finally { pm.close(); } };
    [mode, dpi, comp].forEach((s) => s.addEventListener('change', apply));
    side.append(h('div', {}, h('h4', {}, icon('file', 14), 'PDF'),
      h('div', { class: 'col' },
        h('div', { class: 'row small' }, doc.pdfFile ? h('span', { class: 'badge pdf' }, 'PDF') : h('span', { class: 'badge' }, 'No PDF'), h('span', { class: 'muted' }, doc.pdfFile ? `${doc.pdfFile} · ${fmt.bytes(doc.pdfSize)}` : ''), doc.pdfStatus === 'stale' || doc.pdfStatus === 'missing' ? h('span', { class: 'badge warn' }, doc.pdfStatus) : null),
        h('div', { class: 'two-col', style: { gap: '8px' } }, mode, dpi), comp,
        h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: !doc.pages.length && !doc.pdfFile, onclick: () => api('pdf:previewDoc', doc.id).catch((e) => toast(e.message, 'error')) }, icon('file'), 'Preview PDF'), h('button', { class: 'btn sm', disabled: !doc.pdfFile, onclick: () => saveAs('pdf') }, icon('download'), 'Save PDF')))));

    if (doc.attachments.length) {
      side.append(h('div', {}, h('h4', {}, icon('files', 14), 'Other files in this folder'), h('div', { class: 'list' }, doc.attachments.map((a) => h('div', { class: 'list-item', style: { padding: '6px 0' } }, icon('file'), h('div', { class: 'grow small' }, a.file, h('div', { class: 'muted' }, fmt.bytes(a.size))),
        h('button', { class: 'btn sm', onclick: () => api('files:open', doc.id, 'attachment', a.id).catch((e) => toast(e.message, 'error')) }, 'Open'))))));
    }
    // file info
    side.append(h('div', {}, h('h4', {}, icon('folder', 14), 'On disk'), h('div', { class: 'kv', style: { gridTemplateColumns: '80px 1fr' } },
      h('div', { class: 'k' }, 'Folder'), h('div', { class: 'v small' }, doc.path),
      h('div', { class: 'k' }, 'Page file'), h('div', { class: 'v small' }, page()?.file || '—'),
      h('div', { class: 'k' }, 'Created'), h('div', { class: 'v small' }, fmt.datetime(doc.createdAt)),
      h('div', { class: 'k' }, 'Modified'), h('div', { class: 'v small' }, fmt.datetime(doc.updatedAt))),
    h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: () => api('files:showInFolder', doc.id, 'page', page()?.id) }, icon('folderOpen'), 'Open file location')));
  }

  function pageMenu(anchor, p, i) {
    if (!p) return;
    menu(anchor, [
      { label: 'Edit / crop / filter', icon: 'crop', onClick: () => { go(i); editPage(); } },
      { label: 'Retake / rescan this page', icon: 'camera', onClick: () => navigate(`#/scan?doc=${doc.id}&replace=${p.id}`) },
      { label: 'Save page as JPG…', icon: 'download', onClick: () => saveAs('jpg', p.id) },
      { label: 'Print this page', icon: 'printer', onClick: () => api('print:documents', [doc.id], [p.id]) },
      { label: 'Move page up', icon: 'chevL', disabled: i === 0, onClick: () => movePage(i, -1) },
      { label: 'Move page down', icon: 'chevR', disabled: i === doc.pages.length - 1, onClick: () => movePage(i, 1) },
      '-',
      { label: 'Delete page', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmDialog(`Delete page ${i + 1}?`, 'The image file is moved to the library Trash folder and the PDF is updated.', { okLabel: 'Delete page', danger: true }))) return;
        await api('pages:delete', [p.id]); toast('Page deleted', 'success'); load();
      } },
    ]);
  }
  async function movePage(i, d) {
    const ids = doc.pages.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    doc = await api('documents:reorder', doc.id, ids);
    index = i + d; load();
  }

  function tagsEditor() {
    const wrap = h('div', { class: 'tags-input' });
    const input = h('input', { placeholder: doc.tags.length ? '' : 'Add tag…', list: 'tagList' });
    const dl = h('datalist', { id: 'tagList' });
    api('documents:tags').then((t) => t.forEach((x) => dl.append(h('option', { value: x.name })))).catch(() => {});
    const save = async (tags) => { doc = await api('documents:update', doc.id, { tags }); draw(); };
    const draw = () => {
      wrap.innerHTML = '';
      doc.tags.forEach((t) => wrap.append(h('span', { class: 'badge tag' }, t, h('button', { title: 'Remove', onclick: () => save(doc.tags.filter((x) => x !== t)) }, '×'))));
      wrap.append(input, dl);
    };
    input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) { e.preventDefault(); const v = input.value.trim(); input.value = ''; save([...doc.tags, v]); }
      if (e.key === 'Backspace' && !input.value && doc.tags.length) save(doc.tags.slice(0, -1));
    });
    draw();
    return h('label', { class: 'field' }, 'Tags', wrap);
  }
  function notesEditor() {
    const t = h('textarea', { class: 'input', rows: 3, placeholder: 'Notes (saved automatically)…', value: doc.notes });
    let timer;
    t.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => api('documents:update', doc.id, { notes: t.value }).catch((e) => toast(e.message, 'error')), 600); });
    return h('label', { class: 'field' }, 'Notes', t);
  }

  // ---------------- actions
  async function rename() {
    const t = await promptDialog('Rename document', 'Title', doc.title, { list: state.docTypes });
    if (!t || t === doc.title) return;
    try { await api('documents:update', doc.id, { title: t }); toast('Renamed — folder and files updated', 'success'); load(); } catch (e) { toast(e.message, 'error'); }
  }
  async function saveAs(kind, pageId, opts) {
    try { const f = await api('files:saveAs', doc.id, kind, pageId, opts || {}); if (f) toast(`Saved to ${f}`, 'success'); } catch (e) { toast(e.message, 'error'); }
  }
  function jpgQualityDialog() {
    const q = h('input', { type: 'range', min: 30, max: 100, value: 100 });
    const v = h('b', {}, 'Original');
    q.addEventListener('input', () => { v.textContent = q.value === '100' ? 'Original' : `${q.value}%`; });
    modal({ title: 'Save page as JPG', body: h('label', { class: 'field' }, h('span', {}, 'Quality: ', v), q), actions: [{ label: 'Cancel' }, { label: 'Save…', primary: true, onClick: () => saveAs('jpg', page().id, { quality: Number(q.value) }) }] });
  }
  function pdfOptionsDialog() {
    const order = doc.pages.map((p) => p.id);
    const checks = new Map(order.map((pid) => [pid, true]));
    const list = h('div', { class: 'strip', style: { gridTemplateColumns: 'repeat(6, 1fr)' } });
    const draw = () => {
      list.innerHTML = '';
      order.forEach((pid, i) => {
        const p = doc.pages.find((x) => x.id === pid);
        const cb = h('input', { type: 'checkbox', checked: checks.get(pid), style: { position: 'absolute', top: '4px', left: '4px' } });
        cb.addEventListener('click', (e) => { e.stopPropagation(); checks.set(pid, cb.checked); });
        list.append(h('div', { class: 's', draggable: 'true', dataset: { id: pid } }, cb, h('img', { src: thumbUrl(p.id, p.version) }), h('span', { class: 'n' }, i + 1)));
      });
    };
    draw();
    sortable(list, '.s', (ids) => { order.splice(0, order.length, ...ids.map(Number)); draw(); }, { horizontal: true });
    const mode = h('select', { class: 'input' }, [['dpi', 'Match image proportions'], ['id1', 'Real ID-card size'], ['passport', 'Real passport size']].map(([v, l]) => h('option', { value: v, selected: v === doc.pdfMode }, l)));
    const comp = h('select', { class: 'input' }, [['original', 'No compression'], ['high', 'Light'], ['balanced', 'Balanced'], ['small', 'Small file']].map(([v, l]) => h('option', { value: v, selected: v === doc.pdfCompression }, l)));
    const opts = () => ({ pageIds: order.filter((pid) => checks.get(pid)), mode: mode.value, compression: comp.value });
    modal({ title: 'Export PDF', size: 'wide', body: h('div', { class: 'col' }, h('div', { class: 'muted small' }, 'Choose pages and drag to change their order for this PDF.'), list, h('div', { class: 'two-col' }, h('label', { class: 'field' }, 'Page size', mode), h('label', { class: 'field' }, 'Compression', comp))),
      actions: [{ label: 'Cancel' }, { label: 'Preview', onClick: async () => { const r = await api('pdf:previewDoc', doc.id, opts()); if (r?.size) toast(`Preview: ${fmt.bytes(r.size)}`, 'info'); return false; } }, { label: 'Save PDF…', primary: true, onClick: () => saveAs('pdf', null, opts()) }] });
  }
  function printDialog() {
    if (doc.pages.length <= 1) return api('print:documents', [doc.id]).catch((e) => toast(e.message, 'error'));
    menu(bar.querySelector('[title=Print]'), [
      { label: 'Print all pages', icon: 'printer', onClick: () => api('print:documents', [doc.id]).catch((e) => toast(e.message, 'error')) },
      { label: `Print page ${index + 1} only`, icon: 'file', onClick: () => api('print:documents', [doc.id], [page().id]).catch((e) => toast(e.message, 'error')) },
    ]);
  }
  async function copyFile(kind) {
    try { await api('files:copyToClipboard', doc.id, kind, page()?.id); toast(kind === 'pdf' ? 'PDF copied — paste it into an email, chat or folder' : 'Image copied to clipboard', 'success'); } catch (e) { toast(e.message, 'error'); }
  }
  async function systemShare(kind) {
    try {
      const url = kind === 'pdf' ? fileUrl('pdf', doc.id, doc.updatedAt) : fileUrl('page', page().id, page().version);
      const blob = await (await fetch(url)).blob();
      const name = kind === 'pdf' ? doc.pdfFile : page().file;
      const file = new File([blob], name, { type: kind === 'pdf' ? 'application/pdf' : 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: doc.title }); return; }
      await copyFile(kind === 'pdf' ? 'pdf' : 'page');
      toast('System sharing is not available here — the file was copied so you can paste it anywhere.', 'info', 5000);
    } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'error'); }
  }

  // keyboard
  const onKey = (e) => {
    if (e.target.matches('input,textarea,select') || document.querySelector('.overlay')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') go(index + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(index - 1);
    else if (e.key === '+' || e.key === '=') setZoom(1);
    else if (e.key === '-') setZoom(-1);
    else if (e.key === '0') { zoom = 'fit'; applyZoom(); renderPage(); }
    else if (e.key.toLowerCase() === 'f') (document.fullscreenElement ? document.exitFullscreen() : main.requestFullscreen());
    else if (e.key.toLowerCase() === 'r') rotate(e.shiftKey ? -90 : 90);
  };
  document.addEventListener('keydown', onKey);
  const onResize = () => applyZoom();
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onResize);
  canvas.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
  try { await load(false); } catch (e) { view.innerHTML = ''; view.className = ''; view.append(h('div', { class: 'banner err' }, e.message)); return null; }
  const unsub = subscribe((evt) => { if (evt === 'changed' && !document.querySelector('.overlay')) load().catch(() => navigate('#/documents')); });
  return () => { unsub(); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); document.removeEventListener('fullscreenchange', onResize); clearTimeout(rotTimer); };
}
