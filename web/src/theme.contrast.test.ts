// The AA floor (docs/design-floor): every text token on every surface, and
// every Badge tone and grid type chip on its own fill, composited over every
// surface — in both themes, every dashboard style preset under each accent
// axis, the print box and the built-in themes a duplicate starts from.
//
//   --text, --text-strong, --muted, --text-dim   ≥ 4.5:1 on bg, surface, surface-2, surface-3, inset
//   --text-faint                                  ≥ 3:1 (disabled controls, decorative icons, dividers)
//   each chip's ink on its fill (11px words)      ≥ 4.5:1
//
// Every colour is READ from the stylesheets (theme.css, the presets, and the
// chip rules themselves); the ratio is themeModel's `contrast` (WCAG 2.x). A
// tint is composited over the surface first, as the browser paints it.
// `PRINT_CONTRAST=1` prints the table docs/design-floor/00-design.md carries.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast } from './features/settings/themeModel';
import { BUILTINS } from './features/settings/themeBuiltins';
import { deriveAccent, deriveBase, deriveRamp, themeStyleVars, type Tokens } from './features/settings/themeModel';
import { brandTokens } from './charts/palette';

type Decls = Record<string, string>;
type Row = { what: string; on: string; ratio: number; min: number };

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const THEME = read('./theme.css');
const STYLE = read('./features/dashboards/Style.module.css');
const PRINT = read('./features/reports/export/Print.module.css');
const BADGE = read('./ui/Badge.module.css');
const GRID = read('./ui/DataGrid/DataGrid.module.css');
const DATA = read('./features/data/Data.module.css');

/** The declarations of the rule whose selector is exactly `sel` (the last of a name wins). */
function block(css: string, sel: string): Decls {
  const m = new RegExp(`(^|[;}\\s])${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no ${sel} rule`);
  const out: Decls = {};
  for (const d of m[2].split(';')) {
    const kv = /^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

/** Split on the commas at depth 0: `a, var(--b, c)` → [a, var(--b, c)]. */
function args(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(at, i).trim());
      at = i + 1;
    }
  }
  return [...out, s.slice(at).trim()];
}

const rgb = (hex: string) => [16, 8, 0].map((s) => (parseInt(hex.slice(1), 16) >> s) & 255);
const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** color-mix(in srgb, a p, b): gamma-encoded sRGB, as the browser mixes. */
const mix = (a: string, b: string, p: number) => hex(rgb(a).map((c, i) => c * p + rgb(b)[i] * (1 - p)));

/**
 * What `expr` paints over `under` (an opaque hex), in the sheet `t`: a hex, an
 * rgba() tint, `var(--x[, fallback])` (an unset brand token is the app's own),
 * or `color-mix(in srgb, A p%, B)` with B a colour or `transparent`.
 */
