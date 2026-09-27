// Additive globals for the analysis-power scripts (same arrangement as
// globals.authoring.d.ts: kept apart from the shared globals.d.ts so concurrent
// branches do not collide on it). A classic script's own top-level functions
// and lets are visible to the others through the shared program; what needs a
// line here is what the page GETS from outside it — the preload bridge.

// The analysis-power bridge (preload/hubPowerPreload.ts).
// ponytail: IPC envelopes typed loosely, as window.hub is
interface Window {
  hubPower: {
    // ── table calculations ──
    kpiCalc(projectId: string, card: any, filters: any, calc: any, params?: any): Promise<any>;
    kpiCalcOptions(projectId: string, card: any): Promise<any>;
    // ── prepare steps ── (results are the JSON envelopes src/ipc/preparePower.ts documents)
    previewStep(projectId: string, datasetId: string, index: number, step: any): Promise<any>;
    stepCounts(projectId: string, datasetId: string): Promise<any>;
    // ── comments ── (src/ipc/comments.ts)
    listComments(projectId: string): Promise<any>;
    addComment(projectId: string, target: any, body: string): Promise<any>;
    replyComment(projectId: string, id: string, body: string): Promise<any>;
    editComment(projectId: string, id: string, body: string): Promise<any>;
    resolveComment(projectId: string, id: string): Promise<any>;
    reopenComment(projectId: string, id: string): Promise<any>;
    deleteComment(projectId: string, id: string): Promise<any>;
    deleteCommentReply(projectId: string, id: string, replyId: string): Promise<any>;
    onCommentsChanged(cb: (o: { projectId: string }) => void): void;
    setDisplayName(name: string): Promise<any>;
  };
}
