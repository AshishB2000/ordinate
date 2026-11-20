// Deep research's RPC channels (contracts in src/api/research.ts). Each handler but the limits' runs in the caller's own request
// context and checks the caller STARTED the run: another person's run, a run in another org and a run that does not exist
// all answer "not found". A reply carries specs, statuses, reasons, counts and the validated report: never a step's facts or ledger.

import { randomUUID } from 'crypto';
import { ipcMain } from '../../ipc/bus';
import { ctx } from '../context';
import * as copilot from '../../ai/copilot';
import * as execConfig from '../../app/execConfig';
import { turnsForBrowser } from '../../ipc/answerSnapshots';
import { askScope } from '../../ipc/agentAsk';
import { CEILING, type StepRec } from '../../ai/researchLoop';
import { publicStep, type Report } from '../../ai/researchWrite';
import { levelsOf } from '../authz/folderGate';
import { addToProject } from './add';
import { cardOf } from './cards';
import * as store from './db';
import { push } from './run';
import * as say from '../researchMessages';

const fail = (error: string) => ({ ok: false as const, error });

/** The run, when the caller started it (and it is in this project). */
async function mine(p: { projectId: string; runId: string }): Promise<store.Run | null> {
  const { org, user } = ctx();
  const run = await store.getRun(org.id, p.runId);
  return run && run.startedBy === user.email && run.projectId.toLowerCase() === p.projectId.toLowerCase() && !(await closedToCaller([run])).has(run.id) ? run : null;
}

/** Is a dataset one of the run's computed steps read now closed to the caller (a team folder)? Then the run is gone from their view, as an answer on it is gone from History (src/ipc/turnsOpen.ts). */
async function closedToCaller(runs: readonly store.Run[]): Promise<Set<string>> {
  const closed = new Set<string>();
  for (const projectId of new Set(runs.map((r) => r.projectId))) {
    const level = await levelsOf(projectId, 'dataset');
    if (!level) continue; // no folder besides Everyone, or an admin
    for (const r of runs) if (r.projectId === projectId && r.steps.some((s) => s.status === 'done' && (s.datasetIds ?? []).some((d) => level(d) === 'none'))) closed.add(r.id);
  }
  return closed;
}

const RESUMABLE = (r: Pick<store.Run, 'state' | 'errorCode'>): boolean => (r.state === 'partial' || r.state === 'failed') && r.errorCode !== 'access';

/** The run as a browser gets it. */
export async function view(run: store.Run) {
  const limits = await store.limitsOf(run.orgId);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return {
    id: run.id, projectId: run.projectId, threadId: run.threadId, agentId: run.agentId, question: run.question, state: run.state, plan: run.plan,
    steps: run.steps.map(publicStep) as Array<ReturnType<typeof publicStep>>, report: run.report as Report | null, storyId: run.storyId, errorCode: run.errorCode,
    stepsUsed: run.stepsUsed, queriesUsed: run.queriesUsed, limits, elapsedSec: Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000)),
    resumable: RESUMABLE(run), startedAt: run.startedAt, finishedAt: run.finishedAt,
  };
}
export type RunView = Awaited<ReturnType<typeof view>>;

