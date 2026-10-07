// Admin → People under password sign-in (AUTH_MODE=password): add someone with
// a temporary password, or give someone a new one. Either way they must change
// it at their next sign-in (src/server/auth/password.ts), and a reset signs
// them out everywhere. The route has already checked the caller is an org
// admin; every statement is confined to the caller's org.
//
// The admin tells the person the password themselves: Ordinate sends no email.

import type { Pool } from 'pg';
import { ctx, type Role } from '../context';
import type { AuthMode } from '../env';
import { registry } from '../rpc';
import { hashPassword, passwordProblem } from '../auth/passwordHash';
import { setPassword } from '../auth/passwordStore';

type Result = { ok: true; id?: string } | { ok: false; error: string };

/** A refusal for a password an admin typed, or null when it may be used. */
function refusal(mode: AuthMode, password: string): Result | null {
  // In another mode nobody would ever sign in with it.
  if (mode !== 'password') return { ok: false, error: 'mode' };
  const p = passwordProblem(password);
  return p ? { ok: false, error: p === 'short' ? 'password-short' : 'password-long' } : null;
}

/** `mode()` and `allowedDomains()` are read per call (AUTH_MODE, ALLOWED_EMAIL_DOMAINS). */
export function register(pool: () => Pool | null, mode: () => AuthMode, allowedDomains: () => readonly string[]): void {
  const db = (): Pool => {
    const p = pool();
    if (!p) throw new Error('admin needs Postgres (DATABASE_URL)');
    return p;
  };

  registry.handle('admin:addUser', async (_e, { email, role, password }: { email: string; role: Role; password: string }): Promise<Result> => {
    const no = refusal(mode(), password);
    if (no) return no;
    const e = email.trim().toLowerCase();
    const allowed = allowedDomains();
    if (allowed.length > 0 && !allowed.includes(e.slice(e.lastIndexOf('@') + 1))) return { ok: false, error: 'domain' };
    // Someone already here (even invited without a password) is given one with Reset password instead.
    const r = await db().query<{ id: string }>(
      `INSERT INTO users (org_id, email, role, password_hash, must_change_password) VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (org_id, email) DO NOTHING RETURNING id`,
      [ctx().org.id, e, role, await hashPassword(password)],
    );
    return r.rows[0] ? { ok: true, id: r.rows[0].id } : { ok: false, error: 'exists' };
  });

  registry.handle('admin:resetPassword', async (_e, { userId, password }: { userId: string; password: string }): Promise<Result> => {
    const no = refusal(mode(), password);
    if (no) return no;
    const org = ctx().org.id;
    // Your own goes through Change password, which asks for the current one.
    const self = await db().query('SELECT 1 FROM users WHERE org_id = $1 AND id = $2 AND email = $3', [org, userId, ctx().user.email]);
    if (self.rowCount === 1) return { ok: false, error: 'self-password' };
    if (!(await setPassword(db(), org, userId, await hashPassword(password), true))) return { ok: false, error: 'unknown' };
    // Whoever held a session on the old password is out now.
    await db().query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return { ok: true };
  });
}
