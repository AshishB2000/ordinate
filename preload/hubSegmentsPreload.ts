import { contextBridge, ipcRenderer } from 'electron';

// The hub's Find-segments bridge (src/ipc/segments.ts), exposed as
// `window.hubSegments`. A session preload (src/windows/hubWindow.ts registers
// every hub*Preload.js), so it checks it is in the hub before exposing
// anything — the overlay and the offscreen export windows share the session
// and get nothing.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubSegments', {
    // Number columns, ticked or skipped with why; RFM's picker defaults.
    features: (projectId: string, datasetId: string) => ipcRenderer.invoke('segments:features', { projectId, datasetId }),
    // A job: { ok, result } | { ok:false, error, cancelled? }.
    fit: (projectId: string, datasetId: string, features: string[]) => ipcRenderer.invoke('segments:fit', { projectId, datasetId, features }),
    saveColumn: (projectId: string, datasetId: string, step: any) => ipcRenderer.invoke('segments:saveColumn', { projectId, datasetId, step }),
    rfm: (projectId: string, datasetId: string, spec: any) => ipcRenderer.invoke('segments:rfm', { projectId, datasetId, spec }),
    rfmSave: (projectId: string, datasetId: string, spec: any) => ipcRenderer.invoke('segments:rfmSave', { projectId, datasetId, spec }),
  });
}
