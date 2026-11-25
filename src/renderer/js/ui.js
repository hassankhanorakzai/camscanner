// Small UI toolkit: element builder, icons, modals, toasts, menus, formatting.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  files: '<path d="M15 3H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z"/><path d="M15 3v4h4"/><path d="M3 8v11a2 2 0 0 0 2 2h9"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 3.5a4 4 0 0 1 0 8M22 21a6 6 0 0 0-4-5.6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  drive: '<rect x="2" y="13" width="20" height="8" rx="2"/><path d="M5.5 13 8 4h8l2.5 9M6 17h.01M10 17h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  download: '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  upload: '<path d="M12 21V9m0 0-4 4m4-4 4 4M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 19 5.5 11h16L19 19z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  rotL: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  rotR: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>', chevR: '<path d="m9 18 6-6-6-6"/>', chevD: '<path d="m6 9 6 6 6-6"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  printerScan: '<rect x="2" y="12" width="20" height="8" rx="2"/><path d="M5 12 7 4h10l2 8M6 16h6"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  wand: '<path d="m15 4 1 2 2 1-2 1-1 2-1-2-2-1 2-1zM5 19 17 7"/><path d="M19 13l.7 1.3L21 15l-1.3.7L19 17l-.7-1.3L17 15l1.3-.7z"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  backup: '<path d="M4 7c0-2 3.6-4 8-4s8 2 8 4-3.6 4-8 4-8-2-8-4z"/><path d="M4 7v10c0 2 3.6 4 8 4s8-2 8-4V7M4 12c0 2 3.6 4 8 4s8-2 8-4"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/>',
  external: '<path d="M14 3h7v7M10 14 21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
  move: '<path d="M5 9 2 12l3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01"/>',
};

export function icon(name, size) {
  const s = size ? ` style="width:${size}px;height:${size}px"` : '';
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = `<svg class="i" viewBox="0 0 24 24"${s}>${P[name] || ''}</svg>`;
  return span.firstChild;
}

export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export const fmt = {
  bytes(n) {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  },
  date(t) { return t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; },
  datetime(t) { return t ? new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; },
  rel(t) {
    if (!t) return '—';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return fmt.date(t);
  },
  initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?'; },
  plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; },
};

export function toast(message, type = 'info', ms = 3800) {
  const el = h('div', { class: `toast ${type}` }, icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info'), h('div', {}, message));
  document.getElementById('toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, ms);
}

export function modal({ title, body, actions = [], size = '', onClose, dismissable = true }) {
  const bodyEl = h('div', { class: 'modal-body' });
  const foot = h('div', { class: 'modal-foot' });
  const box = h('div', { class: `modal ${size}` }, h('div', { class: 'modal-head' }, h('h2', {}, title), dismissable ? h('button', { class: 'btn ghost icon sm', onclick: () => close(), title: 'Close' }, icon('x')) : null), bodyEl, foot);
  const overlay = h('div', { class: 'overlay' }, box);
  let closed = false;
  const close = (v) => {
    if (closed) return; closed = true;
    overlay.remove(); document.removeEventListener('keydown', onKey, true);
    onClose?.(v);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
      const primary = actions.find((a) => a.primary);
      if (primary && !e.defaultPrevented) { e.preventDefault(); primaryBtn?.click(); }
    }
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && dismissable) close(); });
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) append(bodyEl, [body]);
  let primaryBtn = null;
  for (const a of actions) {
    const b = h('button', { class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger solid' : ''}` }, a.label);
    if (a.primary) primaryBtn = b;
    b.addEventListener('click', async () => {
      if (!a.onClick) return close(a.value);
      b.disabled = true;
      try { const r = await a.onClick(); if (r !== false) close(r ?? a.value); } catch (e) { toast(e.message, 'error'); } finally { b.disabled = false; }
    });
    foot.append(b);
  }
  if (!actions.length) foot.remove();
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  setTimeout(() => bodyEl.querySelector('input:not([type=checkbox]):not([type=range]),select,textarea')?.focus(), 30);
  return { el: box, body: bodyEl, close };
}

export function confirmDialog(title, message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    modal({ title, body: h('div', { class: 'muted', style: { whiteSpace: 'pre-line' } }, message), onClose: (v) => resolve(!!v),
      actions: [{ label: 'Cancel', value: false }, { label: okLabel, primary: !danger, danger, value: true }] });
  });
}

export function promptDialog(title, label, value = '', { placeholder = '', okLabel = 'Save', list = null } = {}) {
  return new Promise((resolve) => {
    const id = `dl${Math.random().toString(36).slice(2)}`;
    const input = h('input', { class: 'input', value, placeholder, list: list ? id : null, maxlength: 150 });
    const body = h('label', { class: 'field' }, label, input, list ? h('datalist', { id }, list.map((o) => h('option', { value: o }))) : null);
    modal({ title, body, onClose: (v) => resolve(v ?? null),
      actions: [{ label: 'Cancel' }, { label: okLabel, primary: true, onClick: () => { const v = input.value.trim(); if (!v) { input.focus(); return false; } return v; } }] });
    setTimeout(() => input.select(), 40);
  });
}

let openMenu = null;
export function menu(anchor, items) {
  closeMenu();
  const el = h('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { el.append(h('hr')); continue; }
    el.append(h('button', { class: it.danger ? 'danger' : '', disabled: it.disabled, onclick: () => { closeMenu(); it.onClick(); } }, it.icon ? icon(it.icon) : null, it.label));
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth; const mh = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
  el.style.top = `${r.bottom + mh + 6 > window.innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
  openMenu = el;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener('mousedown', outside, true); } }

export async function withBusy(btn, fn) {
  const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}

/** Progress modal for long tasks. */
export function progressModal(title) {
  const bar = h('div', { style: { width: '0%' } });
  const label = h('div', { class: 'muted small' }, 'Working…');
  const m = modal({ title, body: h('div', { class: 'col' }, h('div', { class: 'progress' }, bar), label), dismissable: false });
  return { set(p, text) { bar.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`; if (text) label.textContent = text; }, close: () => m.close() };
}

/** Make children of `container` (matching selector) reorderable by drag & drop. */
export function sortable(container, selector, onDrop, { horizontal = false } = {}) {
  let dragEl = null;
  container.addEventListener('dragstart', (e) => {
    const it = e.target.closest(selector); if (!it) return;
    dragEl = it; it.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', '');
  });
  container.addEventListener('dragend', () => { dragEl?.classList.remove('dragging'); dragEl = null; $$('.drop-before,.drop-after', container).forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
  container.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    const it = e.target.closest(selector); if (!it || it === dragEl) return;
    e.preventDefault();
    const r = it.getBoundingClientRect();
    const after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    $$('.drop-before,.drop-after', container).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    it.classList.add(after ? 'drop-after' : 'drop-before');
  });
  container.addEventListener('drop', (e) => {
    if (!dragEl) return;
    const it = e.target.closest(selector); if (!it || it === dragEl) return;
    e.preventDefault();
    const after = it.classList.contains('drop-after');
    it.classList.remove('drop-before', 'drop-after');
    if (after) it.after(dragEl); else it.before(dragEl);
    onDrop($$(selector, container).map((x) => x.dataset.id));
  });
}
