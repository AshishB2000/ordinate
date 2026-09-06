// Chart color — the base palette, the theme-token reader, and the pure functions
// that derive a full palette from one chosen swatch.
//
// Every function here is pure and has ZERO Chart.js coupling: hex in, hex out.
// That is what makes them worth their own file rather than lines inside the
// renderer — they are testable and readable without a canvas, a dataset or a
// chart type anywhere in scope.
//
// getCSSVar is the one impure member: it reads a CSS custom property off an
// element's computed style, which is how every chart picks up the active theme
// (--chart-1..5, --muted, --border, --surface, --text-strong, --font-ui) instead
// of hardcoding colors. It lives here because the palette IS what it is read
// for, and mapRender.js resolves it at call time too.
//
// Loads before chartRender.js / chartTable.js, both of which read CHART_PALETTE
// and these helpers. Classic global-scope script — NO import/export.

// Fallback series colors, used when a theme token is missing and as the fixed
// swatch order in the data table.
const CHART_PALETTE = ['#2563eb', '#0e7490', '#14b8a6', '#6366f1', '#64748b'];

// `el` exists because a dashboard style preset (`.dash-theme--dark` and friends)
// REMAPS these very tokens on a CONTAINER element, not on :root. Resolving from
// the root would paint light-theme charts inside dark-styled dashboard chrome —
// and it makes the four side-by-side preset thumbnails (the same grid rendered
// under four presets, live, on screen at once) outright impossible, since every
// chart would read one shared set of colours. Callers pass the element they draw
// into. OMITTING `el` IS BYTE-IDENTICAL TO THE OLD ROOT READ, so every existing
// call site elsewhere in the app is unaffected.
function getCSSVar(name: string, el?: Element | null): string {
  return getComputedStyle(el || document.documentElement).getPropertyValue(name).trim();
}

// ── Color helpers (for deriving a full palette from one chosen swatch) ──────
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
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

function hslToHex(h: number, s: number, l: number): string {
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
function paletteFromSeed(hex: string, n: number): string[] {
  const base = hexToHsl(hex);
  if (!base) return Array.from({ length: n }, () => hex);
  const seed = '#' + /^#?([0-9a-f]{6})$/i.exec(hex)[1].toLowerCase();   // canonical seed
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
function interpolatePalette(base: string[], n: number): string[] {
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
