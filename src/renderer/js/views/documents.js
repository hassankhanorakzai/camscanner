import { h } from '../ui.js';
import { docBrowser } from '../components.js';

export default async function documents(view, _params, query, name) {
  const recent = name === 'recent';
  view.append(h('div', { class: 'page-head' }, h('div', {},
    h('h1', {}, recent ? 'Recent Scans' : 'My Documents'),
    h('div', { class: 'sub' }, recent ? 'Documents scanned or changed in the last 30 days.' : 'Every document in your library, across all people and folders.'))));
  const b = docBrowser(view, { base: recent ? { sinceDays: 30 } : {}, initialSearch: query.q || '' });
  return () => b.destroy();
}
