// Every converted store holds the SAME lock across pods (src/app/recordFs.ts
// `locked`, docs/record-locks/00-design.md). In-process tests cannot see a
// missing Postgres lock — only another session or another process can — so:
//
//   1. WIRING, per store: a RAW pg session holds `records:<org>:<rel>` of that
//      store's file. The store's call stays pending while it does, and lands
//      right after its COMMIT. CONTROL: the same call on another project (or
//      org, for the workspace's themes) is not delayed.
//   2. TWO PROCESSES (two pods, one Postgres), 20 concurrent appends each —
//      comments, versions, alert events: all 40 kept, under every store's cap of
//      50. NEGATIVE CONTROL: the old six-line per-process chain loses appends.
//   3. FX: pod B sees pod A's currency declaration within a second. NEGATIVE
//      CONTROL: a never-expiring cache (the old one) never does.
//
// Needs DATABASE_URL (a Postgres it may CREATE DATABASE on); without it, one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-recordLocked-pods.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { spawn }: typeof import('child_process') = require('child_process');
const { randomUUID }: typeof import('crypto') = require('crypto');

const CHILD = process.argv[2] === 'child';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), CHILD ? 'ordinate-pod-child-' : 'ordinate-pods-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(TMP);
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const comments: typeof import('../src/app/comments') = require('../src/app/comments');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const fxStore: typeof import('../src/app/fxStore') = require('../src/app/fxStore');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let req = 0;
const as = <T>(fn: () => Promise<T>, org = 'acme'): Promise<T> =>
  context.runInContext({ user: { email: `ana@${org}.test`, role: 'admin' }, org: { id: org } }, `r${++req}`, fn);

/** A list record, read-modify-written with a yield in the middle (the race window). */
async function appendRaw(file: string, n: string): Promise<void> {
  let list: string[] = [];
  try { list = JSON.parse(await recordFs.readFile(file, 'utf8')); } catch { /* none yet */ }
  await new Promise((r) => setImmediate(r));
  list.push(n);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await recordFs.writeFile(tmp, JSON.stringify(list));
  await recordFs.rename(tmp, file);
}

// The chain every store used to copy: in-process only.
const queues = new Map<string, Promise<unknown>>();
function oldChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => undefined));
  return next;
}

// ── A child: one pod ─────────────────────────────────────────────────────────

async function child(): Promise<void> {
  const [, , , mode, url, pid, who, startAt] = process.argv;
  const pool = new Pool({ connectionString: url, max: 10 });
  pool.on('error', () => undefined);
  recordFs.useRecordDb(pool);
  const out: Record<string, unknown> = {};
  try {
    await sleep(Math.max(0, Number(startAt) - Date.now()));
    await as(async () => {
      if (mode === 'append') {
        const vid = '9'.repeat(8) + '-9999-4999-8999-' + '9'.repeat(12);
        await Promise.all(Array.from({ length: 20 }, async (_, i) => {
          await comments.add(pid, { kind: 'dataset', id: pid }, `${who}${i}`);
          await versions.record(pid, 'visual', { id: vid, name: `${who}${i}`, chartType: 'bar', encoding: {} });
          await alertStore.recordEvents(pid, [{ id: randomUUID(), ruleId: randomUUID(), at: new Date().toISOString(), message: `${who}${i}`, seen: false } as never]);
        }));
      } else if (mode === 'chain') {
        const file = path.join(appPaths.userData(), 'projects', pid, 'chained.json');
        await Promise.all(Array.from({ length: 20 }, (_, i) => oldChain(pid, () => appendRaw(file, `${who}${i}`))));
      } else if (mode === 'fx-declare') {
        await sleep(300); // after pod B has cached what it read
        out.declaredAt = Date.now();
        await fxStore.setColumnCurrency(pid, pid, 'amount', { kind: 'fixed', code: 'EUR' });
      } else if (mode === 'fx-watch') {
        const file = path.join(appPaths.userData(), 'projects', pid, 'fx.json');
        const neverExpires = new Map<string, unknown>(); // the old cache: invalidated by this pod's own writes only
        const oldGet = async (): Promise<unknown> => {
          if (!neverExpires.has(file)) neverExpires.set(file, await fxStore.getFx(pid));
          return neverExpires.get(file);
        };
        const declared = (s: unknown): boolean => !!(s as { columns?: Record<string, Record<string, unknown>> }).columns?.[pid]?.amount;
        await fxStore.getFx(pid);
        await oldGet();
        for (let t = Date.now(); Date.now() - t < 3_000 && !out.seenAt; await sleep(25)) {
          if (declared(await fxStore.getFx(pid))) out.seenAt = Date.now();
        }
        out.oldSeen = declared(await oldGet());
      }
    });
  } finally {
    await pool.end();
    process.stdout.write(JSON.stringify(out) + '\n');
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

function runChild(args: string[]): Promise<Record<string, number | boolean>> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [__filename, 'child', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString()));
    c.stderr.on('data', (d: Buffer) => (err += d.toString()));
    c.on('exit', (code) => {
      const line = out.trim().split('\n').pop() || '';
      if (code !== 0) return reject(new Error(`child ${args[0]} exited ${code}: ${err.slice(-800)}`));
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`child ${args[0]}: ${out} ${err}`.slice(-800))); }
    });
  });
}

