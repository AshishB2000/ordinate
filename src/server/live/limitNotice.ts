// "Today's live queries are used up" — told to the org's admins ONCE per UTC
// day — MAIN PROCESS ONLY. docs/live-data/00-plan.md L2.7 ("admins are told").
//
// The org's first refusal of the day (decided by ./usageStore.ts under the
// org's per-day lock, so across pods there is exactly one) calls `tellAdmins`:
//
//   - one server log line, for the operator;
//   - a `live:daily-limit` push to every tab of each enabled org ADMIN, on every
//     pod (sse.publish → the Postgres fan-out). Not to members: the limit is
//     the org's, and so is the decision to raise it. Under dev sign-in (every
//     caller is the admin) and without Postgres, the org's tabs. The web shell
//     shows it as a toast linking to Admin → Live usage, which also shows the
//     day's refusals for as long as the day lasts.
//
// The payload is the day and the limit — no dataset, no figure — so a tab
// that reads it learns nothing a member could not.

import { publish } from '../sse';
import { liveUsageDb } from './usageStore';

export const LIMIT_CHANNEL = 'live:daily-limit';

export interface LimitNotice {
  /** The UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  /** LIVE_DAILY_QUERY_LIMIT when it was reached. */
  readonly limit: number;
}

/** The log line and the push. Never throws: a notice that cannot be delivered must not fail the question. */
export async function tellAdmins(org: string, n: LimitNotice): Promise<void> {
  console.warn(
    `[live] org ${org} reached LIVE_DAILY_QUERY_LIMIT (${n.limit} warehouse queries) on ${n.day} UTC: until 00:00 UTC its Live figures are cached answers labelled stale, or refused. Admin → Live usage shows where the queries went.`,
  );
  const notice: LimitNotice = { day: n.day, limit: n.limit };
  try {
    const via = liveUsageDb();
    if (!via || via.devAuth) return publish({ org }, LIMIT_CHANNEL, notice);
    const r = await via.pool.query<{ email: string }>(
      `SELECT email FROM users WHERE org_id = $1 AND role = 'admin' AND disabled_at IS NULL ORDER BY email`,
      [org],
    );
    for (const { email } of r.rows) publish({ org, user: email }, LIMIT_CHANNEL, notice);
  } catch (err) {
    console.warn(`[live] org ${org}: the daily-limit notice was not pushed — ${err instanceof Error ? err.message : String(err)}`);
  }
}
