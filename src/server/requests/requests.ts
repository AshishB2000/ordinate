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
// THE MENTION PATH, as Ask an editor (../mentions/asks.ts): the rows are the gate; the push (`requests:changed`: ids,
// names and the state, never a title or note) and the email (users.request_email, off by default, under the mention
// email budget) never stand in the send's way. NOT TWICE, NOT A FLOOD: the same charts from the same person in the same
// project within a day are "already sent"; at most REQUESTS_PER_DAY a person a day, across projects (shared counters);
// a refused or failed send is given back.

import { createHash, randomUUID } from 'crypto';
import type { Channel } from '../../app/channels';
import { composeMessage } from '../../analysis/subscriptionMessage';
import * as analysis from '../../analysis/analysis';
import * as dashboards from '../../analysis/dashboards';
import { arrangeSheet } from '../../analysis/planLayout';
import type { PlannedVisual } from '../../analysis/analysisPlan';
import * as drafts from '../../analysis/publishDashboard';
import * as copilot from '../../ai/copilot';
import { sanitizeStoredSpec, type AnswerSpec } from '../../ai/answerSpec';
import * as config from '../../app/config';
import * as datasets from '../../data/datasets';
import { personName } from '../../app/mentionToken';
import { getProject } from '../../app/projects';
import * as versions from '../../app/versions';
import { logger } from '../../app/logger';
import { stableStringify } from '../../engine/queryCache';
import { computeCard, type Built, type Failure } from '../../ipc/answers';
import { saveCardAsVisual } from '../../ipc/answerSave';
import { openers } from '../authz/folderGate';
import { datasetsAt, landsIn, mustEdit, mustOpen, withLanding } from '../authz/folderWrites';
import * as counters from '../counters';
import { ctx } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import { hold, mentionEmailBuckets } from '../mail/budget';
import { mailReady } from '../mail/emailChannel';
import { appLink } from '../publicUrl';
import * as say from '../requestMessages';
import { publish } from '../sse';
import { deliver } from '../subscriptions/deliver';
import * as store from './store';
import type { DashboardRequest } from './store';

/** Requests one person may send a day, across projects. */
export const REQUESTS_PER_DAY = 10;
const DAY = 86_400_000;

export type CreateReply = { ok: true; id?: string; already?: true } | { ok: false; error: string; code?: 'rate_limited' };

/** The push a person's tabs get: ids, names and the state — never the title, a chart or the note. */
export interface RequestNotice {
  projectId: string;
  id: string;
  by: string;
  on: string;
  state: store.RequestState;
  /** Approved: the dashboard the requester's toast opens. */
  dashboardId?: string;
}

const inFlight = new Set<Promise<void>>();

/** Test hook: until every notice started so far has ended. */
export async function requestsSettled(): Promise<void> {
  while (inFlight.size) await Promise.all(inFlight);
}

function background(p: Promise<void>): void {
  const q = p.catch((err: unknown) => logger.warn('[requests] notices failed:', err instanceof Error ? err.message : String(err)));
  inFlight.add(q);
  void q.finally(() => inFlight.delete(q));
}

const datasetIdsOf = (charts: readonly AnswerSpec[]): string[] => [...new Set(charts.map((c) => c.datasetId.toLowerCase()))];
const reviewPath = (projectId: string, id: string): string => `/requests/${projectId}/${id}`;
const dashboardPath = (projectId: string, id: string): string => `/dashboards/${projectId}/${id}`;

/** Editors and admins with Edit on every dataset, never the requester: `openers` per dataset, intersected. */
async function approversOf(projectId: string, ids: readonly string[], requester: string): Promise<string[]> {
  const pool = orgDb();
  if (!pool) return [];
  let out: string[] | null = null;
  for (const id of ids) {
    const these = new Set((await openers(pool, ctx().org.id, projectId, { kind: 'dataset', id }, 'edit')).map((e) => e.toLowerCase()));
    out = (out ?? [...these]).filter((e) => these.has(e));
  }
  return (out ?? []).filter((e) => e !== requester.toLowerCase());
}

