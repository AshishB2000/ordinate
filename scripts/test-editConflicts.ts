// Two editors never overwrite each other (src/app/editConflict.ts,
// docs/edit-conflicts/00-design.md) — real HTTP, EVERY converted channel, on
// files and (with DATABASE_URL) on Postgres.
//
// Per channel (dashboard, visual, metric, metric tree, report, story,
// scorecard, scenario):
//   (a) open → two saves with the open tag: the first lands; the second is 409
//       `record_changed` with the catalog's sentence and the current tag, and
//       the record is the first write;
//   (b) the reply's tag is the next base — saving from it lands — and it is the
//       tag a fresh open reads: a tab never conflicts with itself;
//   (c) a write that is not content between open and save — a saved view, a
//       favourite, a report's "generated" stamp, a save of the same content —
//       does NOT conflict, and pushes nothing;
//   (d) NEGATIVE CONTROL: without `base` the stale save lands (automation's
//       last-writer-wins);
//   (e) the race: a write committed while the guarded save waits for the
//       record's lock — a RAW Postgres session holding the advisory key, as
//       test-recordLocked does; on files a `recordFs.locked` hold — is seen by
//       the compare: the save is refused and that write stays. NEGATIVE CONTROL
//       (once a leg): the compare made BEFORE the lock lets the save land and
//       the write is lost;
//   (f) the push: a save that moved the tag tells the project's readers
//       `{projectId, type, id, tag}`, the reply's tag.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-editConflicts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const schedules: typeof import('../src/server/jobs/schedules') = require('../src/server/jobs/schedules');
const editConflict: typeof import('../src/app/editConflict') = require('../src/app/editConflict');
const say: typeof import('../src/app/editConflictMessages') = require('../src/app/editConflictMessages');

type Identity = import('../src/server/context').Identity;
type ContentType = import('../src/analysis/recordDiff').ContentType;
interface Reply { status: number; body: any } // any: each channel's own reply

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-conflicts-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (v: unknown): string => String(JSON.stringify(v)).slice(0, 300);

// Every push lockedUpdate sends, by spy (it reaches pushToReaders at call time).
const pushes: Array<{ channel: string; payload: any }> = []; // any: the push payload
(schedules as { pushToReaders: typeof schedules.pushToReaders }).pushToReaders = (_p, channel, payload) => { pushes.push({ channel, payload }); };

function caller(base: string, headers: Record<string, string> = {}) {
  return async (channel: string, payload?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json', ...headers }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? wire.decode(text) : JSON.parse(text) };
  };
}

/** One converted channel, driven as its editor drives it. `v` names a content value ('A', 'B', …). */
interface Chan {
  type: ContentType;
  label: string;
  /** The record's directory under the project: its lock path and its Postgres row. */
  dir: string;
  seed(): Promise<string>;
  open(id: string): Promise<Reply>;
  save(id: string, v: string, base?: string): Promise<Reply>;
  /** The stored value `save` and `mutate` write. */
  read(id: string): Promise<string>;
  /** A write that is not content (or is the same content). */
  quiet(id: string): Promise<Reply>;
  /** What another writer does to the stored JSON in the race. */
  mutate(rec: any, v: string): void; // any: the stored record
}

