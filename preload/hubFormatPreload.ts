import { contextBridge, ipcRenderer } from 'electron';

// The hub's formatting bridge — the project's category colour map (src/ipc/format.ts)
// — exposed as `window.hubFormat`. A session preload (see src/windows/hubWindow.ts),
// so it checks where it is: the overlay and the offscreen export windows share the
// session and get nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubFormat', {
    getColorMap: (projectId: string) => ipcRenderer.invoke('format:colors:get', { projectId }),
    assignColors: (projectId: string, column: string, values: unknown[]) =>
      ipcRenderer.invoke('format:colors:assign', { projectId, column, values }),
    setColor: (projectId: string, column: string, value: string, token: string | null) =>
      ipcRenderer.invoke('format:colors:set', { projectId, column, value, token }),
    resetColors: (projectId: string, column: string) =>
      ipcRenderer.invoke('format:colors:reset', { projectId, column }),
    applyPalette: (projectId: string, column: string, values: unknown[]) =>
      ipcRenderer.invoke('format:colors:palette', { projectId, column, values }),
  });
}
