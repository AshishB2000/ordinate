// Self-check for the DashboardStyle vocabulary in src/analysis/dashboards.ts —
// `sanitizeStyle`, `DEFAULT_DASHBOARD_STYLE` and the `DASHBOARD_STYLE_PRESETS`
// table. Pure logic, no Electron, no fs, no framework.
//
// Three properties are worth a suite of their own, because each one fails
// SILENTLY rather than loudly:
//
//   1. CLAMP, NEVER ECHO. Every axis is a closed enum, and the sanitized value
//      is interpolated straight into a CSS class name (`dash-theme--<x>`) and
//      into the exported stylesheet. A sanitizer that passed an unrecognized
//      string through would not throw — it would emit a class nothing styles,
//      or worse, attacker-chosen text into a <style> block. So the assertions
//      below hammer the near misses (wrong case, plausible misspellings,
//      `__proto__`, numbers, null, arrays), not just obvious garbage.
//   2. FRESH OBJECT PER CALL. `sanitizeStyle` fills defaults; handing back the
//      shared DEFAULT_DASHBOARD_STYLE would mean one caller's
//      `style.theme = 'dark'` restyling every record that had ever defaulted —
//      the classic shared-mutable-default bug, invisible until two dashboards
//      are open at once.
//   3. THE PRESET TABLE IS ITSELF VALID INPUT. A preset is a shortcut over the
//      same three axes, so `sanitizeStyle(preset)` must be the preset. If a
//      preset ever drifted off the enums (a renamed accent, say) it would be
//      silently clamped back to the default and the picker would offer four
//      buttons that all did the same thing.
//
//   npm run build:ts && node scripts/test-dashboardStyle.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled sibling of the real module (built by pretest).
const {
  sanitizeStyle,
  DEFAULT_DASHBOARD_STYLE,
  DASHBOARD_STYLE_PRESETS,
}: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');

// The allowed members of each axis, restated here ON PURPOSE. This file is the
// second opinion: if someone widens an enum in dashboards.ts without deciding
// to, the "rejects a value off the list" assertions below stop matching.
const THEMES = ['auto', 'clean', 'executive', 'dark'];
const DENSITIES = ['comfortable', 'compact'];
const ACCENTS = ['blue', 'teal', 'slate'];

// ── The default itself ─────────────────────────────────────────────────────────
// A dashboard nobody has restyled must FOLLOW THE APP. 'clean' was the default
// and it pins the light tokens on the sheet, which is why a dark app rendered
// white dashboards with near-white inherited text on them.
ok('the default theme is auto, so an untouched dashboard follows the app',
  DEFAULT_DASHBOARD_STYLE.theme === 'auto'
  && DEFAULT_DASHBOARD_STYLE.density === 'comfortable'
  && DEFAULT_DASHBOARD_STYLE.accent === 'blue',
  JSON.stringify(DEFAULT_DASHBOARD_STYLE));
ok('the default is itself a fixed point of sanitizeStyle',
  JSON.stringify(sanitizeStyle(DEFAULT_DASHBOARD_STYLE)) === JSON.stringify(DEFAULT_DASHBOARD_STYLE));

// ── The preset table ───────────────────────────────────────────────────────────
// Exactly four names, and exactly these four: the picker, the CSS and the
// renderer all key off this list, so an added/renamed preset must be a
// deliberate edit here too.
const presetNames = Object.keys(DASHBOARD_STYLE_PRESETS);
ok('there are exactly five presets', presetNames.length === 5, presetNames.join(','));
ok('the preset names are exactly auto/clean/executive/dense/dark',
  presetNames.slice().sort().join(',') === 'auto,clean,dark,dense,executive',
  presetNames.join(','));
// The two that must not drift: `auto` is the one that declares nothing, and
// `dense` is a DENSITY — it has no business pinning a light sheet, which it did.
ok('the auto preset is theme:auto and claims no look',
  DASHBOARD_STYLE_PRESETS.auto.theme === 'auto' && !DASHBOARD_STYLE_PRESETS.auto.chosen);
