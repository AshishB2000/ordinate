// A chart's table calculation on every published surface (review report-01 finding 5): /p/ dashboards, embeds and
// stories draw the series `visual:data` draws, and the page says what kind of figure each one is.
//
//   surfaces   running total, percent of total and moving sum: each surface's series, after the page sanitizer, is
//              Object.is-equal to visual:data's, with the same calc kind; NEGATIVE CONTROL: the raw figures differ
//   control    a chart with no calc publishes byte for byte what it did before (no `calc` key anywhere)
//   sanitizer  `calc` is a closed enum: an unknown kind, a non-string or an object is dropped
//   site       the page's formatter prints a calc the way calcParts does (0.25 of total is "25.0% of total", never
//              "0.25"); a series with no calc keeps the page's own formatter
//
//   npm run build:ts && node scripts/test-publishTableCalcs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as format from '../src/app/format';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');
const { randomUUID }: typeof import('crypto') = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-pubcalc-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: visual:data's reply, read field by field
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const tableCalc: typeof import('../src/analysis/tableCalc') = require('../src/analysis/tableCalc');
const { buildDashboard, chartPayload }: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const { buildStory }: typeof import('../src/publish/storyData') = require('../src/publish/storyData');
const { policyOutgoing, readAssets }: typeof import('../src/publish/publish') = require('../src/publish/publish');
const { sanitizePage, sanitizePayload }: typeof import('../src/publish/sanitize') = require('../src/publish/sanitize');
const { makeLock }: typeof import('../src/publish/embedLock') = require('../src/publish/embedLock');
const { labelListsFor }: typeof import('../src/ipc/valueLabelReplies') = require('../src/ipc/valueLabelReplies');
type Any = any; // any: a reply or a sanitized page, read field by field below

const show = (v: unknown): string => (JSON.stringify(v) ?? 'undefined').slice(0, 400);
const sameSeq = (a: unknown[], b: unknown[]): boolean => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// Every day of 2024, in two regions. Whole numbers, so every sum is exact.
const ROWS: Array<[string, string, number]> = [];
for (let t = Date.UTC(2024, 0, 1); t <= Date.UTC(2024, 11, 31); t += 86_400_000) {
  const n = Math.round(t / 86_400_000);
  const day = new Date(t).toISOString().slice(0, 10);
  ROWS.push([day, 'East', 100 + (n % 17)], [day, 'West', 60 + (n % 11)], [day, n % 3 ? 'North' : 'South', 5 + (n % 7)]);
}
const COLUMNS = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }] as Any;
const CALCS = [
  { name: 'Running total', encoding: { category: 'day', grain: 'month', values: [{ column: 'amount', aggregation: 'sum', calc: { kind: 'running_total', along: 'across' } }] } },
  { name: 'Share', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum', calc: { kind: 'pct_of_total', along: 'across' } }] } },
  { name: 'Moving sum', encoding: { category: 'day', grain: 'month', values: [{ column: 'amount', aggregation: 'sum', calc: { kind: 'moving_sum', along: 'across', window: 3 } }] } },
];
const PLAIN = { name: 'Plain', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } };

