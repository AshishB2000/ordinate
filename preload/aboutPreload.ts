import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('about', {
  openExternal: (url: string) => ipcRenderer.send('shell:open', url),
});
