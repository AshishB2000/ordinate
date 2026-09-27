import { contextBridge, ipcRenderer } from 'electron';

// The hub's Assistant-plan bridge (src/ipc/plan.ts), exposed as `window.hubPlan`.
// A session preload (see src/windows/hubWindow.ts), so it checks where it is:
// the overlay and the offscreen export windows share the session and get
// nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubPlan', {
    check: (projectId: string, steps: any) => ipcRenderer.invoke('plan:check', { projectId, steps }),
    start: (projectId: string, threadId: string, intent: string, steps: any) =>
      ipcRenderer.invoke('plan:start', { projectId, threadId, intent, steps }),
    next: (runId: string) => ipcRenderer.invoke('plan:next', { runId }),
    skip: (runId: string, index: number) => ipcRenderer.invoke('plan:skip', { runId, index }),
    replace: (runId: string, index: number, step: any) => ipcRenderer.invoke('plan:replace', { runId, index, step }),
    fix: (runId: string, index: number) => ipcRenderer.invoke('plan:fix', { runId, index }),
    stop: (runId: string) => ipcRenderer.invoke('plan:stop', { runId }),
    undo: (runId: string) => ipcRenderer.invoke('plan:undo', { runId }),
  });
}
