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

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const REPO = path.resolve(__dirname, '..');
const HUB = path.join(REPO, 'renderer/hub/hub.css');
const THEME = path.join(REPO, 'renderer/theme.css');

// The section markers. The style blocks must stay contiguous and last in the
// dashboard region — the axis order (theme → density → accent) is what makes the
// accent axis win the cascade, and it is decided by POSITION, since all three
// are single-class selectors of equal specificity.
const SECTION_START = 'DASHBOARD STYLES — three orthogonal axes';
const SECTION_END = '── Connect data';

// The contract's class names, verbatim. Renaming one here without renaming it in
// dashboards.ts is the failure this list exists to make loud.
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

/** Distinct suffixes used on one axis, e.g. `dash-theme` → clean/executive/dark. */
function axisNames(css: string, axis: string): string[] {
  const found = new Set<string>();
  const re = new RegExp('\\.' + axis + '--([a-z0-9-]+)', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) found.add(m[1]);
  return Array.from(found).sort();
}

/** Names in `want` that `have` is missing — the actionable half of a failure. */
function missing(want: Set<string>, have: Set<string>): string[] {
  return Array.from(want).filter((n) => !have.has(n)).sort();
}

// ── read ─────────────────────────────────────────────────────────────────────

ok('hub.css exists', fs.existsSync(HUB));
ok('theme.css exists', fs.existsSync(THEME));
if (!fs.existsSync(HUB) || !fs.existsSync(THEME)) process.exit(1);

const hubRaw = fs.readFileSync(HUB, 'utf8');
const themeRaw = fs.readFileSync(THEME, 'utf8');

const startAt = hubRaw.indexOf(SECTION_START);
const endAt = hubRaw.indexOf(SECTION_END, startAt < 0 ? 0 : startAt);
ok('the dashboard style section is present and banner-marked', startAt >= 0, SECTION_START);
ok('the style section ends before the Connect-data block', endAt > startAt,
   'the section must stay contiguous — axis order is what decides the cascade');
if (startAt < 0 || endAt <= startAt) process.exit(1);

// Start the slice at the banner's OPENING `/*`, not at the title text inside
// it. Slicing mid-comment leaves the closing `*/` unpaired, which would make the
// orphan-delimiter check below fire on every run and be turned off as noise —
// and that check is the only thing standing between a mistyped comment and a
// silently missing rule.
const bannerAt = hubRaw.lastIndexOf('/*', startAt);
// Same at the tail: SECTION_END names text inside the NEXT banner, so cut at
// that banner's own `/*` rather than part-way through it.
const nextBannerAt = hubRaw.lastIndexOf('/*', endAt);
const section = decomment(hubRaw.slice(bannerAt < 0 ? startAt : bannerAt,
                                       nextBannerAt > bannerAt ? nextBannerAt : endAt));
const hub = decomment(hubRaw);
const theme = decomment(themeRaw);

// ── the class names are the contract ─────────────────────────────────────────

ok('theme classes are exactly clean/executive/dark',
   axisNames(hub, 'dash-theme').join(',') === THEMES.join(','),
   axisNames(hub, 'dash-theme').join(','));
ok('density classes are exactly comfortable/compact',
   axisNames(hub, 'dash-density').join(',') === DENSITIES.join(','),
   axisNames(hub, 'dash-density').join(','));
ok('accent classes are exactly blue/teal/slate',
   axisNames(hub, 'dash-accent').join(',') === ACCENTS.join(','),
   axisNames(hub, 'dash-accent').join(','));

// Plain class selectors, never `html.dash-theme--dark`. The same block has to
// work on <html>, on #dash-editor, and on a preview tile in the style picker;
// qualified with `html` the picker's thumbnails all paint the root's colours.
const qualified = rules(section)
  .map((r) => r.sel)
  .filter((s) => /(^|,)\s*[a-z][a-z0-9]*\.dash-(theme|density|accent)--/.test(s));
ok('no axis class is qualified by an element (html.dash-theme--x)',
   qualified.length === 0, qualified.join(' | '));

// ── theme axis: identical token sets ─────────────────────────────────────────

const themeSets = new Map<string, Set<string>>();
for (const name of THEMES) {
  const sel = '.dash-theme--' + name;
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
  ok(`.dash-theme--${name} defines every token the other themes do`,
     gap.length === 0, `missing: ${gap.join(', ')}`);
});

// The white-boxes guard, stated as such: theme.css's [data-theme="dark"] is the
// authoritative list of what must move for a surface to go dark. Anything it
// redefines and .dash-theme--dark does not is a light value on a dark sheet.
const appDark = propsOf(theme, '[data-theme="dark"]');
ok('theme.css [data-theme="dark"] block found', appDark !== null);
if (appDark) {
  const gap = missing(appDark, themeSets.get('dark') ?? new Set());
  ok('.dash-theme--dark redefines everything [data-theme="dark"] does',
     gap.length === 0,
     `these would inherit the LIGHT value on a dark sheet: ${gap.join(', ')}`);
}

