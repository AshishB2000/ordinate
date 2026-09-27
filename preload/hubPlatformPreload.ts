import { contextBridge, ipcRenderer } from 'electron';

// The hub's platform bridge — background jobs and publishing — exposed as
// `window.hubPlatform`. A session preload (see src/windows/hubWindow.ts), so it
// checks where it is: the overlay and the offscreen export windows share the
// session and get nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubPlatform', {
    // Jobs (src/ipc/jobs.ts).
    listJobs: () => ipcRenderer.invoke('jobs:list'),
    cancelJob: (id: string) => ipcRenderer.invoke('jobs:cancel', { id }),
    revealJob: (id: string) => ipcRenderer.invoke('jobs:reveal', { id }),
    clearJobs: () => ipcRenderer.invoke('jobs:clear'),
    onJobsChanged: (cb: (snap: any) => void) => {
      const h = (_e: unknown, snap: any) => cb(snap);
      ipcRenderer.on('jobs:changed', h);
      return () => ipcRenderer.removeListener('jobs:changed', h);
    },
    // A job whose work runs in THIS renderer (a report, a story PDF): main owns
    // the record, the renderer reports progress and the outcome.
    startRendererJob: (kind: string, label: string, projectId?: string, silent?: boolean) =>
      ipcRenderer.invoke('jobs:rendererStart', { kind, label, projectId, silent }),
    updateRendererJob: (id: string, progress: number, note?: string) =>
      ipcRenderer.invoke('jobs:rendererUpdate', { id, progress, note }),
    finishRendererJob: (id: string, outcome: { ok: boolean; error?: string; message?: string; path?: string }) =>
      ipcRenderer.invoke('jobs:rendererFinish', { id, ...outcome }),
    onRendererJobCancel: (cb: (id: string) => void) => {
      const h = (_e: unknown, id: string) => cb(id);
      ipcRenderer.on('jobs:rendererCancel', h);
      return () => ipcRenderer.removeListener('jobs:rendererCancel', h);
    },
    // The visual builder's preview: `visual:data`, sampled above 250k rows (src/ipc/vizSample.ts).
    previewVisualData: (projectId: string, datasetId: string, encoding: any, filters?: any, params?: any) =>
      ipcRenderer.invoke('visual:preview', { projectId, datasetId, encoding, filters, params }),
    // Publish to folder (src/ipc/publish.ts).
    publishTargets: (projectId: string) => ipcRenderer.invoke('publish:targets', { projectId }),
    publishConfig: (projectId: string) => ipcRenderer.invoke('publish:config', { projectId }),
    publishPickFolder: () => ipcRenderer.invoke('publish:pickFolder'),
    publishPlan: (config: any) => ipcRenderer.invoke('publish:plan', { config }),
    publishRun: (config: any) => ipcRenderer.invoke('publish:run', { config }),
    publishRepublish: (projectId: string, brands?: any) => ipcRenderer.invoke('publish:republish', { projectId, brands }),
  });
}
