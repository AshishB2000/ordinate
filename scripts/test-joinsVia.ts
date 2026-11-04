// A relationship's `label` and a reference's `via` survive every sanitizer, and a `via` resolves
// through THAT relationship (step 09) — or is refused, never answered through the first one.
// Old pods of a rolling deploy must not drop a field a later release writes (plan 09, "Old pods").
//
//   § via     a measure, the category and a filter step name their relationship; JS === resident
//             (Object.is); a via that cannot resolve is refused
//   § guard   sanitizeSteps / sanitizeEncoding / sanitizeRelationship keep the new fields (and drop
//             a malformed one); a `via` filter that reaches no planner is
//             skipped with the unknown-column warning on the JS fold, declined by the resident
//             predicate, refused by Live; a KPI and a chart reached through `vizJoin` / `metricJoin`
//             refuse it even in a project with NO relationships. Every guard has a negative control.
//   § order   a re-saved relationship keeps its place and its id, so "the first relationship" holds
//   § golden  no-via answers over a table related twice are byte-identical to scripts/fixtures/golden/joinsNoVia.json,
//             recorded from the planner before it learned via (never re-recorded)
//
//   npm run build:ts && node scripts/test-joinsVia.js

import { ok, finish } from './selfcheck';
import type { FilterStep } from '../src/data/transforms';
import type { LiveRefusal } from '../src/engine/live/liveSpec';
import type { VizEncoding } from '../src/analysis/visuals';
import * as fx from './joinsViaFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-joinsvia-data-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const ipcRels: typeof import('../src/ipc/relationships') = require('../src/ipc/relationships');
const jp: typeof import('../src/analysis/joinPlan') = require('../src/analysis/joinPlan');
const js: typeof import('../src/analysis/joinJs') = require('../src/analysis/joinJs');
const jr: typeof import('../src/engine/joinResident') = require('../src/engine/joinResident');
const { buildVizData }: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const { applyPipeline, sanitizeSteps }: typeof import('../src/data/transforms') = require('../src/data/transforms');
const { sanitizeEncoding }: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const { filterPredicate }: typeof import('../src/engine/residentFilter') = require('../src/engine/residentFilter');
const { filterCannotWarn }: typeof import('../src/ipc/visualsResident') = require('../src/ipc/visualsResident');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const { generateSql }: typeof import('../src/engine/sqlGen') = require('../src/engine/sqlGen');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const { mergeDashboardFilters }: typeof import('../src/analysis/dashboardFilters') = require('../src/analysis/dashboardFilters');
const cardModel: any = require('../src/analysis/cardModel'); // any: a UMD module with no exported types
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const GOLDEN = path.join(__dirname, 'fixtures', 'golden', 'joinsNoVia.json');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each reply is narrowed by its check

const { SALES, DATES, R_ORDER, R_SHIP, RELS, infos } = fx;
const show = (v: unknown): string => JSON.stringify(v);
const F = (column: string, op: string, value: number | string): FilterStep => ({ type: 'filter', column, op, value } as FilterStep);

