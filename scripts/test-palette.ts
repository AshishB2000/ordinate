// Self-check for the Customize color helpers in renderer/hub/hub.js. hub.js isn't
// node-runnable (browser globals), so these mirror the pure helpers — keep in sync.

export {}; // module scope — sibling test scripts share top-level names

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
function paletteFromSeed(hex: string, n: number): string[] {
  const base = hexToHsl(hex);
  if (!base) return Array.from({ length: n }, () => hex);
  const seed = '#' + /^#?([0-9a-f]{6})$/i.exec(hex)![1].toLowerCase();
  const s = Math.max(0.35, Math.min(0.85, base.s));
  const l = Math.max(0.42, Math.min(0.62, base.l));
  const offsets = [0, 32, -32, 64, -64, 96, -96, 128, -128];
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return seed;
    return hslToHex(base.h + (offsets[i] || (i * 40)), s, l);
  });
}

let failures = 0;
function ok(label: string, cond: boolean) { if (cond) console.log('ok   ' + label); else { console.error('FAIL ' + label); failures++; } }
const isHex = (c: string) => /^#[0-9a-f]{6}$/i.test(c);

const SEED = '#4f7cd4';
const pal = paletteFromSeed(SEED, 5);
ok('returns n colors', pal.length === 5);
ok('index 0 is the exact seed', pal[0] === SEED);
ok('every entry is a valid #rrggbb', pal.every(isHex));
ok('all 5 colors are distinct', new Set(pal).size === 5);

// derived colors share the seed hue family (within ±130° of the seed hue)
const baseH = hexToHsl(SEED)!.h;
const within = pal.slice(1).every(c => {
  let dh = Math.abs(hexToHsl(c)!.h - baseH) % 360; if (dh > 180) dh = 360 - dh;
  return dh <= 130;
});
ok('derived hues stay related to the seed', within);

// hex→hsl→hex round-trips closely for a few colors
['#e83859', '#22c55e', '#0ea5e9'].forEach(hex => {
  const { h, s, l } = hexToHsl(hex)!;
  const back = hexToHsl(hslToHex(h, s, l))!;
  let dh = Math.abs(back.h - h) % 360; if (dh > 180) dh = 360 - dh;
  ok('round-trip ' + hex, dh < 2 && Math.abs(back.s - s) < 0.02 && Math.abs(back.l - l) < 0.02);
});

// bad input degrades gracefully
ok('bad hex → filled fallback', paletteFromSeed('nope', 3).length === 3);

// interpolatePalette — distinct per-category colors for pie/donut/treemap legends.
function interpolatePalette(base: string[], n: number): string[] {
  if (n <= base.length) return base.slice(0, n);
  const parse = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const hx = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (base.length - 1);
    const lo = Math.floor(t), hi = Math.min(base.length - 1, lo + 1), f = t - lo;
    const [r1, g1, b1] = parse(base[lo]);
    const [r2, g2, b2] = parse(base[hi]);
    out.push('#' + hx(r1 + f * (r2 - r1)) + hx(g1 + f * (g2 - g1)) + hx(b1 + f * (b2 - b1)));
  }
  return out;
}
const BASE = ['#2563eb', '#0e7490', '#14b8a6', '#6366f1', '#64748b'];
ok('n<=base → first n base colors', JSON.stringify(interpolatePalette(BASE, 3)) === JSON.stringify(BASE.slice(0, 3)));
const ten = interpolatePalette(BASE, 10);
ok('n>base → exactly n colors', ten.length === 10);
ok('n>base → all valid #rrggbb', ten.every(isHex));
ok('n>base → all distinct', new Set(ten).size === 10);
ok('endpoints anchor on the base palette', ten[0] === BASE[0] && ten[9] === BASE[BASE.length - 1]);
ok('single category → one color', JSON.stringify(interpolatePalette(BASE, 1)) === JSON.stringify(['#2563eb']));

if (failures) { console.error('\n' + failures + ' assertion(s) failed'); process.exit(1); }
console.log('\nAll palette checks passed.');
