// ONE-OFF RECORDER (T8.1): runs the desktop renderer's copies of shared rules —
// exactly as each differential suite loaded them — over that suite's own inputs,
// and writes the answers to scripts/fixtures/golden/<suite>.json in the wire
// codec's tagged JSON (scripts/golden.ts reads them back). It needs the desktop
// tree, so it is deleted with it in the next commit.
//
//   npm run build:ts && node scripts/record-golden.js

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { encode } from '../src/server/wire';
import { withT } from './i18nNode';
import { PERIOD_PRESETS, N_PRESETS } from '../src/analysis/dateIntel';
import type { CalendarPrefs, PeriodSpec } from '../src/analysis/dateIntel';
import * as tc from '../src/analysis/tableCalc';
import * as format from '../src/app/format';

const REPO = path.resolve(__dirname, '..');
const HUB = path.join(REPO, 'renderer', 'hub');
const OUT = path.join(__dirname, 'fixtures', 'golden');
const read = (f: string): string => fs.readFileSync(path.join(HUB, f), 'utf8');
fs.mkdirSync(OUT, { recursive: true });
function write(name: string, value: unknown): void {
  fs.writeFileSync(path.join(OUT, `${name}.json`), encode(value) + '\n');
  console.log(`wrote scripts/fixtures/golden/${name}.json`);
}
// any: the legacy scripts are untyped classic scripts run in a vm
type Any = any;

// ── test-paramsParity: dashParams.js paramSubst ─────────────────────────────
{
  const ctx = vm.createContext({ OrdFormat: require('../src/app/format') });
  vm.runInContext(read('dashParams.js'), ctx);
  const entries = [
    { name: 'threshold', kind: 'number', value: 2000 },
    { name: 'Ratio', kind: 'number', value: 0.123456789 },
    { name: 'region', kind: 'text', value: 'West' },
    { name: 'regions', kind: 'list', value: ['West', 'East'] },
    { name: 'none', kind: 'list', value: [] },
    { name: 'asof', kind: 'date', value: '2024-06-30' },
    { name: 'unset', kind: 'text', value: null },
  ];
  const texts = [
    'Orders over {{threshold}}',
    '{{ratio}} and {{ RATIO }}',
    '{{region}} vs {{regions}} ({{none}})',
    'as of {{asof}}; {{unset}}',
    'broken {{nobody}} stays',
    'no braces at all',
    '{{threshold}}{{threshold}}',
    '{ {threshold} } and {{thres hold}}',
    '',
  ];
  const out = texts.map((t) => [t, vm.runInContext(`paramSubst(${JSON.stringify(t)}, ${JSON.stringify(entries)})`, ctx)]);
  write('paramsParity', { entries, cases: out });
}

// ── test-periodLabels: periodPicker.js periodLabel ──────────────────────────
{
  const ctx = vm.createContext(withT({ OrdFormat: require('../src/app/format') }));
  vm.runInContext(read('periodPicker.js'), ctx);
  const specs: PeriodSpec[] = [];
  for (const p of PERIOD_PRESETS) {
    if (p === 'custom') specs.push({ preset: p, from: '2024-01-01', to: '2024-03-31' }, { preset: p, from: '2024-01-01' }, { preset: p, to: '2024-03-31' });
    else if (N_PRESETS.has(p)) specs.push({ preset: p, n: 1 }, { preset: p, n: 12 });
    else specs.push({ preset: p });
  }
  const cals: Array<[string, CalendarPrefs]> = [
    ['fy1', { weekStart: 1, fiscalYearStart: 1 }],
    ['fy7', { weekStart: 1, fiscalYearStart: 7 }],
    ['454', { weekStart: 1, fiscalYearStart: 1, calendarType: '454', yearEnd: 'nearest' }],
    ['iso', { weekStart: 1, fiscalYearStart: 7, calendarType: 'iso', yearEnd: 'nearest' }],
  ];
  const cases: Array<[string, CalendarPrefs, PeriodSpec, string]> = [];
  for (const [name, cal] of cals) {
    for (const spec of specs) cases.push([name, cal, spec, vm.runInContext(`wsFormats = ${JSON.stringify(cal)}; periodLabel(${JSON.stringify(spec)})`, ctx)]);
  }
  write('periodLabels', { cases });
}