/** Who asked for which charts in what project — hashed, so no chart sits in a counter key. */
function sameKey(projectId: string, requester: string, charts: readonly AnswerSpec[]): string {
  return 'request:same:' + createHash('sha256').update([requester.toLowerCase(), projectId.toLowerCase(), stableStringify(charts)].join('\0')).digest('hex').slice(0, 32);
}

/** The caller asks for a dashboard of their answer turns `turnIds` in `threadId`. */
export async function createRequest(projectId: string, input: { threadId: string; turnIds: string[]; title: string; note?: string }): Promise<CreateReply> {
  if (!orgDb()) return { ok: false, error: say.requestsOff() };
  const { org, user } = ctx();
  const charts: AnswerSpec[] = [];
  for (const turnId of new Set(input.turnIds)) {
    const turn = await copilot.findTurn(projectId, input.threadId, turnId); // the caller's own threads only
    if (!turn) return { ok: false, error: say.notYourAnswer() };
    const spec = turn.answer && !turn.answer.table ? sanitizeStoredSpec(turn.answer) : undefined; // the chart form; never the turn's words or kept card
    if (!spec) return { ok: false, error: say.notAChart() };
    charts.push(spec);
  }
  const ids = datasetIdsOf(charts);
  await mustOpen(projectId, datasetsAt(ids)); // a dataset the requester cannot open: `closed`
  for (const id of ids) if (!(await datasets.getDatasetMeta(projectId, id))) return { ok: false, error: say.datasetGone() };
  const approvers = await approversOf(projectId, ids, user.email);
  if (!approvers.length) return { ok: false, error: say.noApprovers() };

  const same = await counters.take(org.id, [{ key: sameKey(projectId, user.email, charts), limit: 1, windowMs: DAY }]);
  if (!same.ok) return { ok: true, already: true };
  const mine = await counters.take(org.id, [{ key: `request:from:${user.email.toLowerCase()}`, limit: REQUESTS_PER_DAY, windowMs: DAY }]);
  if (!mine.ok) {
    await counters.give(org.id, same.windows, 1); // refused: it is not "already sent" tomorrow
    return { ok: false, code: 'rate_limited', error: say.tooManyRequests(REQUESTS_PER_DAY) };
  }
  const req = { id: randomUUID(), projectId, requester: user.email, title: input.title.trim().slice(0, 120), note: (input.note ?? '').trim().slice(0, 2000), charts };
  try {
    await store.insertRequest(req, approvers);
  } catch (err) {
    await counters.give(org.id, same.windows, 1);
    await counters.give(org.id, mine.windows, 1);
    throw err;
  }
  background(tellApprovers(req, approvers));
  return { ok: true, id: req.id };
}

/** A chart as the review page draws it: the engine's figures, formatted by the server; or why it cannot be drawn. */
export type CardView =
  | { ok: true; title: string; chartType: string; datasetName: string; data: Built['card']['data']; headline: Built['card']['headline']; caption: string; notes: string[]; filterLabels: string[] }
  | { ok: false; reason: string };

/** What approving makes, as the review page lists it. */
export interface Creates {
  /** One visual per chart, by name, in order. */
  visuals: string[];
  dashboard: string;
  /** Where it lands, by name. */
  folder: string;
}

interface Plan {
  built: Array<Built | Failure>;
  folderId: string;
  creates: Creates;
}

/** The ONE function the review and the approval share: every chart through the door as the caller, and where it lands. */
async function planOf(r: DashboardRequest): Promise<Plan> {
  const built: Array<Built | Failure> = [];
  for (const spec of r.charts) built.push(await computeCard(r.projectId, spec));
  const folderId = await landsIn(r.projectId, undefined, datasetIdsOf(r.charts)); // refuses unless the caller edits it
  const visuals = built.map((b, i) => ('card' in b ? b.card.title : r.charts[i].title));
  return { built, folderId, creates: { visuals, dashboard: r.title, folder: await folderName(r.projectId, folderId) } };
}

async function folderName(projectId: string, folderId: string): Promise<string> {
  if (folderId === projectId.toLowerCase()) return say.everyoneFolder();
  const r = await inOrg((c, org) => c.query<{ name: string }>('SELECT name FROM folders WHERE org_id = $1 AND project_id = $2 AND id = $3::uuid', [org, projectId, folderId]));
  return r.rows[0]?.name ?? say.everyoneFolder();
}

