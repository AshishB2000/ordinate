// Admin → Users and Teams (T3.4). The route has already checked the caller is
// an org admin (src/api/admin.ts); every statement here is confined to the
// caller's org by `org_id = ctx().org.id`, so another org's id matches nothing.
//
// Two guards keep an org from locking itself out: the last enabled admin can
// be neither demoted nor disabled, and nobody disables themselves.
// (ORDINATE_ADMIN_EMAIL is re-made admin at every sign-in as well — T3.2.)

import type { Pool } from 'pg';
import { ctx, type Role } from '../context';
import { registry } from '../rpc';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  /** Invited and never signed in. */
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly teams: number;
}

export interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly members: { readonly id: string; readonly email: string }[];
}

type Result = { ok: true } | { ok: false; error: string };

const iso = (col: string, as: string) => `to_json(${col}) #>> '{}' AS "${as}"`;

/** Other enabled admins than `userId` in the org — the last-admin guard's question. */
const OTHER_ADMINS = `(SELECT count(*) FROM users o WHERE o.org_id = $1 AND o.id <> $2 AND o.role = 'admin' AND o.disabled_at IS NULL)`;

/** `allowedDomains()`: ALLOWED_EMAIL_DOMAINS, read per call. */
export function register(pool: () => Pool | null, allowedDomains: () => readonly string[]): void {
  const db = (): Pool => {
    const p = pool();
    if (!p) throw new Error('admin needs Postgres (DATABASE_URL)');
    return p;
  };
  const org = () => ctx().org.id;

  registry.handle('admin:users', async (): Promise<UserRow[]> => {
    const r = await db().query<UserRow>(
      `SELECT u.id, u.email, u.role, u.last_login_at IS NULL AS pending, u.disabled_at IS NOT NULL AS disabled,
              ${iso('u.created_at', 'createdAt')}, ${iso('u.last_login_at', 'lastLoginAt')},
              (SELECT count(*)::int FROM team_members m WHERE m.user_id = u.id) AS teams
         FROM users u WHERE u.org_id = $1 ORDER BY u.email`,
      [org()],
    );
    return r.rows;
  });

  registry.handle('admin:invite', async (_e, { email, role }: { email: string; role: Role }): Promise<Result & { id?: string }> => {
    const e = email.trim().toLowerCase();
    const domain = e.slice(e.lastIndexOf('@') + 1);
    // Sign-in would refuse this address anyway (ALLOWED_EMAIL_DOMAINS); say so now.
    const allowed = allowedDomains();
    if (allowed.length > 0 && !allowed.includes(domain)) return { ok: false, error: 'domain' };
    // A pending member: no last_login_at until their first sign-in, which keeps the role set here.
    const r = await db().query<{ id: string }>(
      `INSERT INTO users (org_id, email, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, email) DO NOTHING RETURNING id`,
      [org(), e, role],
    );
    return r.rows[0] ? { ok: true, id: r.rows[0].id } : { ok: false, error: 'exists' };
  });

  registry.handle('admin:setRole', async (_e, { userId, role }: { userId: string; role: Role }): Promise<Result> => {
    const r = await db().query(
      `UPDATE users SET role = $3 WHERE org_id = $1 AND id = $2 AND ($3 = 'admin' OR role <> 'admin' OR ${OTHER_ADMINS} > 0)`,
      [org(), userId, role],
    );
    if (r.rowCount === 1) return { ok: true };
    return { ok: false, error: (await exists(db(), org(), userId)) ? 'last-admin' : 'unknown' };
  });

  registry.handle('admin:setDisabled', async (_e, { userId, disabled }: { userId: string; disabled: boolean }): Promise<Result> => {
    const self = await db().query('SELECT 1 FROM users WHERE org_id = $1 AND id = $2 AND email = $3', [org(), userId, ctx().user.email]);
    if (disabled && self.rowCount === 1) return { ok: false, error: 'self' };
    const r = await db().query(
      disabled
        ? `UPDATE users SET disabled_at = coalesce(disabled_at, now()) WHERE org_id = $1 AND id = $2 AND (role <> 'admin' OR ${OTHER_ADMINS} > 0)`
        : `UPDATE users SET disabled_at = NULL WHERE org_id = $1 AND id = $2`,
      [org(), userId],
    );
    if (r.rowCount !== 1) return { ok: false, error: (await exists(db(), org(), userId)) ? 'last-admin' : 'unknown' };
    // Signed out everywhere now, not at the next request (sessions and tokens already refuse a disabled user).
    if (disabled) await db().query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return { ok: true };
  });

  registry.handle('admin:teams', async (): Promise<TeamRow[]> => {
    const r = await db().query<TeamRow>(
      `SELECT t.id, t.name, ${iso('t.created_at', 'createdAt')},
              coalesce(json_agg(json_build_object('id', u.id, 'email', u.email) ORDER BY u.email) FILTER (WHERE u.id IS NOT NULL), '[]') AS members
         FROM teams t
         LEFT JOIN team_members m ON m.team_id = t.id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE t.org_id = $1
        GROUP BY t.id ORDER BY t.name`,
      [org()],
    );
    return r.rows;
  });

  registry.handle('admin:createTeam', async (_e, { name }: { name: string }): Promise<Result & { id?: string }> => {
    const r = await db().query<{ id: string }>(
      'INSERT INTO teams (org_id, name) VALUES ($1, $2) ON CONFLICT (org_id, name) DO NOTHING RETURNING id',
      [org(), name],
    );
    return r.rows[0] ? { ok: true, id: r.rows[0].id } : { ok: false, error: 'exists' };
  });

  registry.handle('admin:renameTeam', async (_e, { teamId, name }: { teamId: string; name: string }): Promise<Result> => {
    try {
      const r = await db().query('UPDATE teams SET name = $3 WHERE org_id = $1 AND id = $2', [org(), teamId, name]);
      return r.rowCount === 1 ? { ok: true } : { ok: false, error: 'unknown' };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return { ok: false, error: 'exists' };
      throw err;
    }
  });

  registry.handle(
    'admin:teamMember',
    async (_e, { teamId, userId, member }: { teamId: string; userId: string; member: boolean }): Promise<Result> => {
      // Both must be this org's: the SELECT finds nothing for another org's team or user.
      const r = member
        ? await db().query(
            `INSERT INTO team_members (team_id, user_id)
             SELECT t.id, u.id FROM teams t, users u WHERE t.id = $2 AND t.org_id = $1 AND u.id = $3 AND u.org_id = $1
             ON CONFLICT DO NOTHING`,
            [org(), teamId, userId],
          )
        : await db().query(
            `DELETE FROM team_members m USING teams t WHERE m.team_id = t.id AND t.org_id = $1 AND m.team_id = $2 AND m.user_id = $3`,
            [org(), teamId, userId],
          );
      if (r.rowCount === 1) return { ok: true };
      // Already in (or already out) is fine; an id from nowhere is not.
      const known = await db().query(
        'SELECT 1 FROM teams t, users u WHERE t.id = $2 AND t.org_id = $1 AND u.id = $3 AND u.org_id = $1',
        [org(), teamId, userId],
      );
      return known.rowCount === 1 ? { ok: true } : { ok: false, error: 'unknown' };
    },
  );
}

async function exists(pool: Pool, org: string, userId: string): Promise<boolean> {
  return (await pool.query('SELECT 1 FROM users WHERE org_id = $1 AND id = $2', [org, userId])).rowCount === 1;
}
