// Additive globals for the analysis-power scripts (same arrangement as
// globals.authoring.d.ts: kept apart from the shared globals.d.ts so concurrent
// branches do not collide on it). Function declarations need no entry — a
// classic script's functions are visible to the others through the shared
// program.

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
  };
}
