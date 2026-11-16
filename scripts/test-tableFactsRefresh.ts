// The `sourceTable:facts` job (src/ipc/sourceFactsRefresh.ts refreshOrgFacts; docs/assistant/00-design.md step 3,
// "Table facts"): an org's documented source tables whose facts are old are read again through the click's door
// (readFacts → src/connectors/tableFactsRun.ts), on the fake warehouse (./liveFakeConnector, its factsHook the spy).
//
//   idle       connections with no documented table: nothing is read
//   stale      a table read 30 h ago and one never read are read again, never-read first, stamped now by `jobs@system`;
//              NEGATIVE CONTROL: one read an hour ago is not
//   failing    a connection whose read fails is tried once, logged in one line without its secret (canary; NEGATIVE
//              CONTROL: the error the warehouse gave did hold it), its stored facts stay and its other tables wait;
//              the next run reads them. A connector that reads no facts is never tried
//   bound      a run starts at most FACTS_PER_RUN reads, the next run the rest; past its deadline it starts none
//   lease      with DATABASE_URL, through the real jobs table: four claimers (and the pod's own poller) race for one due
//              row, at most one wins here and each stale table is read once, by `jobs@system`. NEGATIVE CONTROL: two
//              runs with no claim read each table twice
//
// Without DATABASE_URL on the server-mode bench (./liveQueryHarness, records on disk); with it, on the row access world
// (./rowPolicyHarness: records, counters and jobs in Postgres).
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-tableFactsRefresh.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { captureLogs } from './logCapture';
import type { TableFacts } from '../src/connectors/tableFacts';
import type { Identity } from '../src/server/context';

const context: typeof import('../src/server/context') = require('../src/server/context');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const refresh: typeof import('../src/ipc/sourceFactsRefresh') = require('../src/ipc/sourceFactsRefresh');

const HOUR = 3_600_000;
const CANARY = 'pw-canary-facts-61c0';
const iso = (ms: number): string => new Date(ms).toISOString();
const FACTS = (rowEstimate: number): TableFacts => ({ columns: [{ name: 'id', type: 'INTEGER' }], rowEstimate });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Bench {
  P: string;
  org: string;
  /** As an editor of the project. */
  as<T>(fn: () => Promise<T>): Promise<T>;
}
const asJob = <T>(b: Bench, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: 'jobs@system', role: 'admin' }, org: { id: b.org } } satisfies Identity, `job:${refresh.FACTS_JOB}:${b.org}`, fn);

/** Every table the fake was asked for facts, and the secrets each read carried. */
const asked: string[] = [];
const seenSecrets: string[] = [];
let failing: RegExp | null = null;
let held: Promise<void> | null = null;
function spy(): void {
  fakeMod.fake.factsHook = async (ctx, table) => {
    asked.push(table);
    seenSecrets.push(String(ctx.secrets.password ?? ''));
    if (held) await held;
    if (failing?.test(table)) return { ok: false, error: `could not reach postgres://admin:${ctx.secrets.password}@wh.internal:5432 (password ${ctx.secrets.password} refused)` };
    return { ok: true, ...FACTS(777) };
  };
}

let noFactsCalls = 0;
const NO_FACTS_ID = 'facts-none-test';

interface Seeded { good: string; bad: string; none: string; docs: Record<string, { connId: string; docId: string }> }

async function seed(b: Bench): Promise<Seeded> {
  return b.as(async () => {
    fakeMod.registerLiveFake();
    registry.registerTestConnector({
      id: NO_FACTS_ID, label: 'No facts (tests)', family: 'test', category: 'Apps & SaaS', readOnly: true, fields: [],
      listTables: async () => { noFactsCalls += 1; return { ok: true, tables: [] }; },
      run: async () => { noFactsCalls += 1; return { ok: false, error: 'no' }; },
    });
    const conn = async (name: string, connectorId: string = fakeMod.LIVE_FAKE_ID) => {
      const c = await connections.saveConnection(b.P, { name, connectorId, values: {} });
      if (!c) throw new Error('fixture: a connection');
      await secretsIpc.storeSecrets(c.id, { password: CANARY });
      return c.id;
    };
    const s: Seeded = { good: await conn('Good'), bad: await conn('Broken'), none: await conn('Saas', NO_FACTS_ID), docs: {} };
    return s;
  });
}

async function doc(b: Bench, s: Seeded, connId: string, table: string, readAt?: number): Promise<void> {
  await b.as(async () => {
    const made = await store.createSourceDoc(b.P, connId, table, {});
    if (!made.ok) throw new Error(`fixture: a doc for ${table}`);
    s.docs[table] = { connId, docId: made.docId };
  });
  if (readAt !== undefined) await setRead(b, s, table, readAt);
}

const setRead = (b: Bench, s: Seeded, table: string, readAt: number): Promise<unknown> =>
  b.as(() => store.updateSourceDoc(b.P, s.docs[table].connId, s.docs[table].docId, (d) => ({ ...d, facts: { ...FACTS(1), readAt: iso(readAt), readBy: 'ed@acme.test' } })));
