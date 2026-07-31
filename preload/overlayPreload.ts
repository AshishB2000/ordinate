import { contextBridge, ipcRenderer } from 'electron';

// Overlay bridge: receive the frozen frame, send back either a committed
// selection rect (CSS px) or a cancel.
contextBridge.exposeInMainWorld('overlay', {
  // ponytail: frame payload is an opaque envelope from main; renderer owns its shape.
  onFrame: (cb: (data: any) => void) => ipcRenderer.on('overlay:frame', (_e, data) => cb(data)),
  commit: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('capture:commit', rect),
  cancel: () => ipcRenderer.send('capture:cancel'),
});
