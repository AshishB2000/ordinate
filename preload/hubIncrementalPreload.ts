import { contextBridge, ipcRenderer } from 'electron';

// The hub's incremental-refresh bridge, exposed as `window.hubIncremental`
// (src/ipc/incremental.ts). A session preload (see src/windows/hubWindow.ts), so
// it checks where it is: the overlay and the offscreen export windows share the
// session and get nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  contextBridge.exposeInMainWorld('hubIncremental', {
    get: (projectId: string, datasetId: string) => ipcRenderer.invoke('incremental:get', { projectId, datasetId }),
    // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
    set: (projectId: string, datasetId: string, patch: any) =>
      ipcRenderer.invoke('incremental:set', { ...patch, projectId, datasetId }),
    requestFull: (projectId: string, datasetId: string) => ipcRenderer.invoke('incremental:requestFull', { projectId, datasetId }),
  });
}