function cardView(b: Built | Failure): CardView {
  if (!('card' in b)) return { ok: false, reason: b.reason };
  const c = b.card;
  return { ok: true, title: c.title, chartType: c.chartType, datasetName: c.datasetName, data: c.data, headline: c.headline, caption: c.caption, notes: c.notes, filterLabels: c.filterLabels };
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
  at: string;
}

function viewOf(r: DashboardRequest): RequestView {
  return {
    projectId: r.projectId, id: r.id, by: personName(r.requester), title: r.title, note: r.note, charts: r.charts.length, state: r.state,
    decidedBy: r.state !== 'open' && r.decidedBy ? personName(r.decidedBy) : '', answer: r.answer, dashboardId: r.dashboardId, at: r.createdAt,
  };
}

/** An approver's read of a request (`mustEdit` on every dataset it reads), or null when there is none. */
async function forApprover(projectId: string, id: string): Promise<DashboardRequest | null> {
  if (!orgDb()) return null;
  const r = await store.getRequest(projectId, id);
  if (r) await mustEdit(projectId, datasetsAt(datasetIdsOf(r.charts)));
  return r;
}

export type PreviewReply = { ok: true; request: RequestView; cards: CardView[]; creates: Creates | null } | { ok: false; error: string };

/** The review page: the request, and while it is open, its charts computed now as the caller and what approving makes. */
export async function previewRequest(projectId: string, id: string): Promise<PreviewReply> {
  const r = await forApprover(projectId, id);
  if (!r) return { ok: false, error: orgDb() ? say.requestGone() : say.requestsOff() };
  if (r.state !== 'open') return { ok: true, request: viewOf(r), cards: [], creates: null };
  const plan = await planOf(r);
  return { ok: true, request: viewOf(r), cards: plan.built.map(cardView), creates: plan.creates };
}

export type ApproveReply = { ok: true; dashboardId: string; published: boolean; creates: Creates } | { ok: false; error: string };

/** Approve and publish, or Edit (`publish` false: a draft only editors see, published by them later). */
export async function approveRequest(projectId: string, id: string, publishIt: boolean): Promise<ApproveReply> {
  const r = await forApprover(projectId, id);
  if (!r) return { ok: false, error: orgDb() ? say.requestGone() : say.requestsOff() };
  if (r.state !== 'open') return { ok: false, error: say.alreadyDecided() };
  if (!(await store.claim(projectId, id))) return { ok: false, error: say.beingApproved() };
  let made: analysis.Analysis | null = null;
  try {
    const plan = await planOf(r);
    const bad = plan.built.findIndex((b) => !('card' in b));
    if (bad >= 0) {
      await store.release(projectId, id);
      return { ok: false, error: say.chartNotDrawn(r.charts[bad].title, (plan.built[bad] as Failure).reason) };
    }
    made = await withLanding(projectId, plan.folderId, () => build(r, plan.built as Built[]));
    if (!made) {
      await store.release(projectId, id);
      return { ok: false, error: say.notMade() };
    }
    const published = publishIt && !!(await drafts.publish(projectId, made.id));
    const done = await store.finish(projectId, id, { state: published ? 'approved' : 'drafted', dashboardId: made.id });
    if (done && published) background(tellRequester(done));
    return { ok: true, dashboardId: made.id, published, creates: plan.creates };
  } catch (err) {
    // Made but not published (D16 refused the copy): a draft of this request still, so it is never made twice.
    if (made) await store.finish(projectId, id, { state: 'drafted', dashboardId: made.id }).catch(() => null);
    else await store.release(projectId, id).catch(() => undefined);
    throw err;
  }
}

