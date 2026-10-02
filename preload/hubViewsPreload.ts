import { contextBridge, ipcRenderer } from 'electron';

// The hub's saved-views bridge, exposed as `window.hubViews` (src/ipc/views.ts).
// A session preload (see src/windows/hubWindow.ts), so it checks where it is:
// the overlay and the offscreen export windows share the session and get
// nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubViews', {
    edit: (projectId: string, analysisId: string, op: any) => ipcRenderer.invoke('views:edit', { projectId, analysisId, op }),
    scope: (projectId: string, analysisId: string, viewId: string) => ipcRenderer.invoke('views:scope', { projectId, analysisId, viewId }),
    parseLink: (url: string) => ipcRenderer.invoke('views:parseLink', { url }),
    openLink: (url: string) => ipcRenderer.invoke('views:openLink', { url }),
    takeLink: () => ipcRenderer.invoke('views:takeLink'),
    onLink: (cb: () => void) => { ipcRenderer.on('views:link', () => cb()); },
  });
}
