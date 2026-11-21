// Evaluation suites' RPC channels (contracts in src/api/evals.ts). Each runs in the caller's own request context. Suites, cases, runs and the
// inbox are for editors and admins of the project (the contracts' `write`); every store call names the project, so another project's id is
// "not found". A reply carries counts, outcomes, check codes and the cases' own words; the answer's words and the judge's line only go to
// the person who ran it (./view.ts); never a ledger, a card or a row.

import { randomUUID } from 'crypto';
import { ipcMain } from '../../ipc/bus';
import { ctx } from '../context';
import * as execConfig from '../../app/execConfig';
import { askScope } from '../../ipc/agentAsk';
import { getDatasetMeta } from '../../data/datasets';
import { isLive } from '../../data/liveDataset';
import { relatedIds } from '../../ai/answerJoin';
import * as aiConfig from '../aiConfig';
import { caseFrom } from './cases';
import * as feedback from './feedback';
import * as store from './db';
import { push } from './run';
import { caseGate, runView } from './view';
import { changedParts, versionOf } from './version';
import * as say from '../evalMessages';
import { MAX_CASES, sanitizeExpect, type Expect } from '../../ai/evalChecks';

const fail = (error: string) => ({ ok: false as const, error });
const needsDb = () => fail(say.needsDb());

/** Warehouse queries a Live compute case can make: the ask's own answer, the expected spec and the answer's spec, each one. */
const LIVE_PER_CASE = 3;

type Gate = Awaited<ReturnType<typeof caseGate>>;
/** A run's counts as the caller may see them: the run row's own when no folder restricts them, else recounted over the cases they may open. */
async function countsOf(org: string, run: store.Run, gate: Gate, byId: ReadonlyMap<string, store.Case>) {
  if (!gate.level) return { casesDone: run.casesDone, casesTotal: run.casesTotal, passed: run.passed, failed: run.failed, notScored: run.notScored };
  const open = new Set(run.caseIds.filter((id) => { const c = byId.get(id); return !c || gate.visible(c); }));
  const done = (await store.resultsOf(org, run.id)).filter((r) => open.has(r.caseId));
  const n = (f: (o: string) => boolean): number => done.filter((r) => f(r.outcome)).length;
  return { casesDone: done.length, casesTotal: open.size, passed: n((o) => o === 'pass'), failed: n((o) => o === 'fail' || o === 'error'), notScored: n((o) => o === 'not_scored') };
}

