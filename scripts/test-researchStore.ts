// Deep research: the Postgres store (0043_research.sql). As an ORDINARY role (a superuser skips RLS, so the other suites cannot
// see it) with a password (CI's Postgres asks for one): forced row-level security by org and by the system scope; the lease, the
// heartbeat and the fence (a retake after an expired lease, and a late finish from the old owner applies nothing); one active run
// per person; 2 runs per pod; the stop flag, resume, the limits and the sweep.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-researchStore.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { researchWorld, sleep, until, answerStep } from './researchHarness';

const store: typeof import('../src/server/research/db') = require('../src/server/research/db');
const worker: typeof import('../src/server/research/worker') = require('../src/server/research/worker');

(async () => {
  const S = await researchWorld('research store');
  if (!S) return;
  const { W } = S;
  try {
    const R = await S.ordinary();
    store.useResearchDb(R);
    const P = W.P;
    const mk = (org: string, by: string) => ({ id: randomUUID(), orgId: org, projectId: P, startedBy: by, agentId: null, threadId: randomUUID(), question: 'why?' });

    // ── forced RLS ──────────────────────────────────────────────────────────────────────────────────────────────
    const a = mk('acme', 'ed@acme.test');
    const b = mk('other', 'o@other.test');
    ok('insert: a run is queued', (await store.insertRun(a)) === true);
    await W.pool.query(`INSERT INTO research_runs (org_id, project_id, id, started_by, thread_id, question) VALUES ($1, $2, $3, $4, $5, 'theirs')`, [b.orgId, P, b.id, b.startedBy, b.threadId]);
    const count = async (settings: Record<string, string>): Promise<number> => {
      const c = await R.connect();
      try {
        await c.query('BEGIN');
        for (const [k, v] of Object.entries(settings)) await c.query('SELECT set_config($1, $2, true)', [k, v]);
        const n = Number((await c.query('SELECT count(*) AS n FROM research_runs')).rows[0].n);
        await c.query('ROLLBACK');
        return n;
      } finally { c.release(); }
    };
    ok('RLS: a statement with no scope sees no row', (await count({})) === 0);
    ok('RLS: the org\'s scope sees its own run and not another org\'s', (await count({ 'ordinate.org': 'acme' })) === 1 && (await count({ 'ordinate.org': 'other' })) === 1);
    ok('RLS: the system scope sees every org\'s', (await count({ 'ordinate.research_scope': 'system' })) === 2);
    ok('RLS (negative control): another scope name is not the system scope', (await count({ 'ordinate.slack_scope': 'system' })) === 0 && (await count({ 'ordinate.research_scope': 'acme' })) === 0);
    const c = await R.connect();
    let refused = false;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('ordinate.org', 'acme', true)`);
      await c.query(`INSERT INTO research_runs (org_id, project_id, id, started_by, thread_id, question) VALUES ('other', $1, $2, 'x', $3, 'x')`, [P, randomUUID(), randomUUID()]);
    } catch (e) { refused = /row-level security/.test((e as Error).message); } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    ok('RLS: a write for another org is refused by the policy', refused);
    ok('RLS: the limits table is under it too', (await store.limitsOf('other')).steps === 8 && (await store.saveLimits('acme', { steps: 5, queries: 6, minutes: 7 })) && (await store.limitsOf('acme')).steps === 5 && (await store.limitsOf('other')).steps === 8);
    await W.pool.query(`DELETE FROM research_runs WHERE org_id = 'other'`);

    // ── one active run per person ────────────────────────────────────────────────────────────────────────────────
    ok('one per person: a second queued run for the same person is refused', (await store.insertRun(mk('acme', 'ed@acme.test'))) === false);
    const boss = mk('acme', 'boss@acme.test');
    ok('one per person: another person may have one', (await store.insertRun(boss)) === true);
    ok('one per person: the first run is untouched', (await store.getRun('acme', a.id))?.state === 'queued');

    // ── the lease, the heartbeat and the fence ───────────────────────────────────────────────────────────────────────────
    const first = await store.claim('podA', 300);
    ok('claim: the oldest queued run goes to the first pod, running, one attempt', first?.id === a.id && first.state === 'running' && first.attempts === 1, JSON.stringify(first));
    const second = await store.claim('podB', 300);
    ok('claim: the second pod gets the OTHER run, never the held one (SKIP LOCKED / the lease)', second?.id === boss.id && (await store.claim('podC', 300)) === null);
    ok('heartbeat: the holder renews; another owner cannot', (await store.heartbeat('acme', a.id, 'podA', 300)) === true && (await store.heartbeat('acme', a.id, 'podB', 300)) === false);
    await sleep(450);
    const retaken = await store.claim('podC', 5000);
    ok('retake: after the lease lapsed another pod takes it (attempt 2), the stored state kept', retaken?.id === a.id && retaken.attempts === 2 && retaken.state === 'running');
    const step = [{ n: 1, kind: 'answer' as const, title: 't', status: 'done' as const, facts: 'f', ledger: [] }];
    ok('fence: the old owner\'s heartbeat, steps, plan, deadline, writing and finish all match no row', !(await store.heartbeat('acme', a.id, 'podA', 300))
      && !(await store.saveSteps('acme', a.id, 'podA', step, 1, 1)) && !(await store.savePlan('acme', a.id, 'podA', ['x'])) && !(await store.setWriting('acme', a.id, 'podA'))
      && !(await store.finish('acme', a.id, 'podA', 'done', null, null)) && (await store.getRun('acme', a.id))?.state === 'running' && (await store.getRun('acme', a.id))?.steps.length === 0);
    ok('fence (negative control): the new owner\'s writes apply', (await store.saveSteps('acme', a.id, 'podC', step, 1, 1)) && (await store.getRun('acme', a.id))?.steps.length === 1);
    ok('flags: the holder reads its stop flag and that it still holds the run', JSON.stringify(await store.flags('acme', a.id, 'podC')) === '{"stop":false,"held":true}' && (await store.flags('acme', a.id, 'podA')).held === false);
    const left = await store.setDeadline('acme', a.id, 'podC', 600_000);
    ok('deadline: set once, ~10 minutes left; a retake keeps it (never extended)', left > 590_000 && left <= 600_000 && (await store.setDeadline('acme', a.id, 'podC', 1_000)) > 500_000);
    ok('finish: the owner ends it, the lease is cleared', (await store.finish('acme', a.id, 'podC', 'partial', 'steps', null)) && (await store.getRun('acme', a.id))?.state === 'partial');
    ok('one per person: the person may start another once the first ended', (await store.insertRun(mk('acme', 'ed@acme.test'))) === true);

    // ── attempts, stop, resume ────────────────────────────────────────────────────────────────────────────────────────
    await store.finish('acme', boss.id, 'podB', 'failed', 'model', null);
    await W.pool.query(`DELETE FROM research_runs WHERE id <> $1`, [boss.id]); // only the run under test is claimable below
    const live = mk('acme', 'east@acme.test');
    await store.insertRun(live);
    for (let i = 0; i < store.MAX_ATTEMPTS; i += 1) { await store.claim(`pod${i}`, 50); await sleep(120); }
    ok('attempts: a run whose pods kept dying is not claimed a 4th time', (await store.claim('podX', 50)) === null);
    const gone = await store.failExhausted();
    ok('attempts: it is failed (gave_up), so the person is not left waiting', gone.length === 1 && gone[0].id === live.id && (await store.getRun('acme', live.id))?.errorCode === 'gave_up');
    ok('resume: a failed run goes back in the queue with a fresh allowance and attempts, its steps kept', (await store.requeue('acme', live.id)) && (await store.getRun('acme', live.id))?.state === 'queued' && (await store.getRun('acme', live.id))?.attempts === 0);
    await store.requestStop('acme', live.id);
    ok('stop: a queued run stops at once', (await store.getRun('acme', live.id))?.state === 'stopped');
    ok('resume (negative control): a stopped run is not resumable', !(await store.requeue('acme', live.id)));
    const run2 = mk('acme', 'west@acme.test');
    await store.insertRun(run2);
    const got = await store.claim('podS', 5000);
    await store.requestStop('acme', run2.id);
    ok('stop: a running run gets the flag, its worker reads it, the state is the worker\'s to set', got?.id === run2.id && (await store.flags('acme', run2.id, 'podS')).stop && (await store.getRun('acme', run2.id))?.state === 'running');
    await store.finish('acme', run2.id, 'podS', 'stopped', null, null);
    const dup = mk('acme', 'boss@acme.test');
    await store.insertRun(dup);
    ok('resume: refused while the person has another run going (one active)', !(await store.requeue('acme', boss.id)));
    await W.pool.query(`UPDATE research_runs SET error_code = 'access', state = 'failed' WHERE id = $1`, [dup.id]);
    ok('resume: a run that failed on access is never resumable', !(await store.requeue('acme', dup.id)));

    // ── limits ──────────────────────────────────────────────────────────────────────────────────────────────────────
    ok('limits: within the ceilings (20 steps, 30 queries, 30 minutes) are saved', await store.saveLimits('acme', { steps: 20, queries: 30, minutes: 30 }));
    ok('limits: past a ceiling, below 1 or not whole is refused, and nothing changes', !(await store.saveLimits('acme', { steps: 21, queries: 30, minutes: 30 })) && !(await store.saveLimits('acme', { steps: 8, queries: 31, minutes: 10 }))
      && !(await store.saveLimits('acme', { steps: 8, queries: 12, minutes: 31 })) && !(await store.saveLimits('acme', { steps: 0, queries: 12, minutes: 10 })) && !(await store.saveLimits('acme', { steps: 2.5, queries: 12, minutes: 10 }))
      && (await store.limitsOf('acme')).steps === 20);

    // ── the sweep ────────────────────────────────────────────────────────────────────────────────────────────────────
    await W.pool.query(`DELETE FROM research_runs`);
    const mkRun = async (by: string, state: string, ageDays: number, story: boolean) => {
      const id = randomUUID();
      await W.pool.query(`INSERT INTO research_runs (org_id, project_id, id, started_by, thread_id, question, state, started_at, story_id) VALUES ('acme', $1, $2, $3, $4, 'q', $5, now() - ($6 || ' days')::interval, $7)`,
        [P, id, by, randomUUID(), state, String(ageDays), story ? randomUUID() : null]);
      return id;
    };
    const oldUnadded = await mkRun('ed@acme.test', 'done', 91, false);
    const oldAdded = await mkRun('ed@acme.test', 'done', 91, true);
    const fresh = await mkRun('ed@acme.test', 'done', 5, false);
    const left2 = await mkRun('gone@acme.test', 'done', 1, true);
    const oldRunning = await mkRun('east@acme.test', 'running', 120, false);
    const n = await store.sweep('acme');
    const have = async (id: string) => (await W.pool.query('SELECT 1 FROM research_runs WHERE id = $1', [id])).rowCount === 1;
    ok('sweep: a run never added and older than 90 days goes; one added to a project stays', !(await have(oldUnadded)) && (await have(oldAdded)));
    ok('sweep: a recent run stays; a run of someone no longer in the org goes (even one added: it is the run, the Story is the project\'s)', (await have(fresh)) && !(await have(left2)) && n === 2, String(n));
    ok('sweep (negative control): an active run is never aged out', await have(oldRunning));
    ok('sweep: only the org it was asked for', (await store.sweep('other')) === 0);

    // ── 2 runs per pod, through the worker ───────────────────────────────────────────────────────────────────────────────
    store.useResearchDb(W.pool);
    await W.pool.query(`DELETE FROM research_runs`);
    S.stub.reset();
    S.stub.steps = [answerStep({ dataset: 'Plain', category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }] })];
    let release!: () => void;
    S.stub.hold = new Promise<void>((r) => { release = r; });
    const ids: string[] = [];
    for (const who of ['ed', 'boss']) {
      const r = await S.start(who, 'sales by region?');
      ids.push(r.body?.runId);
      if (r.status !== 200 || !r.body?.ok) throw new Error('start failed: ' + r.text);
    }
    const third = mk('acme', 'east@acme.test');
    await store.insertRun(third);
    const w = worker.latestForTest();
    worker.pauseForTest(false);
    const started = (await w?.tick()) ?? 0;
    worker.pauseForTest(true);
    ok('2 per pod: one worker starts at most 2 runs at once of the 3 queued', started === 2 && (await store.getRun('acme', third.id))?.state === 'queued', String(started));
    ok('2 per pod: a further tick starts none while both are held', (await (async () => { worker.pauseForTest(false); const n2 = (await w?.tick()) ?? 0; worker.pauseForTest(true); return n2; })()) === 0);
    release();
    await until(async () => (await W.pool.query(`SELECT 1 FROM research_runs WHERE state IN ('running', 'writing') AND id = ANY($1)`, [ids])).rowCount === 0);
    ok('2 per pod: they finish once released', (await W.pool.query(`SELECT 1 FROM research_runs WHERE state IN ('running', 'writing') AND id = ANY($1)`, [ids])).rowCount === 0);
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
