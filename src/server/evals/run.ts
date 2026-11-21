// One claimed suite run, from its lease to its end (the lease and heartbeat are ./worker.ts's). It runs AS THE PERSON WHO PRESSED RUN,
// with no request: every piece of work is its own `runInContext` for them as they are NOW (role, not disabled, no password change
// owed), and before every case `authorize()` runs on `eval:runStart`'s contract and the project. ONE abort signal: the lease (another
// pod retook the run) joined to the 30-minute limit. A lost lease stops everything and writes nothing (every write is fenced by the
// owner, ./db.ts). Each case's result is stored as it finishes, so a retake or a resume asks only the cases with no result.
//
// WHAT HAPPENS (docs/eval-suites/00-design.md): a case's ask fails or times out -> an `error` result, the run goes on; the model is not
// set up -> `failed` (model); the person's request cap is still full after a minute -> `partial` (limited); the person lost write
// access, the project or the agent -> `failed` (access, not resumable); stop -> `stopped`; the time limit -> `partial` (deadline).

import type { Pool } from 'pg';
import { contractFor } from '../../api/index';
import { authorize } from '../authz/index';
import { seedRank } from '../authz/caller';
import { runInContext, type Identity } from '../context';
import { untilAborted } from '../limits';
import * as orgConfig from '../orgConfig';
import { publish } from '../sse';
import * as aiConfig from '../aiConfig';
import * as projects from '../../app/projects';
import * as execConfig from '../../app/execConfig';
import * as analyze from '../../ai/analyze';
import { askScope } from '../../ipc/agentAsk';
import { exactChecks, verdict, type Check, type Judged } from '../../ai/evalChecks';
import { JUDGE_SYSTEM, judgeUser, parseJudge } from '../../ai/evalJudge';
import { underBudget } from '../slack/ask';
import { askCase } from './ask';
import { sidesOf } from './check';
import * as store from './db';

export class LeaseLost extends Error {
  constructor() {
    super('the evaluation run\'s lease was lost');
    this.name = 'LeaseLost';
  }
}

/** The most one run may take, in minutes. */
export const RUN_MINUTES = 30;
const tune = { budgetPollMs: 2_000, budgetTries: 30 };
/** Test hook: how often a run re-asks for its person's request budget, and how many times. */
export function tuneForTest(o: Partial<typeof tune>): void {
  Object.assign(tune, o);
}

interface Account { who: Identity; mustChangePassword: boolean }
async function accountOf(org: string, email: string): Promise<Account | null> {
  const r = await store.db().query<{ role: 'admin' | 'editor' | 'viewer'; must: boolean }>('SELECT role, must_change_password AS must FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [org, email]);
  return r.rows[0] ? { who: { user: { email, role: r.rows[0].role }, org: { id: org } }, mustChangePassword: r.rows[0].must } : null;
}

/** Tells the runner's tabs (only theirs) that the run moved: ids and a state, never a word of an answer. */
export function push(run: Pick<store.Run, 'orgId' | 'startedBy' | 'id' | 'projectId'>, state: string): void {
  publish({ org: run.orgId, user: run.startedBy }, 'evals:changed', { runId: run.id, projectId: run.projectId, state });
}

/** May this person still run tests here: write on the project (the contract), a live project, an agent they may still use. */
export async function mayRun(pool: Pool, who: Identity, run: Pick<store.Run, 'projectId' | 'agentId'>): Promise<boolean> {
  const contract = contractFor('eval:runStart');
  if (!contract) return false;
  const d = await authorize(contract, { projectId: run.projectId }, who, pool);
  if (!d.ok) return false;
  if (d.rank !== undefined) seedRank(run.projectId, d.rank);
  const project = await projects.getProject(run.projectId);
  if (!project || project.archivedAt) return false;
  return !run.agentId || (await askScope(run.projectId, run.agentId)).agent?.id === run.agentId;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
  });
}

