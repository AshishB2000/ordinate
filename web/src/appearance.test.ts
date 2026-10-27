// appearance.css against what it claims to be (Settings → Appearance): each
// highlight is brandTokens(seed) — the workspace accent's own walk, over every
// canvas surface — minus the chart ramp, renamed --brand-* → --user-*; every
// id the settings offer has its rule and no rule is orphaned; every canvas
// sets the whole neutral ramp in both themes; theme-boot.js reads the same
// keys and lets every id through. The contrast floors are
// theme.contrast.test.ts's.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANVASES, HIGHLIGHTS } from './app/theme';
import { brandTokens } from './charts/palette';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const CSS = read('./appearance.css');
const BOOT = read('../public/theme-boot.js');

/** Every rule as [selector list, declarations]. */
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m): [string[], Record<string, string>] => [
  m[1].split(',').map((s) => s.trim()),
  Object.fromEntries([...m[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()])),
]);
const rule = (sel: string) => RULES.find(([sels]) => sels.includes(sel))?.[1];
const idsOf = (attr: string) => [...CSS.matchAll(new RegExp(`^\\[data-${attr}="(\\w+)"\\] \\{`, 'gm'))].map((m) => m[1]);

/** What a highlight's rule must say: brandTokens(seed) without the chart ramp, as --user-* tokens. */
function expected(seed: string): Record<string, string> {
  const t = brandTokens(seed)!;
  return Object.fromEntries(Object.entries({ ...t.light, ...t.dark }).filter(([k]) => !k.includes('-chart-')).map(([k, v]) => [k.replace('--brand-', '--user-'), v]));
}

const NEUTRALS = ['--chrome', '--bg', '--surface', '--surface-1', '--surface-2', '--surface-3', '--inset', '--surface-float', '--text', '--text-strong', '--muted', '--text-dim', '--text-faint', '--border', '--border-2', '--border-3', '--border-hairline'];

describe('appearance.css', () => {
  it('offers exactly the canvases and highlights Settings lists', () => {
    expect(idsOf('canvas')).toEqual(CANVASES.map((c) => c.id).filter((id) => id !== 'slate'));
    expect(idsOf('accent')).toEqual(HIGHLIGHTS.map((h) => h.id));
  });

  for (const h of HIGHLIGHTS) {
    if (!h.hex) continue;
    it(`highlight ${h.id} is brandTokens(${h.hex}) over every canvas`, () => expect(rule(`[data-accent="${h.id}"]`)).toEqual(expected(h.hex)));
  }

  it('Monochrome sets the ink as well, dark on its chalk in dark', () => {
    const mono = rule('[data-accent="mono"]')!;
    expect(Object.keys(mono).sort()).toEqual([...Object.keys(expected('#2563eb')), '--user-accent-ink', '--user-dk-accent-ink'].sort());
    expect(mono['--user-dk-accent-ink']).toBe('#171717');
  });

  for (const c of CANVASES) {
    if (c.id === 'slate') continue;
    it(`canvas ${c.id} sets the whole neutral ramp, in light and (on the page and on a chip) in dark`, () => {
      expect(Object.keys(rule(`[data-canvas="${c.id}"]`)!)).toEqual(NEUTRALS);
      expect(rule(`[data-theme="dark"][data-canvas="${c.id}"]`)).toBe(rule(`[data-theme="dark"] [data-canvas="${c.id}"]`));
      expect(Object.keys(rule(`[data-theme="dark"][data-canvas="${c.id}"]`)!)).toEqual(NEUTRALS);
    });
  }

  it('a drifted highlight is caught (negative control)', () => {
    expect({ ...rule('[data-accent="violet"]'), '--user-dk-accent-fg': '#ffffff' }).not.toEqual(expected('#7c3aed'));
    expect(rule('[data-accent="indigo"]')).not.toEqual(expected('#4f46e6'));
  });
});

describe('theme-boot.js', () => {
  it('reads the keys theme.ts writes, and its id rule lets every id through and nothing else', () => {
    expect(BOOT).toContain("localStorage.getItem('ordinate.canvas')");
    expect(BOOT).toContain("localStorage.getItem('ordinate.accent')");
    const src = /\/(\^\[a-z\]\{1,16\}\$)\/\.test\(canvas\)/.exec(BOOT)?.[1];
    expect(src).toBeTruthy();
    const ok = new RegExp(src!);
    for (const id of [...CANVASES, ...HIGHLIGHTS].map((x) => x.id)) expect(ok.test(id), id).toBe(true);
    for (const bad of ['', 'Stone', 'x"] body {', '../a', 'a'.repeat(17)]) expect(ok.test(bad), bad).toBe(false);
  });
});
