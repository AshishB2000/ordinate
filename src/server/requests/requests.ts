// Dashboard requests (docs/team-folders/00-design.md D20 and "Dashboard requests"; docs/assistant/00-design.md "Viewers
// request, editors approve"). A viewer who cannot keep an answer asks for a dashboard of it; an editor approves it,
// opens it as a draft, or declines it with a note; the viewer is told.
//
// NOTHING IS MADE UNTIL APPROVAL, AND NO FIGURE IS STORED. A request is one row (0037) holding each answer's chart form
// — the spec its turn stored, never the turn's words or kept card, which carry figures. The review computes every chart
// now, through THE answer door (`computeCard`: folders, row access rules, hidden columns), as the reviewer; approving
// computes them again the same way (`planOf`, one function for both) and makes exactly that: each chart saved as a
// visual (`saveCardAsVisual`, Save as visual's path), one dashboard holding them (the plan builder's arrangement and
// card whitelist), landed where E6 lands a derived item (`landsIn`: the folder of its first dataset outside Everyone,
// else Everyone, placed before the record is written), and published through Publish itself.
//
// WHO. The requester: anyone who reads the project, on their own answer turns (`findTurn` reads the caller's threads
// only), on datasets they open. The approvers: editors and admins with Edit on every dataset the charts read
// (`openers` at 'edit', per dataset, intersected), never the requester — they are told (bell, push, email if on), and
// only they may review, approve or decline (`mustEdit`: below Edit refuses `edit`, a closed dataset `closed`).
//
// WHERE. A new dashboard lands where E6 lands a derived item — or in the folder the requester suggested, or the reviewer
// picked, among those the reviewer edits and the requester opens (./where.ts). A request may instead name an existing
// dashboard the requester opens: approving adds the charts to its draft on a sheet of their own (Edit on its folder),
// and Approve and publish publishes it — unless its draft already had edits nobody published.
//
// THE MENTION PATH, as Ask an editor (./tell.ts): the rows are the gate; the push and the email never stand in the
// send's way. NOT TWICE, NOT A FLOOD: the same charts from the same person in the same project within a day are
// "already sent"; at most REQUESTS_PER_DAY a person a day, across projects (shared counters), and OPEN_PER_PROJECT open
// at once in a project; a refused or failed send is given back. The requester may withdraw an open request.

import { createHash, randomUUID } from 'crypto';
import * as analysis from '../../analysis/analysis';
import * as dashboards from '../../analysis/dashboards';
import { arrangeSheet } from '../../analysis/planLayout';
import type { PlannedVisual } from '../../analysis/analysisPlan';
import * as drafts from '../../analysis/publishDashboard';
import { statusOf } from '../../analysis/publishedCopy';
import * as copilot from '../../ai/copilot';
import { sanitizeStoredSpec, type AnswerSpec } from '../../ai/answerSpec';
import { relatedIds } from '../../ai/answerJoin';
import * as config from '../../app/config';
import * as datasets from '../../data/datasets';
import { personName } from '../../app/mentionToken';
import * as versions from '../../app/versions';
import { logger } from '../../app/logger';
import { stableStringify } from '../../engine/queryCache';
import { computeCard, type Built, type Failure } from '../../ipc/answers';
import { saveCardAsVisual } from '../../ipc/answerSave';
import { openers } from '../authz/folderGate';
import { FolderError, placementOf } from '../authz/folders';
import { datasetsAt, landsIn, mustEdit, mustOpen, withLanding, type Anchor } from '../authz/folderWrites';
import * as counters from '../counters';
import { ctx } from '../context';
import { orgDb } from '../db/inOrg';
import * as say from '../requestMessages';
import * as store from './store';
import type { DashboardRequest } from './store';
import { background, tellApprovers, tellRequester, tellWithdrawn } from './tell';
import { asMember, folderChoices, folderName, foldersOpen, type FolderChoice } from './where';
import { lockPrint } from '../../ipc/answerSnapshots';

export { requestsSettled, type RequestNotice } from './tell';

