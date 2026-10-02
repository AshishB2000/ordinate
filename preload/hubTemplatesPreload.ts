import { contextBridge, ipcRenderer } from 'electron';

// The hub's user-templates bridge, exposed as `window.hubTemplates`
// (src/ipc/userTemplates.ts). A session preload (see src/windows/hubWindow.ts),
// so it checks where it is: the overlay and the offscreen export windows share
// the session and get nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubTemplates', {
    capture: (projectId: string, analysisId: string) => ipcRenderer.invoke('utpl:capture', { projectId, analysisId }),
    save: (payload: any) => ipcRenderer.invoke('utpl:save', payload),
    rename: (id: string, name: string) => ipcRenderer.invoke('utpl:rename', { id, name }),
    remove: (id: string) => ipcRenderer.invoke('utpl:delete', { id }),
    exportFile: (id: string) => ipcRenderer.invoke('utpl:export', { id }),
    importFile: () => ipcRenderer.invoke('utpl:import'),
    preview: (payload: any) => ipcRenderer.invoke('utpl:preview', payload),
    apply: (payload: any) => ipcRenderer.invoke('utpl:apply', payload),
  });
}
