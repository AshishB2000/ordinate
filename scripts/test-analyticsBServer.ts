// Self-check for the analytics workbenches B server channels (T2.11) — REAL
// HTTP, server mode, no Electron, every DuckDB call ROUTED to the caller's
// locked org worker exactly as src/server/main.ts does (routeByOrg):
//
//   insights:*     list (one dataset / the project), dismiss
//   events:*       list (+ each event's `when` and `days`, the app's own date
//                  arithmetic), save, delete, importCsv, setCalendars
//   snapshots:*    list (+ `delta` = current rows − snapshot rows, Object.is),
//                  diff, setKeep, stamps, restore; `visual:data` with `asOf`
//   sql:*          schema, run, explain, params bound, prepareSave → the
//                  composer's save with a `sql` origin, datasetQuery
//   LOCKDOWN       a filesystem read (read_csv('/etc/passwd'), FROM '/etc/…',
//                  glob, read_text) and another org's Parquet are refused —
//                  by the gate, AND with the gate sabotaged by the org
//                  worker's engine lock alone (control: the same sabotage
//                  reads the caller's OWN org file, so the sabotage is real)
//   scope          another org's caller → 403; a malformed input → 400
//   Part 2 (DATABASE_URL): every channel × viewer / editor / admin grants on a
//                  scratch database — exactly the roles its access names, and a
//                  denied call never reaches its handler.
//
//   npm run build:ts && node scripts/test-analyticsBServer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: the loader hook has no public type

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const sqlGate: typeof import('../src/engine/sqlGate') = require('../src/engine/sqlGate');
const { analyticsB }: typeof import('../src/api/analyticsB') = require('../src/api/analyticsB');

type Identity = import('../src/server/context').Identity;
type Reply = { status: number; body: any }; // any: each reply is narrowed by the assertion that reads it

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-analyticsB-')));
const who = (org: string): Identity => ({ user: { email: `u@${org}`, role: 'admin' }, org: { id: org } });

function client(base: string, headers: Record<string, string>) {
  return async (channel: string, payload?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json', ...headers }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
  };
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
}

/** The sample project (Retail orders), seeded as `as`; plus that dataset's Parquet path. */
async function seedSample(as: Identity): Promise<{ pid: string; ds: string; parquet: string }> {
  return context.runInContext(as, 'seed', async () => {
    const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
    const pid = String((await sample.seedSampleProject()).projectId);
    const ds = (await datasets.listDatasets(pid))[0].id;
    return { pid, ds, parquet: record.parquetPath(pid, ds) };
  });
}

const SELECT = 'select region, sum(revenue) as revenue from retail_orders group by 1 order by 2 desc';

