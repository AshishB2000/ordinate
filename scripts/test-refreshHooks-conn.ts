// A refresh URL for a whole CONNECTION: one call refreshes every dataset that
// came from it — one `curl` after a dbt run that built twenty models, instead
// of twenty URLs. Real Postgres, real HTTP, two pods (scripts/hookHarness.ts).
//
//   access     a viewer gets 403; the connection must exist; a target is a
//              dataset OR a connection, never both and never neither
//   at rest    `connection_id` set, `dataset_id` NULL; the two lists are apart
//   one call   every copy from the connection is refreshed and every Live
//              dataset's cache reset — `{status, datasets: {queued,
//              already_running, cache_reset}}`; a dataset of ANOTHER
//              connection and a pasted one are untouched, their source unasked
//   interval   the URL's own, as a dataset's: again at once → 429, on the
//              other pod too
//   coalesce   a dataset another pod is refreshing is joined, the rest queued
//   nothing    a connection that feeds no dataset → 404, the dataset URL's
//              "dataset not found"
//   creator    without her grant → 403 and nothing asked of the source
//   audit      `hook_refresh`: the creator, the hook and the CONNECTION
//   cap        at most MAX_LIVE_PER_DATASET live URLs per connection
//   control    a DATASET's URL still refreshes that dataset alone
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-refreshHooks-conn.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { EN, until, withHookPods } from './hookHarness';
import { Client } from 'pg';

const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const store: typeof import('../src/server/hooks/store') = require('../src/server/hooks/store');
const lock: typeof import('../src/server/jobs/refreshLock') = require('../src/server/jobs/refreshLock');

// The source: which tables were asked for.
const asked: string[] = [];
connectionRun.runConnection = (async (_c: unknown, _v: unknown, _s: unknown, sel: { table?: string }) => {
  asked.push(sel.table ?? '?');
  return { ok: true, truncated: false, result: { columns: [{ name: 'region', type: 'text' }], rows: [['north'], ['south'], ['east']], rowCount: 3, warnings: [] } };
}) as unknown as typeof connectionRun.runConnection;