const factsOf = (b: Bench, s: Seeded, table: string) => b.as(async () => (await store.readSourceDoc(b.P, s.docs[table].connId, s.docs[table].docId))?.rec.facts);
const sorted = (xs: string[]): string => [...xs].sort().join();

async function suite(b: Bench): Promise<Seeded> {
  spy();
  const s = await seed(b);
  const idle = await asJob(b, () => refresh.refreshOrgFacts());
  ok('idle: connections with no documented table: nothing is read', idle === 0 && asked.length === 0);

  const t0 = Date.now();
  await doc(b, s, s.good, 'fresh_t', t0 - HOUR);
  await doc(b, s, s.good, 'stale_t', t0 - 30 * HOUR);
  await doc(b, s, s.good, 'never_t');
  await doc(b, s, s.bad, 'bad_old', t0 - 40 * HOUR);
  await doc(b, s, s.bad, 'bad_new');
  await doc(b, s, s.none, 'saas_t');
  failing = /^bad_/;
  const logs = captureLogs();
  let first = -1;
  try {
    first = await asJob(b, () => refresh.refreshOrgFacts());
  } finally {
    logs.restore();
  }
  const stale = await factsOf(b, s, 'stale_t');
  const never = await factsOf(b, s, 'never_t');
  ok('stale: the table read 30 h ago and the one never read are read again, never-read first; one try on the broken connection',
    first === 2 && sorted(asked) === sorted(['never_t', 'stale_t', 'bad_new']) && asked[asked.length - 1] === 'stale_t', JSON.stringify({ first, asked }));
  ok('stale: each is stored, stamped now by the jobs identity (readBy jobs@system), as the click stamps its reader',
    stale?.rowEstimate === 777 && never?.rowEstimate === 777 && stale.readBy === 'jobs@system' && never.readBy === 'jobs@system' && Date.parse(stale.readAt) >= t0, JSON.stringify({ stale, never }));
  const fresh = await factsOf(b, s, 'fresh_t');
  ok('NEGATIVE CONTROL: the table read an hour ago is not read again', !asked.includes('fresh_t') && fresh?.rowEstimate === 1 && fresh.readAt === iso(t0 - HOUR));
  const oldBad = await factsOf(b, s, 'bad_old');
  ok('failing: the broken connection\'s other table waits, and its stored facts stay', !asked.includes('bad_old') && oldBad?.rowEstimate === 1 && oldBad.readAt === iso(t0 - 40 * HOUR));
  ok('failing: a connector that reads no facts is never tried', !asked.includes('saas_t') && noFactsCalls === 0 && !(await factsOf(b, s, 'saas_t')));
  const lines = logs.lines.filter((l) => l.includes('[sourceFacts]'));
  ok('failing: one log line, naming the connection, its error redacted (no secret, no URL credentials)',
    lines.length === 1 && lines[0].startsWith('warn: ') && lines[0].includes(s.bad) && lines[0].includes('***') && !lines[0].includes(CANARY), lines.join('\n'));
  ok(`canary: no log line of the run carries the connection's secret (${logs.lines.length} lines)`, !logs.lines.some((l) => l.includes(CANARY)));
  ok('NEGATIVE CONTROL: the read did carry the secret, and the warehouse\'s error held it', seenSecrets.length === asked.length && seenSecrets.every((x) => x === CANARY));

  asked.length = 0;
  failing = null;
  const second = await asJob(b, () => refresh.refreshOrgFacts());
  ok('failing: the next run reads the broken connection\'s tables, never-read first; the fresh ones are left',
    second === 2 && asked.join() === 'bad_new,bad_old' && (await factsOf(b, s, 'bad_old'))?.rowEstimate === 777, JSON.stringify({ second, asked }));

  const many = Array.from({ length: refresh.FACTS_PER_RUN + 3 }, (_, i) => `bulk_${i}`);
  for (const t of many) await doc(b, s, s.good, t);
  asked.length = 0;
  const late = await asJob(b, () => refresh.refreshOrgFacts(Date.now() - 1));
  ok('bound: past its deadline a run starts no read', late === 0 && asked.length === 0);
  const capped = await asJob(b, () => refresh.refreshOrgFacts());
  ok(`bound: one run reads at most ${refresh.FACTS_PER_RUN}`, capped === refresh.FACTS_PER_RUN && asked.length === refresh.FACTS_PER_RUN, String(asked.length));
  const firstBatch = asked.splice(0);
  const rest = await asJob(b, () => refresh.refreshOrgFacts());
  ok('bound: the next run reads the rest, and nothing twice', rest === 3 && sorted([...firstBatch, ...asked]) === sorted(many), asked.join());
  return s;
}

// ── With a database: the lease ───────────────────────────────────────────────

