// Project sharing (T3.3): the handlers behind `project:access` (who holds
// which role) and `project:share` (grant, change, remove). The route has
// already checked the caller — read on the project for the list, project
// admin for a change — so these only check that the grantee is a user or
// team of the caller's org. The owner team's grant is not changed here
// (ownership moves in Admin → Projects, ../admin/org.ts). Server only: they
// need Postgres.

import type { Pool } from 'pg';
import { ctx } from '../context';
import { registry } from '../rpc';

type Role = 'viewer' | 'editor' | 'admin';
type Member = { userId: string } | { teamId: string };

export interface Grant {
  readonly kind: 'user' | 'team';
  readonly id: string;
  /** The user's email or the team's name. */
  readonly label: string;
  readonly role: Role;
  readonly owner: boolean;
}

/** Registers the two channels; `pool()` is read per call (null → the server has no Postgres). */
export function register(pool: () => Pool | null): void {
  const db = (): Pool => {
    const p = pool();
    if (!p) throw new Error('sharing needs Postgres (DATABASE_URL)');
    return p;
  };

  registry.handle('project:access', async (_e, { projectId }: { projectId: string }): Promise<Grant[]> => {
    const r = await db().query<Grant>(
      `SELECT CASE WHEN g.user_id IS NULL THEN 'team' ELSE 'user' END AS kind,
              coalesce(g.user_id, g.team_id)::text AS id,
              coalesce(u.email, t.name) AS label, g.role, g.owner
         FROM project_grants g
         LEFT JOIN users u ON u.id = g.user_id
         LEFT JOIN teams t ON t.id = g.team_id
        WHERE g.org_id = $1 AND g.project_id = $2
        ORDER BY g.owner DESC, kind, label`,
      [ctx().org.id, projectId],
    );
    return r.rows;
  });

  registry.handle(
    'project:share',
    async (_e, { projectId, member, role }: { projectId: string; member: Member; role: Role | null }): Promise<{ ok: boolean; error?: string }> => {
      const org = ctx().org.id;
      const [col, id, table] = 'userId' in member ? ['user_id', member.userId, 'users'] : ['team_id', member.teamId, 'teams'];
      const exists = await db().query(`SELECT 1 FROM ${table} WHERE id = $1 AND org_id = $2`, [id, org]);
      if (exists.rowCount !== 1) return { ok: false, error: 'unknown member' };
      if (role === null) {
        await db().query(`DELETE FROM project_grants WHERE org_id = $1 AND project_id = $2 AND ${col} = $3 AND NOT owner`, [org, projectId, id]);
        return { ok: true };
      }
      const r = await db().query(
        `INSERT INTO project_grants (org_id, project_id, ${col}, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, project_id, ${col}) DO UPDATE SET role = EXCLUDED.role WHERE NOT project_grants.owner`,
        [org, projectId, id, role],
      );
      return r.rowCount === 1 ? { ok: true } : { ok: false, error: 'owner' };
    },
  );
}