async function main(): Promise<void> {
  const salesTable = fx.tables.get(SALES.id) as import('../src/data/transforms').TableData;
  ok('fixture: 40 sales, and the ship-year column is not all 2024 (so a wrongly filtered primary shows)',
    salesTable.rows.length === 40 && salesTable.rows.some((r) => r[5] === 2025) && salesTable.rows.some((r) => r[5] === 2024));
  ok('fixture: Dates repeats 2024-03-01 and RELS lists Order date first',
    DATES.rows.filter((r) => r[0] === '2024-03-01').length === 2 && RELS.map((r) => r.id).join() === [R_ORDER, R_SHIP, fx.R_RET].join());

  // ── § golden: no via, the first relationship, byte for byte ────────────────
  ok('no-via answers are byte-identical to the recording made before the planner changed', wire.encode(await fx.noViaAnswers()) === fs.readFileSync(GOLDEN, 'utf8'));

  // ── § guard: the sanitizers keep the new fields ────────────────────────────
  const viaStep = { ...F('year', '=', 2024), via: R_SHIP };
  ok('sanitizeSteps keeps a UUID via on a filter step, drops another', show(sanitizeSteps([viaStep, { ...viaStep, via: '../x' }])) === show([viaStep, F('year', '=', 2024)]));
  ok('sanitizeSteps: a non-string via is dropped too (negative control)', show(sanitizeSteps([{ ...viaStep, via: 7 }])) === show([F('year', '=', 2024)]));

  const enc: VizEncoding = {
    category: 'month', categoryDatasetId: DATES.id, categoryVia: R_SHIP,
    values: [{ column: 'year', aggregation: 'max', datasetId: DATES.id, via: R_SHIP }],
  };
  const e = sanitizeEncoding(enc);
  ok('sanitizeEncoding keeps categoryVia and a measure via only beside their datasetId',
    e.categoryVia === R_SHIP && e.values[0].via === R_SHIP && sanitizeEncoding({ ...enc, categoryDatasetId: undefined }).categoryVia === undefined);
  ok('sanitizeEncoding: a measure via without its datasetId, and a non-UUID via, are dropped (negative control)',
    sanitizeEncoding({ ...enc, values: [{ column: 'amount', aggregation: 'sum', via: R_SHIP }] }).values[0].via === undefined
    && sanitizeEncoding({ ...enc, categoryVia: '../x', values: [{ ...enc.values[0], via: '../x' }] }).categoryVia === undefined
    && sanitizeEncoding({ ...enc, values: [{ ...enc.values[0], via: '../x' }] }).values[0].via === undefined);

  const r = { id: R_ORDER, from: { datasetId: SALES.id, column: 'order_date' }, to: { datasetId: DATES.id, column: 'date' } };
  ok('sanitizeRelationship keeps a label, trimmed; drops one over 60',
    rels.sanitizeRelationship({ ...r, label: '  Ship date ' })!.label === 'Ship date' && rels.sanitizeRelationship({ ...r, label: 'x'.repeat(61) })!.label === undefined);
  ok('sanitizeRelationship: a blank, control-character or non-string label is dropped, the relationship stays (negative control)',
    ['   ', 'a\nb', 'a\u0000b', 7, null].every((label) => { const s = rels.sanitizeRelationship({ ...r, label }); return !!s && s.label === undefined; })
    && rels.sanitizeRelationship({ ...r, label: 'x'.repeat(60) })!.label === 'x'.repeat(60));
  ok('the fixture relationships carry their labels', RELS[0].label === 'Order date' && RELS[1].label === 'Ship date' && RELS[2].label === undefined);

  // ── § via: a reference names its relationship, in both engines ─────────
  const golden = Object.fromEntries((JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as { label: string; data: unknown }[]).map((g) => [g.label, g])) as Record<string, { data: unknown }>;
  const M = (column: string, aggregation: 'sum' | 'count' | 'max', datasetId?: string, via?: string) => ({ column, aggregation, ...(datasetId && { datasetId }), ...(via && { via }) });
  const V: Record<string, { enc: VizEncoding; filters?: FilterStep[] }> = {
    ship: { enc: { category: 'month', categoryDatasetId: DATES.id, categoryVia: R_SHIP, values: [M('amount', 'sum')] } },
    both: { enc: { category: 'month', categoryDatasetId: DATES.id, values: [M('amount', 'sum'), M('quarter', 'count', DATES.id, R_SHIP)] } },
    shipFilter: { enc: { category: 'region', values: [M('amount', 'sum')] }, filters: [{ ...F('quarter', '=', 'Q1'), via: R_SHIP }] },
    defaultNamed: { enc: { category: 'month', categoryDatasetId: DATES.id, categoryVia: R_ORDER, values: [M('amount', 'sum')] } },
    orderYear: { enc: { category: 'region', values: [M('amount', 'sum')] }, filters: [{ ...F('year', '=', 2024), via: R_ORDER }] },
  };
  const join = (c: { enc: VizEncoding; filters?: FilterStep[] }, rs = RELS) => jp.resolveVizJoin(SALES.id, c.enc, c.filters || [], rs, infos);
  const planOf = (c: { enc: VizEncoding; filters?: FilterStep[] }): import('../src/analysis/joinPlan').VizJoin => {
    const j = join(c);
    if (!j || !j.ok) throw new Error(`does not plan: ${show(j)}`);
    return j.value;
  };
  const err = (c: { enc: VizEncoding; filters?: FilterStep[] }, rs = RELS): string => { const j = join(c, rs); return j && !j.ok ? j.error : `planned: ${show(j)}`; };
  const dataOf: Record<string, unknown> = {};
  for (const [label, c] of Object.entries(V)) {
    const j = planOf(c);
    const want = js.joinedVizDataJs(j, fx.tables, infos);
    const got = await jr.joinedAggregateResident(j.plan.tables.map((t) => fx.sourceOf(t.datasetId)), j, infos);
    dataOf[label] = want.data;
    ok(`${label}: the resident path answers, and the reference raised no warning`, got !== null && want.warnings.length === 0, show([got, want.warnings]));
    const same = !!got && show(got.data.labels) === show(want.data.labels) && want.data.series.every((sr, i) => got.data.series[i]?.name === sr.name
      && sr.values.every((v, k) => Object.is(v, got.data.series[i].values[k])));
    ok(`${label}: labels and every value SQL === JS (Object.is)`, same, show([got && got.data, want.data]));
  }
  const both = planOf(V.both);
  ok('both: two Dates tables, each one row per sale', both.plan.tables.map((t) => t.key).join() === `,${R_ORDER},${R_SHIP}`
    && both.plan.tables.map((t) => t.parent).join() === '-1,0,0' && js.joinTables(both.plan, both.layout, fx.tables, infos).rows.length === 40);
  ok('both: the default Dates keeps its name, the Ship date one takes the label', both.encoding.category === 'Dates.month' && both.encoding.values[1].column === 'Ship date.quarter'
    && both.measureTable.get('Ship date.quarter') === 2 && both.encoding.values.every((v) => v.via === undefined && v.datasetId === undefined));
  const ship = planOf(V.ship);
  ok('ship: its column is named by the label', ship.layout.columns.some((c) => c.name === 'Ship date.month') && ship.encoding.category === 'Ship date.month' && ship.encoding.categoryVia === undefined);
  ok('NEGATIVE CONTROL: Ship date by month differs from Order date by month', show(dataOf.ship) !== show(golden.NV1.data) && (dataOf.ship as { labels: string[] }).labels.includes('2025-01'));
  ok('defaultNamed: the same table and the same answer as no via (NV1)', show(dataOf.defaultNamed) === show(golden.NV1.data) && planOf(V.defaultNamed).plan.tables.length === 2
    && planOf(V.defaultNamed).plan.tables[1].label === undefined);
  const sf = planOf(V.shipFilter);
  ok('shipFilter: the step reads Ship date.quarter and loses its via', show(sf.filters) === show([F('Ship date.quarter', '=', 'Q1')]));
  const oy = planOf(V.orderYear);
  const allSales = buildVizData(SALES.columns, SALES.rows, V.orderYear.enc, []).data;
  ok('a via filter on `year` (the primary has one) filters the joined year, never the primary\'s: every 2024 order stays',
    show(oy.filters) === show([F('Dates.year', '=', 2024)]) && show(dataOf.orderYear) === show(allSales), show([dataOf.orderYear, allSales]));
  ok('negative control: the primary\'s own year = 2024 drops the orders that ship in 2025',
    show(buildVizData(SALES.columns, SALES.rows, V.orderYear.enc, [F('year', '=', 2024)]).data) !== show(allSales));
  const unlabelled = RELS.map((x) => (x.id === R_SHIP ? { ...x, label: undefined } : x));
  const ul = jp.resolveVizJoin(SALES.id, V.ship.enc, [], unlabelled, infos);
  ok('an unlabelled relationship names its table "Dates (ship_date)"', !!ul && ul.ok && ul.value.encoding.category === 'Dates (ship_date).month', show(ul));

  for (const q of ['Q1', 'Q3']) {
    const k = jp.planMetricJoin(SALES.id, 'amount', [{ ...F('quarter', '=', q), via: R_SHIP }], RELS, infos);
    if (!k || !k.ok) { ok(`KPI ${q}: plans`, false, show(k)); continue; }
    const { plan, layout, column, table, filters } = k.value;
    const jsKpi = js.joinedMetricJs(plan, layout, fx.tables, infos, { column, aggregation: 'sum', table }, filters);
    const sqlKpi = await jr.joinedMetricResident(plan.tables.map((t) => fx.sourceOf(t.datasetId)), plan, layout, infos, { column, aggregation: 'sum' }, filters);
    ok(`KPI: planMetricJoin with a Ship-date ${q} filter — joinedMetricJs === joinedMetricResident (${jsKpi})`, typeof jsKpi === 'number' && Object.is(jsKpi, sqlKpi), show([jsKpi, sqlKpi]));
  }
  const kOrder = jp.planMetricJoin(SALES.id, 'amount', [{ ...F('quarter', '=', 'Q1'), via: R_ORDER }], RELS, infos);
  const kShip = jp.planMetricJoin(SALES.id, 'amount', [{ ...F('quarter', '=', 'Q1'), via: R_SHIP }], RELS, infos);
  const kpi = (k: typeof kShip): number | null => (k && k.ok ? js.joinedMetricJs(k.value.plan, k.value.layout, fx.tables, infos, { column: k.value.column, aggregation: 'sum', table: k.value.table }, k.value.filters) : null);
  ok('NEGATIVE CONTROL: the Q1 total by ship date differs from Q1 by order date', kpi(kShip) !== kpi(kOrder) && typeof kpi(kOrder) === 'number', show([kpi(kShip), kpi(kOrder)]));
  ok('planMetricJoin: every column the dataset\'s own and no via → no join (null)', jp.planMetricJoin(SALES.id, 'amount', [F('year', '=', 2024)], RELS, infos) === null);

  const viaRet: VizEncoding = { category: 'region', values: [M('refund', 'sum', fx.RETURNS.id, fx.R_RET)] };
  ok('via through R_RET from Sales (the one side): refused, many side', /many side/.test(err({ enc: viaRet })), err({ enc: viaRet }));
  ok('a deleted relationship id (a template from another project): refused, never the first', /no longer exists/.test(err({ enc: { ...V.ship.enc, categoryVia: fx.ID(999) } })));
  ok('deleting Ship date refuses its chart rather than redrawing it through Order date', /no longer exists/.test(err(V.ship, RELS.filter((x) => x.id !== R_SHIP))));
  ok('via R_SHIP with categoryDatasetId = RETURNS: refused, does not lead', /does not lead/.test(err({ enc: { ...V.ship.enc, categoryDatasetId: fx.RETURNS.id } })), err({ enc: { ...V.ship.enc, categoryDatasetId: fx.RETURNS.id } }));
  ok('a via filter on a column its table lacks: refused, never the primary\'s same-named column', /has no column "amount"/.test(err({ enc: V.shipFilter.enc, filters: [{ ...F('amount', '>', 0), via: R_SHIP }] })));
  ok('a via KPI that cannot resolve is an error (no figure), never a fallback', (() => { const k = jp.planMetricJoin(SALES.id, 'amount', [{ ...F('quarter', '=', 'Q1'), via: fx.ID(999) }], RELS, infos); return !!k && !k.ok; })());
  ok('the golden (no via) is still byte-identical', wire.encode(await fx.noViaAnswers()) === fs.readFileSync(GOLDEN, 'utf8'));
  const plain: VizEncoding = { ...V.ship.enc, categoryVia: undefined };
  ok('hasVia sees a categoryVia, a measure via and a filter via, and nothing else',
    jp.hasVia(V.ship.enc, []) && jp.hasVia(enc, []) && jp.hasVia(plain, [viaStep]) && !jp.hasVia(plain, [F('year', '=', 2024)])
    && !jp.hasVia({ category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, []));

  // ── § guard: the fold, the resident predicate and Live never filter the primary's own column ──
  const t = applyPipeline(salesTable, [viaStep]);
  ok('a via filter reaching applyPipeline skips with the unknown-column warning; the primary\'s own `year` is NOT filtered',
    t.rowCount === salesTable.rows.length && show(t.warnings) === show(['Filter skipped: unknown column "year"']));
  const control = applyPipeline(salesTable, [F('year', '=', 2024)]);
  ok('negative control: without via the same step does filter the primary\'s year', control.rowCount < salesTable.rows.length && control.warnings.length === 0);
  ok('resident declines it so JS answers with the warning',
    filterPredicate(SALES.columns, viaStep, []) === null && !filterCannotWarn(viaStep, new Set(['year'])));
  ok('negative control: without via the resident predicate exists and the step cannot warn',
    filterPredicate(SALES.columns, F('year', '=', 2024), []) !== null && filterCannotWarn(F('year', '=', 2024), new Set(['year'])));
  // The SQL generator (pipelineDuck / pipelinePower) is a fourth evaluator of a filter step.
  const sqlCols = SALES.columns.map((c, i) => ({ physical: `c${i}`, name: c.name, type: c.type }));
  const g = generateSql('sales', sqlCols, [viaStep]);
  ok('sqlGen skips a via filter with the fold\'s own warning and no predicate; the primary\'s `year` is NOT filtered',
    !!g.sql && !g.sql.includes('WHERE') && g.params.length === 0 && show(g.warnings) === show(t.warnings));
  const gc = generateSql('sales', sqlCols, [F('year', '=', 2024)]);
  ok('negative control: without via sqlGen does filter the primary\'s year (a WHERE, one bound param, no warning)',
    !!gc.sql && gc.sql.includes('WHERE') && show(gc.params) === show([2024]) && gc.warnings.length === 0);
  ok('Live refuses a via filter (related)', (spec.adaptFilter(viaStep, SALES.columns, {}, []) as LiveRefusal).code === 'related');
  ok('negative control: Live adapts the same filter without via', !spec.isRefusal(spec.adaptFilter(F('year', '=', 2024), SALES.columns, {}, [])));

  // ── § guard: a KPI and a chart in a project with no relationships ──────────
  await projects.init();
  const P = (await projects.createProject('Joins via')).id;
  const sales = (await datasets.saveDataset(P, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'amount', type: 'number' }, { name: 'year', type: 'number' }],
    rows: [[10, 2024], [20, 2025], [30, 2024]],
  }))!;
  const sum = { column: 'amount', aggregation: 'sum' as const };
  ok('a via filter on a KPI with no relationships is refused (no value), not skipped into a total',
    show(await ipcRels.joinedMetricFor(P, sales.id, sum, [viaStep])) === show({ ok: true, value: null })
    && (await ipcRels.metricReads(P, sales.id, 'amount', [viaStep])).length === 0);
  ok('negative control: without via the KPI falls through to the single-dataset path (null)', (await ipcRels.joinedMetricFor(P, sales.id, sum, [F('year', '=', 2024)])) === null);
  const salesEnc: VizEncoding = { category: 'year', values: [{ column: 'amount', aggregation: 'sum' }] };
  ok('a via filter on a chart with no relationships is refused: its relationship no longer exists',
    show(await ipcRels.joinedVizDataFor(P, sales.id, salesEnc, [viaStep])) === show({ ok: false, error: 'A relationship this chart joins through no longer exists.' }));
  ok('negative control: without via the chart needs no join (null)', (await ipcRels.joinedVizDataFor(P, sales.id, salesEnc, [F('year', '=', 2024)])) === null);

  // ── § guard: a merge keys a filter by its via, so `year = 2024` never swallows `year = 2024 via R_SHIP` ──
  const merged = mergeDashboardFilters([F('year', '=', 2024)], [viaStep]);
  ok('mergeDashboardFilters keeps a dashboard filter and a tile\'s same filter through a relationship, both', show(merged) === show([F('year', '=', 2024), viaStep]), show(merged));
  ok('…so the merged chart is refused here (no relationship), never drawn on the primary\'s year', show(await ipcRels.joinedVizDataFor(P, sales.id, salesEnc, merged)) === show({ ok: false, error: 'A relationship this chart joins through no longer exists.' }));
  ok('negative control: the same filter twice without via still merges to one', mergeDashboardFilters([F('year', '=', 2024)], [F('year', '=', 2024)]).length === 1);
  const carried = cardModel.carrySteps({ kind: 'navigate', carry: 'all_selection' }, { filters: [F('year', '=', 2024), viaStep], selection: [] });
  ok('a tile action carries both too', show(carried) === show([F('year', '=', 2024), viaStep]), show(carried));
  ok('negative control: a tile action still carries a repeated plain filter once',
    cardModel.carrySteps({ kind: 'navigate', carry: 'all_selection' }, { filters: [F('year', '=', 2024), F('year', '=', 2024)], selection: [] }).length === 1);

  // ── § guard: Explain declines a via filter, never narrating the primary's same-named `year` ──
  copilotIpc.register();
  const tileWith = (filters: FilterStep[]) => ({ datasetId: sales.id, encoding: { category: 'year', values: [sum] }, filters, chartType: 'column', name: 'Amount by year' });
  ok('tileSpec: a chart with a via filter has no spec', answers.tileSpec(tileWith([viaStep])) === null);
  const explainVia = await handlers.get('answer:explain')!(null, { projectId: P, tile: tileWith([viaStep]) });
  ok('answer:explain on a via filter declines, and starts no conversation', explainVia.ok === false && !explainVia.threadId, show(explainVia));
  ok('negative control: tileSpec keeps the same filter without via', show(answers.tileSpec(tileWith([F('year', '=', 2024)]))!.filters) === show([{ column: 'year', op: '=', value: 2024 }]));
  const explainPlain = await handlers.get('answer:explain')!(null, { projectId: P, tile: tileWith([F('year', '=', 2024)]) });
  ok('negative control: the same chart without via still explains', explainPlain.ok === true && typeof explainPlain.threadId === 'string', show(explainPlain));

  // ── § order: "first" holds across saves ────────────────────────────────────
  await rels.saveRelationship(P, RELS[0]);
  await rels.saveRelationship(P, RELS[1]);
  await rels.saveRelationship(P, { ...RELS[0], cardinality: 'one_to_one' });
  const after = await rels.listRelationships(P);
  ok('re-saving the first relationship keeps it first', after[0].id === R_ORDER && after[1].id === R_SHIP && after.length === 2);
  ok('re-saving it replaces it in place (the new cardinality, the label kept)', after[0].cardinality === 'one_to_one' && after[0].label === 'Order date');
  ok('saving an identical edge again keeps the existing id', (await rels.saveRelationship(P, { ...RELS[1], id: undefined }))!.id === R_SHIP);
  const last = await rels.listRelationships(P);
  ok('...and does not stack a duplicate or reorder', last.map((x) => x.id).join() === [R_ORDER, R_SHIP].join());
  const added = await rels.saveRelationship(P, RELS[2]);
  ok('a new edge goes to the end (negative control)', (await rels.listRelationships(P)).map((x) => x.id).join() === [R_ORDER, R_SHIP, added!.id].join());

  // ── § keep: a release-1 save (its contract has no label) keeps the same edge's label. The warning is derived and
  //    recomputed by the release that writes it (absent when the edge no longer warns), so it is never carried. ──
  const Q = (await projects.createProject('Joins keep')).id;
  const warned = { kind: 'repeats', repeats: 2 } as const;
  await rels.saveRelationship(Q, { ...RELS[0], warning: warned });
  const bare = (extra: object) => ({ from: RELS[0].from, to: RELS[0].to, cardinality: 'one_to_one', ...extra }); // relationship:save's release-1 shape
  await rels.saveRelationship(Q, bare({ id: R_ORDER }));
  const byId = (await rels.listRelationships(Q))[0];
  ok('a same-edge re-save by id without a label keeps it (and takes the new cardinality)', byId.label === 'Order date' && byId.cardinality === 'one_to_one', show(byId));
  ok('…and a re-save without a warning does NOT inherit the old one (a stale warning would come back)', byId.warning === undefined, show(byId));
  await rels.saveRelationship(Q, { ...RELS[0], warning: warned });
  await rels.saveRelationship(Q, bare({}));
  const byEdge = await rels.listRelationships(Q);
  ok('…and a same-edge re-save with no id keeps the label too, and not the warning', byEdge.length === 1 && byEdge[0].id === R_ORDER && byEdge[0].label === 'Order date' && byEdge[0].warning === undefined, show(byEdge));
  await rels.saveRelationship(Q, bare({ id: R_ORDER, warning: warned }));
  ok('negative control: a warning that IS sent is stored', show((await rels.listRelationships(Q))[0].warning) === show(warned));
  await rels.saveRelationship(Q, bare({ id: R_ORDER, label: 'Booked' }));
  ok('negative control: a label that IS sent replaces the stored one', (await rels.listRelationships(Q))[0].label === 'Booked');
  await rels.saveRelationship(Q, { id: R_ORDER, from: { datasetId: SALES.id, column: 'sale_id' }, to: RELS[0].to, cardinality: 'many_to_one' });
  const moved = (await rels.listRelationships(Q))[0];
  ok('negative control: a re-save that changes the edge\'s columns does not inherit its label (nor its warning)',
    moved.id === R_ORDER && moved.from.column === 'sale_id' && moved.label === undefined && moved.warning === undefined, show(moved));

  fx.removeFixture();
  fs.rmSync(process.env.ORDINATE_LOCAL_DIR as string, { recursive: true, force: true });
  finish();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
