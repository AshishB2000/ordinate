import { contextBridge, ipcRenderer } from 'electron';

// The hub's privacy bridge — sensitivity proposals, the Share policy, and the
// policy applied to what leaves — exposed as `window.hubPrivacy`. A session
// preload (see src/windows/hubWindow.ts), so it checks where it is: the overlay
// and the offscreen export windows share the session and get nothing from here.
//
// Nothing on this surface can read the project's masking key: main applies it
// and hands back tokens (src/ipc/privacy.ts).
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubPrivacy', {
    overview: (projectId: string) => ipcRenderer.invoke('privacy:overview', { projectId }),
    setPolicy: (projectId: string, policy: Record<string, string>) =>
      ipcRenderer.invoke('privacy:setPolicy', { projectId, policy }),
    review: (projectId: string, datasetId: string) => ipcRenderer.invoke('privacy:review', { projectId, datasetId }),
    decide: (projectId: string, datasetId: string, column: string, level: string) =>
      ipcRenderer.invoke('privacy:decide', { projectId, datasetId, column, level }),
    scan: (projectId: string, datasetIds?: string[]) => ipcRenderer.invoke('privacy:scan', { projectId, datasetIds }),
    summary: (projectId: string, path: string, datasetIds?: string[] | null) =>
      ipcRenderer.invoke('privacy:summary', { projectId, path, datasetIds }),
    // `visual:data` for an answer that is about to LEAVE the app: main applies
    // the Share policy for `share` ('export' | 'report' | 'publish') to the reply.
    visualData: (projectId: string, datasetId: string, encoding: unknown, filters: unknown, params: unknown, share: string, analytics?: unknown) =>
      ipcRenderer.invoke('visual:data', { projectId, datasetId, encoding, filters, params, share, analytics }),
    shareReply: (projectId: string, datasetId: string, encoding: unknown, reply: unknown, path: string) =>
      ipcRenderer.invoke('privacy:shareReply', { projectId, datasetId, encoding, reply, path }),
  });
}
