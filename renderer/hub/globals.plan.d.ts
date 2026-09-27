// Additive globals for the Assistant's plan mode (planCard.ts, planEdit.ts) —
// kept apart from the shared globals.d.ts so concurrent branches do not collide
// on it. Classic-script functions need no declaration here; only the preload
// bridge does.

// preload/hubPlanPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubPlan: {
    check(projectId: string, steps: any): Promise<any>;
    start(projectId: string, threadId: string, intent: string, steps: any): Promise<any>;
    next(runId: string): Promise<any>;
    skip(runId: string, index: number): Promise<any>;
    replace(runId: string, index: number, step: any): Promise<any>;
    fix(runId: string, index: number): Promise<any>;
    stop(runId: string): Promise<any>;
    undo(runId: string): Promise<any>;
  };
}
