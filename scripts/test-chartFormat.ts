// Formatting depth: the config rules main clamps (src/analysis/chartFormat.ts),
// the visual sanitizer that calls them, what buildChart then DRAWS from a
// config (renderer/hub/fmtApply.ts in a vm, the chart harness's way), and the
// value palettes' contrast in both themes (renderer/hub/chartPalette.ts).
//
//   · log scale: min <= 0, max <= 0 and a 100% chart are refused; a log axis
//     over data with a zero or a negative in it is drawn linear;
//   · dual axis: only on combo / line / column kinds, only the visual's own
//     measures, never a series split, and at least one measure stays left;
//   · the sanitizer clamps a bad config on save, on update, and when the chart
//     type changes under a config that was valid;
//   · sequential and diverging ramps hold 3:1 on the light surface and on both
//     dark ones, for the accent swatches and hostile seeds.
//
//   npm run build:ts && node scripts/test-chartFormat.js

export {};
import { ok, failureCount, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-chartformat-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: () => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

const cf: typeof import('../src/analysis/chartFormat') = require('../src/analysis/chartFormat');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const branding: typeof import('../src/app/branding') = require('../src/app/branding');

const REPO = path.resolve(__dirname, '..');
const HUB = path.join(REPO, 'renderer', 'hub');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const TWO = { values: [{ column: 'revenue', aggregation: 'sum' }, { column: 'price', aggregation: 'avg' }] };
const v = (raw: unknown, chartType = 'line', encoding: any = TWO) => cf.validateFormat(raw, { chartType, encoding });

// ── Log scale ──────────────────────────────────────────────────────────────
ok('a log axis with no bounds is valid', same(v({ axes: { y: { log: true } } }).value, { axes: { y: { log: true } } }));
ok('…and with min above 0', v({ axes: { y: { log: true, min: 1, max: 1000 } } }).errors.length === 0);
{
  const r = v({ axes: { y: { log: true, min: 0 } } });
  ok('log + min 0 is invalid', r.errors.some((e) => /log scale needs min above 0/.test(e)), JSON.stringify(r.errors));
  ok('…and the log is dropped, the min kept', same(r.value, { axes: { y: { min: 0 } } }), JSON.stringify(r.value));
}
ok('log + a negative min is invalid', v({ axes: { y: { log: true, min: -5 } } }).value.axes!.y!.log === undefined);
ok('log + max <= 0 is invalid', v({ axes: { y: { log: true, max: -1 } } }).errors.length === 1);
ok('a 100% chart cannot take a log axis',
  v({ axes: { y: { log: true } } }, 'pct_stacked_column').value.axes === undefined);
ok('a right axis can be log on its own', same(v({ axes: { y2: { log: true } } }).value, { axes: { y2: { log: true } } }));

// ── Ranges, formats, ticks ─────────────────────────────────────────────────
ok('min below max is kept', same(v({ axes: { x: { min: 0, max: 10 } } }).value, { axes: { x: { min: 0, max: 10 } } }));
{
  const r = v({ axes: { y: { min: 10, max: 10 } } });
  ok('min equal to max is invalid, and both go', r.errors.length === 1 && r.value.axes === undefined, JSON.stringify(r));
}
ok('min above max is invalid', v({ axes: { y: { min: 5, max: 1 } } }).value.axes === undefined);
for (const bad of [NaN, Infinity, '5', null, {}]) {
  ok(`min ${JSON.stringify(bad) ?? String(bad)} is not a number and is dropped`,
    v({ axes: { y: { min: bad } } }).value.axes === undefined);
}
ok('a known number format, tick density and hide survive',
  same(v({ axes: { y: { format: 'currency', ticks: 'few', hide: true } } }).value.axes, { y: { format: 'currency', ticks: 'few', hide: true } }));
ok('unknown format / ticks / axis keys are dropped',
  v({ axes: { y: { format: 'roman', ticks: 'lots' }, z: { hide: true } } }).value.axes === undefined);

// ── Dual axis ──────────────────────────────────────────────────────────────
ok('a combo may put one of two measures on the right',
  same(v({ y2Series: ['avg of price'] }, 'combo').value.y2Series, ['avg of price']));
ok('…so may a line and a column', v({ y2Series: ['avg of price'] }, 'line').errors.length === 0
  && v({ y2Series: ['avg of price'] }, 'column').errors.length === 0);
ok('an empty list is a valid assignment (everything left)', same(v({ y2Series: [] }, 'combo').value.y2Series, []));
for (const t of ['pie', 'bar', 'stacked_column', 'scatter', 'heatmap']) {
  const r = v({ y2Series: ['avg of price'] }, t);
  ok(`no dual axis on ${t}`, r.value.y2Series === undefined && r.errors.length === 1, JSON.stringify(r.errors));
}
{
  const r = v({ y2Series: ['avg of price', 'max of stock'] }, 'combo');
  ok('a measure the visual does not have is refused', same(r.value.y2Series, ['avg of price'])
    && r.errors.some((e) => /max of stock/.test(e)), JSON.stringify(r));
}
{
  const r = v({ y2Series: ['sum of revenue', 'avg of price'] }, 'combo');
  ok('every measure on the right is invalid — one must stay left',
    r.value.y2Series === undefined && r.errors.some((e) => /at least one measure/.test(e)), JSON.stringify(r.errors));
}
ok('a split encoding has values for series, not measures',
  v({ y2Series: ['East'] }, 'line', { values: TWO.values, series: 'region' }).value.y2Series === undefined);
ok('without the encoding a dual axis cannot be checked, so it is dropped',
  cf.validateFormat({ y2Series: ['avg of price'] }, { chartType: 'combo' }).value.y2Series === undefined);
ok('measure names follow vizData: count is the column, none has both spellings',
  same(cf.measureNames({ values: [{ column: 'n', aggregation: 'count' }, { column: 'p', aggregation: 'none' }] }), ['n', 'sum of p', 'p']));

// ── The rest of the keys ───────────────────────────────────────────────────
{
  const r = v({
    labelFormat: 'percent', labelPosition: 'inside', sortOrder: ['b', 'a', 'b', 5],
    seriesColors: { 'sum of revenue': 'chart-3', x: '#ff0000' }, colorByCategory: true,
    measurePalettes: { 'avg of price': 'diverging', 'avg of stock': 'sequential', 'sum of revenue': 'rainbow' },
    y2AxisLabel: 'Price',
  });
  ok('label format and position are kept', r.value.labelFormat === 'percent' && r.value.labelPosition === 'inside');
  ok('a custom order keeps unique strings only', same(r.value.sortOrder, ['b', 'a']));
  ok('series colours keep ramp slots only', same(r.value.seriesColors, { 'sum of revenue': 'chart-3' }));
  ok('value palettes keep the visual\'s measures and known kinds', same(r.value.measurePalettes, { 'avg of price': 'diverging' }));
  ok('colorByCategory and the right-axis title survive', r.value.colorByCategory === true && r.value.y2AxisLabel === 'Price');
}
ok('junk never throws and yields nothing', [null, 3, 'x', [], { axes: 'y' }].every((j) => same(cf.validateFormat(j).value, {})));

// ── The visual sanitizer clamps, never trusts ──────────────────────────────
{
  const bad = { yZero: true, axes: { y: { log: true, min: -1, max: 5 } }, y2Series: ['sum of revenue', 'avg of price'], sort: 'custom', sortOrder: ['x'] };
  const out: any = visuals.sanitizeOverrides(bad, { chartType: 'combo', encoding: TWO as any });
  ok('sanitizeOverrides drops the invalid log and the all-right dual axis',
    same(out.axes, { y: { min: -1, max: 5 } }) && out.y2Series === undefined, JSON.stringify(out));
  ok('…keeps what was valid, including the new sort mode', out.yZero === true && out.sort === 'custom' && same(out.sortOrder, ['x']));
  ok('…and without a context it trusts no dual axis', (visuals.sanitizeOverrides({ y2Series: ['avg of price'] }) as any).y2Series === undefined);
  const snap: any = dashboards.sanitizeCardVisual({ datasetId: 'd', chartType: 'pie', encoding: TWO, overrides: { y2Series: ['avg of price'], labelPosition: 'center' } });
  ok('a published snapshot is clamped against its own type', snap.overrides.y2Series === undefined && snap.overrides.labelPosition === 'center');
}

// ── The offline export's colours pass the bundle whitelist as integers only ──
{
  const dx: typeof import('../src/analysis/dashboardExport') = require('../src/analysis/dashboardExport');
  const card = (extra: any) => dx.sanitizeBundle({ pages: [{ cards: [{
    kind: 'chart', chartType: 'pie', layout: { x: 0, y: 0, w: 6, h: 4 },
    data: { labels: ['a', 'b', 'c'], series: [{ label: 's', values: [1, 2, 3] }] }, ...extra,
  }] }] }).pages[0].cards[0] as any;
  ok('export: ramp slots 0–7 survive the whitelist', same(card({ slots: [0, 4, 7], seriesSlots: [2] }).slots, [0, 4, 7])
    && same(card({ seriesSlots: [2] }).seriesSlots, [2]));
  for (const bad of [[0, 8, 1], [0, '1', 2], ['#ff0000'], [0.5], [-1], [0, 1, 2, 3], 'chart-1', { 0: 1 }, []]) {
    const c = card({ slots: bad });
    ok(`export: slots ${JSON.stringify(bad)} are dropped whole`, c.slots === undefined, JSON.stringify(c.slots));
  }
  ok('export: no caller text reaches the render script through a slot',
    !JSON.stringify(card({ slots: ['</script><script>alert(1)</script>'] })).includes('script'));

  // Run the exported file's own scripts against a stub Chart and a stub DOM,
  // and read the colours they hand Chart.js.
  const html = dx.buildSelfContainedHtml({ name: 'X', pages: [{ cards: [
    { kind: 'chart', chartType: 'pie', layout: { x: 0, y: 0, w: 6, h: 4 }, slots: [2, 0, 5],
      data: { labels: ['a', 'b', 'c'], series: [{ label: 's', values: [1, 2, 3] }] } },
    { kind: 'chart', chartType: 'pie', layout: { x: 6, y: 0, w: 6, h: 4 },
      data: { labels: ['a', 'b'], series: [{ label: 's', values: [1, 2] }] } },
    { kind: 'chart', chartType: 'bar', layout: { x: 0, y: 4, w: 6, h: 4 }, seriesSlots: [3, 1],
      data: { labels: ['a'], series: [{ label: 's', values: [1] }, { label: 't', values: [2] }] } },
  ] }] }, 'window.Chart = function (_c, cfg) { window.__cfgs.push(cfg); };');
  const el = (): any => ({ style: {}, appendChild(c: any) { return c; }, getContext: () => ({}) });
  const box: any = { __cfgs: [], document: { title: '', createElement: el, getElementById: el } };
  box.window = box;
  vm.createContext(box);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1], box);
  const ramp = dx.accentRamp(dashboards.sanitizeStyle(undefined)).chart;
  const [pie, plain, bars] = box.__cfgs;
  ok('export file: a pie draws each slice in its slot',
    !!pie && same(pie.data.datasets[0].backgroundColor, [ramp[2], ramp[0], ramp[5]]), JSON.stringify(pie && pie.data.datasets[0]));
  ok('export file: a pie with no slots gets one colour per slice, not one for the whole pie',
    !!plain && same(plain.data.datasets[0].backgroundColor, [ramp[0], ramp[1]]));
  ok('export file: series slots colour each series',
    !!bars && bars.data.datasets[0].backgroundColor === ramp[3] && bars.data.datasets[1].backgroundColor === ramp[1]);
}

