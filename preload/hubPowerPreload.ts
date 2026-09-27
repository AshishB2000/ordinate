import { contextBridge, ipcRenderer } from 'electron';

// The hub's analysis-power bridge, a third preload beside hubPreload.ts and
// hubAuthoringPreload.ts (both at or near the 800-line cap). Same arrangement
// as the authoring one: the SESSION runs it in every frame (windows/hubWindow.ts
// registers it), so it checks it is in the hub before exposing anything — the
// overlay and the offscreen export windows share the session and get nothing.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubPower', {
    // ── table calculations ── (src/ipc/tableCalcKpi.ts)
    // A KPI card's figure as a table calculation over its period series.
    kpiCalc: (projectId: string, card: any, filters: any, calc: any, params?: any) =>
      ipcRenderer.invoke('tableCalc:kpi', { projectId, card, filters, calc, params }),
    // { ok, dateColumn } — whether the card's dataset has periods to calculate over.
    kpiCalcOptions: (projectId: string, card: any) => ipcRenderer.invoke('tableCalc:kpiOptions', { projectId, card }),

    // ── prepare steps ── (src/ipc/preparePower.ts)
    previewStep: (projectId: string, datasetId: string, index: number, step: any) =>
      ipcRenderer.invoke('prepare:stepPreview', { projectId, datasetId, index, step }),
    stepCounts: (projectId: string, datasetId: string) =>
      ipcRenderer.invoke('prepare:stepCounts', { projectId, datasetId }),

    // ── comments ── (src/ipc/comments.ts)
    listComments: (projectId: string) => ipcRenderer.invoke('comment:list', { projectId }),
    addComment: (projectId: string, target: any, body: string) => ipcRenderer.invoke('comment:add', { projectId, target, body }),
    replyComment: (projectId: string, id: string, body: string) => ipcRenderer.invoke('comment:reply', { projectId, id, body }),
    editComment: (projectId: string, id: string, body: string) => ipcRenderer.invoke('comment:edit', { projectId, id, body }),
    resolveComment: (projectId: string, id: string) => ipcRenderer.invoke('comment:resolve', { projectId, id }),
    reopenComment: (projectId: string, id: string) => ipcRenderer.invoke('comment:reopen', { projectId, id }),
    deleteComment: (projectId: string, id: string) => ipcRenderer.invoke('comment:delete', { projectId, id }),
    deleteCommentReply: (projectId: string, id: string, replyId: string) =>
      ipcRenderer.invoke('comment:deleteReply', { projectId, id, replyId }),
    onCommentsChanged: (cb: (o: { projectId: string }) => void) => ipcRenderer.on('comments:changed', (_e, o) => cb(o)),
    setDisplayName: (name: string) => ipcRenderer.invoke('profile:setDisplayName', name),

    // ── scorecards ── (src/ipc/scorecards.ts)
    scorecardList: (projectId: string) => ipcRenderer.invoke('scorecard:list', { projectId }),
    scorecardGet: (projectId: string, id: string) => ipcRenderer.invoke('scorecard:get', { projectId, id }),
    scorecardCreate: (projectId: string, input: any) => ipcRenderer.invoke('scorecard:create', { projectId, ...input }),
    scorecardUpdate: (projectId: string, id: string, patch: any) => ipcRenderer.invoke('scorecard:update', { projectId, id, patch }),
    scorecardDuplicate: (projectId: string, id: string) => ipcRenderer.invoke('scorecard:duplicate', { projectId, id }),
    scorecardDelete: (projectId: string, id: string) => ipcRenderer.invoke('scorecard:delete', { projectId, id }),
    // Every row's figures for the period `offset` steps back — all computed in main.
    scorecardCompute: (projectId: string, id: string, offset: number) => ipcRenderer.invoke('scorecard:compute', { projectId, id, offset }),
    scorecardDetail: (projectId: string, id: string, metricId: string, offset: number) =>
      ipcRenderer.invoke('scorecard:detail', { projectId, id, metricId, offset }),
    scorecardSnapshot: (projectId: string, id: string, offset?: number) => ipcRenderer.invoke('scorecard:snapshot', { projectId, id, offset }),
    scorecardCreateReport: (projectId: string, id: string) => ipcRenderer.invoke('scorecard:createReport', { projectId, id }),
  });
}
