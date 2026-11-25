import { h, icon, fmt, toast, confirmDialog, promptDialog, menu } from '../ui.js';
import { api, navigate } from '../core.js';
import { docBrowser } from '../components.js';

export default async function collection(view, [id]) {
  let c;
  try { c = await api('collections:get', Number(id)); } catch (e) { view.append(h('div', { class: 'banner err' }, e.message)); return null; }
  const head = h('div', { class: 'page-head' });
  const notes = h('textarea', { class: 'input', rows: 2, placeholder: 'Notes about this person/folder (saved automatically)…', value: c.notes });
  let nt;
  notes.addEventListener('input', () => { clearTimeout(nt); nt = setTimeout(() => api('collections:update', c.id, { notes: notes.value }).catch((e) => toast(e.message, 'error')), 600); });
  function drawHead() {
    head.innerHTML = '';
    const more = h('button', { class: 'btn icon', title: 'More' }, icon('more'));
    more.addEventListener('click', () => menu(more, [
      { label: 'Rename', icon: 'edit', onClick: rename },
      { label: c.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', onClick: async () => { c = await api('collections:update', c.id, { favorite: !c.favorite }); drawHead(); } },
      { label: c.kind === 'person' ? 'Mark as custom folder' : 'Mark as person', icon: c.kind === 'person' ? 'folder' : 'user', onClick: async () => { c = await api('collections:update', c.id, { kind: c.kind === 'person' ? 'folder' : 'person' }); drawHead(); } },
      { label: 'Open folder in Explorer', icon: 'folderOpen', onClick: () => api('storage:openFolder', 'documents') },
      '-',
      { label: 'Delete collection', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmDialog(`Delete “${c.name}”?`, `The folder and its ${fmt.plural(c.docCount, 'document')} will be moved to Trash. You can restore it later.`, { okLabel: 'Move to Trash', danger: true }))) return;
        await api('collections:delete', c.id); toast('Moved to Trash', 'success'); navigate('#/collections');
      } },
    ]));
    head.append(
      h('button', { class: 'btn ghost icon', title: 'Back', onclick: () => navigate('#/collections') }, icon('chevL')),
      h('span', { class: 'avatar', style: { width: '46px', height: '46px', fontSize: '17px' } }, c.kind === 'folder' ? icon('folder') : fmt.initials(c.name)),
      h('div', {}, h('h1', { style: { cursor: 'text' }, title: 'Click to rename', onclick: rename }, c.name, c.favorite ? ' ★' : ''), h('div', { class: 'sub' }, `${c.kind === 'folder' ? 'Folder' : 'Person'} · ${fmt.plural(c.docCount, 'document')} · ${fmt.plural(c.pageCount, 'page')} · Documents\\${c.folder}`)),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', id: 'scanHere', onclick: () => navigate(`#/scan?collection=${c.id}`) }, icon('camera'), 'Scan new document'),
      more);
  }
  async function rename() {
    const name = await promptDialog('Rename collection', 'Name', c.name);
    if (!name || name === c.name) return;
    try { c = await api('collections:update', c.id, { name }); drawHead(); toast('Renamed — folder updated on disk', 'success'); } catch (e) { toast(e.message, 'error'); }
  }
  drawHead();
  view.append(head, h('div', { style: { marginBottom: '16px' } }, notes));
  const b = docBrowser(view, { base: { collectionId: c.id }, scanHash: `#/scan?collection=${c.id}` });
  return () => b.destroy();
}