export function register(): void {
  ipcMain.handle('research:start', async (_e, p: { projectId: string; threadId?: string; agentId?: string; question: string }) => {
    if (!store.dbOrNull()) return fail(say.needsDb());
    if (!execConfig.assistantOn() || !(await execConfig.executionReady())) return { ok: false as const, notReady: true, error: say.notReady() };
    const { org, user } = ctx();
    const named = p.threadId ? await copilot.threadFor(p.projectId, p.threadId) : null;
    const agentId = named && named.id === p.threadId ? (named.agentId ?? null) : (p.agentId ?? null);
    if (agentId && (await askScope(p.projectId, agentId)).agent?.id !== agentId) return fail(say.agentNotYours());
    const threadId = named && named.id === p.threadId ? named.id : (await copilot.createThread(p.projectId, agentId))?.id;
    if (!threadId) return fail(say.couldNotAdd());
    const id = randomUUID();
    if (!(await store.insertRun({ id, orgId: org.id, projectId: p.projectId, startedBy: user.email, agentId, threadId, question: p.question }))) {
      if (!named) await copilot.deleteThread(p.projectId, threadId);
      return fail(say.alreadyRunning());
    }
    await copilot.appendTurn(p.projectId, { role: 'user', text: p.question }, threadId);
    const turns = await copilot.appendTurn(p.projectId, { role: 'assistant', text: say.turnText(), research: { runId: id } }, threadId);
    const turn = turns?.[turns.length - 1];
    if (!turn) {
      await store.requestStop(org.id, id);
      return fail(say.couldNotAdd());
    }
    await store.setTurn(org.id, id, turn.id);
    push({ orgId: org.id, startedBy: user.email, id, projectId: p.projectId }, 'queued');
    return { ok: true as const, runId: id, threadId, turns: await turnsForBrowser(p.projectId, turns) };
  });

  ipcMain.handle('research:get', async (_e, p: { projectId: string; runId: string }) => {
    if (!store.dbOrNull()) return fail(say.needsDb());
    const run = await mine(p);
    return run ? { ok: true as const, run: await view(run) } : fail(say.notFound());
  });

  ipcMain.handle('research:card', async (_e, p: { projectId: string; runId: string; step: number }) => {
    if (!store.dbOrNull()) return fail(say.needsDb());
    const run = await mine(p);
    const step: StepRec | undefined = run?.steps.find((s) => s.n === p.step);
    return run && step ? cardOf(run.projectId, step) : fail(say.notFound());
  });

  ipcMain.handle('research:stop', async (_e, p: { projectId: string; runId: string }) => {
    if (!store.dbOrNull()) return fail(say.needsDb());
    const run = await mine(p);
    if (!run) return fail(say.notFound());
    await store.requestStop(run.orgId, run.id);
    push(run, 'stopping');
    return { ok: true as const };
  });

  ipcMain.handle('research:resume', async (_e, p: { projectId: string; runId: string }) => {
    if (!store.dbOrNull()) return fail(say.needsDb());
    const run = await mine(p);
    if (!run) return fail(say.notFound());
    if (!RESUMABLE(run)) return fail(say.notResumable());
    if (!execConfig.assistantOn() || !(await execConfig.executionReady())) return { ok: false as const, notReady: true, error: say.notReady() };
    if (!(await store.requeue(run.orgId, run.id))) return fail(say.alreadyRunning());
    push(run, 'queued');
    return { ok: true as const };
  });

  ipcMain.handle('research:addToProject', async (_e, p: { projectId: string; runId: string }) => {
    if (!store.dbOrNull()) return fail(say.needsDb());
    const run = await mine(p);
    if (!run) return fail(say.notFound());
    const r = await addToProject(run.orgId, run.id);
    if (r.ok) push(run, 'added');
    return r;
  });

  ipcMain.handle('research:list', async (_e, p: { projectId: string }) => {
    if (!store.dbOrNull()) return { ok: true as const, runs: [], activeRunId: null, limits: null };
    const { org, user } = ctx();
    const all = await store.listRuns(org.id, p.projectId, user.email);
    const closed = await closedToCaller(all);
    const runs = all.filter((r) => !closed.has(r.id));
    return {
      ok: true as const, limits: await store.limitsOf(org.id),
      activeRunId: runs.find((r) => store.ACTIVE.includes(r.state))?.id ?? null,
      runs: runs.map((r) => ({ id: r.id, question: r.question, state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt, storyId: r.storyId, threadId: r.threadId })),
    };
  });

  ipcMain.handle('research:limits', async () => (store.dbOrNull() ? { ok: true as const, limits: await store.limitsOf(ctx().org.id), ceilings: CEILING } : fail(say.needsDb())));
  ipcMain.handle('research:setLimits', async (_e, p: { steps: number; queries: number; minutes: number }) => {
    if (!store.dbOrNull()) return fail(say.needsDb());
    return (await store.saveLimits(ctx().org.id, p)) ? { ok: true as const, limits: p, ceilings: CEILING } : fail(say.badLimits());
  });
}
