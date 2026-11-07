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
//
// The line LEAVES the app (Slack, Teams, email), so it never names a member of
// a column marked personal or financial: those columns are not candidate
// dimensions at all (app/sharePolicy withheldColumns), as the outbound summary
// drops its driver sentence over one; nor is a column hidden from the alert's audience (part 4, D17).

import type { AlertRule } from '../analysis/alerts';
import { driversFor, specForRule } from './drivers';
import { withheldColumns } from '../app/sharePolicy';
import { withLockOf } from './rowDoors';

export async function diagnoseAlert(projectId: string, rule: AlertRule): Promise<string | null> {
  if (rule.compare !== 'change' || rule.change?.vs !== 'previous_period') return null;
  const spec = await specForRule(projectId, rule);
  if (!spec) return null;
  const withheld = await withheldColumns(projectId, spec.datasetId);
  // Through the column gate on the rule's own question (D17); a column hidden from the alert's audience is no candidate either.
  const r = await withLockOf(projectId, spec.datasetId, async (_lock, hidden) => driversFor(projectId, spec, undefined, { withhold: new Set([...withheld, ...hidden]) }), [spec.metric, spec.filters, spec.compare]);
  // No breakdown (one-member dimensions, a metric that cannot be split) → no
  // line: the caption would only repeat the alert's own sentence.
  return r.ok && r.selected && r.caption ? r.caption : null;
}
