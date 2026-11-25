import { h, $, icon, toast, fmt, menu, modal, confirmDialog } from './ui.js';
import { api, onEvent, state, emit, navigate, loadSettings } from './core.js';

const routes = {
  dashboard: () => import('./views/dashboard.js'),
  scan: () => import('./scan/scan.js'),
  documents: () => import('./views/documents.js'),
  recent: () => import('./views/documents.js'),
  favorites: () => import('./views/favorites.js'),
  collections: () => import('./views/collections.js'),
  collection: () => import('./views/collection.js'),
  doc: () => import('./views/viewer.js'),
  trash: () => import('./views/trash.js'),
  storage: () => import('./views/storage.js'),
  settings: () => import('./views/settings.js'),
  portal: () => import('./views/portal.js'),
};

const NAV = [
  ['dashboard', 'Dashboard', 'home'],
  ['scan', 'Scan Document', 'scan'],
  ['documents', 'My Documents', 'files'],
  ['collections', 'People / Collections', 'users'],
  ['recent', 'Recent Scans', 'clock'],
  ['favorites', 'Favorites', 'star'],
  ['trash', 'Trash', 'trash'],
  '-',
  ['portal', 'Phone & Web', 'phone'],
  ['storage', 'Local Storage', 'drive'],
  ['settings', 'Settings', 'settings'],
];

let cleanup = null;
let currentRoute = null;
export const leaveGuard = { fn: null };

// ---------------------------------------------------------------- boot
async function boot() {
  onEvent('sync:state', (s) => { state.sync = s; renderSyncChip(); emit('sync', s); });
  onEvent('library:changed', () => { emit('changed'); refreshCounts(); });
  onEvent('update:status', (s) => emit('update', s));
  let st = await api('auth:status');
  if (!st.user) st = await api('auth:resume').catch(() => st);
  if (st.user) await enterApp(st); else showAuth(st);
}

function applyStatus(st) {
  state.user = st.user; state.showUserList = st.showUserList; state.libState = st.libState; state.libError = st.libError; state.sync = st.sync;
}

