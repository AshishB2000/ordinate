// Live on a PostgreSQL read replica (docs/live-data/00-plan.md L3.2, D8).
//
// 1. The rule, pure. Which connectors CAN be Live and which ask a connection to
//    opt in (`ConnectorLive.optIn`); `isLiveOffered` over a connection's stored
//    values — only a real `true` is a yes; a broken opt-in (a missing field, a
//    text field, a secret) makes the connector not Live at all (NEGATIVE
//    CONTROLS: the guard fails closed); the catalog says "can be Live" and names
//    the checkbox, never the dialect.
// 2. The server enforces it (no DATABASE_URL needed: no socket is opened).
//    `connection:import {mode:'live'}` and `dataset:setMode` refuse a Postgres
//    connection without the opt-in, with the catalog sentence; `dataset:source`
//    offers the switch only once it is ticked; `connection:setLiveOptIn` ticks
//    it, refuses to untick while Live datasets ask the connection (naming how
//    many), and unticks once none do; the executor asks the rule on EVERY
//    question — a restored Live dataset over an unticked connection is refused
//    before any socket (NEGATIVE CONTROL: ticked, the same question reaches the
//    network and fails there instead).
// 3. With DATABASE_URL — end to end on a real Postgres whose sessions default
//    to UTC+14: connect with the box ticked (`connection:testAndSave`), "Add
//    from connection → Live" over a table, and the same table copied; charts
//    and KPIs through the L2.3 executor (`liveVizData` / `liveMetric`) equal the
//    extract's (`vizDataFor` / `computeCardMetric`) with `Object.is` — every
//    label and every figure, sums and averages included (the fixture's amounts
//    are quarters, so no summation order can round). A timestamptz bucketed by
//    day agrees because a live session runs in UTC (NEGATIVE CONTROL: the same
//    compiled statement on a raw session in the database's own zone answers
//    other days). PINNED: a text category holding both '' and NULL — one blank
//    row in the copy (an import types '' as null), two on live (for L2.8).
//    Measured: a live KPI's round trip, and the UTC statement's.
//
//   npm run build:ts && node scripts/test-liveReplica.js
//   DATABASE_URL=postgres://… node scripts/test-liveReplica.js   # + section 3

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import type { ConnectorDef, ConnectorField } from '../src/connectors/types';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livereplica-'));
const dbUrl = process.env.DATABASE_URL;
// Section 3's Postgres is on this machine; the SSRF guard refuses loopback otherwise (T6.1).
if (dbUrl) process.env.SSRF_ALLOW = '127.0.0.0/8,::1/128';

const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
const optIn: typeof import('../src/ipc/liveOptIn') = require('../src/ipc/liveOptIn');
const api: typeof import('../src/api/index') = require('../src/api/index');
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');

const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x));
const OPT_IN = 'readReplica';
const OPT_IN_LABEL = 'This is a read replica or a warehouse';
/** The Postgres-family members whose server IS PostgreSQL (its parser, functions, casts). */
const REPLICA_LIVE = ['postgres', 'alloydb', 'neon', 'supabase', 'timescaledb'];
/** Not verified against the Redshift dialect's spellings: a reimplementation, a fork, or a pgwire engine. */
const NOT_LIVE = ['cockroachdb', 'yugabytedb', 'materialize', 'questdb', 'risingwave'];

// ── 1. The rule ───────────────────────────────────────────────────────────────

