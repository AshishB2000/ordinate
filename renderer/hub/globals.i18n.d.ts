// Additive globals for interface languages (i18n.ts, settingsLanguage.ts) —
// kept apart from the shared globals.d.ts so concurrent branches do not
// collide on it. `t()` itself is a classic-script function in i18n.ts.

// preload/hubLanguagePreload.ts — mirrors the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubI18n: {
    boot: any;
    languages(): Promise<any[]>;
    setLanguage(code: string): Promise<any>;
  };
}
