// Assistant conversations kept, paged and pruned (src/ai/copilotRows.ts `listPage` and `pruneUnused`,
// 0025_assistant_retention.sql, docs/assistant-threads/00-design.md §8), on the real app over a scratch
// database (scripts/notifyHarness.ts). Without DATABASE_URL: one skip line. Without one the file
// store keeps its cap of 50: scripts/copilotStoreChecks.ts, run by test-copilot-threads.
//
//   (a) 60 conversations of one member are all kept and page 50 + 10 over copilot:threads in the
//       index's order, with no duplicate and no gap, through updated_at ties and microsecond steps,
//       the boundary inside a tie; the pages match the whole list field by field (Object.is) —
//       NEGATIVE CONTROLS: a cursor without its tie-break, or cut to the millisecond, leaves a gap
//       the check sees;
//   (b) another member's conversations, interleaved in time, are never in those pages, and the
//       first member's cursor in their hands pages only their own; a conversation past page one
//       still opens by id with its agent (copilot:history, copilot.agentOf) — NEGATIVE CONTROL:
//       another member's id resolves to the caller's latest, whose agent agentOf never reports;
//   (c) a cursor that is not one is refused by the contract (400) before it reaches SQL;
//   (d) the org setting: unset by default; admin:saveSettings stores it, a save without it keeps it,
//       null clears it; 0 and 3651 are refused; a member who is not an admin may not set it;
//   (e) the shared sweep: unset, it deletes nothing (NEGATIVE CONTROL for the rest); set to 30 days
//       it deletes the org's conversations unused for longer, with their turns, keeps those within
//       30 days, and never another org's — control: that org's own pass deletes its old one; a
//       conversation an append holds is skipped without waiting, then goes; a backlog of 250 goes
//       in one pass of batches.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-copilotPaging.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { BOSS, ORG, show, withServer, type Identity } from './notifyHarness';

const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const copilotRows: typeof import('../src/ai/copilotRows') = require('../src/ai/copilotRows');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const sharedState: typeof import('../src/server/sharedState') = require('../src/server/sharedState');

const BEA = 'bea@acme.test';
const bea: Identity = { user: { email: BEA, role: 'editor' }, org: { id: ORG } };
const jobsOf = (org: string): Identity => ({ user: { email: 'jobs@system', role: 'admin' }, org: { id: org } });
const GLOBEX_THREAD = '00000000-0000-4000-8000-000000000777';
const AGENT = '00000000-0000-4000-8000-0000000000a9';
interface Summary { id: string; title: string; updatedAt: string; turnCount: number }

/** What is wrong with `got` against `want`: a repeat, a missing id, or the first place out of order; null when equal. */
function pageFault(got: readonly string[], want: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const x of got) {
    if (seen.has(x)) return `duplicate ${x}`;
    seen.add(x);
  }
  for (const x of want) if (!seen.has(x)) return `gap: ${x} missing`;
  for (let i = 0; i < want.length; i++) if (!Object.is(got[i], want[i])) return `out of order at ${i}`;
  return got.length === want.length ? null : `${got.length - want.length} extra`;
}

const ids = (list: readonly Summary[]): string[] => list.map((t) => t.id);

