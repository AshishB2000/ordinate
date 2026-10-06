// The dashboard style presets must each define the WHOLE token set, not a diff.
//
// WHY THIS EXISTS. A preset is a block of CSS custom properties on a plain class
// (.dash-theme--dark, .dash-accent--teal, …). CSS has no notion of a complete
// palette: a block that declares 33 of 34 tokens is perfectly valid, and the
// missing one silently INHERITS — from :root, i.e. from the light theme. So the
// failure mode of a half-written dark preset is not an error, a warning, or a
// console message. It is a white card head on a near-black sheet, and a chart
// series painted in the light ramp next to four dark ones. Exactly the shape of
// the --surface-1 bug that motivated test-cssVars.ts: invisible in a diff,
// invisible in CI, obvious the moment someone opens the app.
//
// The check is therefore SET EQUALITY, not spot values. Colours are a design
// decision and change; the invariant is that every block on an axis covers the
// same names, and that the dark theme covers everything theme.css's
// [data-theme="dark"] covers — that block is the authoritative list of what has
// to move for a surface to go dark.
//
// It also pins the class NAMES against the feature contract. The three axes are
// applied by string concatenation from the record ('dash-theme--' + style.theme),
// so a class renamed in CSS alone does not throw — it renders an unstyled sheet
// that looks like the default, which is a bug nobody reports because nothing
// looks broken.
//
// The stylesheet is the web app's dashboard Style module
// (web/src/features/dashboards/Style.module.css, generated from the desktop
// hub.css blocks verbatim) and the app tokens are web/src/theme.css. The desktop
// hub.css this file first guarded went with the desktop app (T8.1); the checks
// that only concerned it (its banner-marked section, .dash-grid, the style
// picker's own markup) went with it.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const REPO = path.resolve(__dirname, '..');
const HUB = path.join(REPO, 'web/src/features/dashboards/Style.module.css');
const THEME = path.join(REPO, 'web/src/theme.css');

// The contract's class names, verbatim. Renaming one here without renaming it in
// the dashboard Style code is the failure this list exists to make loud.
// The three that PIN a look. `auto` is deliberately not here: it declares no
// tokens at all, which is asserted separately below.
const THEMES = ['clean', 'dark', 'executive'];
const DENSITIES = ['comfortable', 'compact'];
const ACCENTS = ['blue', 'slate', 'teal'];

// ── tiny CSS reader (same approach as test-cssVars.ts: no dependency) ─────────

