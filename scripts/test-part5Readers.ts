// Readers for every shape part 5 writes (semantic layer part 5, step 01, release 5A).
//
// A LATER release writes `countd`, funnel and period metrics, a snapshot's `per`, a metric's `target` and target
// alerts. A pod of THIS release that reads such a record must (1) keep it, verbatim, through every load and re-save,
// and (2) compute none of it: a chart refuses with a sentence, a KPI shows no figure, an alert is skipped untouched.
// A record with none of the new shapes reads and saves byte-identically.
//
//   npm run build:ts && node scripts/test-part5Readers.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-part5-readers-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const answerSpec: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const metricFormula: typeof import('../src/analysis/metricFormula') = require('../src/analysis/metricFormula');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const stepsSanitize: typeof import('../src/data/stepsSanitize') = require('../src/data/stepsSanitize');
const sqlGen: typeof import('../src/engine/sqlGen') = require('../src/engine/sqlGen');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const versions: typeof import('../src/ipc/versions') = require('../src/ipc/versions');
const editConflict: typeof import('../src/app/editConflict') = require('../src/app/editConflict');
const { isPendingError }: typeof import('../src/data/pendingError') = require('../src/data/pendingError');

const COLS = [{ name: 'customer_id', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'day', type: 'date' }] as any; // any: the dataset column shape, as the sibling suites build it
const ROWS: Array<[string, number, string]> = [];
for (let i = 0; i < 40; i += 1) ROWS.push([`c${i % 7}`, 10 + i, `2026-0${i < 20 ? 1 : 2}-${String((i % 20) + 1).padStart(2, '0')}`]);

function throws(fn: () => unknown, is: (e: unknown) => boolean): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return is(e);
  }
}

