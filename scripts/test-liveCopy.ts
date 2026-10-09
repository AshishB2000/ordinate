// Self-check for "Make a copy" on a Live dataset (docs/live-data/00-plan.md
// L2.6): `dataset:copyLive` (src/ipc/liveDatasets.ts) over the real RPC route,
// in server mode, against the fake warehouse (./liveFakeConnector.ts) in the
// org's own DuckDB worker.
//
// 1. Access. `write`, project-scoped, a strict input: a project VIEWER is
//    refused before the handler (authorize, a grant table standing in for
//    Postgres) — NEGATIVE CONTROL: the same viewer reads the Schema panel; an
//    editor may copy. Over the route, a member with no grant is a 403 and
//    nothing is saved.
// 2. The copy. A NEW extract named "<name> (copy)" holding every warehouse row
//    (against a direct count), refreshable from the same origin, its table view
//    paging, the Live dataset's column notes (a personal mark) carried over.
//    The Live dataset: its record byte-identical, no Parquet, still Live, and
//    no live question spent (runBound never called).
// 3. The reply: id, name, rowCount, warnings — no SQL, no secret, no address
//    (canaries in the origin's SQL and the connection's password).
// 4. Failures. The warehouse's own error → a catalog sentence; its words reach
//    the server log only (NEGATIVE CONTROL: the log has the canary). A
//    connection aimed at the cloud metadata address is refused by the SSRF
//    guard (NEGATIVE CONTROL: a public address passes and copies). A failure
//    saves nothing.
// 5. Refusals (negative controls): an extract (`not_live`), a missing dataset,
//    a Live dataset whose connection is gone, a non-UUID (400).
//
//   npm run build:ts && node scripts/test-liveCopy.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import * as H from './liveQueryHarness';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const api: typeof import('../src/api/index') = require('../src/api/index');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const liveMsg: typeof import('../src/data/liveMessages') = require('../src/data/liveMessages');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');

type Identity = import('../src/server/context').Identity;
const { fake, fakeMod, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);
const SQL_CANARY = 'canary_alias_7c3e';
const BROKEN_CANARY = 'missing_table_canary_51af';
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };

