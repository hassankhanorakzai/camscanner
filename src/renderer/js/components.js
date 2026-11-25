import { h, icon, fmt, toast, modal, confirmDialog, promptDialog, menu } from './ui.js';
import { api, state, thumbUrl, navigate, subscribe } from './core.js';

export function docCard(d, { selected = false, onToggle = null } = {}) {
  const star = h('button', { class: `star ${d.favorite ? 'on' : ''}`, title: d.favorite ? 'Remove from favorites' : 'Add to favorites' }, icon('star', 15));
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    d.favorite = !d.favorite;
    star.classList.toggle('on', d.favorite);
    await api('documents:favorite', [d.id], d.favorite).catch((x) => toast(x.message, 'error'));
  });
  const sel = h('span', { class: 'sel-box', title: 'Select' }, selected ? icon('check', 14) : null);
  sel.addEventListener('click', (e) => { e.stopPropagation(); onToggle?.(d); });
  const thumb = d.coverPageId
    ? h('img', { src: thumbUrl(d.coverPageId, d.coverVersion), loading: 'lazy', alt: '', onerror: (e) => e.target.replaceWith(h('div', { class: 'ph' }, icon('file'))) })
    : h('div', { class: 'ph' }, icon(d.attachmentCount ? 'files' : 'file'));
  const card = h('div', { class: `card doc-card ${selected ? 'selected' : ''}`, dataset: { id: d.id }, title: `${d.collectionName} / ${d.title}` },
    h('div', { class: 'card-top' }, onToggle ? sel : h('span'), star),
    h('div', { class: 'thumb' }, thumb),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, d.title),
      h('div', { class: 'meta' }, icon(d.collectionKind === 'folder' ? 'folder' : 'user', 12), ' ', d.collectionName),
      h('div', { class: 'meta' }, `${d.docType} · ${fmt.plural(d.pageCount, 'page')} · ${fmt.rel(d.updatedAt)}`),
      h('div', { class: 'badges' },
        d.hasJpg ? h('span', { class: 'badge jpg' }, 'JPG') : null,
        d.hasPdf ? h('span', { class: 'badge pdf' }, 'PDF') : null,
        d.pdfStatus === 'stale' || d.pdfStatus === 'missing' ? h('span', { class: 'badge warn', title: 'PDF needs regenerating' }, 'PDF!') : null,
        d.missingCount ? h('span', { class: 'badge warn', title: 'Some files are missing on disk' }, `${d.missingCount} missing`) : null,
        d.attachmentCount ? h('span', { class: 'badge' }, `+${d.attachmentCount} file`) : null,
        d.tags.slice(0, 2).map((t) => h('span', { class: 'badge tag' }, t)))));
  card.addEventListener('click', (e) => {
    if (onToggle && (e.ctrlKey || e.shiftKey || card.closest('.selecting'))) { onToggle(d); return; }
    navigate(`#/doc/${d.id}`);
  });
  return card;
}

export function collectionCard(c) {
  const cover = c.coverPageId ? h('img', { src: thumbUrl(c.coverPageId), loading: 'lazy', alt: '' }) : h('span', { class: 'avatar big' }, c.kind === 'folder' ? icon('folder', 28) : fmt.initials(c.name));
  return h('div', { class: 'card doc-card col-card', onclick: () => navigate(`#/collection/${c.id}`), title: c.name },
    h('div', { class: 'card-top' }, h('span'), c.favorite ? h('span', { class: 'star on' }, icon('star', 15)) : h('span')),
    h('div', { class: 'thumb' }, cover),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, c.name),
      h('div', { class: 'meta' }, `${fmt.plural(c.docCount, 'document')} · ${fmt.plural(c.pageCount, 'page')}`),
      h('div', { class: 'meta' }, `${c.kind === 'folder' ? 'Folder' : 'Person'} · updated ${fmt.rel(c.updatedAt)}`)));
}

export function emptyState(ic, title, text, action) {
  return h('div', { class: 'empty' }, icon(ic), h('h3', {}, title), h('p', {}, text), action || null);
}

// ------------------------------------------------------------------ dialogs
export function newCollectionDialog({ kind = 'person', name = '' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', placeholder: 'e.g. Muhammad Ali', value: name, maxlength: 120 });
    let k = kind;
    const seg = h('div', { class: 'seg' }, ['person', 'folder'].map((v) => h('button', { type: 'button', class: v === k ? 'on' : '', onclick: (e) => { k = v; [...seg.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, icon(v === 'person' ? 'user' : 'folder'), v === 'person' ? 'Person' : 'Custom folder')));
    const notes = h('textarea', { class: 'input', placeholder: 'Optional notes (phone, reference number…)', rows: 3 });
    modal({
      title: 'New collection',
      body: h('div', { class: 'col' }, seg, h('label', { class: 'field' }, 'Name or title', input), h('label', { class: 'field' }, 'Notes', notes)),
      onClose: (v) => resolve(v || null),
      actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: async () => {
        if (!input.value.trim()) { input.focus(); return false; }
        const c = await api('collections:create', { name: input.value.trim(), kind: k, notes: notes.value });
        toast(`Created “${c.name}”`, 'success');
        return c;
      } }],
    });
  });
}

