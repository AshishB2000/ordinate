// Count distinct, offered (semantic layer part 5, step 04): the contracts take `countd`, a metric formula reads
// `countd(col)`, the words say "count distinct", and the Assistant and agents ask for one.
//
//   contract   metric:save and visual:data take it; NEGATIVE CONTROL median is still refused
//   formulas   countd(col) in a formula is the distinct count, [Name] of a countd metric is the same figure
//   words      "count distinct of customer_id"; a formula over it is not additive
//
//   npm run build:ts && node scripts/test-countdWriters.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-countd-writers-'));

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each reply is narrowed where read
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const fmt: typeof import('../src/analysis/metricFormat') = require('../src/analysis/metricFormat');
const additivity: typeof import('../src/analysis/additivity') = require('../src/analysis/additivity');
const formula: typeof import('../src/analysis/metricFormula') = require('../src/analysis/metricFormula');
const apiMetrics: typeof import('../src/api/metrics') = require('../src/api/metrics');
const apiVisuals: typeof import('../src/api/visuals') = require('../src/api/visuals');

const COLS = [{ name: 'day', type: 'date' }, { name: 'order_id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'region', type: 'text' }] as any; // any: the dataset column shape

void (async () => {
  await projects.init();
  ipcMetrics.register();
  ipcVisuals.register();
  const P = (await projects.createProject('Countd writers')).id;
  const rows: string[][] = [];
  for (let i = 0; i < 60; i += 1) rows.push([`2024-01-${String((i % 28) + 1).padStart(2, '0')}`, `o${i}`, `c${i % 12}`, i % 2 ? 'East' : 'West']);
  const D = (await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: COLS, rows } as any))!.id; // any: the sibling suites' save shape

  // ── contract ──────────────────────────────────────────────────────────────
  const def = { column: 'customer_id', aggregation: 'countd' };
  ok('contract: a countd metric', apiMetrics.metrics['metric:save'].input.safeParse({ projectId: P, input: { name: 'C', datasetId: D, definition: def } }).success);
  ok('contract: a countd chart measure', apiVisuals.visuals['visual:data'].input.safeParse({ projectId: P, datasetId: D, encoding: { category: 'day', values: [{ column: 'customer_id', aggregation: 'countd' }] } }).success);
  ok('NEGATIVE CONTROL: median is still refused', !apiMetrics.metrics['metric:save'].input.safeParse({ projectId: P, input: { name: 'C', datasetId: D, definition: { column: 'x', aggregation: 'median' } } }).success);

  // ── formulas ──────────────────────────────────────────────────────────────
  const compiled = formula.compileMetricFormula('countd(customer_id)', ['customer_id']);
  ok('countd(col) compiles to a countd operand', compiled.ok && compiled.program.aggregates[0].aggregation === 'countd' && compiled.program.aggregates[0].column === 'customer_id');
  const save = async (name: string, definition: unknown) => (await handlers.get('metric:save')!(null, { projectId: P, input: { name, datasetId: D, definition } })).metric;
  const kpi = async (m: { id: string }): Promise<number> => (await handlers.get('metric:value')!(null, { projectId: P, id: m.id })).value;
  const orders = await save('Orders', { column: 'order_id', aggregation: 'count' });
  const cust = await save('Customers', def);
  const per = await save('Orders per customer', { formula: 'count(order_id) / countd(customer_id)' });
  ok('the distinct count is 12', (await kpi(cust)) === 12, String(await kpi(cust)));
  ok('countd(col) in a formula is the distinct count', Object.is(await kpi(per), (await kpi(orders)) / (await kpi(cust))));
  ok('[Customers] in a formula is the same figure', Object.is(await kpi(await save('Same', { formula: '[Customers] * 1' })), await kpi(cust)));
  ok('NEGATIVE CONTROL: a plain count of the same column is a different figure', (await kpi(await save('Rows', { column: 'customer_id', aggregation: 'count' }))) === 60);

  // ── words ─────────────────────────────────────────────────────────────────
  ok('words', fmt.describeDefinition(await metrics.getMetric(P, cust.id) as never) === 'count distinct of customer_id', fmt.describeDefinition(cust));
  const byName = new Map((await metrics.listMetrics(P)).map((m) => [m.name, m as never])) as never;
  ok('a formula over countd is not additive', !additivity.additivityOf(per, COLS, byName).categories);

  finish();
})();
