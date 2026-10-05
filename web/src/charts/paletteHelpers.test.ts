// The colour helpers behind Customize (./palette.ts) and the element-scoped
// colour rule. Ported at the T8.1 cutover from scripts/test-palette.ts, which
// ran these same checks against a hand-kept MIRROR of the desktop's hub.js
// helpers; here they run against the real functions the chart engine calls.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isDarkHex } from './maps/colors';
import { getCSSVar, hexToHsl, hslToHex, interpolatePalette, paletteFromSeed } from './palette';

const isHex = (c: string) => /^#[0-9a-f]{6}$/i.test(c);

describe('palette from one seed', () => {
  const SEED = '#4f7cd4';
  const pal = paletteFromSeed(SEED, 5);
  it('returns n valid, distinct colours, the seed first', () => {
    expect(pal).toHaveLength(5);
    expect(pal[0]).toBe(SEED);
    expect(pal.every(isHex)).toBe(true);
    expect(new Set(pal).size).toBe(5);
  });
  it('derived hues stay related to the seed (within ±130°)', () => {
    const baseH = hexToHsl(SEED)!.h;
    expect(pal.slice(1).every((c) => {
      let dh = Math.abs(hexToHsl(c)!.h - baseH) % 360;
      if (dh > 180) dh = 360 - dh;
      return dh <= 130;
    })).toBe(true);
  });
  it('hex → hsl → hex round-trips closely', () => {
    for (const hex of ['#e83859', '#22c55e', '#0ea5e9']) {
      const { h, s, l } = hexToHsl(hex)!;
      const back = hexToHsl(hslToHex(h, s, l))!;
      let dh = Math.abs(back.h - h) % 360;
      if (dh > 180) dh = 360 - dh;
      expect(dh < 2 && Math.abs(back.s - s) < 0.02 && Math.abs(back.l - l) < 0.02, hex).toBe(true);
    }
  });
  it('a bad hex degrades to a filled fallback', () => {
    expect(paletteFromSeed('nope', 3)).toHaveLength(3);
  });
});

describe('interpolatePalette — distinct per-category colours', () => {
  const BASE = ['#2563eb', '#0e7490', '#14b8a6', '#6366f1', '#64748b'];
  it('n <= base gives the first n base colours', () => {
    expect(interpolatePalette(BASE, 3)).toEqual(BASE.slice(0, 3));
    expect(interpolatePalette(BASE, 1)).toEqual(['#2563eb']);
  });
  it('n > base gives exactly n valid, distinct colours anchored on the base', () => {
    const ten = interpolatePalette(BASE, 10);
    expect(ten).toHaveLength(10);
    expect(ten.every(isHex)).toBe(true);
    expect(new Set(ten).size).toBe(10);
    expect([ten[0], ten[9]]).toEqual([BASE[0], BASE[BASE.length - 1]]);
  });
});

// The failure this exists to catch: dashboard style presets remap the theme
// tokens on a CONTAINER, so a chart MUST resolve its colours from its own
// element, not from :root — otherwise a dark-styled dashboard paints light
// charts, and live preset thumbnails side by side are impossible.
describe('getCSSVar element scoping', () => {
  it('an element resolves against that element; none or null against the root, trimmed', () => {
    let readFrom = '';
    const panel = document.createElement('div');
    vi.stubGlobal('getComputedStyle', (el: Element) => ({ getPropertyValue: () => { readFrom = el === panel ? 'panel' : el === document.documentElement ? 'root' : 'other'; return '  #123456  '; } }));
    try {
      const scoped = getCSSVar('--chart-1', panel);
      expect(readFrom).toBe('panel');
      expect(scoped).toBe('#123456');
      expect(getCSSVar('--chart-1')).toBe(scoped);
      expect(readFrom).toBe('root');
      expect(getCSSVar('--chart-1', null)).toBe(scoped);
      expect(readFrom).toBe('root');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Every getCSSVar call in the chart engine must carry a second argument. A new
  // unscoped call is the exact regression that silently reintroduces root-wide colour.
  it('every getCSSVar call in the chart engine is element-scoped', () => {
    const dir = path.resolve(process.cwd(), 'src/charts');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== 'palette.ts') files.push(p);
      }
    };
    walk(dir);
    const calls = files.flatMap((f) => (readFileSync(f, 'utf8').match(/getCSSVar\([^)]*\)/g) ?? []).map((c) => `${path.basename(f)}: ${c}`));
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter((c) => !c.includes(','))).toEqual([]);
  });
});

describe('isDarkHex — the map asks its own surface, not the root theme', () => {
  it('reads light, dark, missing and non-hex surfaces', () => {
    expect(isDarkHex('#ffffff')).toBe(false);
    expect(isDarkHex('#232327')).toBe(true); // theme.css dark
    expect(isDarkHex('')).toBe(false);
    expect(isDarkHex('rgb(35, 35, 39)')).toBe(false);
  });
  // (useDocTheme.ts subscribes to the root theme only to know WHEN to redraw.)
  it('no dataset.theme branch where the map picks its colours (draw.ts, the mapRender port)', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/charts/maps/draw.ts'), 'utf8');
    expect(src.length).toBeGreaterThan(1000);
    expect(/documentElement\.dataset\.theme/.test(src)).toBe(false);
  });
});
