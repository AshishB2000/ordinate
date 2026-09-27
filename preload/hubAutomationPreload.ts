import { contextBridge, ipcRenderer } from 'electron';

// The hub's automation bridge — Settings → Automation and the hidden report
// window — exposed as `window.hubAutomation`. A session preload, discovered by
// its file name (see src/windows/hubWindow.ts), so it checks where it is: the
// overlay and the offscreen export windows share the session and get nothing.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubAutomation', {
    status: () => ipcRenderer.invoke('automation:status'),
    set: (patch: { enabled?: boolean; http?: boolean; port?: number }) => ipcRenderer.invoke('automation:set', patch),
    takeToken: () => ipcRenderer.invoke('automation:takeToken'),
    regenerateToken: () => ipcRenderer.invoke('automation:regenerateToken'),
    // The hidden `?headless=report` window's answer (renderer/hub/automationReport.ts).
    reportDone: (outcome: { ok: boolean; base64?: string; ext?: string; error?: string; skippedMaps?: number }) =>
      ipcRenderer.invoke('automation:reportDone', outcome),
  });
}
