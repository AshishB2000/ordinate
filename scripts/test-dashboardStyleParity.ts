// A dashboard style is a CLOSED ENUM, declared twice.
//
// Main owns the copy that reaches disk (src/analysis/dashboards.ts:
// DASHBOARD_STYLE_PRESETS / DEFAULT_DASHBOARD_STYLE) and the renderer needs the
// same table to build the picker — but a classic global-scope <script> cannot
// import from main, so the vocabulary is declared a second time in
// renderer/hub/dashStyle.ts. Two declarations of one enum is exactly the shape
// that drifts, and the drift is INVISIBLE: a preset the renderer offers but
// main does not know sanitizes silently back to the default, so the user picks
// "Executive", sees it apply, reopens the dashboard and finds it Clean again.
// This asserts the two copies are identical, the same way test-ai-naming.ts
// pins the not-configured sentence.
//
// It also pins the enum against the CSS: every axis value must have a class
// block in hub.css, because a value with no block is a style that applies
// nothing at all — and that failure looks exactly like "the button is broken".

export {};
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');

const REPO = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(REPO, p), 'utf8');
const renderer = read('renderer/hub/dashStyle.ts');

/** Pull `name: { theme: 'x', density: 'y', accent: 'z' }` entries out of a source block. */
function parsePresetTable(src: string, constName: string): Record<string, Record<string, string>> {
  const start = src.indexOf(constName);
  if (start < 0) return {};
  const open = src.indexOf('{', start);
  const end = src.indexOf('\n};', open);
  const block = src.slice(open, end < 0 ? src.length : end);
  const out: Record<string, Record<string, string>> = {};
  const entry = /(\w+)\s*:\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(block)) !== null) {
    const axes: Record<string, string> = {};
    const pair = /(\w+)\s*:\s*'([^']*)'/g;
    let p: RegExpExecArray | null;
    while ((p = pair.exec(m[2])) !== null) axes[p[1]] = p[2];
    out[m[1]] = axes;
  }
  return out;
}

// ── The preset table, in both worlds ────────────────────────────────────────
const MAIN = dashboards.DASHBOARD_STYLE_PRESETS as unknown as Record<string, Record<string, string>>;
const REND = parsePresetTable(renderer, 'const DASH_STYLE_PRESETS');

ok('main exports a preset table', Boolean(MAIN) && Object.keys(MAIN).length > 0);
ok('dashStyle.ts declares the renderer copy', Object.keys(REND).length > 0);
ok('…and both name the same four presets',
  JSON.stringify(Object.keys(MAIN).sort()) === JSON.stringify(Object.keys(REND).sort()),
  `main=${Object.keys(MAIN).sort()} renderer=${Object.keys(REND).sort()}`);
ok('…which are exactly clean/executive/dense/dark',
  JSON.stringify(Object.keys(MAIN).sort()) === JSON.stringify(['clean', 'dark', 'dense', 'executive']),
  String(Object.keys(MAIN).sort()));

for (const name of Object.keys(MAIN)) {
  const a = MAIN[name];
  const b = REND[name] || {};
  ok(`preset "${name}" is byte-identical in both copies`,
    a.theme === b.theme && a.density === b.density && a.accent === b.accent,
    `main=${JSON.stringify(a)} renderer=${JSON.stringify(b)}`);
}

// ── The default, in both worlds ─────────────────────────────────────────────
const MDEF = dashboards.DEFAULT_DASHBOARD_STYLE as unknown as Record<string, string>;
const RDEF = parsePresetTable('X = {d: ' + (/const DASH_STYLE_DEFAULT = (\{[^}]*\})/.exec(renderer) || ['', '{}'])[1] + '}\n};', 'X');
ok('the default style matches in both copies',
  Boolean(RDEF.d) && MDEF.theme === RDEF.d.theme && MDEF.density === RDEF.d.density && MDEF.accent === RDEF.d.accent,
  `main=${JSON.stringify(MDEF)} renderer=${JSON.stringify(RDEF.d)}`);
ok('…and the default is itself a preset (Clean)',
  MDEF.theme === MAIN.clean.theme && MDEF.density === MAIN.clean.density && MDEF.accent === MAIN.clean.accent);

// ── The axis lists ──────────────────────────────────────────────────────────
// The renderer clamps against these three arrays before composing a class name;
// if they fall behind main's sanitizer, a legitimately-stored style paints as
// the default and the record looks corrupt when it is not.
function parseList(name: string): string[] {
  const m = new RegExp('const ' + name + " = \\[([^\\]]*)\\]").exec(renderer);
  if (!m) return [];
  return (m[1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
}
const AXES: Record<string, string[]> = {
  theme: parseList('DASH_THEMES'),
  density: parseList('DASH_DENSITIES'),
  accent: parseList('DASH_ACCENTS'),
};
for (const axis of Object.keys(AXES)) {
  ok(`the renderer declares the "${axis}" axis`, AXES[axis].length > 0);
  // Main is the authority: every value it will accept must be paintable.
  for (const name of Object.keys(MAIN)) {
    ok(`…and it covers preset "${name}"'s ${axis} ("${MAIN[name][axis]}")`,
      AXES[axis].indexOf(MAIN[name][axis]) >= 0, String(AXES[axis]));
  }
  // …and a value the renderer would paint but main would reject is just as bad.
  for (const v of AXES[axis]) {
    const probe: Record<string, string> = { theme: 'clean', density: 'comfortable', accent: 'blue' };
    probe[axis] = v;
    const clamped = dashboards.sanitizeStyle(probe as any) as unknown as Record<string, string>;
    ok(`…and main accepts "${v}" on ${axis} rather than clamping it away`,
      clamped[axis] === v, JSON.stringify(clamped));
  }
}

// ── Every axis value has a class block in the stylesheet ────────────────────
// A style with no CSS block applies nothing, which on screen is indistinguishable
// from a dead button.
const css = read('renderer/hub/hub.css');
const PREFIX: Record<string, string> = { theme: 'dash-theme--', density: 'dash-density--', accent: 'dash-accent--' };
for (const axis of Object.keys(AXES)) {
  for (const v of AXES[axis]) {
    ok(`hub.css defines .${PREFIX[axis]}${v}`, css.indexOf('.' + PREFIX[axis] + v) >= 0);
  }
}

if (failureCount()) {
  console.error('\n' + failureCount() + ' dashboard-style parity check(s) FAILED');
  process.exit(1);
}
console.log('\nAll dashboard-style parity checks passed.');