// ---------------------------------------------------------------- auth
function showAuth(st, mode = st.hasAccounts ? 'login' : 'register') {
  $('#shell').classList.add('hidden');
  const root = $('#auth');
  root.classList.remove('hidden');
  root.innerHTML = '';
  document.documentElement.dataset.theme = 'light';
  const hero = h('div', { class: 'auth-hero' },
    h('div', {},
      h('div', { class: 'brand', style: { padding: 0, marginBottom: '48px' } }, h('div', { class: 'logo' }, icon('scan')), 'SmartScan'),
      h('h1', {}, 'Scan, organise and keep every document — on your own PC.'),
      h('p', {}, 'Auto-cropped scans saved as real JPG and PDF files in folders you can open in Windows Explorer.'),
      h('ul', {},
        h('li', {}, icon('scan'), 'Automatic edge detection & perspective correction'),
        h('li', {}, icon('users'), 'Organise by person: CNIC, passport, certificates…'),
        h('li', {}, icon('drive'), 'Stored on your chosen drive — works fully offline'),
        h('li', {}, icon('shield'), 'Separate, password-protected libraries per user'))),
    h('div', { class: 'small', style: { opacity: 0.7 } }, 'Your documents never leave this computer.'),
    h('div', { class: 'paper' }), h('div', { class: 'paper b' }));
  const formWrap = h('div', { class: 'auth-form' });
  root.append(hero, formWrap);
  const err = h('div', { class: 'auth-err hidden' });
  const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); };

  if (mode === 'login') {
    const user = h('input', { class: 'input', placeholder: 'Username', value: st.lastUsername || '', autocomplete: 'username' });
    const pass = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const remember = h('input', { type: 'checkbox' });
    const btn = h('button', { class: 'btn primary lg', type: 'submit' }, 'Sign in');
    const form = h('form', { class: 'auth-card', onsubmit: async (e) => {
      e.preventDefault(); err.classList.add('hidden'); btn.disabled = true;
      try { await enterApp(await api('auth:login', { username: user.value, password: pass.value, remember: remember.checked })); } catch (x) { showErr(x.message); pass.select(); } finally { btn.disabled = false; }
    } },
    h('h2', {}, 'Welcome back'), h('div', { class: 'muted' }, 'Sign in to your document library.'),
    st.knownUsers?.length ? h('div', { class: 'user-chips' }, st.knownUsers.slice(0, 6).map((u) => h('span', { class: 'user-chip', onclick: () => { user.value = u.username; pass.focus(); } }, h('span', { class: 'avatar' }, fmt.initials(u.displayName)), u.displayName))) : null,
    err,
    h('label', { class: 'field' }, 'Username', user),
    h('label', { class: 'field' }, 'Password', pass),
    h('label', { class: 'check' }, remember, 'Keep me signed in on this computer'),
    btn,
    h('div', { class: 'muted center' }, 'New here? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); showAuth(st, 'register'); } }, 'Create an account')));
    formWrap.append(form);
    setTimeout(() => { if (document.activeElement === document.body) (user.value ? pass : user).focus(); }, 30);
  } else {
    const display = h('input', { class: 'input', placeholder: 'e.g. Ayesha Khan', maxlength: 80 });
    const user = h('input', { class: 'input', placeholder: 'letters, numbers, . _ -', autocomplete: 'username' });
    const pass = h('input', { class: 'input', type: 'password', placeholder: 'At least 8 characters, letters + numbers', autocomplete: 'new-password' });
    const pass2 = h('input', { class: 'input', type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password' });
    let base = st.defaultBase;
    const loc = h('input', { class: 'input', value: base, readonly: true, title: base });
    const remember = h('input', { type: 'checkbox', checked: true });
    const btn = h('button', { class: 'btn primary lg', type: 'submit' }, 'Create account');
    const form = h('form', { class: 'auth-card', onsubmit: async (e) => {
      e.preventDefault(); err.classList.add('hidden');
      if (pass.value !== pass2.value) return showErr('Passwords do not match.');
      btn.disabled = true;
      try { await enterApp(await api('auth:register', { username: user.value, password: pass.value, displayName: display.value || user.value, baseDir: base, remember: remember.checked }), true); } catch (x) { showErr(x.message); } finally { btn.disabled = false; }
    } },
    h('h2', {}, st.hasAccounts ? 'Create a new account' : 'Set up SmartScan'), h('div', { class: 'muted' }, 'Each account has its own private document library and folder.'),
    err,
    h('label', { class: 'field' }, 'Your name', display),
    h('label', { class: 'field' }, 'Username', user),
    h('div', { class: 'two-col' }, h('label', { class: 'field' }, 'Password', pass), h('label', { class: 'field' }, 'Confirm', pass2)),
    h('label', { class: 'field' }, 'Storage location', h('div', { class: 'row' }, loc, h('button', { class: 'btn', type: 'button', onclick: async () => {
      const p = await api('dialog:chooseFolder', { title: 'Where should SmartScan keep your documents?', defaultPath: base });
      if (p) { base = p; loc.value = p; loc.title = p; }
    } }, icon('folder'), 'Browse')), h('span', { class: 'hint' }, 'Any internal or external drive. A “SmartScan” folder will be created here.')),
    h('label', { class: 'check' }, remember, 'Keep me signed in on this computer'),
    btn,
    st.hasAccounts ? h('div', { class: 'muted center' }, 'Already have an account? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); showAuth(st, 'login'); } }, 'Sign in')) : null);
    formWrap.append(form);
    setTimeout(() => { if (document.activeElement === document.body) display.focus(); }, 30);
  }
}

// ---------------------------------------------------------------- shell
async function enterApp(st, fresh = false) {
  applyStatus(st);
  $('#auth').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  if (state.libState === 'ok') await loadSettings().catch(() => {});
  renderSidebar(); renderTopbar();
  window.removeEventListener('hashchange', route);
  window.addEventListener('hashchange', route);
  if (fresh) location.hash = '#/dashboard';
  route();
  if (fresh) toast(`Your library was created at ${state.user.libraryPath}`, 'success', 6000);
}

export async function reloadStatus() {
  applyStatus(await api('auth:status'));
  if (state.libState === 'ok') await loadSettings().catch(() => {});
  renderSidebar(); renderTopbar(); route();
}

function renderSidebar() {
  const sb = $('#sidebar');
  sb.innerHTML = '';
  sb.append(h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('scan')), 'SmartScan'));
  for (const n of NAV) {
    if (n === '-') { sb.append(h('div', { class: 'nav-sep' })); continue; }
    const [id, label, ic] = n;
    sb.append(h('a', { class: 'nav-item', href: `#/${id}`, dataset: { nav: id } }, icon(ic), label, h('span', { class: 'count hidden', dataset: { count: id } })));
  }
  sb.append(h('div', { class: 'sidebar-foot' }, h('div', { class: 'storage-meter', id: 'storageMeter' })));
  refreshCounts();
  highlightNav();
}

export async function refreshCounts() {
  if (state.libState !== 'ok') return;
  try {
    const s = await api('stats:get');
    const set = (k, v) => { const el = document.querySelector(`[data-count="${k}"]`); if (el) { el.textContent = v; el.classList.toggle('hidden', !v); } };
    set('documents', s.documents); set('collections', s.collections); set('trash', s.trash); set('favorites', s.favorites);
    const m = $('#storageMeter');
    if (m) {
      const used = s.jpgBytes + s.pdfBytes;
      m.innerHTML = '';
      m.append(h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', {}, 'Library size'), h('b', { style: { color: '#e2e8f0' } }, fmt.bytes(used))),
        h('div', { class: 'small' }, `${s.jpgFiles} JPG · ${s.pdfFiles} PDF`));
      api('storage:info').then((info) => {
        const d = info.usage?.disk;
        if (!d) return;
        const pct = Math.round(((d.total - d.free) / d.total) * 100);
        m.append(h('div', { class: 'meter', title: `${pct}% of drive used` }, h('div', { style: { width: `${pct}%` } })), h('div', { class: 'small' }, `${fmt.bytes(d.free)} free on drive`));
      }).catch(() => {});
    }
  } catch { /* offline */ }
}

function highlightNav() {
  const r = (location.hash.slice(2).split(/[/?]/)[0]) || 'dashboard';
  const map = { collection: 'collections', doc: null };
  const key = r in map ? map[r] : r;
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}

function renderTopbar() {
  const tb = $('#topbar');
  tb.innerHTML = '';
  const q = h('input', { class: 'input', placeholder: 'Search people, documents, types, tags…', id: 'globalSearch' });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(`#/documents?q=${encodeURIComponent(q.value.trim())}`); });
  const user = state.user;
  const um = h('div', { class: 'user-menu', title: user.libraryPath }, h('span', { class: 'avatar' }, fmt.initials(user.displayName)), h('div', {}, h('div', { style: { fontWeight: 600, fontSize: '13px' } }, user.displayName), h('div', { class: 'muted small' }, `@${user.username}`)), icon('chevD'));
  um.addEventListener('click', () => menu(um, [
    { label: 'Account & settings', icon: 'settings', onClick: () => navigate('#/settings') },
    { label: 'Open my storage folder', icon: 'folderOpen', onClick: () => api('storage:openFolder', 'documents').catch((e) => toast(e.message, 'error')) },
    '-',
    { label: 'Sign out', icon: 'logout', onClick: logout },
  ]));
  tb.append(h('div', { class: 'search' }, icon('search'), q), h('div', { class: 'spacer' }),
    h('span', { id: 'syncChip' }),
    h('button', { class: 'btn primary', onclick: () => navigate('#/scan') }, icon('camera'), 'Scan'), um);
  renderSyncChip();
}

function renderSyncChip() {
  const holder = $('#syncChip');
  if (!holder) return;
  const s = state.libState !== 'ok' ? { status: 'offline' } : (state.sync || { status: 'idle' });
  const label = { synced: 'Synced', syncing: 'Syncing…', attention: 'Needs attention', offline: 'Storage offline', idle: 'Ready' }[s.status] || 'Ready';
  const title = s.status === 'offline' ? 'The storage drive is not connected' : s.lastRun ? `Last checked ${fmt.rel(s.lastRun)}${s.watching ? ' · watching for changes' : ''}` : '';
  holder.innerHTML = '';
  holder.append(h('span', { class: `sync-chip ${s.status}`, title, onclick: () => navigate('#/storage') }, h('span', { class: 'dot' }), label));
}

async function logout() {
  if (leaveGuard.fn && !(await leaveGuard.fn())) return;
  leaveGuard.fn = null;
  cleanup?.(); cleanup = null;
  const st = await api('auth:logout');
  state.user = null;
  location.hash = '';
  showAuth(st, 'login');
}

// ---------------------------------------------------------------- routing
let lastHash = '';
async function route() {
  if (!state.user) return;
  const hash = location.hash || '#/dashboard';
  if (leaveGuard.fn && hash !== lastHash && lastHash) {
    const ok = await leaveGuard.fn();
    if (!ok) { history.replaceState(null, '', lastHash); highlightNav(); return; }
    leaveGuard.fn = null;
  }
  lastHash = hash;
  const [pathPart, queryPart] = hash.slice(2).split('?');
  const [name, ...params] = pathPart.split('/');
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  highlightNav();
  const view = $('#view');
  cleanup?.(); cleanup = null;
  view.className = '';
  view.innerHTML = '';
  if (state.libState !== 'ok' && !['settings'].includes(name)) { renderOffline(view); return; }
  const loader = routes[name] || routes.dashboard;
  const token = (currentRoute = {});
  try {
    const mod = await loader();
    if (token !== currentRoute) return;
    cleanup = (await mod.default(view, params, query, name)) || null;
  } catch (e) {
    console.error(e);
    view.append(h('div', { class: 'banner err' }, icon('alert'), e.message));
  }
}

function renderOffline(view) {
  const foreign = state.libState === 'foreign';
  view.append(h('div', { class: 'empty', style: { maxWidth: '640px', margin: '40px auto' } },
    icon(foreign ? 'alert' : 'drive'),
    h('h3', {}, foreign ? 'This folder belongs to another library' : 'Your storage drive is not available'),
    h('p', {}, state.libError || 'The library folder could not be opened.'),
    h('p', { class: 'small' }, 'If it is on an external or network drive, reconnect it and press Retry. If the drive letter changed, use “Locate library”. Nothing has been deleted.'),
    h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '18px' } },
      h('button', { class: 'btn primary', onclick: async () => { const st = await api('storage:retry'); applyStatus(st); if (st.libState === 'ok') { toast('Storage reconnected', 'success'); reloadStatus(); } else toast('Still not available', 'error'); } }, icon('refresh'), 'Retry'),
      h('button', { class: 'btn', onclick: async () => {
        const p = await api('dialog:chooseFolder', { title: 'Locate your SmartScan library folder' });
        if (!p) return;
        try { applyStatus(await api('storage:locate', p)); toast('Library found', 'success'); reloadStatus(); } catch (e) { toast(e.message, 'error'); }
      } }, icon('search'), 'Locate library'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('Start a new empty library?', 'Use this only if the old drive is lost. Your old files are not touched, and you can still restore from a backup later.', { okLabel: 'Choose location' }))) return;
        const p = await api('dialog:chooseFolder', { title: 'Where should the new library be created?' });
        if (!p) return;
        try { applyStatus(await api('storage:createNew', p)); reloadStatus(); } catch (e) { toast(e.message, 'error'); }
      } }, 'New library'))));
}

// global keyboard shortcut: Ctrl+K focuses search
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#globalSearch')?.focus(); }
});
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.message) toast(e.reason.message, 'error'); });

// prevent the window from navigating when files are dropped outside a drop zone
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

export { modal };
boot().catch((e) => { document.body.innerHTML = `<pre style="padding:20px;color:#b91c1c">${e.stack || e}</pre>`; });