export function register(): void {
  ipcMain.handle('feedback:rate', async (_e, p: { projectId: string; threadId: string; turnId: string; value: 'up' | 'down' | 'none'; reason?: string }) => feedback.rate(p));
  ipcMain.handle('feedback:inbox', async (_e, p: { projectId: string }) => (store.dbOrNull() ? { ok: true as const, items: await feedback.inbox(p.projectId) } : { ok: true as const, items: [], available: false }));
  ipcMain.handle('feedback:dismiss', async (_e, p: { projectId: string; turnId: string }) => (store.dbOrNull() ? ((await feedback.handle(p.projectId, p.turnId)) ? { ok: true as const } : fail(say.inboxGone())) : needsDb()));

  ipcMain.handle('eval:suites', async (_e, p: { projectId: string }) => {
    if (!store.dbOrNull()) return { ok: true as const, available: false as const, suites: [], activeRunId: null };
    const { org } = ctx();
    const gate = await caseGate(p.projectId);
    const [suites, allCases, last, runs] = await Promise.all([store.listSuites(org.id, p.projectId), store.listCases(org.id, p.projectId), store.lastRunPerSuite(org.id, p.projectId), store.listRuns(org.id, p.projectId, undefined, 50)]);
    const cases = allCases.filter((c) => gate.visible(c));
    const live = new Set<string>();
    for (const id of new Set(cases.flatMap((c) => (c.expect.compute ? [c.expect.compute.datasetId, ...relatedIds(c.expect.compute)] : [])))) {
      if (isLive(await getDatasetMeta(p.projectId, id).catch(() => null))) live.add(id);
    }
    const versions = new Map<string | null, Record<string, string>>();
    for (const agentId of new Set(suites.map((s) => s.agentId))) versions.set(agentId, await versionOf(p.projectId, agentId));
    const active = runs.find((r) => store.ACTIVE.includes(r.state));
    const byId = new Map(allCases.map((c) => [c.id, c]));
    return {
      ok: true as const, available: true as const, activeRunId: active?.id ?? null,
      suites: await Promise.all(suites.map(async (s) => {
        const mine = cases.filter((c) => c.suiteId === s.id);
        const l = last.find((r) => r.suiteId === s.id);
        return {
          id: s.id, name: s.name, agentId: s.agentId, caseCount: mine.length, createdAt: s.createdAt,
          liveQueries: LIVE_PER_CASE * mine.filter((c) => c.expect.compute && [c.expect.compute.datasetId, ...relatedIds(c.expect.compute)].some((d) => live.has(d))).length,
          last: l ? { runId: l.id, state: l.state, startedAt: l.startedAt, ...(await countsOf(org.id, l, gate, byId)) } : null,
          stale: l ? changedParts(l.version, versions.get(s.agentId) ?? {}) : [],
          runningId: active && active.suiteId === s.id ? active.id : null,
        };
      })),
    };
  });

  ipcMain.handle('eval:suiteSave', async (_e, p: { projectId: string; id?: string; name: string; agentId?: string | null }) => {
    if (!store.dbOrNull()) return needsDb();
    const { org, user } = ctx();
    if (p.id) return (await store.renameSuite(org.id, p.projectId, p.id, p.name)) ? { ok: true as const, id: p.id } : fail(say.notFound());
    const agentId = p.agentId ?? null;
    if (agentId && (await askScope(p.projectId, agentId)).agent?.id !== agentId) return fail(say.agentNotYours());
    const made = await store.createSuite(org.id, { id: randomUUID(), projectId: p.projectId, name: p.name, agentId, by: user.email });
    return made ? { ok: true as const, id: made.id } : fail(say.tooManySuites(String(store.MAX_SUITES)));
  });
  ipcMain.handle('eval:suiteDelete', async (_e, p: { projectId: string; id: string }) => {
    if (!store.dbOrNull()) return needsDb();
    const { org } = ctx();
    if (!(await store.getSuite(org.id, p.projectId, p.id))) return fail(say.notFound());
    return (await store.deleteSuite(org.id, p.projectId, p.id)) ? { ok: true as const } : fail(say.suiteBusy());
  });

  ipcMain.handle('eval:cases', async (_e, p: { projectId: string; suiteId: string }) => {
    if (!store.dbOrNull()) return needsDb();
    const { org } = ctx();
    const suite = await store.getSuite(org.id, p.projectId, p.suiteId);
    if (!suite) return fail(say.notFound());
    const gate = await caseGate(p.projectId);
    const cases = (await store.listCases(org.id, p.projectId, p.suiteId)).filter((c) => gate.visible(c));
    const names = new Map<string, string>();
    for (const c of cases) if (c.expect.compute && !names.has(c.expect.compute.datasetId)) names.set(c.expect.compute.datasetId, (await getDatasetMeta(p.projectId, c.expect.compute.datasetId).catch(() => null))?.name ?? '');
    return {
      ok: true as const, suite: { id: suite.id, name: suite.name, agentId: suite.agentId }, max: MAX_CASES,
      cases: cases.map((c) => ({
        id: c.id, position: c.position, question: c.question, source: c.source, say: c.expect.say ?? null, refuse: c.expect.refuse === true,
        compute: c.expect.compute ? { spec: c.expect.compute, datasetName: names.get(c.expect.compute.datasetId) ?? '' } : null,
      })),
    };
  });
  ipcMain.handle('eval:caseSave', async (_e, p: { projectId: string; suiteId: string; id?: string; question: string; refuse?: boolean; say?: string }) => {
    if (!store.dbOrNull()) return needsDb();
    const { org, user } = ctx();
    if (!(await store.getSuite(org.id, p.projectId, p.suiteId))) return fail(say.notFound());
    if (!p.id) {
      const expect = sanitizeExpect({ refuse: p.refuse ? true : undefined, say: p.say });
      if (!expect) return fail(say.badCase());
      const id = randomUUID();
      const added = await store.addCase(org.id, p.projectId, p.suiteId, { id, question: p.question, expect, source: 'typed', by: user.email });
      return added === 'ok' ? { ok: true as const, id } : fail(added === 'full' ? say.suiteFull(String(MAX_CASES)) : say.notFound());
    }
    const cur = (await store.listCases(org.id, p.projectId, p.suiteId)).find((c) => c.id === p.id);
    if (!cur) return fail(say.notFound());
    const next: Expect | null = sanitizeExpect({ compute: cur.expect.compute, refuse: cur.expect.compute ? undefined : p.refuse ? true : undefined, say: p.say });
    if (!next) return fail(say.badCase());
    return (await store.updateCase(org.id, p.projectId, p.suiteId, p.id, { question: p.question, expect: next })) ? { ok: true as const, id: p.id } : fail(say.notFound());
  });
  ipcMain.handle('eval:caseDelete', async (_e, p: { projectId: string; suiteId: string; id: string }) => {
    if (!store.dbOrNull()) return needsDb();
    return (await store.deleteCase(ctx().org.id, p.projectId, p.suiteId, p.id)) ? { ok: true as const } : fail(say.notFound());
  });
  ipcMain.handle('eval:caseFrom', async (_e, p: Parameters<typeof caseFrom>[0]) => (store.dbOrNull() ? caseFrom(p) : needsDb()));

  ipcMain.handle('eval:runStart', async (_e, p: { projectId: string; suiteId: string }) => {
    if (!store.dbOrNull()) return needsDb();
    const { org, user } = ctx();
    const suite = await store.getSuite(org.id, p.projectId, p.suiteId);
    if (!suite) return fail(say.notFound());
    if (!execConfig.assistantOn() || !(await execConfig.executionReady())) return { ok: false as const, notReady: true, error: say.notReady() };
    if (suite.agentId && (await askScope(p.projectId, suite.agentId)).agent?.id !== suite.agentId) return fail(say.agentNotYours());
    const gate = await caseGate(p.projectId);
    const caseIds = (await store.listCases(org.id, p.projectId, p.suiteId)).filter((c) => gate.visible(c)).map((c) => c.id); // the runner runs what they may see
    if (!caseIds.length) return fail(say.emptySuite());
    const id = randomUUID();
    if (!(await store.insertRun({ id, orgId: org.id, projectId: p.projectId, suiteId: p.suiteId, agentId: suite.agentId, startedBy: user.email, caseIds, version: await versionOf(p.projectId, suite.agentId) }))) return fail(say.alreadyRunning());
    push({ orgId: org.id, startedBy: user.email, id, projectId: p.projectId }, 'queued');
    return { ok: true as const, runId: id };
  });

  ipcMain.handle('eval:runGet', async (_e, p: { projectId: string; runId: string }) => {
    if (!store.dbOrNull()) return needsDb();
    const { org, user } = ctx();
    const run = await store.getRun(org.id, p.runId);
    if (!run || run.projectId.toLowerCase() !== p.projectId.toLowerCase()) return fail(say.notFound());
    const gate = await caseGate(p.projectId);
    const [results, cases, before, suite] = await Promise.all([store.resultsOf(org.id, run.id), store.listCases(org.id, p.projectId, run.suiteId), store.previousRun(org.id, run.suiteId, run.startedAt), store.getSuite(org.id, p.projectId, run.suiteId)]);
    const prev = before ? { run: before, results: await store.resultsOf(org.id, before.id) } : null;
    return { ok: true as const, suite: suite ? { id: suite.id, name: suite.name } : null, ...runView(user.email, run, results, new Map(cases.map((c) => [c.id, c])), gate.level, gate.visible, prev) };
  });
  ipcMain.handle('eval:runList', async (_e, p: { projectId: string; suiteId?: string }) => {
    if (!store.dbOrNull()) return { ok: true as const, runs: [] };
    const { org, user } = ctx();
    const runs = await store.listRuns(org.id, p.projectId, p.suiteId);
    const gate = await caseGate(p.projectId);
    const byId = new Map((await store.listCases(org.id, p.projectId)).map((c) => [c.id, c]));
    return { ok: true as const, runs: await Promise.all(runs.map(async (r) => ({ id: r.id, suiteId: r.suiteId, state: r.state, ...(await countsOf(org.id, r, gate, byId)), modelCalls: r.modelCalls, startedAt: r.startedAt, finishedAt: r.finishedAt, mine: r.startedBy === user.email }))) };
  });
  ipcMain.handle('eval:runStop', async (_e, p: { projectId: string; runId: string }) => {
    if (!store.dbOrNull()) return needsDb();
    const { org } = ctx();
    const run = await store.getRun(org.id, p.runId);
    if (!run || run.projectId.toLowerCase() !== p.projectId.toLowerCase()) return fail(say.notFound());
    await store.requestStop(org.id, run.id); // any editor may stop it: a stop exposes nothing
    push(run, 'stopping');
    return { ok: true as const };
  });
  ipcMain.handle('eval:runResume', async (_e, p: { projectId: string; runId: string }) => {
    if (!store.dbOrNull()) return needsDb();
    const { org, user } = ctx();
    const run = await store.getRun(org.id, p.runId);
    if (!run || run.projectId.toLowerCase() !== p.projectId.toLowerCase() || run.startedBy !== user.email) return fail(say.notFound()); // it runs as, and is paced by, its runner
    if ((run.state !== 'partial' && run.state !== 'failed') || run.errorCode === 'access') return fail(say.notResumable());
    if (!execConfig.assistantOn() || !(await execConfig.executionReady())) return { ok: false as const, notReady: true, error: say.notReady() };
    if (!(await store.requeue(org.id, run.id))) return fail(say.alreadyRunning());
    push(run, 'queued');
    return { ok: true as const };
  });

  ipcMain.handle('eval:judge', async () => (store.dbOrNull() ? { ok: true as const, pick: await store.judgePick(ctx().org.id) } : needsDb()));
  ipcMain.handle('eval:setJudge', async (_e, p: { pick: { provider: string; model: string } | null }) => {
    if (!store.dbOrNull() || !aiConfig.enabled()) return needsDb();
    if (p.pick) {
      const view = await aiConfig.adminView();
      const pick = p.pick;
      if (!view.models.some((m) => m.provider === pick.provider && m.model === pick.model) || !view.providers.some((x) => x.provider === pick.provider && x.connected)) return fail(say.judgeNotEnabled());
    }
    await store.saveJudge(ctx().org.id, p.pick);
    return { ok: true as const, pick: p.pick };
  });
}