function paint(expr: string, t: Decls, under: string, depth = 0): string {
  if (depth > 12) throw new Error(`${expr}: too deep`);
  const e = expr.trim();
  if (/^#[0-9a-f]{6}$/i.test(e)) return e.toLowerCase();
  let m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(e);
  if (m) return mix(hex([m[1], m[2], m[3]].map(Number)), under, Number(m[4]));
  m = /^var\(([\s\S]+)\)$/.exec(e);
  if (m) {
    const [name, fallback] = args(m[1]);
    const v = t[name] ?? fallback;
    if (v === undefined) throw new Error(`${name} is not defined`);
    return paint(v, t, under, depth + 1);
  }
  m = /^color-mix\(\s*in srgb\s*,([\s\S]+)\)$/.exec(e);
  if (m) {
    const [a, b] = args(m[1]);
    const am = /^([\s\S]+?)\s+([\d.]+)%$/.exec(a);
    if (!am) throw new Error(`cannot read ${a}`);
    const p = Number(am[2]) / 100;
    const ca = paint(am[1], t, under, depth + 1);
    return mix(ca, b === 'transparent' ? under : paint(b, t, under, depth + 1), p);
  }
  throw new Error(`cannot paint ${e}`);
}

const SURFACES = ['--bg', '--surface', '--surface-2', '--surface-3', '--inset'];
const TEXT: Array<[string, number]> = [['--text', 4.5], ['--text-strong', 4.5], ['--muted', 4.5], ['--text-dim', 4.5], ['--text-faint', 3]];
/** Every small word on a fill of its own: the rule's `color` on its `background`, read from its stylesheet. */
const CHIPS: Array<[string, Decls]> = [
  ...['neutral', 'accent', 'ok', 'warn', 'error'].map((tone): [string, Decls] => [`Badge ${tone}`, block(BADGE, `.${tone}`)]),
  ...['text', 'number', 'date'].map((type): [string, Decls] => [`Grid chip ${type}`, { ...block(GRID, '.type'), ...block(GRID, `.${type}`) }]),
  ['Data type chip', block(DATA, '.typeChip')],
];

/** Every pair a sheet must hold, measured. `chips: false` for a sheet that carries no chips of its own. */
export function audit(t: Decls, chips = true): Row[] {
  const rows: Row[] = [];
  for (const on of SURFACES) {
    const s = paint(`var(${on})`, t, '#ffffff');
    for (const [name, min] of TEXT) rows.push({ what: name, on, ratio: contrast(paint(`var(${name})`, t, s), s) as number, min });
    if (!chips) continue;
    for (const [what, rule] of CHIPS) {
      const fill = paint(rule.background, t, s);
      rows.push({ what, on, ratio: contrast(paint(rule.color, t, fill), fill) as number, min: 4.5 });
    }
  }
  return rows;
}

const fails = (rows: Row[]) => rows.filter((r) => !(r.ratio >= r.min)).map((r) => `${r.what} on ${r.on}: ${r.ratio.toFixed(2)} < ${r.min}`);

const LIGHT = block(THEME, ':root');
const DARK = { ...LIGHT, ...block(THEME, '[data-theme="dark"]') };
const axis = (name: string, dark: boolean): Decls => ({ ...block(STYLE, `.accent_${name}`), ...(dark ? block(STYLE, `.theme_dark.accent_${name}`) : {}) });

/** Every sheet a reader can be looking at, by name. */
const SHEETS: Record<string, { t: Decls; chips: boolean }> = {
  'app light': { t: LIGHT, chips: true },
  'app dark': { t: DARK, chips: true },
  // A light box inside a dark app (an export's render): the dark tokens it does not redefine show through.
  print: { t: { ...DARK, ...block(PRINT, '.light') }, chips: false },
};
for (const a of ['blue', 'teal', 'slate']) {
  for (const [app, t] of [['light', LIGHT], ['dark', DARK]] as const) {
    // `auto` declares no theme rule: the sheet follows the app, under the chosen accent axis.
    SHEETS[`auto · ${a} (${app} app)`] = { t: { ...t, ...axis(a, false) }, chips: true };
    for (const theme of ['clean', 'executive', 'dark']) {
      SHEETS[`${theme} · ${a} (${app} app)`] = { t: { ...t, ...block(STYLE, `.theme_${theme}`), ...axis(a, theme === 'dark') }, chips: true };
    }
  }
}
for (const b of BUILTINS) {
  // A duplicated built-in is a whole token map of its own (themeModel.ALL_TOKENS).
  const t: Decls = {};
  for (const [k, v] of Object.entries(b.tokens)) if (typeof v === 'string') t[k] = v;
  SHEETS[`built-in ${b.id}`] = { t, chips: true };
}

// A workspace theme is drawn on the dashboard sheet as custom properties (DashboardChrome useStyleVars),
// over whatever app it is in: a dark one in a light app must not inherit the light app's inks.
const themed = (tokens: Tokens): Decls => ({ ...LIGHT, ...Object.fromEntries(themeStyleVars(tokens)) });
const INK_TOKENS = ['--accent-text', '--ok-text', '--warn-text', '--error-text'];
const darkBuiltin = BUILTINS.find((b) => b.id === 'dark')!.tokens;
const savedBefore: Tokens = Object.fromEntries(Object.entries(darkBuiltin).filter(([k]) => !INK_TOKENS.includes(k)));
SHEETS['theme: built-in dark saved before the inks (light app)'] = { t: themed(savedBefore), chips: true };
const clean = BUILTINS.find((b) => b.id === 'clean')!.tokens;
SHEETS['theme: Light duplicated and made dark (light app)'] = {
  t: themed(deriveRamp(deriveAccent(deriveBase({ ...clean, '--bg': '#101114', '--surface': '#1c1c20', '--text': '#ececee', '--border': '#2e2e33' })))),
  chips: true,
};

// A workspace brand accent (brand.ts on :root) and a dashboard's own (useStyleVars on the sheet) set
// --brand-*; the app and the blue axis read them. A handful of seeds, the app's own blue first.
for (const seed of ['#2563eb', '#7c3aed', '#0d9488', '#e11d48', '#ca8a04', '#ffff00', '#1a1a1a']) {
  const b = brandTokens(seed)!;
  const brand = { ...b.light, ...b.dark };
  for (const [app, t] of [['light', LIGHT], ['dark', DARK]] as const) {
    SHEETS[`brand ${seed} (${app} app)`] = { t: { ...t, ...brand }, chips: true };
    SHEETS[`brand ${seed} · auto · blue (${app} app)`] = { t: { ...t, ...axis('blue', false), ...brand }, chips: true };
    for (const theme of ['clean', 'executive', 'dark']) {
      SHEETS[`brand ${seed} · ${theme} · blue (${app} app)`] = { t: { ...t, ...block(STYLE, `.theme_${theme}`), ...axis('blue', theme === 'dark'), ...brand }, chips: true };
    }
  }
}

/**
 * Below the floor before this branch, and not this branch's to fix (docs/design-floor, Follow-ups): an
 * `auto` sheet in a DARK app carries the LIGHT accent axis (DashboardChrome styleClass), so a brand's
 * light ramp is drawn on the app's dark surfaces. Exact, so the fix — or one more failure — shows here.
 */
const KNOWN: Record<string, string[]> = {
  'brand #0d9488 · auto · blue (dark app)': ['Grid chip date on --surface-3: 4.31 < 4.5'],
};

describe('the AA floor', () => {
  for (const [name, { t, chips }] of Object.entries(SHEETS)) {
    it(name, () => expect(fails(audit(t, chips))).toEqual(KNOWN[name] ?? []));
  }

  it('fails a planted pair (negative control)', () => {
    // The light theme's dim text as it shipped (2.71:1 on surface-3) …
    expect(fails(audit({ ...LIGHT, '--text-dim': '#8a909c' }))).toContain('--text-dim on --surface-3: 2.71 < 4.5');
    // … and the ok Badge inked in its fill colour, as it shipped: 3.35:1 on its 10% tint over white,
    // lower than the same ink on the bare surface — the tint is composited before it is measured.
    expect(fails(audit({ ...LIGHT, '--ok-text': 'var(--ok)' }))).toContain('Badge ok on --surface: 3.35 < 4.5');
    expect(contrast('#059669', '#ffffff')).toBeGreaterThan(3.35);
  });

  it('reads every colour from the stylesheets, and refuses one it cannot read', () => {
    expect(paint('var(--accent-text)', LIGHT, '#ffffff')).toBe('#1d4fd0');
    expect(paint('var(--accent-text)', DARK, '#1c1c20')).toBe('#7cb0ff');
    expect(paint('rgba(5, 150, 105, 0.1)', {}, '#ffffff')).toBe('#e6f5f0');
    expect(paint('color-mix(in srgb, #000000 50%, transparent)', {}, '#ffffff')).toBe('#808080');
    expect(() => paint('var(--nope)', {}, '#ffffff')).toThrow();
    expect(() => paint('hsl(0 0% 50%)', {}, '#ffffff')).toThrow();
  });
});

// The tables in docs/design-floor/00-design.md, from this file's own numbers.
if (process.env.PRINT_CONTRAST) {
  const cols = SURFACES.map((s) => s.slice(2));
  for (const name of ['app light', 'app dark', 'clean · blue (light app)', 'executive · blue (light app)', 'dark · blue (light app)']) {
    const rows = audit(SHEETS[name].t, SHEETS[name].chips);
    console.log(`\n**${name}**\n\n| | ${cols.join(' | ')} | floor |\n|---|${cols.map(() => '---:').join('|')}|---:|`);
    for (const w of new Set(rows.map((r) => r.what))) {
      const of = rows.filter((r) => r.what === w);
      console.log(`| ${w} | ${of.map((r) => r.ratio.toFixed(2)).join(' | ')} | ${of[0].min} |`);
    }
  }
  const worst = new Map<string, Row & { sheet: string }>();
  for (const [sheet, { t, chips }] of Object.entries(SHEETS)) {
    for (const r of audit(t, chips)) if (!worst.has(r.what) || r.ratio < worst.get(r.what)!.ratio) worst.set(r.what, { ...r, sheet });
  }
  console.log(`\n**The lowest of each over all ${Object.keys(SHEETS).length} sheets**\n\n| | lowest | where | floor |\n|---|---:|---|---:|`);
  for (const [w, r] of worst) console.log(`| ${w} | ${r.ratio.toFixed(2)} | ${r.sheet}, ${r.on.slice(2)} | ${r.min} |`);
}