export async function execute(pool: Pool, run: store.Run, owner: string, lease: AbortSignal): Promise<void> {
  const org = run.orgId;
  const alive = (): void => { if (lease.aborted) throw new LeaseLost(); };
  const account = await accountOf(org, run.startedBy);
  if (!account || account.mustChangePassword) {
    await store.finish(org, run.id, owner, 'failed', 'access');
    return push(run, 'failed');
  }
  await orgConfig.fresh(org);
  const left = await store.setDeadline(org, run.id, owner, RUN_MINUTES * 60_000);
  const deadline = Date.now() + left;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('evaluation time limit')), Math.max(0, left));
  const onLost = () => ac.abort(lease.reason);
  lease.addEventListener('abort', onLost, { once: true });
  const reqId = `evals:${run.id}`;
  /** `fn` as the runner is now: a fresh context per piece of work. Null: the account is gone or disabled. */
  const asRunner = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    const a = await accountOf(org, run.startedBy);
    return a && !a.mustChangePassword ? runInContext(a.who, reqId, fn, undefined, ac.signal) : null;
  };
  /** The person's request budget: waited for (a run is paced, not refused), up to a minute. */
  const budget = async (): Promise<boolean> => {
    for (let i = 0; i < tune.budgetTries; i++) {
      if (underBudget(org, run.startedBy)) return true;
      await sleep(tune.budgetPollMs, ac.signal);
      alive();
    }
    return false;
  };
  const end = async (state: 'done' | 'partial' | 'failed' | 'stopped', code: string | null): Promise<void> => {
    if (!(await store.finish(org, run.id, owner, state, code))) throw new LeaseLost();
    push(run, state);
  };
  try {
    const cases = new Map((await store.casesByIds(org, run.caseIds)).map((c) => [c.id, c]));
    const done = await store.doneCaseIds(org, run.id);
    // The judge: the org's Judge model, else the Assistant's own. What it resolves to NOW is recorded (a saved pick that is no longer enabled falls back).
    const prep = await asRunner(async () => {
      const scope = await askScope(run.projectId, run.agentId);
      const picked = await store.judgePick(org);
      const prefer = picked ?? scope.agent?.model ?? null;
      const mine = (await aiConfig.memberView(prefer)).mine;
      return { prefer, label: mine ? `${mine.provider}/${mine.model}` : null, own: !picked };
    });
    if (!prep) return await end('failed', 'access');
    if (!(await store.setJudge(org, run.id, owner, prep.label, prep.own))) throw new LeaseLost();
    const ready = async (): Promise<boolean> => execConfig.assistantOn() && (await execConfig.executionReady());

    for (const [at, id] of run.caseIds.entries()) {
      if (done.has(id)) continue;
      const position = at + 1; // the run's own order, whatever happens to the case later
      alive();
      const flags = await store.flags(org, run.id, owner);
      if (!flags.held) throw new LeaseLost();
      if (flags.stop) return await end('stopped', null);
      if (Date.now() >= deadline) return await end('partial', 'deadline');
      if ((await asRunner(async () => mayRun(pool, (await accountOf(org, run.startedBy))?.who ?? account.who, run))) !== true) return await end('failed', 'access');
      const c = cases.get(id);
      if (!c) { // deleted after the run started
        if (!(await store.recordResult(org, run.id, owner, { caseId: id, position, question: '', outcome: 'error', checks: [], judged: { state: 'none' }, calls: 0, errorCode: 'gone', reply: null, why: null, datasetIds: [] }))) throw new LeaseLost();
        continue;
      }
      if (!(await budget())) return await end('partial', 'limited');
      const who = (await accountOf(org, run.startedBy))?.who;
      if (!who) return await end('failed', 'access');
      const asked = await askCase(pool, who, reqId, { projectId: run.projectId, agentId: run.agentId, question: c.question }, ac.signal);
      alive();
      if (!asked.ok && asked.code === 'not_ready') return await end('failed', 'model');
      if (!asked.ok && (asked.code === 'denied' || asked.code === 'agent')) return await end('failed', 'access');
      let result: store.NewResult;
      if (!asked.ok) {
        result = { caseId: c.id, position, question: c.question, outcome: 'error', checks: [], judged: { state: 'none' }, calls: 0, errorCode: asked.code, reply: null, why: null, datasetIds: [] };
      } else {
        const exp = c.expect;
        const expected = exp.compute;
        const comp = asked.got.computed;
        const sides = expected && comp?.kind === 'chart' ? await asRunner(() => untilAborted(sidesOf(run.projectId, expected, comp.spec), ac.signal)).catch((): null => null) : null;
        alive();
        const checks: Check[] = exactChecks(exp, asked.got, sides);
        let judged: Judged = { state: 'none' };
        let why = '';
        let calls = asked.calls;
        // The judge reads the words only when every exact check passed: a case that already failed costs no second model call.
        if (exp.say && checks.every((k) => k.ok)) {
          if (!(await budget())) return await end('partial', 'limited');
          const reply = await asRunner(async () => {
            if (!(await ready())) return null;
            try {
              const out = await untilAborted(analyze.dispatch(JUDGE_SYSTEM, [{ role: 'user', text: judgeUser({ question: c.question, reply: asked.text, say: exp.say! }) }], undefined, { prose: true, model: prep.prefer }), ac.signal);
              return out.error || !out.rawText ? null : out.rawText;
            } catch {
              return null;
            }
          });
          alive();
          calls += 1;
          const parsed = reply ? parseJudge(reply) : { judged: { state: 'not_scored' } as Judged, why: '' };
          judged = parsed.judged;
          why = parsed.why;
        }
        result = {
          caseId: c.id, position, question: c.question, outcome: verdict(checks, judged), checks, judged, calls, errorCode: null,
          reply: asked.text, why: why || null, datasetIds: asked.datasetIds,
        };
      }
      if (!(await store.recordResult(org, run.id, owner, result))) throw new LeaseLost();
      push(run, 'running');
    }
    alive();
    await end('done', null);
  } finally {
    clearTimeout(timer);
    lease.removeEventListener('abort', onLost);
  }
}
