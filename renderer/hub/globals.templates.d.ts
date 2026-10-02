// Additive globals for the user-template scripts (userTemplateSave.ts,
// userTemplateGallery.ts) — kept apart from the shared globals.d.ts so
// concurrent branches do not collide on it. Classic-script functions need no
// declaration here; only the preload bridge does.

// preload/hubTemplatesPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubTemplates: {
    capture(projectId: string, analysisId: string): Promise<any>;
    save(payload: any): Promise<any>;
    rename(id: string, name: string): Promise<any>;
    remove(id: string): Promise<any>;
    exportFile(id: string): Promise<any>;
    importFile(): Promise<any>;
    preview(payload: any): Promise<any>;
    apply(payload: any): Promise<any>;
  };
}