function channels(call: (c: string, p?: unknown) => Promise<Reply>, pid: string, ds: string): Chan[] {
  const named = (rec: any, v: string) => { rec.name = v; }; // any: the stored record
  // A metric tree's content here is its split column; each value is a column of the dataset.
  const COLS: Record<string, string> = { A: 'region', B: 'product', C: 'channel', D: 'segment', E: 'region' };
  let metricN = 0;
  const metricSeed = async (): Promise<string> => (await call('metric:save', { projectId: pid, input: { name: `Seed metric ${++metricN}`, datasetId: ds, definition: { column: 'amount', aggregation: 'sum' } } })).body.metric.id;
  return [
    {
      type: 'dashboard', label: 'dashboard', dir: 'analyses', mutate: named,
      seed: async () => (await call('analysis:create', { projectId: pid, name: 'Seed' })).body.id,
      open: (id) => call('analysis:open', { projectId: pid, id }),
      save: async (id, v, base) => {
        // The editor's autosave: the whole document.
        const a = (await call('analysis:open', { projectId: pid, id })).body.analysis;
        return call('analysis:update', { projectId: pid, id, ...(base ? { base } : {}), name: v, sheets: a.sheets, filters: a.filters, style: a.style, parameters: a.parameters });
      },
      read: async (id) => (await call('analysis:open', { projectId: pid, id })).body.analysis.name,
      quiet: (id) => call('analysis:view', { projectId: pid, id, op: { op: 'create', name: `View ${Date.now()}`, state: {} } }),
    },
    {
      type: 'visual', label: 'visual', dir: 'visuals', mutate: named,
      seed: async () => (await call('visual:save', { projectId: pid, datasetId: ds, name: 'Seed', chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } })).body.id,
      open: (id) => call('visual:get', { projectId: pid, id }),
      save: (id, v, base) => call('visual:update', { projectId: pid, id, ...(base ? { base } : {}), name: v, chartType: 'bar' }),
      read: async (id) => (await call('visual:get', { projectId: pid, id })).body.name,
      quiet: async (id) => call('visual:update', { projectId: pid, id, favorite: !(await call('visual:get', { projectId: pid, id })).body.favorite }),
    },
    {
      type: 'metric', label: 'metric', dir: 'metrics', mutate: named,
      seed: metricSeed,
      open: (id) => call('metric:get', { projectId: pid, id }),
      save: (id, v, base) => call('metric:update', { projectId: pid, id, ...(base ? { base } : {}), patch: { name: `Metric ${v}`, definition: { column: 'amount', aggregation: 'sum' } } }),
      read: async (id) => String((await call('metric:get', { projectId: pid, id })).body.metric.name).replace(/^Metric /, ''),
      quiet: async (id) => call('metric:update', { projectId: pid, id, patch: { name: (await call('metric:get', { projectId: pid, id })).body.metric.name } }),
    },
    {
      type: 'metric', label: 'metric tree', dir: 'metrics', mutate: (rec, v) => { rec.tree = { ...rec.tree, split: v }; },
      seed: metricSeed,
      open: (id) => call('metricTree:compute', { projectId: pid, id }),
      save: (id, v, base) => call('metricTree:save', { projectId: pid, id, ...(base ? { base } : {}), tree: { metricId: id, split: COLS[v] ?? v } }),
      read: async (id) => {
        const split = (await call('metric:get', { projectId: pid, id })).body.metric.tree?.split;
        return Object.keys(COLS).find((k) => COLS[k] === split && k !== 'E') ?? split;
      },
      quiet: async (id) => call('metric:update', { projectId: pid, id, patch: { name: (await call('metric:get', { projectId: pid, id })).body.metric.name } }),
    },
    {
      type: 'report', label: 'report', dir: 'reports', mutate: named,
      seed: async () => {
        const a = (await call('analysis:create', { projectId: pid, name: 'For a report' })).body.id;
        return (await call('reports:create', { projectId: pid, analysisId: a })).body.report.id;
      },
      open: (id) => call('reports:open', { projectId: pid, id }),
      save: (id, v, base) => call('reports:update', { projectId: pid, id, ...(base ? { base } : {}), patch: { name: v, format: 'pdf' } }),
      read: async (id) => (await call('reports:open', { projectId: pid, id })).body.report.name,
      quiet: (id) => call('reports:generated', { projectId: pid, id }),
    },
    {
      type: 'story', label: 'story', dir: 'stories', mutate: named,
      seed: async () => (await call('story:create', { projectId: pid, name: 'Seed' })).body.id,
      open: (id) => call('story:get', { projectId: pid, id }),
      save: async (id, v, base) => call('story:update', { projectId: pid, id, ...(base ? { base } : {}), name: v, blocks: (await call('story:get', { projectId: pid, id })).body.blocks }),
      read: async (id) => (await call('story:get', { projectId: pid, id })).body.name,
      quiet: async (id) => call('story:update', { projectId: pid, id, name: (await call('story:get', { projectId: pid, id })).body.name }),
    },
    {
      type: 'scorecard', label: 'scorecard', dir: 'scorecards', mutate: named,
      seed: async () => (await call('scorecard:create', { projectId: pid, name: 'Seed', period: 'month', rows: [] })).body.scorecard.id,
      open: (id) => call('scorecard:get', { projectId: pid, id }),
      save: (id, v, base) => call('scorecard:update', { projectId: pid, id, ...(base ? { base } : {}), patch: { name: v } }),
      read: async (id) => (await call('scorecard:get', { projectId: pid, id })).body.name,
      quiet: async (id) => call('scorecard:update', { projectId: pid, id, patch: { period: (await call('scorecard:get', { projectId: pid, id })).body.period } }),
    },
    {
      type: 'scenario', label: 'scenario', dir: 'scenarios', mutate: named,
      seed: async () => (await call('scenario:create', { projectId: pid, input: { name: 'Seed', baseMetricIds: [], drivers: [] } })).body.scenario.id,
      open: (id) => call('scenario:get', { projectId: pid, id }),
      save: (id, v, base) => call('scenario:update', { projectId: pid, id, ...(base ? { base } : {}), patch: { name: v, baseMetricIds: [], drivers: [] } }),
      read: async (id) => (await call('scenario:get', { projectId: pid, id })).body.name,
      quiet: async (id) => call('scenario:update', { projectId: pid, id, patch: { name: (await call('scenario:get', { projectId: pid, id })).body.name, baseMetricIds: [], drivers: [] } }),
    },
  ];
}

