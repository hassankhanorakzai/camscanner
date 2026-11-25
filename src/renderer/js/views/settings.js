import { h, icon, toast, modal, fmt } from '../ui.js';
import { api, state, loadSettings, subscribe } from '../core.js';
import { reloadStatus } from '../app.js';

export default async function settings(view) {
  const offline = state.libState !== 'ok';
  const s = offline ? null : await loadSettings();
  const app = await api('app:info');
  const save = async (patch) => {
    try { await api('settings:set', patch); await loadSettings(); toast('Saved', 'success', 1500); } catch (e) { toast(e.message, 'error'); }
  };
  const row = (title, desc, control) => h('div', { class: 'setting' }, h('div', {}, h('div', { style: { fontWeight: 600 } }, title), desc ? h('div', { class: 'd' }, desc) : null), control);
  const toggle = (key, val) => { const i = h('input', { type: 'checkbox', checked: !!val }); i.addEventListener('change', () => save({ [key]: i.checked })); return h('label', { class: 'check' }, i); };
  const select = (key, val, opts, num = false) => { const sel = h('select', { class: 'input' }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l))); sel.addEventListener('change', () => save({ [key]: num ? Number(sel.value) : sel.value })); return sel; };

  view.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Settings'), h('div', { class: 'sub' }, 'Account, scanning defaults and application options.'))));

  // ---- account
  const user = state.user;
  const nameInput = h('input', { class: 'input', value: user.displayName, maxlength: 80 });
  const account = h('div', { class: 'card pad' }, h('h3', {}, 'Account'),
    h('div', { class: 'row', style: { marginBottom: '14px' } }, h('span', { class: 'avatar', style: { width: '48px', height: '48px', fontSize: '18px' } }, fmt.initials(user.displayName)),
      h('div', {}, h('div', { style: { fontWeight: 700 } }, user.displayName), h('div', { class: 'muted small' }, `@${user.username} · member since ${fmt.date(user.createdAt)}`))),
    row('Display name', null, h('div', { class: 'row' }, nameInput, h('button', { class: 'btn', onclick: async () => { try { await api('auth:updateProfile', { displayName: nameInput.value }); toast('Profile updated', 'success'); reloadStatus(); } catch (e) { toast(e.message, 'error'); } } }, 'Save'))),
    row('Password', 'Change the password used to sign in.', h('button', { class: 'btn', onclick: changePassword }, icon('shield'), 'Change password')),
    row('Library folder', user.libraryPath, h('button', { class: 'btn', onclick: () => { location.hash = '#/storage'; } }, 'Manage')),
    row('Delete account', 'Removes your account from this PC. Your files can be kept.', h('button', { class: 'btn danger', onclick: deleteAccount }, icon('trash'), 'Delete…')));

  const blocks = [account];
  if (s) {
    blocks.push(h('div', { class: 'card pad' }, h('h3', {}, 'Scanning'),
      row('Default filter', 'Applied to new captures; change per page in the editor.', select('defaultFilter', s.defaultFilter, [['original', 'Original colour'], ['enhance', 'Magic colour (enhanced)'], ['lighten', 'Lighten'], ['gray', 'Grayscale'], ['bw', 'Black & white']])),
      row('Camera resolution', 'Higher is sharper but slower on low-end PCs.', select('cameraResolution', s.cameraResolution, [['720', '1280 × 720'], ['1080', '1920 × 1080'], ['1440', '2560 × 1440'], ['2160', '3840 × 2160 (4K)']])),
      row('Auto-capture', 'Take the photo automatically when a document is held steady.', toggle('autoCapture', s.autoCapture)),
      row('JPG quality', 'Quality of saved page images.', select('jpgQuality', s.jpgQuality, [[98, 'Maximum (98)'], [92, 'High (92)'], [85, 'Good (85)'], [75, 'Compact (75)']], true))),
    h('div', { class: 'card pad' }, h('h3', {}, 'PDF'),
      row('Create PDF automatically', 'Keep a PDF next to the JPG pages of every document, updated on every change.', toggle('autoPdf', s.autoPdf)),
      row('Page size', 'Pages keep their own proportions — never forced to A4.', select('pdfMode', s.pdfMode, [['dpi', 'From image resolution'], ['id1', 'ID card size (85.6 mm)'], ['passport', 'Passport page (125 mm)']])),
      row('Resolution', 'Used to compute physical page size.', select('pdfDpi', s.pdfDpi, [[150, '150 dpi'], [200, '200 dpi'], [300, '300 dpi']], true)),
      row('Compression', 'Smaller PDFs re-encode images.', select('pdfCompression', s.pdfCompression, [['original', 'None (best quality)'], ['high', 'Light'], ['balanced', 'Balanced'], ['small', 'Small file']]))),
    h('div', { class: 'card pad' }, h('h3', {}, 'Application'),
      row('Theme', null, select('theme', s.theme, [['light', 'Light'], ['dark', 'Dark']])),
      row('Default sort', null, select('defaultSort', s.defaultSort, [['updated', 'Last modified'], ['created', 'Date scanned'], ['title', 'Title'], ['name', 'Person']])),
      row('Start with Windows', 'Launch SmartScan when you sign in to Windows.', (() => { const i = h('input', { type: 'checkbox', checked: !!s.launchAtStartup }); i.addEventListener('change', () => save({ launchAtStartup: i.checked })); return h('label', { class: 'check' }, i); })()),
      row('Automatic database backup', 'Daily snapshot of the index into Backups\\auto.', toggle('autoBackup', s.autoBackup)),
      row('Show accounts on sign-in screen', 'Lists user names on the login screen of this PC.', (() => { const i = h('input', { type: 'checkbox', checked: state.showUserList !== false }); i.addEventListener('change', () => api('auth:setShowUserList', i.checked)); return h('label', { class: 'check' }, i); })())));
  }
  const upd = h('span', { class: 'muted small' });
  blocks.push(h('div', { class: 'card pad' }, h('h3', {}, 'About & updates'),
    h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Version'), h('div', { class: 'v' }, app.version), h('div', { class: 'k' }, 'Runtime'), h('div', { class: 'v' }, `Electron ${app.electron} · ${app.platform}`), h('div', { class: 'k' }, 'App data'), h('div', { class: 'v' }, app.dataDir)),
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: async () => {
      upd.textContent = 'Checking…';
      const r = await api('app:checkUpdates');
      upd.textContent = r.state === 'available' ? `Version ${r.version} is downloading…` : r.state === 'none' ? 'You have the latest version.' : r.message || r.state;
    } }, icon('refresh'), 'Check for updates'), upd),
    h('p', { class: 'muted small' }, 'SmartScan works fully offline. Checking for updates is the only time it contacts the internet, and only when you click the button.')));
  const unsub = subscribe((e, d) => {
    if (e !== 'update') return;
    if (d.state === 'downloading') upd.textContent = `Downloading update… ${Math.round(d.percent || 0)}%`;
    if (d.state === 'ready') { upd.innerHTML = ''; upd.append(`Version ${d.version} is ready. `, h('button', { class: 'btn sm primary', onclick: () => api('app:installUpdate') }, 'Restart & install')); }
    if (d.state === 'error') upd.textContent = d.message;
  });
  view.append(h('div', { class: 'settings-grid' }, h('div', { class: 'col', style: { gap: '16px' } }, blocks.filter((_, i) => i % 2 === 0)), h('div', { class: 'col', style: { gap: '16px' } }, blocks.filter((_, i) => i % 2 === 1))));
  return unsub;
}

