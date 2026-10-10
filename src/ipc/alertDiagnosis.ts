// WHERE A FIRED ALERT'S CHANGE CAME FROM — the line under the alert's sentence.
//
// "Revenue fell 31% vs the previous period" sends its reader off to find out
// where. The key-drivers engine (./drivers) already answers that for the Why
// drawer; this asks it the same question when the rule FIRES, so the bell and
// the Slack / Teams post carry the answer with them.
//
// NO MODEL: the sentence is `driversCaption`, written from figures the drivers
// engine computed over the rule's own two periods (alertStore.recentPeriods —
// the same pair `metricFor` compared). It says WHERE the change is, never why:
// the app has the data, not the cause.
//
// Only a period-over-period rule has two periods of rows to compare; "since the
// last refresh" compares against a figure whose rows are gone.

import type { AlertRule } from '../analysis/alerts';
import { driversFor, specForRule } from './drivers';

export async function diagnoseAlert(projectId: string, rule: AlertRule): Promise<string | null> {
  if (rule.compare !== 'change' || rule.change?.vs !== 'previous_period') return null;
  const spec = await specForRule(projectId, rule);
  if (!spec) return null;
  const r = await driversFor(projectId, spec);
  // No breakdown (one-member dimensions, a metric that cannot be split) → no
  // line: the caption would only repeat the alert's own sentence.
  return r.ok && r.selected && r.caption ? r.caption : null;
}
