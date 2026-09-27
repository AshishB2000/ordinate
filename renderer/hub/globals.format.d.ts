// Additive globals for the formatting-depth scripts (fmtColors, fmtApply, fmtSort,
// formatPanel, fmtColorsUi, fmtProfile) — kept apart from the shared
// globals.d.ts, the same arrangement as globals.platform.d.ts, so concurrent
// branches do not collide on it. Classic-script functions need no declaration
// here; only the preload bridge and the bound CommonJS module do.

// preload/hubFormatPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubFormat: {
    getColorMap(projectId: string): Promise<any>;
    assignColors(projectId: string, column: string, values: unknown[]): Promise<any>;
    setColor(projectId: string, column: string, value: string, token: string | null): Promise<any>;
    resetColors(projectId: string, column: string): Promise<any>;
    applyPalette(projectId: string, column: string, values: unknown[]): Promise<any>;
  };
}

// src/analysis/colorMap.ts, bound by fmtColors.ts as `OrdColorMap`. Typed here
// rather than imported: the renderer program cannot import a main-process
// module without re-emitting it (see formatBind.ts).
interface OrdColorMapApi {
  COLOR_TOKENS: readonly string[];
  MAX_COLOR_VALUES: number;
  isColorToken(v: unknown): boolean;
  slotIndex(token: string): number;
  colorKey(v: unknown): string | null;
  assignColors(current: Record<string, string> | null | undefined, values: readonly unknown[]):
    { colors: Record<string, string>; tokens: (string | null)[]; changed: boolean };
  applyPalette(values: readonly unknown[]): Record<string, string>;
  setColor(current: Record<string, string> | null | undefined, value: unknown, token: unknown): Record<string, string>;
  sanitizeColorMap(raw: unknown): Record<string, Record<string, string>>;
}
