// Assistant conversations written at once (src/ai/copilot.ts), server mode, two members.
// Without a database every member's conversations live in ONE record, projects/<id>/copilot.json,
// so each change reads, changes and writes it inside recordFs.locked. With DATABASE_URL they are
// rows (src/ai/copilotRows.ts), and one member's writes in a project take an advisory lock:
//
//   (a) 2 members × 25 appendTurn fired at once on one project: all 50 turns kept, each
//       member one conversation holding their 25 — NEGATIVE CONTROL: the same appends
//       without the lock (recordFs.locked stubbed to a pass-through; the rows' owner lock off)
//       lose turns or split a member's into several conversations;
//   (b) a rename, a createThread and a deleteThread racing 20 more appends all land.
//
// File leg always; the rows leg with DATABASE_URL (a scratch database, dropped after).
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-copilotThreadLock.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-copilot-lock-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(TMP);
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const copilotRows: typeof import('../src/ai/copilotRows') = require('../src/ai/copilotRows');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');

type Thread = import('../src/ai/copilot').CopilotThread;
const ALICE = 'alice@acme.test';
const BOB = 'bob@acme.test';
const N = 25;
const M = 10;

let req = 0;
const as = <T>(email: string, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email, role: 'editor' }, org: { id: 'acme' } }, `r${++req}`, fn);
const texts = (threads: Thread[]): string[] => threads.flatMap((t) => t.turns.map((x) => x.text));

/** `n` appends per member, every one fired at once, each its own request. */
function race(pid: string, n: number, label: string, ids: Record<string, string | undefined> = {}): Promise<unknown> {
  return Promise.all([ALICE, BOB].flatMap((who) => Array.from({ length: n }, (_, i) =>
    as(who, () => copilot.appendTurn(pid, { role: 'user', text: `${who} ${label} ${i}` }, ids[who])))));
}

/** The two members' turns all kept, each member's in one conversation of their own. */
function intact(threads: Thread[], n: number, label: string): boolean {
  const got = texts(threads);
  return got.length === 2 * n && [ALICE, BOB].every((who) => {
    const own = threads.filter((t) => t.owner === who);
    return own.length === 1 && own[0].turns.length === n && own[0].turns.every((x) => x.text.startsWith(`${who} ${label}`));
  });
}

/** `fn` with this leg's lock out of the way: the record lock on files, the owner lock on rows. */
async function unlocked<T>(fn: () => Promise<T>): Promise<T> {
  if (copilotRows.on()) {
    copilotRows._setOwnerLock(false);
    try {
      return await fn();
    } finally {
      copilotRows._setOwnerLock(true);
    }
  }
  const real = recordFs.locked;
  (recordFs as { locked: unknown }).locked = (_p: string, f: () => Promise<unknown>) => f();
  try {
    return await fn();
  } finally {
    (recordFs as { locked: unknown }).locked = real;
  }
}

async function leg(name: string): Promise<void> {
  // (a) every turn of two members' concurrent appends is kept
  const pid = (await as(ALICE, () => projects.createProject('Chat'))).id;
  await race(pid, N, 'a');
  const all = await as(ALICE, () => copilot.loadThreads(pid));
  const got = new Set(texts(all));
  const want = [ALICE, BOB].flatMap((who) => Array.from({ length: N }, (_, i) => `${who} a ${i}`));
  ok(`${name} (a): ${2 * N} concurrent appends from two members — all kept`,
    texts(all).length === 2 * N && want.every((t) => got.has(t)), `${texts(all).length} stored`);
  for (const who of [ALICE, BOB]) {
    const own = all.filter((t) => t.owner === who);
    ok(`${name} (a): …${who} has one conversation holding all ${N} of theirs`,
      own.length === 1 && own[0].turns.length === N && own[0].turns.every((x) => x.text.startsWith(who)),
      own.map((t) => t.turns.length));
  }

  const bare = await unlocked(async () => {
    const pid = (await as(ALICE, () => projects.createProject('Bare'))).id;
    await race(pid, N, 'a');
    return as(ALICE, () => copilot.loadThreads(pid));
  });
  ok(`${name} (a) NEGATIVE CONTROL: the same appends without the lock lose turns or split conversations`,
    !intact(bare, N, 'a'), `${texts(bare).length} kept in ${bare.length} conversations`);

  // (b) the other writers hold the same lock: none of them undoes an append, or is undone by one
  const a = all.find((t) => t.owner === ALICE)?.id;
  const b = all.find((t) => t.owner === BOB)?.id;
  const doomed = await as(BOB, () => copilot.createThread(pid));
  const [, renamed, fresh, deleted] = await Promise.all([
    race(pid, M, 'b', { [ALICE]: a, [BOB]: b }),
    as(ALICE, () => copilot.renameThread(pid, a ?? '', 'Renamed')),
    as(BOB, () => copilot.createThread(pid)),
    as(BOB, () => copilot.deleteThread(pid, doomed?.id ?? '')),
  ]);
  const after = new Map((await as(ALICE, () => copilot.loadThreads(pid))).map((t) => [t.id, t]));
  ok(`${name} (b): a rename, a create and a delete racing ${2 * M} appends all land`,
    after.size === 3 && renamed?.title === 'Renamed' && after.get(a ?? '')?.title === 'Renamed'
    && after.get(a ?? '')?.turns.length === N + M && after.get(b ?? '')?.turns.length === N + M
    && !!fresh && after.has(fresh.id) && deleted && !after.has(doomed?.id ?? ''),
    [...after.values()].map((t) => `${t.owner} ${t.title} ${t.turns.length}`));
}

(async () => {
  await leg('file');
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the DB leg: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_copilot_lock_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined); // 57P01 when the database is dropped
  try {
    await mig.migrate(pool);
    recordFs.useRecordDb(pool);
    inOrg.useOrgDb(pool); // as src/server/app.ts wires both: the conversations are rows
    await leg('rows');
  } finally {
    inOrg.useOrgDb(null);
    recordFs.useRecordDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('copilot thread lock suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