/** Requests one person may send a day, across projects. */
export const REQUESTS_PER_DAY = 10;
/** Requests one person may have open at once in one project. */
export const OPEN_PER_PROJECT = 20;
const DAY = 86_400_000;

export type CreateReply = { ok: true; id?: string; already?: true } | { ok: false; error: string; code?: 'rate_limited' | 'too_many_open' };

const datasetIdsOf = (charts: readonly AnswerSpec[]): string[] => [...new Set(charts.map((c) => c.datasetId.toLowerCase()))];
/** Every dataset a chart reads: its own, and a related category's or split's (../../ai/answerJoin). */
const readsOf = (c: AnswerSpec): string[] => [c.datasetId, ...relatedIds(c)].map((id) => id.toLowerCase());
const readIdsOf = (charts: readonly AnswerSpec[]): string[] => [...new Set(charts.flatMap(readsOf))];
/** What an approver needs Edit on: every dataset the charts read, and the dashboard they go onto. */
const anchorsOf = (r: Pick<DashboardRequest, 'charts' | 'targetId'>): Anchor[] => [...datasetsAt(readIdsOf(r.charts)), ...(r.targetId ? [{ kind: 'dashboard' as const, id: r.targetId }] : [])];

/** Editors and admins with Edit on every anchor, never the requester: `openers` per anchor, intersected. */
async function approversOf(projectId: string, anchors: readonly Anchor[], requester: string): Promise<string[]> {
  const pool = orgDb();
  if (!pool) return [];
  let out: string[] | null = null;
  for (const a of anchors) {
    const these = new Set((await openers(pool, ctx().org.id, projectId, a, 'edit')).map((e) => e.toLowerCase()));
    out = (out ?? [...these]).filter((e) => these.has(e));
  }
  return (out ?? []).filter((e) => e !== requester.toLowerCase());
}

/** Who asked for which charts on what in a project — hashed, so no chart sits in a counter key. */
function sameKey(projectId: string, requester: string, charts: readonly AnswerSpec[], targetId: string | null): string {
  return 'request:same:' + createHash('sha256').update([requester.toLowerCase(), projectId.toLowerCase(), targetId ?? '', stableStringify(charts)].join('\0')).digest('hex').slice(0, 32);
}

/** A turn's chart form — never its words or kept card — or the sentence why it has none. */
function chartOf(turn: copilot.CopilotTurn): AnswerSpec | string {
  if (turn.sql) return say.sqlNotAChart();
  if (turn.answer?.table) return say.keepTableFirst(); // a warehouse table's answer: a dataset first, an editor's to keep
  return (turn.answer && sanitizeStoredSpec(turn.answer)) || say.notAChart();
}

export interface CreateInput {
  threadId: string;
  turnIds: string[];
  title: string;
  note?: string;
  /** An existing dashboard (one the caller opens) the charts go onto. */
  dashboardId?: string;
  /** A folder (one the caller opens) suggested for a new dashboard. */
  folderId?: string;
}

