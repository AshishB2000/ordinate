// Additive globals for the data-snapshots scripts — kept apart from the shared
// globals.d.ts, the same arrangement as globals.platform.d.ts, so concurrent
// branches do not collide on it. Classic-script functions need no declaration
// here; only the preload bridge does.

// preload/hubSnapshotsPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubSnapshots: {
    list(projectId: string, datasetId: string): Promise<any>;
    setKeep(projectId: string, datasetId: string, keep: number): Promise<any>;
    diff(projectId: string, datasetId: string, stamp: string, key: string | null, limit?: number): Promise<any>;
    restore(projectId: string, datasetId: string, stamp: string): Promise<any>;
    stamps(projectId: string, datasetIds: string[], metricIds: string[]): Promise<any>;
    metricHistory(projectId: string, metricId: string): Promise<any>;
    visualData(projectId: string, datasetId: string, encoding: any, filters: any, params: any, asOf: string, analytics?: any): Promise<any>;
    metricValue(projectId: string, id: string, filters: any, params: any, asOf: string): Promise<any>;
    computeMetric(projectId: string, datasetId: string, column: string, aggregation: string, filters: any, params: any, asOf: string): Promise<any>;
    visualRows(projectId: string, datasetId: string, encoding: any, filters: any, mark: any, page: any, params: any, asOf: string): Promise<any>;
    exportVisualRows(projectId: string, datasetId: string, encoding: any, filters: any, mark: any, page: any, name: string, params: any, asOf: string): Promise<any>;
  };
}
