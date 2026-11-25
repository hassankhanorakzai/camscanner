import { h, icon, fmt } from '../ui.js';
import { api, navigate, subscribe } from '../core.js';
import { collectionCard, newCollectionDialog, emptyState } from '../components.js';

export default async function collections(view) {
  let search = ''; let kind = '';
  const input = h('input', { class: 'input', placeholder: 'Search by person name or document title…' });
  const seg = h('div', { class: 'seg' }, [['', 'All'], ['person', 'People'], ['folder', 'Folders']].map(([v, l]) => h('button', { class: v === kind ? 'on' : '', onclick: (e) => { kind = v; [...seg.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); load(); } }, l)));
  const count = h('span', { class: 'muted small' });
  const grid = h('div', { class: 'grid' });
  view.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'People / Collections'), h('div', { class: 'sub' }, 'Each person or folder holds their own documents (CNIC, passport, certificates…).')), h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', id: 'newCollection', onclick: async () => { const c = await newCollectionDialog(); if (c) navigate(`#/collection/${c.id}`); } }, icon('plus'), 'New collection')),
    h('div', { class: 'toolbar' }, h('div', { class: 'search grow' }, icon('search'), input), seg, count), grid);
  async function load() {
    const cols = await api('collections:list', { search, kind });
    count.textContent = fmt.plural(cols.length, 'collection');
    grid.innerHTML = '';
    if (!cols.length) {
      grid.append(h('div', { style: { gridColumn: '1/-1' } }, emptyState('users', search ? 'No matches' : 'No collections yet', search ? 'Try a different name.' : 'Create one for each person whose documents you keep.',
        search ? null : h('button', { class: 'btn primary', onclick: async () => { const c = await newCollectionDialog(); if (c) navigate(`#/collection/${c.id}`); } }, icon('plus'), 'New collection'))));
      return;
    }
    cols.forEach((c) => grid.append(collectionCard(c)));
  }
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { search = input.value; load(); }, 160); });
  await load();
  return subscribe((e) => { if (e === 'changed') load(); });
}
