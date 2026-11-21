// Metric proposals (docs/metric-proposals/00-design.md). A refused answer names something that is not defined; anyone who
// can read the project may ask for a definition; an editor reviews it (a live preview, computed by the engine for them),
// approves it, edits it or declines it; the people who asked are told.
//
// NOTHING IS SAVED UNTIL APPROVAL, AND NO FIGURE IS STORED. A proposal is a row (0047) holding the model's STRUCTURE (a
// name, a formula or a column and aggregation, a description, other names; a term's filters), checked as the person
// acting: the columns it may use are those of a dataset they open, minus the ones hidden from them (./check.ts). Approval
// re-checks it as the approving editor and saves through the checked saves (`saveMetricChecked`, `saveTermChecked`), so a
// proposal can save nothing the editor could not save by hand. The preview is not a channel of its own: the card calls
// `metric:check` / `metric:preview` as the reviewer.
//
// ONE CARD PER NEED: a repeat proposal of the same kind and name raises the open one's count (the store's partial unique
// index decides, so two at once make one card). A person counts once per question.
//
// FOR FEATURE 8 (the issues board): `proposeFromQuestions` drafts from a group of questions and raises the card;
// `raiseProposal` raises a draft already made. Both run as the caller, who must read the project.

import * as analyze from '../../ai/analyze';
import * as copilot from '../../ai/copilot';
import * as execConfig from '../../app/execConfig';
import { assistantOff } from '../../ai/aiMessages';
import * as metrics from '../../analysis/metrics';
import { listFullTerms } from '../../analysis/terms';
import { parseDraft, proposeUser, PROPOSE_SYSTEM, type DraftIn } from '../../ai/proposalDraft';
import { contracts } from '../../api/index';
import { personName } from '../../app/mentionToken';
import { logger } from '../../app/logger';
import * as versionsMod from '../../app/versions';
import { saveMetricChecked } from '../../ipc/metricSave';
import { saveTermChecked } from '../../ipc/terms';
import { openers } from '../authz/folderGate';
import { datasetsAt, editsOnly, mustEdit } from '../authz/folderWrites';
import * as counters from '../counters';
import { ctx } from '../context';
import { orgDb } from '../db/inOrg';
import * as say from '../proposalMessages';
import { checkDraft, visibleDataset, type VisibleDataset } from './check';
import * as store from './store';
import type { Proposal, StoredDraft } from './store';
import { background, tellApprovers, tellAskers } from './tell';

export { proposalsSettled } from './tell';

/** Definitions one person may ask the model to draft a day, across projects. */
export const PROPOSALS_PER_DAY = 10;
const DAY = 86_400_000;
/** Datasets, and questions, one draft call is told about. */
const MAX_DATASETS = 6;
const MAX_QUESTIONS = 20;
const MAX_NAMES = 100;

export type RaiseReply = { ok: true; id: string; raised: boolean; asks: number } | { ok: false; error: string; notReady?: true; code?: 'rate_limited' | 'too_many_open' };
export interface QuestionAsk { email: string; question: string }

/** The editors and admins with Edit on the dataset, never the caller (they are not told of their own proposal). */
async function approversOf(projectId: string, datasetId: string): Promise<string[]> {
  const pool = orgDb();
  if (!pool) return [];
  const me = ctx().user.email.toLowerCase();
  return (await openers(pool, ctx().org.id, projectId, { kind: 'dataset', id: datasetId }, 'edit')).map((e) => e.toLowerCase()).filter((e) => e !== me);
}

/** Raises a draft the model (or a caller) already made: checked as the caller, then one card per need. */
export async function raiseProposal(projectId: string, draft: DraftIn, asks: readonly QuestionAsk[]): Promise<RaiseReply> {
  if (!orgDb()) return { ok: false, error: say.proposalsOff() };
  const clean = asks.filter((a) => a.email.includes('@') && a.question.trim()).slice(0, 200);
  if (!clean.length) return { ok: false, error: say.notRefusedAnswer() };
  const checked = await checkDraft(projectId, draft);
  if (!checked.ok) return { ok: false, error: checked.error };
  const approvers = await approversOf(projectId, checked.draft.datasetId);
  const made = await store.openOrRaise(projectId, checked.draft, clean, approvers);
  if (!made) return { ok: false, code: 'too_many_open', error: say.tooManyOpen(store.MAX_OPEN) };
  if (made.created) background(tellApprovers(made.proposal, approvers, ctx().user.email));
  return { ok: true, id: made.proposal.id, raised: !made.created, asks: made.proposal.asks };
}