void (async () => {
  await projects.init();
  const P = (await projects.createProject('Part 5 readers')).id;
  const D = (await datasets.saveDataset(P, { name: 'orders', sourceKind: 'csv', columns: COLS, rows: ROWS } as any))!.id; // any: the sibling suites' save shape

  // ── countd kept ──────────────────────────────────────────────────────────
  const m = (await metrics.saveMetric(P, { name: 'Customers', datasetId: D, definition: { column: 'customer_id', aggregation: 'countd' } }))!;
  await metrics.updateMetric(P, m.id, { name: 'Buyers' });
  ok('metric: countd survives a rename', ((await metrics.getMetric(P, m.id))!.definition as { aggregation?: string }).aggregation === 'countd', JSON.stringify((await metrics.getMetric(P, m.id))!.definition));

  const encoding = { category: 'day', values: [{ column: 'customer_id', aggregation: 'countd' }], pivot: { rows: [{ column: 'day' }], columns: [], values: [{ column: 'customer_id', aggregation: 'countd' }] } };
  const v = (await visuals.saveVisual(P, { name: 'Buyers by day', datasetId: D, chartType: 'column', encoding }))!;
  await visuals.updateVisual(P, v.id, { name: 'Buyers per day' });
  const got = (await visuals.getVisual(P, v.id))!;
  ok('visual: countd survives save → update → get', String(got.encoding.values[0].aggregation) === 'countd' && String(got.encoding.pivot!.values[0].aggregation) === 'countd', JSON.stringify(got.encoding));

  const card = { type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: 'customer_id', aggregation: 'countd' } };
  const a = (await analysis.saveAnalysis(P, { name: 'Board', sheets: [{ name: 'A', cards: [card] }] }))!;
  const kept = (await analysis.getAnalysis(P, a.id))!.sheets[0].cards.find((c) => c.type === 'metric');
  ok('dashboard: a countd KPI card survives', kept !== undefined && String(kept.metric!.aggregation) === 'countd', JSON.stringify((await analysis.getAnalysis(P, a.id))!.sheets[0].cards));

  const spec = answerSpec.sanitizeStoredSpec({ datasetId: D, category: 'day', measures: [{ column: 'customer_id', aggregation: 'countd' }] });
  ok('stored answer spec keeps a countd measure', String(spec?.measures[0]?.aggregation) === 'countd', JSON.stringify(spec));

  const G = { type: 'group_aggregate', groupBy: ['day'], aggregations: [{ column: 'customer_id', fn: 'countd', as: 'customers' }] };
  ok('Prepare: a countd group step survives sanitize', JSON.stringify(transforms.sanitizeSteps([G])) === JSON.stringify([G]), JSON.stringify(transforms.sanitizeSteps([G])));
  const T = { columns: COLS, rows: ROWS.map((r) => [...r]) };
  ok('Prepare: a run that meets it refuses, typed — never an ungrouped table', throws(() => transforms.applyPipeline(T, [G as never]), isPendingError));
  const plainG = { ...G, aggregations: [{ column: 'customer_id', fn: 'count', as: 'rows' }] };
  ok('NEGATIVE CONTROL: the same step with count groups', transforms.applyPipeline(T, [plainG as never]).columns.map((c) => c.name).join() === 'day,rows');
  const SQL_COLS = [{ physical: 'c0', name: 'customer_id', type: 'text' }, { physical: 'c1', name: 'amount', type: 'number' }, { physical: 'c2', name: 'day', type: 'date' }] as any; // any: sqlGen's column shape
  ok('Prepare on DuckDB: the SQL pipeline hands a countd step to the fold (which refuses), never counts it', sqlGen.generateSql('t', SQL_COLS, [G as never]).sql === null);
  ok('NEGATIVE CONTROL: the same step with count compiles to SQL', typeof sqlGen.generateSql('t', SQL_COLS, [plainG as never]).sql === 'string');
  ok('resident: an aggregate expression for countd refuses, typed — never a count', throws(() => residentQuery.aggExpr(COLS, 0, 'countd'), isPendingError));
  ok('NEGATIVE CONTROL: the same expression for count is SQL', typeof residentQuery.aggExpr(COLS, 0, 'count') === 'string');
  ok('NEGATIVE CONTROL: the Prepare pivot step still refuses countd', typeof stepsSanitize.checkPowerStep({ type: 'pivot', key: 'day', value: 'amount', fn: 'countd' }) === 'string');
  ok('NEGATIVE CONTROL: an unknown aggregation still reads as sum', (metrics.sanitizeDefinition({ column: 'amount', aggregation: 'median' }) as { aggregation: string }).aggregation === 'sum');
  ok('a countd(col) metric formula has no figure on this release', metricFormula.compileMetricFormula('countd(customer_id)', ['customer_id', 'amount', 'day']).ok === false);

  // ── kinds kept: funnel and period definitions, a snapshot's per, a metric's target ──
  const U1 = '11111111-1111-4111-8111-111111111111';
  const U2 = '22222222-2222-4222-8222-222222222222';
  const FUN = { funnel: { entity: 'customer_id', event: 'customer_id', time: 'day', steps: ['visit', 'buy'], window: { n: 7, unit: 'days' } }, show: 'rate' };
  const PER = { base: U1, window: { to_date: 'year' }, compare: { vs: 'previous_year', show: 'pct_change' } };
  const SNAP = { column: 'amount', aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: 'customer_id' } };
  const TARGET = { source: { metricId: U2 }, per: 'month', thresholds: { good: 100, warn: 90 } };
  const TREE = { relation: 'sum', children: [{ metricId: U1 }, { metricId: U2 }] };
  const kinds: Record<string, string> = {};
  for (const [name, definition] of [['Visit → buy', FUN], ['Revenue YTD', PER], ['MRR', SNAP]] as const) {
    const x = (await metrics.saveMetric(P, { name, datasetId: D, definition, target: TARGET } as never))!;
    kinds[name] = x.id;
    await metrics.updateMetric(P, x.id, { name: name + ' (2)' });
    await metrics.updateMetric(P, x.id, { tree: TREE }, undefined, 'metricTree');
    const back = (await metrics.getMetric(P, x.id))!, dup = (await metrics.duplicateMetric(P, x.id))!;
    ok(`${name}: definition survives rename, tree save and duplicate`, isDeepStrictEqual(back.definition, definition) && isDeepStrictEqual(dup.definition, definition), JSON.stringify(back.definition));
    ok(`${name}: target survives`, isDeepStrictEqual((back as { target?: unknown }).target, TARGET) && isDeepStrictEqual((dup as { target?: unknown }).target, TARGET), JSON.stringify(back));
    ok(`${name}: sanitizing twice is sanitizing once`, JSON.stringify(metrics.sanitizeDefinition(metrics.sanitizeDefinition(definition))) === JSON.stringify(metrics.sanitizeDefinition(definition)));
  }
  // The release-5A editor sends a snapshot without `per` on every save (MetricEditor.tsx): the stored per stays.
  await metrics.updateMetric(P, kinds.MRR, { definition: { column: 'amount', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } } });
  ok('MRR: an editor that knows no per keeps the stored one', isDeepStrictEqual((await metrics.getMetric(P, kinds.MRR))!.definition, SNAP));
  ok('a plain metric is byte-identical', JSON.stringify(metrics.sanitizeDefinition({ column: 'amount', aggregation: 'sum' })) === '{"column":"amount","aggregation":"sum"}');
  ok('a plain snapshot is byte-identical', JSON.stringify(metrics.sanitizeDefinition({ ...SNAP, snapshot: { column: 'day', take: 'last' } })) === '{"column":"amount","aggregation":"sum","snapshot":{"column":"day","take":"last"}}');
  ok('a metric with no target writes no target key', !('target' in (await metrics.getMetric(P, m.id))!));
  ok('NEGATIVE CONTROL: a one-step funnel is not a funnel', !('funnel' in metrics.sanitizeDefinition({ ...FUN, funnel: { ...FUN.funnel, steps: ['visit'] } })));
  ok('NEGATIVE CONTROL: a period metric with neither window nor compare is not one', !('base' in metrics.sanitizeDefinition({ base: U1 })));
  ok('NEGATIVE CONTROL: last: 0 is refused', !('base' in metrics.sanitizeDefinition({ base: U1, window: { last: 0, unit: 'day' } })));
  ok('NEGATIVE CONTROL: a target with no source is not a target', !('target' in (await metrics.saveMetric(P, { name: 'No target', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, target: { per: 'month' } } as never))!));
  const restoredT = (await metrics.getMetric(P, kinds['Revenue YTD']))!;
  await versions.writeBack(P, 'metric', restoredT.id, { name: 'Revenue YTD', definition: PER, filters: [], format: { kind: 'number', decimals: 0 } });
  const restored = (await metrics.getMetric(P, restoredT.id))!;
  ok('a version restore keeps the definition and the target', isDeepStrictEqual(restored.definition, PER) && isDeepStrictEqual((restored as { target?: unknown }).target, TARGET), JSON.stringify(restored));
  ok('the edit-conflict tag covers target', editConflict.contentTag('metric', restored) !== editConflict.contentTag('metric', { ...restored, target: undefined }));

  finish();
})();
