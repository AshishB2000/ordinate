// Additive globals for multi-currency (round 10) — kept apart from the shared
// globals.d.ts so concurrent branches do not collide on it. Classic-script
// functions need no declaration here; only the preload bridge does.

// preload/hubFxPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubFx: {
    get(projectId: string): Promise<any>;
    set(projectId: string, patch: any): Promise<any>;
    column(projectId: string, datasetId: string, column: string, decl: any): Promise<any>;
    dashboard(projectId: string, dashboardId: string, code: string | null): Promise<any>;
    coverage(projectId: string, datasetId: string, column: string, currency?: string): Promise<any>;
    visualData(req: any): Promise<any>;
    metricValue(req: any): Promise<any>;
    computeMetric(req: any): Promise<any>;
  };
}
