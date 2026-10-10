// The Live safety net (docs/live-data/00-plan.md L2.1, D6) over the real RPC
// route, in server mode, against org acme's locked DuckDB worker.
//
// A Live dataset stores its schema and nothing else. Every channel that READS
// ROWS and is not routed to the warehouse would, handed one, find zero rows and
// compute a confident zero. So:
//
// 1. EVERY ROW-READING CHANNEL ANSWERS FROM THE WAREHOUSE OR REFUSES, TYPED.
//    Each channel whose contract takes a dataset (enumerated from src/api/ —
//    see ROW_READERS) is called against a Live dataset over the test harness's
//    fake warehouse (scripts/liveFakeConnector.ts). The doors L2.4 routes —
//    charts, KPI tiles, answers and what funnels into them (ROUTED) — must
//    ANSWER, with a live-dated figure. Every other one must answer the typed
//    refusal: HTTP 409 `live_dataset` with the catalog's sentence, or a
//    handler's own `{ok:false, code:'live_dataset' | 'live_refused'}` (a pivot,
//    cohort or funnel is the compiler's refusal; a picker with no list of values
//    to give says which case it is, §5). Never a 200 with a figure in it.
// 2. NOTHING THAT MERELY LISTS BREAKS. The list, columns, source, catalog,
//    lineage, search, Home, trash/restore, versions and a project bundle all
//    answer 200 with the Live dataset in them (or skipped, for a value search).
// 3. A refusal carries no SQL text, no address and no dataset id — including a
//    routed door whose Live dataset's connection is gone (a second Live dataset,
//    whose origin is a canary SQL text): every reader is a typed failure there.
// 4. Negative control: the same channels on an EXTRACT dataset with the same
//    columns answer without the refusal — the net is not a blanket 409.
// 5. A PROFILE OPENS TWO DOORS, NO MORE (L2.5). Once a schema sync has stored
//    a profile, the filter pickers (`dataset:distinct`) and the column panel
//    (`dataset:profile`) answer from it — flagged as a sample's — and every
//    other row reader above still refuses, typed. Before it, they refuse (1).
//
//   npm run build:ts && node scripts/test-liveSafetyNet.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livenet-'));
const SQL_CANARY = 'select_SECRET_CANARY_7f19 from warehouse.orders';

const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };

const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'sales', type: 'number' },
  { name: 'day', type: 'date' },
  { name: 'customer', type: 'text' },
  { name: 'qty', type: 'number' },
];
const ROWS: Cell[][] = Array.from({ length: 120 }, (_, i) => [
  `r${i % 5}`, (i * 37) % 101, `2024-0${1 + (i % 9)}-1${i % 9}`, `c${i % 17}`, (i * 7) % 13,
]);
const WAREHOUSE_TYPE: Record<string, string> = { text: 'VARCHAR', number: 'DOUBLE', date: 'DATE' };

/** The fake warehouse's table: ROWS typed as a warehouse holds them, in the current org's DuckDB worker. */
async function loadWarehouseTable(table: string): Promise<void> {
  await duck.execAsync(`CREATE OR REPLACE TABLE "${table}" (${COLUMNS.map((c) => `"${c.name}" ${WAREHOUSE_TYPE[c.type]}`).join(', ')})`);
  const params: Cell[] = [];
  const tuples = ROWS.map((r) => `(${COLUMNS.map((c, i) => { params.push(r[i]); return `CAST($${params.length} AS ${WAREHOUSE_TYPE[c.type]})`; }).join(', ')})`);
  await duck.queryAsync(`INSERT INTO "${table}" VALUES ${tuples.join(', ')}`, params as (string | number | null)[]);
}

