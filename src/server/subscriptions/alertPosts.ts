// A fired alert, posted to the channels its rule names — on the server's tick.
//
// Nothing is recomputed and nothing is reworded: the event already carries the
// sentence the app composed (analysis/alerts.alertMessage) and the figure the
// rule read through the KPI door (alertStore.metricFor → computeCardMetric), so
// the post says exactly what the bell says. It goes out as the same neutral
// message a subscription uses — the rule's name, the sentence, the figure, a
// link to the dashboard the rule was made on — through the same renderers and
// the same single door to a webhook (./deliver.ts).
//
// A post that fails is logged and left: the alert itself is in the inbox either
// way, and the next firing tries again. Each attempt is on the audit trail.

import { getChannel } from '../../app/channels';
import * as alertStore from '../../analysis/alertStore';
import { fmtMetric, type AlertEvent, type AlertRule } from '../../analysis/alerts';
import { composeMessage } from '../../analysis/subscriptionMessage';
import { renderSlack, renderTeams } from '../../analysis/subscriptionRender';
import { alertTitle } from '../../analysis/subscriptionText';
import { audit } from '../authz/audit';
import { ctx } from '../context';
import { dashboardLink } from '../publicUrl';
import { postToChannel } from './deliver';
import { subscriptionDb } from './run';

/** The message one fired event stands for. Pure given the rule and the event. */
export function alertMessageModel(projectId: string, rule: AlertRule, event: AlertEvent) {
  return composeMessage({
    title: alertTitle(rule.name),
    subtitle: [],
    note: event.message,
    kpis: event.value === null ? [] : [{ label: rule.metric.label || rule.metric.column || rule.name, display: fmtMetric(event.value) }],
    visuals: [],
    link: event.analysisId ? dashboardLink(projectId, event.analysisId) : null,
    footer: '',
  });
}

/** Post each of `events` to its rule's channels. Returns how many posts went out. Never throws. */
export async function postFiredAlerts(projectId: string, events: AlertEvent[]): Promise<number> {
  if (!events.length) return 0;
  let sent = 0;
  try {
    const rules = new Map((await alertStore.load(projectId)).rules.map((r) => [r.id, r]));
    for (const event of events) {
      const rule = rules.get(event.ruleId);
      if (!rule || !rule.channelIds || !rule.channelIds.length) continue;
      const model = alertMessageModel(projectId, rule, event);
      let ok = 0;
      for (const id of rule.channelIds) {
        const c = await getChannel(id);
        if (!c) continue; // removed since: Admin → Channels warned that this rule used it
        if ((await postToChannel(c.id, c.name, (c.kind === 'teams' ? renderTeams : renderSlack)(model).payload)).ok) ok++;
      }
      sent += ok;
      const who = ctx();
      await audit(subscriptionDb(), { org: who.org.id, actor: who.user.email, action: 'rpc', channel: 'alerts:post', projectId, targets: [rule.id, ...rule.channelIds], outcome: ok ? 'ok' : 'error', requestId: who.requestId }).catch(() => undefined);
    }
  } catch {
    // The alert is already in the inbox; a post that could not be made must not fail the tick.
  }
  return sent;
}
