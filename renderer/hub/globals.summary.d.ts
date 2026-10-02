// Additive globals for the Summary card (round 8) — kept apart from the shared
// globals.d.ts so concurrent branches do not collide on it. Classic-script
// functions need no declaration here; only the preload bridge does.

// preload/hubSummaryPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubSummary: {
    compute(req: any): Promise<any>;
    rewrite(req: any): Promise<any>;
  };
}
