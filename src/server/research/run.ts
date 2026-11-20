// One claimed research run, from its lease to its end (the lease and heartbeat are ./worker.ts's). It runs AS ITS STARTER,
// with no request: every piece of work is its own `runInContext` for the person as they are NOW (role, not disabled, no
// password change owed), so per-request caches never outlive a step and a lost role or folder stops the next one. Before
// every step `authorize()` runs on `research:start`'s contract and the project (src/server/slack/ask.ts `mayAsk`'s way).
//
// ONE abort signal: the lease (another pod retook the run) joined to the time limit. A lost lease stops everything and
// writes nothing (every write is fenced by the owner, ./db.ts). The time limit aborts the engine queries of the step running.
//
// WHAT HAPPENS ON EACH FAILURE (docs/deep-research/00-design.md): a model error or a refused AI budget -> `failed`
// (code model | limited, resumable); the starter lost write access, the project, the agent or their account -> `failed`
// (code access, not resumable); a refused step -> recorded, never repaired; an engine failure -> a `failed` step; a write
// failure -> `partial` with a report of charts only; a lost lease -> nothing; stop -> `stopped`; the deadline -> `partial`
// with charts only; a step or query limit -> the report is still written, `partial`.

import type { Pool } from 'pg';
import { contractFor } from '../../api/index';
import { authorize } from '../authz/index';
import { seedRank } from '../authz/caller';
import { ctx, runInContext, type Identity } from '../context';
import { untilAborted } from '../limits';
import * as orgConfig from '../orgConfig';
import { publish } from '../sse';
import * as projects from '../../app/projects';
import * as execConfig from '../../app/execConfig';
import * as analyze from '../../ai/analyze';
import * as copilotRows from '../../ai/copilotRows';
import { guardAnswer, buildFacts } from '../../ipc/copilot';
import { askGuidance } from '../../ipc/guidance';
import { askScope, scopedContext } from '../../ipc/agentAsk';
import { parseActionLine, type ParseCode } from '../../ai/researchActions';
import { runLoop, type Decision, type End, type LoopState, type StepRec } from '../../ai/researchLoop';
import { PLAN_SYSTEM, WRITE_SYSTEM, parsePlan, planUser, stepSystem, stepUser, writeUser } from '../../ai/researchPrompts';
import { buildReport, chartsOnly, parseWriteReply, type Report } from '../../ai/researchWrite';
import { underBudget } from '../slack/ask';
import { restricted } from '../slack/check';
import { readAgent } from '../../ai/agents';
import { titlesOf } from '../../knowledge/store';
import * as store from './db';
import { computeStep, type StepScope } from './steps';
import * as say from '../researchMessages';

export class LeaseLost extends Error {
  constructor() {
    super('the research run\'s lease was lost');
    this.name = 'LeaseLost';
  }
}

const REPLY: Record<ParseCode, () => string> = {
  empty: say.replyEmpty, prose: say.replyProse, many: say.replyMany, json: say.replyJson, kind: say.replyKind, shape: say.replyShape, figure_name: say.replyFigureName,
};

