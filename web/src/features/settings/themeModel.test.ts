// Differential: the browser's theme model against the one the server validates
// every save with (src/analysis/themeModel.ts, as emitted by the root
// `npm run build:ts`) — the same token list, sanitizer, CSS and contrast rule,
// compared with Object.is over the built-ins and a deterministic fuzz.

import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_TOKENS, contrast, deriveAccent, deriveBase, deriveRamp, FONTS, isDark, sanitizeTokens, themeCssVars, themeStyleVars, themeWarnings, type Tokens } from './themeModel';
import { BUILTINS } from './themeBuiltins';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the legacy UMD module has no types on this side
const legacy = require(path.join(ROOT, 'src', 'analysis', 'themeModel.js')) as any;

/** A small deterministic PRNG, so a failure names a reproducible case. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const NASTY = ['url(javascript:alert(1))', 'red', '#12345', '#ABCDEF', 'rgba(1,2,3,0.5)', 'rgba(300,0,0,1)', '0 1px 2px #000000', '0 1px 2px rgba(0,0,0,0.2)', 'var(--x)', '12', '12px', '-4', 99, -3, 2.55, 'none', 'sm', 'on', 'off', 'above', 'inter', 'comic-sans', '', null, {}, []];

function fuzzTokens(r: () => number): Record<string, unknown> {
  const out: Record<string, unknown> = { '--evil': 'x', __proto__: 'y' };
  for (const name of ALL_TOKENS) {
    if (r() < 0.3) continue;
    const pick = r();
    out[name] = pick < 0.5 ? NASTY[Math.floor(r() * NASTY.length)] : '#' + Math.floor(r() * 0xffffff).toString(16).padStart(6, '0');
  }
  return out;
}

const same = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b));

describe('theme model — the browser copy agrees with the server’s', () => {
  it('the same token list and fonts', () => {
    expect(ALL_TOKENS).toEqual(legacy.ALL_TOKENS);
    expect(FONTS).toEqual(legacy.FONTS);
  });

  it('every built-in is a valid, complete token map, unchanged by either sanitizer', () => {
    for (const b of BUILTINS) {
      same(sanitizeTokens(b.tokens), b.tokens);
      same(legacy.sanitizeTokens(b.tokens), b.tokens);
      expect(Object.keys(b.tokens).sort()).toEqual([...ALL_TOKENS].sort());
    }
  });

  it('sanitizeTokens, themeCssVars, themeWarnings and isDark agree on 400 fuzzed maps and every derivation', () => {
    const r = rng(20261004);
    const cases: unknown[] = [...BUILTINS.map((b) => b.tokens), ...BUILTINS.map((b) => deriveRamp(deriveAccent(deriveBase(b.tokens))))];
    for (let i = 0; i < 400; i++) cases.push(fuzzTokens(r));
    let checked = 0;
    for (const raw of cases) {
      same(sanitizeTokens(raw), legacy.sanitizeTokens(raw));
      same(themeCssVars(raw), legacy.themeCssVars(raw));
      same(themeWarnings(raw), legacy.themeWarnings(raw));
      const bg = (raw as Tokens)['--bg'];
      expect(Object.is(isDark(bg), legacy.isDark(bg))).toBe(true);
      checked++;
    }
    expect(checked).toBe(410);
  });

  it('a derived theme stays valid: deriving never produces a value the server would drop', () => {
    for (const b of BUILTINS) {
      for (const accent of ['#2563eb', '#fde047', '#111111', '#ff00aa']) {
        const t = deriveRamp(deriveAccent(deriveBase({ ...b.tokens, '--accent': accent })));
        same(legacy.sanitizeTokens(t), t);
      }
    }
  });

  it('a dark base re-derives a dark family (no light --surface-2 inside a dark theme)', () => {
    const dark = deriveBase({ '--bg': '#101114', '--surface': '#1c1c20', '--text': '#ececee', '--border': '#2e2e33' });
    for (const k of ['--surface-2', '--surface-3', '--inset', '--titlebar']) expect(isDark(dark[k])).toBe(true);
  });
});

/** An ink measured as the browser paints it: on its rgba() fill composited over an opaque surface. */
function onFill(ink: unknown, fill: unknown, surface: string): number {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(String(fill));
  const u = [1, 3, 5].map((i) => parseInt(surface.slice(i, i + 2), 16));
  const bg = m ? '#' + [m[1], m[2], m[3]].map((c, i) => Math.round(Number(c) * Number(m[4]) + u[i] * (1 - Number(m[4]))).toString(16).padStart(2, '0')).join('') : surface;
  return contrast(ink, bg) as number;
}
const INKS: Array<[string, string]> = [['--accent-text', '--accent-soft'], ['--ok-text', '--ok-soft'], ['--warn-text', '--warn-soft'], ['--error-text', '--error-soft']];
const SURFACES = ['--bg', '--surface', '--surface-2', '--surface-3', '--inset'];
const light = BUILTINS.find((b) => b.id === 'clean')!.tokens;
const darkBuiltin = BUILTINS.find((b) => b.id === 'dark')!.tokens;

describe('a theme\'s tone inks read on its own sheet (docs/design-floor, review round)', () => {
  it('duplicating Light and making it dark re-derives every ink to 4.5:1 on its fill, over every surface', () => {
    const t = deriveBase({ ...light, '--bg': '#101114', '--surface': '#1c1c20', '--text': '#ececee', '--border': '#2e2e33' });
    for (const [ink, fill] of INKS) for (const sf of SURFACES) expect(onFill(t[ink], t[fill], t[sf] as string), `${ink} on ${sf}`).toBeGreaterThanOrEqual(4.5);
  });

  it('a new accent re-derives the accent ink from its own hue, and it reads on its tint', () => {
    for (const accent of ['#7c3aed', '#0d9488', '#fde047', '#111111']) {
      for (const base of [light, darkBuiltin]) {
        const t = deriveAccent({ ...base, '--accent': accent });
        for (const sf of SURFACES) expect(onFill(t['--accent-text'], t['--accent-soft'], t[sf] as string), `${accent} on ${sf}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('a theme saved before the inks gets them where it is drawn, for its own lightness — never the app\'s', () => {
    const saved: Tokens = { ...darkBuiltin };
    for (const [ink] of INKS) delete saved[ink];
    const vars = new Map(themeStyleVars(saved));
    for (const [ink, fill] of INKS) for (const sf of SURFACES) expect(onFill(vars.get(ink), vars.get(fill), vars.get(sf)!), `${ink} on ${sf}`).toBeGreaterThanOrEqual(4.5);
    // …and an ink the theme does carry is left as it is.
    expect(new Map(themeStyleVars(darkBuiltin)).get('--ok-text')).toBe(darkBuiltin['--ok-text']);
    expect(themeStyleVars(darkBuiltin).length).toBe(themeCssVars(darkBuiltin).length);
  });

  it('themeWarnings measures the inks: a light ink on a dark theme is not "contrast OK"', () => {
    const stale = { ...darkBuiltin, '--accent-text': '#1d4fd0', '--ok-text': '#065f46' };
    expect(themeWarnings(stale).map((w) => w.token).sort()).toEqual(['--accent-text', '--ok-text']);
    expect(themeWarnings(darkBuiltin).filter((w) => w.token.endsWith('-text'))).toEqual([]);
  });
});
