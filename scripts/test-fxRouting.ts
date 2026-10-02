'use strict';

// Self-check for WHEN a read converts currency (src/ipc/fxQuery.ts) — the
// routing, not the arithmetic (test-fx / test-fxResident hold that).
//
// A conversion that answers in place of the join path or a map path would
// silently drop a related dataset's filter or a map's geo payload, so those
// reads must DECLINE and let their own paths answer. A count is not money: a
// "count of amount" must neither convert nor lose rows with no rate.
//
//   npm run build:ts && node scripts/test-fxRouting.js

import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type FilterStep = import('../src/data/transforms').FilterStep;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-fxrouting-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test' },
      ipcMain: { handle: () => {}, on: () => {} },
      net: {}, nativeImage: {}, shell: {},
      Notification: function () { return { show: () => {} }; },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const fxStore: typeof import('../src/app/fxStore') = require('../src/app/fxStore');
const fxQuery: typeof import('../src/ipc/fxQuery') = require('../src/ipc/fxQuery');
const dashboards: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');

const COLUMNS: ParsedColumn[] = [
  { name: 'date', type: 'date' },
  { name: 'region', type: 'text' },
  { name: 'amount', type: 'number' },
];
// 2020 is before the bundled sample's first month: no EUR→USD rate for it.
const ROWS = [
  ['2024-03-01', 'West', 100],
  ['2024-03-02', 'East', 200],
  ['2020-01-05', 'West', 50],
];

async function main(): Promise<void> {
  await projects.init();
  const project = await projects.createProject('FX routing');
  const pid = project.id;
  const ds = await datasets.saveDataset(pid, { name: 'Sales', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
  if (!ds) { ok('saved the fixture', false); return; }
  const did = ds.id;
  await fxStore.setProjectFx(pid, { target: 'USD' });
  await fxStore.setColumnCurrency(pid, did, 'amount', { kind: 'fixed', code: 'EUR', date: 'date' });

  // ── A metric ────────────────────────────────────────────────────────────
  ok('own columns: the metric converts', !!(await fxQuery.fxContext(pid, did, ['amount'], ['amount', 'region'])));
  ok('a filter on a RELATED dataset\'s column: declines (the join path answers)',
    (await fxQuery.fxContext(pid, did, ['amount'], ['amount', 'store_region'])) === null);

  const sum = await dashboards.computeCardMetric(pid, did, { column: 'amount', aggregation: 'sum' });
  ok('sum of a declared column carries the conversion', !!sum.fx && sum.fx.target === 'USD');
  ok('…and counts the row with no rate', !!sum.fx && sum.fx.missing === 1, sum.fx);
  const count = await dashboards.computeCardMetric(pid, did, { column: 'amount', aggregation: 'count' });
  ok('count of a declared column: not converted', count.fx === undefined);
  ok('…and keeps every row, rate or not', count.value === 3, count.value);

  // ── A chart ─────────────────────────────────────────────────────────────
  const enc = (over: Record<string, unknown> = {}): any => ({ category: 'region', values: [{ column: 'amount', aggregation: 'sum' }], ...over });
  ok('a chart over own columns converts', !!(await fxQuery.fxVizContext(pid, did, enc())));
  ok('a chart counting the money column: not converted',
    (await fxQuery.fxVizContext(pid, did, enc({ values: [{ column: 'amount', aggregation: 'count' }] }))) === null);
  ok('a map: declines (its geo payload comes from its own path)',
    (await fxQuery.fxVizContext(pid, did, enc({ geo: { level: 'point' } }))) === null);
  ok('a category from a related dataset: declines',
    (await fxQuery.fxVizContext(pid, did, enc({ category: 'store_name' }))) === null);
  const related: FilterStep[] = [{ type: 'filter', column: 'store_region', op: '=', value: 'West' }];
  ok('a related filter on a chart: declines', (await fxQuery.fxVizContext(pid, did, enc(), related)) === null);
  const own: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'West' }];
  ok('an own filter on a chart: converts', !!(await fxQuery.fxVizContext(pid, did, enc(), own)));
}

main()
  .catch((err) => ok('threw', false, err))
  .finally(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    finish();
  });
