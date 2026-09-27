import { contextBridge, ipcRenderer } from 'electron';

// The hub's backups-and-sync bridge, exposed as `window.hubBackup`. A session
// preload (see src/windows/hubWindow.ts), so it checks where it is: the overlay
// and the offscreen export windows share the session and get nothing from here.
// No method takes a path — folders come from main's native pickers, and a
// backup or a conflict copy is named by the id main's own list handed out.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubBackup', {
    // Backups (src/ipc/backups.ts).
    settings: () => ipcRenderer.invoke('backups:settings'),
    set: (patch: { cadence?: string; keep?: number }) => ipcRenderer.invoke('backups:set', patch),
    chooseFolder: () => ipcRenderer.invoke('backups:chooseFolder'),
    useDefaultFolder: () => ipcRenderer.invoke('backups:useDefaultFolder'),
    revealFolder: () => ipcRenderer.invoke('backups:reveal'),
    backUpNow: () => ipcRenderer.invoke('backups:now'),
    list: () => ipcRenderer.invoke('backups:list'),
    restore: (id: string) => ipcRenderer.invoke('backups:restore', { id }),
    onChanged: (cb: (view: any) => void) => {
      const h = (_e: unknown, view: any) => cb(view);
      ipcRenderer.on('backups:changed', h);
      return () => ipcRenderer.removeListener('backups:changed', h);
    },
    // Sync folder and lock.json (src/ipc/syncFolder.ts).
    syncStatus: (id: string) => ipcRenderer.invoke('sync:status', { id }),
    syncTake: (id: string) => ipcRenderer.invoke('sync:take', { id }),
    syncConflicts: (id: string) => ipcRenderer.invoke('sync:conflicts', { id }),
    revealConflict: (id: string, rel: string) => ipcRenderer.invoke('sync:revealConflict', { id, rel }),
    revealSyncFolder: (id: string) => ipcRenderer.invoke('sync:revealFolder', { id }),
    moveToSyncFolder: (id: string) => ipcRenderer.invoke('sync:moveTo', { id }),
    openFromFolder: () => ipcRenderer.invoke('sync:openFrom'),
    moveBack: (id: string) => ipcRenderer.invoke('sync:moveBack', { id }),
    relaunch: () => ipcRenderer.invoke('sync:relaunch'),
    onLockLost: (cb: (info: any) => void) => {
      const h = (_e: unknown, info: any) => cb(info);
      ipcRenderer.on('sync:lockLost', h);
      return () => ipcRenderer.removeListener('sync:lockLost', h);
    },
  });
}