function changePassword() {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const n2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  modal({ title: 'Change password', body: h('div', { class: 'col' }, h('label', { class: 'field' }, 'Current password', cur), h('label', { class: 'field' }, 'New password', n1, h('span', { class: 'hint' }, 'At least 8 characters with letters and numbers')), h('label', { class: 'field' }, 'Confirm new password', n2)),
    actions: [{ label: 'Cancel' }, { label: 'Change password', primary: true, onClick: async () => {
      if (n1.value !== n2.value) { toast('New passwords do not match', 'error'); return false; }
      await api('auth:changePassword', { current: cur.value, next: n1.value });
      toast('Password changed', 'success');
      return true;
    } }] });
}

function deleteAccount() {
  const pw = h('input', { class: 'input', type: 'password' });
  const files = h('input', { type: 'checkbox' });
  modal({ title: 'Delete account', body: h('div', { class: 'col' },
    h('div', { class: 'banner err' }, icon('alert'), 'This removes your sign-in from this computer.'),
    h('label', { class: 'check' }, files, 'Also delete my library folder (sent to the Recycle Bin)'),
    h('div', { class: 'muted small' }, 'If unchecked, your JPG/PDF files stay in your storage folder and remain accessible in Explorer.'),
    h('label', { class: 'field' }, 'Confirm with your password', pw)),
  actions: [{ label: 'Cancel' }, { label: 'Delete account', danger: true, onClick: async () => {
    await api('auth:deleteAccount', { password: pw.value, deleteFiles: files.checked });
    location.hash = ''; location.reload();
    return true;
  } }] });
}
