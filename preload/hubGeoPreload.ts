import { contextBridge, ipcRenderer } from 'electron';

// The hub's geospatial-analysis bridge (depth round 6), exposed as
// `window.hubGeo`. A session preload (see src/windows/hubWindow.ts), so it
// checks where it is: the overlay and the offscreen export windows share the
// session and get nothing from here. Handlers: src/ipc/geoAnalysis.ts.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubGeo', {
    resolvePlace: (text: string) => ipcRenderer.invoke('geo:resolvePlace', { text }),
    boundarySources: (projectId: string) => ipcRenderer.invoke('geo:boundarySources', { projectId }),
    spatialPreview: (projectId: string, datasetId: string, index: number, step: any) =>
      ipcRenderer.invoke('geo:spatialPreview', { projectId, datasetId, index, step }),
    saveSpatialStep: (projectId: string, datasetId: string, index: number, step: any) =>
      ipcRenderer.invoke('geo:saveSpatialStep', { projectId, datasetId, index, step }),
  });
}
