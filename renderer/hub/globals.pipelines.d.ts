// Additive globals for the Pipelines tab (pipelinesPage.ts / pipelinesGraph.ts /
// pipelinesDetail.ts) — kept apart from the shared globals.d.ts so concurrent
// branches do not collide on it. Classic-script functions need no declaration
// here; only the preload bridge does.

// preload/hubPipelinesPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubPipelines: {
    get(projectId: string): Promise<any>;
    run(projectId: string, nodeId?: string): Promise<any>;
    setSchedule(projectId: string, patch: { cron?: string | null; tz?: string; paused?: boolean }): Promise<any>;
    preview(cron: string, tz: string): Promise<any>;
    setPolicy(projectId: string, policy: { retries: number; backoffMs: number }): Promise<any>;
    setPaused(projectId: string, nodeId: string, paused: boolean): Promise<any>;
    setNodeSchedule(projectId: string, nodeId: string, patch: { every?: string; cadence?: string; at?: string }): Promise<any>;
    onChanged(cb: (o: { projectId: string; live: Record<string, string> }) => void): () => void;
  };
}