// ── The parent ───────────────────────────────────────────────────────────────

/** A raw session: BEGIN and hold `key` until `commit()`. */
async function rawHold(url: string, key: string): Promise<() => Promise<void>> {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  return async () => { await c.query('COMMIT'); await c.end(); };
}

interface Wire { store: string; rel: string; call: () => Promise<unknown>; other: () => Promise<unknown>; org?: string }

async function wired(url: string, w: Wire): Promise<void> {
  const commit = await rawHold(url, `records:acme:${w.rel}`);
  let landed = 0;
  const t0 = Date.now();
  const pending = as(w.call).then(() => { landed = Date.now(); }, (e: Error) => { landed = -1; throw e; });
  const t1 = Date.now();
  await as(w.other, w.org);
  const otherMs = Date.now() - t1;
  await sleep(400);
  const held = landed === 0;
  const released = Date.now();
  await commit();
  await pending;
  ok(`wiring ${w.store}: held while a raw session holds ${w.rel.replace(/[0-9a-f-]{36}/g, '<id>')}, lands right after its COMMIT (${landed - released} ms)`,
    held && landed - t0 >= 300 && landed - released < 1_500, `held=${held} after=${landed - released}`);
  ok(`wiring ${w.store} CONTROL: the same call elsewhere is not delayed (${otherMs} ms)`, otherMs < 300);
}