async function lease(W: import('./rowPolicyHarness').World, b: Bench, s: Seeded): Promise<void> {
  const runner: typeof import('../src/server/jobs/runner') = require('../src/server/jobs/runner');
  const row = `kind = '${refresh.FACTS_JOB}' AND org_id = '${b.org}'`;
  for (let i = 0; i < 150 && (await W.pool.query(`SELECT 1 FROM jobs WHERE ${row}`)).rowCount === 0; i++) await sleep(100);
  ok(`lease: the pod inserted the org's ${refresh.FACTS_JOB} row`, (await W.pool.query(`SELECT 1 FROM jobs WHERE ${row}`)).rowCount === 1);
  const three = ['stale_t', 'never_t', 'bad_new'];
  const t0 = Date.now();
  const allFresh = async () => { for (const t of Object.keys(s.docs)) if (t !== 'saas_t') await setRead(b, s, t, t0); };
  await allFresh();
  for (const t of three) await setRead(b, s, t, t0 - 48 * HOUR);
  asked.length = 0;
  const started = new Date();
  await W.pool.query(`UPDATE jobs SET next_run_at = now() - interval '1 second', lease_owner = NULL, lease_until = NULL WHERE ${row}`);
  const claims = await Promise.all([1, 2, 3, 4].map(() => runner.claimOne(W.pool, [refresh.FACTS_JOB])));
  const won = claims.filter((c): c is NonNullable<typeof c> => c !== null);
  await Promise.all(won.map((c) => runner.runClaim(W.pool, c, W.app.log)));
  // Whoever took it — a claimer here or this pod's own poller — wait for its finish.
  const finished = async () => (await W.pool.query(`SELECT 1 FROM jobs WHERE ${row} AND last_finished_at >= $1`, [started])).rowCount === 1;
  for (let i = 0; i < 150 && !(await finished()); i++) await sleep(100);
  await sleep(200);
  ok(`lease: four concurrent claimers raced for one due row; at most one won here (${won.length})`, won.length <= 1 && (await finished()));
  ok('lease: each stale table was read exactly once', sorted(asked) === sorted(three), asked.join());
  const by = await Promise.all(three.map((t) => factsOf(b, s, t)));
  ok('lease: the real runner\'s run stamps readBy jobs@system', by.every((f) => f?.readBy === 'jobs@system' && Date.parse(f.readAt) >= t0), JSON.stringify(by.map((f) => f?.readBy)));
  ok('lease: a claim after it finished finds nothing due', (await runner.claimOne(W.pool, [refresh.FACTS_JOB])) === null);

  for (const t of three) await setRead(b, s, t, t0 - 48 * HOUR);
  asked.length = 0;
  // Each read is held until both runs have made one, so neither can store before the other has listed what is stale.
  let open: () => void = () => undefined;
  held = new Promise<void>((r) => { open = r; });
  const timer = setTimeout(() => open(), 5000);
  const realHook = fakeMod.fake.factsHook!;
  fakeMod.fake.factsHook = async (ctx, table) => {
    if (asked.length === 1) open();
    return realHook(ctx, table);
  };
  try {
    await Promise.all([asJob(b, () => refresh.refreshOrgFacts()), asJob(b, () => refresh.refreshOrgFacts())]);
  } finally {
    clearTimeout(timer);
    held = null;
    fakeMod.fake.factsHook = realHook;
  }
  ok('NEGATIVE CONTROL: the lease is what makes it once: two runs with no claim read each table twice', sorted(asked) === sorted([...three, ...three]), asked.join());
}

(async () => {
  // The encrypted store's interface over a Map, as on a server with a master key.
  const vault = new Map<string, string>();
  const useVault = () => configSecrets.useSecretStore({
    get: async (org, kind, ref) => vault.get(`${org}\u0000${kind}\u0000${ref}`) ?? null,
    put: async (org, kind, ref, value) => { vault.set(`${org}\u0000${kind}\u0000${ref}`, value); },
    delete: async (org, kind, ref) => vault.delete(`${org}\u0000${kind}\u0000${ref}`),
  });
  if (!process.env.DATABASE_URL) {
    const H: typeof import('./liveQueryHarness') = require('./liveQueryHarness');
    try {
      useVault();
      const P = await H.as(H.ORG_A, async () => {
        await H.projects.init();
        return (await H.projects.createProject('Table facts refresh')).id;
      });
      await suite({ P, org: H.ORG_A.org.id, as: (fn) => H.as(H.ORG_A, fn) });
      console.log('skip the lease: DATABASE_URL is unset (the jobs table needs Postgres)');
    } finally {
      H.cleanup();
    }
    return;
  }
  const RP: typeof import('./rowPolicyHarness') = require('./rowPolicyHarness');
  const W = await RP.world('table facts refresh');
  if (!W) return;
  try {
    useVault();
    const b: Bench = { P: W.P, org: 'acme', as: (fn) => W.as('boss', fn) };
    const s = await suite(b);
    await lease(W, b, s);
  } finally {
    fakeMod.fake.factsHook = null;
    await W.close();
  }
})()
  .catch((e) => ok('table facts refresh suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
