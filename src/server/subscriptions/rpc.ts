// channel:* and subscription:* — the handlers. Contracts: src/api/subscriptions.ts.
//
// What a reply may hold is decided HERE, by `publicSubscription` and
// `publicChannel`: a subscription's definition, who owns it, its schedule as a
// sentence, its next runs, and its runs as catalog sentences. Never a webhook
// URL (the list says `secretSet`), never the figures hash, never anything a
// remote answered.

import * as analysis from '../../analysis/analysis';
import * as projects from '../../app/projects';
import { canKeepWebhooks, deleteChannel, getChannel, listChannels, publicChannel, saveChannel, type PublicChannel } from '../../app/channels';
import { composeMessage } from '../../analysis/subscriptionMessage';
import { renderSlack, renderTeams } from '../../analysis/subscriptionRender';
import { nextSlots, sanitizeSubSchedule, sanitizeTimeZone, type SubSchedule } from '../../analysis/subscriptionSchedule';
import * as store from '../../analysis/subscriptions';
import type { RunEntry, Subscription, SubscriptionInput } from '../../analysis/subscriptions';
import * as say from '../../analysis/subscriptionText';
import { sendableCards } from '../../ipc/subscriptionFigures';
import { formatBytes } from '../../publish/combos';
import { ctx } from '../context';
import { dashboardLink } from '../publicUrl';
import { registry } from '../rpc';
import { postToChannel } from './deliver';
import { buildMessage, ownerIdentity, runSubscription } from './run';

/** "Mon 12 Oct, 08:00" in the subscription's own zone. */
function slotText(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(new Date(at));
}

function nextRuns(schedule: SubSchedule, timezone: string, now = Date.now()): Array<{ at: string; text: string }> {
  return nextSlots(schedule, timezone, now, 3).map((at) => ({ at: new Date(at).toISOString(), text: slotText(at, timezone) }));
}

const runView = (e: RunEntry) => ({ at: e.at, ...(e.slot ? { slot: e.slot } : {}), trigger: e.trigger, outcome: e.outcome, text: say.runText(e.code, e.detail) });

/** A subscription as a browser sees it. `dashboards`: this project's dashboards by id. */
function publicSubscription(s: Subscription, dashboards: Map<string, string>) {
  const last = s.run.history[0];
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    analysisId: s.analysisId,
    /** Null when the dashboard was deleted. */
    dashboard: dashboards.get(s.analysisId) ?? null,
    content: s.content,
    viewId: s.viewId ?? null,
    schedule: s.schedule,
    timezone: s.timezone,
    channelIds: s.channelIds,
    message: s.message,
    conditions: s.conditions,
    enabled: s.enabled,
    owner: s.owner,
    scheduleText: say.scheduleText(s.schedule, s.timezone),
    nextRuns: s.enabled ? nextRuns(s.schedule, s.timezone) : [],
    lastRun: last ? runView(last) : null,
    paused: s.run.paused ? { at: s.run.paused.at, text: say.pausedText(store.PAUSE_AFTER), reason: say.runText(s.run.paused.code, s.run.paused.detail) } : null,
    updatedAt: s.updatedAt,
  };
}

async function dashboardNames(projectId: string): Promise<Map<string, string>> {
  return new Map((await analysis.listAnalyses(projectId)).map((a) => [a.id, a.name]));
}

/** What every channel picker needs: the channels, whether this server can keep a URL at all, and whether the caller may add one. */
async function channelFrame(): Promise<{ channels: PublicChannel[]; canStore: boolean; canManage: boolean }> {
  return { channels: await Promise.all((await listChannels()).map(publicChannel)), canStore: canKeepWebhooks(), canManage: ctx().user.role === 'admin' };
}

/** The message a channel's "Send a test message" posts: fixed words, no data. */
function testMessage(name: string) {
  return composeMessage({ title: say.testTitle(), subtitle: [], note: say.testBody(name), kpis: [], visuals: [], link: null, footer: '' });
}

/** Every subscription in the org that posts to `channelId`, by project. */
async function usage(channelId: string): Promise<Array<{ projectId: string; project: string; id: string; name: string }>> {
  const out = [];
  for (const p of await projects.listProjects()) {
    for (const s of await store.listSubscriptions(p.id)) if (s.channelIds.includes(channelId)) out.push({ projectId: p.id, project: p.name, id: s.id, name: s.name });
  }
  return out;
}

type Draft = SubscriptionInput & { analysisId: string; channelIds: string[] };