async function partOne(): Promise<void> {
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) =>
    typeof h['x-test-org'] === 'string' ? who(h['x-test-org']) : null);
  const base = await listen(app);
  const call = client(base, { 'x-test-org': 'org-a' });
  const other = client(base, { 'x-test-org': 'org-b' });
  try {
    const a = await seedSample(who('org-a'));
    const b = await seedSample(who('org-b'));
    const { pid, ds } = a;

    // ── SQL over the project's datasets ──────────────────────────────────────
    const schema = await call('sql:schema', { projectId: pid });
    ok('sql:schema: the sample dataset under its slug, with its declared columns',
      schema.status === 200 && schema.body.ok && schema.body.datasets.some((d: { slug: string; columns: unknown[] }) => d.slug === 'retail_orders' && d.columns.length > 5), JSON.stringify(schema.body).slice(0, 300));
    const run = await call('sql:run', { projectId: pid, sql: SELECT });
    ok('sql:run over HTTP in the ROUTED org worker: rows come back (not "SQL is off")',
      run.status === 200 && run.body.ok && run.body.rows.length > 1 && run.body.columns[1].type === 'number', JSON.stringify(run.body).slice(0, 300));
    const exp = await call('sql:explain', { projectId: pid, sql: SELECT });
    ok('sql:explain: the columns it would return, no rows', exp.status === 200 && exp.body.ok && exp.body.columns.length === 2 && !('rows' in exp.body), JSON.stringify(exp.body));
    const bound = await call('sql:run', { projectId: pid, sql: 'select count(*) as n from retail_orders where region = [[r]]', params: [{ name: 'r', kind: 'text', value: "West' or '1'='1" }] });
    ok('sql:run: a [[param]] is BOUND — an injection-shaped value matches nothing', bound.status === 200 && bound.body.ok && bound.body.rows[0][0] === 0, JSON.stringify(bound.body));
    const noParam = await call('sql:run', { projectId: pid, sql: 'select * from retail_orders where region = [[r]]' });
    ok('sql:run: a missing parameter is named, not guessed', noParam.status === 200 && noParam.body.ok === false && /r/.test(noParam.body.error), JSON.stringify(noParam.body));
    const ddl = await call('sql:run', { projectId: pid, sql: 'drop table retail_orders' });
    ok('sql:run: DDL is refused by the gate', ddl.status === 200 && ddl.body.ok === false, JSON.stringify(ddl.body));

    // ── The lockdown: a filesystem read, another org's file ─────────────────
    const hostile = [
      "select * from read_csv('/etc/passwd')",
      "select * from '/etc/passwd'",
      "select * from read_text('/etc/hosts')",
      "select * from glob('/etc/*')",
      `select * from read_parquet('${b.parquet}')`,
      `select * from '${b.parquet}'`,
      "select * from read_csv_auto('../../../../etc/passwd')",
    ];
    for (const q of hostile) {
      const r = await call('sql:run', { projectId: pid, sql: q });
      ok(`gate refuses: ${q.slice(0, 60)}`, r.status === 200 && r.body.ok === false && !/root:/.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 200));
    }
    const crossDs = await call('sql:run', { projectId: pid, sql: 'select * from retail_orders_2' });
    ok('another project\'s dataset is not a table here', crossDs.status === 200 && crossDs.body.ok === false, JSON.stringify(crossDs.body));

    // Defence in depth: sabotage the gate, so the statement reaches the org worker as written.
    const realGate = sqlGate.readOnlyError;
    (sqlGate as { readOnlyError: typeof realGate }).readOnlyError = () => null;
    try {
      const own = await call('sql:run', { projectId: pid, sql: `select count(*) as n from read_parquet('${a.parquet}')` });
      ok('control: with the gate off, the caller\'s OWN org file reads (the sabotage is real)', own.status === 200 && own.body.ok && own.body.rows[0][0] === 5000, JSON.stringify(own.body));
      for (const q of hostile.filter((x) => !x.startsWith('drop'))) {
        const r = await call('sql:run', { projectId: pid, sql: q });
        ok(`engine lock alone refuses: ${q.slice(0, 60)}`, r.status === 200 && r.body.ok === false && /Permission|disabled|not allowed|External access|does not exist/i.test(r.body.error) && !/root:/.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 200));
      }
      const set = await call('sql:run', { projectId: pid, sql: "select 1; set enable_external_access=true" });
      ok('engine lock alone: a second statement is still refused', set.status === 200 && set.body.ok === false, JSON.stringify(set.body));
    } finally {
      (sqlGate as { readOnlyError: typeof realGate }).readOnlyError = realGate;
    }

    // ── Save as dataset: prepareSave stages, the composer saves with the sql origin ──
    const prep = await call('sql:prepareSave', { projectId: pid, sql: SELECT });
    ok('sql:prepareSave: a staged table + the sql origin', prep.status === 200 && prep.body.ok && typeof prep.body.stagedId === 'string' && prep.body.origin.kind === 'sql' && prep.body.origin.deps[0] === ds, JSON.stringify(prep.body).slice(0, 300));
    const saved = await call('dataset:composeSave', {
      projectId: pid, name: 'Revenue by region (query)', base: { inline: { name: 'q', stagedId: prep.body.stagedId } }, joins: [], steps: [],
      sourceKind: 'sql', origin: prep.body.origin,
    });
    ok('dataset:composeSave: a sql-origin dataset', saved.status === 200 && saved.body.ok && saved.body.dataset.rowCount === run.body.rowCount, JSON.stringify(saved.body).slice(0, 300));
    const qid = saved.body.dataset.id as string;
    const view = await call('sql:datasetQuery', { projectId: pid, datasetId: qid });
    ok('sql:datasetQuery: the statement back ("View query")', view.status === 200 && view.body.ok && view.body.sql === SELECT, JSON.stringify(view.body));
    const notSql = await call('sql:datasetQuery', { projectId: pid, datasetId: ds });
    ok('sql:datasetQuery: a file dataset has no query to show', notSql.status === 200 && notSql.body.ok === false);
    // A forged deps list is not stored: the server re-derives the datasets from the gated SQL.
    const prep2 = await call('sql:prepareSave', { projectId: pid, sql: SELECT });
    const forged = await call('dataset:composeSave', {
      projectId: pid, name: 'Forged deps', base: { inline: { name: 'q', stagedId: prep2.body.stagedId } }, joins: [], steps: [],
      sourceKind: 'sql', origin: { ...prep2.body.origin, deps: [qid, '00000000-0000-4000-8000-000000000000'] },
    });
    const storedDeps = await context.runInContext(who('org-a'), 'deps', async () => {
      const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
      const meta = await datasets.getDatasetMeta(pid, forged.body.dataset.id);
      return meta && meta.origin && meta.origin.kind === 'sql' ? meta.origin.deps : null;
    });
    ok('dataset:composeSave: a forged deps list is replaced by the statement\'s own datasets', forged.status === 200 && forged.body.ok && JSON.stringify(storedDeps) === JSON.stringify([ds]), JSON.stringify(storedDeps));
    const prep3 = await call('sql:prepareSave', { projectId: pid, sql: SELECT });
    const smuggled = await call('dataset:composeSave', {
      projectId: pid, name: 'Smuggled', base: { inline: { name: 'q', stagedId: prep3.body.stagedId } }, joins: [], steps: [],
      sourceKind: 'sql', origin: { kind: 'sql', sql: "select * from read_csv('/etc/passwd')", deps: [ds] },
    });
    ok('dataset:composeSave: an origin statement the gate refuses is not stored', smuggled.status === 200 && smuggled.body.ok === false && /Only this project/.test(smuggled.body.error), JSON.stringify(smuggled.body));
    const badOrigin = await call('dataset:composeSave', { projectId: pid, name: 'x', base: { inline: { name: 'q', stagedId: prep.body.stagedId } }, joins: [], steps: [], origin: { kind: 'url', url: 'http://x' } });
    ok('dataset:composeSave: another origin kind from a browser → 400', badOrigin.status === 400, badOrigin.status);

    // ── Snapshots ────────────────────────────────────────────────────────────
    const seeded = await context.runInContext(who('org-a'), 'snap', async () => {
      const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
      await datasets.setAutoRefresh(pid, qid, { every: 'daily' });
      const cur = await datasets.getDataset(pid, qid);
      if (!cur) throw new Error('no query dataset');
      // Two refreshes a moment apart, as the refresh path runs them (the write, then
      // the clock): each keeps the table it replaces, stamped with the time it was fetched.
      await new Promise((r) => setTimeout(r, 5));
      await datasets.updateDatasetData(pid, qid, { columns: cur.columns, rows: cur.rows.slice(1) });
      await datasets.markRefresh(pid, qid, 'ok', null);
      await new Promise((r) => setTimeout(r, 5));
      const mid = await datasets.getDataset(pid, qid);
      await datasets.updateDatasetData(pid, qid, { columns: cur.columns, rows: [...mid!.rows, ['Atlantis', 1]] });
      await datasets.markRefresh(pid, qid, 'ok', null);
      return { first: cur.rows.length };
    });
    const snaps = await call('snapshots:list', { projectId: pid, datasetId: qid });
    const L = snaps.body;
    ok('snapshots:list: eligible, two kept', snaps.status === 200 && L.ok && L.eligible && L.items.length === 2, JSON.stringify(L).slice(0, 300));
    ok('snapshots:list: every delta = current rows − snapshot rows (Object.is)', L.items.every((s: { delta: number; rowCount: number }) => Object.is(s.delta, L.current.rowCount - s.rowCount)), JSON.stringify(L.items));
    ok('snapshots:list: the oldest snapshot is the table as first saved', L.items[1].rowCount === seeded.first);
    const diff = await call('snapshots:diff', { projectId: pid, datasetId: qid, stamp: L.items[0].stamp, key: 'region' });
    ok('snapshots:diff: one region added since', diff.status === 200 && diff.body.ok && diff.body.diff.counts.added === 1 && diff.body.diff.added[0].values.includes('Atlantis'), JSON.stringify(diff.body).slice(0, 300));
    const whole = await call('snapshots:diff', { projectId: pid, datasetId: qid, stamp: L.items[0].stamp, key: null });
    ok('snapshots:diff: matched on the whole row', whole.status === 200 && whole.body.ok && whole.body.diff.mode === 'row');
    ok('snapshots:diff: a malformed stamp → 400', (await call('snapshots:diff', { projectId: pid, datasetId: qid, stamp: '../x' })).status === 400);
    const stamps = await call('snapshots:stamps', { projectId: pid, datasetIds: [qid], metricIds: [] });
    ok('snapshots:stamps: both times for the picker', stamps.status === 200 && stamps.body.ok && stamps.body.items.length === 2);
    const asOf = await call('visual:data', { projectId: pid, datasetId: qid, encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'count' }] }, asOf: stamps.body.items[1].at });
    const latest = await call('visual:data', { projectId: pid, datasetId: qid, encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'count' }] } });
    ok('visual:data asOf: the chart as the oldest snapshot held it', asOf.status === 200 && asOf.body.ok && asOf.body.data.labels.length === seeded.first && latest.body.data.labels.includes('Atlantis') && !asOf.body.data.labels.includes('Atlantis'), JSON.stringify(asOf.body).slice(0, 200));
    const keep = await call('snapshots:setKeep', { projectId: pid, datasetId: qid, keep: 1 });
    ok('snapshots:setKeep 1: one older snapshot removed', keep.status === 200 && keep.body.ok && keep.body.removed === 1, JSON.stringify(keep.body));
    const left = (await call('snapshots:list', { projectId: pid, datasetId: qid })).body;
    const rest = await call('snapshots:restore', { projectId: pid, datasetId: qid, stamp: left.items[0].stamp });
    ok('snapshots:restore: the data goes back', rest.status === 200 && rest.body.ok && rest.body.dataset.rowCount === left.items[0].rowCount && !('rows' in rest.body.dataset), JSON.stringify(rest.body).slice(0, 200));
    ok('snapshots:list on another org\'s project → 403', (await other('snapshots:list', { projectId: pid, datasetId: qid })).status === 403);

    // ── Events ───────────────────────────────────────────────────────────────
    const e0 = await call('events:list', { projectId: pid });
    ok('events:list: holiday calendars on offer', e0.status === 200 && e0.body.ok && e0.body.available.length > 0, JSON.stringify(e0.body).slice(0, 200));
    const ev = await call('events:save', { projectId: pid, event: { title: 'Black Friday', kind: 'campaign', date: '2024-11-29', end: '2024-12-02' } });
    ok('events:save: stored with an id', ev.status === 200 && ev.body.ok && /^[0-9a-f-]{36}$/.test(ev.body.event.id), JSON.stringify(ev.body));
    const one = await call('events:save', { projectId: pid, event: { title: 'Launch', kind: 'launch', date: '2024-03-01', end: null, scope: { datasetIds: [ds], filters: [{ type: 'filter', column: 'region', op: 'in', values: ['West'] }] } } });
    const listed = (await call('events:list', { projectId: pid })).body.events as Array<{ id: string; days: number; when: string; scope?: unknown }>;
    const bf = listed.find((x) => x.id === ev.body.event.id);
    const ln = listed.find((x) => x.id === one.body.event.id);
    ok('events:list: days counted by the app — 4 for Nov 29 – Dec 2, 1 for one day', bf?.days === 4 && ln?.days === 1, JSON.stringify(listed));
    ok('events:list: the "when" line comes from the server', !!bf && /Nov/.test(bf.when) && /Dec/.test(bf.when), bf?.when);
    ok('events:list: the scope is kept', !!ln?.scope);
    ok('events:save: no title → refused with a reason', (await call('events:save', { projectId: pid, event: { title: '', kind: 'other', date: '2024-01-01' } })).body.ok === false);
    ok('events:save: an unknown field → 400', (await call('events:save', { projectId: pid, event: { title: 'x', kind: 'other', date: '2024-01-01', evil: 1 } })).status === 400);
    const imp = await call('events:importCsv', { projectId: pid, text: 'date,title,kind\n2024-07-04,Summer sale,campaign\nnot a date,Broken,other\n' });
    ok('events:importCsv: one added, one skipped', imp.status === 200 && imp.body.ok && imp.body.added === 1 && imp.body.skipped === 1, JSON.stringify(imp.body));
    const cal = await call('events:setCalendars', { projectId: pid, calendars: [e0.body.available[0].code, 'nope'] });
    ok('events:setCalendars: known codes kept, unknown dropped', cal.status === 200 && cal.body.ok && cal.body.calendars.length === 1, JSON.stringify(cal.body));
    const del = await call('events:delete', { projectId: pid, id: ev.body.event.id });
    ok('events:delete: removed', del.status === 200 && del.body.ok);
    ok('events:list on another org\'s project → 403', (await other('events:list', { projectId: pid })).status === 403);

    // ── Insights ─────────────────────────────────────────────────────────────
    const ins = await call('insights:list', { projectId: pid, datasetId: ds });
    ok('insights:list: findings on the sample', ins.status === 200 && ins.body.ok && ins.body.insights.length > 0, JSON.stringify(ins.body).slice(0, 200));
    const all = await call('insights:list', { projectId: pid });
    ok('insights:list (project): ranked across datasets', all.status === 200 && all.body.ok && all.body.insights.length > 0);
    const first = ins.body.insights[0].id as string;
    const dis = await call('insights:dismiss', { projectId: pid, id: first });
    const after = await call('insights:list', { projectId: pid, datasetId: ds });
    ok('insights:dismiss: the card is gone from the list', dis.status === 200 && dis.body.ok && !after.body.insights.some((i: { id: string }) => i.id === first));
    // Home's row rides home:overview: each card's sparkline IS the chart's own visual:data.
    const home = await call('home:overview', { projectId: pid });
    const stands = home.body.standsOut as Array<{ id: string; datasetId: string; chart: { encoding: unknown; filters?: unknown[] }; spark: { labels: unknown[]; series: Array<{ values: unknown[] }> } | null }>;
    ok('home:overview standsOut: findings with a chart, dismissed ones left out', home.status === 200 && stands.length > 0 && stands.length <= 6 && !stands.some((x) => x.id === first), JSON.stringify(stands.map((x) => x.id)).slice(0, 200));
    const own = await call('visual:data', { projectId: pid, datasetId: stands[0].datasetId, encoding: stands[0].chart.encoding, filters: stands[0].chart.filters ?? [] });
    ok('home:overview standsOut: the sparkline equals the chart\'s visual:data (Object.is)', !!stands[0].spark
      && stands[0].spark.labels.length === own.body.data.labels.length && stands[0].spark.labels.every((l, i) => Object.is(l, own.body.data.labels[i]))
      && stands[0].spark.series[0].values.every((v, i) => Object.is(v, own.body.data.series[0].values[i])), JSON.stringify(stands[0].spark).slice(0, 200));
    ok('insights:list on another org\'s project → 403', (await other('insights:list', { projectId: pid })).status === 403);
    ok('insights:list: a non-uuid dataset → 400', (await call('insights:list', { projectId: pid, datasetId: '../x' })).status === 400);
    ok('sql:run on another org\'s project → 403', (await other('sql:run', { projectId: pid, sql: SELECT })).status === 403);
  } finally {
    await app.close();
  }
}

