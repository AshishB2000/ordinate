// Workspace dashboard THEMES in the browser — the presentation half of
// src/analysis/themeModel.ts (token list, fonts, CSS for a token map, the
// contrast warnings) plus themeEditor.ts's derivations (a base colour or the
// accent re-derives its family). The server validates every save with the
// original model (src/app/themeStore.ts); a differential test holds this copy
// to it (themeModel.test.ts).

import { brandContrast, hexToHsl, hslToHex, paletteFromSeed } from '../../charts/palette';

export type Tokens = Record<string, string | number>;

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
const STYLE_TOKENS = ['--font-ui', '--dash-card-border-w', '--dash-card-radius', '--dash-card-shadow', '--dash-card-rule', '--dash-kpi-size', '--dash-kpi-label'];
export const ALL_TOKENS = [...AXIS_COLORS, ...AXIS_SHADOWS, '--font-numeric', '--dash-gap', '--dash-row', ...STYLE_TOKENS];

const SANS = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
export const FONTS: Record<string, { label: string; stack: string }> = {
  hanken: { label: 'Hanken Grotesk', stack: '"Hanken Grotesk", ' + SANS },
  inter: { label: 'Inter', stack: 'Inter, "Inter Variable", ' + SANS },
  plex: { label: 'IBM Plex Sans', stack: '"IBM Plex Sans", ' + SANS },
  'source-serif': { label: 'Source Serif', stack: '"Source Serif 4", "Source Serif Pro", ui-serif, Georgia, "Times New Roman", serif' },
};
const FONT_TOKENS = ['--font-ui', '--font-numeric'];
const PX: Record<string, [number, number]> = {
  '--dash-gap': [2, 32],
  '--dash-row': [24, 96],
  '--dash-card-radius': [0, 28],
  '--dash-card-border-w': [0, 3],
  '--dash-kpi-size': [14, 56],
};
const ENUMS: Record<string, Record<string, string>> = {
  '--dash-card-shadow': { none: 'none', sm: 'var(--shadow-sm)', md: 'var(--shadow-md)', lg: 'var(--shadow-lg)' },
  '--dash-card-rule': { on: '1px', off: '0px' },
  '--dash-kpi-label': { below: '1', above: '-1' },
};

const HEX_RE = /^#[0-9a-f]{6}$/i;
const RGBA_RE = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d{1,4})\s*\)$/i;
const LEN = '(?:0|-?\\d{1,3}(?:\\.\\d{1,2})?px)';
const SHADOW_RE = new RegExp('^((?:' + LEN + ' ){2,4})(\\S.*)$');

function color(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (HEX_RE.test(t)) return t.toLowerCase();
  const m = RGBA_RE.exec(t);
  if (!m || [m[1], m[2], m[3]].some((c) => Number(c) > 255)) return '';
  return `rgba(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])}, ${m[4]})`;
}
function shadow(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim().replace(/\s+/g, ' ');
  if (t === 'none') return t;
  const m = SHADOW_RE.exec(t);
  const c = m ? color(m[2]) : '';
  return m && c ? m[1] + c : '';
}
function px(v: unknown, [lo, hi]: [number, number]): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d{1,4}(\.\d+)?(px)?\s*$/.test(v) ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(hi, Math.max(lo, n)) * 10) / 10;
}
function tokenValue(name: string, v: unknown): string | number | null {
  if (AXIS_COLORS.includes(name)) return color(v) || null;
  if (AXIS_SHADOWS.includes(name)) return shadow(v) || null;
  if (FONT_TOKENS.includes(name)) return typeof v === 'string' && FONTS[v] ? v : null;
  if (PX[name]) return px(v, PX[name]);
  if (ENUMS[name]) return typeof v === 'string' && ENUMS[name][v] ? v : null;
  return null;
}

/** Known tokens with valid values; everything else dropped. Never throws. */
export function sanitizeTokens(raw: unknown): Tokens {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Tokens = {};
  for (const name of ALL_TOKENS) {
    if (!Object.hasOwn(o, name)) continue;
    const v = tokenValue(name, o[name]);
    if (v !== null) out[name] = v;
  }
  return out;
}

