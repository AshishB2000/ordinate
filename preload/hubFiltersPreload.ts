import { contextBridge, ipcRenderer } from 'electron';

// The hub's typed-filters bridge, beside hubPreload.ts and its siblings. The
// SESSION runs it in every frame (windows/hubWindow.ts registers every
// preload/hub<Area>Preload.js), so it checks it is in the hub before exposing
// anything — the overlay and the offscreen export windows get nothing.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: the result is the JSON envelope src/ipc/filterParse.ts documents, typed loosely as window.hub is
  contextBridge.exposeInMainWorld('hubFilters', {
    // "west technology last quarter" on this dashboard → { ok, tokens, chips, groups, unknown, columns, examples }.
    // `pick` maps a phrase key to the suggestion id the user chose for it.
    parse: (projectId: string, dashboardId: string, text: string, pick?: Record<string, string>) =>
      ipcRenderer.invoke('filterParse:parse', { projectId, dashboardId, text, pick }),
  });
}
