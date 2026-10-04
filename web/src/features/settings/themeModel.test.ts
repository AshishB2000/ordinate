// Differential: the browser's theme model against the one the server validates
// every save with (renderer/hub/themeModel.ts, as emitted by the root
// `npm run build:ts`) — the same token list, sanitizer, CSS and contrast rule,
// compared with Object.is over the built-ins and a deterministic fuzz.

import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_TOKENS, deriveAccent, deriveBase, deriveRamp, FONTS, isDark, sanitizeTokens, themeCssVars, themeWarnings, type Tokens } from './themeModel';
import { BUILTINS } from './themeBuiltins';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the legacy UMD module has no types on this side
const legacy = require(path.join(ROOT, 'renderer', 'hub', 'themeModel.js')) as any;

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
