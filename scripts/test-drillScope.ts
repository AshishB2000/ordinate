// The rows behind a DATED chart point and behind a KPI's saved metric
// (src/ipc/drillScope.ts) — through the shipped `visual:rows` handler.
//
// Like test-visual-rows, the assertion that matters is differential: the rows
// the panel lists, re-aggregated here in plain JS, reproduce the figure the
// app drew (Object.is). A wider or narrower row set fails it.
//
//   dated      every bucket of a time-series chart, at whatever grain the
//              chart chose (days and months here), split by a series or not
//   refuse     NEGATIVE CONTROLS: without the chart's grain the same mark is
//              still refused (the pure resolver alone); a label that is not
//              one of the axis's buckets is refused, never matched loosely
//   metric     a KPI on a saved metric: the metric's OWN filters join the
//              card's, so the rows add up to the KPI's figure. NEGATIVE
//              CONTROL: without the metric they add up to something else
//   formula    a calculated metric is refused with a reason; so is a metric
//              of another dataset
//   export     the CSV is the same row set
//
//   npm run build:ts && node scripts/test-drillScope.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-drillscope-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const files: typeof import('../src/server/files') = require('../src/server/files');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const visualsMod: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const dashboards: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');

type Any = any; // any: each handler's own reply shape, read field by field below
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
const COLS = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'kind', type: 'text' }, { name: 'amount', type: 'number' }] as Any;
const AMOUNT = 3;

/** Whole numbers only, so a JS left-fold and the engine's sum agree to the bit. */
function fixture(days: string[]): Array<[string, string, string, number]> {
  const rows: Array<[string, string, string, number]> = [];
  days.forEach((day, i) => {
    rows.push([day, 'East', 'sale', 100 + i], [day, 'West', 'sale', 40 + 2 * i], [day, i % 2 ? 'East' : 'West', 'refund', -(5 + i)]);
  });
  return rows;
}
const DAILY = fixture(['2024-03-01', '2024-03-02', '2024-03-03', '2024-03-04']);
const MONTHLY = fixture(Array.from({ length: 14 }, (_, m) => `${2023 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-${String(3 + m).padStart(2, '0')}`)
  .concat(['2023-01-28', '2023-02-11', '2024-02-27']));

