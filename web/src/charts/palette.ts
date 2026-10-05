// Chart colour (renderer/hub/chartPalette.ts) — the base palette, the
// theme-token reader, the pure functions that derive a palette from one swatch,
// the workspace accent's token set, and the value ramps. Hex in, hex out; only
// getCSSVar touches the DOM, which is how every chart picks up the active theme
// (--chart-1..8, --muted, --border, --surface, --text-strong, --font-ui).

export const CHART_PALETTE = ['#2563eb', '#0e7490', '#14b8a6', '#6366f1', '#64748b', '#b45309', '#be185d', '#4d7c0f'];

// `el` exists because a dashboard style preset (`.dash-theme--dark` and friends)
// REMAPS these very tokens on a CONTAINER element, not on :root. Resolving from
// the root would paint light-theme charts inside dark-styled dashboard chrome —
// and it makes the four side-by-side preset thumbnails (the same grid rendered
// under four presets, live, on screen at once) outright impossible, since every
// chart would read one shared set of colours. Callers pass the element they draw
// into. OMITTING `el` IS BYTE-IDENTICAL TO THE OLD ROOT READ, so every existing
// call site elsewhere in the app is unaffected.
export function getCSSVar(name: string, el?: Element | null): string {
  return getComputedStyle(el || document.documentElement).getPropertyValue(name).trim();
}

// ── Color helpers (for deriving a full palette from one chosen swatch) ──────
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

// A harmonious n-color palette seeded from one hex: index 0 is the exact seed,
// the rest rotate hue ±32°, ±64°, … around it (same S/L) so series stay distinct
// yet clearly related to the chosen color. Falls back to [seed] if hex is unparseable.
export function paletteFromSeed(hex: string, n: number): string[] {
  const base = hexToHsl(hex);
  if (!base) return Array.from({ length: n }, () => hex);
  const seed = '#' + /^#?([0-9a-f]{6})$/i.exec(hex)![1]!.toLowerCase();   // canonical seed
  const s = Math.max(0.35, Math.min(0.85, base.s));   // keep colors lively, not washed/neon
  const l = Math.max(0.42, Math.min(0.62, base.l));
  const offsets = [0, 32, -32, 64, -64, 96, -96, 128, -128];
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return seed;                          // series 1 = the exact chosen color
    return hslToHex(base.h + (offsets[i] || (i * 40)), s, l);
  });
}

// Expand a small base palette to n DISTINCT colors by interpolating through the
// base colors (a gradient walk). Keeps the app's restrained color family — no
// rainbow — while giving per-category charts (pie/donut/treemap/funnel) a unique
// color per slice, so the legend genuinely maps one color to one category.
export function interpolatePalette(base: string[], n: number): string[] {
  if (n <= base.length) return base.slice(0, n);
  const parse = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (base.length - 1);
    const lo = Math.floor(t), hi = Math.min(base.length - 1, lo + 1), f = t - lo;
    const [r1, g1, b1] = parse(base[lo]);
    const [r2, g2, b2] = parse(base[hi]);
    out.push('#' + hex(r1 + f * (r2 - r1)) + hex(g1 + f * (g2 - g1)) + hex(b1 + f * (b2 - b1)));
  }
  return out;
}

// ── The workspace ACCENT → every token it drives ────────────────────────────
//
// Settings → Appearance → Branding picks ONE colour. The app needs a dozen from
// it — the accent, its hover shade, two tints, the focus ring and an eight-colour
// chart ramp — in BOTH themes, and each has a contrast floor: white text on
// the accent (a primary button) at 4.5:1, and every chart colour at 3:1
// against the surface it is drawn on. So the pick is a SEED: its hue is kept,
// its lightness is walked until each floor holds. A pale yellow still produces
// a readable button; a near-black still produces a visible dark-mode line.
//
// Returned as CSS custom properties (`--brand-*` for light, `--brand-dk-*` for
// dark). theme.css and the dashboard "blue" accent READ those with the app's
// own blue as the fallback, so clearing the accent is removing the properties.

