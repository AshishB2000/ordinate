// The board an editor reads and works (docs/issues-board/00-design.md; contracts in src/api/issues.ts). Every reply carries counts, the
// app's or the model's title and fix, and example QUESTION words with the reason: never an answer, a figure, a row or who asked (people are
// a count). The folder rule is #5's inbox rule (`openRows`): an issue with any signal on a dataset or dashboard closed to the caller is not
// theirs to see, since its title was written from every question (fail closed; an admin opens everything).

import type { SignalKind } from '../../ai/issueSignals';
import { ctx } from '../context';
import { openRows } from '../evals/feedback';
import { proposeFromQuestions } from '../proposals/proposals';
import * as say from '../issueMessages';
import * as store from './db';
import { fallbackFor } from './fallback';
import { checkProject } from './weekly';
import * as trackers from './trackers/service';

const EXAMPLES = 5;
const ASKERS = 20;

export interface IssueView {
  id: string; title: string; fix: string; kind: SignalKind; status: store.Status; reopened: number; questions: number; people: number;
  kinds: Array<{ kind: SignalKind; count: number }>;
  examples: Array<{ kind: SignalKind; reason: string | null; question: string; at: string }>;
  tickets: store.TicketRow[]; proposalId: string | null; updatedAt: string;
}

const noDb = () => ({ ok: false as const, error: say.needsDb() });

/** The issue `id` (or all) as the caller may see it. */
async function visible(projectId: string, id?: string): Promise<store.Issue[]> {
  return openRows(projectId, await store.board(ctx().org.id, projectId, id));
}

export async function list(projectId: string): Promise<{ ok: true; available: boolean; issues: IssueView[]; trackers: { linear: boolean; jira: boolean } } | { ok: false; error: string }> {
  if (!store.dbOrNull()) return { ok: true, available: false, issues: [], trackers: { linear: false, jira: false } };
  const org = ctx().org.id;
  const issues = await visible(projectId);
  const ids = issues.map((i) => i.id);
  const [kinds, tickets] = await Promise.all([store.kindsOf(org, ids), store.ticketsOf(org, ids)]);
  const out: IssueView[] = [];
  for (const i of issues) {
    const open = await openRows(projectId, await store.examples(org, projectId, i.id, EXAMPLES));
    out.push({
      id: i.id, title: i.title || fallbackFor({ key: i.key, kind: i.kind, labels: [], questions: open.map((e) => e.question) }).title, fix: i.fix, kind: i.kind, status: i.status, reopened: i.reopened,
      questions: i.questions, people: i.people, kinds: kinds.get(i.id) ?? [], tickets: tickets.get(i.id) ?? [], proposalId: i.proposalId, updatedAt: i.updatedAt,
      examples: open.map((e) => ({ kind: e.kind, reason: e.reason, question: e.question, at: e.at })),
    });
  }
  return { ok: true, available: true, issues: out, trackers: await trackers.connected() };
}

export async function settings(projectId: string) {
  if (!store.dbOrNull()) return { ok: true as const, available: false, enabled: false, lastRunAt: null, lastError: null, trackers: { linear: false, jira: false } };
  return { ok: true as const, available: true, ...(await store.getSettings(ctx().org.id, projectId)), trackers: await trackers.connected() };
}

export async function setEnabled(projectId: string, enabled: boolean) {
  if (!store.dbOrNull()) return noDb();
  await store.setEnabled(ctx().org.id, projectId, enabled, ctx().user.email);
  return { ok: true as const };
}

/** The admin's "Check now": the same check the job makes. */
export async function checkNow(projectId: string) {
  if (!store.dbOrNull()) return noDb();
  const org = ctx().org.id;
  const s = await store.getSettings(org, projectId);
  try {
    const r = await checkProject(projectId, s.lastRunAt ? new Date(s.lastRunAt) : null);
    await store.stamp(org, projectId);
    return { ok: true as const, signals: r.signals, created: r.created, reopened: r.reopened, named: r.named };
  } catch {
    await store.failed(org, projectId, 'failed');
    return { ok: false as const, error: say.checkFailed() };
  }
}

export async function setStatus(projectId: string, id: string, status: store.Status) {
  if (!store.dbOrNull()) return noDb();
  if (!(await visible(projectId, id)).length) return { ok: false as const, error: say.notFound() };
  return (await store.setStatus(ctx().org.id, projectId, id, status, ctx().user.email)) ? { ok: true as const } : { ok: false as const, error: say.notFound() };
}

/** "Propose a definition": #7's `proposeFromQuestions`, as the caller (an editor), with the questions open to them and the datasets they showed. */
export async function propose(projectId: string, id: string) {
  if (!store.dbOrNull()) return noDb();
  if (!(await visible(projectId, id)).length) return { ok: false as const, error: say.notFound() };
  const org = ctx().org.id;
  const rows = await openRows(projectId, await store.examples(org, projectId, id, ASKERS));
  if (!rows.length) return { ok: false as const, error: say.noOpenQuestions() };
  const r = await proposeFromQuestions(projectId, {
    questions: rows.map((x) => ({ email: x.owner, question: x.question.slice(0, 300) })),
    datasetIds: [...new Set(rows.flatMap((x) => x.datasetIds))],
  });
  if (r.ok) await store.setProposal(org, id, r.id);
  return r;
}

export async function send(projectId: string, id: string, provider: store.Provider) {
  if (!store.dbOrNull()) return noDb();
  const [issue] = await visible(projectId, id);
  if (!issue) return { ok: false as const, error: say.notFound() };
  const link = trackers.linkBack(projectId, id);
  if (!link) return { ok: false as const, error: say.noPublicUrl() };
  const org = ctx().org.id;
  if (!(await trackers.connected())[provider]) return { ok: false as const, error: say.notConnected(trackers.NAMES[provider]) };
  if (!(await store.claimTicket(org, id, provider, ctx().user.email))) return { ok: false as const, error: say.alreadySent(trackers.NAMES[provider]) };
  const own = fallbackFor({ key: issue.key, kind: issue.kind, labels: [], questions: [] });
  try {
    const made = await trackers.createTicket(provider, { title: issue.title || own.title, fix: issue.fix || own.fix, questions: issue.questions, people: issue.people, link });
    if (!made.ok) {
      await store.freeTicket(org, id, provider);
      return made;
    }
    await store.fillTicket(org, id, { provider, ref: made.ref, url: made.url });
    return { ok: true as const, ref: made.ref, url: made.url };
  } catch (err) {
    await store.freeTicket(org, id, provider).catch(() => undefined);
    throw err;
  }
}