function pure(): void {
  const def = (id: string): ConnectorDef => {
    const d = registry.getConnector(id);
    if (!d) throw new Error(`no connector ${id}`);
    return d;
  };
  for (const id of REPLICA_LIVE) {
    const d = def(id);
    const f = d.fields.find((x) => x.key === OPT_IN);
    ok(`${id}: CAN be Live, in the Redshift dialect, behind the "${OPT_IN}" opt-in`, registry.isLiveCapable(d) && d.live?.dialect === 'redshift' && d.live.optIn === OPT_IN);
    ok(`${id}: the opt-in is a non-secret checkbox, off by default, last on the form`,
      !!f && f.type === 'checkbox' && f.secret !== true && f.default === false && f.label === OPT_IN_LABEL && d.fields[d.fields.length - 1] === f);
    ok(`${id}: its help says why, in one factual line`, !!f && /primary OLTP database adds load to production\.$/.test(f.help ?? '') && !(f.help ?? '').includes('\n'), f?.help);
  }
  const rs = def('amazon-redshift');
  ok('amazon-redshift: Live with no opt-in (a warehouse) — and no opt-in field on its form',
    registry.isLiveCapable(rs) && rs.live?.optIn === undefined && !rs.fields.some((f) => f.key === OPT_IN) && registry.isLiveOffered(rs, {}));
  for (const id of NOT_LIVE) {
    const d = def(id);
    ok(`${id}: not Live (unverified against the dialect), and no opt-in on its form`, !d.live && !registry.isLiveCapable(d) && !d.fields.some((f) => f.key === OPT_IN));
  }

  const pg = def('postgres');
  const offered = (values: Record<string, unknown> | null | undefined): boolean => registry.isLiveOffered(pg, values);
  ok('isLiveOffered: a Postgres connection ticked `true` is offered Live', offered({ host: 'h', [OPT_IN]: true }));
  ok('NEGATIVE CONTROL — isLiveOffered: unticked, missing, or no values at all → not offered',
    !offered({ [OPT_IN]: false }) && !offered({ host: 'h' }) && !offered({}) && !offered(null) && !offered(undefined));
  ok('NEGATIVE CONTROL — isLiveOffered: only a real boolean counts ("true", 1, "on" are not a yes)',
    !offered({ [OPT_IN]: 'true' }) && !offered({ [OPT_IN]: 1 }) && !offered({ [OPT_IN]: 'on' }));
  ok('isLiveOffered: a connector with no live dialect is never offered, ticked or not',
    !registry.isLiveOffered(def('cockroachdb'), { [OPT_IN]: true }) && !registry.isLiveOffered(def('mysql'), { [OPT_IN]: true }) && !registry.isLiveOffered(null, { [OPT_IN]: true }));

  // A broken declaration fails CLOSED: the connector is not Live for anyone.
  const withOptIn = (key: string, fields: ConnectorField[]): ConnectorDef => ({ ...pg, fields, live: { ...pg.live!, optIn: key } });
  const box = (over: Partial<ConnectorField> = {}): ConnectorField => ({ key: OPT_IN, label: 'x', type: 'checkbox', ...over });
  ok('the rule holds for a well-formed declaration (the controls below differ in one thing each)', registry.isLiveCapable(withOptIn(OPT_IN, [box()])));
  ok('NEGATIVE CONTROL — an opt-in naming no field: not Live at all, even with the key set',
    !registry.isLiveCapable(withOptIn('typo', [box()])) && !registry.isLiveOffered(withOptIn('typo', [box()]), { typo: true, [OPT_IN]: true }));
  ok('NEGATIVE CONTROL — an opt-in naming a TEXT field: not Live', !registry.isLiveCapable(withOptIn(OPT_IN, [box({ type: 'text' })])));
  ok('NEGATIVE CONTROL — an opt-in naming a SECRET checkbox: not Live', !registry.isLiveCapable(withOptIn(OPT_IN, [box({ secret: true })])));

  const catalog = registry.connectorCatalog();
  const entry = (id: string) => catalog.find((e) => e.id === id);
  ok('catalog: every replica-capable Postgres says live (CAN be) and names its checkbox',
    REPLICA_LIVE.every((id) => entry(id)?.live === true && entry(id)?.liveOptIn === OPT_IN));
  ok('catalog: Redshift, Snowflake and BigQuery are live with no opt-in key',
    ['amazon-redshift', 'snowflake', 'bigquery'].every((id) => entry(id)?.live === true && !('liveOptIn' in (entry(id) ?? {}))));
  ok('catalog: the rest carry no opt-in key', catalog.filter((e) => !REPLICA_LIVE.includes(e.id)).every((e) => !('liveOptIn' in e)));
  ok('catalog: still no dialect anywhere', !JSON.stringify(catalog).includes('"dialect"') && !JSON.stringify(catalog).includes('"redshift"'));

  ok('the refusal: a non-live connector gets "can\'t answer live", an unticked Postgres the opt-in sentence naming the box, the rest none',
    /can’t answer questions live/.test(optIn.liveOfferRefusal(def('cockroachdb'), {}) ?? '')
      && (optIn.liveOfferRefusal(pg, {}) ?? '').includes(`Tick “${OPT_IN_LABEL}”`) && optIn.liveOfferRefusal(pg, { [OPT_IN]: true }) === null
      && optIn.liveOfferRefusal(rs, {}) === null);
  const input = api.contracts['connection:setLiveOptIn'].input;
  const ids = { projectId: '0b8f0e7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b', connId: '1b8f0e7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b' };
  ok('contract: connection:setLiveOptIn takes a boolean', input.safeParse({ ...ids, on: true }).success && input.safeParse({ ...ids, on: false }).success);
  ok('NEGATIVE CONTROL — contract: "true", a missing `on` and an extra key are refused',
    !input.safeParse({ ...ids, on: 'true' }).success && !input.safeParse(ids).success && !input.safeParse({ ...ids, on: true, values: {} }).success);
  ok('contract: write access, scoped to the project', api.contracts['connection:setLiveOptIn'].access === 'write');
}

