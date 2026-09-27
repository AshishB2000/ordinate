// Additive globals for the privacy scripts (privacyShare, privacySettings,
// privacyReview, prepareMask) — kept apart from the shared globals.d.ts, the
// same arrangement as globals.platform.d.ts, so concurrent branches do not
// collide on it. Classic-script functions need no declaration here; only the
// preload bridge does.

// preload/hubPrivacyPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubPrivacy: {
    overview(projectId: string): Promise<any>;
    setPolicy(projectId: string, policy: Record<string, string>): Promise<any>;
    review(projectId: string, datasetId: string): Promise<any>;
    decide(projectId: string, datasetId: string, column: string, level: string): Promise<any>;
    scan(projectId: string, datasetIds?: string[]): Promise<any>;
    summary(projectId: string, path: string, datasetIds?: string[] | null): Promise<any>;
    visualData(projectId: string, datasetId: string, encoding: any, filters: any, params: any, share: string, analytics?: any): Promise<any>;
    shareReply(projectId: string, datasetId: string, encoding: any, reply: any, path: string): Promise<any>;
  };
}
