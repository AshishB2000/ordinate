// Main's TYPED handle on the workspace theme model.
//
// The implementation is src/analysis/themeModel.ts — a pure UMD module (the
// cardModel/geoMatch arrangement) that the web Settings port is tested against —
// so the token list, the validator and the contrast rule the editor shows are
// the very ones that clamp what reaches disk and an exported file. This module
// only gives main the types; it adds no logic of its own.

export type TokenValue = string | number;
export type ThemeTokens = Record<string, TokenValue>;

export interface ThemeRecord {
  id: string;
  name: string;
  tokens: ThemeTokens;
  updatedAt: string;
}

export interface ThemeWarning {
  token: string;
  against: string;
  ratio: number;
  min: number;
  message: string;
}

interface ThemeModel {
  /** Exactly the tokens hub.css's dashboard theme + density blocks declare. */
  AXIS_TOKENS: string[];
  /** The editor's own tokens (theme-editor.css), consumed only on a themed sheet. */
  STYLE_TOKENS: string[];
  ALL_TOKENS: string[];
  FONTS: Record<string, { label: string; stack: string }>;
  sanitizeTokens(raw: unknown): ThemeTokens;
  /** null for a non-object; `id` is '' when the input's was not a UUID. */
  sanitizeTheme(raw: unknown): ThemeRecord | null;
  themeCssVars(tokens: unknown): Array<[string, string]>;
  contrast(a: unknown, b: unknown): number | null;
  themeWarnings(tokens: unknown): ThemeWarning[];
  isDark(hex: unknown): boolean;
  resolveTheme(dashThemeId: unknown, workspaceId: unknown, themes: unknown): { theme: ThemeRecord | null; source: string };
  sanitizeThemeId(v: unknown): string;
  isId(x: unknown): x is string;
}

export const themeModel = require('./themeModel') as ThemeModel;