(async () => {
  appMod.registerHandlers();
  const seed = await H.as(ORG_A, async () => {
    await H.projects.init();
    const projectId = (await H.projects.createProject('Make a copy')).id;
    const orders = await H.liveOver(projectId, { sql: `SELECT region, amount, day FROM ${fakeMod.ORDERS_TABLE} AS ${SQL_CANARY}` }, fakeMod.ORDERS_COLUMNS, fakeMod.LIVE_FAKE_ID, { fixture: 'orders' });
    const broken = await H.liveOver(projectId, { sql: `SELECT * FROM ${BROKEN_CANARY}` }, fakeMod.ORDERS_COLUMNS, fakeMod.LIVE_FAKE_ID, { fixture: 'orders' });
    const metadata = await H.liveOver(projectId, { table: fakeMod.ORDERS_TABLE }, fakeMod.ORDERS_COLUMNS, fakeMod.LIVE_FAKE_NET_ID, { fixture: 'orders', host: '169.254.169.254' });
    const pub = await H.liveOver(projectId, { table: fakeMod.ORDERS_TABLE }, fakeMod.ORDERS_COLUMNS, fakeMod.LIVE_FAKE_NET_ID, { fixture: 'orders', host: '8.8.8.8' });
    const orphan = await H.liveRecord.saveLiveRecord(projectId, {
      name: 'Orphan', columns: fakeMod.ORDERS_COLUMNS, origin: { kind: 'connection', connId: '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d', table: fakeMod.ORDERS_TABLE },
    });
    const extract = await H.datasets.saveDataset(projectId, { name: 'Already a copy', sourceKind: 'csv', columns: fakeMod.ORDERS_COLUMNS, rows: [['North', 1, '2024-01-01']] });
    if (!orphan || !extract) throw new Error('fixture not saved');
    await catalog.setColumn(projectId, orders.liveId, 'region', { sensitivity: 'personal', description: 'Where the order shipped' });
    await catalog.setColumn(projectId, orders.liveId, 'gone_column', { description: 'Not in the warehouse any more' });
    return { projectId, orders, broken, metadata, pub, orphan: orphan.id, extract: extract.id };
  });
  const P = seed.projectId;
  const dsDir = path.join(H.DATA, 'orgs', 'acme', 'userData', 'projects', P, 'datasets');
  const raw = (id: string): string => fs.readFileSync(path.join(dsDir, `${id}.json`), 'utf8');
  const hasParquet = (id: string): boolean => fs.existsSync(path.join(dsDir, `${id}.parquet`));
  const count = () => H.as(ORG_A, async () => (await H.datasets.listDatasets(P)).length);

  const appFor = (who: Identity) => appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: H.DATA }), undefined, () => who);
  const admin = appFor(ORG_A);
  const bodies: string[] = [];
  const post = async (channel: string, payload: unknown, app = admin) => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    bodies.push(r.body);
    return { status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: each reply is narrowed by the check that reads it
  };
  const copy = (datasetId: string, app = admin) => post('dataset:copyLive', { projectId: P, datasetId }, app);

  // ── 1. Access ─────────────────────────────────────────────────────────────
  const contract = api.contracts['dataset:copyLive'];
  const input = { projectId: P, datasetId: seed.orders.liveId };
  ok('contract: write, project-scoped by projectId', contract.access === 'write' && 'project' in contract && contract.project(input) === P);
  ok('contract: a strict input — an extra key or a non-UUID is refused',
    !contract.input.safeParse({ ...input, sql: 'SELECT 1' }).success && !contract.input.safeParse({ ...input, datasetId: '../x' }).success && contract.input.safeParse(input).success);
  // The grant lookup is one Postgres query; a table answering one rank stands in for it.
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: Identity, channel: 'dataset:copyLive' | 'dataset:liveSchema', rank: number) =>
    H.as(who, () => authz.authorize(api.contracts[channel], input, who, grants(rank)));
  ok('access: a project VIEWER may not make a copy (it saves a dataset)', !(await decide(VIEWER, 'dataset:copyLive', 1)).ok);
  ok('access NEGATIVE CONTROL: the same viewer reads the Schema panel', (await decide(VIEWER, 'dataset:liveSchema', 1)).ok);
  ok('access: a project editor may make a copy', (await decide(EDITOR, 'dataset:copyLive', 2)).ok);
  const before403 = await count();
  const viewerApp = appFor(VIEWER);
  const denied = await copy(seed.orders.liveId, viewerApp);
  ok('route: a member without a grant gets a 403, and nothing is saved', denied.status === 403 && (await count()) === before403, `${denied.status} ${denied.body}`);
  await viewerApp.close();

  // ── 2. The copy ───────────────────────────────────────────────────────────
  const liveBefore = raw(seed.orders.liveId);
  fakeMod.resetFake();
  const made = await copy(seed.orders.liveId);
  // The fixture table exists once the fake has been asked (it creates it on first use).
  const n = Number((await H.as(ORG_A, () => duck.queryAsync(`SELECT count(*)::DOUBLE AS n FROM ${fakeMod.ORDERS_TABLE}`)))[0]?.n ?? -1);
  const copyId = String(made.value?.dataset?.id ?? '');
  ok('copy: ok, a NEW dataset id beside the Live one', made.status === 200 && made.value?.ok === true && /^[0-9a-f-]{36}$/.test(copyId) && copyId !== seed.orders.liveId, made.body.slice(0, 300));
  ok(`copy: every warehouse row (${n}, by a direct count)`, n === 240 && made.value?.dataset?.rowCount === n, `${n} ${made.body.slice(0, 200)}`);
  const liveName = (await H.as(ORG_A, () => H.datasets.getDatasetMeta(P, seed.orders.liveId)))?.name;
  ok('copy: named "<the Live dataset\'s name> (copy)"', made.value?.dataset?.name === `${liveName} (copy)`, made.value?.dataset?.name);
  const copyMeta = await H.as(ORG_A, () => H.datasets.getDatasetMeta(P, copyId));
  ok('copy: an extract — no mode, no live block, its own Parquet', !!copyMeta && copyMeta.mode === undefined && !('live' in JSON.parse(raw(copyId))) && hasParquet(copyId));
  ok('copy: declared columns as an import types them', copyMeta?.columns.map((c) => `${c.name}:${c.type}`).join(',') === 'region:text,amount:number,day:date', show(copyMeta?.columns));
  const page = await post('dataset:page', { projectId: P, datasetId: copyId, offset: 0, limit: 5 });
  ok('copy: its table view pages (what Live could not do)', page.status === 200 && page.value?.ok === true && page.value.total === n && page.value.rows.length === 5, page.body.slice(0, 200));
  const src = await post('dataset:source', { projectId: P, id: copyId });
  ok('copy: refreshable from the same connection, not Live', src.value?.kind === 'connection' && src.value?.refreshable === true && !('live' in src.value), src.body);
  const notes = await post('catalog:columns', { projectId: P, datasetId: copyId });
  ok('copy: the Live dataset\'s column notes come with it — the personal mark too',
    notes.value?.columns?.region?.sensitivity === 'personal' && notes.value.columns.region.description === 'Where the order shipped', notes.body);
  ok('copy: …only for columns the copy has', !('gone_column' in (notes.value?.columns ?? {})), notes.body);
  ok('Live: its record is byte-identical after the copy', raw(seed.orders.liveId) === liveBefore);
  ok('Live: still Live, still no Parquet', JSON.parse(raw(seed.orders.liveId)).mode === 'live' && !hasParquet(seed.orders.liveId));
  ok('Live: no live question was spent (runBound never called — an import reads through run)', fake.calls.length === 0, String(fake.calls.length));
  const again = await copy(seed.orders.liveId);
  ok('copy: a second copy is another new dataset (the first is not overwritten)', again.value?.ok === true && again.value.dataset.id !== copyId && hasParquet(copyId), again.body.slice(0, 200));

  // Measured, not asserted: one copy over the route — the fake's run in the org worker, the Parquet write, the scan.
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await copy(seed.orders.liveId);
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  console.log(`     a copy of ${n} rows over the route: median ${ms[2].toFixed(1)} ms (min ${ms[0].toFixed(1)}, max ${ms[4].toFixed(1)}; 5 runs)`);

  // ── 3. The reply ──────────────────────────────────────────────────────────
  ok('reply: exactly ok, dataset {id, name, rowCount} and warnings',
    Object.keys(made.value).sort().join() === 'dataset,ok,warnings' && Object.keys(made.value.dataset).sort().join() === 'id,name,rowCount', made.body.slice(0, 300));
  ok('reply: no SQL text, no secret', !made.body.includes(SQL_CANARY) && !made.body.includes('SELECT') && !made.body.includes(H.SECRET_CANARY), made.body.slice(0, 300));

  // ── 4. Failures ───────────────────────────────────────────────────────────
  let before = await count();
  const failed = await H.capturingWarn(() => copy(seed.broken.liveId));
  ok('warehouse error: a catalog sentence, nothing saved', failed.value.value?.ok === false && failed.value.value.error === liveMsg.liveCopyReadFailedMessage() && (await count()) === before, failed.value.body);
  ok('warehouse error: its words are not in the reply', !failed.value.body.includes(BROKEN_CANARY) && !failed.value.body.includes('SELECT'), failed.value.body);
  ok('warehouse error NEGATIVE CONTROL: the server log has them (the canary is real)', failed.lines.some((l) => l.includes(BROKEN_CANARY)), show(failed.lines));
  ok('warehouse error: the log line carries no secret', failed.lines.every((l) => !l.includes(H.SECRET_CANARY)));
  before = await count();
  const meta = await H.capturingWarn(() => copy(seed.metadata.liveId));
  ok('SSRF: a connection aimed at the metadata address is refused before the connector runs, nothing saved',
    meta.value.value?.ok === false && meta.value.value.error === liveMsg.liveCopyReadFailedMessage() && (await count()) === before && meta.lines.some((l) => /link-local/.test(l)), show(meta));
  ok('SSRF: the reply names no address', !meta.value.body.includes('169.254'), meta.value.body);
  const pub = await copy(seed.pub.liveId);
  ok('SSRF NEGATIVE CONTROL: a public address passes the guard and copies', pub.value?.ok === true && pub.value.dataset.rowCount === 240 && !pub.body.includes('8.8.8.8'), pub.body.slice(0, 300));

  // ── 5. Refusals ───────────────────────────────────────────────────────────
  before = await count();
  const notLive = await copy(seed.extract);
  ok('refused: an extract has nothing to copy from a warehouse (code not_live), nothing saved',
    notLive.value?.ok === false && notLive.value.code === 'not_live' && notLive.value.error === liveMsg.liveCopyNotLiveMessage() && (await count()) === before, notLive.body);
  const missing = await copy('0b8f0e7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b');
  ok('refused: a dataset that does not exist', missing.value?.ok === false && missing.value.error === H.msg.liveDatasetMissing(), missing.body);
  const orphan = await copy(seed.orphan);
  ok('refused: a Live dataset whose connection is gone says so', orphan.value?.ok === false && orphan.value.error === liveMsg.liveConnectionGoneMessage() && (await count()) === before, orphan.body);
  const bad = await post('dataset:copyLive', { projectId: P, datasetId: 'not-a-uuid' });
  ok('refused: a non-UUID dataset id is a 400 at the contract', bad.status === 400, bad.body);
  ok('no reply in this suite carried the selection\'s SQL or the password', bodies.every((b) => !b.includes(SQL_CANARY) && !b.includes(BROKEN_CANARY) && !b.includes(H.SECRET_CANARY)));

  await admin.close();
  H.cleanup();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