// ── renderResult: ALL_CHART_TYPE_IDS (test-visual-chart-ids, -analytics) and VIZ_LABELS (-analysisPlan) ──
{
  const rr = read('renderResult.ts');
  const m = /const\s+ALL_CHART_TYPE_IDS\s*=\s*\[([\s\S]*?)\]/.exec(rr);
  const parsed = m ? (m[1].match(/'([a-z_]+)'/g) || []).map((q) => q.slice(1, -1)) : [];
  const sandbox: Record<string, Any> = { console };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.document = undefined;
  sandbox.localStorage = undefined;
  vm.createContext(withT(sandbox));
  const got = vm.runInContext(read('renderResult.js') + '\n;({ALL_CHART_TYPE_IDS, VIZ_LABELS});', sandbox);
  const specCtx: Record<string, unknown> = {};
  vm.createContext(specCtx);
  vm.runInContext(read('chartTypeSpec.js') + '\n;this.resolveChartType = resolveChartType;', specCtx);
  const resolve = specCtx.resolveChartType as (t: string) => { overlayKinds: string[] };
  write('chartIds', {
    // The literal as test-visual-chart-ids / test-analytics parsed it from renderResult.ts.
    parsedIds: parsed,
    // The evaluated list and labels test-analysisPlan read from renderResult.js.
    allChartTypeIds: Array.from(got.ALL_CHART_TYPE_IDS as string[]),
    vizLabels: { ...got.VIZ_LABELS },
    // chartTypeSpec.js resolveChartType(id).overlayKinds, per parsed id (test-analytics §5).
    overlayKinds: Object.fromEntries(parsed.map((id) => [id, Array.from(resolve(id).overlayKinds)])),
  });
}

// ── test-captions: chartShapes.js waterfallSteps / paretoShape ──────────────
{
  const shapes = require('../renderer/hub/chartShapes') as Any;
  const s1 = (name: string, values: (number | null)[]) => [{ name, values }];
  const WF: Array<{ name: string; data: Any; totals?: string[] }> = [
    { name: 'plain steps', data: { labels: ['a', 'b', 'c'], series: s1('v', [0.1, 0.2, 0.3]) } },
    { name: 'opening total', data: { labels: ['Total', 'x', 'y'], series: s1('v', [1e6 / 3, -123.45, 7e-3]) } },
    { name: 'empty subtotal mid-way', data: { labels: ['a', 'Subtotal', 'b', 'Grand total'], series: s1('v', [5, null, 2, null]) } },
    { name: 'override total', data: { labels: ['Open', 'a', 'b'], series: [{ name: 'v', values: [10, 'x', -3] }] }, totals: ['Open'] },
    { name: 'bridge', data: { labels: ['e', 'w', 'Total', 'n'], series: [
      { name: 'p', values: [0.1, 0.7, 99, null] }, { name: 'q', values: [0.3, null, 1, 0.2] }] } },
    { name: 'empty', data: { labels: [], series: s1('v', []) } },
  ];
  const PARETO: Array<{ name: string; data: Any }> = [
    { name: 'spread', data: { labels: ['a', 'b', 'c', 'd', 'e'], series: s1('v', [30, 20, 5, 35, 10]) } },
    { name: 'exact 80 in floats', data: { labels: ['a', 'b', 'c'], series: s1('v', [0.1, 0.7, 0.2]) } },
    { name: 'ties', data: { labels: ['a', 'b', 'c', 'd'], series: s1('v', [2, 2, 2, 2]) } },
    { name: 'negatives and nulls', data: { labels: ['a', 'b', 'c', 'd'], series: s1('v', [-5, null, 3, 1]) } },
    { name: 'all zero', data: { labels: ['a', 'b'], series: s1('v', [0, 0]) } },
    { name: 'long tail', data: { labels: Array.from({ length: 40 }, (_, i) => 'c' + i),
                                 series: s1('v', Array.from({ length: 40 }, (_, i) => 1 / (i + 1))) } },
  ];
  write('captions', {
    waterfall: Object.fromEntries(WF.map((f) => [f.name, shapes.waterfallSteps(f.data.labels, f.data.series, f.totals)])),
    pareto: Object.fromEntries(PARETO.map((f) => [f.name, shapes.paretoShape(f.data.labels, f.data.series[0].values)])),
  });
}