async function main(): Promise<void> {
  ipcVisuals.register();
  require('../src/ipc/visualsServer').register();
  const rowsOf = handlers.get('visual:rows');
  const download = handlers.get('visual:rowsDownload');
  ok('the shipped handlers are registered', !!rowsOf && !!download);
  if (!rowsOf || !download) return;

  const pid = (await projects.createProject('Drill scope')).id;
  const save = async (name: string, rows: unknown[][]) => (await datasets.saveDataset(pid, { name, sourceKind: 'csv', columns: COLS, rows } as Any))!.id;
  const daily = await save('Daily', DAILY);
  const monthly = await save('Monthly', MONTHLY);
  const all = (datasetId: string, extra: Record<string, unknown>) => rowsOf(null, { projectId: pid, datasetId, filters: [], page: { offset: 0, limit: 5000 }, ...extra }) as Promise<Any>;
  const sum = (rows: unknown[][]): number => rows.reduce((n, r) => n + Number(r[AMOUNT]), 0);

  // ── dated ───────────────────────────────────────────────────────────────
  const CASES: Array<[string, string, boolean, string?]> = [
    ['the chart\'s own choice', daily, false], ['the chart\'s own choice, split', monthly, true],
    ['asked for', monthly, false, 'week'], ['asked for', monthly, false, 'month'], ['asked for, split', monthly, true, 'month'],
    ['asked for', monthly, false, 'quarter'], ['asked for', monthly, false, 'year'],
  ];
  const grains = new Set<string>();
  for (const [name, datasetId, split, asked] of CASES) {
    const encoding = visualsMod.sanitizeEncoding({ category: 'day', ...(asked ? { grain: asked } : {}), ...(split ? { series: 'region' } : {}), values: [{ column: 'amount', aggregation: 'sum' }] });
    const chart = await ipcVisuals.vizDataFor(pid, datasetId, encoding, []);
    if (!chart.ok) { ok(`${name}: the chart draws`, false, show(chart)); continue; }
    const grain = chart.category && chart.category.kind === 'date' ? chart.category.grain : null;
    let checked = 0;
    let wrong = '';
    for (let i = 0; i < chart.data.labels.length; i += 1) {
      for (const s of chart.data.series) {
        const drawn = s.values[i];
        if (drawn === null) continue;
        const res = await all(datasetId, { encoding, mark: { category: chart.data.labels[i], ...(split ? { series: s.name } : {}) } });
        checked += 1;
        if (!res.ok || !res.available || !Object.is(sum(res.rows), drawn) || res.total !== res.rows.length) wrong = wrong || show([chart.data.labels[i], s.name, drawn, res.available && sum(res.rows), res]);
      }
    }
    if (grain) grains.add(grain);
    ok(`dated (by ${grain}, ${name}): every point's rows add up to the figure the chart drew`, !!grain && (!asked || grain === asked) && checked >= 2 && !wrong, wrong || show([grain, checked]));
  }
  ok('dated: every grain was exercised', ['day', 'week', 'month', 'quarter', 'year'].every((g) => grains.has(g)), show([...grains]));
  const monthsEnc = visualsMod.sanitizeEncoding({ category: 'day', grain: 'month', values: [{ column: 'amount', aggregation: 'sum' }] });
  const months = await ipcVisuals.vizDataFor(pid, monthly, monthsEnc, []);
  const label = months.ok ? months.data.labels[1] : '';

  // ── refuse ──────────────────────────────────────────────────────────────
  const meta = (await datasets.getDatasetMeta(pid, monthly))!;
  const pure = ipcVisuals.resolveDrill(meta.columns, monthsEnc, [], { category: label });
  ok('NEGATIVE CONTROL: without the chart\'s grain the same mark is refused', pure.available === false && /date/.test(pure.reason), show(pure));
  const loose = await all(monthly, { encoding: monthsEnc, mark: { category: 'Mar 2024' } });
  ok('NEGATIVE CONTROL: a label that is not one of the axis\'s buckets is refused, with a reason', loose.ok === true && loose.available === false && typeof loose.reason === 'string' && loose.rows === undefined, show(loose));

  // ── metric ──────────────────────────────────────────────────────────────
  const format = { kind: 'number', decimals: 0, compact: false };
  const sales = await metrics.saveMetric(pid, { name: 'Sales', datasetId: monthly, definition: { column: 'amount', aggregation: 'sum' }, filters: [{ type: 'filter', column: 'kind', op: '=', value: 'sale' }], format } as Any);
  const refunds = await metrics.saveMetric(pid, { name: 'Refunds', datasetId: monthly, definition: { column: 'amount', aggregation: 'sum' }, filters: [{ type: 'filter', column: 'kind', op: '=', value: 'refund' }], format } as Any);
  const rate = await metrics.saveMetric(pid, { name: 'Refund rate', datasetId: monthly, definition: { formula: '[Refunds] / [Sales]' }, filters: [], format } as Any);
  ok('fixture metrics saved', !!sales && !!refunds && !!rate);
  if (!sales || !rate) return;

  const kpiEnc = { values: [{ column: 'amount', aggregation: 'sum' }] };
  const east = [{ type: 'filter', column: 'region', op: '=', value: 'East' }];
  const figure = async (filters: unknown[]): Promise<number | null> => {
    const r = await dashboards.computeCardMetric(pid, monthly, { column: 'amount', aggregation: 'sum' }, [...(sales.filters as Any[]), ...filters] as Any);
    return r.ok ? r.value : null;
  };
  for (const [name, filters] of [['no card filter', []], ['a card filter', east]] as Array<[string, unknown[]]>) {
    const res = await all(monthly, { encoding: kpiEnc, filters, mark: null, metricId: sales.id });
    const kpi = await figure(filters);
    ok(`metric (${name}): the rows add up to the KPI's figure`, res.ok && res.available && kpi !== null && Object.is(sum(res.rows), kpi) && res.rows.every((r: unknown[]) => r[2] === 'sale'), show([kpi, res.available && sum(res.rows)]));
  }
  const bare = await all(monthly, { encoding: kpiEnc, mark: null });
  ok('NEGATIVE CONTROL: without the metric the rows add up to something else', bare.ok && bare.available && !Object.is(sum(bare.rows), await figure([])) && bare.rows.some((r: unknown[]) => r[2] === 'refund'));

  // ── formula ─────────────────────────────────────────────────────────────
  const calc = await all(monthly, { encoding: kpiEnc, mark: null, metricId: rate.id });
  ok('formula: a calculated metric is refused, by name', calc.ok === true && calc.available === false && calc.reason.includes('Refund rate') && calc.rows === undefined, show(calc));
  const other = await all(daily, { encoding: kpiEnc, mark: null, metricId: sales.id });
  const gone = await all(monthly, { encoding: kpiEnc, mark: null, metricId: '00000000-0000-4000-8000-000000000000' });
  ok('formula: a metric of another dataset, or one that is gone, is refused', other.available === false && gone.available === false, show([other, gone]));

  // ── export ──────────────────────────────────────────────────────────────
  const listed = await all(monthly, { encoding: kpiEnc, mark: null, metricId: sales.id });
  const file = await download(null, { projectId: pid, datasetId: monthly, encoding: kpiEnc, filters: [], mark: null, metricId: sales.id, name: 'Sales' });
  const csv = file && file.downloadToken ? fs.readFileSync(files.downloadPathForTest(file.downloadToken) as string, 'utf8').trim().split('\n') : [];
  ok('export: the CSV is the same row set', file.ok === true && file.rows === listed.total && csv.length === listed.total + 1 && csv.slice(1).every((l) => l.includes(',sale,')), show([file, listed.total, csv.length]));
  const dated = await download(null, { projectId: pid, datasetId: monthly, encoding: monthsEnc, filters: [], mark: { category: label }, name: 'Month' });
  const one = await all(monthly, { encoding: monthsEnc, mark: { category: label } });
  ok('export: a dated point\'s CSV has that point\'s rows', dated.ok === true && one.available === true && dated.rows === one.total && one.total > 0, show([dated, one.total]));
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