export function exportDialog(ids) {
  const jpg = h('input', { type: 'checkbox', checked: true });
  const pdf = h('input', { type: 'checkbox', checked: true });
  const flat = h('input', { type: 'checkbox' });
  const q = h('input', { type: 'range', min: 40, max: 100, value: 100 });
  const qv = h('span', {}, 'Original');
  q.addEventListener('input', () => { qv.textContent = q.value === '100' ? 'Original' : `${q.value}%`; });
  modal({
    title: `Export ${fmt.plural(ids.length, 'document')}`,
    body: h('div', { class: 'col' },
      h('div', { class: 'muted' }, 'Copies of the stored files will be written to a folder you choose.'),
      h('label', { class: 'check' }, jpg, 'JPG images (each page)'),
      h('label', { class: 'check' }, pdf, 'PDF documents'),
      h('label', { class: 'field' }, h('span', {}, 'JPG quality: ', qv), q),
      h('label', { class: 'check' }, flat, 'Put all files in one folder (no sub-folders)')),
    actions: [{ label: 'Cancel' }, { label: 'Choose folder & export', primary: true, onClick: async () => {
      if (!jpg.checked && !pdf.checked) { toast('Choose JPG and/or PDF', 'error'); return false; }
      const r = await api('files:export', ids, { jpg: jpg.checked, pdf: pdf.checked, quality: Number(q.value), flat: flat.checked });
      if (r) toast(`Exported ${r.files} files`, 'success');
      return true;
    } }],
  });
}

export async function moveDialog(ids) {
  const cols = await api('collections:list', {});
  const sel = h('select', { class: 'input' }, cols.map((c) => h('option', { value: c.id }, c.name)));
  return new Promise((resolve) => modal({
    title: `Move ${fmt.plural(ids.length, 'document')}`,
    body: h('label', { class: 'field' }, 'Move to collection', sel),
    onClose: (v) => resolve(!!v),
    actions: [{ label: 'Cancel' }, { label: 'Move', primary: true, onClick: async () => {
      for (const id of ids) await api('documents:update', id, { collectionId: Number(sel.value) });
      toast('Moved', 'success');
      return true;
    } }],
  }));
}

export async function deleteDocs(ids) {
  if (!(await confirmDialog(`Move ${fmt.plural(ids.length, 'document')} to Trash?`, 'Files are moved to the Trash folder inside your library. You can restore them from Trash.', { okLabel: 'Move to Trash', danger: true }))) return false;
  await api('documents:delete', ids);
  toast('Moved to Trash', 'success');
  return true;
}

export async function addTagDialog(ids) {
  const tags = (await api('documents:tags')).map((t) => t.name);
  const tag = await promptDialog('Add tag', 'Tag', '', { placeholder: 'e.g. visa, urgent, 2024', list: tags, okLabel: 'Add' });
  if (!tag) return false;
  await api('documents:addTag', ids, tag);
  toast(`Tagged ${fmt.plural(ids.length, 'document')}`, 'success');
  return true;
}

// ------------------------------------------------------------------ document browser
/**
 * Grid with search, sort, filters and bulk actions.
 * opts: { base: query object always applied, initialSearch, showCollectionFilter }
 */