ok('the dense preset is compact and still follows the app',
  DASHBOARD_STYLE_PRESETS.dense.theme === 'auto'
  && DASHBOARD_STYLE_PRESETS.dense.density === 'compact');

for (const name of presetNames) {
  const preset = (DASHBOARD_STYLE_PRESETS as any)[name];
  const clean = sanitizeStyle(preset);
  ok(`preset "${name}" round-trips through sanitizeStyle unchanged`,
    JSON.stringify(clean) === JSON.stringify(preset),
    JSON.stringify({ preset, clean }));
  ok(`preset "${name}" sits on all three enums`,
    THEMES.includes(preset.theme) && DENSITIES.includes(preset.density) && ACCENTS.includes(preset.accent),
    JSON.stringify(preset));
  // Sanitizing must COPY, or storing a preset on a record would alias the
  // shared table and let one dashboard's edit rewrite the picker.
  ok(`preset "${name}" is copied, never aliased, by sanitizeStyle`, clean !== preset);
}

// Every preset is a distinct triple — otherwise two picker buttons look
// different and do the same thing. `auto` and `dense` share a theme and differ
// on density, which is the point of dense.
const presetTriples = presetNames.map((n) => JSON.stringify((DASHBOARD_STYLE_PRESETS as any)[n]));
ok('the five presets are five DIFFERENT triples',
  new Set(presetTriples).size === 5, presetTriples.join(' | '));

// ── Every axis clamps junk to ITS OWN default, and never echoes ────────────────
// A wrong-case or near-miss string is the realistic failure (hand-edited JSON,
// a renderer that title-cased a label), and it is exactly the one a loose
// `typeof === 'string'` check would let through.
const JUNK: [string, unknown][] = [
  ['wrong case', 'Dark'],
  ['shouty case', 'CLEAN'],
  ['near-miss spelling', 'darc'],
  ['trailing space', 'dark '],
  ['a PRESET name used as an axis value', 'dense'],
  ['__proto__', '__proto__'],
  ['constructor', 'constructor'],
  ['toString', 'toString'],
  ['a number', 1],
  ['a numeric string index', 0],
  ['null', null],
  ['undefined', undefined],
  ['true', true],
  ['an array', ['dark']],
  ['an object', { theme: 'dark' }],
  ['the empty string', ''],
];

for (const [label, value] of JUNK) {
  const t = sanitizeStyle({ theme: value, density: 'compact', accent: 'teal' });
  ok(`theme rejects ${label} → auto`, t.theme === 'auto', JSON.stringify(t));
  ok(`theme rejecting ${label} leaves the OTHER axes alone`,
    t.density === 'compact' && t.accent === 'teal', JSON.stringify(t));

  const d = sanitizeStyle({ theme: 'dark', density: value, accent: 'teal' });
  ok(`density rejects ${label} → comfortable`, d.density === 'comfortable', JSON.stringify(d));

  const a = sanitizeStyle({ theme: 'dark', density: 'compact', accent: value });
  ok(`accent rejects ${label} → blue`, a.accent === 'blue', JSON.stringify(a));
}

// The whole point of the clamp: whatever went in, what comes out is a member of
// the allowed set. One loop over every junk value, checked structurally.
let echoed = 0;
for (const [, value] of JUNK) {
  const s = sanitizeStyle({ theme: value, density: value, accent: value });
  if (!THEMES.includes(s.theme) || !DENSITIES.includes(s.density) || !ACCENTS.includes(s.accent)) echoed++;
}
ok('no junk value is ever echoed onto any axis', echoed === 0, echoed + ' leaked');

// ── Non-object input is the default, and never throws ──────────────────────────
const NON_OBJECTS: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'dark'],
  ['a number', 42],
  ['NaN', NaN],
  ['false', false],
  ['an empty array', []],
  ['an empty object', {}],
  ['a function', () => 'dark'],
];
for (const [label, value] of NON_OBJECTS) {
  let s: any = null;
  try {
    s = sanitizeStyle(value);
  } catch (e: any) {
    ok(`sanitizeStyle(${label}) does not throw`, false, e && e.message);
  }
  ok(`sanitizeStyle(${label}) yields the default`,
    !!s && JSON.stringify(s) === JSON.stringify(DEFAULT_DASHBOARD_STYLE), JSON.stringify(s));
}