function decomment(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The custom properties declared by the rule whose selector is exactly `sel`.
 *  `null` when there is no such rule — a missing block and an empty one are
 *  different bugs and must not report the same way. Preset blocks never nest,
 *  so scanning to the first `}` is enough. */
function propsOf(css: string, sel: string): Set<string> | null {
  const m = new RegExp('(^|[;}\\s])' + esc(sel) + '\\s*\\{([^}]*)\\}').exec(css);
  if (!m) return null;
  const out = new Set<string>();
  const re = /(^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g;
  let d: RegExpExecArray | null;
  while ((d = re.exec(m[2]))) out.add(d[2]);
  return out;
}

/** Every innermost `selector { … }` rule. The `[^{}]` classes make the match
 *  land inside an @media wrapper rather than swallowing it. */
function rules(css: string): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}

/** Distinct suffixes used on one axis, e.g. `theme` → clean/executive/dark. */
function axisNames(css: string, axis: string): string[] {
  const found = new Set<string>();
  const re = new RegExp('\\.' + axis + '_([a-z0-9]+)', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) found.add(m[1]);
  return Array.from(found).sort();
}

/** Names in `want` that `have` is missing — the actionable half of a failure. */
function missing(want: Set<string>, have: Set<string>): string[] {
  return Array.from(want).filter((n) => !have.has(n)).sort();
}

// ── read ─────────────────────────────────────────────────────────────────────

ok('Style.module.css exists', fs.existsSync(HUB));
ok('theme.css exists', fs.existsSync(THEME));
if (!fs.existsSync(HUB) || !fs.existsSync(THEME)) process.exit(1);

const hubRaw = fs.readFileSync(HUB, 'utf8');
const themeRaw = fs.readFileSync(THEME, 'utf8');

const section = decomment(hubRaw);
const hub = decomment(hubRaw);
const theme = decomment(themeRaw);

// ── the class names are the contract ─────────────────────────────────────────

ok('theme classes are exactly clean/dark/executive (auto has none)',
   axisNames(hub, 'theme').join(',') === THEMES.join(','),
   axisNames(hub, 'theme').join(','));

// ── auto declares NOTHING, and that is the feature ─────────────────────────
// Every other theme block redefines the token set on the sheet container, which
// is what pins a dashboard to a look. `auto` must declare none of them, so the
// tokens resolve from the app's [data-theme] and the sheet follows Appearance.
// In a CSS module that means no block at all.
ok('there is no .theme_auto block', propsOf(hub, '.theme_auto') === null);
ok('density classes are exactly comfortable/compact',
   axisNames(hub, 'density').join(',') === DENSITIES.join(','),
   axisNames(hub, 'density').join(','));
ok('accent classes are exactly blue/teal/slate',
   axisNames(hub, 'accent').join(',') === ACCENTS.join(','),
   axisNames(hub, 'accent').join(','));

// Plain class selectors, never `html.theme_dark`. The same block has to work on
// the editor's subtree and on a preview tile; qualified with `html`, every
// preview paints the root's colours.
const qualified = rules(section)
  .map((r) => r.sel)
  .filter((s) => /(^|,)\s*[a-z][a-z0-9]*\.(theme|density|accent)_/.test(s));
ok('no axis class is qualified by an element (html.theme_x)',
   qualified.length === 0, qualified.join(' | '));

// ── theme axis: identical token sets ─────────────────────────────────────────

const themeSets = new Map<string, Set<string>>();
for (const name of THEMES) {
  const sel = '.theme_' + name;
  const p = propsOf(section, sel);
  ok(`${sel} block exists`, p !== null);
  if (p) themeSets.set(name, p);
}

const themeUnion = new Set<string>();
themeSets.forEach((s) => s.forEach((n) => themeUnion.add(n)));
ok('the theme axis defines a non-trivial token set', themeUnion.size >= 30,
   `${themeUnion.size} tokens`);

// The core assertion. A theme block missing a token inherits the LIGHT value, so
// the dark preset shows white boxes; the missing names are printed because "sets
// differ" is not something anyone can act on.
themeSets.forEach((have, name) => {
  const gap = missing(themeUnion, have);
  ok(`.theme_${name} defines every token the other themes do`,
     gap.length === 0, `missing: ${gap.join(', ')}`);
});

// The white-boxes guard, stated as such: theme.css's [data-theme="dark"] is the
// authoritative list of what must move for a surface to go dark. Anything it
// redefines and .dash-theme--dark does not is a light value on a dark sheet.
const appDark = propsOf(theme, '[data-theme="dark"]');
ok('theme.css [data-theme="dark"] block found', appDark !== null);
if (appDark) {
  const gap = missing(appDark, themeSets.get('dark') ?? new Set());
  ok('.theme_dark redefines everything [data-theme="dark"] does',
     gap.length === 0,
     `these would inherit the LIGHT value on a dark sheet: ${gap.join(', ')}`);
}

// color-scheme is not a custom property, so the set checks above cannot see it.
// Without it the native <select>/<input type="date"> in .dash-ctrl-select and
// .dash-ctrl-date render a white widget on a dark card.
const darkBlock = new RegExp('\\.theme_dark\\s*\\{([^}]*)\\}').exec(section);
ok('.theme_dark sets color-scheme: dark for the native controls',
   !!darkBlock && /color-scheme\s*:\s*dark/.test(darkBlock[1]));

// ── accent axis: identical token sets, light and dark ────────────────────────

const accentSels = ACCENTS.map((a) => '.accent_' + a)
  .concat(ACCENTS.map((a) => '.theme_dark.accent_' + a));

const accentSets = new Map<string, Set<string>>();
for (const sel of accentSels) {
  const p = propsOf(section, sel);
  ok(`${sel} block exists`, p !== null);
  if (p) accentSets.set(sel, p);
}

const accentUnion = new Set<string>();
accentSets.forEach((s) => s.forEach((n) => accentUnion.add(n)));
ok('the accent axis defines a non-trivial token set', accentUnion.size >= 10,
   `${accentUnion.size} tokens`);

// A chart with four series in one palette and a fifth inherited from the theme
// reads as a rendering bug, not as a style. Same rule for the dark combinations,
// which exist precisely because the light ramps go muddy on a dark surface.
accentSets.forEach((have, sel) => {
  const gap = missing(accentUnion, have);
  ok(`${sel} defines every token the other accents do`,
     gap.length === 0, `missing: ${gap.join(', ')}`);
});

// The accent axis must come after every theme block: all of them are (0,1,0), so
// only position breaks the tie, and if a theme wins, picking Teal on Dark keeps
// the theme's blue.
const lastTheme = Math.max(...THEMES.map((n) => section.lastIndexOf('.theme_' + n + ' {')));
const firstAccent = Math.min(...ACCENTS.map((n) => section.indexOf('.accent_' + n + ' {')));
ok('accent blocks come after every theme block (accent must win the cascade)',
   firstAccent > lastTheme, `theme@${lastTheme} accent@${firstAccent}`);

// ── density axis: the two geometry tokens, always both ───────────────────────

// The editor's grid reads these back for drag/resize hit-testing. A density block that set only the gap would paint one pitch and
// compute drops against another, landing cards a row off from where they were
// released.
for (const name of DENSITIES) {
  const sel = '.density_' + name;
  const p = propsOf(section, sel);
  ok(`${sel} block exists`, p !== null);
  if (!p) continue;
  const gap = missing(new Set(['--dash-gap', '--dash-row']), p);
  ok(`${sel} defines both --dash-gap and --dash-row`, gap.length === 0,
     `missing: ${gap.join(', ')}`);
}

ok('theme.css :root defines the geometry tokens the density axis moves',
   /--dash-gap\s*:/.test(theme) && /--dash-row\s*:/.test(theme));
ok('theme.css :root defines --font-numeric (Executive remaps it)',
   /--font-numeric\s*:/.test(theme));

// ── the workspace-theme token list IS this set ───────────────────────────────

// A workspace theme (Settings → Appearance → Themes) may override exactly the
// tokens the preset blocks declare, validated against ONE list exported from
// src/analysis/themeModel.ts. Set equality in both directions: a token added
// to a preset block and not to the list is a colour no theme can set; one in
// the list and in no block is a name a theme sets and nothing reads.
{
  const themeModel = require('../src/analysis/themeModel') as { AXIS_TOKENS: string[] };
  const declared = new Set<string>(themeUnion);
  for (const name of DENSITIES) (propsOf(section, '.density_' + name) ?? new Set<string>()).forEach((n) => declared.add(n));
  const list = new Set(themeModel.AXIS_TOKENS);
  ok('themeModel.AXIS_TOKENS has no duplicates', list.size === themeModel.AXIS_TOKENS.length);
  ok('every token a theme or density block declares is in themeModel.AXIS_TOKENS',
     missing(declared, list).length === 0, `missing from the list: ${missing(declared, list).join(', ')}`);
  ok('every token in themeModel.AXIS_TOKENS is declared by a theme or density block',
     missing(list, declared).length === 0, `declared nowhere: ${missing(list, declared).join(', ')}`);
}

// ── no dangling var() inside the new section ─────────────────────────────────

// A var() with no fallback must name a token the Style module or the app's
// theme.css defines — legal CSS that paints nothing is the bug this guards.
const definedAnywhere = new Set<string>();
for (const css of [hub, theme]) {
  const re = /(^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) definedAnywhere.add(m[2]);
}
const dangling = new Set<string>();
{
  const re = /var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) {
    if (m[2] !== ',' && !definedAnywhere.has(m[1])) dangling.add(m[1]);
  }
}
ok('every var() in the Style module resolves to a definition or a fallback',
   dangling.size === 0, Array.from(dangling).join(', '));

