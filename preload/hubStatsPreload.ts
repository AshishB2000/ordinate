import { contextBridge, ipcRenderer } from 'electron';

// The hub's statistics-workbench bridge, exposed as `window.hubStats`. A
// session preload (see src/windows/hubWindow.ts), so it checks where it is:
// the overlay and the offscreen export windows share the session and get
// nothing from here. Every figure comes back computed by main (src/ipc/stats.ts).
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubStats', {
    run: (projectId: string, spec: any) => ipcRenderer.invoke('stats:run', { projectId, spec }),
    pair: (projectId: string, spec: any, x: string, y: string) => ipcRenderer.invoke('stats:pair', { projectId, spec, x, y }),
    tile: (projectId: string, spec: any, filters: any, params: any, asOf: string | null, share?: 'export') =>
      ipcRenderer.invoke('stats:tile', { projectId, spec, filters, params, asOf, share }),
    saveFormula: (projectId: string, spec: any) => ipcRenderer.invoke('stats:saveFormula', { projectId, spec }),
  });
}
