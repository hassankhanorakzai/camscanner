// Shared state, API bridge and URL helpers.
export const api = (channel, ...args) => window.smartscan.call(channel, ...args);
export const onEvent = (evt, cb) => window.smartscan.on(evt, cb);

export const state = {
  user: null,
  settings: null,
  sync: null,
  libState: null,
  libError: null,
  docTypes: [],
  listeners: new Set(),
};

export function emit(evt, data) { for (const l of state.listeners) { try { l(evt, data); } catch (e) { console.error(e); } } }
export function subscribe(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }

export const fileUrl = (kind, id, v = '') => `app://smartscan/_data/${kind}/${id}${v ? `?v=${v}` : ''}`;
export const thumbUrl = (pageId, v) => fileUrl('thumb', pageId, v);

export function navigate(hash) { if (location.hash !== hash) location.hash = hash; else window.dispatchEvent(new HashChangeEvent('hashchange')); }

export async function loadSettings() {
  state.settings = await api('settings:get');
  state.docTypes = state.settings.docTypes || [];
  document.documentElement.dataset.theme = state.settings.theme === 'dark' ? 'dark' : 'light';
  return state.settings;
}