/**
 * The model's draft from a group of questions over `datasetIds` (only the ones the caller opens are told), then the card.
 * The reply of the model is parsed and checked, never repaired; a refusal is given back its sentence and costs no card.
 */
export async function proposeFromQuestions(projectId: string, input: { questions: readonly QuestionAsk[]; datasetIds: readonly string[] }): Promise<RaiseReply> {
  if (!orgDb()) return { ok: false, error: say.proposalsOff() };
  if (!(await execConfig.executionReady())) return { ok: false, notReady: true, error: assistantOff() };
  const { org, user } = ctx();
  const asks = input.questions.slice(0, MAX_QUESTIONS);
  const visible: VisibleDataset[] = [];
  for (const id of new Set(input.datasetIds)) {
    const d = visible.length < MAX_DATASETS ? await visibleDataset(projectId, id) : null;
    if (d) visible.push(d);
  }
  if (!visible.length) return { ok: false, error: say.noDataset() };
  const mine = await counters.take(org.id, [{ key: `proposal:from:${user.email.toLowerCase()}`, limit: PROPOSALS_PER_DAY, windowMs: DAY }]);
  if (!mine.ok) return { ok: false, code: 'rate_limited', error: say.tooManyToday(PROPOSALS_PER_DAY) };
  const giveBack = async (): Promise<void> => counters.give(org.id, mine.windows, 1);
  try {
    const taken = [...(await metrics.listMetrics(projectId)).map((m) => m.name), ...(await listFullTerms(projectId)).map((t) => t.name)].slice(0, MAX_NAMES);
    const text = proposeUser(asks.map((a) => a.question), visible, taken);
    const { rawText, error } = await analyze.dispatch(PROPOSE_SYSTEM, [{ role: 'user', text }]);
    if (error) {
      await giveBack();
      return { ok: false, error: say.modelFailed() };
    }
    const parsed = parseDraft(rawText);
    if (!parsed.ok) {
      await giveBack();
      return { ok: false, error: parsed.code === 'figure_text' ? say.figureInDraft() : say.badDraft() };
    }
    if ('none' in parsed) {
      await giveBack();
      return { ok: false, error: say.nothingToDefine() };
    }
    // The model names a dataset: only one it was told about counts (never another the caller happens to open).
    const named = visible.find((d) => d.name.trim().toLowerCase() === parsed.draft.dataset.trim().toLowerCase());
    if (!named) {
      await giveBack();
      return { ok: false, error: say.datasetNotFound(parsed.draft.dataset) };
    }
    const { dataset: _name, ...rest } = parsed.draft;
    const r = await raiseProposal(projectId, { ...rest, datasetId: named.id } as DraftIn, asks);
    if (!r.ok) await giveBack();
    return r;
  } catch (err) {
    await giveBack();
    throw err;
  }
}

/** `proposal:propose`: the caller's own refused turn becomes the question; the datasets its answer read are the model's facts. */
export async function proposeFromTurn(projectId: string, threadId: string, turnId: string): Promise<RaiseReply> {
  if (!orgDb()) return { ok: false, error: say.proposalsOff() };
  const turn = await copilot.findTurn(projectId, threadId, turnId); // the caller's own conversation only
  if (!turn || !turn.define) return { ok: false, error: say.notRefusedAnswer() };
  const history = await copilot.loadHistory(projectId, threadId);
  const at = history.findIndex((t) => t.id === turnId);
  const asked = history.slice(0, Math.max(at, 0)).reverse().find((t) => t.role === 'user');
  if (!asked || !asked.text.trim()) return { ok: false, error: say.notRefusedAnswer() };
  return proposeFromQuestions(projectId, { questions: [{ email: ctx().user.email, question: asked.text }], datasetIds: turn.factsFrom ?? [] });
}

