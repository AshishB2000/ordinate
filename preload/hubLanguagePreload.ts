import { contextBridge, ipcRenderer } from 'electron';

// The hub's language bridge, exposed as `window.hubI18n` (src/ipc/i18n.ts).
// `boot` is fetched with sendSync ON PURPOSE: it must exist before the hub's
// first <script> runs, because renderer files build their labels at load time.
// A session preload (see src/windows/hubWindow.ts — found by the name pattern
// hub[A-Z][A-Za-z]*Preload.js, which is why this is not hubI18nPreload), so it
// checks where it is.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  let boot: unknown = null;
  try { boot = ipcRenderer.sendSync('i18n:boot'); } catch (_) { boot = null; }
  contextBridge.exposeInMainWorld('hubI18n', {
    boot,
    languages: () => ipcRenderer.invoke('i18n:languages'),
    setLanguage: (code: string) => ipcRenderer.invoke('i18n:setLanguage', code),
  });
}