async function parent(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 10 });
  pool.on('error', () => undefined);
  const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
  await mig.migrate(pool);
  recordFs.useRecordDb(pool);
  const duckPool: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
  duckPool.routeByOrg({ dataDir: TMP, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 600_000 });
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
  const pipelineStore: typeof import('../src/app/pipelineStore') = require('../src/app/pipelineStore');
  const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
  const themes: typeof import('../src/app/themeStore') = require('../src/app/themeStore');
  const snapshots: typeof import('../src/data/snapshots') = require('../src/data/snapshots');
  const input: typeof import('../src/data/inputTable/store') = require('../src/data/inputTable/store');
  const subs: typeof import('../src/analysis/subscriptions') = require('../src/analysis/subscriptions');
  const publish: typeof import('../src/publish/publish') = require('../src/publish/publish');
  const hosted: typeof import('../src/publish/hosted') = require('../src/publish/hosted');
  const appMod: typeof import('../src/server/app') = require('../src/server/app');
  const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
  appMod.registerHandlers();
  (publish as { buildPages: unknown }).buildPages = async () => ({ pages: [], index: '<p>i</p>', combos: 0 });

  try {
    const s = await as(async () => {
      const [p, q] = [await projects.createProject('P'), await projects.createProject('Q')];
      const mk = async (pid: string) => (await datasets.saveDataset(pid, { name: 'D', sourceKind: 'csv', columns: [{ name: 'amount', type: 'number' }], rows: [[1]] } as never))!.id;
      const [dp, dq] = [await mk(p.id), await mk(q.id)];
      const table = async (pid: string) => {
        const r = await input.createInputTable(pid, { name: 'T', columns: [{ name: 'x', type: 'number' }] });
        if (!r.ok) throw new Error(r.error);
        return r.id;
      };
      const [tp, tq] = [await table(p.id), await table(q.id)];
      const sub = async (pid: string) => (await subs.createSubscription(pid, { name: 'S' } as never, 'ana@acme.test'))!.id;
      const [sp, sq] = [await sub(p.id), await sub(q.id)];
      const site = async (pid: string) => (await hosted.publishHosted({ projectId: pid, dashboardIds: [randomUUID()] }, 'ana@acme.test')).id;
      const [hp, hq] = [await site(p.id), await site(q.id)];
      return { p: p.id, q: q.id, dp, dq, tp, tq, sp, sq, hp, hq };
    });
    const V = randomUUID();
    const rule = (name: string) => ({ name, datasetId: s.dp, metric: { column: 'amount', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 1 }, enabled: true });
    const batch = [{ label: 'Edit', ops: [{ t: 'set', r: 0, c: 0, cells: [['5']] }] }];
    const ds = (pid: string, id: string) => `projects/${pid}/datasets/${id}.json`;
    const W: Wire[] = [
      { store: 'comments', rel: `projects/${s.p}/comments.json`, call: () => comments.add(s.p, { kind: 'dataset', id: s.p }, 'x'), other: () => comments.add(s.q, { kind: 'dataset', id: s.q }, 'x') },
      { store: 'catalog', rel: `projects/${s.p}/catalog.json`, call: () => catalog.setDoc(s.p, `dataset:${s.dp}`, { description: 'x' }), other: () => catalog.setDoc(s.q, `dataset:${s.dq}`, { description: 'x' }) },
      { store: 'fx', rel: `projects/${s.p}/fx.json`, call: () => fxStore.setProjectFx(s.p, { target: 'EUR' }), other: () => fxStore.setProjectFx(s.q, { target: 'EUR' }) },
      { store: 'pipelines', rel: `projects/${s.p}/pipelines.json`, call: () => pipelineStore.update(s.p, (x) => { x.paused = []; }), other: () => pipelineStore.update(s.q, (x) => { x.paused = []; }) },
      { store: 'privacy policy', rel: `projects/${s.p}/privacy/policy.json`, call: () => privacy.setPolicy(s.p, { export: 'drop' }), other: () => privacy.setPolicy(s.q, { export: 'drop' }) },
      { store: 'privacy review', rel: `projects/${s.p}/privacy/review.json`, call: () => privacy.decide(s.p, s.dp, 'amount', 'none'), other: () => privacy.decide(s.q, s.dq, 'amount', 'none') },
      { store: 'themes', rel: 'themes.json', call: () => themes.saveTheme({ name: 'T' }), other: () => themes.saveTheme({ name: 'T' }), org: 'globex' },
      { store: 'versions', rel: `projects/${s.p}/history/visual/${V}`, call: () => versions.record(s.p, 'visual', { id: V, name: 'v', chartType: 'bar' }), other: () => versions.record(s.q, 'visual', { id: V, name: 'v', chartType: 'bar' }) },
      { store: 'dataset quality', rel: ds(s.p, s.dp), call: () => datasets.writeQuality(s.p, s.dp, () => undefined), other: () => datasets.writeQuality(s.q, s.dq, () => undefined) },
      { store: 'dataset markRefresh', rel: ds(s.p, s.dp), call: () => datasets.markRefresh(s.p, s.dp, 'ok', null), other: () => datasets.markRefresh(s.q, s.dq, 'ok', null) },
      { store: 'dataset setAutoRefresh', rel: ds(s.p, s.dp), call: () => datasets.setAutoRefresh(s.p, s.dp, { every: null }), other: () => datasets.setAutoRefresh(s.q, s.dq, { every: null }) },
      { store: 'snapshots', rel: `projects/${s.p}/datasets/${s.dp}.snapshots.json`, call: () => snapshots.setKeep(s.p, s.dp, 3), other: () => snapshots.setKeep(s.q, s.dq, 3) },
      { store: 'input table', rel: ds(s.p, s.tp), call: () => input.saveInputBatches(s.p, s.tp, batch), other: () => input.saveInputBatches(s.q, s.tq, batch) },
      { store: 'project fields', rel: `projects/${s.p}/project.json`, call: () => projects.renameProject(s.p, 'P2'), other: () => projects.renameProject(s.q, 'Q2') },
      { store: 'project touchOpened', rel: `projects/${s.p}/project.json`, call: () => projects.touchOpened(s.p), other: () => projects.touchOpened(s.q) },
      {
        store: 'format colours', rel: `projects/${s.p}/project.json`,
        call: () => rpc.handlers.get('format:colors:assign')!(null, { projectId: s.p, column: 'region', values: ['East'] }) as Promise<unknown>,
        other: () => rpc.handlers.get('format:colors:assign')!(null, { projectId: s.q, column: 'region', values: ['East'] }) as Promise<unknown>,
      },
      { store: 'alerts', rel: `projects/${s.p}/alerts.json`, call: () => alertStore.saveRule(s.p, rule('A')), other: () => alertStore.saveRule(s.q, rule('A')) },
      { store: 'subscriptions', rel: `projects/${s.p}/subscriptions/${s.sp}.json`, call: () => subs.stampRun(s.p, s.sp, (r) => r), other: () => subs.stampRun(s.q, s.sq, (r) => r) },
      { store: 'published site', rel: `published/${s.hp}/manifest.json`, call: () => hosted.setAccess(s.hp, 'link'), other: () => hosted.setAccess(s.hq, 'link') },
    ];
    for (const w of W) await wired(url, w);

    // ── Two processes ──────────────────────────────────────────────────────
    const pid = await as(async () => (await projects.createProject('Two pods')).id);
    const start = String(Date.now() + 1_500);
    await Promise.all(['a', 'b'].map((who) => runChild(['append', url, pid, who, start])));
    const got = await as(async () => ({
      comments: (await comments.list(pid)),
      versions: (await versions.list(pid, 'visual', '9'.repeat(8) + '-9999-4999-8999-' + '9'.repeat(12))).length,
      events: (await alertStore.load(pid)).events.length,
    }));
    const nComments = got.comments.ok ? got.comments.comments.length : -1;
    ok(`two pods × 20 concurrent appends: all 40 comments kept (${nComments})`, nComments === 40);
    ok(`…all 40 versions kept, under the cap of 50 (${got.versions})`, got.versions === 40);
    ok(`…all 40 alert events kept (${got.events})`, got.events === 40);
    const chainPid = await as(async () => (await projects.createProject('Old chain')).id);
    const start2 = String(Date.now() + 1_500);
    await Promise.all(['a', 'b'].map((who) => runChild(['chain', url, chainPid, who, start2])));
    const chained = await as(async () => JSON.parse(await recordFs.readFile(path.join(appPaths.userData(), 'projects', chainPid, 'chained.json'), 'utf8')) as string[]);
    ok(`NEGATIVE CONTROL: the old per-process chain across two pods loses appends (${40 - chained.length} of 40)`, chained.length < 40, String(chained.length));

    // ── fx across pods ───────────────────────────────────────────────────
    const fxPid = await as(async () => (await projects.createProject('Fx')).id);
    const start3 = String(Date.now() + 1_500);
    const [declare, watch] = await Promise.all([runChild(['fx-declare', url, fxPid, 'a', start3]), runChild(['fx-watch', url, fxPid, 'b', start3])]);
    const lag = Number(watch.seenAt) - Number(declare.declaredAt);
    ok(`fx: pod B sees pod A's declaration within a second of it (${lag} ms)`, Number.isFinite(lag) && lag <= 1_500, JSON.stringify({ declare, watch }));
    ok('fx NEGATIVE CONTROL: a never-expiring cache on pod B never sees it', watch.oldSeen === false);
  } finally {
    recordFs.useRecordDb(null);
    await pool.end();
  }
}

if (CHILD) {
  void child().catch((e) => ok('child pod ran to the end', false, e && e.stack ? e.stack : String(e))).finally(finish);
} else {
  (async () => {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) {
      console.log('skip record lock pods suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
      return;
    }
    const dbName = `ordinate_lockpods_${process.pid}_${Date.now()}`;
    const u = new URL(adminUrl);
    u.pathname = '/' + dbName;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    try {
      await parent(u.toString());
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  })()
    .catch((e) => ok('record lock pods suite ran to the end', false, e && e.stack ? e.stack : String(e)))
    .finally(() => {
      fs.rmSync(TMP, { recursive: true, force: true });
      finish();
    });
}
