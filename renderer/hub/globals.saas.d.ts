// Additive globals for the SaaS-sources scripts — kept apart from the shared
// globals.d.ts, the same arrangement as globals.platform.d.ts, so concurrent
// branches do not collide on it. Classic-script functions (saas.ts's
// saasWatchRow) need no declaration here; only the preload bridge does.

// preload/hubSaasPreload.ts — mirrors the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubSaas: {
    setFolderWatch(projectId: string, connId: string, watch: boolean): Promise<any>;
  };
}