// ── One string declared twice: execMenu.ts (test-ai-naming), homeAsk.ts (test-sampleProject) ──
{
  const ai = /^const AI_NOT_CONFIGURED = '([^']*)';$/m.exec(read('execMenu.ts'));
  const sample = /^const HA_SAMPLE_DATASET = '([^']*)';$/m.exec(read('homeAsk.ts'));
  const sf = read('settingsFormats.ts');
  const sfList = sf.slice(sf.indexOf('const SF_SWATCHES'), sf.indexOf('];', sf.indexOf('const SF_SWATCHES')));
  write('declaredTwice', {
    aiNotConfigured: ai ? ai[1] : null,
    sampleDatasetName: sample ? sample[1] : null,
    settingsSwatches: (sfList.match(/#[0-9a-f]{6}/gi) || []).map((h) => h.toLowerCase()),
  });
}

// ── test-tableCalc: calcMenu.js tcCalcLabel / tcCalcParts ───────────────────
{
  const ctx = vm.createContext(withT({ OrdFormat: format, window: {}, document: {} }));
  const mirror = vm.runInContext(read('calcMenu.js') + '\n;({ tcCalcLabel, tcCalcParts });', ctx) as Any;
  const values = [0, 0.241, -0.5, 1, 3, 112.44, 1234567, -2500, null, NaN];
  const raws = [null, 0, 1_250_000, -42];
  const cases: unknown[] = [];
  for (const kind of tc.TABLE_CALC_KINDS) {
    for (const v of values) for (const raw of raws) cases.push([kind, v, raw, mirror.tcCalcLabel(kind, v, raw), JSON.stringify(mirror.tcCalcParts(kind, v, raw))]);
  }
  write('tableCalc', { cases });
}

// ── test-dashboardStyleParity: dashStyle.ts's copy of the preset enum ───────
{
  const renderer = read('dashStyle.ts');
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
  const parseList = (name: string): string[] => {
    const m = new RegExp('const ' + name + " = \\[([^\\]]*)\\]").exec(renderer);
    return m ? (m[1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1)) : [];
  };
  write('dashboardStyle', {
    presets: parsePresetTable(renderer, 'const DASH_STYLE_PRESETS'),
    defaultStyle: parsePresetTable('X = {d: ' + (/const DASH_STYLE_DEFAULT = (\{[^}]*\})/.exec(renderer) || ['', '{}'])[1] + '}\n};', 'X').d,
    axes: { theme: parseList('DASH_THEMES'), density: parseList('DASH_DENSITIES'), accent: parseList('DASH_ACCENTS') },
  });
}

// ── test-chartFormat: fmtApply.js's copies of main's lists ──────────────────
{
  // The test's own load chain (test-chartFormat.ts, "What buildChart draws").
  const SCRIPTS = [
    'chartTraits.js', 'chartPalette.js', 'chartTypeSpec.js', 'chartShapes.js', 'chartFamiliesExtra.js', 'chartFamiliesPlugins.js',
    'chartValueLabels.js', 'chartAnnotations.js', 'chartDatasets.js', 'chartScales.js', 'chartRender.js', 'calcMenu.js', 'chartTable.js',
  ];
  const sandbox: Record<string, Any> = { console };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.matchMedia = () => ({ matches: false });
  sandbox.document = { documentElement: {}, createElement: () => ({ style: {}, getContext: () => null }) };
  sandbox.requestAnimationFrame = (f: () => void) => f;
  sandbox.cancelAnimationFrame = () => {};
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sandbox.hubFormat = { getColorMap: () => Promise.resolve({}), assignColors: () => new Promise(() => {}) };
  vm.createContext(withT(sandbox));
  vm.runInContext(fs.readFileSync(path.join(REPO, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), 'utf8'), sandbox);
  const PRELUDE = `
function _fmtVal(v) { return v == null ? '' : String(v); }
function fmtWith(v, mode) { return mode + ':' + v; }
function histogramBins(values) { return { labels: values.map(String), counts: values.map(function(){return 1;}) }; }
var currentProjectId = 'p1';
`;
  const hub = (files: string[]): string => files.map((f) => '\n// ==== ' + f + ' ====\n' + read(f)).join('\n');
  const src = PRELUDE + hub(SCRIPTS)
    + '\nwindow.module = { exports: {} }; window.exports = window.module.exports;\n'
    + fs.readFileSync(path.join(REPO, 'src', 'analysis', 'colorMap.js'), 'utf8')
    + hub(['fmtColors.js', 'fmtApply.js', 'formatPanel.js']);
  const api = vm.runInContext(src + '\n;({ FMT_DUAL_AXIS_TYPES, fmtMeasureNames });', sandbox) as Any;
  const TWO = { values: [{ column: 'revenue', aggregation: 'sum' }, { column: 'price', aggregation: 'avg' }] };
  const encs = [TWO, { values: [{ column: 'n', aggregation: 'count' }, { column: 'p', aggregation: 'none' }] }, { values: [] }];
  write('chartFormat', {
    dualAxisTypes: Array.from(api.FMT_DUAL_AXIS_TYPES as Iterable<string>),
    measureNames: encs.map((enc) => [enc, Array.from(api.fmtMeasureNames(enc) as string[])]),
  });
}

