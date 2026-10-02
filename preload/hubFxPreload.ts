import { contextBridge, ipcRenderer } from 'electron';

// The hub's multi-currency bridge, exposed as `window.hubFx` (src/ipc/fx.ts).
// A session preload (see src/windows/hubWindow.ts), so it checks where it is.
//
// The three READS below are the ordinary `visual:data` / `metric:value` /
// `dashboard:metric` channels with a dashboard's own target currency on the
// request — renderer/hub/fxUi.ts routes a dashboard's tiles through them only
// when that dashboard has picked one.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubFx', {
    get: (projectId: string) => ipcRenderer.invoke('fx:get', { projectId }),
    set: (projectId: string, patch: any) => ipcRenderer.invoke('fx:set', { projectId, patch }),
    column: (projectId: string, datasetId: string, column: string, decl: any) =>
      ipcRenderer.invoke('fx:column', { projectId, datasetId, column, decl }),
    dashboard: (projectId: string, dashboardId: string, code: string | null) =>
      ipcRenderer.invoke('fx:dashboard', { projectId, dashboardId, code }),
    coverage: (projectId: string, datasetId: string, column: string, currency?: string) =>
      ipcRenderer.invoke('fx:coverage', { projectId, datasetId, column, currency }),
    visualData: (req: any) => ipcRenderer.invoke('visual:data', req),
    metricValue: (req: any) => ipcRenderer.invoke('metric:value', req),
    computeMetric: (req: any) => ipcRenderer.invoke('dashboard:metric', req),
  });
}
