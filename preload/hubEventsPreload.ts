import { contextBridge, ipcRenderer } from 'electron';

// The hub's Events bridge, exposed as `window.hubEvents` (src/ipc/events.ts).
// A session preload (see src/windows/hubWindow.ts), so it checks where it is:
// the overlay and the offscreen export windows share the session and get
// nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubEvents', {
    list: (projectId: string) => ipcRenderer.invoke('events:list', { projectId }),
    save: (projectId: string, event: any) => ipcRenderer.invoke('events:save', { projectId, event }),
    remove: (projectId: string, id: string) => ipcRenderer.invoke('events:delete', { projectId, id }),
    importCsv: (projectId: string, text: string) => ipcRenderer.invoke('events:importCsv', { projectId, text }),
    setCalendars: (projectId: string, calendars: string[]) => ipcRenderer.invoke('events:setCalendars', { projectId, calendars }),
  });
}
