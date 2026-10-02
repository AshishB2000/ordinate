// Additive globals for incremental refresh (round 10) — kept apart from the
// shared globals.d.ts so concurrent branches do not collide on it. Classic-script
// functions need no declaration here; only the preload bridge does.

// preload/hubIncrementalPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubIncremental: {
    get(projectId: string, datasetId: string): Promise<any>;
    set(projectId: string, datasetId: string, patch: any): Promise<any>;
    requestFull(projectId: string, datasetId: string): Promise<any>;
  };
}
