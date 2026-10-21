// A fired alert, posted to the channels its rule names — on every path that
// fires one (the tick, a refresh, a refresh URL, MCP, a pipeline step, fresh on
// ask: server/jobs/schedules.ts `deliverFired`).
//
// Nothing is recomputed and nothing is reworded: the event already carries the
// sentence the app composed (analysis/alerts.alertMessage) and the figure the
// rule read through the KPI door (alertStore.metricFor → computeCardMetric), so
// the post says exactly what the bell says — the sentence, then where the change
// came from when the event carries that (ipc/alertDiagnosis). It goes out as the same neutral
// message a subscription uses — the rule's name, the sentence, the figure, a
// link to the dashboard the rule was made on — through the one send door
// (./deliver.ts), which renders it for Slack, Teams or email.
//
// A post that fails is logged and left: the alert itself is in the inbox either
// way, and the next firing tries again. Each attempt is on the audit trail.
//
// AT MOST ONCE PER EVENT (docs/notifications §5.3). Right before an event's own
// post, its id is claimed in `alert_posts` (0020) — an INSERT every pod shares —
// and only the first claimant posts, whichever path delivered it. A claim the
// database cannot answer posts nothing for that event, and says so on the trail.
// Without a database there is no ledger (and no channel secret to post with).

import { getChannel } from '../../app/channels';
import * as alertStore from '../../analysis/alertStore';
import { fmtMetric, type AlertEvent, type AlertRule } from '../../analysis/alerts';
import { composeMessage } from '../../analysis/subscriptionMessage';
import { alertTitle } from '../../analysis/subscriptionText';
import { audit } from '../authz/audit';
import { ctx } from '../context';
import { dashboardLink } from '../publicUrl';
import { deliver, type DatasetsMemo } from './deliver';
import { subscriptionDb } from './run';
import { inOrg, orgDb } from '../db/inOrg';

/** The message one fired event stands for. Pure given the rule and the event. */
export function alertMessageModel(projectId: string, rule: AlertRule, event: AlertEvent) {
  return composeMessage({
    title: alertTitle(rule.name),
    subtitle: [],
    note: event.diagnosis ? `${event.message} ${event.diagnosis}` : event.message,
    kpis: event.value === null ? [] : [{ label: rule.metric.label || rule.metric.column || rule.name, display: fmtMetric(event.value) }],
    visuals: [],
    link: event.analysisId ? dashboardLink(projectId, event.analysisId) : null,
    footer: '',
  });
}

/** Is this the first claim of `eventId`, on any pod? No database: no ledger, so yes. Throws when the database cannot answer. */
async function claim(projectId: string, eventId: string): Promise<boolean> {
  if (!orgDb()) return true;
  return inOrg(async (c, org) => {
    await c.query(`DELETE FROM alert_posts WHERE org_id = $1 AND claimed_at < now() - interval '30 days'`, [org]);
    const r = await c.query('INSERT INTO alert_posts (org_id, project_id, event_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id', [org, projectId, eventId]);
    return r.rowCount === 1;
  });
}

const inFlight = new Set<Promise<number>>();

/** Test hook: until every post started so far has ended. */
export async function postsSettled(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

/** Post each of `events` to its rule's channels, each event at most once. Returns how many posts went out. Never throws. */
export function postFiredAlerts(projectId: string, events: AlertEvent[]): Promise<number> {
  const p = post(projectId, events);
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

async function post(projectId: string, events: AlertEvent[]): Promise<number> {
  if (!events.length) return 0;
  let sent = 0;
  try {
    const rules = new Map((await alertStore.load(projectId)).rules.map((r) => [r.id, r]));
    const memo: DatasetsMemo = new Map(); // each rule's datasets, read once for all its channels this tick
    for (const event of events) {
      const rule = rules.get(event.ruleId);
      const channelIds = rule && rule.channelIds;
      if (!rule || !channelIds || !channelIds.length) continue;
      const who = ctx();
      const trail = (ok: boolean) => audit(subscriptionDb(), { org: who.org.id, actor: who.user.email, action: 'rpc', channel: 'alerts:post', projectId, targets: [rule.id, ...channelIds], outcome: ok ? 'ok' : 'error', requestId: who.requestId }).catch(() => undefined);
      let first: boolean;
      try {
        first = await claim(projectId, event.id);
      } catch {
        await trail(false); // could not tell whether another path posted it: post nothing rather than twice
        continue;
      }
      if (!first) continue; // posted already, by another path or pod
      const model = alertMessageModel(projectId, rule, event);
      let ok = 0;
      for (const id of channelIds) {
        const c = await getChannel(id);
        if (!c) continue; // removed since: Admin → Channels warned that this rule used it
        if ((await deliver(c, { kind: 'alert', projectId, ruleId: rule.id, message: model }, memo)).ok) ok++;
      }
      sent += ok;
      await trail(ok > 0);
    }
  } catch {
    // The alert is already in the inbox; a post that could not be made must not fail the path that fired it.
  }
  return sent;
}
