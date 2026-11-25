import { h, icon, fmt, toast, confirmDialog } from '../ui.js';
import { api, thumbUrl, subscribe } from '../core.js';
import { emptyState } from '../components.js';

export default async function trash(view) {
  const body = h('div');
  view.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Trash'), h('div', { class: 'sub' }, 'Recently deleted documents and collections. Their files are kept in the library’s Trash folder until you delete them permanently.')),
    h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => api('storage:openFolder', 'trash') }, icon('folderOpen'), 'Open Trash folder'),
    h('button', { class: 'btn danger', id: 'emptyTrash', onclick: async () => {
      if (!(await confirmDialog('Empty Trash?', 'All items in Trash will be permanently deleted (sent to the Windows Recycle Bin where available). This cannot be undone in SmartScan.', { okLabel: 'Empty Trash', danger: true }))) return;
      await api('trash:empty'); toast('Trash emptied', 'success'); load();
    } }, icon('trash'), 'Empty Trash')), body);
  async function load() {
    const t = await api('trash:list');
    body.innerHTML = '';
    if (!t.documents.length && !t.collections.length) { body.append(emptyState('trash', 'Trash is empty', 'Deleted documents appear here and can be restored.')); return; }
    const row = (thumb, title, sub, onRestore, onPurge) => h('div', { class: 'list-item' }, thumb, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, title), h('div', { class: 'muted small' }, sub)),
      h('button', { class: 'btn sm', onclick: onRestore }, icon('restore'), 'Restore'), h('button', { class: 'btn sm danger', onclick: onPurge }, icon('trash'), 'Delete forever'));
    const purge = async (sel, name) => {
      if (!(await confirmDialog(`Permanently delete “${name}”?`, 'The files will be removed from your library (sent to the Recycle Bin where available).', { okLabel: 'Delete forever', danger: true }))) return;
      await api('trash:purge', sel); load();
    };
    if (t.collections.length) {
      body.append(h('div', { class: 'section-title' }, h('h2', {}, 'Collections')), h('div', { class: 'card list' }, t.collections.map((c) => row(h('span', { class: 'avatar' }, fmt.initials(c.name)), c.name, `Deleted ${fmt.rel(c.deletedAt)} · ${fmt.plural(c.docCount, 'document')}`,
        async () => { await api('collections:restore', c.id); toast('Restored', 'success'); load(); }, () => purge({ collectionIds: [c.id] }, c.name)))));
    }
    if (t.documents.length) {
      body.append(h('div', { class: 'section-title' }, h('h2', {}, 'Documents')), h('div', { class: 'card list' }, t.documents.map((d) => row(
        d.coverPageId ? h('img', { class: 'mini', src: thumbUrl(d.coverPageId) }) : h('span', { class: 'mini' }), d.title, `${d.collectionName} · ${d.docType} · ${fmt.plural(d.pageCount, 'page')} · deleted ${fmt.rel(d.deletedAt)}`,
        async () => { await api('documents:restore', [d.id]); toast('Restored', 'success'); load(); }, () => purge({ documentIds: [d.id] }, d.title)))));
    }
  }
  await load();
  return subscribe((e) => { if (e === 'changed') load(); });
}
