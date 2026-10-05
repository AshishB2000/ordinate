// Formatting depth: the config rules main clamps (src/analysis/chartFormat.ts),
// the visual sanitizer that calls them, the offline export's colours, and
// main's lists against the desktop Format panel's recorded copies. (What a
// config DRAWS and the value palettes' contrast are the web chart engine's:
// web/src/charts/fmt.test.ts and palette.test.ts.)
//
//   · log scale: min <= 0, max <= 0 and a 100% chart are refused; a log axis
//     over data with a zero or a negative in it is drawn linear;
//   · dual axis: only on combo / line / column kinds, only the visual's own
//     measures, never a series split, and at least one measure stays left;
//   · the sanitizer clamps a bad config on save, on update, and when the chart
//     type changes under a config that was valid;
//
//   npm run build:ts && node scripts/test-chartFormat.js

export {};
import { ok, failureCount, finish } from './selfcheck';
import { withT } from './i18nNode';
import { golden } from './golden';

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
  vm.createContext(withT(box));
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

// ── The desktop's copies of main's lists ───────────────────────────────────
// The desktop's Format panel (fmtApply.js / formatPanel.js) kept its own copies
// of these two; they were recorded when the desktop app went (T8.1) —
// scripts/fixtures/golden/chartFormat.json — and main is held to them. What a
// config DRAWS is the web chart engine's (web/src/charts/fmt.test.ts, against the
// desktop's recorded configs); the value-palette contrast checks moved with the
// palette to web/src/charts/palette.test.ts.
{
  const G = golden<{ dualAxisTypes: string[]; measureNames: Array<[{ values: Array<{ column: string; aggregation: string }> }, string[]]> }>('chartFormat');
  ok('the desktop offered a dual axis on exactly main\'s kinds',
    same([...G.dualAxisTypes].sort(), [...cf.DUAL_AXIS_TYPES].sort()));
  ok('the fixture holds the three encodings', G.measureNames.length === 3);
  for (const [enc, names] of G.measureNames) {
    ok(`the desktop and main name measures alike (${JSON.stringify(enc.values.map((x) => x.aggregation))})`,
      same(names, cf.measureNames(enc as any)));
  }
}

storage().then(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
  finish();
  if (failureCount()) process.exit(1);
}).catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
