// Additive globals for the key-drivers scripts (same arrangement as
// globals.power.d.ts: kept apart from the shared globals.d.ts so concurrent
// branches do not collide on it). What needs a line here is what the page GETS
// from outside the scripts — the preload bridge.

// The key-drivers bridge (preload/hubDriversPreload.ts).
// ponytail: IPC envelopes typed loosely, as window.hub is
interface Window {
  hubDrivers: {
    explain(projectId: string, request: any): Promise<any>;
    explainAlert(projectId: string, ruleId: string): Promise<any>;
    addTile(projectId: string, request: any, name: string): Promise<any>;
  };
}
