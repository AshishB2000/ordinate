// Additive globals for the automation scripts (settingsAutomation.ts,
// automationReport.ts) — kept apart from the shared globals.d.ts, like
// globals.platform.d.ts, so concurrent branches do not collide on it.

// preload/hubAutomationPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubAutomation: {
    status(): Promise<any>;
    set(patch: { enabled?: boolean; http?: boolean; port?: number }): Promise<any>;
    takeToken(): Promise<{ token: string | null }>;
    regenerateToken(): Promise<any>;
    reportDone(outcome: { ok: boolean; base64?: string; ext?: string; error?: string; skippedMaps?: number }): Promise<any>;
  };
}