async function server(): Promise<void> {
  ipcVisuals.register();
  const viz = handlers.get('visual:data');
  ok('visual:data is registered', !!viz);
  if (!viz) return;
  await projects.init();
  const pid = (await projects.createProject('Published calcs')).id;
  const ds = (await datasets.saveDataset(pid, { name: 'Sales', sourceKind: 'csv', columns: COLUMNS, rows: ROWS } as Any))!.id;
  const saved = [];
  for (const v of [...CALCS, PLAIN]) saved.push((await visuals.saveVisual(pid, { datasetId: ds, name: v.name, chartType: 'column', encoding: v.encoding } as never))!);
  const dash = (await analysisStore.saveAnalysis(pid, {
    name: 'Calcs', sheets: [{ id: randomUUID(), name: 'Main', cards: saved.map((v, i) => ({ id: randomUUID(), type: 'visual', visualId: v.id, layout: { x: 0, y: 4 * i, w: 6, h: 4 } })) }],
  } as never))!;
  const story = (await stories.saveStory(pid, { name: 'Calcs story', blocks: saved.map((v) => ({ id: randomUUID(), kind: 'visual', visualId: v.id, filters: [] })) }))!;
  const outgoing = policyOutgoing(pid, 'publish');
  const EAST = [{ type: 'filter', column: 'region', op: '=', value: 'East' }];
  const app = (encoding: unknown, filters: unknown[] = []): Promise<Any> => viz(null, { projectId: pid, datasetId: ds, encoding, filters, chartType: 'column' });
  const tileOf = (page: Any, i: number): Any => { const c = page.dashboard.sheets[0].cards[i]; return c.payloads[c.variants[0]]; };

  const page: Any = sanitizePage({ kind: 'dashboard', site: {}, dashboard: await buildDashboard(pid, dash.id, 1, {}, outgoing) });
  const embed: Any = sanitizePage({ kind: 'dashboard', site: {}, dashboard: await buildDashboard(pid, dash.id, 1, {}, outgoing, { lock: makeLock({ region: ['East'] }) }) });
  const told: Any = sanitizePage({ kind: 'story', site: {}, story: await buildStory(pid, story.id, {}, outgoing) });
  const surfaces: Array<[string, (i: number) => Any, unknown[]]> = [
    ['/p/', (i) => tileOf(page, i), []],
    ['embed', (i) => tileOf(embed, i), EAST],
    ['story', (i) => told.story.blocks[i].data, []],
  ];

  for (const [surface, published, filters] of surfaces) {
    for (let i = 0; i < CALCS.length; i++) {
      const want = await app(CALCS[i].encoding, filters);
      const got = published(i);
      const kind = CALCS[i].encoding.values[0].calc.kind;
      const a = want.ok ? want.data.series[0] : null;
      const b = got && Array.isArray(got.series) ? got.series[0] : null;
      ok(`${surface} ${kind}: the app draws it`, !!a && a.calc?.kind === kind, show(want));
      ok(`${surface} ${kind}: the published series is visual:data's, value for value`, !!a && !!b && sameSeq(b.values, a.values), `${show(b)} vs ${show(a)}`);
      ok(`${surface} ${kind}: …and says it is a ${kind}`, !!b && b.calc === kind, show(b));
      ok(`${surface} ${kind}: NEGATIVE CONTROL: the raw figures are not what it draws`, !!a && !!b && !sameSeq(b.values, a.raw), show(a && a.raw));
    }
    const plain = published(CALCS.length);
    ok(`${surface}: a chart with no calc carries no calc key`, !!plain && Array.isArray(plain.series) && plain.series.every((s: Any) => !('calc' in s)), show(plain));
  }

  // Byte for byte what a plain chart published before: chartPayload over the reply WITHOUT the calc step, sanitized alike.
  const enc = visuals.sanitizeEncoding(PLAIN.encoding as never);
  const before = await ipcVisuals.vizDataFor(pid, ds, enc, []);
  const lists = await labelListsFor(pid, ds, enc);
  const old = sanitizePayload(before.ok ? await chartPayload(ds, enc, 'column', undefined, before.data, outgoing, { ...lists, otherBucket: false }) : null);
  ok('control: a plain tile publishes byte for byte what the path without calcs published', JSON.stringify(tileOf(page, CALCS.length)) === JSON.stringify(old), `${show(tileOf(page, CALCS.length))} vs ${show(old)}`);
  ok('control: …and a plain story block too', JSON.stringify(told.story.blocks[CALCS.length].data) === JSON.stringify(old));
  ok('control: withTableCalcs hands a plain reply back untouched', Object.is(tableCalc.withTableCalcs(before, enc), before));
}

function sanitizer(): void {
  const pay = (calc: unknown): Any => sanitizePayload({ labels: ['a'], series: [{ label: 's', values: [0.5], calc }] });
  for (const k of tableCalc.TABLE_CALC_KINDS) ok(`sanitizer: keeps the kind ${k}`, pay(k).series[0].calc === k);
  for (const bad of ['eval', 'RUNNING_TOTAL', '', 7, null, { kind: 'running_total' }, ['pct_of_total']])
    ok(`sanitizer: drops calc ${show(bad)}`, !('calc' in pay(bad).series[0]), show(pay(bad)));
  ok('sanitizer: a series with no calc stays { label, values }', JSON.stringify(sanitizePayload({ labels: ['a'], series: [{ label: 's', values: [1] }] })) === '{"labels":["a"],"series":[{"label":"s","values":[1]}],"caption":""}');
  ok('sanitizer: raw figures and the whole calc object never reach a page', show(sanitizePayload({ labels: ['a'], series: [{ label: 's', values: [1], raw: [9], calc: { kind: 'diff' } }] })).indexOf('9') < 0);
}

