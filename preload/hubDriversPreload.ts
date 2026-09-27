import { contextBridge, ipcRenderer } from 'electron';

// The hub's KEY DRIVERS bridge ("Why did this change?"), beside hubPreload.ts
// (at its 800-line cap) and the other area bridges. The SESSION runs it in every
// frame (windows/hubWindow.ts registers every hub<Area>Preload), so it checks it
// is in the hub before exposing anything — the overlay and the offscreen export
// windows share the session and get nothing.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubDrivers', {
    // The change between two periods, decomposed — every figure computed in main.
    explain: (projectId: string, request: any) => ipcRenderer.invoke('drivers:explain', { projectId, request }),
    // An alert event's change: the rule's latest two periods.
    explainAlert: (projectId: string, ruleId: string) => ipcRenderer.invoke('drivers:explainAlert', { projectId, ruleId }),
    // Save the question as a waterfall visual that recomputes on every render.
    addTile: (projectId: string, request: any, name: string) => ipcRenderer.invoke('drivers:addTile', { projectId, request, name }),
  });
}
