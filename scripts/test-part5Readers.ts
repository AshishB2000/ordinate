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
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each handler's reply is narrowed where it is read
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const ipcScenarios: typeof import('../src/ipc/scenarios') = require('../src/ipc/scenarios');
const ipcTemplates: typeof import('../src/ipc/templates') = require('../src/ipc/templates');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const dashboards: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const dashboardModel: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const stories: typeof import('../src/ipc/stories') = require('../src/ipc/stories');
const embedLock: typeof import('../src/publish/embedLock') = require('../src/publish/embedLock');
const planExec: typeof import('../src/ai/planExec') = require('../src/ai/planExec');
const driverShape: typeof import('../src/analysis/driverShape') = require('../src/analysis/driverShape');
const treeRef: typeof import('../src/analysis/metricTreeJs') = require('../src/analysis/metricTreeJs');
const metricFormat: typeof import('../src/analysis/metricFormat') = require('../src/analysis/metricFormat');
const msg: typeof import('../src/analysis/pendingMessages') = require('../src/analysis/pendingMessages');
const checkMsg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const alerts: typeof import('../src/analysis/alerts') = require('../src/analysis/alerts');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const { randomUUID }: typeof import('crypto') = require('crypto');

const COLS = [{ name: 'customer_id', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'day', type: 'date' }] as any; // any: the dataset column shape, as the sibling suites build it
const ROWS: Array<[string, number, string]> = [];
for (let i = 0; i < 40; i += 1) ROWS.push([`c${i % 7}`, 10 + i, `2026-0${i < 20 ? 1 : 2}-${String((i % 20) + 1).padStart(2, '0')}`]);

