// One subscription run, start to finish — and the tick that finds the due ones.
//
// WHO IT RUNS AS. Nobody is signed in when a schedule fires, so a run computes
// as the subscription's OWNER, with the access the owner has NOW: the owner's
// row is read (gone or disabled → `owner_removed`), their role on the project
// is decided by the same `authorize` an RPC goes through (none →
// `owner_no_access`), and the figures are resolved inside `runInContext(owner)`.
// A run that fails either check sends nothing.
//
// ONCE. A scheduled run stamps its slot (`run.lastSlot`) BEFORE it computes or
// posts anything, so a run that is repeated — a pod that died mid-run, a lease
// retaken from a stalled pod (./job.ts, ../jobs/runner.ts) — finds the slot
// handled and does nothing. Between pods the jobs table's lease is what lets
// only one claim a tick; the stamp is what makes a repeat harmless.
//
// REFUSED FIRST. A dashboard whose figures can come from a dataset with row
// access rules is refused from its definition (`dashboardSendRefusal`) before
// the owner is looked up or any figure computed: a `skipped` run, code
// `row_policy`. `deliver` still refuses per channel behind it.
//
// WHAT A RUN LEAVES. One history entry (time, outcome, a typed code — the
// sentence is written from the catalog when it is read), the failure count, and
// after PAUSE_AFTER failed runs in a row a pause: the subscription is switched
// off with the reason, and its owner is told over SSE. Nothing a remote said is
// kept: that goes to the log (./deliver.ts).

import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { byProjectId, rpc, Uuid } from '../../api/contract';
import * as analysis from '../../analysis/analysis';
import * as projects from '../../app/projects';
import { getChannel, type Channel } from '../../app/channels';
import { formatDate } from '../../app/format';
import { todayIso } from '../../analysis/dateIntel';
import { filterLine, type PageAnalysis } from '../../analysis/reportPages';
import { viewControlValue, type SavedView } from '../../analysis/savedViews';
import { composeMessage, figuresOf, type MessageModel } from '../../analysis/subscriptionMessage';
import { dueDecision } from '../../analysis/subscriptionSchedule';
import * as store from '../../analysis/subscriptions';
import type { RunEntry, RunState, Subscription } from '../../analysis/subscriptions';
import { asOfText, footerText, pausedNotice, scheduleText, viewText, type RunCode, type RunDetail } from '../../analysis/subscriptionText';
import { utcLabel } from '../../data/figureAsOf';
import { resolveFigures } from '../../ipc/subscriptionFigures';
import { audit } from '../authz/audit';
import { authorize } from '../authz/index';
import { ctx, runInContext, type Identity } from '../context';
import { toReaders } from '../jobs/schedules';
import { dashboardLink } from '../publicUrl';
import { publish } from '../sse';
import { dashboardSendRefusal, deliver, type DatasetsMemo } from './deliver';

let db: { pool: Pool | null; devAuth: boolean } = { pool: null, devAuth: true };

/** The pool accounts and grants are read from (src/server/app.ts). `devAuth`: AUTH_MODE=dev, where everyone is the dev admin. */
export function useSubscriptionDb(pool: Pool | null, devAuth: boolean): void {
  db = { pool, devAuth };
}

/** The pool an audit row is written through, or null without Postgres. */
export function subscriptionDb(): Pool | null {
  return db.pool;
}

const READ_PROJECT = rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId });

