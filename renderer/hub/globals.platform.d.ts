// Additive globals for the platform-depth scripts (jobs, publish) — kept apart
// from the shared globals.d.ts, the same arrangement as globals.authoring.d.ts,
// so concurrent branches do not collide on it. Classic-script functions need
// no declaration here; only the preload bridge does.

// preload/hubPlatformPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubPlatform: {
    listJobs(): Promise<any>;
    cancelJob(id: string): Promise<any>;
    revealJob(id: string): Promise<any>;
    clearJobs(): Promise<any>;
    onJobsChanged(cb: (snap: any) => void): () => void;
    startRendererJob(kind: string, label: string, projectId?: string, silent?: boolean): Promise<any>;
    updateRendererJob(id: string, progress: number, note?: string): Promise<any>;
    finishRendererJob(id: string, outcome: { ok: boolean; error?: string; message?: string; path?: string }): Promise<any>;
    onRendererJobCancel(cb: (id: string) => void): () => void;
    previewVisualData(projectId: string, datasetId: string, encoding: any, filters?: any, params?: any, analytics?: any): Promise<any>;
    publishTargets(projectId: string): Promise<any>;
    publishConfig(projectId: string): Promise<any>;
    publishPickFolder(): Promise<any>;
    publishPlan(config: any): Promise<any>;
    publishRun(config: any): Promise<any>;
    publishRepublish(projectId: string, brands?: any): Promise<any>;
  };
}