withServer('copilot-paging', {}, async (b) => {
  const boss = b.as('boss');
  await b.provision('bea');

  // ── (a) 60 conversations, two pages ───────────────────────────────────────
  const pid = (await b.run(BOSS, () => projects.createProject('Many conversations'))).id;
  await b.share(pid, 'bea', 'viewer');
  for (let i = 0; i < 60; i++) await b.run(BOSS, () => copilot.createThread(pid));
  for (let i = 0; i < 5; i++) await b.run(bea, () => copilot.createThread(pid));
  // Each member's k-th conversation: second k / 7, plus (k % 7) / 2 microseconds — pairs tie on
  // updated_at, steps of 1 µs between them, and Bea's five sit among the boss's first seven.
  await b.pool.query(
    `UPDATE assistant_threads t
        SET updated_at = timestamptz '2026-10-01 12:00:00Z' + (n.k / 7) * interval '1 second' + (n.k % 7 / 2) * interval '1 microsecond'
       FROM (SELECT id, (row_number() OVER (PARTITION BY owner ORDER BY touched) - 1)::int AS k FROM assistant_threads WHERE project_id = $1) n
      WHERE t.project_id = $1 AND t.id = n.id`,
    [pid],
  );
  const order = async (owner: string): Promise<string[]> => (await b.pool.query<{ id: string }>(
    'SELECT id::text FROM assistant_threads WHERE org_id = $1 AND project_id = $2 AND owner = $3 ORDER BY updated_at DESC, touched DESC',
    [ORG, pid, owner],
  )).rows.map((r) => r.id);
  const want = await order(BOSS.user.email);
  ok('paging: control — all 60 of one member\'s conversations are kept (no cap of 50)', want.length === 60, want.length);

  const one = (await boss.call('copilot:threads', { projectId: pid })).body;
  const two = (await boss.call('copilot:threads', { projectId: pid, cursor: one.next })).body;
  const got = [...one.threads, ...two.threads] as Summary[];
  ok('paging: page one is 50 with a cursor, page two the other 10 with none after',
    one.ok && one.threads.length === 50 && typeof one.next === 'string' && two.ok && two.threads.length === 10 && two.next === null,
    show([one.threads?.length, one.next, two.threads?.length, two.next]));
  ok('paging: the two pages are the index\'s order exactly — no duplicate, no gap', pageFault(ids(got), want) === null, pageFault(ids(got), want));
  const tie = (await b.pool.query<{ same: boolean }>(
    'SELECT count(DISTINCT updated_at) = 1 AND count(*) = 2 AS same FROM assistant_threads WHERE project_id = $1 AND id = ANY($2::uuid[])',
    [pid, [one.threads.at(-1).id, two.threads[0].id]],
  )).rows[0].same;
  ok('paging: control — the page boundary falls inside an updated_at tie', tie);
  const all = await b.run(BOSS, () => copilot.listThreads(pid));
  const field = all.length === got.length && all.every((t, i) => (['id', 'title', 'updatedAt', 'turnCount'] as const).every((k) => Object.is(t[k], got[i][k])));
  ok('paging: the pages equal the whole list, every field (Object.is)', field, show([all[0], got[0]]));

  const [at, touched] = String(one.next).split('.');
  const after = async (cursor: string): Promise<string | null> =>
    pageFault([...ids(one.threads), ...ids((await boss.call('copilot:threads', { projectId: pid, cursor })).body.threads)], want);
  const noTie = await after(`${at}.0`);
  ok('paging NEGATIVE CONTROL: a cursor without its tie-break skips the rest of the tie, and the check sees the gap', noTie?.startsWith('gap') === true, noTie);
  const msOnly = await after(`${(BigInt(at) / 1000n) * 1000n}.${touched}`);
  ok('paging NEGATIVE CONTROL: a cursor cut to the millisecond loses the microsecond step, and the check sees the gap', msOnly?.startsWith('gap') === true, msOnly);

  // ── (b) another member ────────────────────────────────────────────────────
  const beas = await order(BEA);
  ok('paging: none of Bea\'s five (interleaved in time) is in the boss\'s pages', beas.length === 5 && !got.some((t) => beas.includes(t.id)));
  const beaPage = (await b.as('bea').call('copilot:threads', { projectId: pid })).body;
  ok('paging: Bea\'s list is her five in order, one page', beaPage.ok && beaPage.next === null && pageFault(ids(beaPage.threads), beas) === null, show(beaPage));
  const borrowed = (await b.as('bea').call('copilot:threads', { projectId: pid, cursor: one.next })).body;
  ok('paging: the boss\'s cursor in Bea\'s hands pages her own conversations only',
    borrowed.ok && borrowed.threads.length > 0 && (borrowed.threads as Summary[]).every((t) => beas.includes(t.id)), show(borrowed));
  // Past page one: found by one lookup, never by scanning the list (an ask, a follow-up and a plan take its agent).
  const oldest = want[59];
  await b.pool.query('UPDATE assistant_threads SET agent_id = $2 WHERE project_id = $1 AND id IN ($3, $4)', [pid, AGENT, oldest, want[0]]);
  const hist = (await boss.call('copilot:history', { projectId: pid, threadId: oldest })).body;
  ok('paging: the 60th conversation, past page one, opens by id (copilot:history names it, not the latest)', hist.ok && hist.threadId === oldest, show([hist.threadId, oldest]));
  ok('paging: …and agentOf gives its agent', (await b.run(BOSS, () => copilot.agentOf(pid, oldest))) === AGENT);
  const stranger = await b.run(BOSS, () => copilot.threadFor(pid, beas[0]));
  ok('paging NEGATIVE CONTROL: another member\'s id resolves to the caller\'s latest, which has an agent…', stranger?.id === want[0] && stranger.agentId === AGENT, show(stranger));
  ok('paging: …and agentOf never reports it for that id', (await b.run(BOSS, () => copilot.agentOf(pid, beas[0]))) === undefined);
  await b.pool.query('UPDATE assistant_threads SET agent_id = NULL WHERE project_id = $1', [pid]);

  // ── (c) a cursor that is not one ──────────────────────────────────────────
  const bad = await boss.call('copilot:threads', { projectId: pid, cursor: "1.2' OR true --" });
  ok('paging: a cursor that is not one is refused by the contract (400)', bad.status === 400, show([bad.status, bad.text]));

  // ── (d) the org setting ───────────────────────────────────────────────────
  const settings = async (): Promise<{ assistantRetentionDays: number | null }> => (await boss.call('admin:settings')).body;
  const save = (extra: object) => boss.call('admin:saveSettings', { publicLinks: false, uploadCapMb: null, ...extra });
  ok('retention: unset by default — conversations are kept', (await settings()).assistantRetentionDays === null);

  // ── (e) the sweep ─────────────────────────────────────────────────────────
  const rpid = (await b.run(BOSS, () => projects.createProject('Retention'))).id;
  const old = (await b.run(BOSS, () => copilot.createThread(rpid)))!.id;
  for (const text of ['q1', 'q2', 'q3']) await b.run(BOSS, () => copilot.appendTurn(rpid, { role: 'user', text }, old));
  const within = (await b.run(BOSS, () => copilot.createThread(rpid)))!.id;
  const fresh = (await b.run(BOSS, () => copilot.createThread(rpid)))!.id;
  const held = (await b.run(BOSS, () => copilot.createThread(rpid)))!.id;
  const age = (tid: string, days: number) =>
    b.pool.query(`UPDATE assistant_threads SET updated_at = now() - $3 * interval '1 day' WHERE project_id = $1 AND id = $2`, [rpid, tid, days]);
  await age(old, 31);
  await age(within, 29);
  await age(held, 40);
  await b.pool.query(`INSERT INTO orgs (id, name) VALUES ('globex', 'Globex') ON CONFLICT DO NOTHING`);
  await b.pool.query(`INSERT INTO org_settings (org_id, assistant_retention_days) VALUES ('globex', 30)`);
  await b.pool.query(
    `INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at) VALUES ('globex', $1, $1, 'g@globex.test', 't', now() - interval '400 days', now() - interval '400 days')`,
    [GLOBEX_THREAD],
  );
  const exists = async (org: string, tid: string): Promise<boolean> => (await b.pool.query('SELECT 1 FROM assistant_threads WHERE org_id = $1 AND id = $2', [org, tid])).rowCount === 1;
  const turnsOf = async (tid: string): Promise<number> =>
    (await b.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_turns WHERE org_id = $1 AND thread_id = $2', [ORG, tid])).rows[0].n;

  await b.run(jobsOf(ORG), () => sharedState.sweepOrg(b.pool));
  ok('retention NEGATIVE CONTROL: unset, the sweep deletes nothing — not even one unused for 31 days', await exists(ORG, old));

  ok('retention: admin:saveSettings stores 30 days', (await save({ assistantRetentionDays: 30 })).body?.ok === true && (await settings()).assistantRetentionDays === 30);
  ok('retention: a save without the field keeps it', (await save({})).body?.ok === true && (await settings()).assistantRetentionDays === 30);
  const [zero, big] = [await save({ assistantRetentionDays: 0 }), await save({ assistantRetentionDays: 3651 })];
  ok('retention: 0 and 3651 days are refused (400)', zero.status === 400 && big.status === 400, show([zero.status, big.status]));
  const member = await b.as('bea').call('admin:saveSettings', { publicLinks: false, uploadCapMb: null, assistantRetentionDays: 1 });
  ok('retention: a member who is not an admin may not set it (403)', member.status === 403 && (await settings()).assistantRetentionDays === 30, member.status);

  ok('retention: control — the old conversation has its 3 turns', (await turnsOf(old)) === 3);
  // An append in flight holds its conversation (`FOR UPDATE`): the sweep passes it by, never waits.
  const append = await b.pool.connect();
  try {
    await append.query('BEGIN');
    await append.query('SELECT 1 FROM assistant_threads WHERE project_id = $1 AND id = $2 FOR UPDATE', [rpid, held]);
    const started = Date.now();
    await b.run(jobsOf(ORG), () => sharedState.sweepOrg(b.pool));
    ok('retention: the sweep never waits on a conversation an append holds', Date.now() - started < 5_000 && (await exists(ORG, held)), Date.now() - started);
  } finally {
    await append.query('COMMIT').catch(() => undefined);
    append.release();
  }
  ok('retention: the sweep deletes a conversation unused for 31 days, with its turns', !(await exists(ORG, old)) && (await turnsOf(old)) === 0);
  ok('retention: …keeps one unused for 29 days and a fresh one', (await exists(ORG, within)) && (await exists(ORG, fresh)));
  ok('retention: …and never another org\'s, however old', await exists('globex', GLOBEX_THREAD));
  await b.run(jobsOf('globex'), () => copilotRows.pruneUnused('globex'));
  ok('retention: control — globex\'s own pass deletes it (the org kept it, nothing else)', !(await exists('globex', GLOBEX_THREAD)));
  await b.run(jobsOf(ORG), () => sharedState.sweepOrg(b.pool));
  ok('retention: the conversation the append held goes on the next pass', !(await exists(ORG, held)));

  await b.pool.query(
    `INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at)
     SELECT $1, $2, gen_random_uuid(), $3, 'old', now() - interval '90 days', now() - interval '90 days' FROM generate_series(1, 250)`,
    [ORG, rpid, BOSS.user.email],
  );
  const gone = await b.run(jobsOf(ORG), () => copilotRows.pruneUnused(ORG));
  const left = (await b.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM assistant_threads WHERE project_id = $1 AND title = 'old'`, [rpid])).rows[0].n;
  ok('retention: a backlog of 250 goes in one pass (batches of 100)', gone === 250 && left === 0, show([gone, left]));

  ok('retention: null clears it, back to keeping every conversation', (await save({ assistantRetentionDays: null })).body?.ok === true && (await settings()).assistantRetentionDays === null);
  await age(fresh, 400);
  await b.run(jobsOf(ORG), () => sharedState.sweepOrg(b.pool));
  ok('retention: …and the sweep deletes nothing again', (await exists(ORG, fresh)) && (await exists(ORG, within)));
})
  .catch((e) => ok('copilot paging suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
