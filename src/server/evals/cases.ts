// Making a case from where cases come from (docs/eval-suites/00-design.md, phase 2): a verified question (its spec IS the answer), an
// answer of the caller's own conversation, or a question in the thumbs-down inbox (words or a refusal the editor adds). The browser never
// sends a spec: the server reads it from the stored record, under the caller's folder access.

import { randomUUID } from 'crypto';
import * as copilot from '../../ai/copilot';
import { MAX_CASES, sanitizeExpect, type Expect } from '../../ai/evalChecks';
import { askScope } from '../../ipc/agentAsk';
import { openTurns } from '../../ipc/turnsOpen';
import { listBoth } from '../../analysis/verifiedQuestions';
import { ctx } from '../context';
import * as store from './db';
import * as feedback from './feedback';
import { caseGate } from './view';
import * as say from '../evalMessages';

type From =
  | { kind: 'verified'; id: string; say?: string }
  | { kind: 'turn'; threadId: string; turnId: string; say?: string }
  | { kind: 'inbox'; turnId: string; say?: string; refuse?: boolean };
export interface FromInput { projectId: string; suiteId?: string; newSuite?: { name: string; agentId?: string | null }; from: From }
type Made = { ok: true; suiteId: string; caseId: string } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

interface Source { question: string; expect: Expect | null; source: store.Case['source']; agentId?: string }

async function sourceOf(projectId: string, from: From): Promise<Source | { error: string }> {
  if (from.kind === 'verified') {
    const all = await listBoth(projectId); // already without the questions on a dataset closed to the caller
    const q = all.spec.find((t) => t.rec.id === from.id)?.rec;
    if (q) return { question: q.question, expect: sanitizeExpect({ compute: q.spec, say: from.say }), source: 'verified' };
    return { error: all.sql.some((t) => t.rec.id === from.id) ? say.sqlQuestion() : say.notFound() };
  }
  if (from.kind === 'turn') {
    const turn = await copilot.findTurn(projectId, from.threadId, from.turnId); // the caller's own conversation
    if (!turn || (await openTurns(projectId, [turn])).length !== 1) return { error: say.notFound() };
    if (turn.sql) return { error: say.sqlQuestion() };
    if (!turn.answer) return { error: say.noChart() };
    const history = await copilot.loadHistory(projectId, from.threadId);
    const before = history[history.findIndex((t) => t.id === turn.id) - 1];
    if (before?.role !== 'user' || !before.text.trim()) return { error: say.questionMissing() };
    const expect = sanitizeExpect({ compute: turn.answer, say: from.say });
    if (expect && !(await caseGate(projectId)).visible({ expect })) return { error: say.dataClosed() };
    return { question: before.text.trim().slice(0, 4000), expect, source: 'answer', agentId: await copilot.agentOf(projectId, from.threadId) };
  }
  const question = await feedback.inboxQuestion(projectId, from.turnId);
  if (!question) return { error: say.inboxGone() };
  return { question, expect: sanitizeExpect({ refuse: from.refuse === true ? true : undefined, say: from.say }), source: 'inbox' };
}

export async function caseFrom(p: FromInput): Promise<Made> {
  const org = ctx().org.id;
  const by = ctx().user.email;
  const src = await sourceOf(p.projectId, p.from);
  if ('error' in src) return fail(src.error);
  if (!src.expect) return fail(say.badCase());
  let suiteId = p.suiteId;
  if (suiteId) {
    if (!(await store.getSuite(org, p.projectId, suiteId))) return fail(say.notFound());
  } else if (p.newSuite) {
    const agentId = p.newSuite.agentId === undefined ? src.agentId ?? null : p.newSuite.agentId;
    if (agentId && (await askScope(p.projectId, agentId)).agent?.id !== agentId) return fail(say.agentNotYours());
    const made = await store.createSuite(org, { id: randomUUID(), projectId: p.projectId, name: p.newSuite.name, agentId, by });
    if (!made) return fail(say.tooManySuites(String(store.MAX_SUITES)));
    suiteId = made.id;
  } else {
    return fail(say.notFound());
  }
  const id = randomUUID();
  const added = await store.addCase(org, p.projectId, suiteId, { id, question: src.question, expect: src.expect, source: src.source, by });
  if (added === 'full') return fail(say.suiteFull(String(MAX_CASES)));
  if (added === 'gone') return fail(say.notFound());
  if (p.from.kind === 'inbox') await feedback.handle(p.projectId, p.from.turnId);
  return { ok: true, suiteId, caseId: id };
}