(async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
  const messages: typeof import('../src/data/liveMessages') = require('../src/data/liveMessages');

  fakeMod.registerLiveFake();
  const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Live safety net')).id;
    const extract = await datasets.saveDataset(projectId, { name: 'Orders copy', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
    // The Live dataset under test: the same rows in the fake warehouse, over a real connection record.
    await loadWarehouseTable('live_net_orders');
    const conn = await connections.saveConnection(projectId, { name: 'Fake warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
    const live = conn && await liveRecord.saveLiveRecord(projectId, {
      name: 'Orders live', columns: COLUMNS, origin: { kind: 'connection', connId: conn.id, table: 'live_net_orders' },
    });
    // The canary: a Live dataset whose connection is gone and whose origin is a SQL text no reply may carry.
    const gone = await liveRecord.saveLiveRecord(projectId, {
      name: 'Orders gone',
      columns: COLUMNS,
      origin: { kind: 'connection', connId: '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d', sql: SQL_CANARY },
    });
    if (!extract || !live || !gone) throw new Error('fixture not saved');
    return { projectId, extract: extract.id, live: live.id, gone: gone.id };
  });
  const P = seed.projectId;
  duck.forbidSyncOnMainThread();

  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const post = async (channel: string, payload: unknown) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }),
      payload: wire.encode({ args: [payload] }),
    });
    let value: unknown = null;
    try {
      value = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body);
    } catch {
      value = null;
    }
    return { status: r.statusCode, body: r.body, value: value as Record<string, unknown> | null }; // a batch's reply is an array; typedReply reads either
  };
  const REFUSAL = messages.liveRefusedMessage();
  /** A Live code: the safety net's refusal, or the executor's typed failure (refused, unavailable, failed…). */
  const LIVE_CODES = new Set([liveDataset.LIVE_DATASET_CODE, 'live_refused', 'live_unavailable', 'live_failed', 'live_timeout', 'live_cancelled']);
  /** A handler's own reply: `{ok:false, code, error|reason}` — per item for a batch, where one Live tile must not fail the rest. */
  const typedReply = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.length > 0 && v.every(typedReply);
    const o = (v ?? {}) as Record<string, unknown>;
    if (o.ok !== false || typeof o.code !== 'string' || !LIVE_CODES.has(o.code)) return false;
    const said = typeof o.error === 'string' ? o.error : o.reason;
    return o.code === liveDataset.LIVE_DATASET_CODE ? said === REFUSAL : typeof said === 'string' && said.length > 0;
  };
  const isRefusal = (r: { status: number; value: unknown }): boolean =>
    (r.status === 409 && (r.value as Record<string, unknown> | null)?.code === liveDataset.LIVE_DATASET_CODE
      && (r.value as Record<string, unknown>).message === REFUSAL) ||
    (r.status === 200 && typedReply(r.value));

  // A metric and a visual on each dataset — the doors that name a dataset through a record.
  const mk = async (datasetId: string) => {
    const metric = await post('metric:save', { projectId: P, input: { name: `Sales ${datasetId.slice(0, 4)}`, datasetId, definition: { column: 'sales', aggregation: 'sum' } } });
    const metricId = String((metric.value?.metric as { id?: string } | undefined)?.id ?? (metric.value as { id?: string } | null)?.id ?? '');
    return { metricId };
  };
  const recs = { live: await mk(seed.live), extract: await mk(seed.extract), gone: await mk(seed.gone) };
  ok('a metric can be DEFINED on a Live dataset (a definition is metadata)', /^[0-9a-f-]{36}$/.test(recs.live.metricId), JSON.stringify(recs.live));

  const enc = { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] };
  /** Every channel that reads a dataset's rows, enumerated from the src/api contracts that take a dataset. */
  const ROW_READERS = (d: string, other: string, metricId: string): [string, string, unknown][] => [
    // the table view, its search and its profile
    ['table view', 'dataset:page', { projectId: P, datasetId: d, offset: 0, limit: 50 }],
    ['table search', 'dataset:page', { projectId: P, datasetId: d, offset: 0, limit: 50, search: 'r1' }],
    ['column stats', 'dataset:stats', { projectId: P, datasetId: d }],
    ['column profile', 'dataset:profile', { projectId: P, datasetId: d, column: 'sales' }],
    ['distinct values', 'dataset:distinct', { projectId: P, datasetId: d, column: 'region' }],
    ['retype a column', 'dataset:update', { projectId: P, datasetId: d, columns: COLUMNS.map((c) => (c.name === 'qty' ? { name: 'qty', type: 'text' } : c)) }],
    // prepare steps and formulas
    ['prepare: open', 'prepare:get', { projectId: P, datasetId: d }],
    ['prepare: add step', 'dataset:addStep', { projectId: P, datasetId: d, step: { type: 'filter', column: 'sales', op: '>', value: 1 } }],
    ['prepare: set steps', 'dataset:setSteps', { projectId: P, datasetId: d, steps: [{ type: 'filter', column: 'sales', op: '>', value: 1 }] }],
    ['prepare: step preview', 'prepare:stepPreview', { projectId: P, datasetId: d, index: -1, step: { type: 'split_column', column: 'region', mode: 'delimiter', delimiter: '-' } }],
    ['prepare: suggest steps', 'dataset:suggestSteps', { projectId: P, datasetId: d }],
    ['prepare: suggest calc field', 'dataset:suggestCalcField', { projectId: P, datasetId: d }],
    ['formula check', 'formula:check', { projectId: P, datasetId: d, expression: '[sales] * 2' }],
    ['text profile', 'text:profile', { projectId: P, datasetId: d, column: 'region' }],
    ['text preview', 'text:preview', { projectId: P, datasetId: d, index: -1, step: { type: 'text_sentiment', column: 'region' } }],
    ['spatial preview', 'geo:spatialPreview', { projectId: P, datasetId: d, index: -1, step: { type: 'spatial_join', lat: 'sales', lng: 'qty', boundary: 'country' } }],
    // quality checks
    ['quality: run', 'quality:run', { projectId: P, datasetId: d }],
    ['quality: preview a rule', 'quality:preview', { projectId: P, datasetId: d, rule: { kind: 'not_null', column: 'sales', severity: 'fail' } }],
    // stats, insights, anomalies
    ['stats: correlation', 'stats:run', { projectId: P, spec: { kind: 'correlation', datasetId: d, columns: ['sales', 'qty'] } }],
    ['stats: distribution', 'stats:run', { projectId: P, spec: { kind: 'distribution', datasetId: d, columns: ['sales'] } }],
    ['insights and anomalies', 'insights:list', { projectId: P, datasetId: d }],
    // charts: plain, pivot, cohort, event funnel, the batch, rows behind a mark
    ['chart (visual:data)', 'visual:data', { projectId: P, datasetId: d, encoding: enc }],
    ['chart batch', 'visual:dataBatch', { projectId: P, items: [{ datasetId: d, encoding: enc }] }],
    ['chart preview', 'visual:preview', { projectId: P, datasetId: d, encoding: enc }],
    ['pivot', 'visual:data', { projectId: P, datasetId: d, encoding: { ...enc, pivot: { rows: [{ column: 'region' }], columns: [], values: [{ column: 'sales', aggregation: 'sum' }] } } }],
    ['cohort', 'visual:data', { projectId: P, datasetId: d, encoding: { ...enc, cohort: { entity: 'customer', date: 'day', grain: 'month' } } }],
    ['event funnel', 'visual:data', { projectId: P, datasetId: d, encoding: { ...enc, eventFunnel: { entity: 'customer', event: 'region', time: 'day', steps: ['r1', 'r2'] } } }],
    ['rows behind a mark', 'visual:rows', { projectId: P, datasetId: d, encoding: enc, mark: { category: 'r1' } }],
    ['visual suggestions', 'visual:suggest', { projectId: P, datasetId: d }],
    // KPI tiles and metric values
    ['KPI tile (dashboard:metric)', 'dashboard:metric', { projectId: P, datasetId: d, column: 'sales', aggregation: 'sum' }],
    ['dashboard tiles', 'analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: d, encoding: enc }] }],
    ['metric preview', 'metric:preview', { projectId: P, datasetId: d, definition: { column: 'sales', aggregation: 'sum' } }],
    ['metric values', 'metric:values', { projectId: P, ids: [metricId] }],
    ['metric check (the measure editor)', 'metric:check', { projectId: P, datasetId: d, expression: 'sum(sales) / sum(qty)', name: 'Per unit', chart: true }],
    // answers
    ['answer card', 'answer:card', { projectId: P, spec: { datasetId: d, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [] } }],
    ['answer: explain a tile', 'answer:explain', { projectId: P, tile: { datasetId: d, encoding: enc, filters: [], chartType: 'bar', name: 'Sales by region' } }],
    ['answer: rerun', 'answer:rerun', { projectId: P, spec: { datasetId: d, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [] } }],
    // drivers, segments, scenarios
    ['key drivers', 'drivers:explain', { projectId: P, request: { datasetId: d, metric: { column: 'sales', aggregation: 'sum' }, compare: { mode: 'latest', column: 'day' }, dimension: 'region' } }],
    ['key drivers from a chart point', 'drivers:explainPoint', { projectId: P, datasetId: d, encoding: { category: 'day', values: [{ column: 'sales', aggregation: 'sum' }], grain: 'month' }, point: {} }],
    ['segments: features', 'segments:features', { projectId: P, datasetId: d }],
    ['segments: fit', 'segments:fit', { projectId: P, datasetId: d, features: ['sales', 'qty'] }],
    ['segments: RFM', 'segments:rfm', { projectId: P, datasetId: d, spec: { id: 'customer', date: 'day', amount: 'sales' } }],
    // joins
    ['join preview (composer)', 'dataset:composePreview', { projectId: P, base: { datasetId: d }, joins: [{ datasetId: other, mode: 'left', on: { left: 'region', right: 'region' } }], offset: 0, limit: 50 }],
    ['join key suggestion', 'relationship:suggest', { projectId: P, fromId: d, toId: other }],
    // alerts: a rule's test run reads the periods and the anomalies
    ['alert test: threshold', 'alerts:test', { projectId: P, rule: { id: '3f0c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b', datasetId: d, metric: { column: 'sales', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 10 } } }],
    ['alert test: change vs period', 'alerts:test', { projectId: P, rule: { id: '3f0c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4c', datasetId: d, metric: { column: 'sales', aggregation: 'sum' }, compare: 'change', change: { pct: 10, vs: 'previous_period', periodColumn: 'day' } } }],
    ['alert test: anomaly', 'alerts:test', { projectId: P, rule: { id: '3f0c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4d', datasetId: d, metric: { column: 'sales', aggregation: 'sum' }, compare: 'anomaly' } }],
    // snapshots
    ['snapshots: restore', 'snapshots:restore', { projectId: P, datasetId: d, stamp: '2024-01-01T00-00-00-000Z' }],
    ['snapshots: diff', 'snapshots:diff', { projectId: P, datasetId: d, stamp: '2024-01-01T00-00-00-000Z' }],
    ['snapshots: keep', 'snapshots:setKeep', { projectId: P, datasetId: d, keep: 3 }],
  ];

  /**
   * The readers L2.4 routes to the warehouse: charts, KPI tiles, answers and the
   * batches over them. On the Live dataset each must ANSWER — and a figure must
   * be dated by the warehouse (`asOf.mode: 'live'`), never by the record.
   */
  const ROUTED = new Set(['chart (visual:data)', 'chart batch', 'chart preview', 'KPI tile (dashboard:metric)', 'dashboard tiles',
    'metric preview', 'metric values', 'metric check (the measure editor)', 'answer card', 'answer: explain a tile', 'answer: rerun', 'alert test: threshold']);
  /** Every `ok` in a reply (a batch answers per item): all true, and every dated one dated live. */
  const answered = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.length > 0 && v.every(answered);
    const o = (v ?? {}) as Record<string, unknown>;
    const asOf = o.asOf as { mode?: string } | undefined;
    return o.ok !== false && !('code' in o) && (!asOf || asOf.mode === 'live');
  };

  // ── 1. Every row reader answers from the warehouse or refuses, typed ───────
  const bodies: string[] = [];
  for (const [label, channel, payload] of ROW_READERS(seed.live, seed.extract, recs.live.metricId)) {
    const r = await post(channel, payload);
    bodies.push(r.body);
    if (ROUTED.has(label)) ok(`Live → ${label} (${channel}) ANSWERS from the warehouse (L2.4)`, r.status === 200 && answered(r.value), `${r.status} ${r.body.slice(0, 240)}`);
    else ok(`Live → ${label} (${channel}) refuses, typed`, isRefusal(r), `${r.status} ${r.body.slice(0, 240)}`);
  }
  ok('every routed door was exercised', ROW_READERS(seed.live, seed.extract, '').filter(([l]) => ROUTED.has(l)).length === ROUTED.size);
  // The canary Live dataset (its connection gone): EVERY reader — routed or not — a typed failure.
  for (const [label, channel, payload] of ROW_READERS(seed.gone, seed.extract, recs.gone.metricId)) {
    const r = await post(channel, payload);
    bodies.push(r.body);
    ok(`Live, connection gone → ${label} (${channel}) is a typed failure`, isRefusal(r), `${r.status} ${r.body.slice(0, 240)}`);
  }
  // The project's SQL over a Live dataset by name: refused, never an empty table.
  const sqlRun = await post('sql:run', { projectId: P, sql: 'SELECT count(*) AS n FROM "Orders live"' });
  bodies.push(sqlRun.body);
  ok('Live → SQL over datasets (sql:run) refuses, typed', isRefusal(sqlRun), `${sqlRun.status} ${sqlRun.body.slice(0, 240)}`);
  // Scenarios compute from metric values.
  const scen = await post('scenario:create', { projectId: P, input: { name: 'What if', baseMetricIds: [recs.live.metricId], drivers: [] } });
  const scenarioId = String((scen.value?.scenario as { id?: string } | undefined)?.id ?? '');
  if (scenarioId) {
    const sc = await post('scenario:compute', { projectId: P, id: scenarioId, draft: { baseMetricIds: [recs.live.metricId], drivers: [{ kind: 'pct', value: 10 }] } });
    bodies.push(sc.body);
    ok('Live → scenario compute refuses, typed', isRefusal(sc), `${sc.status} ${sc.body.slice(0, 240)}`);
  } else {
    ok('a scenario on a Live metric could be created to test', false, scen.body.slice(0, 240));
  }

  // A chart can be DEFINED on a Live dataset, and its thumbnail is drawn through the chart door (L2.4).
  const vis = await post('visual:save', { projectId: P, datasetId: seed.live, name: 'Sales by region', chartType: 'bar', encoding: enc });
  const visualId = String((vis.value?.visual as { id?: string } | undefined)?.id ?? (vis.value as { id?: string } | null)?.id ?? '');
  ok('a visual can be saved on a Live dataset (a definition is metadata)', vis.status === 200 && /^[0-9a-f-]{36}$/.test(visualId), vis.body.slice(0, 240));
  if (visualId) {
    const thumbs = await post('visual:thumbs', { projectId: P, ids: [visualId] });
    bodies.push(thumbs.body);
    ok('Live → gallery thumbnail (visual:thumbs) ANSWERS from the warehouse (L2.4)', thumbs.status === 200 && answered(thumbs.value), `${thumbs.status} ${thumbs.body.slice(0, 240)}`);
  }
  const goneVis = await post('visual:save', { projectId: P, datasetId: seed.gone, name: 'Gone by region', chartType: 'bar', encoding: enc });
  const goneVisualId = String((goneVis.value?.visual as { id?: string } | undefined)?.id ?? '');
  if (goneVisualId) {
    const thumbs = await post('visual:thumbs', { projectId: P, ids: [goneVisualId] });
    bodies.push(thumbs.body);
    ok('Live, connection gone → gallery thumbnail is a typed failure', thumbs.status === 200 && /"code":"live_unavailable"/.test(thumbs.body), `${thumbs.status} ${thumbs.body.slice(0, 240)}`);
  }

  // A subscription reads a dashboard's cards (src/ipc/subscriptionFigures.ts): through the doors, so a
  // Live KPI is the warehouse's figure, and one whose connection is gone says why — never a zero.
  const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
  const boardOn = (datasetId: string, visual: string) => context.runInContext(ADMIN, 'board', async () => (await analysisStore.saveAnalysis(P, {
    name: 'Board',
    sheets: [{ name: 'One', cards: [
      { id: crypto.randomUUID(), type: 'metric', layout: { x: 0, y: 0, w: 3, h: 4 }, metric: { datasetId, column: 'sales', aggregation: 'sum', label: 'Sales' } },
      ...(visual ? [{ id: crypto.randomUUID(), type: 'visual', layout: { x: 3, y: 0, w: 6, h: 4 }, visualId: visual }] : []),
    ] }],
  } as never))!.id);
  const subDraft = (analysisId: string) => ({
    name: 'Send', analysisId, content: { mode: 'all', cardIds: [] }, schedule: { cadence: 'daily', at: '08:00' }, timezone: 'UTC', channelIds: [],
    message: { title: '', note: '', includeLink: false }, conditions: { skipUnchanged: false, onlyWhenRefreshed: false },
  });
  type SubModel = { kpis: { value: string }[]; sections: { rows: string[][]; note?: string }[] };
  const subLive = await post('subscription:preview', { projectId: P, draft: subDraft(await boardOn(seed.live, visualId)) });
  const liveModel = (subLive.value?.slack as { model?: SubModel } | undefined)?.model;
  bodies.push(subLive.body);
  ok('Live → a subscription\'s message (subscription:preview) ANSWERS from the warehouse: the KPI is a figure, the chart has rows (L2.4)',
    subLive.status === 200 && !!liveModel && /\d/.test(liveModel.kpis[0].value) && liveModel.sections[0].rows.length === 5, `${subLive.status} ${subLive.body.slice(0, 240)}`);
  const subGone = await post('subscription:preview', { projectId: P, draft: subDraft(await boardOn(seed.gone, goneVisualId)) });
  const goneModel = (subGone.value?.slack as { model?: SubModel } | undefined)?.model;
  bodies.push(subGone.body);
  ok('Live, connection gone → a subscription\'s cards each carry the failure\'s sentence — no figure, no rows, no SQL, no dataset id',
    subGone.status === 200 && !!goneModel && !/^[\d.,]+[KMB]?$/.test(goneModel.kpis[0].value) && goneModel.kpis[0].value.length > 10
      && goneModel.sections.every((sec) => sec.rows.length === 0 && typeof sec.note === 'string' && sec.note.length > 10)
      && !subGone.body.includes('SECRET_CANARY') && !subGone.body.includes(seed.gone), `${subGone.status} ${subGone.body.slice(0, 300)}`);

  // ── 3. A refusal leaks nothing ─────────────────────────────────────────────
  ok('no refusal carries the selection\'s SQL', bodies.every((b) => !b.includes('SECRET_CANARY')));
  ok('no refusal carries the dataset id', bodies.filter((b) => /"code":"live_/.test(b)).every((b) => !b.includes(seed.live) && !b.includes(seed.gone)));

  // ── 4. Negative control: the same readers on the extract do not refuse ─────
  let extractRefused = 0;
  for (const [label, channel, payload] of ROW_READERS(seed.extract, seed.extract, recs.extract.metricId)) {
    const r = await post(channel, payload);
    if (isRefusal(r) || /live_dataset/.test(r.body)) {
      extractRefused++;
      console.error(`     extract refused: ${label}`);
    }
  }
  ok('negative control: no reader refuses the EXTRACT with the same columns', extractRefused === 0, String(extractRefused));

  // ── 2. Nothing that merely lists breaks ────────────────────────────────────
  for (const [label, channel, payload] of [
    ['dataset list', 'dataset:list', { projectId: P }],
    ['grid header', 'dataset:columns', { projectId: P, id: seed.live }],
    ['source', 'dataset:source', { projectId: P, id: seed.live }],
    ['catalog list', 'catalog:list', { projectId: P }],
    ['catalog columns', 'catalog:columns', { projectId: P, datasetId: seed.live }],
    ['catalog record', 'catalog:get', { projectId: P, ref: `dataset:${seed.live}` }],
    ['lineage', 'lineage:get', { projectId: P, type: 'dataset', id: seed.live }],
    ['relationships list', 'relationship:list', { projectId: P }],
    ['related datasets', 'relationship:related', { projectId: P, datasetId: seed.extract }],
    ['quality rules list', 'quality:list', { projectId: P, datasetId: seed.live }],
    ['snapshots list', 'snapshots:list', { projectId: P, datasetId: seed.live }],
    ['incremental refresh settings', 'incremental:get', { projectId: P, datasetId: seed.live }],
    ['Home', 'home:overview', { projectId: P }],
    ['palette search', 'search:query', { projectId: P, query: 'Orders' }],
    ['project insights', 'insights:list', { projectId: P }],
    ['privacy overview', 'privacy:overview', { projectId: P }],
    ['privacy scan of the project', 'privacy:scan', { projectId: P }],
    ['pipelines', 'pipelines:get', { projectId: P }],
    ['metrics list', 'metric:list', { projectId: P }],
    ['SQL schema', 'sql:schema', { projectId: P }],
    ['versions', 'versions:list', { projectId: P, type: 'dataset', id: seed.live }],
    ['as-of stamps', 'dashboard:asOfStamps', { projectId: P, datasetIds: [seed.live, seed.extract], metricIds: [] }],
    ['Live schema panel (unsynced)', 'dataset:liveSchema', { projectId: P, datasetId: seed.live }],
  ] as [string, string, unknown][]) {
    const r = await post(channel, payload);
    ok(`lists: ${label} (${channel}) answers 200`, r.status === 200 && !/live_dataset/.test(r.body), `${r.status} ${r.body.slice(0, 240)}`);
  }
  // The way OUT of the net (L2.6): "Make a copy" reads the warehouse, never the stored rows, so it is
  // never the refusal — on the canary dataset it answers that the connection is gone, and names no SQL
  // (its full flow, on a working connection: test-liveCopy).
  const copied = await post('dataset:copyLive', { projectId: P, datasetId: seed.gone });
  ok('the way out: Make a copy (dataset:copyLive) answers 200, never the live_dataset refusal, no SQL',
    copied.status === 200 && copied.value?.ok === false && copied.value.error === messages.liveConnectionGoneMessage() && !/live_dataset/.test(copied.body)
      && !copied.body.includes('SECRET_CANARY'), `${copied.status} ${copied.body.slice(0, 240)}`);
  const list = await post('dataset:list', { projectId: P });
  const row = (list.value as unknown as { id: string; mode?: string; maxCacheAgeSec?: number }[]).find((x) => x.id === seed.live);
  ok('the list names the Live dataset as Live, with its cache age', row?.mode === 'live' && row?.maxCacheAgeSec === liveDataset.DEFAULT_MAX_CACHE_AGE_SEC, JSON.stringify(row));
  const search = await post('dataSearch:query', { projectId: P, term: 'r1' });
  const hits = (search.value?.hits as { datasetId: string }[] | undefined) ?? [];
  ok('a value search skips the Live dataset and still searches the extract', search.status === 200 && hits.some((h) => h.datasetId === seed.extract) && !hits.some((h) => h.datasetId === seed.live), search.body.slice(0, 240));
  const exported = await post('projects:export', { id: P });
  ok('a project bundle exports with a Live dataset in it', exported.status === 200 && exported.value?.ok !== false, exported.body.slice(0, 240));
  const trashed = await post('dataset:delete', { projectId: P, id: seed.live });
  ok('a Live dataset moves to the Trash', trashed.status === 200 && trashed.value?.ok === true, trashed.body.slice(0, 240));
  const trashList = await post('trash:list', { projectId: P });
  ok('…the Trash lists it', trashList.status === 200 && trashList.body.includes(seed.live));
  const restored = await post('trash:restore', { projectId: P, type: 'dataset', id: seed.live });
  ok('…and restores it', restored.status === 200 && restored.value?.ok === true, restored.body.slice(0, 240));
  const back = await post('dataset:list', { projectId: P });
  ok('…still Live after the round trip', (back.value as unknown as { id: string; mode?: string }[]).some((x) => x.id === seed.live && x.mode === 'live'));

  // ── 5. A profile opens the pickers and the column panel, nothing else ──────
  const PROFILED = new Set(['dataset:distinct', 'dataset:profile']);
  const synced = await context.runInContext(ADMIN, 'profile', () => liveDataset.writeSchemaSync(P, seed.live, {
    columns: COLUMNS,
    profile: {
      sampledAt: new Date().toISOString(), sampleRows: 120, method: 'sample',
      columns: [
        { name: 'region', filled: 120, distinct: 5, values: ['r0', 'r1', 'r2', 'r3', 'r4'], counts: [24, 24, 24, 24, 24] },
        { name: 'sales', filled: 120, distinct: 101 },
      ],
    },
    missingColumns: [],
    syncedAt: new Date().toISOString(),
    changed: false,
  }));
  ok('a schema sync\'s profile lands on the Live record', synced === true);
  const picked = await post('dataset:distinct', { projectId: P, datasetId: seed.live, column: 'region', limit: 3 });
  ok('profiled → the filter picker answers from the sample, flagged approximate', picked.status === 200 && JSON.stringify(picked.value?.values) === '["r0","r1","r2"]'
    && picked.value?.total === 5 && picked.value?.approximate === true && !picked.body.includes('SECRET_CANARY'), picked.body.slice(0, 240));
  const unmeasured = await post('dataset:distinct', { projectId: P, datasetId: seed.live, column: 'customer' });
  ok('profiled, but a column the sample never measured → still refuses, typed (never an empty list)', isRefusal(unmeasured), unmeasured.body.slice(0, 240));
  // The picker's refusal is a REPLY that says which case it is (L2.6's leftover) — recognised exactly, on top of `isRefusal`.
  const pmsg: typeof import('../src/engine/liveProfileMessages') = require('../src/engine/liveProfileMessages');
  const noList = (r: { status: number; value: Record<string, unknown> | null }, reason: string, sentence: string): boolean => isRefusal(r) && r.status === 200
    && r.value?.code === 'live_refused' && r.value.reason === reason && r.value.error === sentence && !('values' in r.value) && !('total' in r.value);
  const unlisted = await post('dataset:distinct', { projectId: P, datasetId: seed.live, column: 'sales' });
  const NOT_LISTED = pmsg.liveValuesNotListed('50');
  ok('…and says why: not sampled for the unmeasured column, not listed for a column with 101 values — neither carries a list',
    noList(unmeasured, 'notSampled', pmsg.liveValuesNotSampled()) && noList(unlisted, 'notListed', NOT_LISTED), `${unmeasured.body.slice(0, 160)} | ${unlisted.body.slice(0, 160)}`);
  ok('NEGATIVE CONTROL: the recogniser takes neither the listed column\'s answer, nor an untyped empty list, nor a refusal without its sentence', !isRefusal(picked)
    && !isRefusal({ status: 200, value: { values: [], total: 0 } }) && !noList({ status: 200, value: { ok: false, code: 'live_refused', reason: 'notListed' } }, 'notListed', NOT_LISTED)
    && !noList(unlisted, 'notSynced', NOT_LISTED), picked.body.slice(0, 160));
  const panel = await post('dataset:profile', { projectId: P, datasetId: seed.live, column: 'sales' });
  const prof = panel.value?.profile as { distinct?: number; sample?: { rows?: number } } | undefined;
  ok('profiled → the column panel answers from the sample, and says so', panel.value?.ok === true && prof?.distinct === 101 && prof.sample?.rows === 120, panel.body.slice(0, 240));
  let stillRefused = 0;
  let others = 0;
  let routedAnswered = 0;
  for (const [label, channel, payload] of ROW_READERS(seed.live, seed.extract, recs.live.metricId)) {
    if (PROFILED.has(channel)) continue;
    const r = await post(channel, payload);
    // The doors L2.4 routes answer from the warehouse, profiled or not (§1); the profile opens none of the rest.
    if (ROUTED.has(label)) {
      if (r.status === 200 && answered(r.value)) routedAnswered++;
      continue;
    }
    others++;
    if (isRefusal(r)) stillRefused++;
    else console.error(`     profiled Live answered: ${label} ${r.status} ${r.body.slice(0, 160)}`);
  }
  ok(`profiled → every other row reader (${others}) still refuses, typed — a profile is not rows`, stillRefused === others && others > 30, `${stillRefused}/${others}`);
  ok(`profiled → the ${ROUTED.size} routed doors still answer from the warehouse`, routedAnswered === ROUTED.size, `${routedAnswered}/${ROUTED.size}`);

  // getDataset itself: throws on Live, a typed error; the metadata read does not.
  await context.runInContext(ADMIN, 'direct', async () => {
    let thrown: unknown = null;
    try {
      await datasets.getDataset(P, seed.live);
    } catch (err) {
      thrown = err;
    }
    ok('getDataset on a Live dataset throws LiveDatasetError', liveDataset.isLiveDatasetError(thrown), String(thrown));
    const meta = await datasets.getDatasetMeta(P, seed.live);
    ok('getDatasetMeta reads it — Live, schema only, not resident', meta?.mode === 'live' && meta.resident === false && meta.columns.length === COLUMNS.length);
    ok('residentSource is null for it (so every resident path falls through to the refusal)', (await datasets.residentSource(P, seed.live)) === null);
    const summaries = await datasets.listDatasets(P);
    ok('listDatasets does not throw and lists all three', summaries.length === 3);
  });

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
