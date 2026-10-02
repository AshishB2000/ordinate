import { contextBridge, ipcRenderer } from 'electron';

// The hub's notebooks bridge, exposed as `window.hubNotebooks` (src/ipc/notebooks.ts).
// A session preload (see src/windows/hubWindow.ts), so it checks where it is:
// the overlay and the offscreen export windows share the session and get
// nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubNotebooks', {
    list: (projectId: string) => ipcRenderer.invoke('notebook:list', { projectId }),
    get: (projectId: string, id: string) => ipcRenderer.invoke('notebook:get', { projectId, id }),
    create: (projectId: string, name: string) => ipcRenderer.invoke('notebook:create', { projectId, name }),
    save: (projectId: string, id: string, name: string, cells: any[]) =>
      ipcRenderer.invoke('notebook:save', { projectId, id, name, cells }),
    remove: (projectId: string, id: string) => ipcRenderer.invoke('notebook:delete', { projectId, id }),
    run: (projectId: string, id: string, cellId: string, runId: string) =>
      ipcRenderer.invoke('notebook:run', { projectId, id, cellId, runId }),
    cancel: (runId: string) => ipcRenderer.invoke('notebook:cancel', { runId }),
    prepareSave: (projectId: string, id: string, cellId: string) =>
      ipcRenderer.invoke('notebook:prepareSave', { projectId, id, cellId }),
    pinVisual: (projectId: string, id: string, cellId: string) =>
      ipcRenderer.invoke('notebook:pinVisual', { projectId, id, cellId }),
    exportMarkdown: (projectId: string, id: string, charts: Record<string, string>) =>
      ipcRenderer.invoke('notebook:exportMarkdown', { projectId, id, charts }),
  });
}
