'use strict';
/* Minimal, allow-listed bridge between the UI and the main process. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const PREFIXES = ['auth:', 'dialog:', 'storage:', 'sync:', 'settings:', 'collections:', 'documents:', 'pages:', 'trash:', 'stats:', 'duplicates:', 'files:', 'pdf:', 'print:', 'backup:', 'scanner:', 'phone:', 'app:'];
const EVENTS = ['sync:state', 'library:changed', 'progress', 'phone:image', 'update:status'];

contextBridge.exposeInMainWorld('smartscan', {
  async call(channel, ...args) {
    if (typeof channel !== 'string' || !PREFIXES.some((p) => channel.startsWith(p))) throw new Error(`Blocked channel ${channel}`);
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
    return r.result;
  },
  on(event, cb) {
    if (!EVENTS.includes(event)) throw new Error(`Blocked event ${event}`);
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(event, fn);
    return () => ipcRenderer.removeListener(event, fn);
  },
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
});