// ── the theme-blind literal ──────────────────────────────────────────────────

// Six desktop dashboard rules once hardcoded #dc2626 instead of var(--error).
// A literal cannot follow a theme, so the broken-card border and the remove
// button painted a light-theme red on the dark preset. Same class of bug as an
// undefined var: legal CSS, wrong pixels.
const literal = rules(hub)
  .filter((r) => /#dc2626/i.test(r.body))
  .map((r) => r.sel.replace(/\s+/g, ' '));
ok('no Style rule hardcodes #dc2626 (use var(--error) — it follows the theme)',
   literal.length === 0, literal.join(' | '));

// ── no comment closes itself early ─────────────────────────────────────────

// The banner above these rules once contained the phrase `--accent*/--chart*`.
// That `*/` CLOSED the comment 23 lines early, so the remaining prose was
// parsed as CSS, and the parser's error recovery swallowed the whole
// `.dash-theme--clean` block with it. Nothing looked wrong: the file read
// correctly, braces balanced, every text-based assertion in this file passed —
// and the browser silently had no Clean theme, so a dashboard on a dark-mode
// machine stayed dark under every preset. After stripping comments the section
// must contain no orphan delimiter; that is the exact signature.
for (const orphan of ['*/', '/*']) {
  ok(`no comment in the Style module closes early (orphan "${orphan}")`,
     section.indexOf(orphan) < 0,
     section.slice(Math.max(0, section.indexOf(orphan) - 70), section.indexOf(orphan) + 10));
}

console.log('');
if (failureCount()) {
  console.error(`${failureCount()} dashboard style CSS check(s) FAILED.`);
  process.exit(1);
}
console.log('All dashboard style CSS checks passed.');
