// Additive globals for saved views (round 10) — kept apart from the shared
// globals.d.ts so concurrent branches do not collide on it. Classic-script
// functions need no declaration here; only the preload bridge does.

// preload/hubViewsPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubViews: {
    edit(projectId: string, analysisId: string, op: any): Promise<any>;
    scope(projectId: string, analysisId: string, viewId: string): Promise<any>;
    parseLink(url: string): Promise<any>;
    openLink(url: string): Promise<boolean>;
    takeLink(): Promise<any>;
    onLink(cb: () => void): void;
  };
}