/** `[property, css]` pairs — what a preview element gets (style.setProperty: CSP-fine). */
export function themeCssVars(tokens: unknown): Array<[string, string]> {
  const t = sanitizeTokens(tokens);
  return Object.keys(t).map((name): [string, string] => {
    const v = t[name];
    if (FONT_TOKENS.includes(name)) return [name, FONTS[v as string].stack];
    if (PX[name]) return [name, `${v}px`];
    if (ENUMS[name]) return [name, ENUMS[name][v as string]];
    return [name, String(v)];
  });
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: unknown, b: unknown): number | null {
  if (typeof a !== 'string' || typeof b !== 'string' || !HEX_RE.test(a) || !HEX_RE.test(b)) return null;
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Warning {
  token: string;
  against: string;
  ratio: number;
  min: number;
  message: string;
}

const CHECKS = ['--accent', '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8']
  .map((token) => ({ token, against: '--surface', min: 3, what: 'on the surface' }))
  .concat([{ token: '--text', against: '--bg', min: 4.5, what: 'on the background' }]);

/** Every chart colour and the accent at 3:1 on the surface, body text at 4.5:1 on the page. Advice, not a gate. */
export function themeWarnings(tokens: unknown): Warning[] {
  const t = sanitizeTokens(tokens);
  const out: Warning[] = [];
  for (const c of CHECKS) {
    const r = contrast(t[c.token], t[c.against]);
    if (r === null || r >= c.min) continue;
    const ratio = Math.round(r * 10) / 10;
    out.push({ token: c.token, against: c.against, ratio, min: c.min, message: `${ratio}:1 ${c.what} — needs ${c.min}:1` });
  }
  return out;
}

export function isDark(hex: unknown): boolean {
  return typeof hex === 'string' && HEX_RE.test(hex) && luminance(hex) < 0.2;
}

// ── The editor's derivations (themeEditor.ts) ───────────────────────────────

export function hexOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX_RE.test(v) ? v.toLowerCase() : fallback;
}

/** `a` moved toward `b` by `t` (0–1), per channel. */
export function mix(a: string, b: string, t: number): string {
  const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = ch(a);
  const y = ch(b);
  return '#' + x.map((c, i) => Math.round(c + (y[i] - c) * t).toString(16).padStart(2, '0')).join('');
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Walk lightness (hue and saturation kept) until `ok` holds — chartPalette's brandWalk. */
function walk(hex: string, dir: -1 | 1, ok: (h: string) => boolean): string {
  const hsl = hexToHsl(hex);
  if (!hsl) return hex;
  let l = hsl.l;
  let out = hex;
  for (let i = 0; i < 60 && !ok(out); i += 1) {
    l = Math.max(0, Math.min(1, l + dir * 0.02));
    out = hslToHex(hsl.h, hsl.s, l);
  }
  return out;
}

/**
 * Editing a base colour re-derives the fourteen a sheet reads from the four the
 * editor shows — else a light --surface-2 would sit inside a dark theme.
 */
export function deriveBase(t: Tokens): Tokens {
  const bg = hexOr(t['--bg'], '#f7f7f8');
  const surface = hexOr(t['--surface'], '#ffffff');
  const text = hexOr(t['--text'], '#18181b');
  const border = hexOr(t['--border'], '#e5e7eb');
  const dark = isDark(bg);
  return {
    ...t,
    '--surface-1': surface,
    '--surface-float': dark ? mix(surface, text, 0.04) : surface,
    '--surface-2': mix(surface, text, 0.04),
    '--surface-3': mix(surface, text, 0.08),
    '--inset': mix(bg, text, 0.03),
    '--titlebar': mix(bg, surface, 0.5),
    '--text-strong': mix(text, dark ? '#ffffff' : '#000000', 0.5),
    '--muted': mix(text, surface, 0.45),
    '--text-dim': mix(text, surface, 0.58),
    '--text-faint': mix(text, surface, 0.72),
    '--border-2': mix(border, text, 0.1),
    '--border-3': mix(border, text, 0.22),
    '--border-hairline': rgba(text, dark ? 0.1 : 0.08),
  };
}

export function deriveAccent(t: Tokens): Tokens {
  const accent = hexOr(t['--accent'], '#2563eb');
  const dark = isDark(hexOr(t['--surface'], '#ffffff'));
  const hsl = hexToHsl(accent);
  return {
    ...t,
    '--accent-2': hsl ? hslToHex(hsl.h, hsl.s, Math.max(0, hsl.l - 0.07)) : accent,
    '--accent-soft': rgba(accent, dark ? 0.16 : 0.08),
    '--accent-line': rgba(accent, dark ? 0.32 : 0.22),
    '--focus-ring': rgba(accent, 0.4),
    '--chart-accent': accent,
    '--accent-ink': brandContrast(accent, '#ffffff') >= 3 ? '#ffffff' : '#0f1117',
  };
}

/** The ramp from the accent: its hue family, each walked to 3:1 on THIS theme's surface. */
export function deriveRamp(t: Tokens): Tokens {
  const accent = hexOr(t['--accent'], '#2563eb');
  const surface = hexOr(t['--surface'], '#ffffff');
  const dir = isDark(surface) ? 1 : -1;
  const out: Tokens = { ...t };
  paletteFromSeed(accent, 8).forEach((c, i) => {
    out[`--chart-${i + 1}`] = i === 0 ? accent : walk(c, dir, (h) => brandContrast(h, surface) >= 3);
  });
  return out;
}

/** "Inter · Source Serif figures · contrast OK" — what a theme is, at a glance. */
export function summary(tokens: Tokens): string {
  const font = (k: string) => (FONTS[tokens[k] as string] ?? FONTS.hanken).label;
  const parts = [font('--font-ui')];
  if (tokens['--font-numeric'] && tokens['--font-numeric'] !== tokens['--font-ui']) parts.push(`${font('--font-numeric')} figures`);
  const n = themeWarnings(tokens).length;
  parts.push(n ? `${n} contrast warning${n === 1 ? '' : 's'}` : 'contrast OK');
  return parts.join(' · ');
}