/** The second writer of the race: hold the record's lock, let the guarded save queue behind it, write `v`, release. */
type Holder = (rel: string, mutate: (rec: any) => void) => Promise<{ write: () => Promise<void> }>; // any: the stored record

async function leg(leg: string, call: (c: string, p?: unknown) => Promise<Reply>, who: Identity, holder: Holder): Promise<void> {
  const pid: string = (await call('projects:create', { name: `Conflicts ${leg}` })).body.id;
  const ds = await context.runInContext(who, 'seed', async () => {
    const d = await datasets.saveDataset(pid, {
      name: 'Sales', sourceKind: 'csv',
      columns: [...['region', 'product', 'channel', 'segment'].map((name) => ({ name, type: 'text' as const })), { name: 'amount', type: 'number' as const }, { name: 'day', type: 'date' as const }],
      rows: [['East', 'Pens', 'Web', 'SMB', 10, '2025-01-05'], ['West', 'Ink', 'Store', 'Ent', 20, '2025-02-05'], ['East', 'Ink', 'Web', 'Ent', 5, '2025-03-05']],
    });
    if (!d) throw new Error('seed dataset');
    return d.id;
  });

  let controlDone = false;
  for (const ch of channels(call, pid, ds)) {
    const L = `${leg} ${ch.label}`;
    const id = await ch.seed();
    const t0: string = (await ch.open(id)).body.tag;
    ok(`${L}: the open reply carries the content tag`, typeof t0 === 'string' && t0.length === 43, show(t0));

    // (a) two editors, one tag
    pushes.length = 0;
    const first = await ch.save(id, 'A', t0);
    const t1: string = first.body.tag;
    ok(`${L} (a): the first save lands with a new tag`, first.status === 200 && first.body.ok !== false && typeof t1 === 'string' && t1 !== t0, show(first.body));
    const second = await ch.save(id, 'B', t0);
    ok(`${L} (a): the second, from the same tag, is 409 record_changed with the current tag`,
      second.status === 409 && second.body.code === 'record_changed' && second.body.tag === t1, show(second));
    ok(`${L} (a): …and the catalog's sentence for a ${ch.type}`, second.body.message === say.recordChanged(ch.type), second.body.message);
    ok(`${L} (a): the record is the first write`, (await ch.read(id)) === 'A');
    // (f) the push
    const mine = pushes.filter((p) => p.payload?.id === id);
    ok(`${L} (f): the first save pushed {projectId, type, id, tag} to readers — the refused one pushed nothing`,
      mine.length === 1 && mine[0].channel === editConflict.SAVED_CHANNEL && mine[0].payload.projectId === pid && mine[0].payload.type === ch.type && mine[0].payload.tag === t1, show(pushes));

    // (b) the reply's tag is the next base
    const again = await ch.save(id, 'C', t1);
    const reopened: string = (await ch.open(id)).body.tag;
    ok(`${L} (b): saving again from the reply's tag lands — a tab never conflicts with itself`, again.status === 200 && again.body.ok !== false, show(again.body));
    ok(`${L} (b): the reply's tag is the tag a fresh open reads`, again.body.tag === reopened, `${again.body.tag} vs ${reopened}`);

    // (c) a write that is not content
    pushes.length = 0;
    const q = await ch.quiet(id);
    ok(`${L} (c): the non-content write itself succeeds`, q.status === 200 && q.body.ok !== false, show(q.body));
    if (ch.type === 'dashboard') ok(`${L} (c): a saved-view reply carries the record's tag, unchanged`, q.body.tag === reopened, show(q.body.tag));
    ok(`${L} (c): …and pushes nothing`, pushes.length === 0, show(pushes));
    const after = await ch.save(id, 'D', reopened);
    ok(`${L} (c): a save from the tag held before it does NOT conflict`, after.status === 200 && (await ch.read(id)) === 'D', show(after));

    // (d) NEGATIVE CONTROL: no base, last writer wins
    const tx: string = (await ch.open(id)).body.tag;
    await ch.save(id, 'A', tx);
    const blind = await ch.save(id, 'B');
    ok(`${L} (d) NEGATIVE CONTROL: without base the stale save lands — last-writer-wins`, blind.status === 200 && (await ch.read(id)) === 'B', show(blind));

    // (e) the race: a write committed while the guarded save waits for the lock
    const ty: string = (await ch.open(id)).body.tag;
    const rel = `projects/${pid}/${ch.dir}/${id}.json`;
    const h = await holder(rel, (rec) => ch.mutate(rec, 'raw'));
    let landed = 0;
    const pending = ch.save(id, 'C', ty).then((r) => { landed = Date.now(); return r; });
    await sleep(400);
    const waited = landed === 0;
    await h.write();
    const raced = await pending;
    ok(`${L} (e): the guarded save waited for the record's lock`, waited);
    ok(`${L} (e): the write committed meanwhile is seen — 409, and that write stays`, raced.status === 409 && raced.body.code === 'record_changed' && (await ch.read(id)) === 'raw', show(raced));

    if (!controlDone && ch.type === 'dashboard') {
      controlDone = true;
      // The compare made BEFORE the lock (check, then act): it passes, the other write lands, then the save.
      const tz: string = (await ch.open(id)).body.tag;
      const checked = (await ch.open(id)).body.tag === tz;
      const h2 = await holder(rel, (rec) => ch.mutate(rec, 'raw2'));
      await h2.write();
      const blindAfterCheck = await ch.save(id, 'C');
      ok(`${leg} (e) NEGATIVE CONTROL: a compare outside the lock passes and the other write is lost`,
        checked && blindAfterCheck.status === 200 && (await ch.read(id)) === 'C');
    }
  }
}

