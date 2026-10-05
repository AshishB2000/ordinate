// The brand accent ramp and the value palettes — contrast in both themes, and
// the same tokens the desktop computed.
//
// These checks ran against the desktop's chartPalette.js (scripts/test-branding.ts
// and test-chartFormat.ts) until the T8.1 cutover; they now run against this
// port. WCAG contrast is computed HERE, independently of the code under test.
// The desktop's answers over the same seeds are the golden fixture
// __golden__/palette.json, compared with Object.is at every leaf.

import { deepStrictEqual } from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { golden } from '../test-golden';
import { applyBrandTokens, BRAND_DARK_SURFACES, brandTokens, rampColor, valueRamp } from './palette';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { ACCENT_SWATCHES } = require(path.join(ROOT, 'src/app/branding.js')) as { ACCENT_SWATCHES: string[] };

type Tokens = { light: Record<string, string>; dark: Record<string, string> } | null;
const G = golden<{
  darkSurfaces: string[];
  brandTokens: Array<[string, Tokens]>;
  applied: Record<string, string>;
  ramps: Array<[string, string, string, string[]]>;
  colors: Array<[string, string[], number, number, number, string]>;
}>('src/charts/__golden__/palette.json');

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const HOSTILE = ['#ffff00', '#ffffff', '#000000', '#00ff00', '#808080', '#1a1a1a', '#ff00ff', '#7fffd4'];

describe('the desktop palette, recorded', () => {
  it('the dark surfaces', () => deepStrictEqual(BRAND_DARK_SURFACES, G.darkSurfaces));

  it('brandTokens: every seed gives the desktop tokens', () => {
    expect(G.brandTokens.length).toBeGreaterThan(16);
    for (const [seed, want] of G.brandTokens) deepStrictEqual(brandTokens(seed), want, seed);
  });

  it('valueRamp and rampColor: every kind, seed and surface', () => {
    for (const [kind, seed, surface, want] of G.ramps) deepStrictEqual(valueRamp(kind, seed, surface), want, `${kind} ${seed} ${surface}`);
    for (const [kind, ramp, v, min, max, want] of G.colors) expect(Object.is(rampColor(ramp, kind, v, min, max), want), `${kind} ${v}`).toBe(true);
  });

  it('applyBrandTokens sets the desktop properties, and clearing removes them', () => {
    const el = document.createElement('div');
    applyBrandTokens(el, '#7c3aed');
    const set = Object.fromEntries([...Array(el.style.length).keys()].map((i) => [el.style.item(i), el.style.getPropertyValue(el.style.item(i))]));
    deepStrictEqual(set, G.applied);
    expect(Object.keys(set).length).toBeGreaterThan(10);
    applyBrandTokens(el, '');
    expect(el.style.length).toBe(0);
  });

  it('a broken port would be caught (negative control)', () => {
    expect(() => deepStrictEqual(brandTokens('#2563eb'), G.brandTokens.find(([s]) => s === '#7c3aed')![1])).toThrow();
  });
});

describe('the accent ramp reads in light AND dark', () => {
  for (const seed of [...ACCENT_SWATCHES, ...HOSTILE]) {
    it(seed, () => {
      const t = brandTokens(seed)!;
      const L = t.light;
      const D = t.dark;
      const fails: string[] = [];
      if (contrast(L['--brand-accent']!, '#ffffff') < 4.5) fails.push('light accent vs white text');
      for (let i = 1; i <= 8; i += 1) if (contrast(L['--brand-chart-' + i]!, '#ffffff') < 3) fails.push('light chart-' + i);
      for (const s of BRAND_DARK_SURFACES) {
        if (contrast(D['--brand-dk-accent']!, s) < 4) fails.push('dark accent on ' + s);
        if (contrast(D['--brand-dk-accent-fg']!, s) < 4.5) fails.push('dark accent-as-text on ' + s);
        for (let i = 1; i <= 8; i += 1) if (contrast(D['--brand-dk-chart-' + i]!, s) < 3) fails.push('dark chart-' + i + ' on ' + s);
      }
      if (contrast(D['--brand-dk-accent']!, '#ffffff') < 3) fails.push('dark accent vs white text');
      expect(fails).toEqual([]);
    });
  }

  it('the app\'s own blue is left as it is in light (already passes)', () => {
    expect(brandTokens('#2563eb')!.light['--brand-accent']).toBe('#2563eb');
  });
  it('a seed too pale for white text is darkened, not rejected', () => {
    expect(brandTokens('#ffff00')!.light['--brand-accent']).not.toBe('#ffff00');
  });
  it('soft/line/focus are rgba() of the accent', () => {
    expect(brandTokens('#2563eb')!.light['--brand-accent-soft']).toMatch(/^rgba\(\d+, \d+, \d+, 0\.08\)$/);
  });
  it('a non-hex seed yields no tokens', () => {
    expect(brandTokens('red')).toBeNull();
    expect(brandTokens('#12345')).toBeNull();
  });
});

describe('value palettes: contrast in both themes', () => {
  for (const seed of [...ACCENT_SWATCHES, ...HOSTILE]) {
    it(`${seed}: sequential and diverging steps all read at 3:1`, () => {
      const fails: string[] = [];
      for (const kind of ['sequential', 'diverging']) {
        const light = valueRamp(kind, seed, '#ffffff');
        const dark = valueRamp(kind, seed, '#1c1c20');
        if (light.length !== 7 || dark.length !== 7) fails.push(kind + ' length');
        light.forEach((c, i) => { if (contrast(c, '#ffffff') < 3) fails.push(`light ${kind}[${i}] ${c}`); });
        dark.forEach((c, i) => BRAND_DARK_SURFACES.forEach((s) => { if (contrast(c, s) < 3) fails.push(`dark ${kind}[${i}] ${c} on ${s}`); }));
        if (new Set(light).size < 4) fails.push('light ' + kind + ' has too few distinct steps');
      }
      expect(fails).toEqual([]);
    });
  }

  it('a sequential ramp strengthens from the surface outward', () => {
    const seq = valueRamp('sequential', '#2563eb', '#ffffff');
    expect(seq.every((c, i) => i === 0 || contrast(c, '#ffffff') >= contrast(seq[i - 1]!, '#ffffff') - 1e-9)).toBe(true);
  });
  it('the diverging ramp maps below-zero, zero and above-zero to its ends and centre', () => {
    const div = valueRamp('diverging', '#2563eb', '#ffffff');
    expect([rampColor(div, 'diverging', -10, -10, 10), rampColor(div, 'diverging', 0, -10, 10), rampColor(div, 'diverging', 10, -10, 10)]).toEqual([div[0], div[3], div[6]]);
  });
  it('the sequential ramp maps min and max to its ends', () => {
    const seq = valueRamp('sequential', '#2563eb', '#ffffff');
    expect([rampColor(seq, 'sequential', 1, 1, 9), rampColor(seq, 'sequential', 9, 1, 9)]).toEqual([seq[0], seq[6]]);
  });
});