/** The caller asks for a dashboard of their answer turns `turnIds` in `threadId`. */
export async function createRequest(projectId: string, input: CreateInput): Promise<CreateReply> {
  if (!orgDb()) return { ok: false, error: say.requestsOff() };
  const { org, user } = ctx();
  const charts: AnswerSpec[] = [];
  for (const turnId of new Set(input.turnIds)) {
    const turn = await copilot.findTurn(projectId, input.threadId, turnId); // the caller's own threads only
    if (!turn) return { ok: false, error: say.notYourAnswer() };
    const chart = chartOf(turn);
    if (typeof chart === 'string') return { ok: false, error: chart };
    charts.push(chart);
  }
  const ids = readIdsOf(charts);
  await mustOpen(projectId, datasetsAt(ids)); // a dataset the requester cannot open: `closed`
  for (const id of ids) if (!(await datasets.getDatasetMeta(projectId, id))) return { ok: false, error: say.datasetGone() };
  let title = input.title.trim().slice(0, 120);
  let targetId: string | null = null;
  let folderId: string | null = null;
  if (input.dashboardId) {
    const target = await analysis.getAnalysis(projectId, input.dashboardId); // as the requester: closed, a draft they cannot read, or none is null
    if (!target) return { ok: false, error: say.dashboardGone() };
    [targetId, title] = [target.id.toLowerCase(), target.name.slice(0, 120)];
  } else if (input.folderId) {
    folderId = input.folderId.toLowerCase();
    if (!(await foldersOpen(projectId)).some((f) => f.id === folderId)) throw new FolderError('closed'); // closed or none: it names nothing
  }
  const approvers = await approversOf(projectId, anchorsOf({ charts, targetId }), user.email);
  if (!approvers.length) return { ok: false, error: say.noApprovers() };

  const same = await counters.take(org.id, [{ key: sameKey(projectId, user.email, charts, targetId), limit: 1, windowMs: DAY }]);
  if (!same.ok) return { ok: true, already: true };
  const mine = await counters.take(org.id, [{ key: `request:from:${user.email.toLowerCase()}`, limit: REQUESTS_PER_DAY, windowMs: DAY }]);
  const giveBack = async (): Promise<void> => {
    await counters.give(org.id, same.windows, 1); // refused: it is not "already sent" tomorrow
    if (mine.ok) await counters.give(org.id, mine.windows, 1);
  };
  if (!mine.ok) {
    await giveBack();
    return { ok: false, code: 'rate_limited', error: say.tooManyRequests(REQUESTS_PER_DAY) };
  }
  const req = { id: randomUUID(), projectId, requester: user.email, title, note: (input.note ?? '').trim().slice(0, 2000), charts, targetId, folderId };
  let stored: boolean;
  try {
    stored = await store.insertRequest(req, approvers, OPEN_PER_PROJECT);
  } catch (err) {
    await giveBack();
    throw err;
  }
  if (!stored) {
    await giveBack();
    return { ok: false, code: 'too_many_open', error: say.tooManyOpen(OPEN_PER_PROJECT) };
  }
  background(tellApprovers(req, approvers));
  return { ok: true, id: req.id };
}

export type WithdrawReply = { ok: true } | { ok: false; error: string };

/** The requester takes their open request back: nothing is made, and the approvers' bell rows go. */
export async function withdrawRequest(projectId: string, id: string): Promise<WithdrawReply> {
  if (!orgDb()) return { ok: false, error: say.requestsOff() };
  const done = await store.withdraw(projectId, id);
  if (done) {
    const r = done.request;
    await counters.clear(ctx().org.id, sameKey(projectId, r.requester, r.charts, r.targetId)); // asked again, it is not "already sent"
    background(tellWithdrawn(r, done.told));
    return { ok: true };
  }
  const r = await store.getRequest(projectId, id);
  if (!r || r.requester !== ctx().user.email) return { ok: false, error: say.requestGone() }; // someone else's: as none
  return { ok: false, error: r.state === 'open' ? say.beingApproved() : say.alreadyDecided() };
}

/** The folders a requester may suggest: those they open. */
export async function requestFolders(projectId: string): Promise<{ ok: true; folders: FolderChoice[] }> {
  return { ok: true, folders: orgDb() ? await foldersOpen(projectId) : [] };
}

/**
 * A chart as the review page draws it: the engine's figures, formatted by the server; or why it cannot be drawn.
 * `fewerRows`: the line saying the requester's figures would differ — a row rule holds them to other rows than the
 * reviewer's on its dataset (their row lock prints differ). Only the comparison: never a figure or row of theirs.
 */
export type CardView =
  | { ok: true; title: string; chartType: string; datasetName: string; data: Built['card']['data']; headline: Built['card']['headline']; caption: string; notes: string[]; filterLabels: string[]; fewerRows?: string }
  | { ok: false; reason: string };

/** What approving makes, as the review page lists it. */
export interface Creates {
  /** One visual per chart, by name, in order. */
  visuals: string[];
  dashboard: string;
  /** Where it lands, by name, and its id (a new dashboard: the reviewer may pick another of the choices). */
  folder: string;
  folderId: string;
  /** An existing dashboard: the sheet the charts go on, and whether Approve and publish publishes it. */
  onto?: { sheet: string; publishes: boolean };
}

