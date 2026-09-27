import { contextBridge, ipcRenderer } from 'electron';

// The hub's what-if scenarios bridge, exposed as `window.hubScenarios`. A session
// preload (see src/windows/hubWindow.ts), so it checks where it is: the overlay
// and the offscreen export windows share the session and get nothing from here.
// Every figure behind these calls is computed in main (src/ipc/scenarios.ts).
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubScenarios', {
    list: (projectId: string) => ipcRenderer.invoke('scenario:list', { projectId }),
    get: (projectId: string, id: string) => ipcRenderer.invoke('scenario:get', { projectId, id }),
    create: (projectId: string, input: any) => ipcRenderer.invoke('scenario:create', { projectId, input }),
    update: (projectId: string, id: string, patch: any) => ipcRenderer.invoke('scenario:update', { projectId, id, patch }),
    duplicate: (projectId: string, id: string) => ipcRenderer.invoke('scenario:duplicate', { projectId, id }),
    remove: (projectId: string, id: string) => ipcRenderer.invoke('scenario:delete', { projectId, id }),
    // Baseline + scenario figures and the tornado; `draft` = unsaved drivers/metrics.
    compute: (projectId: string, id: string, draft?: any, focusMetricId?: string) =>
      ipcRenderer.invoke('scenario:compute', { projectId, id, draft, focusMetricId }),
    compare: (projectId: string, ids: string[]) => ipcRenderer.invoke('scenario:compare', { projectId, ids }),
    // One metric under a scenario, with a dashboard's filters and parameters.
    card: (projectId: string, scenarioId: string, metricId: string, filters: any, params: any) =>
      ipcRenderer.invoke('scenario:card', { projectId, scenarioId, metricId, filters, params }),
    targets: (projectId: string, baseMetricIds: string[]) => ipcRenderer.invoke('scenario:targets', { projectId, baseMetricIds }),
  });
}
