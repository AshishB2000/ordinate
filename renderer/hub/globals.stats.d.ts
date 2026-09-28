// Additive globals for the statistics-workbench scripts — kept apart from the
// shared globals.d.ts (the globals.snapshots.d.ts arrangement), so concurrent
// branches do not collide on it. Classic-script functions need no declaration
// here; only the preload bridge does.

// preload/hubStatsPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubStats: {
    run(projectId: string, spec: any): Promise<any>;
    pair(projectId: string, spec: any, x: string, y: string): Promise<any>;
    tile(projectId: string, spec: any, filters: any, params: any, asOf: string | null, share?: 'export'): Promise<any>;
    saveFormula(projectId: string, spec: any): Promise<any>;
  };
}