/** The owner as they are NOW, or why they can no longer run this. */
export async function ownerIdentity(org: string, email: string, projectId: string): Promise<Identity | 'owner_removed' | 'owner_no_access'> {
  const { pool, devAuth } = db;
  if (!pool || devAuth) return { user: { email, role: 'admin' }, org: { id: org } }; // no accounts: the one identity is the dev admin
  const r = await pool.query<{ role: 'admin' | 'editor' | 'viewer' }>('SELECT role FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [org, email]);
  if (!r.rows[0]) return 'owner_removed';
  const who: Identity = { user: { email, role: r.rows[0].role }, org: { id: org } };
  return (await authorize(READ_PROJECT, { projectId }, who, pool)).ok ? who : 'owner_no_access';
}

type Definition = Pick<Subscription, 'name' | 'analysisId' | 'content' | 'viewId' | 'schedule' | 'timezone' | 'message'>;

export interface Built {
  model: MessageModel;
  /** The newest data time among the figures. */
  dataAt: string | null;
  /** sha-256 of the figures: what "nothing changed" compares. */
  hash: string;
}

/** The dashboard with every control at the view's pick, so the filter line says what the send is filtered by. */
function underView(a: analysis.Analysis, view: SavedView | null): PageAnalysis {
  const sheets = a.sheets.map((s) => ({
    name: s.name,
    cards: s.cards.map((c) => (view && c.type === 'control' && c.control ? { ...c, control: { ...c.control, default: viewControlValue(view, c) ?? undefined } } : c)),
  }));
  return { id: a.id, name: a.name, sheets } as unknown as PageAnalysis; // reportPages reads a card loosely, as reportsServer hands it one
}

/**
 * The message a definition stands for right now, as the CURRENT context's user
 * — a preview's caller, or a run's owner. A typed code when there is nothing to
 * compose.
 */
export async function buildMessage(projectId: string, def: Definition): Promise<Built | { code: 'dashboard_gone' | 'no_content' }> {
  // A send reaches viewers: the published copy (a draft never published only for its editors' own sends).
  const a = def.analysisId ? await analysis.getAudienceAnalysis(projectId, def.analysisId) : null;
  if (!a) return { code: 'dashboard_gone' };
  // A view that was deleted since falls back to the dashboard as saved, rather than failing the send.
  const view = (def.viewId && (a.views || []).find((v) => v.id === def.viewId)) || null;
  const figs = await resolveFigures(projectId, a, def.content.mode === 'cards' ? def.content.cardIds : null, view);
  if (!figs.found) return { code: 'no_content' };
  const filters = filterLine(underView(a, view));
  const model = composeMessage({
    title: def.message.title || a.name,
    subtitle: [formatDate(todayIso()), ...(view ? [viewText(view.name)] : []), ...(filters ? [filters] : []), ...(figs.dataAt ? [asOfText(utcLabel(figs.dataAt))] : [])],
    note: def.message.note,
    ...(def.message.noteBy ? { noteBy: def.message.noteBy } : {}), // who wrote it (subscription:save) — an email says "Note from …"
    kpis: figs.kpis,
    visuals: figs.visuals,
    link: def.message.includeLink ? dashboardLink(projectId, a.id) : null,
    footer: footerText(def.name, scheduleText(def.schedule, def.timezone)),
  });
  return { model, dataAt: figs.dataAt, hash: createHash('sha256').update(figuresOf(model)).digest('hex') };
}

/** `uncounted`: a failure that must not count toward the pause — every channel only hit the hourly email budget. */
interface Result { outcome: RunEntry['outcome']; code: RunCode; detail?: RunDetail; built?: Built; uncounted?: boolean }

/** Compute as the owner and post to every channel. Never throws. */
async function attempt(sub: Subscription, org: string, scheduled: boolean): Promise<Result> {
  const who = await ownerIdentity(org, sub.owner, sub.projectId);
  if (typeof who === 'string') return { outcome: 'failed', code: who, detail: { owner: sub.owner } };
  return runInContext(who, `subscription:${sub.id}`, async (): Promise<Result> => {
    const channels = (await Promise.all(sub.channelIds.map(getChannel))).filter((c): c is Channel => c !== null);
    if (!channels.length) return { outcome: 'failed', code: 'no_channels' };
    let built: Awaited<ReturnType<typeof buildMessage>>;
    try {
      built = await buildMessage(sub.projectId, sub);
    } catch {
      return { outcome: 'failed', code: 'compute_failed' };
    }
    if ('code' in built) return { outcome: 'failed', code: built.code };
    // The conditions hold a SCHEDULED run back; "Send now" is someone asking for it.
    if (scheduled && sub.conditions.skipUnchanged && sub.run.lastHash === built.hash) return { outcome: 'skipped', code: 'unchanged' };
    if (scheduled && sub.conditions.onlyWhenRefreshed && sub.run.lastDataAt && built.dataAt && built.dataAt <= sub.run.lastDataAt) return { outcome: 'skipped', code: 'not_refreshed' };
    let sent = 0;
    let failure: RunDetail & { code: RunCode } | null = null;
    let partialMail: RunDetail | null = null;
    let onlyLimited = true;
    const memo: DatasetsMemo = new Map(); // the dashboard's datasets, read once for all its channels
    for (const c of channels) {
      const r = await deliver(c, { kind: 'dashboard', projectId: sub.projectId, analysisId: sub.analysisId, message: built.model }, memo);
      if (r.ok) {
        sent++;
        if (r.partial) partialMail ??= { channel: c.name, sent: r.partial.sent, total: r.partial.total };
      } else {
        failure ??= { code: r.code, channel: c.name, ...(r.status ? { status: r.status } : {}) };
        if (r.code !== 'rate_limited') onlyLimited = false;
      }
    }
    // An email list that reached some of its people is sent (it clears the failure count), and says who it missed.
    if (!failure) return partialMail ? { outcome: 'sent', code: 'mail_partial', detail: partialMail, built } : { outcome: 'sent', code: 'sent', detail: { sent }, built };
    const { code, ...where } = failure;
    return sent ? { outcome: 'sent', code: 'partial', detail: { sent, total: channels.length, channel: where.channel }, built } : { outcome: 'failed', code, detail: where, uncounted: onlyLimited };
  });
}

/**
 * Run one subscription and record what happened. `slot`: the scheduled instant
 * (absent = "Send now"). Returns the history entry, or null when the
 * subscription is gone or the slot was already handled.
 */
export async function runSubscription(projectId: string, id: string, slot?: number, now = Date.now()): Promise<RunEntry | null> {
  const org = ctx().org.id;
  const scheduled = slot !== undefined;
  const slotIso = scheduled ? new Date(slot).toISOString() : undefined;
  let sub = await store.getSubscription(projectId, id);
  if (!sub) return null;
  if (slotIso) {
    if (sub.run.lastSlot && sub.run.lastSlot >= slotIso) return null; // a repeated claim: this slot is done
    sub = await store.stampRun(projectId, id, (run) => ({ ...run, lastSlot: slotIso })); // the fence, before anything leaves
    if (!sub) return null;
  }
  // A dashboard with row access rules is refused from its DEFINITION first: nothing computed, nothing sent
  // (docs/row-policy D10; docs/notifications D5). Any other failure here is left for `attempt` to name.
  const refused = await dashboardSendRefusal(projectId, sub.analysisId).catch(() => null);
  const r: Result = refused ? { outcome: 'skipped', code: 'row_policy' } : await attempt(sub, org, scheduled);
  const entry: RunEntry = { at: new Date(now).toISOString(), trigger: scheduled ? 'schedule' : 'manual', outcome: r.outcome, code: r.code, ...(slotIso ? { slot: slotIso } : {}), ...(r.detail ? { detail: r.detail } : {}) };
  // Only a SCHEDULED failure counts toward the pause — and not one where the hourly email budget was the only
  // reason (it clears by itself); any send that goes out, even partly, clears the count.
  const failures = r.outcome === 'sent' ? 0 : scheduled && r.outcome === 'failed' && !r.uncounted ? sub.run.failures + 1 : sub.run.failures;
  const pause = scheduled && r.outcome === 'failed' && failures >= store.PAUSE_AFTER;
  await store.stampRun(projectId, id, (run): RunState => ({
    ...run,
    failures,
    history: [entry, ...run.history],
    ...(r.outcome === 'sent' && r.built ? { lastSentAt: entry.at, lastHash: r.built.hash, ...(r.built.dataAt ? { lastDataAt: r.built.dataAt } : {}) } : {}),
    ...(pause ? { paused: { code: r.code, at: entry.at, ...(r.detail ? { detail: r.detail } : {}) } } : {}),
  }), pause);
  // An attempt to send data out is on the audit trail: who it ran as, what, where to — ids only.
  if (r.outcome !== 'skipped') {
    await audit(db.pool, { org, actor: sub.owner, action: 'rpc', channel: 'subscription:send', projectId, targets: [id, ...sub.channelIds], outcome: r.outcome === 'sent' ? 'ok' : 'error', requestId: ctx().requestId }).catch(() => undefined);
  }
  if (pause) publish({ org, user: sub.owner }, 'subscriptions:paused', { projectId, id, name: sub.name, message: pausedNotice(sub.name, failures) });
  await changed(projectId, id);
  return entry;
}

/** Tell the project's readers a subscription's state moved (ids only), so an open list re-reads it. */
async function changed(projectId: string, id: string): Promise<void> {
  const { pool, devAuth } = db;
  if (!pool) return publish({ org: ctx().org.id }, 'subscriptions:changed', { projectId, id });
  await toReaders(pool, devAuth, projectId, 'subscriptions:changed', { projectId, id }).catch(() => undefined);
}

/** A slot the server was down for: recorded, never sent. */
async function recordMissed(sub: Subscription, slot: number, now: number): Promise<void> {
  const slotIso = new Date(slot).toISOString();
  await store.stampRun(sub.projectId, sub.id, (run) => ({ ...run, lastSlot: slotIso, history: [{ at: new Date(now).toISOString(), slot: slotIso, trigger: 'schedule', outcome: 'missed', code: 'missed' }, ...run.history] }));
  await changed(sub.projectId, sub.id);
}

/**
 * The org's due subscriptions, one after another. Called by the `subscriptions`
 * job (./job.ts) in the org's context; `now` is passed in.
 * ponytail: every project's subscription list is read each minute — a `next_run_at`
 * index when an org holds thousands.
 */
export async function tickSubscriptions(now = Date.now()): Promise<number> {
  let ran = 0;
  for (const p of await projects.listProjects()) {
    for (const sub of await store.listSubscriptions(p.id)) {
      if (!sub.enabled) continue;
      const due = dueDecision({ schedule: sub.schedule, timezone: sub.timezone, lastSlot: sub.run.lastSlot, since: sub.since }, now);
      if (due.kind === 'none') continue;
      if (due.kind === 'missed') await recordMissed(sub, due.slot, now);
      else if (await runSubscription(p.id, sub.id, due.slot, now)) ran++;
    }
  }
  return ran;
}