interface Plan {
  built: Array<Built | Failure>;
  folderId: string;
  creates: Creates;
  /** A new dashboard's folders the reviewer may pick. */
  choices: FolderChoice[];
  /** Why nothing can be approved (the dashboard it is for is gone). */
  problem?: string;
}

/**
 * The ONE function the review and the approval share: every chart through the door as the caller, and where it goes —
 * onto the existing dashboard, or a new one in `pick`, the requester's suggestion, or E6's landing, the first two only
 * when among the choices (the reviewer edits it, the requester opens it).
 */
async function planOf(r: DashboardRequest, pick?: string): Promise<Plan> {
  const built: Array<Built | Failure> = [];
  for (const spec of r.charts) built.push(await computeCard(r.projectId, spec));
  const visuals = built.map((b, i) => ('card' in b ? b.card.title : r.charts[i].title));
  if (r.targetId) {
    const target = await analysis.getStoredAnalysis(r.projectId, r.targetId);
    const folderId = (await placementOf(r.projectId, 'dashboard', [r.targetId])).get(r.targetId) ?? r.projectId.toLowerCase();
    const onto = target ? { sheet: say.requestedBySheet(personName(r.requester)), publishes: statusOf(target) !== 'edited' } : undefined;
    const creates = { visuals, dashboard: target?.name ?? r.title, folder: await folderName(r.projectId, folderId), folderId, ...(onto ? { onto } : {}) };
    return { built, folderId, creates, choices: [], ...(target ? {} : { problem: say.targetGone() }) };
  }
  const choices = await folderChoices(r.projectId, r.requester);
  const wanted = (pick ?? r.folderId ?? '').toLowerCase();
  const folderId = await landsIn(r.projectId, choices.some((c) => c.id === wanted) ? wanted : undefined, datasetIdsOf(r.charts)); // refuses unless the caller edits it
  return { built, folderId, choices, creates: { visuals, dashboard: r.title, folder: await folderName(r.projectId, folderId), folderId } };
}

function cardView(b: Built | Failure, fewerRows?: string): CardView {
  if (!('card' in b)) return { ok: false, reason: b.reason };
  const c = b.card;
  return { ok: true, title: c.title, chartType: c.chartType, datasetName: c.datasetName, data: c.data, headline: c.headline, caption: c.caption, notes: c.notes, filterLabels: c.filterLabels, ...(fewerRows ? { fewerRows } : {}) };
}

/**
 * The datasets of `charts` on which a row rule holds the requester to other rows than the caller (the reviewer): their
 * row lock prints, each worked out in a context of its own, differ, and the requester's is a lock (none: they see more).
 * Records only, never a row; an account gone or disabled names none.
 */
async function fewerRowsOn(r: DashboardRequest): Promise<Set<string>> {
  const ids = readIdsOf(r.charts);
  const theirs = await asMember(r.requester, () => Promise.all(ids.map((id) => lockPrint(r.projectId, id))));
  const out = new Set<string>();
  for (const [i, id] of ids.entries()) {
    const them = theirs?.[i];
    if (them !== undefined && them !== null && stableStringify(them) !== stableStringify(await lockPrint(r.projectId, id))) out.add(id);
  }
  return out;
}

/** The request as its page shows it: names, never an address. */
export interface RequestView {
  projectId: string;
  id: string;
  by: string;
  title: string;
  note: string;
  charts: number;
  state: store.RequestState;
  decidedBy: string;
  answer: string;
  dashboardId: string | null;
  /** It names an existing dashboard (its name is the title). */
  onto: boolean;
  at: string;
}

function viewOf(r: DashboardRequest): RequestView {
  return {
    projectId: r.projectId, id: r.id, by: personName(r.requester), title: r.title, note: r.note, charts: r.charts.length, state: r.state,
    decidedBy: r.state !== 'open' && r.decidedBy ? personName(r.decidedBy) : '', answer: r.answer, dashboardId: r.dashboardId, onto: r.targetId !== null, at: r.createdAt,
  };
}

