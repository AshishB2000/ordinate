import { contextBridge, ipcRenderer } from 'electron';

// The hub's workspace-THEMES bridge (src/ipc/themes.ts), exposed as
// `window.hubThemes`. A session preload (see src/windows/hubWindow.ts), so it
// checks where it is: the overlay and the offscreen export windows share the
// session and get nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubThemes', {
    list: () => ipcRenderer.invoke('themes:list'),
    save: (theme: any) => ipcRenderer.invoke('themes:save', theme),
    remove: (id: string) => ipcRenderer.invoke('themes:delete', id),
    setDefault: (id: string) => ipcRenderer.invoke('themes:setDefault', id),
    onChanged: (cb: (state: any) => void) => {
      const h = (_e: unknown, state: any) => cb(state);
      ipcRenderer.on('themes:changed', h);
      return () => ipcRenderer.removeListener('themes:changed', h);
    },
  });
}