// ── …through storage: save, update, and a type change under a valid config ──
async function storage(): Promise<void> {
  await projects.init();
  const p = await projects.createProject('Format');
  const ds = await datasets.saveDataset(p.id, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }, { name: 'price', type: 'number' }],
    rows: [['East', 10, 2], ['West', 20, 3]],
  } as any);
  const saved = await visuals.saveVisual(p.id, {
    name: 'Dual', datasetId: ds!.id, chartType: 'combo',
    encoding: { category: 'region', values: TWO.values },
    overrides: { y2Series: ['avg of price'], axes: { y2: { log: true }, y: { min: 3, max: 1 } } },
  });
  ok('saveVisual keeps a valid dual axis and drops the bad range',
    !!saved && same(saved.overrides.y2Series, ['avg of price']) && same(saved.overrides.axes, { y2: { log: true } }),
    JSON.stringify(saved && saved.overrides));
  const upd = await visuals.updateVisual(p.id, saved!.id, { chartType: 'pie' });
  ok('turning it into a pie clamps the dual axis away', !!upd && upd.overrides.y2Series === undefined, JSON.stringify(upd && upd.overrides));
  const back = await visuals.updateVisual(p.id, saved!.id, { overrides: { axes: { y: { log: true, min: 0 } } } });
  ok('updateVisual clamps a patched log + min 0', !!back && same(back.overrides.axes, { y: { min: 0 } }));
  const read = await visuals.getVisual(p.id, saved!.id);
  ok('…and the stored file reads back clamped', !!read && same(read.overrides.axes, { y: { min: 0 } }));
}