/** An approver's read of a request (`mustEdit` on every dataset it reads, and the dashboard it names), or null when there is none. */
async function forApprover(projectId: string, id: string): Promise<DashboardRequest | null> {
  if (!orgDb()) return null;
  const r = await store.getRequest(projectId, id);
  if (r) await mustEdit(projectId, anchorsOf(r));
  return r;
}

export type PreviewReply =
  | { ok: true; request: RequestView; cards: CardView[]; creates: Creates | null; choices: FolderChoice[]; suggested: string; problem?: string }
  | { ok: false; error: string };

/** The review page: the request, and while it is open, its charts computed now as the caller and what approving makes. */
export async function previewRequest(projectId: string, id: string): Promise<PreviewReply> {
  const r = await forApprover(projectId, id);
  if (!r) return { ok: false, error: orgDb() ? say.requestGone() : say.requestsOff() };
  if (r.state !== 'open') return { ok: true, request: viewOf(r), cards: [], creates: null, choices: [], suggested: '' };
  const plan = await planOf(r);
  // The requester's suggestion by name, when the reviewer opens it (a closed folder's name is never shown).
  const suggested = r.folderId ? ((await foldersOpen(projectId)).find((f) => f.id === r.folderId)?.name ?? '') : '';
  const fewer = await fewerRowsOn(r);
  const line = say.seesFewerRows(personName(r.requester));
  const cards = plan.built.map((b, i) => cardView(b, readsOf(r.charts[i]).some((id) => fewer.has(id)) ? line : undefined));
  return { ok: true, request: viewOf(r), cards, creates: plan.creates, choices: plan.choices, suggested, ...(plan.problem ? { problem: plan.problem } : {}) };
}

export type ApproveReply = { ok: true; dashboardId: string; published: boolean; creates: Creates; why?: string } | { ok: false; error: string };

/** Approve and publish, or Edit (`publish` false: a draft only editors see, published by them later); `folderId`, a new dashboard's folder among the choices. */
export async function approveRequest(projectId: string, id: string, publishIt: boolean, folderId?: string): Promise<ApproveReply> {
  const r = await forApprover(projectId, id);
  if (!r) return { ok: false, error: orgDb() ? say.requestGone() : say.requestsOff() };
  if (r.state !== 'open') return { ok: false, error: say.alreadyDecided() };
  const pick = folderId !== undefined && !r.targetId ? folderId.toLowerCase() : undefined;
  if (pick !== undefined && !(await folderChoices(projectId, r.requester)).some((c) => c.id === pick)) return { ok: false, error: say.folderNotOffered(personName(r.requester)) };
  if (!(await store.claim(projectId, id))) return { ok: false, error: say.beingApproved() };
  let made: analysis.Analysis | null = null;
  try {
    const plan = await planOf(r, pick);
    const bad = plan.built.findIndex((b) => !('card' in b));
    if (plan.problem || bad >= 0) {
      await store.release(projectId, id);
      return { ok: false, error: plan.problem ?? say.chartNotDrawn(r.charts[bad].title, (plan.built[bad] as Failure).reason) };
    }
    let edited = false;
    if (r.targetId) {
      const added = await addTo(r, plan.built as Built[], r.targetId);
      [made, edited] = [added?.a ?? null, added?.edited ?? false];
    } else {
      made = await withLanding(projectId, plan.folderId, () => build(r, plan.built as Built[]));
    }
    if (!made) {
      await store.release(projectId, id);
      return { ok: false, error: say.notMade() };
    }
    const published = publishIt && !edited && !!(await drafts.publish(projectId, made.id));
    const done = await store.finish(projectId, id, { state: published ? 'approved' : 'drafted', dashboardId: made.id });
    if (done && published) background(tellRequester(done));
    return { ok: true, dashboardId: made.id, published, creates: plan.creates, ...(publishIt && edited ? { why: say.draftHadEdits() } : {}) };
  } catch (err) {
    // Made but not published (D16 refused the copy): a draft of this request still, so it is never made twice.
    if (made) await store.finish(projectId, id, { state: 'drafted', dashboardId: made.id }).catch(() => null);
    else await store.release(projectId, id).catch(() => undefined);
    throw err;
  }
}

