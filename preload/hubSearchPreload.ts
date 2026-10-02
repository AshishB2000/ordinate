import { contextBridge, ipcRenderer } from 'electron';

// The hub's search-inside-the-data bridge, exposed as `window.hubDataSearch`
// (src/ipc/dataSearch.ts). A session preload (see src/windows/hubWindow.ts), so
// it checks where it is: the overlay and the offscreen export windows share the
// session and get nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  contextBridge.exposeInMainWorld('hubDataSearch', {
    // '' projectId searches every project; dashboardId marks the hits that can filter it.
    query: (projectId: string, term: string, dashboardId?: string) =>
      ipcRenderer.invoke('dataSearch:query', { projectId, term, dashboardId }),
  });
}
