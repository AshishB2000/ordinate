import { contextBridge, ipcRenderer } from 'electron';

// The hub's input-tables bridge, exposed as `window.hubInput` (src/ipc/input.ts).
// A session preload (see src/windows/hubWindow.ts), so it checks where it is:
// the overlay and the offscreen export windows share the session and get
// nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubInput', {
    create: (projectId: string, name: string, columns: any[]) =>
      ipcRenderer.invoke('input:create', { projectId, name, columns }),
    load: (projectId: string, id: string) => ipcRenderer.invoke('input:load', { projectId, id }),
    validate: (projectId: string, id: string, rows: any[]) => ipcRenderer.invoke('input:validate', { projectId, id, rows }),
    save: (projectId: string, id: string, batches: any[]) => ipcRenderer.invoke('input:save', { projectId, id, batches }),
    setColumns: (projectId: string, id: string, columns: any[], from: number[]) =>
      ipcRenderer.invoke('input:setColumns', { projectId, id, columns, from }),
  });
}