// ── What buildChart draws from a config (the renderer pass) ───────────────
const CHART_UMD = path.join(REPO, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const SCRIPTS = [
  'chartTraits.js', 'chartPalette.js', 'chartTypeSpec.js', 'chartShapes.js', 'chartFamiliesExtra.js', 'chartFamiliesPlugins.js',
  'chartValueLabels.js', 'chartDatasets.js', 'chartScales.js', 'chartRender.js', 'chartTable.js',
];
const THEME: Record<string, string> = {
  '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6', '--chart-4': '#6366f1',
  '--chart-5': '#64748b', '--chart-6': '#b45309', '--chart-7': '#be185d', '--chart-8': '#4d7c0f',
  '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff', '--text-strong': '#111827',
  '--font-ui': 'Inter, sans-serif', '--accent': '#2563eb', '--ok': '#16a34a', '--error': '#dc2626',
};
const recorded: any[] = [];
const persisted: any[] = [];
const sandbox: Record<string, any> = { console };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.matchMedia = () => ({ matches: false });
sandbox.document = { documentElement: {}, createElement: () => ({ style: {}, getContext: () => null }) };
sandbox.requestAnimationFrame = (f: Function) => f;
sandbox.cancelAnimationFrame = () => {};
sandbox.getComputedStyle = () => ({ getPropertyValue: (n: string) => THEME[n] || '' });
sandbox.hubFormat = {
  getColorMap: () => Promise.resolve({}),
  assignColors: (pid: string, column: string, values: unknown[]) => { persisted.push({ pid, column, values }); return new Promise(() => {}); },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(CHART_UMD, 'utf8'), sandbox, { filename: 'chart.umd.js' });
const RealChart = sandbox.Chart;
function Rec(this: any, _c: unknown, config: any) { recorded.push(config); this.config = config; }
(Rec as any).defaults = RealChart.defaults;
(Rec as any).overrides = RealChart.overrides;
(Rec as any).register = () => {};
sandbox.Chart = Rec;
const PRELUDE = `
function _fmtVal(v) { return v == null ? '' : String(v); }
function fmtWith(v, mode) { return mode + ':' + v; }
function histogramBins(values) { return { labels: values.map(String), counts: values.map(function(){return 1;}) }; }
var currentProjectId = 'p1';
`;
const hub = (files: string[]) => files.map((f) => '\n// ==== ' + f + ' ====\n' + fs.readFileSync(path.join(HUB, f), 'utf8')).join('\n');
// The shared colour rule loads the way index.html loads it: the CommonJS shim,
// then src/analysis/colorMap.js, then fmtColors.js binding it — AFTER the chart
// scripts, since chartShapes.js exports itself wherever `module` exists.
const src = PRELUDE + hub(SCRIPTS)
  + '\nwindow.module = { exports: {} }; window.exports = window.module.exports;\n'
  + fs.readFileSync(path.join(REPO, 'src', 'analysis', 'colorMap.js'), 'utf8')
  + hub(['fmtColors.js', 'fmtApply.js', 'formatPanel.js']);
const api: any = vm.runInContext(src + `
;({ buildChart, fmtAdoptColorMap, fmtWithScope, fmtMeasureNames, FMT_DUAL_AXIS_TYPES, fmtExportSlots,
    valueRamp, rampColor, brandContrast, BRAND_DARK_SURFACES, getMap: function () { return fmtColorMap; } });`,
sandbox, { filename: 'format-family.js' });

function draw(type: string, data: any, overrides: any): any {
  recorded.length = 0;
  api.buildChart({}, JSON.parse(JSON.stringify(data)), type, overrides);
  return recorded[0];
}
const DATA2 = { labels: ['East', 'West', 'North'], series: [{ name: 'sum of revenue', values: [100, 1000, 10] }, { name: 'avg of price', values: [2, 3, 4] }] };
const DATA1 = { labels: ['East', 'West', 'North'], series: [{ name: 'sum of revenue', values: [100, 1000, 10] }] };

{
  const c = draw('column', DATA1, { yAxisLabel: 'Revenue', axes: { y: { log: true, ticks: 'few', format: 'currency' } }, legendPosition: 'bottom' });
  ok('log scale draws a logarithmic y axis', c.options.scales.y.type === 'logarithmic', c.options.scales.y.type);
  ok('…with its title, tick density and number format',
    c.options.scales.y.title.text === 'Revenue' && c.options.scales.y.ticks.maxTicksLimit === 4
      && c.options.scales.y.ticks.callback(5) === 'currency:5');
  ok('legend position is what was asked', c.options.plugins.legend.position === 'bottom');
  const neg = draw('column', { labels: ['a', 'b'], series: [{ name: 's', values: [5, -2] }] }, { axes: { y: { log: true } } });
  ok('a log axis over a negative value is drawn linear', neg.options.scales.y.type !== 'logarithmic');
  const zeroMin = draw('column', DATA1, { yZero: true, axes: { y: { log: true } } });
  ok('start-at-zero does not survive onto a log axis', zeroMin.options.scales.y.type === 'logarithmic' && zeroMin.options.scales.y.min === undefined);
  const r = draw('column', DATA1, { axes: { y: { min: 5, max: 2000 }, x: { hide: true, ticks: 'many' } } });
  ok('min / max reach the value axis', r.options.scales.y.min === 5 && r.options.scales.y.max === 2000);
  ok('hide and tick density reach the category axis', r.options.scales.x.display === false && r.options.scales.x.ticks.maxTicksLimit === 16);
  const h = draw('bar', DATA1, { axes: { x: { min: 1 } } });
  ok('on a horizontal bar the VALUE axis is x', h.options.scales.x.min === 1 && h.options.scales.y.min === undefined);
}
{
  const c = draw('line', DATA2, { y2Series: ['avg of price'], y2AxisLabel: 'Price', axes: { y2: { log: true } } });
  const byLabel = (n: string) => c.data.datasets.find((d: any) => d.label === n);
  ok('dual axis: the assigned measure draws on the right', byLabel('avg of price').yAxisID === 'y1' && byLabel('sum of revenue').yAxisID === 'y');
  ok('…on a right axis with its own title and scale',
    !!c.options.scales.y1 && c.options.scales.y1.position === 'right' && c.options.scales.y1.title.text === 'Price'
      && c.options.scales.y1.type === 'logarithmic');
  const combo = draw('combo', DATA2, {});
  ok('a combo with no assignment keeps its lines on the right', combo.data.datasets[1].yAxisID === 'y1' && !!combo.options.scales.y1);
  const left = draw('combo', DATA2, { y2Series: [] });
  ok('an empty assignment puts everything on the left', left.data.datasets.every((d: any) => d.yAxisID !== 'y1') && !left.options.scales.y1);
  const pie = draw('pie', DATA1, { y2Series: ['sum of revenue'] });
  ok('a pie ignores a dual axis it cannot have', !pie.options.scales.y1);
}
{
  const labels = (sort: string, order?: string[]) => draw('column', DATA1, { sort, sortOrder: order }).data.labels.join();
  ok('sort by label A → Z', labels('label_asc') === 'East,North,West');
  ok('sort by label Z → A', labels('label_desc') === 'West,North,East');
  ok('custom order: the listed labels first, the rest after in their own order',
    labels('custom', ['North', 'Nowhere']) === 'North,East,West', labels('custom', ['North', 'Nowhere']));
  ok('a sort never changes a figure', draw('column', DATA1, { sort: 'label_asc' }).data.datasets[0].data.join() === '100,10,1000');
}
{
  const labelled = draw('column', DATA1, { valueMode: 'all', labelFormat: 'percent', labelPosition: 'inside' });
  ok('data labels still draw through the valueLabels plugin', labelled.plugins.some((p: any) => p.id === 'valueLabels'));
}

// Project colours: two charts over one column, dealt from the renderer cache.
{
  api.fmtAdoptColorMap({ id: 'p1', colorMap: { region: { West: 'chart-5' } } });
  const scope = { projectId: 'p1', encoding: { category: 'region', values: [] } };
  const donut = draw('donut', DATA1, api.fmtWithScope({}, scope));
  const pie = draw('pie', { labels: ['North', 'West', 'East'], series: [{ name: 'n', values: [3, 2, 1] }] },
    api.fmtWithScope({ sort: 'desc' }, scope));
  const col = (cfg: any, label: string) => cfg.data.datasets[0].backgroundColor[cfg.data.labels.indexOf(label)];
  ok('a stored value keeps its slot (West = chart-5)', col(donut, 'West') === THEME['--chart-5'], col(donut, 'West'));
  ok('new values are dealt the lowest free slots', col(donut, 'East') === THEME['--chart-1'] && col(donut, 'North') === THEME['--chart-2']);
  ok('a second chart, other order, paints every value the same',
    ['East', 'West', 'North'].every((l) => col(pie, l) === col(donut, l)), JSON.stringify([pie.data.labels, pie.data.datasets[0].backgroundColor]));
  ok('only the deal that changed the map was persisted', persisted.length === 1 && persisted[0].column === 'region');
  const unscoped = draw('pie', DATA1, {});
  ok('a chart with no dataset keeps its own palette walk', unscoped.data.datasets[0].backgroundColor[0] === THEME['--chart-1']);
  const bars = draw('column', DATA1, api.fmtWithScope({ colorByCategory: true }, scope));
  ok('"Colour bars by category" paints each bar from the map', typeof bars.data.datasets[0].backgroundColor === 'function');
  const split = draw('line', DATA2, api.fmtWithScope({}, { projectId: 'p1', encoding: { category: 'region', series: 'segment', values: [] } }));
  ok('split series are dealt from their column\'s map', split.data.datasets[0].borderColor === THEME['--chart-1']
    && Object.keys(api.getMap().segment || {}).length === 2);
  const own = draw('line', DATA2, { seriesColors: { 'avg of price': 'chart-7' } });
  ok('a measure series takes the visual\'s own colour', own.data.datasets[1].borderColor === THEME['--chart-7']);
  const exp = api.fmtExportSlots('pie', { encoding: { category: 'region' }, overrides: {} }, DATA1);
  ok('an export carries the same colours as ramp slots', same(exp.slots, [0, 4, 1]), JSON.stringify(exp));
  const vp = draw('column', DATA1, { measurePalettes: { 'sum of revenue': 'sequential' } });
  const bg = vp.data.datasets[0].backgroundColor;
  ok('a value palette colours each bar by its value', Array.isArray(bg) && bg[1] !== bg[2], JSON.stringify(bg));
}

// The renderer's copies of main's lists, pinned together.
ok('the renderer offers a dual axis on exactly main\'s kinds',
  same([...api.FMT_DUAL_AXIS_TYPES].sort(), [...cf.DUAL_AXIS_TYPES].sort()));
for (const enc of [TWO, { values: [{ column: 'n', aggregation: 'count' }, { column: 'p', aggregation: 'none' }] }, { values: [] }]) {
  ok(`renderer and main name measures alike (${JSON.stringify(enc.values.map((x: any) => x.aggregation))})`,
    same(api.fmtMeasureNames(enc), cf.measureNames(enc as any)));
}

// ── Value palettes: contrast in both themes ────────────────────────────────
// WCAG contrast written out here, independently of the code under test.
function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const DARK: string[] = api.BRAND_DARK_SURFACES;
const SEEDS = [...branding.ACCENT_SWATCHES, '#ffff00', '#ffffff', '#000000', '#00ff00', '#808080', '#1a1a1a', '#ff00ff', '#7fffd4'];
for (const seed of SEEDS) {
  const fails: string[] = [];
  for (const kind of ['sequential', 'diverging']) {
    const light: string[] = api.valueRamp(kind, seed, '#ffffff');
    const dark: string[] = api.valueRamp(kind, seed, '#1c1c20');
    if (light.length !== 7 || dark.length !== 7) fails.push(kind + ' length');
    light.forEach((c, i) => { if (contrast(c, '#ffffff') < 3) fails.push(`light ${kind}[${i}] ${c}`); });
    dark.forEach((c, i) => DARK.forEach((s) => { if (contrast(c, s) < 3) fails.push(`dark ${kind}[${i}] ${c} on ${s}`); }));
    if (new Set(light).size < 4) fails.push('light ' + kind + ' has too few distinct steps');
  }
  ok(`${seed}: sequential and diverging steps all read at 3:1 in light AND dark`, fails.length === 0, fails.join('; '));
}
{
  const seq: string[] = api.valueRamp('sequential', '#2563eb', '#ffffff');
  const rising = seq.every((c, i) => i === 0 || contrast(c, '#ffffff') >= contrast(seq[i - 1], '#ffffff') - 1e-9);
  ok('a sequential ramp strengthens from the surface outward', rising);
  const div: string[] = api.valueRamp('diverging', '#2563eb', '#ffffff');
  ok('the diverging ramp maps below-zero, zero and above-zero to its ends and centre',
    api.rampColor(div, 'diverging', -10, -10, 10) === div[0] && api.rampColor(div, 'diverging', 0, -10, 10) === div[3]
      && api.rampColor(div, 'diverging', 10, -10, 10) === div[6]);
  ok('the sequential ramp maps min and max to its ends',
    api.rampColor(seq, 'sequential', 1, 1, 9) === seq[0] && api.rampColor(seq, 'sequential', 9, 1, 9) === seq[6]);
}

storage().then(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
  finish();
  if (failureCount()) process.exit(1);
}).catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