export function docBrowser(container, opts = {}) {
  const st = { search: opts.initialSearch || '', sort: state.settings?.defaultSort || 'updated', docType: '', tag: '', hasPdf: '', favorites: false, selected: new Set(), docs: [] };
  const search = h('input', { class: 'input', placeholder: 'Search in these documents…', value: st.search });
  const sort = h('select', { class: 'input' }, [['updated', 'Last modified'], ['created', 'Date scanned'], ['title', 'Title A–Z'], ['name', 'Person / collection'], ['type', 'Document type'], ['pages', 'Most pages']].map(([v, l]) => h('option', { value: v, selected: v === st.sort }, l)));
  const type = h('select', { class: 'input' }, h('option', { value: '' }, 'All types'), (state.docTypes || []).map((t) => h('option', { value: t }, t)));
  const tag = h('select', { class: 'input' }, h('option', { value: '' }, 'All tags'));
  const pdf = h('select', { class: 'input' }, h('option', { value: '' }, 'JPG & PDF'), h('option', { value: '1' }, 'Has PDF'), h('option', { value: '0' }, 'No PDF'));
  const fav = h('button', { class: 'btn', title: 'Favorites only' }, icon('star'));
  const selBtn = h('button', { class: 'btn' }, icon('check'), 'Select');
  const count = h('span', { class: 'muted small' });
  const bulk = h('div', { class: 'bulkbar hidden' });
  const grid = h('div', { class: 'grid' });
  const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'search grow' }, icon('search'), search), sort, type, tag, pdf, fav, selBtn, count);
  container.append(toolbar, bulk, grid);
  api('documents:tags').then((tags) => tags.forEach((t) => tag.append(h('option', { value: t.name }, `${t.name} (${t.n})`)))).catch(() => {});

  let selecting = false;
  const toggle = (d) => {
    if (st.selected.has(d.id)) st.selected.delete(d.id); else st.selected.add(d.id);
    selecting = selecting || st.selected.size > 0;
    draw();
  };
  const ids = () => [...st.selected];
  function renderBulk() {
    bulk.classList.toggle('hidden', !selecting);
    grid.classList.toggle('selecting', selecting);
    selBtn.classList.toggle('active', selecting);
    bulk.innerHTML = '';
    if (!selecting) return;
    const n = st.selected.size;
    bulk.append(h('b', {}, `${n} selected`),
      h('button', { class: 'btn sm', onclick: () => { st.docs.forEach((d) => st.selected.add(d.id)); draw(); } }, 'Select all'),
      h('button', { class: 'btn sm', onclick: () => { st.selected.clear(); selecting = false; draw(); } }, 'Cancel'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn sm', disabled: !n, onclick: () => exportDialog(ids()) }, icon('download'), 'Export'),
      h('button', { class: 'btn sm', disabled: !n, onclick: () => api('print:documents', ids()).catch((e) => toast(e.message, 'error')) }, icon('printer'), 'Print'),
      h('button', { class: 'btn sm', disabled: !n, onclick: async () => { await api('documents:favorite', ids(), true); load(); } }, icon('star'), 'Favorite'),
      h('button', { class: 'btn sm', disabled: !n, onclick: async () => { if (await addTagDialog(ids())) load(); } }, icon('tag'), 'Tag'),
      h('button', { class: 'btn sm', disabled: !n, onclick: async () => { if (await moveDialog(ids())) { st.selected.clear(); load(); } } }, icon('move'), 'Move'),
      h('button', { class: 'btn sm', disabled: !n, onclick: async () => { if (await deleteDocs(ids())) { st.selected.clear(); selecting = false; load(); } } }, icon('trash'), 'Delete'));
  }
  function draw() {
    renderBulk();
    grid.innerHTML = '';
    count.textContent = fmt.plural(st.docs.length, 'document');
    if (!st.docs.length) {
      grid.append(h('div', { style: { gridColumn: '1/-1' } }, emptyState('files', st.search ? 'No matches' : 'No documents yet', st.search ? 'Try another search term.' : 'Scan a document to get started.',
        opts.emptyAction || h('button', { class: 'btn primary', onclick: () => navigate(opts.scanHash || '#/scan') }, icon('camera'), 'Scan document'))));
      return;
    }
    for (const d of st.docs) grid.append(docCard(d, { selected: st.selected.has(d.id), onToggle: toggle }));
  }
  let seq = 0;
  async function load() {
    const my = ++seq;
    const q = { ...(opts.base || {}), search: st.search, sort: st.sort, docType: st.docType, tag: st.tag, favorites: st.favorites || opts.base?.favorites, hasPdf: st.hasPdf === '' ? null : st.hasPdf === '1' };
    const docs = await api('documents:list', q);
    if (my !== seq) return;
    st.docs = docs;
    for (const id of [...st.selected]) if (!docs.some((d) => d.id === id)) st.selected.delete(id);
    draw();
  }
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.search = search.value; load(); }, 180); });
  sort.addEventListener('change', () => { st.sort = sort.value; load(); });
  type.addEventListener('change', () => { st.docType = type.value; load(); });
  tag.addEventListener('change', () => { st.tag = tag.value; load(); });
  pdf.addEventListener('change', () => { st.hasPdf = pdf.value; load(); });
  fav.addEventListener('click', () => { st.favorites = !st.favorites; fav.classList.toggle('active', st.favorites); load(); });
  selBtn.addEventListener('click', () => { selecting = !selecting; if (!selecting) st.selected.clear(); draw(); });
  const onKey = (e) => {
    if (e.target.matches('input,textarea,select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); selecting = true; st.docs.forEach((d) => st.selected.add(d.id)); draw(); }
    if (e.key === 'Delete' && st.selected.size) deleteDocs(ids()).then((ok) => { if (ok) { st.selected.clear(); selecting = false; load(); } });
    if (e.key === 'Escape' && selecting) { st.selected.clear(); selecting = false; draw(); }
  };
  document.addEventListener('keydown', onKey);
  const unsub = subscribe((evt) => { if (evt === 'changed') load(); });
  load();
  return { reload: load, destroy: () => { unsub(); document.removeEventListener('keydown', onKey); } };
}

export function docActionsMenu(anchor, d, after) {
  menu(anchor, [
    { label: 'Open', icon: 'file', onClick: () => navigate(`#/doc/${d.id}`) },
    { label: 'Add pages', icon: 'plus', onClick: () => navigate(`#/scan?doc=${d.id}`) },
    { label: 'Show in folder', icon: 'folderOpen', onClick: () => api('files:showInFolder', d.id, 'pdf') },
    { label: 'Export…', icon: 'download', onClick: () => exportDialog([d.id]) },
    '-',
    { label: 'Move to Trash', icon: 'trash', danger: true, onClick: async () => { if (await deleteDocs([d.id])) after?.(); } },
  ]);
}
