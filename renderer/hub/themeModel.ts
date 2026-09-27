// Workspace THEMES — the pure model. No DOM, no IPC.
//
// A theme is a JSON record of TOKEN OVERRIDES: `{ id, name, tokens, updatedAt }`,
// where `tokens` maps a custom-property name to a validated value. Applied, it
// sets those properties on ONE dashboard sheet, over whatever the sheet's own
// preset classes (.dash-theme--* / .dash-density--* / .dash-accent--*) declare —
// inline properties beat class rules, so a theme wins without a cascade fight.
//
// Shared the cardModel way: main requires it (src/app/themeStore.ts validates
// every write with it, src/analysis/dashboardExport.ts whitelists an exported
// theme with it), the renderer loads it as a <script> that attaches `themeModel`
// to window, and scripts/test-themes.js requires it. One token list, one
// validator, one contrast rule, one resolution order — not three.
(function (global: any) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isId = (x: unknown): x is string => typeof x === 'string' && UUID_RE.test(x);

  // ── The token list ─────────────────────────────────────────────────────────
  //
  // AXIS_TOKENS is EXACTLY what hub.css's dashboard theme blocks and density
  // blocks declare. scripts/test-dashboardStyleCss.ts asserts the equality, so a
  // token added to a preset block without being added here (or the reverse)
  // fails CI instead of becoming a colour a theme silently cannot set.
  const AXIS_COLORS = [
    '--bg', '--surface', '--surface-2', '--surface-3', '--inset', '--surface-1', '--surface-float',
    '--border-hairline', '--focus-ring',
    '--text', '--text-strong', '--muted', '--text-dim', '--text-faint',
    '--border', '--border-2', '--border-3',
    '--accent', '--accent-2', '--accent-soft', '--accent-line', '--accent-ink',
    '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8',
    '--chart-accent',
    '--error', '--error-soft', '--ok', '--ok-soft', '--warn', '--warn-soft',
    '--titlebar',
  ];
  const AXIS_SHADOWS = ['--shadow-sm', '--shadow-md', '--shadow-lg'];
  const AXIS_TOKENS = AXIS_COLORS.concat(AXIS_SHADOWS, ['--font-numeric', '--dash-gap', '--dash-row']);

  // The editor's own tokens. No preset declares them: theme-editor.css gives
  // each a default and consumes it only under `.dash-themed`, so a sheet with no
  // theme renders byte-for-byte as it did before themes existed.
  const STYLE_TOKENS = [
    '--font-ui', '--dash-card-border-w', '--dash-card-radius', '--dash-card-shadow',
    '--dash-card-rule', '--dash-kpi-size', '--dash-kpi-label',
  ];
  const ALL_TOKENS = AXIS_TOKENS.concat(STYLE_TOKENS);

  // The four families a theme may name — as FULL stacks with system fallbacks.
  // The app ships no font files and fetches none: a family renders when it is
  // installed on the machine, and the stack's fallbacks otherwise.
  const SANS = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const FONTS: Record<string, { label: string; stack: string }> = {
    hanken: { label: 'Hanken Grotesk', stack: '"Hanken Grotesk", ' + SANS },
    inter: { label: 'Inter', stack: 'Inter, "Inter Variable", ' + SANS },
    plex: { label: 'IBM Plex Sans', stack: '"IBM Plex Sans", ' + SANS },
    'source-serif': { label: 'Source Serif', stack: '"Source Serif 4", "Source Serif Pro", ui-serif, Georgia, "Times New Roman", serif' },
  };
  const FONT_TOKENS = ['--font-ui', '--font-numeric'];

  /** Pixel tokens and their bounds. Out-of-range numbers are clamped, never echoed. */
  const PX: Record<string, [number, number]> = {
    '--dash-gap': [2, 32],
    '--dash-row': [24, 96],
    '--dash-card-radius': [0, 28],
    '--dash-card-border-w': [0, 3],
    '--dash-kpi-size': [14, 56],
  };

  /** Closed enums, and the CSS each value compiles to. */
  const ENUMS: Record<string, Record<string, string>> = {
    '--dash-card-shadow': { none: 'none', sm: 'var(--shadow-sm)', md: 'var(--shadow-md)', lg: 'var(--shadow-lg)' },
    '--dash-card-rule': { on: '1px', off: '0px' },
    '--dash-kpi-label': { below: '1', above: '-1' },
  };

  // ── Values ─────────────────────────────────────────────────────────────────

  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const RGBA_RE = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d{1,4})\s*\)$/i;

  /** `#rrggbb` (lower-cased) or `rgba(r, g, b, a)` in one canonical spelling; '' otherwise. */
  function color(v: unknown): string {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    if (HEX_RE.test(s)) return s.toLowerCase();
    const m = RGBA_RE.exec(s);
    if (!m || [m[1], m[2], m[3]].some((c) => Number(c) > 255)) return '';
    return `rgba(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])}, ${m[4]})`;
  }

  // One box-shadow: two to four lengths and a colour. Nothing else — no inset,
  // no second shadow, no var(): every character of it is interpolated into CSS.
  const LEN = '(?:0|-?\\d{1,3}(?:\\.\\d{1,2})?px)';
  const SHADOW_RE = new RegExp('^((?:' + LEN + ' ){2,4})(\\S.*)$');
  function shadow(v: unknown): string {
    if (typeof v !== 'string') return '';
    const s = v.trim().replace(/\s+/g, ' ');
    if (s === 'none') return s;
    const m = SHADOW_RE.exec(s);
    const c = m ? color(m[2]) : '';
    return m && c ? m[1] + c : '';
  }

  function px(v: unknown, [lo, hi]: [number, number]): number | null {
    const n = typeof v === 'number' ? v
      : typeof v === 'string' && /^\s*-?\d{1,4}(\.\d+)?(px)?\s*$/.test(v) ? parseFloat(v) : NaN;
    if (!Number.isFinite(n)) return null;
    return Math.round(Math.min(hi, Math.max(lo, n)) * 10) / 10;
  }

  /** One token's value, validated for its kind — or null, and the token is dropped. */
  function tokenValue(name: string, v: unknown): string | number | null {
    if (AXIS_COLORS.indexOf(name) >= 0) return color(v) || null;
    if (AXIS_SHADOWS.indexOf(name) >= 0) return shadow(v) || null;
    if (FONT_TOKENS.indexOf(name) >= 0) return typeof v === 'string' && FONTS[v] ? v : null;
    if (PX[name]) return px(v, PX[name]);
    if (ENUMS[name]) return typeof v === 'string' && ENUMS[name][v] ? v : null;
    return null;
  }

  /** Keep known tokens with valid values; drop everything else. Never throws. */
  function sanitizeTokens(raw: unknown): Record<string, string | number> {
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const out: Record<string, string | number> = {};
    for (const name of ALL_TOKENS) {
      if (!Object.prototype.hasOwnProperty.call(o, name)) continue;
      const v = tokenValue(name, o[name]);
      if (v !== null) out[name] = v;
    }
    return out;
  }

  const MAX_NAME = 60;

  /** A whole record. `id` is kept only when it is a UUID; the caller mints one otherwise. */
  function sanitizeTheme(raw: unknown): any {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
    return {
      id: isId(o.id) ? o.id.toLowerCase() : '',
      name: name || 'Untitled theme',
      tokens: sanitizeTokens(o.tokens),
      updatedAt: typeof o.updatedAt === 'string' && !isNaN(Date.parse(o.updatedAt)) ? o.updatedAt : '',
    };
  }

  /** `[property, css]` pairs for a sanitized token map — what an element or a stylesheet gets. */
  function themeCssVars(tokens: unknown): Array<[string, string]> {
    const t = sanitizeTokens(tokens);
    return Object.keys(t).map((name): [string, string] => {
      const v = t[name];
      if (FONT_TOKENS.indexOf(name) >= 0) return [name, FONTS[v as string].stack];
      if (PX[name]) return [name, v + 'px'];
      if (ENUMS[name]) return [name, ENUMS[name][v as string]];
      return [name, String(v)];
    });
  }

  // ── Contrast ───────────────────────────────────────────────────────────────

  function luminance(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /** WCAG contrast ratio of two #rrggbb colours, or null when either is not one. */
  function contrast(a: unknown, b: unknown): number | null {
    if (typeof a !== 'string' || typeof b !== 'string' || !HEX_RE.test(a) || !HEX_RE.test(b)) return null;
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // What is checked: every chart colour (and the accent) against the surface it
  // is drawn on at 3:1 — the WCAG floor for graphics — and body text against the
  // page at 4.5:1. Warnings only: a theme with warnings can still be saved.
  const CHECKS: Array<{ token: string; against: string; min: number; what: string }> =
    ['--accent', '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8']
      .map((token) => ({ token, against: '--surface', min: 3, what: 'on the surface' }))
      .concat([{ token: '--text', against: '--bg', min: 4.5, what: 'on the background' }]);

  function themeWarnings(tokens: unknown): Array<{ token: string; against: string; ratio: number; min: number; message: string }> {
    const t = sanitizeTokens(tokens);
    const out: Array<{ token: string; against: string; ratio: number; min: number; message: string }> = [];
    for (const c of CHECKS) {
      const r = contrast(t[c.token], t[c.against]);
      if (r === null || r >= c.min) continue;
      const ratio = Math.round(r * 10) / 10;
      out.push({ token: c.token, against: c.against, ratio, min: c.min,
        message: `${ratio}:1 ${c.what} — needs ${c.min}:1` });
    }
    return out;
  }

  /** True when a background reads as dark — decides the native controls' color-scheme. */
  function isDark(hex: unknown): boolean {
    return typeof hex === 'string' && HEX_RE.test(hex) && luminance(hex) < 0.2;
  }

  // ── Resolution ─────────────────────────────────────────────────────────────
  //
  // The dashboard's own theme, then the workspace default, then the built-in
  // preset (no tokens: the sheet's preset classes stand). A theme id that no
  // longer resolves — deleted, or from another workspace — falls through, it
  // never blanks the sheet. `'none'` is a dashboard saying "my preset only",
  // which is the one way to opt out of a workspace default.
  function resolveTheme(dashThemeId: unknown, workspaceId: unknown, themes: unknown): { theme: any; source: string } {
    const list = Array.isArray(themes) ? themes : [];
    const find = (id: unknown): any => (isId(id) ? list.find((t: any) => t && t.id === id.toLowerCase()) || null : null);
    if (dashThemeId === 'none') return { theme: null, source: 'builtin' };
    const d = find(dashThemeId);
    if (d) return { theme: d, source: 'dashboard' };
    const w = find(workspaceId);
    if (w) return { theme: w, source: 'workspace' };
    return { theme: null, source: 'builtin' };
  }

  /** What a dashboard style's `themeId` may hold: a theme's UUID or 'none'. */
  function sanitizeThemeId(v: unknown): string {
    return v === 'none' ? 'none' : isId(v) ? v.toLowerCase() : '';
  }

  const api = {
    AXIS_TOKENS, STYLE_TOKENS, ALL_TOKENS, FONTS, PX, ENUMS,
    color, shadow, sanitizeTokens, sanitizeTheme, themeCssVars,
    contrast, themeWarnings, isDark, resolveTheme, sanitizeThemeId, isId,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.themeModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