/** Every channel × viewer / editor / admin grant: allowed exactly when the role reaches the access. */
async function partTwo(adminUrl: string): Promise<void> {
  const dbName = `ordinate_t211_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const app = appMod.buildApp(envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  }));
  try {
    const base = await listen(app);
    const as = (w: string) => client(base, { 'x-forwarded-email': `${w}@acme.test` });
    for (const p of ['boss', 'alice', 'bob', 'carol']) await as(p)('projects:list');
    const uid = async (w: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${w}@acme.test`])).rows[0].id;
    const boss: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const { pid, ds } = await seedSample(boss);
    for (const [w, role] of [['alice', 'viewer'], ['bob', 'editor'], ['carol', 'admin']]) {
      const r = await as('boss')('project:share', { projectId: pid, member: { userId: await uid(w) }, role });
      if (r.status !== 200) throw new Error('share ' + r.body);
    }
    // A query dataset with one kept snapshot, for the snapshot channels.
    const prep = (await as('boss')('sql:prepareSave', { projectId: pid, sql: SELECT })).body;
    const qid = (await as('boss')('dataset:composeSave', { projectId: pid, name: 'Q', base: { inline: { name: 'q', stagedId: prep.stagedId } }, joins: [], steps: [], sourceKind: 'sql', origin: prep.origin })).body.dataset.id as string;
    const stamp = await context.runInContext(boss, 'snap', async () => {
      const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
      const snapshots: typeof import('../src/data/snapshots') = require('../src/data/snapshots');
      await datasets.setAutoRefresh(pid, qid, { every: 'daily' });
      const cur = await datasets.getDataset(pid, qid);
      await new Promise((r) => setTimeout(r, 5));
      await datasets.updateDatasetData(pid, qid, { columns: cur!.columns, rows: cur!.rows.slice(1) });
      await datasets.markRefresh(pid, qid, 'ok', null);
      return (await snapshots.list(pid, qid))[0].stamp;
    });
    const ev = (await as('boss')('events:save', { projectId: pid, event: { title: 'E', kind: 'other', date: '2024-01-01' } })).body.event.id as string;
    const insight = ((await as('boss')('insights:list', { projectId: pid, datasetId: ds })).body.insights[0] as { id: string }).id;

    const calls = new Map<string, number>();
    for (const ch of Object.keys(analyticsB)) {
      const real = rpc.handlers.get(ch);
      if (!real) continue;
      rpc.registry.removeHandler(ch);
      rpc.registry.handle(ch, (e, ...args) => {
        calls.set(ch, (calls.get(ch) ?? 0) + 1);
        return real(e, ...args);
      });
    }
    const cells: Array<[string, () => unknown]> = [
      ['insights:list', () => ({ projectId: pid, datasetId: ds })],
      ['insights:dismiss', () => ({ projectId: pid, id: insight, dismissed: false })],
      ['events:list', () => ({ projectId: pid })],
      ['events:save', () => ({ projectId: pid, event: { id: ev, title: 'E2', kind: 'other', date: '2024-01-02' } })],
      ['events:importCsv', () => ({ projectId: pid, text: 'date,title\n2024-02-02,I\n' })],
      ['events:setCalendars', () => ({ projectId: pid, calendars: [] })],
      ['snapshots:list', () => ({ projectId: pid, datasetId: qid })],
      ['snapshots:diff', () => ({ projectId: pid, datasetId: qid, stamp })],
      ['snapshots:stamps', () => ({ projectId: pid, datasetIds: [qid], metricIds: [] })],
      ['snapshots:setKeep', () => ({ projectId: pid, datasetId: qid, keep: 10 })],
      ['sql:schema', () => ({ projectId: pid })],
      ['sql:run', () => ({ projectId: pid, sql: SELECT })],
      ['sql:explain', () => ({ projectId: pid, sql: SELECT })],
      ['sql:prepareSave', () => ({ projectId: pid, sql: SELECT })],
      ['sql:datasetQuery', () => ({ projectId: pid, datasetId: qid })],
      // Last: they change what the others read.
      ['snapshots:restore', () => ({ projectId: pid, datasetId: qid, stamp })],
      ['events:delete', () => ({ projectId: pid, id: ev })],
    ];
    const rank = { read: 1, write: 2, admin: 3 } as const;
    const has: Record<string, number> = { alice: 1, bob: 2, carol: 3 };
    let wrong = 0;
    let leaks = 0;
    const lines: string[] = [];
    const covered = new Set(cells.map((c) => c[0]));
    ok('roles: the matrix covers every analytics B channel', Object.keys(analyticsB).every((c) => covered.has(c)), Object.keys(analyticsB).filter((c) => !covered.has(c)).join());
    for (const [ch, mk] of cells) {
      const access = (analyticsB as Record<string, { access: 'read' | 'write' | 'admin' }>)[ch].access;
      const line: string[] = [];
      for (const w of ['alice', 'bob', 'carol']) {
        const before = calls.get(ch) ?? 0;
        const r = await as(w)(ch, mk());
        const allowed = r.status === 200;
        if (allowed !== has[w] >= rank[access] || (r.status !== 200 && r.status !== 403)) wrong++;
        if (!allowed && (calls.get(ch) ?? 0) !== before) leaks++;
        line.push(allowed ? 'ALLOW' : 'deny ');
      }
      lines.push(`     ${ch.padEnd(22)} ${access.padEnd(6)} ${line.join(' ')}`);
    }
    console.log('     channel                access viewer editor admin\n' + lines.join('\n'));
    ok('roles: every channel allows exactly the roles its access names', wrong === 0, wrong);
    ok('roles: a denied call never reached its handler (spy)', leaks === 0, leaks);
  } finally {
    await app.close();
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

(async () => {
  context.enterServerMode(DATA);
  duck.forbidSyncOnMainThread();
  // As src/server/main.ts: every async DuckDB call in the caller's org worker, locked at start.
  const pool = poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 4, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  try {
    await partOne();
    if (process.env.DATABASE_URL) await partTwo(process.env.DATABASE_URL);
    else console.log('skip analytics B DB part: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
  } finally {
    pool.shutdown();
    duck.setRouter(null);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