// A partial object gets the missing axes defaulted — this is the path EVERY
// record written before the field existed takes on load (normalize()).
const partial = sanitizeStyle({ theme: 'dark' });
ok('a partial style defaults the axes it omits',
  partial.theme === 'dark' && partial.density === 'comfortable' && partial.accent === 'blue',
  JSON.stringify(partial));

// ── Fresh object per call ──────────────────────────────────────────────────────
const first = sanitizeStyle(null);
ok('the result is not the shared DEFAULT_DASHBOARD_STYLE object', first !== DEFAULT_DASHBOARD_STYLE);
(first as any).theme = 'dark';
(first as any).accent = 'slate';
const second = sanitizeStyle(null);
ok('mutating one result does not affect the next call',
  second.theme === 'auto' && second.accent === 'blue', JSON.stringify(second));
ok('mutating one result does not mutate DEFAULT_DASHBOARD_STYLE',
  DEFAULT_DASHBOARD_STYLE.theme === 'auto' && DEFAULT_DASHBOARD_STYLE.accent === 'blue',
  JSON.stringify(DEFAULT_DASHBOARD_STYLE));
ok('two calls return two distinct objects', sanitizeStyle(null) !== sanitizeStyle(null));

// ── Prototype pollution: a hostile key is data, not an assignment target ───────
// JSON.parse (not a literal) is the only way to get a real own "__proto__" key,
// which is how such a payload would actually arrive — off disk or over IPC.
const hostile = JSON.parse('{"__proto__":{"ordinatePolluted":true},"theme":"dark"}');
const polluted = sanitizeStyle(hostile);
ok('a __proto__ payload does not pollute Object.prototype',
  ({} as any).ordinatePolluted === undefined);
ok('a __proto__ payload still sanitizes normally', polluted.theme === 'dark', JSON.stringify(polluted));
ok('the sanitized style carries only the three known keys',
  Object.keys(polluted).slice().sort().join(',') === 'accent,density,theme',
  Object.keys(polluted).join(','));

// ── The 'clean' migration ──────────────────────────────────────────────────
// Almost every stored 'clean' was written by the old DEFAULT, not chosen — so
// reading it back as an override would keep every existing dashboard pinned
// light forever. A 'clean' the user actually picked carries `chosen` and keeps
// its override. No version bump: absence of the flag IS the signal.
{
  const defaulted = sanitizeStyle({ theme: 'clean', density: 'comfortable', accent: 'blue' });
  ok("a stored 'clean' with no chosen flag reads back as auto",
    defaulted.theme === 'auto', JSON.stringify(defaulted));

  const picked = sanitizeStyle({ theme: 'clean', density: 'comfortable', accent: 'blue', chosen: true });
  ok("…but a 'clean' the user picked stays clean",
    picked.theme === 'clean' && picked.chosen === true, JSON.stringify(picked));

  // The migration is for 'clean' alone: dark and executive were never a default,
  // so a stored one is always a choice, flag or no flag.
  for (const t of ['dark', 'executive'] as const) {
    ok(`a stored '${t}' is untouched by the migration`,
      sanitizeStyle({ theme: t, density: 'comfortable', accent: 'blue' }).theme === t);
  }
  ok('auto survives a round trip', sanitizeStyle({ theme: 'auto', density: 'comfortable', accent: 'blue' }).theme === 'auto');
  ok('junk still falls back to the default, which is now auto',
    sanitizeStyle({ theme: 'neon' }).theme === 'auto');
}

if (failureCount()) {
  console.error('\n' + failureCount() + ' dashboardStyle check(s) FAILED');
  process.exit(1);
}
console.log('\nAll dashboardStyle checks passed.');