interface Account { who: Identity; mustChangePassword: boolean }
async function accountOf(org: string, email: string): Promise<Account | null> {
  const r = await store.db().query<{ role: 'admin' | 'editor' | 'viewer'; must: boolean }>(
    'SELECT role, must_change_password AS must FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [org, email]);
  return r.rows[0] ? { who: { user: { email, role: r.rows[0].role }, org: { id: org } }, mustChangePassword: r.rows[0].must } : null;
}

/** Tells the starter's tabs (only theirs) that the run moved: ids and the state, never a figure. */
export function push(run: Pick<store.Run, 'orgId' | 'startedBy' | 'id' | 'projectId'>, state: string): void {
  publish({ org: run.orgId, user: run.startedBy }, 'research:changed', { runId: run.id, projectId: run.projectId, state });
}

/** May this person still run research here: write on the project (the contract), a live project, an agent they may still use. */
export async function mayRun(pool: Pool, who: Identity, run: Pick<store.Run, 'projectId' | 'agentId'>): Promise<boolean> {
  const contract = contractFor('research:start');
  if (!contract) return false;
  const d = await authorize(contract, { projectId: run.projectId }, who, pool);
  if (!d.ok) return false;
  if (d.rank !== undefined) seedRank(run.projectId, d.rank);
  const project = await projects.getProject(run.projectId);
  if (!project || project.archivedAt) return false;
  return !run.agentId || (await askScope(run.projectId, run.agentId)).agent?.id === run.agentId;
}

const END_STATE: Record<End, { state: 'done' | 'partial' | 'failed' | 'stopped'; code: string | null } | null> = {
  done: { state: 'done', code: null }, steps: { state: 'partial', code: 'steps' }, queries: { state: 'partial', code: 'queries' },
  deadline: { state: 'partial', code: 'deadline' }, stopped: { state: 'stopped', code: null }, lost: null, model: { state: 'failed', code: 'model' }, access: { state: 'failed', code: 'access' },
};

export async function execute(pool: Pool, run: store.Run, owner: string, lease: AbortSignal): Promise<void> {
  const org = run.orgId;
  const alive = (): void => { if (lease.aborted) throw new LeaseLost(); };
  const account = await accountOf(org, run.startedBy);
  if (!account || account.mustChangePassword) {
    await store.finish(org, run.id, owner, 'failed', 'access', null);
    return push(run, 'failed');
  }
  await orgConfig.fresh(org);
  const limits = await store.limitsOf(org);
  const left = await store.setDeadline(org, run.id, owner, limits.minutes * 60_000);
  const deadline = Date.now() + left;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('research time limit')), Math.max(0, left));
  const onLost = () => ac.abort(lease.reason);
  lease.addEventListener('abort', onLost, { once: true });
  const reqId = `research:${run.id}`;
  /** `fn` as the starter is now: a fresh context per piece of work. Null: the account is gone or disabled. */
  const asStarter = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    const a = await accountOf(org, run.startedBy);
    return a && !a.mustChangePassword ? runInContext(a.who, reqId, fn, undefined, ac.signal) : null;
  };
  let steps: StepRec[] = run.steps;
  const used = { steps: run.stepsUsed, queries: run.queriesUsed };
  let plan: string[] = run.plan;
  try {
    // Scope, facts and guidance are rebuilt each attempt (never stored): metadata and the starter's own gates.
    const prep = await asStarter(async () => {
      const scope = await askScope(run.projectId, run.agentId);
      const asked = await scopedContext(run.projectId, scope, { kind: '' });
      const facts = await buildFacts(run.projectId, asked, () => undefined, run.question);
      const agent = scope.agent ? { id: scope.agent.id, name: scope.agent.name, instructions: scope.agent.instructions.map((i) => i.text), datasets: scope.only } : undefined;
      const guided = await askGuidance(run.projectId, asked, facts.provenance.kind, run.question, agent ? { agent } : {});
      // A document of a TEAM-ONLY agent (a person outside its teams may not read it) makes the run restricted: Add to project keeps no prose.
      let teamOnly = false;
      const docs = guided.used.documents ?? [];
      if (docs.length) {
        const found = await titlesOf(run.projectId, docs).catch(() => new Map<string, { title: string; agentId: string | null }>());
        for (const agentId of new Set([...found.values()].flatMap((d) => (d.agentId ? [d.agentId] : [])))) {
          const a = await readAgent(run.projectId, agentId);
          if (!a || a.rec.teamIds.length > 0) teamOnly = true; // gone or team-gated: unknown or restricted
        }
      }
      return { scope, facts, guided, teamOnly };
    });
    if (!prep) { await store.finish(org, run.id, owner, 'failed', 'access', null); return push(run, 'failed'); }
    const { scope, facts, guided } = prep;
    if (prep.teamOnly) await store.markRestricted(org, run.id, owner);
    const model = scope.agent?.model ?? null;
    const ready = async (): Promise<boolean> => execConfig.assistantOn() && (await execConfig.executionReady());

    /** One model call, as the starter (the provider and the model are the org's, read in the person's context): budgeted, bounded by the signal. */
    const call = async (system: string, text: string): Promise<{ ok: true; raw: string } | { ok: false; code: 'limited' | 'model' | 'time' }> => {
      if (!underBudget(org, run.startedBy)) return { ok: false, code: 'limited' };
      const r = await asStarter(async () => {
        if (!(await ready())) return { ok: false as const, code: 'model' as const };
        try {
          const out = await untilAborted(analyze.dispatch(system, [{ role: 'user', text }], undefined, { prose: true, model }), ac.signal);
          return out.error || !out.rawText ? { ok: false as const, code: 'model' as const } : { ok: true as const, raw: out.rawText };
        } catch {
          return { ok: false as const, code: 'time' as const };
        }
      });
      alive();
      return r ?? { ok: false, code: 'model' };
    };
    const fail = async (code: 'model' | 'limited'): Promise<void> => {
      await store.finish(org, run.id, owner, 'failed', code, null);
      push(run, 'failed');
    };

    // THE PLAN: one call (skipped on a retake or a resume, which already has one).
    if (!plan.length && run.state !== 'writing') {
      alive();
      const r = await call(PLAN_SYSTEM, planUser({ question: run.question, facts: facts.text, guidance: guided.text }));
      const parsed = r.ok ? parsePlan(r.raw) : null;
      if (!parsed) return await fail(r.ok ? 'model' : r.code === 'limited' ? 'limited' : 'model');
      plan = parsed;
      if (!(await store.savePlan(org, run.id, owner, plan))) throw new LeaseLost();
      push(run, 'running');
    }

    // A run retaken in `writing` ends as its loop did (a step or query limit stays `partial`).
    let end: End = run.state === 'writing' && (run.errorCode === 'steps' || run.errorCode === 'queries') ? run.errorCode : 'done';
    let fatal: 'model' | 'limited' = 'model';
    if (run.state !== 'writing') {
      const sc: StepScope = { projectId: run.projectId, question: run.question, only: scope.only, model };
      const from: LoopState = { steps, stepsUsed: used.steps, queriesUsed: used.queries };
      const r = await runLoop(limits, from, {
        now: Date.now, deadline, lost: () => lease.aborted,
        stopRequested: async () => (await store.flags(org, run.id, owner)).stop,
        allowed: async () => (await asStarter(async () => mayRun(pool, ctx(), run))) === true,
        async decide(sofar): Promise<Decision> {
          const reply = await call(stepSystem(), stepUser({ question: run.question, plan, facts: facts.text, guidance: guided.text, steps: sofar, left: { steps: limits.steps - used.steps, queries: limits.queries - used.queries } }));
          if (!reply.ok) return reply.code === 'time' ? { ok: false, refused: say.timeUp() } : { ok: false, fatal: reply.code };
          const p = parseActionLine(reply.raw);
          return p.ok ? { ok: true, action: p.action } : { ok: false, refused: REPLY[p.code]() };
        },
        async compute(action) {
          if (action.kind === 'sql' && !underBudget(org, run.startedBy)) return { status: 'failed', reason: say.tooBusy() }; // the SQL answer makes its own model call
          let touched = false;
          const out = await asStarter(async () => {
            const r = await untilAborted(computeStep(action, sc), ac.signal);
            // Recorded NOW, while the dataset exists and under the starter's rules: Add to project may come after it is deleted.
            if (r.status === 'done') touched = await restricted({ projectId: run.projectId, datasetIds: r.datasetIds, dashboardIds: [] });
            return r;
          }).catch((): null => null);
          alive();
          if (touched) await store.markRestricted(org, run.id, owner);
          return out ?? { status: 'failed', reason: say.timeUp() };
        },
        async save(s) {
          steps = s.steps;
          used.steps = s.stepsUsed;
          used.queries = s.queriesUsed;
          if (!(await store.saveSteps(org, run.id, owner, s.steps, s.stepsUsed, s.queriesUsed))) { ac.abort(new LeaseLost()); throw new LeaseLost(); }
          push(run, 'running');
        },
      });
      end = r.end;
      fatal = r.fatal ?? 'model';
      steps = r.state.steps;
    }
    alive();
    const mapped = END_STATE[end];
    if (!mapped) throw new LeaseLost();
    const usable = steps.some((s) => s.status === 'done');
    let { state, code } = mapped;
    if (end === 'model') code = fatal;
    let report: Report | null = null;
    if (state === 'done' || state === 'partial') {
      if (!usable) {
        state = 'failed';
        code = 'no_steps';
      } else {
        const now = new Date().toISOString();
        if (end === 'deadline') {
          report = chartsOnly(steps, run.question, now);
        } else {
          if (!(await store.setWriting(org, run.id, owner, end === 'steps' || end === 'queries' ? end : null))) throw new LeaseLost();
          push(run, 'writing');
          // A stop asked for since the last step is honored before the write call, which costs a model call.
          if ((await store.flags(org, run.id, owner)).stop) {
            if (!(await store.finish(org, run.id, owner, 'stopped', null, null))) throw new LeaseLost();
            return push(run, 'stopped');
          }
          const w = await call(WRITE_SYSTEM, writeUser({ question: run.question, plan, guidance: guided.text, steps }));
          alive();
          report = w.ok ? buildReport(parseWriteReply(w.raw), steps, guided.ledger, guardAnswer, now) : null;
          if (!report) { report = chartsOnly(steps, run.question, now); state = 'partial'; code = 'write'; }
        }
      }
    }
    if (!(await store.finish(org, run.id, owner, state, code, report))) throw new LeaseLost();
    await asStarter(async () => {
      if (run.turnId) await copilotRows.setResearchFacts(run.projectId, run.threadId, run.turnId, steps.flatMap((s) => (s.status === 'done' ? s.datasetIds ?? [] : [])));
    }).catch(() => undefined); // the turn is the card's anchor; its hiding is best effort here and retried by nobody: a failure leaves it visible only to its owner
    push(run, state);
  } finally {
    clearTimeout(timer);
    lease.removeEventListener('abort', onLost);
  }
}
