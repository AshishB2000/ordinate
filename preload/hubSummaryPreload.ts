import { contextBridge, ipcRenderer } from 'electron';

// The hub's Summary-card bridge, exposed as `window.hubSummary` (src/ipc/summary.ts).
// A session preload (see src/windows/hubWindow.ts), so it checks where it is:
// the overlay and the offscreen export windows share the session and get
// nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubSummary', {
    compute: (req: any) => ipcRenderer.invoke('summary:compute', req),
    rewrite: (req: any) => ipcRenderer.invoke('summary:rewrite', req),
  });
}
