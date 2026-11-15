// Who a folder opens to, as people (docs/team-folders/00-design.md, "Who can open what"): the resolver's rule run for
// every member at once, for the move warning and Share → Folders' head counts. Admins (org or project) open every
// folder, so they are not here: no move or grant changes what they see.

import type { PoolClient } from 'pg';
import type { FolderLevel } from './folders';

export interface Member {
  readonly id: string;
  readonly email: string;
  /** Their project role's rank: 1 viewer, 2 editor (admins are left out). */
  readonly rank: 1 | 2;
  /** Every team they are in (lowercase ids). */
  readonly teams: readonly string[];
}

/** The project's members folders restrict: enabled, not an org admin, a project role below admin — one statement. */
export async function membersOn(c: PoolClient, org: string, projectId: string): Promise<Member[]> {
  const r = await c.query<{ id: string; email: string; rank: number; teams: string[] }>(
    `SELECT u.id::text AS id, u.email,
            max(CASE g.role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)::int AS rank,
            array(SELECT tm.team_id::text FROM team_members tm WHERE tm.user_id = u.id) AS teams
       FROM users u
       JOIN project_grants g ON g.org_id = u.org_id AND g.project_id = $2
        AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))
      WHERE u.org_id = $1 AND u.disabled_at IS NULL AND u.role <> 'admin'
      GROUP BY u.id, u.email
      ORDER BY u.email`,
    [org, projectId.toLowerCase()],
  );
  return r.rows
    .filter((m) => m.rank === 1 || m.rank === 2)
    .map((m) => ({ id: m.id.toLowerCase(), email: m.email, rank: m.rank as 1 | 2, teams: (m.teams ?? []).map((t) => t.toLowerCase()) }));
}

/**
 * A member's level on a folder whose root is `root` (the project id: Everyone; null: no root — too deep, broken),
 * given the grants on that root: the resolver's `levelAt`, by person.
 */
export function levelAt(m: Member, root: string | null, projectId: string, grants: ReadonlyArray<{ teamId: string; level: 'view' | 'edit' }>): FolderLevel {
  if (root === null) return 'none';
  const cap: FolderLevel = m.rank === 2 ? 'edit' : 'view';
  if (root === projectId.toLowerCase()) return cap;
  const mine = grants.filter((g) => m.teams.includes(g.teamId.toLowerCase())).map((g) => g.level);
  if (!mine.length) return 'none';
  return mine.includes('edit') && cap === 'edit' ? 'edit' : 'view';
}
