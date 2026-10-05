// Self-check for workspace THEMES — src/analysis/themeModel.ts (the pure model
// main and the hub share), src/app/themeStore.ts (the store and its bundle
// hooks), and the theme's path through dashboards.sanitizeStyle and the
// dashboard export's whitelist.
//
//   1. TOKENS: unknown names dropped, bad values dropped, numbers bounded, fonts
//      a four-family whitelist, enums closed — and what each compiles to.
//   2. CONTRAST: a known-bad colour warns and a good one does not, on a light
//      theme and a dark one; text against the page at 4.5:1.
//   3. RESOLUTION: the dashboard's theme, then the workspace default, then the
//      built-in preset — a missing or deleted id falls through, 'none' opts out.
//   4. THE STORE: a round trip, the default cleared with its theme, a corrupt
//      file read as empty (and kept aside), junk records skipped.
//   5. BUNDLES: a project bundle carries the themes its dashboards name and an
//      import adopts them; the export whitelist holds against hostile values.
//
//   npm run build:ts && node scripts/test-themes.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-themes-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: () => tmp } };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const tm = require('../src/analysis/themeModel') as any;
const store: typeof import('../src/app/themeStore') = require('../src/app/themeStore');
const { sanitizeStyle }: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const { sanitizeBundle, buildSelfContainedHtml }: typeof import('../src/analysis/dashboardExport') = require('../src/analysis/dashboardExport');
const { sanitizePage }: typeof import('../src/publish/sanitize') = require('../src/publish/sanitize');
const { pageHtml }: typeof import('../src/publish/siteHtml') = require('../src/publish/siteHtml');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';

