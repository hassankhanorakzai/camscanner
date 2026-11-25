import { h, icon, fmt } from '../ui.js';
import { api, navigate, state, subscribe } from '../core.js';
import { docCard, newCollectionDialog, emptyState, collectionCard } from '../components.js';

export default async function dashboard(view) {
  const wrap = h('div');
  view.append(wrap);
  async function draw() {
    const [s, recent, cols] = await Promise.all([api('stats:get'), api('documents:list', { sort: 'created', limit: 10 }), api('collections:list', {})]);
    wrap.innerHTML = '';
    const hour = new Date().getHours();
    wrap.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${state.user.displayName.split(' ')[0]}`),
      h('div', { class: 'sub' }, s.last7 ? `${fmt.plural(s.last7, 'document')} scanned this week` : 'Your documents, organised by person and stored on your own drive.'))));
    if (s.missing) wrap.append(h('div', { class: 'banner warn' }, icon('alert'), `${fmt.plural(s.missing, 'file')} could not be found on disk.`, h('div', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => navigate('#/storage') }, 'Review')));
    wrap.append(h('div', { class: 'quick' },
      h('div', { class: 'card quick-scan', onclick: () => navigate('#/scan'), id: 'quickScan' }, h('div', { class: 'big' }, icon('camera')), h('div', {}, h('h2', {}, 'Quick Scan'), h('p', {}, 'Camera, scanner, phone or image files — auto-cropped and saved as JPG + PDF.'))),
      h('div', { class: 'card pad row', style: { cursor: 'pointer' }, onclick: async () => { const c = await newCollectionDialog(); if (c) navigate(`#/collection/${c.id}`); } },
        h('div', { class: 'stat', style: { padding: 0 } }, h('div', { class: 'ic' }, icon('users')), h('div', {}, h('div', { style: { fontWeight: 700, fontSize: '16px' } }, 'Create New Collection'), h('div', { class: 'muted small' }, 'Add a person (e.g. “Muhammad Ali”) or a custom folder'))))));
    const stat = (ic, v, l, href, color) => h('div', { class: 'card stat', style: { cursor: href ? 'pointer' : 'default' }, onclick: href ? () => navigate(href) : null },
      h('div', { class: 'ic', style: color ? { background: color[0], color: color[1] } : {} }, icon(ic)), h('div', {}, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l)));
    wrap.append(h('div', { class: 'stats' },
      stat('files', s.documents, 'Scanned documents', '#/documents'),
      stat('layers', s.pages, 'Pages scanned', '#/documents', ['#f3e8ff', '#7c3aed']),
      stat('users', s.collections, 'Named collections', '#/collections', ['#e0f2fe', '#0284c7']),
      stat('image', s.jpgFiles, `JPG files · ${fmt.bytes(s.jpgBytes)}`, null, ['#dcfce7', '#16a34a']),
      stat('file', s.pdfFiles, `PDF files · ${fmt.bytes(s.pdfBytes)}`, null, ['#fee2e2', '#dc2626'])));
    wrap.append(h('div', { class: 'section-title' }, h('h2', {}, 'Recently scanned'), h('div', { class: 'spacer' }), h('a', { href: '#/recent' }, 'View all')));
    if (!recent.length) wrap.append(emptyState('scan', 'No scans yet', 'Create a collection for a person, then scan their CNIC, passport or certificates.', h('button', { class: 'btn primary', onclick: () => navigate('#/scan') }, icon('camera'), 'Scan your first document')));
    else wrap.append(h('div', { class: 'grid' }, recent.map((d) => docCard(d))));
    if (cols.length) {
      const top = [...cols].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
      wrap.append(h('div', { class: 'section-title' }, h('h2', {}, 'People & collections'), h('div', { class: 'spacer' }), h('a', { href: '#/collections' }, 'View all')),
        h('div', { class: 'grid' }, top.map((c) => collectionCard(c))));
    }
  }
  await draw();
  return subscribe((e) => { if (e === 'changed') draw(); });
}