/** Every chart saved as a visual (a version each), laid out as the plan builder lays a sheet; null when a save failed. */
async function cardsOf(r: DashboardRequest, built: Built[]): Promise<dashboards.Card[] | null> {
  const ids: string[] = [];
  for (const b of built) {
    const saved = await saveCardAsVisual(r.projectId, b.card);
    if (!saved.ok) return null;
    ids.push(saved.visual.id);
  }
  const planned: PlannedVisual[] = built.map((b, i) => ({
    kind: 'existing', visualId: ids[i], datasetId: b.card.spec.datasetId, name: b.card.title, chartType: b.card.chartType,
    encoding: { category: b.card.spec.category, values: b.card.spec.measures }, filters: [],
  }));
  const at = arrangeSheet({ metrics: [], visuals: planned, texts: [] });
  return dashboards.sanitizeCards(ids.map((visualId, i) => ({ type: 'visual', layout: at.visuals[i], visualId })));
}

/** A new dashboard of the charts: the plan builder's arrangement and card whitelist, and a version. */
async function build(r: DashboardRequest, built: Built[]): Promise<analysis.Analysis | null> {
  const cards = await cardsOf(r, built);
  if (!cards) return null;
  const style = dashboards.DASHBOARD_STYLE_PRESETS[config.get().branding.dashboardStyle];
  const saved = await analysis.saveAnalysis(r.projectId, { name: r.title, sheets: [{ name: r.title, cards }], style });
  if (saved) await versions.record(r.projectId, 'dashboard', saved);
  return saved;
}

/** The charts on a new sheet of an existing dashboard's DRAFT, under its lock, and a version. `edited`: the draft already had unpublished edits. */
async function addTo(r: DashboardRequest, built: Built[], targetId: string): Promise<{ a: analysis.Analysis; edited: boolean } | null> {
  const cards = await cardsOf(r, built);
  if (!cards) return null;
  return analysis.lockedAnalysis(r.projectId, targetId, async () => {
    const before = await analysis.getStoredAnalysis(r.projectId, targetId);
    if (!before) return null;
    const a = await analysis.updateAnalysis(r.projectId, targetId, { sheets: [...before.sheets, { name: say.requestedBySheet(personName(r.requester)), cards }] });
    if (a) await versions.record(r.projectId, 'dashboard', a, { before });
    return a && { a, edited: statusOf(before) === 'edited' };
  });
}

export type DeclineReply = { ok: true } | { ok: false; error: string };

/** Decline with a note: nothing is made, and the requester is told with the note. */
export async function declineRequest(projectId: string, id: string, note: string): Promise<DeclineReply> {
  const r = await forApprover(projectId, id);
  if (!r) return { ok: false, error: orgDb() ? say.requestGone() : say.requestsOff() };
  if (r.state !== 'open') return { ok: false, error: say.alreadyDecided() };
  const done = await store.finish(projectId, id, { state: 'declined', answer: note.trim().slice(0, 2000) });
  if (!done) return { ok: false, error: say.beingApproved() };
  background(tellRequester(done));
  return { ok: true };
}

/** Publish's hook: a drafted request whose dashboard is now published is approved, and its requester told. Never fails a publish. */
export async function dashboardPublished(projectId: string, dashboardId: string): Promise<void> {
  if (!orgDb()) return;
  try {
    for (const r of await store.publishedNow(projectId, dashboardId)) background(tellRequester(r));
  } catch (err) {
    logger.warn('[requests] a drafted request was not marked published:', err instanceof Error ? err.message : String(err));
  }
}

/** The caller's bell rows (the mention path's `mentions:list`). */
export interface RequestRow extends RequestView {
  /** The caller asked for it (open, to withdraw, or decided); else they were asked to approve it. */
  mine: boolean;
  seen: boolean;
}

export async function listRequests(limit: number): Promise<RequestRow[]> {
  return (await store.listInbox(limit)).map((x) => ({ ...viewOf(x), at: x.at, mine: x.role === 'requester', seen: x.seen }));
}
