// Additive globals for the workspace-theme scripts (themeModel, themeApply,
// themeSettings, themeEditor) — kept apart from the shared globals.d.ts, the
// same arrangement as globals.platform.d.ts, so concurrent branches do not
// collide on it. Classic-script functions need no declaration here.

// renderer/hub/themeModel.ts attaches this to window (UMD, the cardModel pattern).
// ponytail: typed loosely across the classic-script boundary, as cardModel is.
declare const themeModel: any;

// preload/hubThemesPreload.ts — methods mirror the contextBridge surface 1:1.
interface Window {
  hubThemes: {
    list(): Promise<any>;
    save(theme: any): Promise<any>;
    remove(id: string): Promise<any>;
    setDefault(id: string): Promise<any>;
    onChanged(cb: (state: any) => void): () => void;
  };
}