withHookPods('a connection\'s refresh URL', async (h) => {
  const { podA, podB, P } = h;
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const cols = [{ name: 'region', type: 'text' as const }];
  const fx = await h.asBoss(async () => {
    const values = { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' };
    const conn = async (name: string) => (await conns.saveConnection(P, { name, connectorId: 'postgres', values }))!.id;
    const [K, K2, EMPTY] = [await conn('Warehouse'), await conn('Other'), await conn('Unused')];
    const copy = async (connId: string, table: string) => (await datasets.saveDataset(P, { name: table, sourceKind: 'postgres', columns: cols, rows: [['old']], origin: { kind: 'connection', connId, table } }))!.id;
    return {
      K, K2, EMPTY, A: await copy(K, 'a'), B: await copy(K, 'b'), X: await copy(K2, 'x'),
      L: (await liveRecord.saveLiveRecord(P, { name: 'Orders live', columns: cols, origin: { kind: 'connection', connId: K, table: 'orders' } }))!.id,
      C: (await datasets.saveDataset(P, { name: 'Pasted', sourceKind: 'paste', columns: cols, rows: [['x']] }))!.id,
    };
  });
  const meta = (id: string) => h.asBoss(() => datasets.getDatasetMeta(P, id));
  const rowsOf = async (id: string) => (await meta(id))?.rowCount;
  const epochOf = async (id: string) => (await meta(id) as { live?: { epoch: number } } | null)?.live?.epoch;
  const carol = (channel: string, payload: unknown, at = podA) => h.call(at, 'carol@acme.test', channel, payload);

  // ── Access and the target ─────────────────────────────────────────────────
  const vic = [await h.call(podA, 'vic@acme.test', 'refreshHook:list', { projectId: P, connId: fx.K }), await h.call(podA, 'vic@acme.test', 'refreshHook:create', { projectId: P, connId: fx.K })];
  ok('access: a project viewer → 403 on a connection\'s list and create', vic.every((r) => r.status === 403), vic.map((r) => r.status).join());
  const shapes = [await carol('refreshHook:create', { projectId: P, connId: fx.K, datasetId: fx.A }), await carol('refreshHook:create', { projectId: P })];
  ok('target: a dataset AND a connection, or neither → 400', shapes.every((r) => r.status === 400), shapes.map((r) => r.status).join());
  const gone = (await carol('refreshHook:create', { projectId: P, connId: fx.C })).body;
  ok('create: a connection that does not exist is refused (the catalog sentence)', gone.ok === false && gone.error === EN['refreshHookMessages.this_connection_no_longer_exists'], JSON.stringify(gone));

  // ── Create, at rest, the two lists ────────────────────────────────────────
  const made = (await carol('refreshHook:create', { projectId: P, connId: fx.K })).body;
  const tK = made.token as string;
  ok('create: a connection\'s URL — ordh_ + 43 chars, once', made.ok === true && store.isHookToken(tK) && made.hook.prefix === tK.slice(0, 13), JSON.stringify(made).slice(0, 120));
  const row = (await h.q<{ dataset_id: string | null; connection_id: string | null }>('SELECT dataset_id, connection_id FROM refresh_hooks WHERE id = $1', [made.hook.id]))[0];
  ok('at rest: connection_id is the connection, dataset_id NULL', row.connection_id === fx.K && row.dataset_id === null, JSON.stringify(row));
  const forA = (await carol('refreshHook:create', { projectId: P, datasetId: fx.A })).body;
  const tA = forA.token as string;
  const lists = { conn: (await carol('refreshHook:list', { projectId: P, connId: fx.K })).body.hooks as { id: string }[], ds: (await carol('refreshHook:list', { projectId: P, datasetId: fx.A })).body.hooks as { id: string }[] };
  ok('list: the connection\'s list holds its URL, the dataset\'s list its own — neither the other\'s', lists.conn.length === 1 && lists.conn[0].id === made.hook.id
    && lists.ds.length === 1 && lists.ds[0].id === forA.hook.id, JSON.stringify(lists));

  // ── One call ──────────────────────────────────────────────────────────────
  const first = await h.hit(podA, tK);
  ok('fire: 202 {status: queued, datasets: {queued 2, already_running 0, cache_reset 1}}', first.status === 202 && first.json?.status === 'queued'
    && JSON.stringify(first.json.datasets) === '{"queued":2,"already_running":0,"cache_reset":1}', `${first.status} ${first.text}`);
  ok('fire: both copies from the connection were refreshed (1 → 3 rows)', await until(async () => (await rowsOf(fx.A)) === 3 && (await rowsOf(fx.B)) === 3), `${await rowsOf(fx.A)} ${await rowsOf(fx.B)}`);
  ok('fire: the Live dataset\'s cache was reset (epoch 0 → 1), nothing fetched for it', (await epochOf(fx.L)) === 1 && !asked.includes('orders'), `${await epochOf(fx.L)}`);
  ok('fire: another connection\'s dataset and a pasted one are untouched, their source unasked', (await rowsOf(fx.X)) === 1 && (await rowsOf(fx.C)) === 1 && asked.slice().sort().join() === 'a,b', asked.join());
  const again = await h.hit(podB, tK);
  ok('interval: again at once, on the OTHER pod → 429 with Retry-After', again.status === 429 && Number(again.headers.get('retry-after')) >= 1, `${again.status}`);
  const trail = await h.q<{ actor: string; target_ids: string[]; outcome: string }>(`SELECT actor, target_ids, outcome FROM audit_log WHERE action = 'hook_refresh' ORDER BY id`);
  ok('audit: one hook_refresh row — the creator, the hook and the CONNECTION', trail.length === 1 && trail[0].actor === 'carol@acme.test'
    && trail[0].target_ids.join() === [made.hook.id, fx.K].join() && trail[0].outcome === 'ok', JSON.stringify(trail));

  // ── Coalesce: another pod is refreshing A ─────────────────────────────────
  await h.rest();
  asked.length = 0;
  const other = new Client({ connectionString: h.dbUrl });
  await other.connect();
  await other.query('SELECT pg_advisory_lock(hashtext($1))', [lock.lockKey('acme', fx.A)]);
  const joined = await h.hit(podA, tK);
  ok('coalesce: A is being refreshed on another pod → joined; B queued, the Live one reset', joined.status === 202 && joined.json?.status === 'queued'
    && JSON.stringify(joined.json.datasets) === '{"queued":1,"already_running":1,"cache_reset":1}', joined.text);
  ok('coalesce: …and the source was asked for B alone', await until(async () => asked.includes('b')) && !asked.includes('a'), asked.join());
  await other.query('SELECT pg_advisory_unlock(hashtext($1))', [lock.lockKey('acme', fx.A)]);
  await other.end();

  // ── A dataset's URL is still one dataset (control) ────────────────────────
  asked.length = 0;
  const single = await h.hit(podA, tA);
  ok('control: a DATASET\'s URL answers {status: queued} and no counts', single.status === 202 && JSON.stringify(single.json) === '{"status":"queued"}', single.text);
  ok('control: …and asks the source for that dataset alone', await until(async () => asked.includes('a')) && asked.join() === 'a', asked.join());

  // ── Nothing to refresh, and a creator without her grant ───────────────────
  const tEmpty = (await carol('refreshHook:create', { projectId: P, connId: fx.EMPTY })).body.token as string;
  const none = await h.hit(podA, tEmpty);
  ok('nothing: a connection that feeds no dataset → 404 dataset not found', none.status === 404 && none.json?.error === 'dataset not found', `${none.status} ${none.text}`);
  await h.rest();
  asked.length = 0;
  await h.pool.query(`DELETE FROM project_grants WHERE user_id = (SELECT id FROM users WHERE email = 'carol@acme.test')`);
  const lost = await h.hit(podA, tK);
  ok('creator: without her grant → 403, and nothing is asked of the source', lost.status === 403 && lost.json?.error === 'forbidden' && asked.length === 0, `${lost.status} ${asked.join()}`);

  // ── The cap ───────────────────────────────────────────────────────────────
  const boss = (payload: unknown) => h.call(podA, 'boss@acme.test', 'refreshHook:create', payload);
  for (let i = 1; i < store.MAX_LIVE_PER_DATASET; i++) await boss({ projectId: P, connId: fx.K });
  const over = (await boss({ projectId: P, connId: fx.K })).body;
  ok(`cap: an ${store.MAX_LIVE_PER_DATASET + 1}th live URL on one connection is refused (the catalog sentence)`, over.ok === false
    && over.error === EN['refreshHookMessages.a_connection_can_have_at_most'].replace('{max}', String(store.MAX_LIVE_PER_DATASET)), JSON.stringify(over));
})
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
