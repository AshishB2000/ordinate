// One refresh door (live data L0.4, closing the gap its log left open): the ↻
// on a connection's dataset row (`connection:refresh`) and the automation
// command `datasets refresh` take the SAME door as `dataset:refresh` — the
// job, the one-per-dataset queue, the lock across pods, the announcement to
// open dashboards — instead of fetching and writing beside it.
//
//   1. queue     ↻ on the dataset and ↻ on its connection row at the same
//                instant, over a source that takes 150 ms: the source is never
//                asked twice at once. NEGATIVE CONTROL: the old handler's own
//                call (`refreshConnectionInto`, straight to the source) beside
//                a running job IS two fetches at once.
//   2. the same  `connection:refresh` runs as a `refresh` job, is announced to
//                open dashboards, and answers the header — no rows.
//   3. its own   a connection the dataset did not come from is refused before
//                the source is asked; the dataset keeps its rows.
//   4. command   `datasets refresh` behind a running refresh queues too, and is
//                announced.
//
// The lock across pods on these two doors: scripts/test-refreshLock.ts §3.
//
//   npm run build:ts && node scripts/test-refreshOneDoor.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const connIpc: typeof import('../src/ipc/connections') = require('../src/ipc/connections');
const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const schedules: typeof import('../src/server/jobs/schedules') = require('../src/server/jobs/schedules');
const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');

const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-onedoor-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const inOrg = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, `t${++seq}`, fn);

// The source: every run is counted, and how many were inside it at once.
const src = { calls: 0, inside: 0, max: 0, delayMs: 150 };
connectionRun.runConnection = (async () => {
  src.calls++;
  src.max = Math.max(src.max, ++src.inside);
  await sleep(src.delayMs);
  src.inside--;
  return { ok: true, truncated: false, result: { columns: [{ name: 'region', type: 'text' }], rows: [['north'], ['south'], ['east']], rowCount: 3, warnings: [] } };
}) as unknown as typeof connectionRun.runConnection;
const resetSrc = () => Object.assign(src, { calls: 0, inside: 0, max: 0 });

const pushes: { channel: string; datasetId: string }[] = [];
schedules.pushToReaders = ((_p: string, channel: string, payload: { datasetId: string }) => {
  pushes.push({ channel, datasetId: payload.datasetId });
}) as typeof schedules.pushToReaders;
const announced = (id: string) => pushes.filter((p) => p.channel === 'hub:dataset-refreshed' && p.datasetId === id).length;

(async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const cols = [{ name: 'region', type: 'text' as const }];
  const fx = await inOrg(async () => {
    await projects.init();
    const P = (await projects.createProject('One door')).id;
    const values = { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' };
    const conn = await conns.saveConnection(P, { name: 'App DB', connectorId: 'postgres', values });
    const other = await conns.saveConnection(P, { name: 'Other DB', connectorId: 'postgres', values });
    const make = async (name: string) => (await datasets.saveDataset(P, { name, sourceKind: 'postgres', columns: cols, rows: [['old']], origin: { kind: 'connection', connId: conn!.id, table: name } }))!.id;
    return { P, conn: conn!.id, other: other!.id, a: await make('a'), b: await make('b'), c: await make('c'), d: await make('d') };
  });
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const post = async (channel: string, payload: unknown) => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    return { status: r.statusCode, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: each reply is narrowed by the check that reads it
  };
  const rowsOf = async (id: string) => (await inOrg(() => datasets.getDatasetMeta(fx.P, id)))?.rowCount;

  // ── 1. The queue ──────────────────────────────────────────────────────────
  const both = await Promise.all([
    post('dataset:refresh', { projectId: fx.P, id: fx.a }),
    post('connection:refresh', { projectId: fx.P, connId: fx.conn, datasetId: fx.a }),
  ]);
  ok('queue: ↻ on the dataset and ↻ on its connection row at once → both answer ok', both.every((r) => r.status === 200 && r.value?.ok === true), JSON.stringify(both.map((r) => r.value)).slice(0, 300));
  ok('queue: …and the source was never asked twice at the same time', src.calls === 2 && src.max === 1, `calls ${src.calls}, at once ${src.max}`);

  resetSrc();
  const job = post('dataset:refresh', { projectId: fx.P, id: fx.b });
  await sleep(40); // the job is inside the source
  await inOrg(() => connIpc.refreshConnectionInto(fx.P, fx.conn, fx.b));
  await job;
  ok('queue (NEGATIVE CONTROL): the old handler\'s direct call beside a running job is two fetches at once', src.max === 2, `at once ${src.max}`);

  // ── 2. The same door ──────────────────────────────────────────────────────
  resetSrc();
  const before = announced(fx.c);
  const one = await post('connection:refresh', { projectId: fx.P, connId: fx.conn, datasetId: fx.c });
  const ran = jobs.snapshot().recent.find((j) => j.kind === 'refresh' && j.datasetId === fx.c);
  ok('same door: connection:refresh ran as a refresh job', ran?.state === 'done', JSON.stringify(ran));
  ok('same door: …and was announced to open dashboards, once', announced(fx.c) - before === 1, `${announced(fx.c) - before}`);
  ok('same door: the reply is the header (3 rows counted, no rows carried)', one.value?.ok === true && one.value.dataset?.rowCount === 3 && !('rows' in one.value.dataset), JSON.stringify(one.value).slice(0, 300));

  // ── 3. Its own connection ─────────────────────────────────────────────────
  resetSrc();
  const wrong = await post('connection:refresh', { projectId: fx.P, connId: fx.other, datasetId: fx.d });
  ok('its own: a connection the dataset did not come from is refused, the source unasked', wrong.value?.ok === false && src.calls === 0 && (await rowsOf(fx.d)) === 1, JSON.stringify(wrong.value));

  // ── 4. The command ────────────────────────────────────────────────────────
  resetSrc();
  const seen = announced(fx.d);
  const ctx = { projectId: fx.P, transport: 'cli' as const, cwd: DATA, headless: true, progress: () => undefined };
  const [, cmd] = await Promise.all([
    post('dataset:refresh', { projectId: fx.P, id: fx.d }),
    inOrg(() => automation.datasetsRefresh(ctx, fx.d)) as Promise<{ rows: number }>,
  ]);
  ok('command: `datasets refresh` behind a running refresh queues (never two fetches at once)', src.calls === 2 && src.max === 1 && cmd.rows === 3, `calls ${src.calls}, at once ${src.max}`);
  ok('command: …and both are announced', announced(fx.d) - seen === 2, `${announced(fx.d) - seen}`);

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
