// The board an editor reads and works (docs/issues-board/00-design.md; contracts in src/api/issues.ts). Every reply carries counts, the
// app's or the model's title and fix, and example QUESTION words with the reason: never an answer, a figure, a row or who asked (people are
// a count). The folder rule is #5's inbox rule (`openRows`): an issue with any signal on a dataset or dashboard closed to the caller is not
// theirs to see, since its title was written from every question (fail closed; an admin opens everything).

import type { SignalKind } from '../../ai/issueSignals';
import { ctx } from '../context';
import { proposeFromQuestions } from '../proposals/proposals';
import * as say from '../issueMessages';
import { openTo } from './open';
import * as store from './db';
import { fallbackFor } from './fallback';
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

/** The issue `id` (or all) as the caller may see it: its title was written from every question of the group, so any of them closed to the caller hides it. */
async function visible(projectId: string, id?: string): Promise<store.Issue[]> {
  return openTo(projectId, await store.board(ctx().org.id, projectId, id));
}

/** The board, with the check's own state (one call: this tab loads it with the rest of the Assistant's settings). */
export async function list(projectId: string) {
  if (!store.dbOrNull()) return { ok: true as const, available: false, issues: [] as IssueView[], trackers: { linear: false, jira: false }, settings: { enabled: false, lastRunAt: null, lastError: null, checking: false } };
  const org = ctx().org.id;
  const issues = await visible(projectId);
  const ids = issues.map((i) => i.id);
  // One statement each, however many issues: the examples, the kinds, the tickets, and one folder lookup per kind for all the examples.
  const [kinds, tickets, rows] = await Promise.all([store.kindsOf(org, ids), store.ticketsOf(org, ids), store.examplesFor(org, projectId, ids, EXAMPLES)]);
  const open = await openTo(projectId, rows);
  const out: IssueView[] = issues.map((i) => {
    const mine = open.filter((e) => e.issue === i.id);
    return {
      id: i.id, title: i.title, fix: i.fix, kind: i.kind, status: i.status, reopened: i.reopened,
      questions: i.questions, people: i.people, kinds: kinds.get(i.id) ?? [], tickets: tickets.get(i.id) ?? [], proposalId: i.proposalId, updatedAt: i.updatedAt,
      examples: mine.map((e) => ({ kind: e.kind, reason: e.reason, question: e.question, at: e.at })),
    };
  });
  return { ok: true as const, available: true, issues: out, trackers: await trackers.connected(), settings: await store.getSettings(org, projectId) };
}

export async function setEnabled(projectId: string, enabled: boolean) {
  if (!store.dbOrNull()) return noDb();
  await store.setEnabled(ctx().org.id, projectId, enabled, ctx().user.email);
  return { ok: true as const };
}

/** The admin's "Check now": asks for the check and returns at once. The org's weekly job (any pod) makes it, and the board shows "checking" until it is done. */
export async function checkNow(projectId: string) {
  if (!store.dbOrNull()) return noDb();
  await store.requestCheck(ctx().org.id, projectId);
  return { ok: true as const, started: true as const };
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
  const rows = await openTo(projectId, await store.examplesFor(org, projectId, [id], ASKERS));
  if (!rows.length) return { ok: false as const, error: say.noOpenQuestions() };
  const r = await proposeFromQuestions(projectId, {
    questions: rows.map((x) => ({ email: x.owner, question: x.question.slice(0, 300), datasetIds: x.datasetIds })),
    datasetIds: [...new Set(rows.flatMap((x) => x.datasetIds))],
  });
  if (r.ok) await store.setProposal(org, id, r.id);
  return r;
}

export async function send(projectId: string, id: string, provider: store.Provider) {
  if (!store.dbOrNull()) return noDb();
  const [issue] = await visible(projectId, id);
  if (!issue) return { ok: false as const, error: say.notFound() };
  const org = ctx().org.id;
  if (!(await trackers.connected())[provider]) return { ok: false as const, error: say.notConnected(trackers.NAMES[provider]) };
  const link = trackers.linkBack(projectId, id);
  if (!link) return { ok: false as const, error: say.noPublicUrl() };
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