// ── test-storyTextPort: storyText.js over the suite's corpus ────────────────
{
  const legacy = require('../renderer/hub/storyText.js') as Record<string, (x: Any) => unknown>;
  const TEXTS = [
    '',
    '\n\n  \n',
    'Revenue **rose** in *Q3*, see `order_date` and [the docs](https://example.com).',
    '[x](javascript:alert(1))',
    '<img src=x onerror=alert(1)>',
    '2 * 3 = 6 and **unclosed',
    'an _aside_ and __double__ and ***triple***',
    '# Title\n\nFirst line\nsecond line\n\n- a\n- b\n1. one\n2. two\n> quoted\n### Small',
    '#### deep\n#sales tag\n##  spaced  heading  ',
    'Intro before any heading\n## Section one\nBody of one\n\n## Section two\n- x\n* y\n3) three',
    '# One\n### stays inside\ntext\n# Two',
    'trailing spaces   \n\t\n> q1\n> q2\nplain',
  ];
  const STORIES = [
    [],
    [{ id: 'a', kind: 'text', text: '' }],
    [{ id: 'a', kind: 'visual', visualId: 'v' }, { id: 'b', kind: 'text', text: 'Hello' }],
    TEXTS.map((text, i) => ({ id: 't' + i, kind: 'text', text })),
    [
      { id: 'h', kind: 'text', text: '# Revenue\nIt grew.\n## By region\nWest leads.' },
      { id: 'v', kind: 'visual', visualId: 'v1' },
      { id: 'm', kind: 'metrics_row', metricIds: ['m1'] },
      { id: 'c', kind: 'callout', tone: 'info', text: '# not a page break' },
      { id: 'd', kind: 'divider' },
      { id: 'z', kind: 'text', text: '### small\nstill section two\n# Close\n' },
    ],
  ];
  write('storyText', {
    texts: TEXTS.map((t) => ({ text: t, inline: t.split('\n').map((line) => legacy.mdInline(line)), parse: legacy.mdParse(t), plain: legacy.mdPlain(t) })),
    stories: STORIES.map((blocks) => ({ blocks, outline: legacy.storyOutline(blocks), pages: legacy.storyPages(blocks) })),
  });
}

// ── test-wordCloud: wordCloudLayout.js's copy of the category cap ───────────
{
  const wc = require('../renderer/hub/wordCloudLayout') as Any;
  write('wordCloud', { categoryCap: wc.WC_CATEGORY_CAP, otherLabel: wc.WC_OTHER_LABEL });
}

// ── web/src/charts/palette.test.ts: chartPalette.js brandTokens / valueRamp / rampColor ──
// (the ramp checks of test-branding and test-chartFormat, which moved to the web port)
{
  const ctx = vm.createContext({});
  vm.runInContext(read('chartPalette.js'), ctx);
  const branding = require('../src/app/branding') as typeof import('../src/app/branding');
  const seeds = [...branding.ACCENT_SWATCHES, '#ffff00', '#ffffff', '#000000', '#00ff00', '#808080', '#1a1a1a', '#ff00ff', '#7fffd4', '#2563eb', '#7c3aed', '#16a34a', 'red', '#12345'];
  const call = (expr: string): unknown => vm.runInContext(expr, ctx);
  const props = new Map<string, string>();
  (ctx as Any).__el = { style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) } };
  call(`applyBrandTokens(__el, '#7c3aed')`);
  const applied = Object.fromEntries(props);
  const ramps: unknown[] = [];
  for (const seed of seeds) for (const kind of ['sequential', 'diverging']) for (const surface of ['#ffffff', '#1c1c20']) {
    ramps.push([kind, seed, surface, call(`Array.from(valueRamp(${JSON.stringify(kind)}, ${JSON.stringify(seed)}, ${JSON.stringify(surface)}))`)]);
  }
  const colors: unknown[] = [];
  const seq = call(`valueRamp('sequential', '#2563eb', '#ffffff')`) as string[];
  const div = call(`valueRamp('diverging', '#2563eb', '#ffffff')`) as string[];
  for (const [kind, ramp] of [['sequential', seq], ['diverging', div]] as Array<[string, string[]]>) {
    for (const [v, min, max] of [[-10, -10, 10], [0, -10, 10], [10, -10, 10], [1, 1, 9], [9, 1, 9], [5, 1, 9], [3, 3, 3], [NaN, 0, 1]]) {
      colors.push([kind, Array.from(ramp), v, min, max, call(`rampColor(${JSON.stringify(ramp)}, ${JSON.stringify(kind)}, ${v}, ${min}, ${max})`)]);
    }
  }
  const out = path.join(REPO, 'web', 'src', 'charts', '__golden__');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'palette.json'), encode({
    darkSurfaces: Array.from(call('BRAND_DARK_SURFACES') as string[]),
    brandTokens: seeds.map((seed) => [seed, JSON.parse(JSON.stringify(call(`brandTokens(${JSON.stringify(seed)})`)))]),
    applied,
    ramps,
    colors,
  }) + '\n');
  console.log('wrote web/src/charts/__golden__/palette.json');
}
