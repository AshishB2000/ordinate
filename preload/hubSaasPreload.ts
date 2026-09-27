import { contextBridge, ipcRenderer } from 'electron';

// The hub's SaaS-sources bridge, exposed as `window.hubSaas`: the workbench
// rail's "Watch this folder" toggle (src/ipc/saas.ts). The SaaS connectors
// themselves travel the existing connection:* channels on window.hub. A session
// preload (see src/windows/hubWindow.ts), so it checks where it is: the overlay
// and the offscreen export windows share the session and get nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubSaas', {
    setFolderWatch: (projectId: string, connId: string, watch: boolean) =>
      ipcRenderer.invoke('saas:setFolderWatch', { projectId, connId, watch }),
  });
}