function brandLum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function brandContrast(a: string, b: string): number {
  const la = brandLum(a);
  const lb = brandLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Walk lightness (keeping hue and saturation) until `ok` holds, darker or lighter. */
function brandWalk(hex: string, dir: -1 | 1, ok: (h: string) => boolean): string {
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

function brandRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** The surfaces the ramp must read on — theme.css --surface in each theme, and the dark sheet. */
const BRAND_LIGHT_SURFACE = '#ffffff';
export const BRAND_DARK_SURFACES = ['#1c1c20', '#232327'];

/**
 * One accent → `{ light, dark }` token maps, every contrast floor met. Null
 * for anything that is not a #rrggbb.
 */
export function brandTokens(hex: string): { light: Record<string, string>; dark: Record<string, string> } | null {
  if (!/^#[0-9a-f]{6}$/i.test(String(hex))) return null;
  const seed = hex.toLowerCase();
  // Light: dark enough for white text on it.
  const accent = brandWalk(seed, -1, (h) => brandContrast(h, '#ffffff') >= 4.5);
  const accentHsl = hexToHsl(accent) as { h: number; s: number; l: number };
  const light: Record<string, string> = {
    '--brand-accent': accent,
    '--brand-accent-2': hslToHex(accentHsl.h, accentHsl.s, Math.max(0, accentHsl.l - 0.07)),
    '--brand-accent-soft': brandRgba(accent, 0.08),
    '--brand-accent-line': brandRgba(accent, 0.22),
    '--brand-focus': brandRgba(accent, 0.4),
  };
  paletteFromSeed(accent, CHART_PALETTE.length).forEach((c, i) => {
    light['--brand-chart-' + (i + 1)] = i === 0 ? accent : brandWalk(c, -1, (h) => brandContrast(h, BRAND_LIGHT_SURFACE) >= 3);
  });
  // Dark: light enough to read on the dark surfaces, still dark enough for
  // white button text at the large-text floor.
  const readsOnDark = (h: string): boolean => BRAND_DARK_SURFACES.every((s) => brandContrast(h, s) >= 4);
  let dk = brandWalk(seed, 1, readsOnDark);
  if (brandContrast(dk, '#ffffff') < 3) dk = brandWalk(dk, -1, (h) => brandContrast(h, '#ffffff') >= 3);
  const dkHsl = hexToHsl(dk) as { h: number; s: number; l: number };
  const dark: Record<string, string> = {
    '--brand-dk-accent': dk,
    '--brand-dk-accent-2': hslToHex(dkHsl.h, dkHsl.s, Math.max(0, dkHsl.l - 0.06)),
    '--brand-dk-accent-soft': brandRgba(dk, 0.16),
    '--brand-dk-accent-line': brandRgba(dk, 0.32),
    '--brand-dk-focus': brandRgba(dk, 0.4),
    // The accent as TEXT (a hovered name): AA on the raised surfaces, so lighter still.
    '--brand-dk-accent-fg': brandWalk(dk, 1, (h) => ['#1c1c20', '#232327', '#2a2a30'].every((s) => brandContrast(h, s) >= 4.5)),
  };
  paletteFromSeed(dk, CHART_PALETTE.length).forEach((c, i) => {
    dark['--brand-dk-chart-' + (i + 1)] = i === 0 ? dk
      : brandWalk(c, 1, (h) => BRAND_DARK_SURFACES.every((s) => brandContrast(h, s) >= 3));
  });
  return { light, dark };
}

/** Every property brandTokens can set — what clearing an accent removes. */
export function brandTokenNames(): string[] {
  const t = brandTokens('#2563eb') as { light: Record<string, string>; dark: Record<string, string> };
  return Object.keys(t.light).concat(Object.keys(t.dark));
}

/** Set (or, with no hex, clear) the brand tokens on an element — :root, or one dashboard sheet. */
export function applyBrandTokens(el: HTMLElement, hex: string): void {
  const t = hex ? brandTokens(hex) : null;
  brandTokenNames().forEach((n) => el.style.removeProperty(n));
  if (!t) return;
  Object.entries(t.light).forEach(([k, v]) => el.style.setProperty(k, v));
  Object.entries(t.dark).forEach(([k, v]) => el.style.setProperty(k, v));
}

// ── Value palettes: sequential and diverging, from the accent ────────────────
//
// A measure can be coloured BY ITS VALUE (Format → Colours): a sequential ramp
// for "more is darker", a diverging one for "above or below a midpoint". Both
// are derived from the accent the same way the chart ramp is — its hue kept,
// its lightness walked — and every step holds the chart-mark floor, 3:1
// against the surface it is drawn on, in whichever theme that surface is. So
// the palest step is the one nearest the surface that still reads, and the
// ramp runs from there to the strongest contrast; nothing fades into the page.

/** Is this surface a dark theme's? (Unknown or empty reads as light.) */
export function rampIsDark(surface: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(String(surface)) && brandLum(surface) < 0.2;
}

/** Does `hex` read as a chart mark on the light surface, or on BOTH dark ones? */
function rampReads(hex: string, dark: boolean): boolean {
  return dark
    ? BRAND_DARK_SURFACES.every((s) => brandContrast(hex, s) >= 3)
    : brandContrast(hex, BRAND_LIGHT_SURFACE) >= 3;
}

/**
 * `n` steps of one hue, nearest-the-surface first. Lightness is monotonic in
 * luminance at a fixed hue and saturation, so once the near end passes the
 * floor every step beyond it passes too.
 */
export function rampOfHue(hex: string, n: number, dark: boolean): string[] {
  const hsl = hexToHsl(hex);
  if (!hsl || n < 1) return Array.from({ length: Math.max(0, n) }, () => hex);
  const s = hsl.s < 0.05 ? 0 : Math.max(0.45, hsl.s);
  const near = brandWalk(hslToHex(hsl.h, s, dark ? 0.2 : 0.9), dark ? 1 : -1, (h) => rampReads(h, dark));
  const nearL = (hexToHsl(near) as { l: number }).l;
  const farL = dark ? Math.max(nearL, 0.88) : Math.min(nearL, 0.22);
  if (n === 1) return [near];
  return Array.from({ length: n }, (_, i) => (i === 0 ? near : hslToHex(hsl.h, s, nearL + (farL - nearL) * (i / (n - 1)))));
}

/**
 * The ramp a value palette draws with, for the surface it is drawn on.
 * sequential: `n` steps of the accent's hue, low → high.
 * diverging:  the accent's complement ← a neutral centre → the accent, `n` odd.
 */
export function valueRamp(kind: string, accent: string, surface: string, n = 7): string[] {
  const dark = rampIsDark(surface);
  const seed = /^#[0-9a-f]{6}$/i.test(String(accent)) ? accent.toLowerCase() : CHART_PALETTE[0];
  if (kind !== 'diverging') return rampOfHue(seed, n, dark);
  const half = Math.max(1, Math.floor(n / 2));
  const hsl = hexToHsl(seed) as { h: number; s: number; l: number };
  const pos = rampOfHue(seed, half + 1, dark);
  const neg = rampOfHue(hslToHex(hsl.h + 180, hsl.s, hsl.l), half + 1, dark);
  const mid = rampOfHue('#808080', 1, dark)[0];
  return neg.slice(1).reverse().concat([mid], pos.slice(1));
}

/**
 * Where `v` falls on a ramp over [min, max]. Diverging centres on zero when the
 * range crosses it, else on the middle of the range.
 */
export function rampColor(ramp: string[], kind: string, v: number, min: number, max: number): string {
  const n = ramp.length;
  if (!n) return '';
  const clamp = (i: number) => ramp[Math.max(0, Math.min(n - 1, i))];
  if (kind !== 'diverging') {
    const t = max > min ? (v - min) / (max - min) : 0.5;
    return clamp(Math.round(t * (n - 1)));
  }
  const half = Math.floor(n / 2);
  const c = min < 0 && max > 0 ? 0 : (min + max) / 2;
  if (v >= c) return clamp(half + Math.round((max > c ? (v - c) / (max - c) : 0) * half));
  return clamp(half - Math.round((c > min ? (c - v) / (c - min) : 0) * half));
}
