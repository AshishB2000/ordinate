// Assistant conversations under the record lock (src/ai/copilot.ts). Every member's
// conversations live in ONE record, projects/<id>/copilot.json, so each change reads,
// changes and writes it inside recordFs.locked (every pod) — server mode, two members:
//
//   (a) 2 members × 25 appendTurn fired at once on one project: all 50 turns kept, each
//       member one conversation holding their 25 — NEGATIVE CONTROL: the same appends
//       with recordFs.locked stubbed to a pass-through lose some;
//   (b) a rename, a createThread and a deleteThread racing 20 more appends all land.
//
// File leg always; the same on Postgres with DATABASE_URL (a scratch database, dropped after).
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

  const real = recordFs.locked;
  (recordFs as { locked: unknown }).locked = (_p: string, fn: () => Promise<unknown>) => fn();
  let lost = 0;
  try {
    const bare = (await as(ALICE, () => projects.createProject('Bare'))).id;
    await race(bare, N, 'a');
    lost = 2 * N - texts(await as(ALICE, () => copilot.loadThreads(bare))).length;
  } finally {
    (recordFs as { locked: unknown }).locked = real;
  }
  ok(`${name} (a) NEGATIVE CONTROL: the same appends with the lock stubbed out lose some (${lost} of ${2 * N})`, lost > 0);

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
    await leg('db');
  } finally {
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