function site(): void {
  const ctx: Any = { OrdFormat: format };
  vm.createContext(ctx);
  vm.runInContext(readAssets().coreJs, ctx);
  ok('site: the core has a calc formatter', typeof ctx.pkCalcParts === 'function');
  if (typeof ctx.pkCalcParts !== 'function') return;
  const values = [0.25, 0.2414, 1, 0, -0.031, 12_345.6, 3, 1_250_000, -7, null, NaN, Infinity];
  for (const k of tableCalc.TABLE_CALC_KINDS) {
    const same = values.every((v) => {
      const want = tableCalc.calcParts(k, v);
      const got = ctx.pkCalcParts(k, v);
      return got.value === want.value && got.suffix === want.suffix;
    });
    ok(`site: ${k} prints as calcParts does`, same, show(values.map((v) => [ctx.pkCalcParts(k, v), tableCalc.calcParts(k, v)])));
  }
  const fmt = (v: number) => 'f' + v;
  const share = { labels: ['East', 'West'], series: [{ label: 'Revenue', values: [0.25, 0.75], calc: 'pct_of_total' }] };
  const cfg = ctx.pkChartConfig('column', share, [], fmt);
  const tipOf = (c: Any, di: number, i: number): string => c.options.plugins.tooltip.callbacks.label({ dataset: c.data.datasets[di], datasetIndex: di, dataIndex: i, raw: c.data.datasets[di].data[i] });
  const tip = tipOf(cfg, 0, 0);
  ok('site: a percent-of-total tooltip says "25.0% of total"', tip === 'Revenue: 25.0% of total', tip);
  ok('site: …its axis prints a percent, never 0.25', cfg.options.scales.y.ticks.callback(0.25) === '25%', cfg.options.scales.y.ticks.callback(0.25));
  const labelled: string[] = [];
  const fakeChart = { // the slice of a Chart.js chart the label plugin reads (as test-publishSite fakes it)
    ctx: { save() {}, restore() {}, fillText: (t: string) => labelled.push(t) }, options: { indexAxis: 'x', color: '#000' }, data: cfg.data,
    getDatasetMeta: (di: number) => ({ hidden: false, type: 'bar', data: cfg.data.datasets[di].data.map(() => ({ x: 0, y: 0, base: 0 })) }),
  };
  cfg.plugins.find((p: Any) => p.id === 'pkValueLabels').afterDatasetsDraw(fakeChart);
  ok('site: …and its value labels are percents, as the app\'s (tcAxisFmt)', JSON.stringify(labelled) === '["25%","75%"]', JSON.stringify(labelled));
  const rt = ctx.pkChartConfig('line', { labels: ['a', 'b'], series: [{ label: 'R', values: [1200, 2500], calc: 'running_total' }] }, [], fmt);
  ok('site: a running total\'s tooltip names it', tipOf(rt, 0, 1) === 'R: 2.5K running total', tipOf(rt, 0, 1));
  const tm = ctx.pkTableModel(share, 'Region');
  ok('site: a table says each calc column\'s kind', JSON.stringify(tm.calcs) === '["","pct_of_total"]', show(tm));
  const plain = ctx.pkChartConfig('column', { labels: ['a'], series: [{ label: 'v', values: [0.25] }] }, [], fmt);
  ok('site: NEGATIVE CONTROL: no calc keeps the page\'s formatter on the axis and tooltip',
    plain.options.scales.y.ticks.callback(0.25) === 'f0.25' && tipOf(plain, 0, 0) === 'v: f0.25');
  const mixed = ctx.pkChartConfig('column', { labels: ['a'], series: [{ label: 'p', values: [0.25], calc: 'pct_of_total' }, { label: 'v', values: [3] }] }, [], fmt);
  ok('site: NEGATIVE CONTROL: a calc beside a plain series leaves the shared axis to the page\'s formatter', mixed.options.scales.y.ticks.callback(3) === 'f3');
  ok('site: …while each series\' tooltip still says what it is', tipOf(mixed, 0, 0) === 'p: 25.0% of total' && tipOf(mixed, 1, 0) === 'v: f3', `${tipOf(mixed, 0, 0)} / ${tipOf(mixed, 1, 0)}`);
  const pct100 = ctx.pkChartConfig('pct_stacked_column', { labels: ['a'], series: [{ label: 'p', values: [0.25], calc: 'pct_of_total' }], figures: { sharePct: [[100]] } }, [], fmt);
  ok('site: NEGATIVE CONTROL: a 100% bar draws the server\'s share, so its tooltip is not the calc\'s', !('pkCalc' in pct100.data.datasets[0]));
}

async function main(): Promise<void> {
  sanitizer();
  site();
  await server();
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
