// A metric's `timeColumn` and a filter step's `fromControl: true` marker (semantic layer part 1, PR 04a).
//
// 04a is the rolling-deploy reader: a LATER release writes these two fields, and a pod of THIS release
// that reads them must keep them through every read, re-save, duplicate, edit-conflict tag and version
// diff — an older sanitizer that drops them would erase the owner's choice on the next save.
//
//   npm run build:ts && node scripts/test-metricTimeReader.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-metric-time-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const editConflict: typeof import('../src/app/editConflict') = require('../src/app/editConflict');
const recordDiff: typeof import('../src/analysis/recordDiff') = require('../src/analysis/recordDiff');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each reply is narrowed by its check
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');

void (async () => {
  await projects.init();
  const P = (await projects.createProject('MetricTime')).id;
  const D = (await datasets.saveDataset(P, {
    name: 'Orders',
    sourceKind: 'csv',
    columns: [{ name: 'amt', type: 'number' }, { name: 'ship_date', type: 'date' }, { name: 'order_date', type: 'date' }],
    rows: [[1, '2026-01-01', '2026-01-02']],
  }))!.id;
  const def = { column: 'amt', aggregation: 'sum' };

  const m = await metrics.saveMetric(P, { name: 'Revenue', datasetId: D, definition: def, timeColumn: 'ship_date' });
  ok('a stored timeColumn is read', m?.timeColumn === 'ship_date');
  const r = await metrics.updateMetric(P, m!.id, { name: 'Revenue (net)' });
  ok('a re-save by this pod keeps it', (await metrics.getMetric(P, m!.id))?.timeColumn === 'ship_date' && r?.name === 'Revenue (net)');
  ok('a duplicate keeps it', (await metrics.duplicateMetric(P, m!.id))?.timeColumn === 'ship_date');
  ok('it is trimmed', (await metrics.saveMetric(P, { name: 'T', datasetId: D, definition: def, timeColumn: '  ship_date ' }))?.timeColumn === 'ship_date');
  ok('NEGATIVE CONTROL: a non-string timeColumn is dropped', (await metrics.saveMetric(P, { name: 'X', datasetId: D, definition: def, timeColumn: 5 }))?.timeColumn === undefined);
  ok('NEGATIVE CONTROL: a blank timeColumn is dropped', (await metrics.saveMetric(P, { name: 'Y', datasetId: D, definition: def, timeColumn: '   ' }))?.timeColumn === undefined);

  const marked = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'last_n_days', n: 30 }, fromControl: true };
  ok('sanitizeSteps keeps fromControl: true', JSON.stringify(transforms.sanitizeSteps([marked])) === JSON.stringify([marked]));
  ok('NEGATIVE CONTROL: fromControl "yes" is dropped', !('fromControl' in transforms.sanitizeSteps([{ ...marked, fromControl: 'yes' }])[0]));
  ok('NEGATIVE CONTROL: an unmarked step serializes without the key', !('fromControl' in transforms.sanitizeSteps([{ ...marked, fromControl: undefined }])[0]));

  ok('the edit-conflict tag covers it (two editors changing the date conflict)',
    editConflict.contentTag('metric', m) !== editConflict.contentTag('metric', { ...m, timeColumn: 'order_date' }));
  ok('NEGATIVE CONTROL: a record without it tags as its saved fields alone',
    editConflict.contentTag('metric', { ...m, timeColumn: undefined }) === editConflict.contentTag('metric', { ...m, timeColumn: undefined, junk: 1 }));
  ok('the version diff names a date change', recordDiff.summarize('metric', m, { ...m, timeColumn: 'order_date' }) === 'Changed the date it counts by');
  ok('NEGATIVE CONTROL: no change, no date sentence', !recordDiff.summarize('metric', m, { ...m, name: 'Other' }).includes('date it counts by'));

  // ── a metric's own date under a dashboard date control: release 2 moves the period onto it, so this release refuses ──
  ipcVisuals.register();
  copilotIpc.register();
  const pending = msg.measureTimeColumnPending();
  const plainM = (await metrics.saveMetric(P, { name: 'Plain revenue', datasetId: D, definition: def }))!;
  const control = (column: string, extra: object = { fromControl: true }) =>
    ({ type: 'filter', column, op: 'period', period: { preset: 'custom', from: '2026-01-01', to: '2026-12-31' }, ...extra });
  const enc = (metricId: string) => ({ category: 'order_date', values: [{ column: 'amt', aggregation: 'sum', metricId }] });
  const chart = (metricId: string, filters: unknown[]) => handlers.get('visual:data')!(null, { projectId: P, datasetId: D, encoding: enc(metricId), filters });
  const refused = await chart(m!.id, [control('order_date')]);
  ok('chart door: a metric counted by ship_date under a control on order_date is refused with the sentence', refused.ok === false && refused.error === pending, JSON.stringify(refused).slice(0, 300));
  ok('NEGATIVE CONTROL: the control on the metric\'s own date draws', (await chart(m!.id, [control('ship_date')])).ok === true);
  ok('NEGATIVE CONTROL: the same period with no fromControl draws', (await chart(m!.id, [control('order_date', {})])).ok === true);
  ok('NEGATIVE CONTROL: a metric with no timeColumn under the control draws', (await chart(plainM.id, [control('order_date')])).ok === true);
  const explained = await handlers.get('answer:explain')!(null, { projectId: P, tile: { datasetId: D, encoding: enc(m!.id), filters: [control('order_date')], chartType: 'column', name: 'Revenue' } });
  ok('answer:explain: the same tile is refused with the sentence, and starts no conversation', explained.ok === false && explained.reason === pending && !explained.threadId, JSON.stringify(explained));
  const explainedPlain = await handlers.get('answer:explain')!(null, { projectId: P, tile: { datasetId: D, encoding: enc(m!.id), filters: [control('ship_date')], chartType: 'column', name: 'Revenue' } });
  ok('NEGATIVE CONTROL: the tile with the control on the metric\'s own date still explains', explainedPlain.ok === true, JSON.stringify(explainedPlain));
  const rule = (metricId: string, filters: unknown[]) => ({ name: 'Revenue above 0', datasetId: D, metric: { column: 'amt', aggregation: 'sum', metricId, filters }, compare: 'threshold', threshold: { op: '>', value: 0 } });
  const alertOn = await alertStore.testRule(P, rule(m!.id, [control('order_date')]));
  ok('alerts: a rule on that metric under the control reads no figure and does not fire', alertOn.ok && alertOn.value === null && alertOn.fire === false, JSON.stringify(alertOn));
  const alertOwn = await alertStore.testRule(P, rule(m!.id, [control('ship_date')]));
  ok('NEGATIVE CONTROL: the same rule with the control on the metric\'s own date reads its figure and fires', alertOwn.ok && typeof alertOwn.value === 'number' && alertOwn.fire === true, JSON.stringify(alertOwn));
  const alertPlain = await alertStore.testRule(P, rule(plainM.id, [control('order_date')]));
  ok('NEGATIVE CONTROL: a rule on a metric with no timeColumn under the control reads its figure', alertPlain.ok && typeof alertPlain.value === 'number', JSON.stringify(alertPlain));

  finish();
})();