/** Every chart saved as a visual, then one dashboard holding them: the plan builder's arrangement and card whitelist. */
async function build(r: DashboardRequest, built: Built[]): Promise<analysis.Analysis | null> {
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
  const cards = dashboards.sanitizeCards(ids.map((visualId, i) => ({ type: 'visual', layout: at.visuals[i], visualId })));
  const style = dashboards.DASHBOARD_STYLE_PRESETS[config.get().branding.dashboardStyle];
  const saved = await analysis.saveAnalysis(r.projectId, { name: r.title, sheets: [{ name: r.title, cards }], style });
  if (saved) await versions.record(r.projectId, 'dashboard', saved);
  return saved;
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
  /** The caller asked for it (their own request, decided); else they were asked to approve it. */
  mine: boolean;
  seen: boolean;
}

export async function listRequests(limit: number): Promise<RequestRow[]> {
  return (await store.listInbox(limit)).map((x) => ({ ...viewOf(x), at: x.at, mine: x.role === 'requester', seen: x.seen }));
}

// ── Telling ─────────────────────────────────────────────────────────────────

function push(email: string, notice: RequestNotice): void {
  try {
    publish({ org: ctx().org.id, user: email }, 'requests:changed', notice);
  } catch (err) {
    logger.warn('[requests] push failed:', err instanceof Error ? err.message : String(err));
  }
}

async function tellApprovers(r: Pick<DashboardRequest, 'id' | 'projectId' | 'requester' | 'title' | 'note' | 'charts'>, to: string[]): Promise<void> {
  const by = personName(r.requester);
  const on = (await getProject(r.projectId).catch(() => null))?.name ?? '';
  for (const email of to) push(email, { projectId: r.projectId, id: r.id, by, on, state: 'open' });
  if (!mailReady()) return;
  const title = r.charts.length === 1 ? say.askedForDashboardOne(by, r.title) : say.askedForDashboard(by, r.title, String(r.charts.length));
  for (const email of to) {
    await mailOne(r.requester, email, r.projectId, { title, subtitle: r.charts.map((c) => c.title), note: r.note, noteBy: by, path: reviewPath(r.projectId, r.id) })
      .catch((err: unknown) => logger.warn('[requests] email failed:', err instanceof Error ? err.message : String(err)));
  }
}

async function tellRequester(r: DashboardRequest): Promise<void> {
  const by = ctx().user.email;
  const on = (await getProject(r.projectId).catch(() => null))?.name ?? '';
  push(r.requester, { projectId: r.projectId, id: r.id, by: personName(by), on, state: r.state, ...(r.state === 'approved' && r.dashboardId ? { dashboardId: r.dashboardId } : {}) });
  if (!mailReady()) return;
  const ready = r.state === 'approved' && r.dashboardId;
  await mailOne(by, r.requester, r.projectId, {
    title: ready ? say.dashboardReady(r.title) : say.requestDeclined(r.title), subtitle: [], note: ready ? '' : r.answer, noteBy: personName(by),
    path: ready ? dashboardPath(r.projectId, r.dashboardId as string) : null,
  }).catch((err: unknown) => logger.warn('[requests] email failed:', err instanceof Error ? err.message : String(err)));
}

/** One email to `email`, only when they turned on users.request_email, under the mention email budget (`author`'s hour and theirs). */
async function mailOne(author: string, email: string, projectId: string, m: { title: string; subtitle: string[]; note: string; noteBy: string; path: string | null }): Promise<void> {
  const r0 = await orgDb()!.query<{ id: string; request_email: boolean }>('SELECT id::text, request_email FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [ctx().org.id, email]);
  const who = r0.rows[0];
  if (!who || !who.request_email) return; // off unless they turned it on
  const message = composeMessage({ title: m.title, subtitle: m.subtitle, note: m.note, noteBy: m.noteBy, kpis: [], visuals: [], link: m.path ? appLink(m.path) : null, footer: '' });
  // A channel of one, made here and never saved, as a mention's: the send resolves it as it resolves any list.
  const one: Channel = { id: who.id, name: 'request', kind: 'email', to: { userIds: [who.id], teamIds: [] }, createdBy: author, createdAt: '', updatedAt: '' };
  const held = await hold(mentionEmailBuckets(ctx().org.id, author, email), 1);
  if (!held) return logger.warn('[requests] email not sent: its sender or recipient reached the hourly limit (the bell row stands)');
  const r = await deliver(one, { kind: 'mention', projectId, message, reason: say.requestEmailReason() });
  if (!r.ok) await held.refund(1);
}