// ── The queue ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProposalView {
  id: string;
  kind: 'metric' | 'term';
  name: string;
  datasetId: string;
  datasetName: string;
  description: string;
  aliases: string[];
  formula?: string;
  column?: string;
  aggregation?: string;
  format?: string;
  filters?: Array<{ column: string; op: string; value?: unknown; values?: unknown[] }>;
  asks: number;
  /** A few of the questions that needed it: their words, never an answer or a figure. */
  questions: string[];
  state: store.ProposalState;
  decidedBy: string;
  answer: string;
  edited: boolean;
  savedId: string | null;
  createdAt: string;
  /** An open draft that no longer passes the reviewer's checks (a column gone or hidden from them): why. */
  problem?: string;
}

/** A stored draft as `checkDraft` takes it: filters as the model wrote them. */
function toIn(d: StoredDraft, datasetId = d.datasetId): DraftIn {
  const base = { name: d.name, datasetId, description: d.description, aliases: d.aliases };
  if (d.kind === 'term') {
    const filters = (Array.isArray(d.filters) ? d.filters : []) as Array<{ column: string; op: never; value?: string | number; values?: Array<string | number> }>;
    return { kind: 'term', ...base, filters: filters.map((f) => ({ column: f.column, op: f.op, ...(f.values ? { values: f.values } : { value: f.value }) })) } as DraftIn;
  }
  return { kind: 'metric', ...base, ...(typeof d.formula === 'string' ? { formula: d.formula } : { column: d.column, aggregation: d.aggregation }), ...(d.format ? { format: d.format } : {}) } as DraftIn;
}

async function viewOf(p: Proposal, datasetName: string, problem?: string): Promise<ProposalView> {
  const d = p.draft;
  return {
    id: p.id, kind: p.kind, name: p.name, datasetId: p.datasetId, datasetName, description: d.description, aliases: d.aliases,
    ...(typeof d.formula === 'string' ? { formula: d.formula } : {}), ...(typeof d.column === 'string' ? { column: d.column, aggregation: String(d.aggregation) } : {}),
    ...(typeof d.format === 'string' ? { format: d.format } : {}), ...(p.kind === 'term' ? { filters: (d.filters ?? []) as ProposalView['filters'] } : {}),
    asks: p.asks, questions: await store.questions(p.id, 5), state: p.state, decidedBy: p.decidedBy && p.state !== 'open' ? personName(p.decidedBy) : '',
    answer: p.answer, edited: p.edited, savedId: p.savedId, createdAt: p.createdAt, ...(problem ? { problem } : {}),
  };
}

/** The reviewer's cards: the proposals whose dataset they edit, each open one re-checked as them. */
export async function listProposals(projectId: string, decided: boolean): Promise<{ ok: true; proposals: ProposalView[] } | { ok: false; error: string }> {
  if (!orgDb()) return { ok: false, error: say.proposalsOff() };
  const all = await store.list(projectId, decided, 100);
  const may = new Set(await editsOnly(projectId, [...new Set(all.map((p) => p.datasetId))]));
  const out: ProposalView[] = [];
  for (const p of all.filter((x) => may.has(x.datasetId))) {
    const ds = await visibleDataset(projectId, p.datasetId);
    const problem = p.state === 'open' ? (ds ? await checkDraft(projectId, toIn(p.draft), false).then((c) => (c.ok ? undefined : c.error)) : say.datasetNotFound('')) : undefined;
    out.push(await viewOf(p, ds?.name ?? '', problem));
  }
  return { ok: true, proposals: out };
}

/** An approver's read (`mustEdit` on the dataset), or null. */
async function forApprover(projectId: string, id: string): Promise<Proposal | null> {
  if (!orgDb()) return null;
  const p = await store.get(projectId, id);
  if (p) await mustEdit(projectId, datasetsAt([p.datasetId]));
  return p;
}

export interface Edit { name?: string; description?: string; aliases?: string[]; formula?: string }
export type DecideReply = { ok: true; savedId: string } | { ok: false; error: string };