async function fileLeg(): Promise<void> {
  const ALICE: Identity = { user: { email: 'alice@acme.test', role: 'admin' }, org: { id: 'default' } };
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }), undefined, () => ALICE);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
  // On files the second writer holds the in-process lock (the whole lock without a DB) and writes the file.
  const holder: Holder = async (rel, mutate) => {
    const file = await context.runInContext(ALICE, 'race', async () => path.join(appPaths.userData(), rel));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const held = context.runInContext(ALICE, 'race', () => recordFs.locked(file, async () => { entered(); await gate; }));
    await inside;
    return {
      write: async () => {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        mutate(rec);
        fs.writeFileSync(file, JSON.stringify(rec));
        release();
        await held;
      },
    };
  };
  try {
    await leg('files', caller(base), ALICE, holder);
  } finally {
    await app.close();
  }
}

async function dbLeg(adminUrl: string): Promise<void> {
  const dbName = `ordinate_conflicts_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const app = appMod.buildApp(envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  }));
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
    const BOSS: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    // A RAW session holds the record's advisory key (recordFs's own key, a bind parameter) and rewrites its row.
    const holder: Holder = async (rel, mutate) => {
      const c = new Client({ connectionString: scratch.toString() });
      await c.connect();
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`records:acme:${rel}`]);
      return {
        write: async () => {
          const row = await c.query<{ body: string }>('SELECT body FROM records WHERE org_id = $1 AND path = $2', ['acme', rel]);
          const rec = JSON.parse(row.rows[0].body);
          mutate(rec);
          await c.query('UPDATE records SET body = $1 WHERE org_id = $2 AND path = $3', [JSON.stringify(rec), 'acme', rel]);
          await c.query('COMMIT');
          await c.end();
        },
      };
    };
    await leg('db', caller(base, { 'x-forwarded-email': 'boss@acme.test' }), BOSS, holder);
    const rows = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM records WHERE org_id = 'acme' AND path LIKE 'projects/%/analyses/%'`);
    ok('db: the records are rows in Postgres, not files', Number(rows.rows[0].n) > 0, rows.rows[0].n);
  } finally {
    await app.close().catch(() => undefined);
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

void (async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  try {
    // The sentence, word for word, for the type the e2e and the banner name.
    ok('the dashboard sentence', say.recordChanged('dashboard') === 'This dashboard was changed in another tab or by someone else. Reload it, or save yours as a copy.');
    ok('the tag ignores key order and non-content fields', editConflict.contentTag('dashboard', { name: 'x', sheets: [], updatedAt: '1', views: [1] })
      === editConflict.contentTag('dashboard', { views: [2], sheets: [], name: 'x', updatedAt: '2' }));
    ok('NEGATIVE CONTROL: …but not a content change', editConflict.contentTag('dashboard', { name: 'x' }) !== editConflict.contentTag('dashboard', { name: 'y' }));
    await fileLeg();
    if (process.env.DATABASE_URL) await dbLeg(process.env.DATABASE_URL);
    else console.log('skip the edit-conflicts DB leg: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
  } catch (e) {
    ok('edit-conflicts suite ran to the end', false, e instanceof Error ? e.stack : String(e));
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  }
})();