void (async () => {
  await projects.init();
  ipcVisuals.register();
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
  const grouped = transforms.applyPipeline(T, [G as never]); // one row per day, so one customer per day
  ok('Prepare: a run that meets it counts distinct per group (step 02) — never an ungrouped table', grouped.columns.map((c) => c.name).join() === 'day,customers' && grouped.rows.length === 40 && grouped.rows.every((r) => r[1] === 1), JSON.stringify(grouped.rows.slice(0, 3)));
  const plainG = { ...G, aggregations: [{ column: 'customer_id', fn: 'count', as: 'rows' }] };
  ok('NEGATIVE CONTROL: the same step with count groups', transforms.applyPipeline(T, [plainG as never]).columns.map((c) => c.name).join() === 'day,rows');
  const SQL_COLS = [{ physical: 'c0', name: 'customer_id', type: 'text' }, { physical: 'c1', name: 'amount', type: 'number' }, { physical: 'c2', name: 'day', type: 'date' }] as any; // any: sqlGen's column shape
  ok('Prepare on DuckDB: the SQL pipeline hands a countd step to the fold (the reference), never counts it', sqlGen.generateSql('t', SQL_COLS, [G as never]).sql === null);
  ok('NEGATIVE CONTROL: the same step with count compiles to SQL', typeof sqlGen.generateSql('t', SQL_COLS, [plainG as never]).sql === 'string');
  ok('resident: an aggregate expression for countd counts distinct (step 02) — never a plain count', residentQuery.aggExpr(COLS, 0, 'countd').includes('count(DISTINCT') && residentQuery.aggExpr(COLS, 0, 'countd') !== residentQuery.aggExpr(COLS, 0, 'count'));
  ok('NEGATIVE CONTROL: the same expression for count is SQL', typeof residentQuery.aggExpr(COLS, 0, 'count') === 'string');
  ok('NEGATIVE CONTROL: the Prepare pivot step still refuses countd', typeof stepsSanitize.checkPowerStep({ type: 'pivot', key: 'day', value: 'amount', fn: 'countd' }) === 'string');
  ok('NEGATIVE CONTROL: an unknown aggregation still reads as sum', (metrics.sanitizeDefinition({ column: 'amount', aggregation: 'median' }) as { aggregation: string }).aggregation === 'sum');
  ok('a countd(col) metric formula compiles (step 04)', metricFormula.compileMetricFormula('countd(customer_id)', ['customer_id', 'amount', 'day']).ok === true);

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

  // ── refused: every reader that cannot compute a part-5 shape shows no figure, or says why ──
  const viz = handlers.get('visual:data')!;
  const plain = (await metrics.saveMetric(P, { name: 'Revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' } }))!;
  const customers = (await metrics.saveMetric(P, { name: 'Customers', datasetId: D, definition: { column: 'customer_id', aggregation: 'countd' } }))!;
  const funnelM = (await metrics.getMetric(P, kinds['Visit → buy']))!;
  const periodM = (await metrics.getMetric(P, kinds['Revenue YTD']))!;
  const perM = (await metrics.getMetric(P, kinds.MRR))!;
  const chartOf = (values: unknown[], more: object = {}) => viz(null, { projectId: P, datasetId: D, encoding: { category: 'day', grain: 'month', values, ...more } });
  for (const x of [funnelM, periodM, perM]) {
    ok(`${x.name}: no KPI figure, never a sum`, (await ipcMetrics.resolveMetric(P, x.id))!.value === null, JSON.stringify(await ipcMetrics.resolveMetric(P, x.id)));
    // Step 05 computes a period metric: this one's base (U1) is no metric, so it says so.
    if (x === periodM) ok(`${x.name}: its KPI says its base is gone`, (await ipcMetrics.resolveMetric(P, x.id))!.notes?.[0] === checkMsg.periodBaseMissing());
    // Step 06 charts a period metric: this one's base is gone, so its chart says so, and a formula over it is not charted yet.
    const c = await chartOf([{ column: 'amount', aggregation: 'sum', metricId: x.id }]);
    ok(`${x.name}: a chart says why`, c.ok === false && c.error === (x === periodM ? checkMsg.periodBaseMissing() : msg.metricKindPending(x.name)), JSON.stringify(c).slice(0, 300));
    const f = (await metrics.saveMetric(P, { name: `Twice ${x.name}`, datasetId: D, definition: { formula: `[${x.name}] * 2` } }))!;
    ok(`${x.name}: a formula over it has no KPI figure`, (await ipcMetrics.resolveMetric(P, f.id))!.value === null);
    const cf = await chartOf([{ column: 'amount', aggregation: 'sum', metricId: f.id }]);
    ok(`${x.name}: a chart of a formula over it says why`, cf.ok === false && cf.error === (x === periodM ? checkMsg.periodInChartFormula(x.name) : msg.metricKindPending(x.name)), JSON.stringify(cf).slice(0, 300));
  }
  // A count distinct is computed from step 02 (scripts/test-countDistinct.ts holds it to the reference): 7 customers, each in both months.
  ok('Customers (countd): its KPI is the distinct count, never a sum', (await ipcMetrics.resolveMetric(P, customers.id))!.value === 7, JSON.stringify(await ipcMetrics.resolveMetric(P, customers.id)));
  ok('Customers (countd): its chart draws the distinct count per month', JSON.stringify((await chartOf([{ column: 'amount', aggregation: 'sum', metricId: customers.id }])).data?.series?.[0]?.values) === '[7,7]');
  const twiceC = (await metrics.saveMetric(P, { name: 'Twice Customers', datasetId: D, definition: { formula: '[Customers] * 2' } }))!;
  ok('Customers (countd): a formula over it has its figure', (await ipcMetrics.resolveMetric(P, twiceC.id))!.value === 14, JSON.stringify(await ipcMetrics.resolveMetric(P, twiceC.id)));
  ok('a raw countd measure draws', JSON.stringify((await chartOf([{ column: 'customer_id', aggregation: 'countd' }])).data?.series?.[0]?.values) === '[7,7]');
  const V = { column: 'amount', aggregation: 'sum' };
  ok('a countd pivot value draws', (await chartOf([V], { pivot: { rows: [{ column: 'day' }], columns: [], values: [{ column: 'customer_id', aggregation: 'countd' }] } })).ok === true);
  copilotIpc.register();
  const SPEC = { datasetId: D, category: 'day', measures: [V], filters: [], chartType: 'column', title: 'Orders' };
  const carded = await handlers.get('answer:card')!(null, { projectId: P, spec: { ...SPEC, measures: [{ column: 'customer_id', aggregation: 'countd' }] } });
  ok('an answer card with a countd measure draws', carded.ok === true, JSON.stringify(carded).slice(0, 300));
  const cardedKind = await handlers.get('answer:card')!(null, { projectId: P, spec: { ...SPEC, measures: [{ ...V, metricId: funnelM.id }] } });
  ok('an answer card over a funnel metric is refused', cardedKind.ok === false && cardedKind.reason === msg.metricKindPending(funnelM.name), JSON.stringify(cardedKind).slice(0, 300));
  ok('NEGATIVE CONTROL: the same answer card with sum draws', (await handlers.get('answer:card')!(null, { projectId: P, spec: SPEC })).ok === true);
  const kpi = await dashboards.computeCardMetric(P, D, { column: 'customer_id', aggregation: 'countd' });
  ok('the KPI door: countd is the distinct count', kpi.ok === true && kpi.value === 7, JSON.stringify(kpi));
  const kpiPer = await dashboards.computeCardMetric(P, D, { column: 'amount', aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: 'customer_id' } });
  ok('the KPI door: a per-entity snapshot has no figure', kpiPer.ok === true && kpiPer.value === null, JSON.stringify(kpiPer));
  const kpiSnap = await dashboards.computeCardMetric(P, D, { column: 'amount', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } });
  ok('NEGATIVE CONTROL: the KPI door: a plain snapshot has its figure', typeof kpiSnap.value === 'number', JSON.stringify(kpiSnap));
  ok('key drivers refuse a funnel metric', driverShape.metricShape(D, COLS, funnelM.definition, [], new Map()).kind === 'none');
  ok('key drivers refuse a countd metric', driverShape.metricShape(D, COLS, customers.definition, [], new Map()).kind === 'none');
  ok('the tree reference gives no figure for a funnel metric', treeRef.metricJs(COLS, ROWS, [funnelM], funnelM, []) === null);
  ok('the tree reference gives no figure for a per-entity snapshot', treeRef.metricJs(COLS, ROWS, [perM], perM, []) === null);
  const plainSnap = { ...perM, definition: { column: 'amount', aggregation: 'sum' as const, snapshot: { column: 'day', take: 'last' as const } } };
  ok('NEGATIVE CONTROL: the tree reference has a figure for a plain snapshot', typeof treeRef.metricJs(COLS, ROWS, [plainSnap], plainSnap, []) === 'number');
  // A KPI card of a funnel or period metric has no column of its own, and a stored aggregation (the writers store sum).
  const kindCard = { type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: '', aggregation: 'sum', metricId: funnelM.id } };
  const board = (await analysis.saveAnalysis(P, { name: 'Kinds', sheets: [{ name: 'A', cards: [kindCard, { ...kindCard, metric: { ...kindCard.metric, aggregation: 'median' } }] }] }))!;
  const kindCards = (await analysis.getAnalysis(P, board.id))!.sheets[0].cards.filter((c) => c.type === 'metric');
  ok('dashboard: a KPI card of a funnel metric (no column, a metricId, sum) survives', kindCards.length === 1 && kindCards[0].metric!.metricId === funnelM.id && kindCards[0].metric!.column === '', JSON.stringify(kindCards));
  ok('NEGATIVE CONTROL: the same card with an aggregation no store knows is dropped, as today', dashboardModel.sanitizeCards([{ ...kindCard, metric: { ...kindCard.metric, aggregation: 'median' } }]).length === 0 && dashboardModel.sanitizeCards([kindCard]).length === 1);
  ok('the words say it is newer', metricFormat.describeDefinition(funnelM) === 'a newer kind of metric');
  ok('a period metric has its words (step 05)', metricFormat.describeDefinition(periodM) === 'its base metric, year to date, % change on last year', metricFormat.describeDefinition(periodM));
  const dated = (await metrics.saveMetric(P, { name: 'Dated revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, timeColumn: 'day' }))!;
  const datedYtd = (await metrics.saveMetric(P, { name: 'Dated 30 years', datasetId: D, definition: { base: dated.id, window: { last: 366, unit: 'month' } } }))!; // thirty years to last month: the rows' days on any clock from March 2026 to 2056
  const ytdFigure = (await ipcMetrics.resolveMetric(P, datedYtd.id))!.value;
  ok('a period metric over a dated base has its figure (step 05): its base over the window', typeof ytdFigure === 'number' && Object.is(ytdFigure, (await ipcMetrics.resolveMetric(P, dated.id, { filters: [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'last_n_months', n: 366 } }] }))!.value), String(ytdFigure));
  const plainKpi = (await ipcMetrics.resolveMetric(P, plain.id))!.value;
  ok('NEGATIVE CONTROL: the plain metric has its figure and its chart', plainKpi === ROWS.reduce((a, r) => a + r[1], 0) && (await chartOf([{ ...V, metricId: plain.id }])).ok === true);

  // Stories, scenarios, templates, plans and embeds: a part-5 metric is never read as its stored column's plain total.
  ipcScenarios.register();
  ipcTemplates.register();
  const listed = ((await handlers.get('scenario:metrics')!(null, { projectId: P })) as Array<{ id: string }>).map((x) => x.id);
  ok('scenarios: the picker offers no pending part-5 metric, and offers a countd one (step 04)', [funnelM, periodM, perM].every((x) => !listed.includes(x.id)) && listed.includes(plain.id) && listed.includes(customers.id), JSON.stringify(listed));
  const planned = (await planExec.loadProjectCtx(P)).metrics.map((x) => x.id);
  ok('plans: a plan step cannot name a pending part-5 metric, and can name a countd one (step 04)', [funnelM, periodM, perM].every((x) => !planned.includes(x.id)) && planned.includes(plain.id) && planned.includes(customers.id), JSON.stringify(planned));
  const open = { covers: async () => true } as never; // any lock that covers the dataset
  ok('embed: a KPI of a funnel metric is not allowed under a lock', (await embedLock.metricAllowed(open, P, { metricId: funnelM.id, datasetId: D, column: 'amount' })) === false);
  ok('NEGATIVE CONTROL: embed: the KPI of the plain metric is allowed', (await embedLock.metricAllowed(open, P, { metricId: plain.id, datasetId: D, column: 'amount' })) === true);
  const D2 = (await datasets.saveDataset(P, { name: 'orders 2', sourceKind: 'csv', columns: COLS, rows: ROWS } as any))!.id; // any: as above
  const D3 = (await datasets.saveDataset(P, { name: 'orders 3', sourceKind: 'csv', columns: COLS, rows: ROWS } as any))!.id; // any: as above
  const countdRev = (await metrics.saveMetric(P, { name: 'Sales', datasetId: D2, definition: { column: 'amount', aggregation: 'countd' } }))!;
  const plainRev = (await metrics.saveMetric(P, { name: 'Sales', datasetId: D3, definition: { column: 'amount', aggregation: 'sum' } }))!;
  const roleMetrics = async (datasetId: string): Promise<string[]> => {
    const r = await handlers.get('template:list')!(null, { projectId: P, datasetId });
    return r.templates.flatMap((t: { matches: Array<{ metricId?: string }> }) => t.matches.map((x) => x.metricId)).filter(Boolean);
  };
  ok("templates: a role does not take a countd metric's column", !(await roleMetrics(D2)).includes(countdRev.id));
  ok('NEGATIVE CONTROL: templates: the same name on a plain metric is taken by a role', (await roleMetrics(D3)).includes(plainRev.id));
  const p2 = (await projects.createProject('Story KPI')).id;
  const d2 = (await datasets.saveDataset(p2, { name: 'orders', sourceKind: 'csv', columns: COLS, rows: ROWS } as any))!.id; // any: as above
  const kept2 = (await metrics.saveMetric(p2, { name: 'Buyers', datasetId: d2, definition: { column: 'amount', aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: 'customer_id' } } }))!;
  const out = await stories.blocksFromRecords(p2, { name: 'S', sheets: [{ name: 'A', cards: [{ type: 'metric', metric: { datasetId: d2, column: 'amount', aggregation: 'sum' } }] }] }, '');
  const tied = (out.find((b) => b.kind === 'metric') as { metricId?: string } | undefined)?.metricId;
  ok('stories: an inline KPI is not tied to a per-entity snapshot metric of the same column', !!tied && tied !== kept2.id);

  // ── alerts: a rule this release cannot evaluate is kept, untouched by an evaluation tick ──
  const R = (over: object) => ({ id: randomUUID(), name: 'r', datasetId: D, enabled: true, compare: 'threshold', threshold: { op: '>', value: 0 }, metric: { column: 'amount', aggregation: 'sum' }, ...over });
  const countdRule = R({ metric: { column: 'customer_id', aggregation: 'countd' } }); // evaluated from step 02
  const rules = [
    R({ compare: 'target', threshold: undefined, targetPct: { op: 'below', pct: 90 }, metric: { column: '', aggregation: 'sum', metricId: periodM.id } }),
    R({ metric: { column: 'amount', aggregation: 'sum', metricId: funnelM.id }, armed: true, history: [1, 2] }),
    R({ metric: { column: 'amount', aggregation: 'sum', metricId: perM.id } }),
  ];
  const plainRule = R({});
  const tag = (r: { metric: object; compare: string }): string => `${(r.metric as { aggregation: string }).aggregation}/${r.compare}/${(r.metric as { metricId?: string }).metricId ? 'a metric' : 'no metric'}`;
  for (const r of [...rules, plainRule, countdRule]) await alertStore.restoreRule(P, r);
  const before = (await alertStore.load(P)).rules;
  for (const r of rules) ok(`kept on load: ${tag(r)}`, before.some((x) => x.id === r.id));
  ok('the target rule keeps its targetPct and its empty column', isDeepStrictEqual((before.find((x) => x.id === rules[0].id) as { targetPct?: unknown } | undefined)?.targetPct, { op: 'below', pct: 90 }) && before.find((x) => x.id === rules[0].id)?.metric.column === '');
  await alertStore.evaluateProject(P, D, Date.parse('2026-11-04T12:00:00Z'));
  const after = (await alertStore.load(P)).rules;
  for (const r of rules) {
    const was = JSON.stringify(before.find((x) => x.id === r.id));
    ok(`kept, byte-identical after an evaluation tick: ${tag(r)}`, was !== undefined && JSON.stringify(after.find((x) => x.id === r.id)) === was, JSON.stringify(after.find((x) => x.id === r.id)));
  }
  ok('NEGATIVE CONTROL: the plain rule was evaluated', typeof after.find((x) => x.id === plainRule.id)?.lastEvaluatedAt === 'string');
  ok('a countd rule is evaluated, and keeps its aggregation', typeof after.find((x) => x.id === countdRule.id)?.lastEvaluatedAt === 'string' && after.find((x) => x.id === countdRule.id)?.metric.aggregation === 'countd');
  ok('NEGATIVE CONTROL: a target rule with no targetPct is not a rule', alerts.sanitizeRule(R({ compare: 'target', threshold: undefined })) === null);
  ok('NEGATIVE CONTROL: a target rule over 1000% is not a rule', alerts.sanitizeRule(R({ compare: 'target', threshold: undefined, targetPct: { op: 'below', pct: 1001 } })) === null);
  ok('NEGATIVE CONTROL: a threshold rule with no column and no metric is still not a rule', alerts.sanitizeRule(R({ metric: { column: '', aggregation: 'sum' } })) === null);
  ok('a plain rule is byte-identical through sanitize', JSON.stringify(alerts.sanitizeRule(plainRule)) === JSON.stringify(alerts.sanitizeRule(alerts.sanitizeRule(plainRule))) && !('targetPct' in alerts.sanitizeRule(plainRule)!));
  for (const r of rules) {
    const tested = await alertStore.testRule(P, r);
    ok(`the Test button says why: ${tag(r)}`, tested.ok && !tested.fire && tested.message === msg.alertPending() && tested.value === null, JSON.stringify(tested));
  }
  ok('NEGATIVE CONTROL: the Test button evaluates the plain rule', (await alertStore.testRule(P, plainRule)).fire === true);
  const testedC = await alertStore.testRule(P, countdRule);
  ok('the Test button evaluates a countd rule: 7 customers', testedC.fire === true && testedC.value === 7, JSON.stringify(testedC));

  finish();
})();