/** Approve as is, or with an edit (a name, words, a metric's formula): re-checked as the caller, then the checked save. */
export async function approveProposal(projectId: string, id: string, edit?: Edit): Promise<DecideReply> {
  const p = await forApprover(projectId, id);
  if (!p) return { ok: false, error: orgDb() ? say.proposalGone() : say.proposalsOff() };
  if (p.state !== 'open') return { ok: false, error: say.alreadyDecided() };
  const d: StoredDraft = { ...p.draft };
  if (edit?.name !== undefined) d.name = edit.name.trim();
  if (edit?.description !== undefined) d.description = edit.description.trim();
  if (edit?.aliases !== undefined) d.aliases = edit.aliases;
  if (edit?.formula !== undefined) {
    if (p.kind !== 'metric' || typeof p.draft.formula !== 'string') return { ok: false, error: say.invalidEdit() };
    d.formula = edit.formula.trim();
  }
  const edited = JSON.stringify(d) !== JSON.stringify(p.draft);
  if (!(await store.claim(projectId, id))) return { ok: false, error: say.beingDecided() };
  try {
    const checked = await checkDraft(projectId, toIn(d), false); // as the approving editor: their view of the columns
    if (!checked.ok) {
      await store.release(projectId, id);
      return { ok: false, error: checked.error };
    }
    const c = checked.draft;
    const mark = { proposal: { asks: p.asks } } satisfies versionsMod.RecordOpts;
    let savedId: string | undefined;
    let why = '';
    if (c.kind === 'metric') {
      const words = c.aliases.length ? `${c.description} ${say.alsoCalled(c.aliases.join(', '))}`.trim() : c.description;
      const input = { name: c.name, datasetId: c.datasetId, definition: typeof c.formula === 'string' ? { formula: c.formula } : { column: c.column, aggregation: c.aggregation }, description: words, ...(c.format ? { format: { kind: c.format } } : {}) };
      const parsed = contracts['metric:save'].input.safeParse({ projectId, input });
      if (!parsed.success) why = say.badDraft();
      else {
        const r = await saveMetricChecked(projectId, parsed.data.input, mark);
        if (r.ok && 'metric' in r && r.metric) savedId = r.metric.id; else why = (r as { error?: string }).error ?? '';
      }
    } else {
      const input = { name: c.name, aliases: c.aliases, description: c.description, datasetId: c.datasetId, filters: c.filters };
      const parsed = contracts['term:save'].input.safeParse({ projectId, input });
      if (!parsed.success) why = say.badDraft();
      else {
        const r = await saveTermChecked(projectId, parsed.data.input as never, mark);
        if (r.ok && 'term' in r && r.term) savedId = r.term.id; else why = (r as { error?: string }).error ?? '';
      }
    }
    if (!savedId) {
      await store.release(projectId, id);
      return { ok: false, error: say.savedFailed(why) };
    }
    const done = await store.finish(projectId, id, { state: 'approved', savedId, edited });
    if (done) background(tellAskers(done.proposal, done.told));
    else logger.warn('[proposals] approved and saved, but the decision was taken by another approval');
    return { ok: true, savedId };
  } catch (err) {
    await store.release(projectId, id).catch(() => undefined);
    throw err;
  }
}

/** Decline with a note: nothing is saved, and the people who asked are told with the note. */
export async function declineProposal(projectId: string, id: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const p = await forApprover(projectId, id);
  if (!p) return { ok: false, error: orgDb() ? say.proposalGone() : say.proposalsOff() };
  if (p.state !== 'open') return { ok: false, error: say.alreadyDecided() };
  const done = await store.finish(projectId, id, { state: 'declined', answer: note.trim().slice(0, 2000) });
  if (!done) return { ok: false, error: say.beingDecided() };
  background(tellAskers(done.proposal, done.told));
  return { ok: true };
}

/** The bell's rows (the mention path's `mentions:list`): approvers' open cards and askers' outcomes. */
export interface ProposalRow {
  projectId: string; id: string; kind: 'metric' | 'term'; name: string; state: store.ProposalState; decidedBy: string; answer: string;
  asks: number; question: string; at: string; seen: boolean; mine: boolean;
}

export async function listInbox(limit: number): Promise<ProposalRow[]> {
  return (await store.listInbox(limit)).map((x) => ({
    projectId: x.projectId, id: x.id, kind: x.kind, name: x.name, state: x.state, decidedBy: x.state !== 'open' && x.decidedBy ? personName(x.decidedBy) : '',
    answer: x.answer, asks: x.asks, question: x.role === 'asker' ? x.question : '', at: x.at, seen: x.seen, mine: x.role === 'asker',
  }));
}
