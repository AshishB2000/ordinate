// The Live safety net (docs/live-data/00-plan.md L2.1, D6) over the real RPC
// route, in server mode, against org acme's locked DuckDB worker.
//
// A Live dataset stores its schema and nothing else. Every channel that READS
// ROWS and is not yet routed to the warehouse (L2.4) would, handed one, find
// zero rows and compute a confident zero. So:
//
// 1. EVERY ROW-READING CHANNEL REFUSES, TYPED. Each channel whose contract
//    takes a dataset (enumerated from src/api/ — see ROW_READERS) is called
//    against a Live dataset and must answer the typed refusal: HTTP 409
//    `live_dataset` with the catalog's sentence, or a handler's own
//    `{ok:false, code:'live_dataset'}`. Never a 200 with a figure in it.
//    Charts, KPI tiles and answers refuse too until L2.4 routes them.
// 2. NOTHING THAT MERELY LISTS BREAKS. The list, columns, source, catalog,
//    lineage, search, Home, trash/restore, versions and a project bundle all
//    answer 200 with the Live dataset in them (or skipped, for a value search).
// 3. A refusal carries no SQL text, no address and no dataset id.
// 4. Negative control: the same channels on an EXTRACT dataset with the same
//    columns answer without the refusal — the net is not a blanket 409.
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

(async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
  const messages: typeof import('../src/data/liveMessages') = require('../src/data/liveMessages');

  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Live safety net')).id;
    const extract = await datasets.saveDataset(projectId, { name: 'Orders copy', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
    const live = await liveRecord.saveLiveRecord(projectId, {
      name: 'Orders live',
      columns: COLUMNS,
      origin: { kind: 'connection', connId: '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d', sql: SQL_CANARY },
    });
    if (!extract || !live) throw new Error('fixture not saved');
    return { projectId, extract: extract.id, live: live.id };
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
  /** A handler's own reply: `{ok:false, code, error|reason}` — per item for a batch, where one Live tile must not fail the rest. */
  const typedReply = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.length > 0 && v.every(typedReply);
    const o = (v ?? {}) as Record<string, unknown>;
    return o.ok === false && o.code === liveDataset.LIVE_DATASET_CODE && (o.error === REFUSAL || o.reason === REFUSAL);
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
  const recs = { live: await mk(seed.live), extract: await mk(seed.extract) };
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
    // answers
    ['answer card', 'answer:card', { projectId: P, spec: { datasetId: d, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [] } }],
    // drivers, segments, scenarios
    ['key drivers', 'drivers:explain', { projectId: P, request: { datasetId: d, metric: { column: 'sales', aggregation: 'sum' }, compare: { mode: 'latest', column: 'day' }, dimension: 'region' } }],
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

  // ── 1. Every row reader refuses a Live dataset, typed ─────────────────────
  const bodies: string[] = [];
  for (const [label, channel, payload] of ROW_READERS(seed.live, seed.extract, recs.live.metricId)) {
    const r = await post(channel, payload);
    bodies.push(r.body);
    ok(`Live → ${label} (${channel}) refuses, typed`, isRefusal(r), `${r.status} ${r.body.slice(0, 240)}`);
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

  // A chart can be DEFINED on a Live dataset (L2.4 draws it); its thumbnail refuses until then.
  const vis = await post('visual:save', { projectId: P, datasetId: seed.live, name: 'Sales by region', chartType: 'bar', encoding: enc });
  const visualId = String((vis.value?.visual as { id?: string } | undefined)?.id ?? (vis.value as { id?: string } | null)?.id ?? '');
  ok('a visual can be saved on a Live dataset (a definition is metadata)', vis.status === 200 && /^[0-9a-f-]{36}$/.test(visualId), vis.body.slice(0, 240));
  if (visualId) {
    const thumbs = await post('visual:thumbs', { projectId: P, ids: [visualId] });
    bodies.push(thumbs.body);
    ok('Live → gallery thumbnail (visual:thumbs) refuses, typed', isRefusal(thumbs) || /"code":"live_dataset"/.test(thumbs.body), `${thumbs.status} ${thumbs.body.slice(0, 240)}`);
  }

  // ── 3. A refusal leaks nothing ─────────────────────────────────────────────
  ok('no refusal carries the selection\'s SQL', bodies.every((b) => !b.includes('SECRET_CANARY')));
  ok('no refusal carries the dataset id', bodies.filter((b) => /live_dataset/.test(b)).every((b) => !b.includes(seed.live)));

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
  ] as [string, string, unknown][]) {
    const r = await post(channel, payload);
    ok(`lists: ${label} (${channel}) answers 200`, r.status === 200 && !/live_dataset/.test(r.body), `${r.status} ${r.body.slice(0, 240)}`);
  }
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
    ok('listDatasets does not throw and lists both', summaries.length === 2);
  });

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
