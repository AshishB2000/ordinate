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

  finish();
})();
