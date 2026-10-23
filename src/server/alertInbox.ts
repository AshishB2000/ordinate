// Each member's own view of a project's alert inbox (docs/notifications/00-design.md
// §5.2): what THEY have seen, kept apart from the events (alert_inbox, 0020), so
// one member's click never clears another's badge.
//
// An event is seen when its `at` is at or before the row's `seen_through` (Mark
// all seen) or its id is in `seen_ids` (Mark seen, one by one). The store stamps
// `at` when it stores an event, strictly after the newest stored one
// (alertStore `stampAfter`), so an event stored after a Mark all seen is always
// unseen. No row yet: the shared `seen` flag the events carried before 0020
// decides, so no badge lights up on upgrade. No database: the shared flag, and
// the store's own markSeen.

import type { AlertEvent } from '../analysis/alerts';
import { isValidId } from '../app/ids';
import { ctx } from './context';
import { inOrg, orgDb } from './db/inOrg';
import { notifyLog, why } from './notifyLog';

/** True when seen state is per member here (a database), false when it is the shared flag. */
export function perMember(): boolean {
  return orgDb() !== null;
}

const shared = (e: AlertEvent): boolean => e.seen;

/**
 * Has the CALLER seen an event of `projectId`? One read; the predicate is then
 * pure. Never throws: a database that cannot answer falls back to the shared
 * flag (and says so in the log), so a Postgres hiccup never takes down the bell
 * or a Summary card.
 */
export async function seenView(projectId: string): Promise<(e: AlertEvent) => boolean> {
  if (!perMember() || !isValidId(projectId)) return shared;
  let r: { rows: Array<{ seen_through: Date | null; seen_ids: string[] }> };
  try {
    r = await inOrg((c, org) =>
      c.query<{ seen_through: Date | null; seen_ids: string[] }>(
        'SELECT seen_through, seen_ids::text[] AS seen_ids FROM alert_inbox WHERE org_id = $1 AND user_email = $2 AND project_id = $3',
        [org, ctx().user.email, projectId],
      ),
    );
  } catch (err) {
    notifyLog().warn({ projectId, error: why(err) }, 'alert inbox not read: showing the shared seen flag');
    return shared;
  }
  const row = r.rows[0];
  if (!row) return shared;
  const through = row.seen_through ? row.seen_through.getTime() : null;
  const ids = new Set(row.seen_ids);
  return (e) => (through !== null && Date.parse(e.at) <= through) || ids.has(e.id);
}

/**
 * Mark one of `events` (the project's stored inbox) seen for the caller — or,
 * with no id, all of them up to `through` (the newest time the caller was shown;
 * never past the newest stored), so an event that landed after the bell drew
 * stays unseen. The caller's row only; the events are not written. `seen_ids`
 * is pruned to the events still stored, so it never outgrows them.
 */
export async function markSeenFor(projectId: string, events: AlertEvent[], eventId?: string, through?: string): Promise<boolean> {
  if (!isValidId(projectId)) return false;
  const live = events.map((e) => e.id);
  const email = ctx().user.email;
  if (eventId) {
    if (!live.includes(eventId)) return true; // no longer in the inbox: nothing to mark
    // A first row keeps what the shared flag already marked seen for everyone.
    const first = [...new Set(events.filter((e) => e.seen).map((e) => e.id).concat(eventId))];
    await inOrg((c, org) =>
      c.query(
        `INSERT INTO alert_inbox (org_id, user_email, project_id, seen_ids) VALUES ($1, $2, $3, $4::uuid[])
         ON CONFLICT (org_id, user_email, project_id) DO UPDATE SET
           seen_ids = ARRAY(SELECT DISTINCT x FROM unnest(alert_inbox.seen_ids || $5::uuid[]) AS x WHERE x = ANY($6::uuid[])),
           updated_at = now()`,
        [org, email, projectId, first, [eventId], live],
      ),
    );
    return true;
  }
  const times = events.map((e) => Date.parse(e.at)).filter(Number.isFinite);
  if (!times.length) return true;
  const shown = through === undefined ? NaN : Date.parse(through);
  const newest = new Date(Number.isFinite(shown) ? Math.min(shown, Math.max(...times)) : Math.max(...times)).toISOString();
  await inOrg((c, org) =>
    c.query(
      `INSERT INTO alert_inbox (org_id, user_email, project_id, seen_through) VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (org_id, user_email, project_id) DO UPDATE SET
         seen_through = GREATEST(alert_inbox.seen_through, EXCLUDED.seen_through),
         seen_ids = ARRAY(SELECT x FROM unnest(alert_inbox.seen_ids) AS x WHERE x = ANY($5::uuid[])),
         updated_at = now()`,
      [org, email, projectId, newest, live],
    ),
  );
  return true;
}