// ── 2 and 3: over the RPC route, in server mode ───────────────────────────────

type Post = (channel: string, payload: unknown) => Promise<{ status: number; body: string; value: any }>; // any: each reply is narrowed by the check that reads it

async function server(): Promise<void> {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  // An in-memory secret store: the encrypted one needs Postgres + a master key (test-connections-server covers it).
  const kept = new Map<string, string>();
  configSecrets.useSecretStore({
    get: async (o, k, r) => kept.get(`${o}|${k}|${r}`) ?? null,
    put: async (o, k, r, v) => { kept.set(`${o}|${k}|${r}`, v); },
    delete: async (o, k, r) => kept.delete(`${o}|${k}|${r}`),
  });
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const post: Post = async (channel, payload) => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    return { status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: as above
  };
  try {
    await enforced(post);
    if (!dbUrl) console.log('skip the Postgres flow: no DATABASE_URL');
    else await (require('./liveReplicaFlow') as typeof import('./liveReplicaFlow')).endToEnd(post, dbUrl, ADMIN);
  } finally {
    await app.close();
  }
}

async function enforced(post: Post): Promise<void> {
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const record: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const lq: typeof import('../src/engine/live/liveQuery') = require('../src/engine/live/liveQuery');
  const COLS = [{ name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }];
  // 169.254.169.254: were any path to open a socket, the SSRF guard would answer — not the opt-in.
  const VALUES = { host: '169.254.169.254', port: 5432, database: 'app', user: 'reader', ssl: false };
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Read replica')).id;
    const pg = await conns.saveConnection(projectId, { name: 'App DB', connectorId: 'postgres', values: VALUES });
    if (!pg) throw new Error('connection not saved');
    const copy = await datasets.saveDataset(projectId, { name: 'Orders copy', sourceKind: 'postgres', columns: COLS, rows: [['North', 1]], origin: { kind: 'connection', connId: pg.id, table: 'public.orders' } });
    if (!copy) throw new Error('dataset not saved');
    return { projectId, pg: pg.id, copy: copy.id };
  });
  const P = seed.projectId;
  const needs = (body: string): boolean => body.includes(`Tick “${OPT_IN_LABEL}”`);

  const cat = await post('connectors:catalog', undefined);
  const pgEntry = (cat.value as { id: string; live: boolean; liveOptIn?: string }[]).find((c) => c.id === 'postgres');
  ok('connectors:catalog: PostgreSQL can be Live, behind its opt-in', pgEntry?.live === true && pgEntry.liveOptIn === OPT_IN, show(pgEntry));

  const imp = await post('connection:import', { projectId: P, connId: seed.pg, name: 'No', table: 'public.orders', limit: 100, mode: 'live' });
  ok('connection:import {mode:live} on an unticked Postgres is refused with the opt-in sentence (before any socket)',
    imp.value?.ok === false && needs(imp.value.error) && !/169\.254|blocked|SSRF|private/i.test(imp.body), imp.body);
  const src0 = await post('dataset:source', { projectId: P, id: seed.copy });
  ok('dataset:source: a copy from an unticked Postgres is not offered the Live switch', src0.value?.kind === 'connection' && !('canGoLive' in src0.value), src0.body);
  const mode0 = await post('dataset:setMode', { projectId: P, datasetId: seed.copy, mode: 'live', confirmDrop: true });
  ok('dataset:setMode → live on it is refused with the opt-in sentence, even confirmed, and the copy is kept',
    mode0.value?.ok === false && needs(mode0.value.error) && (await context.runInContext(ADMIN, 'm', () => datasets.getDatasetMeta(P, seed.copy)))?.mode !== 'live', mode0.body);

  const tick = await post('connection:setLiveOptIn', { projectId: P, connId: seed.pg, on: true });
  const stored = await context.runInContext(ADMIN, 'c', () => conns.getConnection(P, seed.pg));
  ok('connection:setLiveOptIn ticks it: stored as a boolean beside the other values, which are untouched',
    tick.value?.ok === true && tick.value.on === true && stored?.values[OPT_IN] === true && stored.values.host === VALUES.host && stored.values.database === 'app', tick.body);
  const src1 = await post('dataset:source', { projectId: P, id: seed.copy });
  ok('…and dataset:source now offers the switch', src1.value?.canGoLive === true, src1.body);
  const mode1 = await post('dataset:setMode', { projectId: P, datasetId: seed.copy, mode: 'live' });
  ok('…and dataset:setMode gets as far as the drop confirmation', mode1.value?.ok === false && mode1.value.code === 'confirm_drop', mode1.body);
  const imp1 = await post('connection:import', { projectId: P, connId: seed.pg, name: 'Yes', table: 'public.orders', limit: 100, mode: 'live' });
  ok('NEGATIVE CONTROL — ticked, the same import reaches the network (refused there, by the SSRF guard)', imp1.value?.ok === false && !needs(imp1.value.error), imp1.body);

  // Two Live datasets over it (the records the create flow writes).
  const lives = await context.runInContext(ADMIN, 'l', async () => Promise.all(['A', 'B'].map((n) =>
    record.saveLiveRecord(P, { name: `Live ${n}`, columns: COLS, origin: { kind: 'connection', connId: seed.pg, table: 'public.orders' } }))));
  const [liveA, liveB] = lives.map((d) => String(d?.id));
  const off2 = await post('connection:setLiveOptIn', { projectId: P, connId: seed.pg, on: false });
  ok('unticking with two Live datasets on it is refused, naming how many',
    off2.value?.ok === false && off2.value.code === 'live_in_use' && off2.value.liveDatasets === 2
      && off2.value.error === `2 Live datasets ask this connection. Switch them to “Copy the data” before unticking “${OPT_IN_LABEL}”.`, off2.body);
  ok('…and the box stays ticked', (await context.runInContext(ADMIN, 'c', () => conns.getConnection(P, seed.pg)))?.values[OPT_IN] === true);
  await post('dataset:delete', { projectId: P, id: liveA });
  const off1 = await post('connection:setLiveOptIn', { projectId: P, connId: seed.pg, on: false });
  ok('with one left, the sentence says one', off1.value?.ok === false && off1.value.liveDatasets === 1 && off1.value.error.startsWith('One Live dataset asks this connection. Switch it'), off1.body);

  // The executor asks the rule on every question. Ticked: the question reaches the network.
  const ask = (id: string) => context.runInContext(ADMIN, 'q', () => lq.liveMetric(P, id, { column: 'amount', aggregation: 'sum' }, []));
  const reached = await ask(liveB);
  ok('ticked: a Live question gets past the rule (and fails at the network: the address is refused)', !reached.ok && reached.code !== 'live_unavailable', show(reached));
  await post('dataset:delete', { projectId: P, id: liveB });
  const off0 = await post('connection:setLiveOptIn', { projectId: P, connId: seed.pg, on: false });
  ok('with none left, it unticks', off0.value?.ok === true && off0.value.on === false
    && (await context.runInContext(ADMIN, 'c', () => conns.getConnection(P, seed.pg)))?.values[OPT_IN] === false, off0.body);
  // A Live dataset restored from the Trash after the untick: its connection says no.
  const restored = await post('trash:restore', { projectId: P, type: 'dataset', id: liveB });
  const refusedQ = await ask(liveB);
  ok('a Live dataset restored over the unticked connection: its question is refused by the rule, before any socket',
    restored.status === 200 && !refusedQ.ok && refusedQ.code === 'live_unavailable' && needs(refusedQ.error), show(refusedQ));
  const offAgain = await post('connection:setLiveOptIn', { projectId: P, connId: seed.pg, on: false });
  ok('…and it counts again: unticking an unticked box is refused while it is there', offAgain.value?.ok === false && offAgain.value.liveDatasets === 1, offAgain.body);

  const rsConn = await context.runInContext(ADMIN, 'rs', () => conns.saveConnection(P, { name: 'DW', connectorId: 'amazon-redshift', values: VALUES }));
  const rsOpt = await post('connection:setLiveOptIn', { projectId: P, connId: String(rsConn?.id), on: true });
  ok('a connector with no opt-in (Redshift) has nothing to tick', rsOpt.value?.ok === false && rsOpt.value.error === 'This connection has no read-replica setting.', rsOpt.body);
  const gone = await post('connection:setLiveOptIn', { projectId: P, connId: '9b8f0e7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b', on: true });
  ok('an unknown connection is "not found"', gone.value?.ok === false && gone.value.error === 'Connection not found', gone.body);
}

(async () => {
  pure();
  await server();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