export function register(): void {
  // ── Channels ──────────────────────────────────────────────────────────
  registry.handle('channel:list', async () => ({ ok: true as const, ...(await channelFrame()) }));

  registry.handle('channel:save', async (_e, input: { id?: string; name: string; kind: string; webhookUrl?: string }) => {
    const r = await saveChannel(input, ctx().user.email);
    return r.ok ? { ok: true as const, channel: await publicChannel(r.channel) } : r;
  });

  registry.handle('channel:usage', async (_e, { id }: { id: string }) => ({ ok: true as const, subscriptions: await usage(id), alerts: [] as Array<{ projectId: string; project: string; id: string; name: string }> }));

  registry.handle('channel:delete', async (_e, { id }: { id: string }) => ((await deleteChannel(id)) ? { ok: true as const } : { ok: false as const, error: say.channelGone() }));

  registry.handle('channel:test', async (_e, { id }: { id: string }) => {
    const c = await getChannel(id);
    if (!c) return { ok: false as const, error: say.channelGone() };
    const model = testMessage(c.name);
    const r = await postToChannel(c.id, c.name, (c.kind === 'teams' ? renderTeams : renderSlack)(model).payload);
    return r.ok ? { ok: true as const } : { ok: false as const, error: say.runText(r.code, { channel: c.name, ...(r.status ? { status: r.status } : {}) }) };
  });

  // ── Subscriptions ─────────────────────────────────────────────────────
  registry.handle('subscription:list', async (_e, { projectId }: { projectId: string }) => {
    const names = await dashboardNames(projectId);
    return {
      ok: true as const,
      subscriptions: (await store.listSubscriptions(projectId)).map((s) => publicSubscription(s, names)),
      ...(await channelFrame()),
    };
  });

  registry.handle('subscription:get', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const s = await store.getSubscription(projectId, id);
    return s ? { ok: true as const, subscription: publicSubscription(s, await dashboardNames(projectId)) } : { ok: false as const, error: say.subscriptionGone() };
  });

  registry.handle('subscription:history', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const s = await store.getSubscription(projectId, id);
    return s ? { ok: true as const, runs: s.run.history.map(runView) } : { ok: false as const, error: say.subscriptionGone() };
  });

  registry.handle('subscription:preview', async (_e, { projectId, draft }: { projectId: string; draft: Draft }) => {
    const schedule = sanitizeSubSchedule(draft.schedule);
    const timezone = sanitizeTimeZone(draft.timezone);
    const a = await analysis.getAnalysis(projectId, draft.analysisId);
    if (!a) return { ok: false as const, error: say.runText('dashboard_gone') };
    const frame = {
      scheduleText: say.scheduleText(schedule, timezone),
      nextRuns: nextRuns(schedule, timezone),
      cards: await sendableCards(projectId, a),
      views: (a.views || []).map((v) => ({ id: v.id, name: v.name })),
      // Whether a link CAN be sent, and the sentence for when it cannot.
      linkNote: dashboardLink(projectId, a.id) ? null : say.noLinkNote(),
    };
    const def = store.definitionOf({ ...draft, viewId: draft.viewId ?? null });
    const built = await buildMessage(projectId, def);
    if ('code' in built) return { ok: true as const, ...frame, empty: say.runText(built.code), slack: null, teams: null };
    const slack = renderSlack(built.model);
    const teams = renderTeams(built.model);
    return {
      ok: true as const,
      ...frame,
      empty: null,
      slack: { model: slack.model, bytes: slack.bytes, size: formatBytes(slack.bytes), blocks: slack.payload.blocks.length, notes: slack.notes },
      teams: { model: teams.model, bytes: teams.bytes, size: formatBytes(teams.bytes), notes: teams.notes },
    };
  });

  registry.handle('subscription:save', async (_e, { projectId, id, subscription }: { projectId: string; id?: string; subscription: Draft }) => {
    if (!(await analysis.getAnalysis(projectId, subscription.analysisId))) return { ok: false as const, error: say.subscriptionNeedsDashboard() };
    const known = new Set((await listChannels()).map((c) => c.id));
    const channelIds = subscription.channelIds.filter((c) => known.has(c.toLowerCase()));
    if (!channelIds.length) return { ok: false as const, error: say.subscriptionNeedsChannel() };
    const input: SubscriptionInput = { ...subscription, channelIds, viewId: subscription.viewId ?? null };
    const who = ctx();
    let saved: Subscription | null;
    if (id) {
      const cur = await store.getSubscription(projectId, id);
      if (!cur) return { ok: false as const, error: say.subscriptionGone() };
      // An owner who can no longer run it hands it to whoever saves it next.
      const stale = typeof (await ownerIdentity(who.org.id, cur.owner, projectId)) === 'string';
      saved = await store.updateSubscription(projectId, id, input, stale ? { owner: who.user.email } : {});
    } else {
      saved = await store.createSubscription(projectId, input, who.user.email);
    }
    return saved ? { ok: true as const, subscription: publicSubscription(saved, await dashboardNames(projectId)) } : { ok: false as const, error: say.subscriptionGone() };
  });

  registry.handle('subscription:setEnabled', async (_e, { projectId, id, enabled }: { projectId: string; id: string; enabled: boolean }) => {
    const cur = await store.getSubscription(projectId, id);
    if (!cur) return { ok: false as const, error: say.subscriptionGone() };
    const who = ctx();
    const stale = enabled && typeof (await ownerIdentity(who.org.id, cur.owner, projectId)) === 'string';
    const saved = await store.updateSubscription(projectId, id, { enabled }, stale ? { owner: who.user.email } : {});
    return saved ? { ok: true as const, subscription: publicSubscription(saved, await dashboardNames(projectId)) } : { ok: false as const, error: say.subscriptionGone() };
  });

  registry.handle('subscription:delete', async (_e, { projectId, id }: { projectId: string; id: string }) => ({ ok: await store.deleteSubscription(projectId, id) }));

  registry.handle('subscription:sendNow', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const entry = await runSubscription(projectId, id);
    if (!entry) return { ok: false as const, error: say.subscriptionGone() };
    return entry.outcome === 'sent' ? { ok: true as const, run: runView(entry) } : { ok: false as const, error: say.runText(entry.code, entry.detail), run: runView(entry) };
  });
}
