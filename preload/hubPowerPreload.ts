import { contextBridge, ipcRenderer } from 'electron';

// The hub's analysis-power bridge, a third preload beside hubPreload.ts and
// hubAuthoringPreload.ts (both at or near the 800-line cap). Same arrangement
// as the authoring one: the SESSION runs it in every frame (windows/hubWindow.ts
// registers it), so it checks it is in the hub before exposing anything.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubPower', {
    // ── table calculations ── (src/ipc/tableCalcKpi.ts)
    // A KPI card's figure as a table calculation over its period series.
    kpiCalc: (projectId: string, card: any, filters: any, calc: any, params?: any) =>
      ipcRenderer.invoke('tableCalc:kpi', { projectId, card, filters, calc, params }),
    // { ok, dateColumn } — whether the card's dataset has periods to calculate over.
    kpiCalcOptions: (projectId: string, card: any) => ipcRenderer.invoke('tableCalc:kpiOptions', { projectId, card }),
  });
}
