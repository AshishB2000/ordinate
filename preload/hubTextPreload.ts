import { contextBridge, ipcRenderer } from 'electron';

// The hub's text-analytics bridge, exposed as `window.hubText` (src/ipc/text.ts).
// A session preload (see src/windows/hubWindow.ts), so it checks where it is:
// the overlay and the offscreen export windows share the session and get nothing.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubText', {
    // A text column's profile over its first 5,000 filled values; `lang` overrides the detected language.
    profile: (projectId: string, datasetId: string, column: string, lang?: string) =>
      ipcRenderer.invoke('text:profile', { projectId, datasetId, column, lang }),
    // What an unsaved text step would do to its real input.
    preview: (projectId: string, datasetId: string, index: number, step: any) =>
      ipcRenderer.invoke('text:preview', { projectId, datasetId, index, step }),
    // Add (index -1) or replace a text step — a job on a big table. Replies like dataset:addStep.
    commitStep: (projectId: string, datasetId: string, index: number, step: any) =>
      ipcRenderer.invoke('text:commitStep', { projectId, datasetId, index, step }),
  });
}