async function main(): Promise<void> {
  // ── 1. Tokens ──────────────────────────────────────────────────────────────
  const t = tm.sanitizeTokens({
    '--bg': '#FAFAFA',
    '--surface': 'rgba(255,255,255, 0.5)',
    '--text': 'red',
    '--border': '#12345',
    '--chart-1': 'rgba(300, 0, 0, 1)',
    '--chart-2': '#0e7490',
    '--made-up': '#ffffff',
    'color': '#ffffff',
    '--shadow-md': '0 10px 28px -12px rgba(15, 23, 42, 0.18)',
    '--shadow-sm': '0 0 red;} body{display:none',
    '--shadow-lg': 'inset 0 1px 2px #000000',
    '--font-ui': 'inter',
    '--font-numeric': '"Comic Sans MS", cursive',
    '--dash-row': 9999,
    '--dash-gap': '-40px',
    '--dash-card-radius': '14px',
    '--dash-kpi-size': 'big',
    '--dash-card-shadow': 'xl',
    '--dash-kpi-label': 'above',
    '--dash-card-rule': 'off',
  });
  ok('tokens: a hex colour is kept, lower-cased', t['--bg'] === '#fafafa', t['--bg']);
  ok('tokens: rgba is kept in one canonical spelling', t['--surface'] === 'rgba(255, 255, 255, 0.5)', t['--surface']);
  ok('tokens: a named colour is dropped (hex/rgba only)', !('--text' in t));
  ok('tokens: a malformed hex is dropped', !('--border' in t));
  ok('tokens: an rgba channel over 255 is dropped', !('--chart-1' in t));
  ok('tokens: an unknown custom property is dropped', !('--made-up' in t) && !('color' in t));
  ok('tokens: a one-layer box-shadow is kept', t['--shadow-md'] === '0 10px 28px -12px rgba(15, 23, 42, 0.18)', t['--shadow-md']);
  ok('tokens: a shadow that tries to close the block is dropped', !('--shadow-sm' in t));
  ok('tokens: an inset shadow is dropped (not in the grammar)', !('--shadow-lg' in t));
  ok('tokens: a whitelisted font KEY is kept', t['--font-ui'] === 'inter');
  ok('tokens: a font stack that is not one of the four is dropped', !('--font-numeric' in t));
  ok('tokens: an oversized row is clamped to its bound', t['--dash-row'] === 96, t['--dash-row']);
  ok('tokens: a negative gap is clamped to its floor', t['--dash-gap'] === 2, t['--dash-gap']);
  ok('tokens: "14px" is read as 14', t['--dash-card-radius'] === 14);
  ok('tokens: a non-number size is dropped', !('--dash-kpi-size' in t));
  ok('tokens: an enum outside its set is dropped', !('--dash-card-shadow' in t));
  ok('tokens: enum members are kept', t['--dash-kpi-label'] === 'above' && t['--dash-card-rule'] === 'off');
  ok('tokens: junk input is an empty map, never a throw',
    [null, undefined, 7, 'x', [], [1, 2]].every((x) => Object.keys(tm.sanitizeTokens(x)).length === 0));

  const css = new Map<string, string>(tm.themeCssVars(t));
  ok('css: a font key compiles to its full stack with system fallbacks',
    /^Inter, .*sans-serif$/.test(css.get('--font-ui') || ''), css.get('--font-ui'));
  ok('css: no stack names a network font source', !/url\(|https?:/.test(Object.values(tm.FONTS).map((f: any) => f.stack).join(' ')));
  ok('css: exactly four families are offered', Object.keys(tm.FONTS).length === 4 &&
    ['Hanken Grotesk', 'Inter', 'IBM Plex Sans', 'Source Serif'].every((l) => Object.values(tm.FONTS).some((f: any) => f.label === l)));
  ok('css: px tokens carry their unit', css.get('--dash-row') === '96px' && css.get('--dash-card-radius') === '14px');
  ok('css: enums compile to their CSS', css.get('--dash-kpi-label') === '-1' && css.get('--dash-card-rule') === '0px');
  ok('css: no value carries a character that could leave a declaration',
    Array.from(css.values()).every((v) => !/[;{}<>]/.test(v)), JSON.stringify(Array.from(css.values())));

  const rec = tm.sanitizeTheme({ id: A.toUpperCase(), name: '  My   theme  ', tokens: { '--bg': '#ffffff' }, extra: 1 });
  ok('record: id lower-cased, name tidied, unknown fields dropped',
    rec.id === A && rec.name === 'My theme' && !('extra' in rec) && rec.tokens['--bg'] === '#ffffff', JSON.stringify(rec));
  ok('record: a non-UUID id is blanked for the store to mint one', tm.sanitizeTheme({ id: '../../etc', tokens: {} }).id === '');
  ok('record: a name is capped', tm.sanitizeTheme({ name: 'x'.repeat(500) }).name.length === 60);
  ok('record: a non-object is null', tm.sanitizeTheme('theme') === null && tm.sanitizeTheme([]) === null);

  // ── 2. Contrast ───────────────────────────────────────────────────────────
  ok('contrast: black on white is 21:1', Math.abs(tm.contrast('#000000', '#ffffff') - 21) < 1e-9);
  ok('contrast: an rgba colour is not measured (null)', tm.contrast('rgba(0, 0, 0, 0.5)', '#ffffff') === null);
  const warnedOn = (tokens: any): string[] => tm.themeWarnings(tokens).map((w: any) => w.token).sort();
  const light = { '--bg': '#f7f7f8', '--surface': '#ffffff', '--text': '#18181b', '--accent': '#2563eb', '--chart-1': '#2563eb', '--chart-2': '#fde047' };
  ok('contrast (light): pale yellow on white warns, blue does not',
    JSON.stringify(warnedOn(light)) === JSON.stringify(['--chart-2']), JSON.stringify(tm.themeWarnings(light)));
  const w0 = tm.themeWarnings(light)[0];
  ok('contrast: the warning names its ratio and floor', w0 && w0.min === 3 && w0.ratio < 3 && /on the surface — needs 3:1$/.test(w0.message), w0 && w0.message);
  const dark = { '--bg': '#18181b', '--surface': '#232327', '--text': '#ececee', '--chart-1': '#fbbf24', '--chart-2': '#1e293b' };
  ok('contrast (dark): slate-800 on the dark surface warns, amber does not',
    JSON.stringify(warnedOn(dark)) === JSON.stringify(['--chart-2']), JSON.stringify(tm.themeWarnings(dark)));
  ok('contrast: grey body text on white warns at 4.5:1',
    JSON.stringify(warnedOn({ '--bg': '#ffffff', '--text': '#9ca3af' })) === JSON.stringify(['--text']));
  ok('contrast: near-black body text on white does not', warnedOn({ '--bg': '#ffffff', '--text': '#18181b' }).length === 0);
  ok('contrast: a pair with a missing side is not guessed at', warnedOn({ '--chart-3': '#fde047' }).length === 0);
  ok('contrast: every chart colour and the accent are checked',
    warnedOn({ '--surface': '#ffffff', '--accent': '#ffffff', '--chart-1': '#fefefe', '--chart-8': '#fafafa' }).join() === '--accent,--chart-1,--chart-8');

  // ── 3. Resolution ─────────────────────────────────────────────────────────
  const themes = [{ id: A, name: 'A', tokens: {} }, { id: B, name: 'B', tokens: {} }];
  const res = (d: unknown, w: unknown): string => {
    const r = tm.resolveTheme(d, w, themes);
    return r.source + ':' + (r.theme ? r.theme.name : '-');
  };
  ok('resolve: the dashboard\'s own theme wins', res(A, B) === 'dashboard:A');
  ok('resolve: no dashboard theme → the workspace default', res('', B) === 'workspace:B' && res(undefined, B) === 'workspace:B');
  ok('resolve: neither → the built-in preset', res('', '') === 'builtin:-');
  ok('resolve: a deleted dashboard theme falls through to the workspace', res(GONE, B) === 'workspace:B');
  ok('resolve: a deleted workspace theme falls through to the built-in', res(GONE, GONE) === 'builtin:-');
  ok('resolve: "none" opts out of the workspace default', res('none', B) === 'builtin:-');
  ok('resolve: an id in another case still resolves', res(A.toUpperCase(), '') === 'dashboard:A');
  ok('resolve: a malformed id is ignored, never matched', res('../x', 'A') === 'builtin:-');
  ok('resolve: a junk theme list is empty', tm.resolveTheme(A, B, 'nope').source === 'builtin');

  ok('style: sanitizeStyle keeps a theme id', sanitizeStyle({ themeId: A.toUpperCase() }).themeId === A);
  ok('style: …and "none"', sanitizeStyle({ themeId: 'none' }).themeId === 'none');
  ok('style: …and drops anything else', !('themeId' in sanitizeStyle({ themeId: 'x;}' })) && !('themeId' in sanitizeStyle({})));

  // ── 4. The store ──────────────────────────────────────────────────────────
  const file = path.join(tmp, 'themes.json');
  store._setStoreFile(file);
  let st = await store.listThemes();
  ok('store: no file is an empty workspace', st.themes.length === 0 && st.defaultId === '');
  const s1 = await store.saveTheme({ name: 'Brand', tokens: { '--bg': '#ffffff', '--chart-1': 'red;}' } });
  ok('store: a new theme gets a UUID and only its valid tokens',
    s1.ok && !!s1.theme && tm.isId(s1.theme.id) && s1.theme.tokens['--bg'] === '#ffffff' && !('--chart-1' in s1.theme.tokens), JSON.stringify(s1));
  const id1 = s1.theme ? s1.theme.id : '';
  const s2 = await store.saveTheme({ id: id1, name: 'Brand v2', tokens: { '--bg': '#000000' } });
  st = await store.listThemes();
  ok('store: saving with an existing id replaces, not appends',
    s2.ok && st.themes.length === 1 && st.themes[0].name === 'Brand v2' && st.themes[0].tokens['--bg'] === '#000000');
  ok('store: the file on disk is what was saved', JSON.parse(fs.readFileSync(file, 'utf8')).themes[0].name === 'Brand v2');
  ok('store: no temp file is left behind', fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')).length === 0);
  ok('store: an unknown id cannot be the default', !(await store.setDefaultTheme(GONE)).ok);
  ok('store: a stored theme can', (await store.setDefaultTheme(id1)).ok && (await store.listThemes()).defaultId === id1);
  ok('store: delete refuses a path-shaped id', !(await store.deleteTheme('../themes')).ok);
  ok('store: deleting the default clears the default', (await store.deleteTheme(id1)).ok &&
    (await store.listThemes()).defaultId === '' && (await store.listThemes()).themes.length === 0);

  fs.writeFileSync(file, '{ "themes": [ {"id": ');
  st = await store.listThemes();
  ok('store: a corrupt file reads as empty, not a throw', st.themes.length === 0);
  ok('store: …and is kept aside as themes.json.corrupt', fs.existsSync(file + '.corrupt'));
  ok('store: …and the next save still works', (await store.saveTheme({ name: 'After' })).ok && (await store.listThemes()).themes.length === 1);

  fs.writeFileSync(file, JSON.stringify({ defaultId: GONE, themes: [
    { id: A, name: 'Kept', tokens: { '--bg': '#ffffff' } },
    { id: A, name: 'Duplicate id', tokens: {} },
    { id: 'not-a-uuid', name: 'No id', tokens: {} },
    'junk', null,
  ] }));
  st = await store.listThemes();
  ok('store: junk records, bad ids and duplicate ids are skipped',
    st.themes.length === 1 && st.themes[0].name === 'Kept', JSON.stringify(st.themes.map((x) => x.name)));
  ok('store: a default naming a missing theme reads as none', st.defaultId === '');

  // ── 5. Bundles ────────────────────────────────────────────────────────────
  const dash = (themeId: string): { name: string; data: Buffer } =>
    ({ name: 'analyses/' + B + '.json', data: Buffer.from(JSON.stringify({ id: B, style: { theme: 'auto', themeId } })) });
  const entry = await store.bundleThemesEntry([dash(A), { name: 'visuals/' + A + '.json', data: Buffer.from('{}') }]);
  ok('bundle: the themes a dashboard names travel as themes.json',
    !!entry && entry.name === 'themes.json' && JSON.parse(entry.data.toString()).themes[0].id === A);
  ok('bundle: no named theme, no entry', (await store.bundleThemesEntry([dash('none')])) === null);

  const incoming = { name: 'themes.json', data: Buffer.from(JSON.stringify({ themes: [
    { id: A, name: 'Theirs, same id', tokens: { '--bg': '#000000' } },
    { id: B, name: 'New here', tokens: { '--bg': '#123456', '--text': 'x;}' } },
  ] })) };
  const added = await store.importBundleThemes([incoming], (s) => s);
  st = await store.listThemes();
  ok('bundle: import adopts a theme this workspace lacks', added === 1 && st.themes.some((x) => x.id === B && x.tokens['--bg'] === '#123456'));
  ok('bundle: …re-validating it', !('--text' in (st.themes.find((x) => x.id === B) || { tokens: {} }).tokens));
  ok('bundle: …and leaves a same-id local theme alone', (st.themes.find((x) => x.id === A) || { name: '' }).name === 'Kept');
  ok('bundle: an unreadable themes.json costs nothing', (await store.importBundleThemes(
    [{ name: 'themes.json', data: Buffer.from('nope') }], (s) => s)) === 0);

  // The export whitelist: every value is interpolated into a <style> block.
  const hostile = {
    name: 'Mine', tokens: {
      '--surface': '#fdfcfb', '--chart-1': '#b91c1c', '--chart-2': 'red;} body{display:none',
      '--bg': '#fff;}</style><script>alert(1)</script>', '--font-ui': 'plex', '--font-numeric': 'x;}',
      '--dash-card-radius': 400, '--evil': '#000000',
    },
  };
  const clean = sanitizeBundle({ name: 'D', pages: [], theme: hostile });
  ok('export: a theme survives sanitizeBundle with only its valid tokens',
    !!clean.theme && JSON.stringify(Object.keys(clean.theme.tokens).sort()) ===
      JSON.stringify(['--chart-1', '--dash-card-radius', '--font-ui', '--surface']), JSON.stringify(clean.theme));
  ok('export: …bounded', !!clean.theme && clean.theme.tokens['--dash-card-radius'] === 28);
  ok('export: a theme with nothing valid is no theme', !('theme' in sanitizeBundle({ pages: [], theme: { tokens: { '--bg': 'x;}' } } })));
  const html = buildSelfContainedHtml({ name: 'D', pages: [], theme: hostile }, '/*chart*/');
  ok('export: the file carries the theme', /html\.dash-themed \{[^}]*--surface: #fdfcfb;/.test(html) && /class="[^"]*dash-themed"/.test(html));
  ok('export: the theme\'s font is emitted as its full local stack', html.includes('"IBM Plex Sans", ui-sans-serif'));
  ok('export: the chart palette is the theme\'s', html.includes("var PALETTE = ['#b91c1c',"));
  ok('export: no hostile value reaches the file', !/display:none|alert\(1\)|--evil/.test(html));
  ok('export: an unthemed file is unchanged by the feature', !buildSelfContainedHtml({ name: 'D', pages: [] }, '').includes('dash-themed'));

  // Publish: a published page goes through the same whitelist.
  const page = sanitizePage({ site: {}, kind: 'dashboard', dashboard: { name: 'D' }, theme: hostile });
  const assets = { chartJs: '', formatJs: '', geoMatchJs: '', coreJs: '', clientJs: '' };
  const pub = pageHtml(page, assets, 'D');
  // any: sanitizePage returns its loose Obj record; `theme` is sanitizeBundle's.
  ok('publish: a published page carries the theme, validated',
    !!page.theme && (page.theme as any).tokens['--surface'] === '#fdfcfb' && /class="[^"]*dash-themed"/.test(pub) && pub.includes('--surface: #fdfcfb;'));
  ok('publish: …with no hostile value', !/display:none|alert\(1\)|--evil/.test(pub));

  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
