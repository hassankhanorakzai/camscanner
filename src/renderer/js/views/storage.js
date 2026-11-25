import { h, icon, fmt, toast, confirmDialog, modal, progressModal, withBusy } from '../ui.js';
import { api, onEvent, state, subscribe, thumbUrl, navigate } from '../core.js';
import { reloadStatus } from '../app.js';

export default async function storage(view) {
  const wrap = h('div');
  view.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Local Storage'), h('div', { class: 'sub' }, 'Where your files live, synchronisation with Windows Explorer, and backups.'))), wrap);

  async function draw() {
    const info = await api('storage:info');
    wrap.innerHTML = '';
    const u = info.usage;
    const sync = state.sync || info.sync || {};
    // ---- location
    const loc = h('div', { class: 'card pad' },
      h('h3', {}, 'Storage location'),
      h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'Library folder'), h('div', { class: 'v', id: 'libPath' }, info.libraryPath),
        h('div', { class: 'k' }, 'Status'), h('div', { class: 'v' }, info.reachable ? h('span', { style: { color: 'var(--ok)', fontWeight: 600 } }, '● Connected') : h('span', { style: { color: 'var(--danger)', fontWeight: 600 } }, '● Not reachable')),
        u?.disk ? [h('div', { class: 'k' }, 'Drive free space'), h('div', { class: 'v' }, `${fmt.bytes(u.disk.free)} free of ${fmt.bytes(u.disk.total)}`)] : null),
      u?.disk ? h('div', { class: 'meter light-meter', style: { margin: '12px 0' } }, h('div', { style: { width: `${Math.round((1 - u.disk.free / u.disk.total) * 100)}%` } })) : null,
      h('div', { class: 'row wrap', style: { marginTop: '12px' } },
        h('button', { class: 'btn primary', onclick: () => api('storage:openFolder', 'documents').catch((e) => toast(e.message, 'error')) }, icon('folderOpen'), 'Open in Explorer'),
        h('button', { class: 'btn', onclick: () => api('storage:openFolder', 'root') }, icon('folder'), 'Library root'),
        h('button', { class: 'btn', onclick: relocate }, icon('move'), 'Change location…'),
        h('button', { class: 'btn', onclick: locate }, icon('search'), 'Locate library…')));
    // ---- usage
    const usage = h('div', { class: 'card pad' }, h('h3', {}, 'Storage usage'),
      u ? h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'Documents (JPG/PDF)'), h('div', { class: 'v' }, `${fmt.bytes(u.documents.bytes)} · ${u.documents.files} files`),
        h('div', { class: 'k' }, 'Database & originals'), h('div', { class: 'v' }, `${fmt.bytes(u.database.bytes)} · ${u.database.files} files`),
        h('div', { class: 'k' }, 'Trash'), h('div', { class: 'v' }, `${fmt.bytes(u.trash.bytes)} · ${u.trash.files} files`),
        h('div', { class: 'k' }, 'Backups'), h('div', { class: 'v' }, `${fmt.bytes(u.backups.bytes)} · ${u.backups.files} files`),
        h('div', { class: 'k' }, h('b', {}, 'Total')), h('div', { class: 'v' }, h('b', {}, fmt.bytes(u.total)))) : h('div', { class: 'muted' }, 'Unavailable while the drive is disconnected.'));
    // ---- sync
    const r = sync.report;
    const list = (title, items, cls = '') => (items && items.length ? h('details', { open: items.length < 6 }, h('summary', { class: cls }, `${title} (${items.length})`), h('ul', { class: 'small muted', style: { margin: '6px 0', paddingLeft: '20px', userSelect: 'text' } }, items.slice(0, 200).map((x) => h('li', {}, x)))) : null);
    const syncCard = h('div', { class: 'card pad', id: 'syncCard' },
      h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Synchronisation'), h('div', { class: 'spacer' }),
        h('span', { class: `sync-chip ${sync.status || 'idle'}` }, h('span', { class: 'dot' }), { synced: 'In sync', syncing: 'Syncing…', attention: 'Needs attention', offline: 'Offline', idle: 'Ready' }[sync.status || 'idle'])),
      h('p', { class: 'muted small' }, 'SmartScan watches your Documents folder. Images or PDFs you add to a document folder in Explorer are imported; renamed and deleted files are detected. Files are never deleted automatically.'),
      h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'Last check'), h('div', { class: 'v' }, sync.lastRun ? fmt.datetime(sync.lastRun) : '—'),
        h('div', { class: 'k' }, 'Live watching'), h('div', { class: 'v' }, sync.watching ? 'On' : 'Off (periodic checks only)')),
      r ? h('div', { class: 'col', style: { marginTop: '10px', gap: '4px' } },
        h('div', { class: 'small' }, `Last run: +${r.addedPages} pages, +${r.addedDocuments.length} documents, +${r.addedCollections.length} collections, ${r.updatedPages} updated, ${r.renamed.length} renames, ${r.pdfRegenerated} PDFs rebuilt.`),
        list('Missing files', r.missingPages), list('Missing folders', r.missingFolders), list('Renamed', r.renamed), list('Imported documents', r.addedDocuments),
        list('Duplicates skipped', r.duplicatesSkipped), list('Not imported', r.skipped), list('Errors', r.errors)) : null,
      h('div', { class: 'row wrap', style: { marginTop: '12px' } },
        h('button', { class: 'btn primary', id: 'rescanBtn', onclick: (e) => withBusy(e.currentTarget, async () => { const rep = await api('sync:run'); toast(`Rescan complete: +${rep.addedPages} pages, ${rep.missingPages.length} missing`, 'success'); draw(); }) }, icon('refresh'), 'Rescan now'),
        r?.missingPages?.length ? h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmDialog('Remove missing records?', `${fmt.plural(r.missingPages.length, 'page')} whose files were deleted outside SmartScan will be removed from the library index. No files are touched.`, { okLabel: 'Remove records', danger: true }))) return;
          const n = await api('sync:removeMissing'); toast(`Removed ${n} records`, 'success'); await api('sync:run'); draw();
        } }, 'Remove missing records') : null));
    // ---- backup
    const autos = await api('backup:listAuto').catch(() => []);
    const backupCard = h('div', { class: 'card pad' }, h('h3', {}, 'Backup & restore'),
      h('p', { class: 'muted small' }, 'A backup is one .ssbackup file containing your database and every scanned file. Save it to an external drive or USB stick.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: createBackup }, icon('backup'), 'Create backup…'),
        h('button', { class: 'btn', onclick: restoreBackup }, icon('restore'), 'Restore from backup…'),
        h('button', { class: 'btn', onclick: () => api('storage:openFolder', 'backups') }, icon('folderOpen'), 'Backups folder')),
      h('h4', { style: { margin: '18px 0 6px' } }, 'Automatic database backups'),
      h('div', { class: 'muted small' }, 'The index is snapshotted daily (newest kept). Restoring one re-reads your files afterwards.'),
      autos.length ? h('div', { class: 'list', style: { marginTop: '8px', maxHeight: '220px', overflow: 'auto' } }, autos.map((a) => h('div', { class: 'list-item', style: { padding: '6px 4px' } }, icon('backup'), h('div', { class: 'grow small' }, fmt.datetime(a.at), h('span', { class: 'muted' }, ` · ${fmt.bytes(a.size)}`)),
        h('button', { class: 'btn sm', onclick: async () => {
          if (!(await confirmDialog('Restore this database snapshot?', 'The current index is backed up first. Your JPG/PDF files are not changed; SmartScan will rescan them afterwards.', { okLabel: 'Restore' }))) return;
          await api('backup:restoreAuto', a.name); toast('Database restored', 'success'); reloadStatus();
        } }, 'Restore')))) : h('div', { class: 'muted small' }, 'None yet.'),
      h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: async () => { await api('backup:autoNow'); toast('Snapshot created', 'success'); draw(); } }, 'Snapshot now'));
    // ---- duplicates
    const dupCard = h('div', { class: 'card pad' }, h('h3', {}, 'Duplicate detection'), h('p', { class: 'muted small' }, 'Find pages that are identical or look the same across your library.'),
      h('button', { class: 'btn', onclick: showDuplicates }, icon('copy'), 'Find duplicates'));
    wrap.append(h('div', { class: 'settings-grid' }, h('div', { class: 'col', style: { gap: '16px' } }, loc, syncCard), h('div', { class: 'col', style: { gap: '16px' } }, usage, backupCard, dupCard)));
  }

  async function relocate() {
    const base = await api('dialog:chooseFolder', { title: 'Choose the new drive or folder for your library' });
    if (!base) return;
    const keep = h('input', { type: 'checkbox', checked: true });
    modal({
      title: 'Move library',
      body: h('div', { class: 'col' }, h('div', {}, 'Your whole library (documents, database, trash, backups) will be copied to:'), h('code', { style: { userSelect: 'text' } }, `${base}\\SmartScan\\Users\\${state.user.folderName}`),
        h('div', { class: 'muted small' }, 'Every file is verified after copying. SmartScan then uses the new location.'), h('label', { class: 'check' }, keep, 'Keep the old copy (recommended — delete it yourself later)')),
      actions: [{ label: 'Cancel' }, { label: 'Move library', primary: true, onClick: async () => {
        const pm = progressModal('Moving library…');
        const off = onEvent('progress', (p) => { if (p.task === 'relocate') pm.set(p.p, `${Math.round(p.p * 100)}%`); });
        try {
          const r = await api('storage:relocate', { baseDir: base, keepOld: keep.checked });
          toast(`Library now at ${r.newPath}`, 'success', 6000);
          await reloadStatus();
        } finally { off(); pm.close(); }
        return true;
      } }],
    });
  }
  async function locate() {
    const p = await api('dialog:chooseFolder', { title: 'Locate your SmartScan library folder' });
    if (!p) return;
    try { await api('storage:locate', p); toast('Library located', 'success'); reloadStatus(); } catch (e) { toast(e.message, 'error'); }
  }
  async function createBackup() {
    const pm = progressModal('Creating backup…');
    const off = onEvent('progress', (p) => { if (p.task === 'backup') pm.set(p.p); });
    try {
      const r = await api('backup:create', {});
      if (r) toast(`Backup saved (${fmt.bytes(r.size)}, ${r.files} files)`, 'success', 6000);
    } catch (e) { toast(e.message, 'error'); } finally { off(); pm.close(); draw(); }
  }
  async function restoreBackup() {
    const sel = await api('backup:inspect').catch((e) => { toast(e.message, 'error'); return null; });
    if (!sel) return;
    const m = sel.manifest;
    const other = m.username !== state.user.username;
    if (!(await confirmDialog('Restore this backup?', `Backup from ${fmt.datetime(Date.parse(m.createdAt))}${other ? ` (account “${m.username}”)` : ''}\n${m.stats?.documents ?? '?'} documents, ${m.files} files.\n\nYour current documents are NOT deleted: they are moved to a “Restore_Previous_…” folder inside your library.`, { okLabel: 'Restore' }))) return;
    const pm = progressModal('Restoring backup…');
    pm.set(0.3, 'Extracting files…');
    try { const r = await api('backup:restore', sel.file); toast(`Restored. Previous data kept in ${r.previous}`, 'success', 8000); await reloadStatus(); } catch (e) { toast(e.message, 'error'); } finally { pm.close(); }
  }
  async function showDuplicates() {
    const groups = await api('duplicates:list');
    modal({ title: 'Duplicate pages', size: 'wide', body: groups.length ? h('div', { class: 'col' }, groups.map((g) => h('div', { class: 'card pad' },
      h('div', { class: 'small', style: { fontWeight: 600, marginBottom: '8px' } }, g.kind === 'exact' ? 'Identical files' : 'Look the same'),
      h('div', { class: 'row wrap' }, g.pages.map((p) => h('div', { class: 'col', style: { width: '120px', gap: '4px', cursor: 'pointer' }, onclick: () => { document.querySelector('.overlay')?.remove(); navigate(`#/doc/${p.documentId}`); } },
        h('img', { src: thumbUrl(p.pageId), style: { width: '120px', height: '100px', objectFit: 'contain', background: 'var(--panel-2)', borderRadius: '6px' } }),
        h('div', { class: 'small' }, h('b', {}, p.title), h('div', { class: 'muted' }, `${p.collection} · p.${p.position}`)))))))) : h('div', { class: 'empty' }, icon('check'), h('h3', {}, 'No duplicates found')) });
  }

  await draw();
  const unsub = subscribe((e) => { if (e === 'sync' && !document.querySelector('.overlay')) draw(); });
  return unsub;
}
