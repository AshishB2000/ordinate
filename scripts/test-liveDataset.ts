// Self-check for the Live dataset record (docs/live-data/00-plan.md L2.1, D5,
// D6): src/data/liveDataset.ts, liveSchema.ts, liveRecord.ts and the channels
// in src/ipc/liveDatasets.ts — over the real RPC route in server mode.
//
// 1. Sanitising. maxCacheAgeSec is an integer in 0 s – 30 days, default 300:
//    a stored 31 days is CLAMPED (a record must load), a requested 31 days is
//    REFUSED (by the contract and by parseMaxCacheAge) — negative controls on
//    both sides; an epoch is a non-negative integer (−1 → 0); a damaged Live
//    block is repaired, never read as an extract.
// 2. Declared types, per dialect, from the catalog's own type names — never
//    from values; a connector's declared `columnType` wins; unknown → text.
// 3. The record: schema only, listed (Live, with its cache age), `getDataset`
//    throws the typed error while every metadata read answers; `bumpEpoch`
//    is metadata-only; `dataset:source` carries `live` + `maxCacheAgeSec` and
//    NO SQL text, no host, no URL (the reply is grepped for planted canaries).
// 4. The mode switch's refusals: no connection origin, prepare steps, no
//    confirm for dropping the stored copy, an out-of-range cache age.
// 5. With DATABASE_URL — the whole flow against a real Postgres through the
//    Redshift connector (a Live dialect): "Add from connection → Live" for a
//    table (catalog types) and a query (a one-row run); Live → extract runs a
//    normal import; extract → Live drops the Parquet; Refresh bumps the epoch;
//    a non-live connector is refused; duplicate column names are refused.
//
//   npm run build:ts && node scripts/test-liveDataset.js
//   DATABASE_URL=postgres://… node scripts/test-liveDataset.js   # + section 5

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livedataset-'));
const SQL_CANARY = 'SELECT canary_col_9b1e FROM secret_schema_9b1e.orders';
const HOST_CANARY = 'warehouse-9b1e.canary.example';

const live: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
const schema: typeof import('../src/data/liveSchema') = require('../src/data/liveSchema');
const api: typeof import('../src/api/index') = require('../src/api/index');
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const DAY = 24 * 60 * 60;

