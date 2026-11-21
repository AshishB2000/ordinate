// Evaluation suites: the Postgres store (0045_evals.sql). As an ORDINARY role (a superuser skips RLS, so the other suites cannot see it)
// with a password (CI's Postgres asks for one): forced row-level security by org and by the system scope; the 100-case cap under
// concurrent adds; the suite cap; one active run per project; the lease, the heartbeat and the fence (a late write from the old owner
// applies nothing); 2 runs per pod; a result once per case; the hidden conversation; and the sweep.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-evalStore.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { evalWorld, sleep } from './evalHarness';

const store: typeof import('../src/server/evals/db') = require('../src/server/evals/db');
const worker: typeof import('../src/server/evals/worker') = require('../src/server/evals/worker');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const hidden: typeof import('../src/server/evals/thread') = require('../src/server/evals/thread');
const checks: typeof import('../src/ai/evalChecks') = require('../src/ai/evalChecks');

(async () => {
  const S = await evalWorld('eval store');
  if (!S) return;
  const { W } = S;
  try {
    const R = await S.ordinary();
    store.useEvalsDb(R);
    const P = W.P;
    const say = checks.sanitizeExpect({ say: 'x' })!;
    const suiteOf = async (org: string, name: string) => (await store.createSuite(org, { id: randomUUID(), projectId: P, name, agentId: null, by: 'ed@acme.test' }))!;

    // ── forced RLS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
    const mine = await suiteOf('acme', 'Mine');
    await W.pool.query(`INSERT INTO eval_suites (org_id, project_id, id, name, created_by) VALUES ('other', $1, $2, 'Theirs', 'o@other.test')`, [P, randomUUID()]);
    await W.pool.query(`INSERT INTO assistant_feedback (org_id, project_id, turn_id, thread_id, owner, value) VALUES ('acme', $1, 't1', $2, 'ed@acme.test', 'up'), ('other', $1, 't2', $2, 'o@other.test', 'up')`, [P, randomUUID()]);
    const count = async (table: string, settings: Record<string, string>): Promise<number> => {
      const c = await R.connect();
      try {
        await c.query('BEGIN');
        for (const [k, v] of Object.entries(settings)) await c.query('SELECT set_config($1, $2, true)', [k, v]);
        const n = Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
        await c.query('ROLLBACK');
        return n;
      } finally { c.release(); }
    };
    ok('RLS: a statement with no scope sees no suite and no thumb', (await count('eval_suites', {})) === 0 && (await count('assistant_feedback', {})) === 0);
    ok('RLS: the org\'s scope sees its own and not another org\'s', (await count('eval_suites', { 'ordinate.org': 'acme' })) === 1 && (await count('eval_suites', { 'ordinate.org': 'other' })) === 1 && (await count('assistant_feedback', { 'ordinate.org': 'acme' })) === 1);
    ok('RLS: the system scope sees every org\'s suites', (await count('eval_suites', { 'ordinate.evals_scope': 'system' })) === 2);
    ok('RLS (negative control): the thumbs have no system scope, and another scope name is not it', (await count('assistant_feedback', { 'ordinate.evals_scope': 'system' })) === 0 && (await count('eval_suites', { 'ordinate.research_scope': 'system' })) === 0 && (await count('eval_suites', { 'ordinate.evals_scope': 'acme' })) === 0);
    const c = await R.connect();
    let refused = false;
    try {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['ordinate.org', 'acme']);
      await c.query(`INSERT INTO eval_suites (org_id, project_id, id, name, created_by) VALUES ('other', $1, $2, 'planted', 'x')`, [P, randomUUID()]);
    } catch { refused = true; } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    ok('RLS: an org cannot write another org\'s row (WITH CHECK)', refused);

    // ── the caps ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const adds = await Promise.all(Array.from({ length: 110 }, (_, i) => store.addCase('acme', P, mine.id, { id: randomUUID(), question: `q${i}`, expect: say, source: 'typed', by: 'ed@acme.test' })));
    ok('cap: 110 concurrent adds leave exactly 100 cases (the suite row\'s lock), 10 told "full"', adds.filter((a) => a === 'ok').length === 100 && adds.filter((a) => a === 'full').length === 10 && (await store.listCases('acme', P, mine.id)).length === 100, JSON.stringify(adds.filter((a) => a !== 'ok')));
    ok('cap: the 101st, one at a time, is refused', (await store.addCase('acme', P, mine.id, { id: randomUUID(), question: 'one more', expect: say, source: 'typed', by: 'ed' })) === 'full');
    ok('cap: a new suite has room (the cap is per suite)', (await store.addCase('acme', P, (await suiteOf('acme', 'Second')).id, { id: randomUUID(), question: 'q', expect: say, source: 'typed', by: 'ed' })) === 'ok');
    ok('cap: a suite that does not exist is "gone", never a row for nobody', (await store.addCase('acme', P, randomUUID(), { id: randomUUID(), question: 'q', expect: say, source: 'typed', by: 'ed' })) === 'gone');
    let made = 2;
    while (made < store.MAX_SUITES) { await suiteOf('acme', `S${made}`); made += 1; }
    ok('cap: the project\'s 51st suite is refused', (await store.createSuite('acme', { id: randomUUID(), projectId: P, name: 'one more', agentId: null, by: 'ed' })) === null);
    ok('a case that damaged its expectation is skipped on read, never fatal', await (async () => {
      await W.pool.query(`INSERT INTO eval_cases (org_id, project_id, suite_id, id, position, question, expect, source, created_by) VALUES ('acme', $1, $2, $3, 999, 'bad', '{"compute":{"nope":1}}', 'typed', 'x')`, [P, mine.id, randomUUID()]);
      return (await store.listCases('acme', P, mine.id)).length === 100;
    })());

    // ── runs: one per project, the lease and the fence ──────────────────────────────────────────────────────────────────────
    const ids = (await store.listCases('acme', P, mine.id)).slice(0, 4).map((x) => x.id);
    const mk = (suiteId: string, caseIds: string[] = ids) => ({ id: randomUUID(), orgId: 'acme', projectId: P, suiteId, agentId: null, startedBy: 'ed@acme.test', caseIds, version: {} });
    const [a, b] = await Promise.all([store.insertRun(mk(mine.id)), store.insertRun(mk(mine.id))]);
    ok('one active run per project: of two at once, one is queued and one refused', a !== b);
    const run = (await store.listRuns('acme', P))[0];
    ok('deleting a suite with a run going is refused; its cases stay', (await store.deleteSuite('acme', P, mine.id)) === false && (await store.listCases('acme', P, mine.id)).length === 100);
    const owner1 = 'pod-a/1/aaaa';
    const claimed = await store.claim(owner1, 250);
    ok('claim: the queued run, running, with an attempt counted', claimed?.id === run.id && claimed.state === 'running' && claimed.attempts === 1);
    ok('claim: nothing else is due while its lease holds', (await store.claim('pod-b/2/bbbb', 250)) === null);
    const res = (n: number) => ({ caseId: ids[n], position: n + 1, question: 'q', outcome: 'pass' as const, checks: [], judged: { state: 'none' as const }, calls: 1, errorCode: null, reply: 'REPLY_CANARY', why: null, datasetIds: [] });
    ok('result: the lease\'s holder stores one, and the run\'s counts follow', (await store.recordResult('acme', run.id, owner1, res(0))) === true && (await store.getRun('acme', run.id))?.casesDone === 1 && (await store.getRun('acme', run.id))?.passed === 1);
    await store.recordResult('acme', run.id, owner1, res(0));
    ok('result: once per case — a repeat changes nothing', (await store.resultsOf('acme', run.id)).length === 1 && (await store.getRun('acme', run.id))?.modelCalls === 1);
    ok('result: a stranger\'s write is fenced out', (await store.recordResult('acme', run.id, 'someone-else', res(1))) === false && (await store.resultsOf('acme', run.id)).length === 1);
    await sleep(350);
    ok('claim: after the lease lapses another pod retakes it (attempt 2)', (await store.claim('pod-b/2/bbbb', 60_000))?.attempts === 2);
    ok('NEGATIVE CONTROL (the fence): the old owner\'s result, heartbeat and finish apply nothing', (await store.recordResult('acme', run.id, owner1, res(2))) === false && (await store.heartbeat('acme', run.id, owner1)) === false && (await store.finish('acme', run.id, owner1, 'done', null)) === false && (await store.getRun('acme', run.id))?.state === 'running');
    ok('the new owner\'s heartbeat and finish do', (await store.heartbeat('acme', run.id, 'pod-b/2/bbbb')) === true && (await store.finish('acme', run.id, 'pod-b/2/bbbb', 'done', null)) === true && (await store.getRun('acme', run.id))?.state === 'done');
    ok('the project is free again once it ends', await store.insertRun(mk(mine.id)));
    const stopping = (await store.listRuns('acme', P))[0];
    await store.requestStop('acme', stopping.id);
    ok('stop: a queued run stops at once', (await store.getRun('acme', stopping.id))?.state === 'stopped');
    const failing = mk(mine.id);
    await store.insertRun(failing);
    for (let i = 0; i < store.MAX_ATTEMPTS; i++) { await store.claim(`pod-${i}`, 30); await sleep(60); }
    ok('a run that keeps dying is failed after MAX_ATTEMPTS, resumable, so nobody waits', (await store.failExhausted()).some((r) => r.id === failing.id) && (await store.getRun('acme', failing.id))?.errorCode === 'gave_up');
    ok('resume: a failed run is queued again with a fresh time allowance', (await store.requeue('acme', failing.id)) === true && (await store.getRun('acme', failing.id))?.state === 'queued');
    ok('resume: a done run is not resumable', (await store.requeue('acme', run.id)) === false);
    await store.requestStop('acme', failing.id);

    // ── two runs per pod ────────────────────────────────────────────────────────────────────────────────────────────────────
    let queued = 0;
    await W.pool.query(`UPDATE eval_runs SET state = 'stopped' WHERE org_id = 'acme' AND state IN ('queued', 'running')`);
    // different projects: the unique index is per project, so three more projects each queue one
    const projects: string[] = [];
    for (let i = 0; i < 3; i++) projects.push((await W.call('boss', 'projects:create', { name: `P${i}` })).body.id);
    for (const p of projects) {
      const s = (await store.createSuite('acme', { id: randomUUID(), projectId: p, name: 's', agentId: null, by: 'ed' }))!;
      await store.addCase('acme', p, s.id, { id: randomUUID(), question: 'q', expect: say, source: 'typed', by: 'ed' });
      if (await store.insertRun({ ...mk(s.id, []), projectId: p })) queued += 1;
    }
    worker.pauseForTest(false);
    worker.tuneForTest({ pollMs: 20, leaseMs: 60_000 });
    const w = worker.latestForTest();
    const started = (await w?.tick()) ?? 0;
    worker.pauseForTest(true);
    ok('worker: a pod claims at most 2 of the 3 queued runs at once', queued === 3 && started === store.PER_POD, `${queued} ${started}`);
    await sleep(300);

    // ── the hidden conversation ─────────────────────────────────────────────────────────────────────────────────────────────
    const T = await W.as('ed', async () => {
      const visible = await copilot.createThread(P);
      const id = await hidden.createHidden(P, null);
      await copilot.appendTurn(P, { role: 'user', text: 'A question typed in a hidden thread' }, id!);
      return { visible: visible!.id, hidden: id! };
    });
    const seen = await W.as('ed', async () => ({ list: (await copilot.listThreadsPage(P)).threads.map((x) => x.id), latest: (await copilot.threadFor(P))?.id, named: (await copilot.threadFor(P, T.hidden))?.id, hist: (await copilot.loadHistory(P, T.hidden)).length }));
    ok('hidden: in no list and never the latest, yet found by its own id, with its turns', !seen.list.includes(T.hidden) && seen.latest === T.visible && seen.named === T.hidden && seen.hist === 1, JSON.stringify(seen));
    ok('NEGATIVE CONTROL: an ordinary conversation, made after it, is listed and is the latest', seen.list.includes(T.visible));
    const asked = await W.call('ed', 'copilot:threads', { projectId: P });
    ok('hidden: the RPC list leaves it out too', !asked.body.threads.some((x: { id: string }) => x.id === T.hidden));

    // ── the sweep ───────────────────────────────────────────────────────────────────────────────────────────────────────────
    await W.pool.query(`UPDATE assistant_threads SET updated_at = now() - interval '2 hours' WHERE id = $1`, [T.hidden]);
    const old = await W.as('ed', async () => (await copilot.createThread(P))!.id);
    await W.pool.query(`UPDATE assistant_threads SET updated_at = now() - interval '2 hours' WHERE id = $1`, [old]);
    const turn = (await W.pool.query<{ id: string }>(`SELECT id::text FROM assistant_turns WHERE thread_id = $1`, [T.hidden])).rows[0].id;
    await W.pool.query(`INSERT INTO assistant_feedback (org_id, project_id, turn_id, thread_id, owner, value, question) VALUES ('acme', $1, $2, $3, 'ed@acme.test', 'down', 'kept while its turn lives'), ('acme', $1, 'gone-turn', $4, 'ed@acme.test', 'down', 'goes with its conversation'), ('acme', $1, 'gone-owner', $4, 'left@acme.test', 'down', 'goes with its person')`, [P, turn, T.hidden, randomUUID()]);
    const swept = await store.sweep('acme');
    const left = async (sql: string, args: unknown[]) => (await W.pool.query(sql, args)).rowCount;
    ok('sweep: a hidden conversation a crash left is deleted', swept.threads === 1 && (await left('SELECT 1 FROM assistant_threads WHERE id = $1', [T.hidden])) === 0);
    ok('NEGATIVE CONTROL: an ordinary old conversation is kept', (await left('SELECT 1 FROM assistant_threads WHERE id = $1', [old])) === 1);
    const qs = (await W.pool.query<{ turn_id: string; question: string | null }>(`SELECT turn_id, question FROM assistant_feedback WHERE value = 'down' ORDER BY turn_id`)).rows;
    ok('sweep: a thumbs-down\'s question goes when its conversation (or its person) is gone; the count stays', qs.find((x) => x.turn_id === 'gone-turn')?.question === null && qs.find((x) => x.turn_id === 'gone-owner')?.question === null && swept.questions >= 2);
    const live = await W.as('ed', async () => {
      const t = (await copilot.createThread(P))!.id;
      const turns = await copilot.appendTurn(P, { role: 'assistant', text: 'ok' }, t);
      return { t, turn: turns![0].id };
    });
    await W.pool.query(`INSERT INTO assistant_feedback (org_id, project_id, turn_id, thread_id, owner, value, question) VALUES ('acme', $1, $2, $3, 'ed@acme.test', 'down', 'still here')`, [P, live.turn, live.t]);
    await store.sweep('acme');
    ok('sweep: a thumbs-down on a live turn keeps its question', (await W.pool.query<{ question: string }>(`SELECT question FROM assistant_feedback WHERE turn_id = $1`, [live.turn])).rows[0].question === 'still here');
    // runs past 30 a suite
    const s2 = (await store.createSuite('acme', { id: randomUUID(), projectId: projects[0], name: 'many', agentId: null, by: 'ed' }))!;
    for (let i = 0; i < 35; i++) await W.pool.query(`INSERT INTO eval_runs (org_id, project_id, id, suite_id, started_by, state, started_at) VALUES ('acme', $1, $2, $3, 'ed', 'done', now() - ($4 || ' minutes')::interval)`, [projects[0], randomUUID(), s2.id, String(i + 1)]);
    ok('sweep: the oldest runs past 30 of a suite go', (await store.sweep('acme')).runs === 5 && (await store.listRuns('acme', projects[0], s2.id, 100)).length === 30);

    // ── the judge setting ───────────────────────────────────────────────────────────────────────────────────────────────────
    await store.saveJudge('acme', { provider: 'anthropic', model: 'm1' });
    await store.saveJudge('acme', { provider: 'openai', model: 'm2' });
    ok('judge: one row per org, saved and replaced; none by default for another org', (await store.judgePick('acme'))?.model === 'm2' && (await store.judgePick('other')) === null);
    await store.saveJudge('acme', null);
    ok('judge: cleared, the Assistant\'s own again', (await store.judgePick('acme')) === null);
  } finally {
    await S.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
