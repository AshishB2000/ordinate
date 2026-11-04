// A metric's `snapshot` (semantic layer part 1, PR 02a) — the READER half.
//
// A LATER release writes `snapshot: {column, take}` (a stock count is the last day's value, not a sum over
// every day). A pod of THIS release that reads such a record must (1) keep it through every re-save, duplicate
// and tree save, and (2) never draw the plain sum over every date in its place: every figure path that would
// do so refuses or shows no figure, until the release that computes snapshots removes the refusals.
//
//   npm run build:ts && node scripts/test-snapshotReader.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-snapshot-reader-'));

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const driverShape: typeof import('../src/analysis/driverShape') = require('../src/analysis/driverShape');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const api: typeof import('../src/api/metrics') = require('../src/api/metrics');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const COLS = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'units', type: 'number' }] as any; // any: the dataset column shape, as the sibling suites build it

void (async () => {
  await projects.init();
  ipcVisuals.register();
  const viz = handlers.get('visual:data');
  ok('the shipped handler is registered', !!viz);
  if (!viz) return finish();
  const pid = (await projects.createProject('Snapshot')).id;
  const rows: Array<[string, string, number]> = [];
  for (let i = 0; i < 40; i += 1) rows.push([`2024-02-${String((i % 20) + 1).padStart(2, '0')}`, i % 2 ? 'East' : 'West', 10 + i]);
  const ds = (await datasets.saveDataset(pid, { name: 'Stock', sourceKind: 'csv', columns: COLS, rows } as any))!; // any: the sibling suites' save shape

  const def = { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } };
  ok('sanitize keeps a snapshot', JSON.stringify(metrics.sanitizeDefinition(def)) === '{"column":"units","aggregation":"sum","snapshot":{"column":"day","take":"last"}}');
  ok('no snapshot: byte-identical to today', JSON.stringify(metrics.sanitizeDefinition({ column: 'units', aggregation: 'sum' })) === '{"column":"units","aggregation":"sum"}');
  for (const bad of [{ column: '', take: 'last' }, { column: 'day', take: 'middle' }, { column: 7, take: 'last' }, 'day', null]) {
    ok(`NEGATIVE CONTROL: sanitize drops ${JSON.stringify(bad)}`, !('snapshot' in metrics.sanitizeDefinition({ column: 'units', aggregation: 'sum', snapshot: bad })));
  }
  ok('a formula never carries one', JSON.stringify(metrics.sanitizeDefinition({ formula: '[A]', snapshot: def.snapshot })) === '{"formula":"[A]"}');

  // A record a newer pod wrote. The store API is what step 07's writer calls.
  const m = (await metrics.saveMetric(pid, { name: 'Stock', datasetId: ds.id, definition: def }))!;
  await metrics.updateMetric(pid, m.id, { name: 'Stock on hand' });
  ok('a rename keeps it', isDeepStrictEqual((await metrics.getMetric(pid, m.id))!.definition, def));
  await metrics.updateMetric(pid, m.id, { tree: { relation: 'sum', children: [{ metricId: U1 }, { metricId: U2 }] } }, undefined, 'metricTree');
  ok('a tree save keeps it', isDeepStrictEqual((await metrics.getMetric(pid, m.id))!.definition, def));
  ok('a duplicate keeps it', isDeepStrictEqual((await metrics.duplicateMetric(pid, m.id))!.definition, def));
  ok('the contract still refuses a writer', !api.metrics['metric:save'].input.safeParse({ projectId: pid, input: { name: 'x', datasetId: ds.id, definition: def } }).success);

  ok('no figure until step 07, never the sum over every date', (await ipcMetrics.resolveMetric(pid, m.id))!.value === null);
  const plain = (await metrics.saveMetric(pid, { name: 'Units', datasetId: ds.id, definition: { column: 'units', aggregation: 'sum' } }))!;
  ok('NEGATIVE CONTROL: the same column without a snapshot has a figure', typeof (await ipcMetrics.resolveMetric(pid, plain.id))!.value === 'number');

  const f = (await metrics.saveMetric(pid, { name: 'Double', datasetId: ds.id, definition: { formula: '[Stock on hand] * 2' } }))!;
  const c = await viz(null, { projectId: pid, datasetId: ds.id, encoding: { category: 'region', values: [{ column: 'Double', aggregation: 'sum', metricId: f.id }] } });
  ok('a chart over it says why', c.ok === false && c.error === msg.measureSnapshotPending('Stock on hand'), JSON.stringify(c).slice(0, 300));
  const fp = (await metrics.saveMetric(pid, { name: 'Double units', datasetId: ds.id, definition: { formula: '[Units] * 2' } }))!;
  const cp = await viz(null, { projectId: pid, datasetId: ds.id, encoding: { category: 'region', values: [{ column: 'Double units', aggregation: 'sum', metricId: fp.id }] } });
  ok('NEGATIVE CONTROL: the same chart over a metric without a snapshot draws', cp.ok === true, JSON.stringify(cp).slice(0, 300));

  const shape = (d: unknown) => driverShape.metricShape(ds.id, COLS, d as never, [], new Map());
  ok('key drivers refuse it', shape(def).kind === 'none');
  ok('NEGATIVE CONTROL: key drivers take the same column without a snapshot', shape({ column: 'units', aggregation: 'sum' }).kind === 'additive');

  finish();
})();
