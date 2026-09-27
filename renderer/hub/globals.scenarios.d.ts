// Additive globals for the what-if scenario scripts — kept apart from the shared
// globals.d.ts, the same arrangement as globals.snapshots.d.ts, so concurrent
// branches do not collide on it. Classic-script functions need no declaration
// here; only the preload bridge does.

// preload/hubScenariosPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubScenarios: {
    list(projectId: string): Promise<any>;
    get(projectId: string, id: string): Promise<any>;
    create(projectId: string, input: any): Promise<any>;
    update(projectId: string, id: string, patch: any): Promise<any>;
    duplicate(projectId: string, id: string): Promise<any>;
    remove(projectId: string, id: string): Promise<any>;
    compute(projectId: string, id: string, draft?: any, focusMetricId?: string): Promise<any>;
    compare(projectId: string, ids: string[]): Promise<any>;
    card(projectId: string, scenarioId: string, metricId: string, filters: any, params: any): Promise<any>;
    targets(projectId: string, baseMetricIds: string[]): Promise<any>;
  };
}
