import { contextBridge, ipcRenderer } from 'electron';

// The hub's data-snapshots bridge, exposed as `window.hubSnapshots`. A session
// preload (see src/windows/hubWindow.ts), so it checks where it is: the overlay
// and the offscreen export windows share the session and get nothing from here.
//
// The last five methods are the ORDINARY read channels with an `asOf` time
// added — view state for the "As of" picker (src/data/asOf.ts). They exist here
// because preload/hubPreload.ts sits at its size cap.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubSnapshots', {
    list: (projectId: string, datasetId: string) => ipcRenderer.invoke('snapshots:list', { projectId, datasetId }),
    setKeep: (projectId: string, datasetId: string, keep: number) =>
      ipcRenderer.invoke('snapshots:setKeep', { projectId, datasetId, keep }),
    diff: (projectId: string, datasetId: string, stamp: string, key: string | null, limit?: number) =>
      ipcRenderer.invoke('snapshots:diff', { projectId, datasetId, stamp, key, limit }),
    restore: (projectId: string, datasetId: string, stamp: string) =>
      ipcRenderer.invoke('snapshots:restore', { projectId, datasetId, stamp }),
    stamps: (projectId: string, datasetIds: string[], metricIds: string[]) =>
      ipcRenderer.invoke('snapshots:stamps', { projectId, datasetIds, metricIds }),
    metricHistory: (projectId: string, metricId: string) =>
      ipcRenderer.invoke('snapshots:metricHistory', { projectId, metricId }),
    visualData: (projectId: string, datasetId: string, encoding: any, filters: any, params: any, asOf: string) =>
      ipcRenderer.invoke('visual:data', { projectId, datasetId, encoding, filters, params, asOf }),
    metricValue: (projectId: string, id: string, filters: any, params: any, asOf: string) =>
      ipcRenderer.invoke('metric:value', { projectId, id, filters, params, asOf }),
    computeMetric: (projectId: string, datasetId: string, column: string, aggregation: string, filters: any, params: any, asOf: string) =>
      ipcRenderer.invoke('dashboard:metric', { projectId, datasetId, column, aggregation, filters, params, asOf }),
    visualRows: (projectId: string, datasetId: string, encoding: any, filters: any, mark: any, page: any, params: any, asOf: string) =>
      ipcRenderer.invoke('visual:rows', { projectId, datasetId, encoding, filters, mark, page, params, asOf }),
    exportVisualRows: (projectId: string, datasetId: string, encoding: any, filters: any, mark: any, page: any, name: string, params: any, asOf: string) =>
      ipcRenderer.invoke('visual:rowsExport', { projectId, datasetId, encoding, filters, mark, page, name, params, asOf }),
  });
}
