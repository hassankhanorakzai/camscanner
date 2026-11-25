import { h } from '../ui.js';
import { api } from '../core.js';
import { docBrowser, collectionCard } from '../components.js';

export default async function favorites(view) {
  view.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Favorites'), h('div', { class: 'sub' }, 'Starred people and documents.'))));
  const cols = await api('collections:list', { favorites: true });
  if (cols.length) view.append(h('div', { class: 'section-title' }, h('h2', {}, 'Collections')), h('div', { class: 'grid', style: { marginBottom: '20px' } }, cols.map(collectionCard)), h('div', { class: 'section-title' }, h('h2', {}, 'Documents')));
  const b = docBrowser(view, { base: { favorites: true }, emptyAction: h('span', { class: 'muted' }, 'Click the ☆ on any document to add it here.') });
  return () => b.destroy();
}
