// Self-check that an INPUT TABLE is used downstream exactly like any dataset —
// no special-casing anywhere: a metric over it, a relationship to it (and the
// join a metric makes across that relationship), a scorecard target (a metric,
// resolved by the same resolveMetric) and an alert rule on it all give the same
// answers as over a CSV dataset holding the same rows. Differential, not
// hand-written: the input table and its CSV twin are compared with Object.is.
//
//   npm run build:ts && node scripts/test-inputDownstream.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-inputdown-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test', getAppPath: () => path.resolve(__dirname, '..') },
      ipcMain: { handle: () => {}, on: () => {} },
      dialog: {}, net: {}, nativeImage: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const scorecardModel: typeof import('../src/analysis/scorecardModel') = require('../src/analysis/scorecardModel');
const store: typeof import('../src/data/inputTable/store') = require('../src/data/inputTable/store');
const { resolveMetric }: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const { joinedMetricFor }: typeof import('../src/ipc/relationships') = require('../src/ipc/relationships');

async function main(): Promise<void> {
  await projects.init();
  const pid = (await projects.createProject('Targets vs actuals')).id;
  const sales = (await datasets.saveDataset(pid, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
    rows: [['east', 10], ['west', 20], ['east', 30], ['north', 5]],
  }))!;
  const created = await store.createInputTable(pid, {
    name: 'Targets',
    columns: [
      { name: 'region', type: 'text', required: true, lookup: { datasetId: sales.id, column: 'region' } },
      { name: 'target', type: 'number' },
    ],
  });
  if (!created.ok) throw new Error(created.error);
  const inputId = created.id;
  const saved = await store.saveInputBatches(pid, inputId, [{
    label: 'Paste 6 cells',
    ops: [{ t: 'ins', at: 0, rows: [['east', '100'], ['west', '200'], ['north', '50']] }],
  }]);
  ok('the input table saved clean — every lookup value is a Sales region', saved.ok && saved.check.failCells === 0, JSON.stringify(saved));
  const twin = (await datasets.saveDataset(pid, {
    name: 'Targets (CSV)', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'target', type: 'number' }],
    rows: [['east', 100], ['west', 200], ['north', 50]],
  }))!;

  // ── The pickers: it is listed like any dataset ─────────────────────────────
  const list = await datasets.listDatasets(pid);
  ok('listed with the other datasets (every picker reads this list)', list.some((d) => d.id === inputId && d.sourceKind === 'input'));
  const meta = await datasets.getDatasetMeta(pid, inputId);
  ok('its columns read as { name, type } like any dataset', meta!.columns.map((c) => `${c.name}:${c.type}`).join() === 'region:text,target:number');

  // ── A metric over it ───────────────────────────────────────────────────────
  const mIn = (await metrics.saveMetric(pid, { name: 'Target', datasetId: inputId, definition: { column: 'target', aggregation: 'sum' } }))!;
  const mCsv = (await metrics.saveMetric(pid, { name: 'Target CSV', datasetId: twin.id, definition: { column: 'target', aggregation: 'sum' } }))!;
  const vIn = (await resolveMetric(pid, mIn.id))!.value;
  const vCsv = (await resolveMetric(pid, mCsv.id))!.value;
  ok('a metric over the input table ≡ the same metric over its CSV twin', Object.is(vIn, vCsv) && Object.is(vIn, 350), `${vIn} vs ${vCsv}`);

  // ── A scorecard target is a metric — the same number ───────────────────────
  const rows = scorecardModel.sanitizeRows([{ metricId: mCsv.id, target: { metricId: mIn.id } }]);
  ok('a scorecard row takes the input table\'s metric as its target', rows.length === 1 && (rows[0].target as any).metricId === mIn.id);

  // ── A relationship to it, and the join a metric makes across it ────────────
  const relIn = await rels.saveRelationship(pid, {
    from: { datasetId: sales.id, column: 'region' }, to: { datasetId: inputId, column: 'region' }, cardinality: 'many_to_one',
  });
  ok('a relationship to the input table is accepted', !!relIn);
  const joinIn = await joinedMetricFor(pid, sales.id, { column: 'target', aggregation: 'sum' }, []);
  await rels.deleteRelationship(pid, relIn!.id);
  const relCsv = await rels.saveRelationship(pid, {
    from: { datasetId: sales.id, column: 'region' }, to: { datasetId: twin.id, column: 'region' }, cardinality: 'many_to_one',
  });
  const joinCsv = await joinedMetricFor(pid, sales.id, { column: 'target', aggregation: 'sum' }, []);
  await rels.deleteRelationship(pid, relCsv!.id);
  ok('Sales → Targets joined metric ≡ Sales → CSV twin', !!joinIn && !!joinCsv && Object.is(joinIn.value, joinCsv.value) && typeof joinIn.value === 'number',
    JSON.stringify({ joinIn, joinCsv }));

  // ── An alert rule on it ────────────────────────────────────────────────────
  const rule = (id: string) => ({
    name: 'Targets over 300', datasetId: id, metric: { column: 'target', aggregation: 'sum' },
    compare: 'threshold', threshold: { op: '>', value: 300 },
  });
  ok('an alert rule on the input table is accepted', !!(await alertStore.saveRule(pid, rule(inputId))));
  await alertStore.saveRule(pid, rule(twin.id));
  const firedIn = await alertStore.evaluateProject(pid, inputId);
  const firedCsv = await alertStore.evaluateProject(pid, twin.id);
  ok('the alert fires on the input table exactly as on its twin',
    firedIn.length === 1 && firedCsv.length === 1 && Object.is(firedIn[0].value, firedCsv[0].value), JSON.stringify({ firedIn, firedCsv }));

  // ── An edit moves them at once ─────────────────────────────────────────────
  await store.saveInputBatches(pid, inputId, [{ label: 'Edit target', ops: [{ t: 'set', r: 1, c: 1, cells: [['10']] }] }]);
  ok('an edit is the metric\'s new value immediately', Object.is((await resolveMetric(pid, mIn.id))!.value, 160));
}

main()
  .catch((err) => ok('threw', false, err && err.stack))
  .finally(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp */ }
    if (failureCount()) { console.error('\n' + failureCount() + ' input-downstream check(s) FAILED'); process.exit(1); }
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