(async () => {
  // ── 1. Sanitising ──────────────────────────────────────────────────────────
  ok('the default cache age is 300 s', live.DEFAULT_MAX_CACHE_AGE_SEC === 300);
  ok('stored: a missing or non-number cache age reads as the default',
    live.sanitizeMaxCacheAge(undefined) === 300 && live.sanitizeMaxCacheAge('600') === 300 && live.sanitizeMaxCacheAge(NaN) === 300);
  ok('stored: 0 (always live) and 30 days are kept', live.sanitizeMaxCacheAge(0) === 0 && live.sanitizeMaxCacheAge(30 * DAY) === 30 * DAY);
  ok('negative control — stored: 31 days is CLAMPED to 30', live.sanitizeMaxCacheAge(31 * DAY) === 30 * DAY);
  ok('stored: a negative age clamps to 0, a fraction floors', live.sanitizeMaxCacheAge(-5) === 0 && live.sanitizeMaxCacheAge(90.9) === 90);
  ok('requested: an absent age is the default', live.parseMaxCacheAge(undefined) === 300);
  ok('requested: 0 and 30 days are accepted', live.parseMaxCacheAge(0) === 0 && live.parseMaxCacheAge(30 * DAY) === 30 * DAY);
  ok('negative control — requested: 31 days is REFUSED, not clamped', live.parseMaxCacheAge(31 * DAY) === null);
  ok('requested: −1, 1.5 and "60" are refused', live.parseMaxCacheAge(-1) === null && live.parseMaxCacheAge(1.5) === null && live.parseMaxCacheAge('60') === null);
  ok('the contract bound equals MAX_CACHE_AGE_SEC (src/api/live.ts imports only zod)', live.MAX_CACHE_AGE_SEC === 30 * DAY);
  const setMode = api.contracts['dataset:setMode'].input;
  const base = { projectId: '0b8f0e7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b', datasetId: '1b8f0e7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b', mode: 'live' };
  ok('contract: dataset:setMode takes 30 days', setMode.safeParse({ ...base, maxCacheAgeSec: 30 * DAY }).success);
  ok('negative control — contract: dataset:setMode refuses 31 days', !setMode.safeParse({ ...base, maxCacheAgeSec: 31 * DAY }).success);
  ok('contract: dataset:setMode refuses a negative age and an unknown mode',
    !setMode.safeParse({ ...base, maxCacheAgeSec: -1 }).success && !setMode.safeParse({ ...base, mode: 'cached' }).success);
  const imp = api.contracts['connection:import'].input;
  const impBase = { projectId: base.projectId, connId: base.datasetId, table: 'public.orders', limit: 10, mode: 'live' };
  ok('contract: connection:import takes mode live with a cache age', imp.safeParse({ ...impBase, maxCacheAgeSec: 60 }).success);
  ok('negative control — contract: connection:import refuses 31 days', !imp.safeParse({ ...impBase, maxCacheAgeSec: 31 * DAY }).success);
  ok('epoch: a non-negative integer is kept', live.sanitizeEpoch(0) === 0 && live.sanitizeEpoch(7) === 7);
  ok('negative control — epoch: −1, 1.5, NaN and "3" read as 0',
    live.sanitizeEpoch(-1) === 0 && live.sanitizeEpoch(1.5) === 0 && live.sanitizeEpoch(NaN) === 0 && live.sanitizeEpoch('3') === 0);
  ok('a record without mode is not Live', live.sanitizeLive({ live: { maxCacheAgeSec: 60, epoch: 1 } }) === undefined && !live.isLive({}));
  const repaired = live.sanitizeLive({ mode: 'live', live: 'garbage', updatedAt: '2024-05-01T00:00:00.000Z' });
  ok('a Live record with a damaged block is repaired to defaults — still Live, never an extract',
    !!repaired && repaired.maxCacheAgeSec === 300 && repaired.epoch === 0 && repaired.schemaSyncedAt === '2024-05-01T00:00:00.000Z', JSON.stringify(repaired));
  let threw: unknown = null;
  try {
    live.requireExtract({ id: 'x', mode: 'live' });
  } catch (err) {
    threw = err;
  }
  ok('requireExtract throws the typed error on Live', live.isLiveDatasetError(threw) && (threw as { code: string }).code === 'live_dataset');
  live.requireExtract({ id: 'x' });
  ok('…and passes an extract', true);
  const reply = { ok: true, items: [{ ok: false, error: new live.LiveDatasetError('x').message }, { ok: false, error: 'Other' }] };
  live.tagLiveRefusals(reply);
  ok('tagLiveRefusals types a caught refusal and leaves any other failure alone',
    (reply.items[0] as Record<string, unknown>).code === 'live_dataset' && !('code' in reply.items[1]), JSON.stringify(reply));

  // ── 2. Declared types ──────────────────────────────────────────────────────
  const cases: [import('../src/connectors/types').LiveDialectId, string, string][] = [
    ['redshift', 'integer', 'number'], ['redshift', 'numeric(18,2)', 'number'], ['redshift', 'double precision', 'number'],
    ['redshift', 'bigint', 'number'], ['redshift', 'character varying(256)', 'text'], ['redshift', 'date', 'date'],
    ['redshift', 'timestamp without time zone', 'date'], ['redshift', 'timestamp(3) with time zone', 'date'], ['redshift', 'boolean', 'text'],
    ['redshift', 'int4', 'number'], ['redshift', 'timestamptz', 'date'], ['redshift', 'time without time zone', 'text'],
    ['databricks', 'DECIMAL(10,2)', 'number'], ['databricks', 'BIGINT', 'number'], ['databricks', 'STRING', 'text'],
    ['databricks', 'TIMESTAMP_NTZ', 'date'], ['databricks', 'ARRAY<STRING>', 'text'], ['databricks', 'BOOLEAN', 'text'],
    ['clickhouse', 'Nullable(UInt64)', 'number'], ['clickhouse', 'LowCardinality(Nullable(String))', 'text'],
    ['clickhouse', "DateTime64(3, 'UTC')", 'date'], ['clickhouse', 'Date32', 'date'], ['clickhouse', 'Decimal(38, 4)', 'number'],
    ['clickhouse', "Enum8('a' = 1)", 'text'], ['clickhouse', 'UUID', 'text'],
    ['snowflake', 'NUMBER(38,0)', 'number'], ['snowflake', 'fixed', 'number'], ['snowflake', 'TIMESTAMP_TZ', 'date'], ['snowflake', 'VARIANT', 'text'],
    ['bigquery', 'INT64', 'number'], ['bigquery', 'BIGNUMERIC', 'number'], ['bigquery', 'TIMESTAMP', 'date'], ['bigquery', 'STRUCT<a INT64>', 'text'],
  ];
  const wrong = cases.filter(([d, t, want]) => schema.liveColumnType(d, t) !== want).map(([d, t, want]) => `${d}:${t}→${schema.liveColumnType(d, t)} (want ${want})`);
  ok(`declared types: ${cases.length} warehouse type names map per dialect`, wrong.length === 0, wrong.join('; '));
  ok('an unknown type name is text (the safe direction)', schema.liveColumnType('redshift', 'geometry') === 'text' && schema.liveColumnType('clickhouse', '') === 'text');
  const declared = schema.liveColumns('bigquery', [{ name: 'id', type: 'INT64', columnType: 'text' }, { name: 'amount', type: 'NUMERIC' }]);
  ok("a connector's declared columnType wins over the table", declared.ok && declared.columns[0].type === 'text' && declared.columns[1].type === 'number', JSON.stringify(declared));
  const dup = schema.liveColumns('redshift', [{ name: 'a', type: 'int' }, { name: 'a', type: 'text' }]);
  ok('two columns of one name are refused', !dup.ok && dup.reason === 'duplicate' && dup.name === 'a');
  ok('no columns, or an empty name, is refused', !schema.liveColumns('redshift', []).ok && !schema.liveColumns('redshift', [{ name: ' ', type: 'int' }]).ok);

  // ── 3. The record, over the RPC route ──────────────────────────────────────
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) process.env.SSRF_ALLOW = '127.0.0.0/8,::1/128'; // section 5's Postgres is on this machine
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  // An in-memory secret store: the encrypted one needs Postgres + a master key (scripts/test-connections-server.ts covers it).
  const kept = new Map<string, string>();
  configSecrets.useSecretStore({
    get: async (o, k, r) => kept.get(`${o}|${k}|${r}`) ?? null,
    put: async (o, k, r, v) => { kept.set(`${o}|${k}|${r}`, v); },
    delete: async (o, k, r) => kept.delete(`${o}|${k}|${r}`),
  });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const record: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');

  const COLS: ParsedColumn[] = [{ name: 'region', type: 'text' }, { name: 'sales', type: 'number' }, { name: 'day', type: 'date' }];
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Live record')).id;
    const rs = await conns.saveConnection(projectId, { name: 'Warehouse', connectorId: 'amazon-redshift', values: { host: HOST_CANARY, port: 5439, database: 'dw', user: 'reader', ssl: true } });
    const pgc = await conns.saveConnection(projectId, { name: 'App DB', connectorId: 'postgres', values: { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' } });
    if (!rs || !pgc) throw new Error('connections not saved');
    const liveDs = await record.saveLiveRecord(projectId, { name: 'Orders live', columns: COLS, origin: { kind: 'connection', connId: rs.id, sql: SQL_CANARY } });
    const fromPg = await datasets.saveDataset(projectId, { name: 'From app db', sourceKind: 'postgres', columns: COLS, rows: [['r1', 1, '2024-01-01']], origin: { kind: 'connection', connId: pgc.id, table: 'orders' } });
    const fromRs = await datasets.saveDataset(projectId, { name: 'From warehouse', sourceKind: 'postgres', columns: COLS, rows: [['r1', 1, '2024-01-01']], origin: { kind: 'connection', connId: rs.id, table: 'public.orders' } });
    const pasted = await datasets.saveDataset(projectId, { name: 'Pasted', sourceKind: 'paste', columns: COLS, rows: [['r1', 1, '2024-01-01']] });
    if (!liveDs || !fromPg || !fromRs || !pasted) throw new Error('datasets not saved');
    await datasets.updateSteps(projectId, fromRs.id, [{ type: 'filter', column: 'sales', op: '>', value: 0 }]);
    return { projectId, rs: rs.id, pg: pgc.id, live: liveDs.id, fromPg: fromPg.id, fromRs: fromRs.id, pasted: pasted.id };
  });
  const P = seed.projectId;

  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const bodies: string[] = [];
  const post = async (channel: string, payload: unknown) => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    bodies.push(r.body);
    return { status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: each reply is narrowed by the check that reads it
  };
  const dsDir = path.join(DATA, 'orgs', 'acme', 'userData', 'projects', P, 'datasets');
  const rawRecord = (id: string) => JSON.parse(fs.readFileSync(path.join(dsDir, `${id}.json`), 'utf8'));
  const hasParquet = (id: string): boolean => fs.existsSync(path.join(dsDir, `${id}.parquet`));

  await context.runInContext(ADMIN, 'record', async () => {
    const meta = await datasets.getDatasetMeta(P, seed.live);
    ok('a Live record is schema only: columns kept, no rows, not resident', meta?.mode === 'live' && meta.columns.length === 3 && meta.rowCount === 0 && meta.resident === false);
    let err: unknown = null;
    try {
      await datasets.getDataset(P, seed.live);
    } catch (e) {
      err = e;
    }
    ok('getDataset throws LiveDatasetError on it', live.isLiveDatasetError(err));
    ok('…and getDataset still reads an extract', (await datasets.getDataset(P, seed.fromPg))?.rows.length === 1);
    const list = await datasets.listDatasets(P);
    ok('listDatasets does not throw, and names it Live with its cache age', list.length === 4 && list.some((d) => d.id === seed.live && d.mode === 'live' && d.maxCacheAgeSec === 300));
  });
  const onDisk = fs.readdirSync(dsDir).filter((f) => f.startsWith(seed.live));
  ok('nothing but the record is on disk for it (no Parquet)', onDisk.length === 1 && onDisk[0] === `${seed.live}.json`, onDisk.join(','));

  const src = await post('dataset:source', { projectId: P, id: seed.live });
  ok('dataset:source: kind + label + refreshable, plus live and the cache age',
    src.status === 200 && src.value.kind === 'connection' && src.value.refreshable === true && src.value.live === true && src.value.maxCacheAgeSec === 300
      && Object.keys(src.value).sort().join(',') === 'kind,label,live,maxCacheAgeSec,refreshable', src.body);
  ok('dataset:source on Live carries no SQL text, no host, no URL', !src.body.includes('canary_col') && !src.body.includes('secret_schema') && !src.body.includes(HOST_CANARY) && !/https?:\/\//.test(src.body), src.body);
  const fromRsSrc = await post('dataset:source', { projectId: P, id: seed.fromRs });
  const fromPgSrc = await post('dataset:source', { projectId: P, id: seed.fromPg });
  const pastedSrc = await post('dataset:source', { projectId: P, id: seed.pasted });
  ok('dataset:source: an extract from a Live-capable connection can go Live', fromRsSrc.value.canGoLive === true && !('live' in fromRsSrc.value), fromRsSrc.body);
  ok('…one from a plain Postgres cannot (and its reply keeps the three keys it always had)', Object.keys(fromPgSrc.value).sort().join(',') === 'kind,label,refreshable', fromPgSrc.body);
  ok('…and a paste is not offered at all', !('canGoLive' in pastedSrc.value) && !('live' in pastedSrc.value), pastedSrc.body);

  const before = rawRecord(seed.live);
  const r1 = await post('dataset:refresh', { projectId: P, id: seed.live });
  const r2 = await post('connection:refresh', { projectId: P, connId: seed.rs, datasetId: seed.live });
  const after = rawRecord(seed.live);
  ok('Refresh on Live bumps the epoch (dataset:refresh, then connection:refresh)', r1.value?.ok === true && r1.value.live?.epoch === 1 && r2.value?.ok === true && r2.value.live?.epoch === 2 && after.live.epoch === 2, `${r1.body} ${r2.body}`);
  ok('…metadata only: updatedAt, columns and the schema stamp are untouched',
    after.updatedAt === before.updatedAt && JSON.stringify(after.columns) === JSON.stringify(before.columns) && after.live.schemaSyncedAt === before.live.schemaSyncedAt);
  ok('…and its reply names the dataset by its header only', !r1.body.includes('canary_col') && !r1.body.includes(HOST_CANARY));
  const bumpExtract = await context.runInContext(ADMIN, 'bump', () => live.bumpEpoch(P, seed.fromPg));
  ok('negative control: bumpEpoch on an extract is refused (false), and writes no live block', bumpExtract === false && !('live' in rawRecord(seed.fromPg)));
  // The scheduler's doors (L0.3/L0.4): a Live record carries no schedule even hand-edited, and a
  // queued refresh of one is refused — only the person-facing Refresh resets its cache.
  const raw = rawRecord(seed.live);
  fs.writeFileSync(path.join(dsDir, `${seed.live}.json`), JSON.stringify({ ...raw, autoRefresh: { every: '5min' }, incremental: { enabled: true, cursor: 'id' } }));
  await context.runInContext(ADMIN, 'sched', async () => {
    const scheduler: typeof import('../src/app/refreshScheduler') = require('../src/app/refreshScheduler');
    const refreshJob: typeof import('../src/data/refreshJob') = require('../src/data/refreshJob');
    const summary = (await datasets.listDatasets(P)).find((d) => d.id === seed.live);
    ok('a hand-edited schedule on a Live record is dropped on load (no autoRefresh, no incrementalOn)', !!summary && !summary.autoRefresh && !summary.incrementalOn, JSON.stringify(summary));
    ok('…so the scheduler never lists it', !(await scheduler.scheduledMetas()).some((m) => m.id === seed.live));
    const queued = await refreshJob.queueRefresh(P, seed.live, 'Refresh Orders live').done;
    ok('a queued (scheduled / pipeline) refresh of a Live dataset is refused, typed', !queued.ok && queued.error === new live.LiveDatasetError('x').message, JSON.stringify(queued));
    ok('…and leaves the record as it was', rawRecord(seed.live).live.epoch === 2 && rawRecord(seed.live).mode === 'live');
  });
  fs.writeFileSync(path.join(dsDir, `${seed.live}.json`), JSON.stringify(raw));
  const sched = await post('dataset:update', { projectId: P, datasetId: seed.live, autoRefresh: 'hourly' });
  ok('a refresh schedule on Live is refused (its cache age is its schedule)', sched.value?.ok === false, sched.body);
  const age = await post('dataset:setMode', { projectId: P, datasetId: seed.live, mode: 'live', maxCacheAgeSec: 0 });
  ok('dataset:setMode live → live sets the cache age (0 = always live)', age.value?.ok === true && age.value.maxCacheAgeSec === 0 && rawRecord(seed.live).live.maxCacheAgeSec === 0, age.body);
  const age31 = await post('dataset:setMode', { projectId: P, datasetId: seed.live, mode: 'live', maxCacheAgeSec: 31 * DAY });
  ok('negative control: a 31-day cache age is refused at the contract (400)', age31.status === 400, age31.body);

  // ── 4. The switch's refusals ────────────────────────────────────────────────
  const noOrigin = await post('dataset:setMode', { projectId: P, datasetId: seed.pasted, mode: 'live', confirmDrop: true });
  ok('a pasted dataset cannot be Live (no connection to ask)', noOrigin.value?.ok === false && /connection/.test(noOrigin.value.error), noOrigin.body);
  const withSteps = await post('dataset:setMode', { projectId: P, datasetId: seed.fromRs, mode: 'live', confirmDrop: true });
  ok('a dataset with prepare steps cannot go Live until they are removed', withSteps.value?.ok === false && /prepare steps/.test(withSteps.value.error), withSteps.body);
  const notOffered = await post('dataset:setMode', { projectId: P, datasetId: seed.fromPg, mode: 'live', confirmDrop: true });
  ok('a plain Postgres source cannot go Live (no live dialect, plan D8)', notOffered.value?.ok === false && /live/i.test(notOffered.value.error), notOffered.body);
  const noConfirmPg = await post('dataset:setMode', { projectId: P, datasetId: seed.fromPg, mode: 'live' });
  ok('…and it says so before asking for a confirm', noConfirmPg.value?.ok === false && noConfirmPg.value.code === undefined && /live/i.test(noConfirmPg.value.error), noConfirmPg.body);
  await post('dataset:setSteps', { projectId: P, datasetId: seed.fromRs, steps: [] });
  const noConfirm = await post('dataset:setMode', { projectId: P, datasetId: seed.fromRs, mode: 'live' });
  ok('negative control: without confirmDrop nothing is dropped', noConfirm.value?.ok === false && noConfirm.value.code === 'confirm_drop' && hasParquet(seed.fromRs), noConfirm.body);
  // The host may appear in a CONNECTION's own error (the person typed it, and
  // connections:list shows it); the selection's SQL never appears anywhere.
  ok('every reply so far is free of the planted SQL', bodies.every((b) => !b.includes('canary_col') && !b.includes('secret_schema')));

  // ── 5. The whole flow against a real Postgres (Redshift's wire) ─────────────
  if (!dbUrl) {
    console.log('skip the Postgres flow: no DATABASE_URL');
  } else {
    const u = new URL(dbUrl);
    const table = `live_l21_${process.pid}_${Date.now().toString(36)}`;
    const { Client } = require('pg') as typeof import('pg');
    const admin = new Client({ connectionString: dbUrl });
    admin.on('error', () => {});
    await admin.connect();
    await admin.query(`create table public.${table} (id integer, region varchar(40), amount numeric(12,2), ratio double precision, ordered date, at timestamptz, flag boolean, code text)`);
    await admin.query(`insert into public.${table} values (1,'North',10.5,0.25,'2024-01-02','2024-01-02T03:04:05Z',true,'007'), (2,'South',7,0.5,'2024-02-03','2024-02-03T00:00:00Z',false,'010')`);
    try {
      const saved = await post('connection:testAndSave', {
        projectId: P, connectorId: 'amazon-redshift', name: 'Local warehouse',
        values: { host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: decodeURIComponent(u.username), ssl: false },
        secrets: { password: decodeURIComponent(u.password) },
      });
      const connId = String(saved.value?.connection?.id ?? '');
      ok('a Redshift-wire connection to the local Postgres saves', saved.value?.ok === true && !!connId, saved.body.slice(0, 300));
      const cat = await post('connectors:catalog', undefined);
      ok('the catalog offers Live for it', (cat.value as { id: string; live: boolean }[]).find((c) => c.id === 'amazon-redshift')?.live === true);
      const viaTable = await post('connection:import', { projectId: P, connId, name: 'Orders (live)', table: `public.${table}`, limit: 100, mode: 'live' });
      const liveId = String(viaTable.value?.dataset?.id ?? '');
      ok('Add from connection → Live (a table) creates a Live dataset', viaTable.value?.ok === true && viaTable.value.dataset.mode === 'live' && viaTable.value.dataset.rowCount === 0, viaTable.body.slice(0, 300));
      const types = (viaTable.value?.dataset?.columns ?? []).map((c: ParsedColumn) => `${c.name}:${c.type}`).join(',');
      ok('…its columns are DECLARED from the catalog (007 stays text; numeric, date, timestamptz typed)',
        types === 'id:number,region:text,amount:number,ratio:number,ordered:date,at:date,flag:text,code:text', types);
      ok('…and no Parquet was written', !hasParquet(liveId));
      const viaSql = await post('connection:import', { projectId: P, connId, name: 'Query (live)', sql: `select region, sum(amount) as total from public.${table} group by region`, limit: 100, mode: 'live' });
      const sqlTypes = (viaSql.value?.dataset?.columns ?? []).map((c: ParsedColumn) => `${c.name}:${c.type}`).join(',');
      ok('Add from connection → Live (a query) reads the columns with a one-row run', viaSql.value?.ok === true && sqlTypes === 'region:text,total:number', viaSql.body.slice(0, 300));
      const dupCols = await post('connection:import', { projectId: P, connId, name: 'Dup', sql: `select region, region from public.${table}`, limit: 100, mode: 'live' });
      ok('a query returning two columns of one name is refused', dupCols.value?.ok === false && /Two columns/.test(dupCols.value.error), dupCols.body);
      const pgSaved = await post('connection:testAndSave', {
        projectId: P, connectorId: 'postgres', name: 'Local app db',
        values: { host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: decodeURIComponent(u.username), ssl: false },
        secrets: { password: decodeURIComponent(u.password) },
      });
      const pgLive = await post('connection:import', { projectId: P, connId: String(pgSaved.value?.connection?.id ?? ''), name: 'No', table: `public.${table}`, limit: 100, mode: 'live' });
      ok('Live from a connector without a live dialect is refused', pgLive.value?.ok === false && /live/i.test(pgLive.value.error), pgLive.body);
      const copy = await post('connection:import', { projectId: P, connId, name: 'Orders (copy)', table: `public.${table}`, limit: 100 });
      ok('"Copy the data" still imports rows', copy.value?.ok === true && copy.value.dataset.rowCount === 2, copy.body.slice(0, 300));

      const toExtract = await post('dataset:setMode', { projectId: P, datasetId: liveId, mode: 'extract' });
      ok('Live → extract runs a normal import', toExtract.value?.ok === true && toExtract.value.dataset.rowCount === 2 && hasParquet(liveId), toExtract.body.slice(0, 300));
      const page = await post('dataset:page', { projectId: P, datasetId: liveId, offset: 0, limit: 10 });
      ok('…and its rows read back (007 is text, as an import types it)', page.status === 200 && JSON.stringify(page.value).includes('"007"'), page.body.slice(0, 300));
      ok('…the record is an extract again (no mode, no live block)', !('mode' in rawRecord(liveId)) && !('live' in rawRecord(liveId)));
      const refused = await post('dataset:setMode', { projectId: P, datasetId: liveId, mode: 'live' });
      ok('extract → Live without confirmDrop is refused with its own code', refused.value?.ok === false && refused.value.code === 'confirm_drop' && hasParquet(liveId), refused.body);
      const toLive = await post('dataset:setMode', { projectId: P, datasetId: liveId, mode: 'live', confirmDrop: true, maxCacheAgeSec: 60 });
      ok('extract → Live with the confirm drops the Parquet and keeps the schema', toLive.value?.ok === true && toLive.value.mode === 'live' && !hasParquet(liveId) && rawRecord(liveId).live.maxCacheAgeSec === 60 && rawRecord(liveId).columns.length === 8, toLive.body.slice(0, 300));
      const afterPage = await post('dataset:page', { projectId: P, datasetId: liveId, offset: 0, limit: 10 });
      ok('…and its table view now refuses, typed', afterPage.value?.code === 'live_dataset', afterPage.body.slice(0, 200));
    } finally {
      await admin.query(`drop table if exists public.${table}`);
      await admin.end();
    }
  }

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
