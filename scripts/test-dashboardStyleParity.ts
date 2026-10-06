// A dashboard style is a CLOSED ENUM, and the desktop declared it twice.
//
// Main owns the copy that reaches disk (src/analysis/dashboards.ts:
// DASHBOARD_STYLE_PRESETS / DEFAULT_DASHBOARD_STYLE). The desktop's picker kept
// a second copy in its classic-script dashStyle.ts, and drift between the two
// was INVISIBLE: a preset the picker offered but main did not know sanitized
// silently back to the default. That copy went with the desktop app (T8.1); its
// table, default and axis lists are the golden fixture
// scripts/fixtures/golden/dashboardStyle.json (scripts/golden.ts), and main is
// still held to them value for value — and must still accept every axis value
// the picker painted rather than clamping it away.

export {};
import { ok, failureCount } from './selfcheck';

import { golden } from './golden';
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');

type Axes = Record<string, string>;
const G = golden<{ presets: Record<string, Axes>; defaultStyle: Axes; axes: Record<string, string[]> }>('dashboardStyle');

// ── The preset table, in both worlds ────────────────────────────────────────
const MAIN = dashboards.DASHBOARD_STYLE_PRESETS as unknown as Record<string, Record<string, string>>;
const REND = G.presets;

ok('main exports a preset table', Boolean(MAIN) && Object.keys(MAIN).length > 0);
ok('the desktop copy was recorded', Object.keys(REND).length > 0);
ok('…and both name the same four presets',
  JSON.stringify(Object.keys(MAIN).sort()) === JSON.stringify(Object.keys(REND).sort()),
  `main=${Object.keys(MAIN).sort()} desktop=${Object.keys(REND).sort()}`);
ok('…which are exactly auto/clean/executive/dense/dark',
  JSON.stringify(Object.keys(MAIN).sort()) === JSON.stringify(['auto', 'clean', 'dark', 'dense', 'executive']),
  String(Object.keys(MAIN).sort()));

for (const name of Object.keys(MAIN)) {
  const a = MAIN[name];
  const b = REND[name] || {};
  ok(`preset "${name}" is byte-identical in both copies`,
    a.theme === b.theme && a.density === b.density && a.accent === b.accent,
    `main=${JSON.stringify(a)} desktop=${JSON.stringify(b)}`);
}

// ── The default, in both worlds ─────────────────────────────────────────────
const MDEF = dashboards.DEFAULT_DASHBOARD_STYLE as unknown as Record<string, string>;
const RDEF = { d: G.defaultStyle };
ok('the default style matches in both copies',
  Boolean(RDEF.d) && MDEF.theme === RDEF.d.theme && MDEF.density === RDEF.d.density && MDEF.accent === RDEF.d.accent,
  `main=${JSON.stringify(MDEF)} desktop=${JSON.stringify(RDEF.d)}`);
ok('…and the default is itself a preset (Auto)',
  MDEF.theme === MAIN.auto.theme && MDEF.density === MAIN.auto.density && MDEF.accent === MAIN.auto.accent);

// ── The axis lists ──────────────────────────────────────────────────────────
// The desktop clamped against these three arrays before composing a class name;
// if they fall behind main's sanitizer, a legitimately-stored style paints as
// the default and the record looks corrupt when it is not.
const AXES: Record<string, string[]> = G.axes;
for (const axis of Object.keys(AXES)) {
  ok(`the desktop declared the "${axis}" axis`, AXES[axis].length > 0);
  // Main is the authority: every value it will accept must be paintable.
  for (const name of Object.keys(MAIN)) {
    ok(`…and it covers preset "${name}"'s ${axis} ("${MAIN[name][axis]}")`,
      AXES[axis].indexOf(MAIN[name][axis]) >= 0, String(AXES[axis]));
  }
  // …and a value the picker would paint but main would reject is just as bad.
  for (const v of AXES[axis]) {
    // `chosen` on the probe, or the 'clean' migration reads a defaulted 'clean'
    // as 'auto' and this looks like the sanitizer clamping a legal value away.
    const probe: Record<string, unknown> = { theme: 'auto', density: 'comfortable', accent: 'blue', chosen: true };
    probe[axis] = v;
    const clamped = dashboards.sanitizeStyle(probe as any) as unknown as Record<string, string>;
    ok(`…and main accepts "${v}" on ${axis} rather than clamping it away`,
      clamped[axis] === v, JSON.stringify(clamped));
  }
}

// ── Every axis value has a class block in the stylesheet ────────────────────
// A style with no CSS block applies nothing, which on screen is indistinguishable
// from a dead button. The stylesheet is now the web app's (a CSS module, one
// `.<axis>_<value>` block per value); `auto` follows the app's theme and
// declares nothing, so it has no block.
{
  const fs: typeof import('fs') = require('fs');
  const path: typeof import('path') = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'features', 'dashboards', 'Style.module.css'), 'utf8');
  for (const axis of Object.keys(AXES)) {
    for (const v of AXES[axis]) {
      if (axis === 'theme' && v === 'auto') continue;
      ok(`Style.module.css defines .${axis}_${v}`, new RegExp(`^\\.${axis}_${v}\\s*\\{`, 'm').test(css));
    }
  }
}

if (failureCount()) {
  console.error('\n' + failureCount() + ' dashboard-style parity check(s) FAILED');
  process.exit(1);
}
console.log('\nAll dashboard-style parity checks passed.');
