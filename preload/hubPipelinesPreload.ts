import { contextBridge, ipcRenderer } from 'electron';

// The hub's pipelines bridge, exposed as `window.hubPipelines` (src/ipc/pipelines.ts).
// A session preload (see src/windows/hubWindow.ts), so it checks where it is:
// the overlay and the offscreen export windows share the session and get
// nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubPipelines', {
    get: (projectId: string) => ipcRenderer.invoke('pipelines:get', { projectId }),
    run: (projectId: string, nodeId?: string) => ipcRenderer.invoke('pipelines:run', { projectId, nodeId }),
    setSchedule: (projectId: string, patch: { cron?: string | null; tz?: string; paused?: boolean }) =>
      ipcRenderer.invoke('pipelines:setSchedule', { projectId, ...patch }),
    preview: (cron: string, tz: string) => ipcRenderer.invoke('pipelines:preview', { cron, tz }),
    setPolicy: (projectId: string, policy: { retries: number; backoffMs: number }) =>
      ipcRenderer.invoke('pipelines:setPolicy', { projectId, policy }),
    setPaused: (projectId: string, nodeId: string, paused: boolean) =>
      ipcRenderer.invoke('pipelines:setPaused', { projectId, nodeId, paused }),
    setNodeSchedule: (projectId: string, nodeId: string, patch: { every?: string; cadence?: string; at?: string }) =>
      ipcRenderer.invoke('pipelines:setNodeSchedule', { projectId, nodeId, ...patch }),
    onChanged: (cb: (o: { projectId: string; live: Record<string, string> }) => void) => {
      const h = (_e: unknown, o: any) => cb(o);
      ipcRenderer.on('pipelines:changed', h);
      return () => ipcRenderer.removeListener('pipelines:changed', h);
    },
  });
}