// color-scheme is not a custom property, so the set checks above cannot see it.
// Without it the native <select>/<input type="date"> in .dash-ctrl-select and
// .dash-ctrl-date render a white widget on a dark card.
const darkBlock = new RegExp('\\.dash-theme--dark\\s*\\{([^}]*)\\}').exec(section);
ok('.dash-theme--dark sets color-scheme: dark for the native controls',
   !!darkBlock && /color-scheme\s*:\s*dark/.test(darkBlock[1]));

// ── accent axis: identical token sets, light and dark ────────────────────────

const accentSels = ACCENTS.map((a) => '.dash-accent--' + a)
  .concat(ACCENTS.map((a) => '.dash-theme--dark.dash-accent--' + a));

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
const lastTheme = Math.max(...THEMES.map((n) => section.lastIndexOf('.dash-theme--' + n + ' {')));
const firstAccent = Math.min(...ACCENTS.map((n) => section.indexOf('.dash-accent--' + n + ' {')));
ok('accent blocks come after every theme block (accent must win the cascade)',
   firstAccent > lastTheme, `theme@${lastTheme} accent@${firstAccent}`);

// ── density axis: the two geometry tokens, always both ───────────────────────

// dashboards.ts reads these back with getComputedStyle for drag/resize
// hit-testing. A density block that set only the gap would paint one pitch and
// compute drops against another, landing cards a row off from where they were
// released.
for (const name of DENSITIES) {
  const sel = '.dash-density--' + name;
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

// .dash-grid must consume them, or the tokens are decoration. The column count
// stays hardcoded on purpose: a card's x/w are layout COORDINATES, and a restyle
// that re-columns the grid moves every saved card.
const grid = rules(hub).find((r) => r.sel === '.dash-grid');
ok('.dash-grid exists', !!grid);
if (grid) {
  ok('.dash-grid consumes var(--dash-gap) and var(--dash-row)',
     /gap:\s*var\(--dash-gap\)/.test(grid.body) &&
     /grid-auto-rows:\s*var\(--dash-row\)/.test(grid.body), grid.body);
  ok('.dash-grid keeps 12 columns hardcoded (a style must never move a card)',
     /grid-template-columns:\s*repeat\(12,\s*1fr\)/.test(grid.body), grid.body);
}

// ── no dangling var() inside the new section ─────────────────────────────────

// test-cssVars.ts checks this repo-wide, but it accepts a definition ANYWHERE.
// Repeating it over the section keeps the failure local and readable while this
// feature is being edited.
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
ok('every var() in the style section resolves to a definition or a fallback',
   dangling.size === 0, Array.from(dangling).join(', '));

// ── the theme-blind literal ──────────────────────────────────────────────────

// Six rules in the dashboard section hardcoded #dc2626 instead of var(--error).
// A literal cannot follow a theme, so the broken-card border and the remove
// button painted a light-theme red on the dark preset. Same class of bug as an
// undefined var: legal CSS, wrong pixels.
const literal = rules(hub)
  .filter((r) => /\.dash-/.test(r.sel) && /#dc2626/i.test(r.body))
  .map((r) => r.sel.replace(/\s+/g, ' '));
ok('no .dash- rule hardcodes #dc2626 (use var(--error) — it follows the theme)',
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
  ok(`no comment in the style section closes early (orphan "${orphan}")`,
     section.indexOf(orphan) < 0,
     section.slice(Math.max(0, section.indexOf(orphan) - 70), section.indexOf(orphan) + 10));
}

// ── the picker previews paint their OWN world ────────────────────────────────

// Each of the four thumbnails carries a preset's three axis classes, and the
// point of the picker is that they therefore look DIFFERENT. Leave the preview
// box or its mini-cards transparent and every tile inherits the surrounding
// sheet instead — four identical boxes, a chooser that silently tells the user
// nothing, and no error anywhere. So the two surfaces that make the difference
// visible are required to set a background from a token.
for (const sel of ['.dash-style-preview', '.dash-mini-card']) {
  const r = rules(hub).find((x) => x.sel.trim() === sel);
  ok(`${sel} exists`, Boolean(r));
  ok(`…and paints its own background from a token`,
     Boolean(r) && /background:\s*var\(--/.test(r!.body), r ? r.body.slice(0, 120) : '(missing)');
}

// The picker markup is built in dashStyle.ts; a class renamed on one side and
// not the other is invisible until someone opens the chooser and finds it bare.
const picker = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub', 'dashStyle.ts'), 'utf8');
for (const cls of ['dash-style-strip', 'dash-style-tile', 'dash-style-preview',
                   'dash-mini-grid', 'dash-mini-card', 'dash-mini-bars', 'dash-mini-bar',
                   'dash-mini-metric', 'dash-mini-line', 'dash-mini-pill']) {
  ok(`dashStyle.ts emits .${cls} and hub.css styles it`,
     picker.indexOf(cls) >= 0 && hub.indexOf('.' + cls) >= 0,
     `emitted=${picker.indexOf(cls) >= 0} styled=${hub.indexOf('.' + cls) >= 0}`);
}

console.log('');
if (failureCount()) {
  console.error(`${failureCount()} dashboard style CSS check(s) FAILED.`);
  process.exit(1);
}
console.log('All dashboard style CSS checks passed.');
