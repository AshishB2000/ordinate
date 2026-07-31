import { contextBridge, ipcRenderer } from 'electron';

// Least-privilege bridge: status window only listens for its display text.
// NB: the namespace is 'screenchart', not 'status' — window.status is a reserved
// legacy DOM property that only holds strings, so a bridge object can't live there.
contextBridge.exposeInMainWorld('screenchart', {
  // ponytail: status payload is a small display envelope from main; renderer owns its shape.
  onState: (cb: (data: any) => void) => ipcRenderer.on('status:state', (_e, data) => cb(data)),
  openHub: () => ipcRenderer.send('hub:open'),
});
