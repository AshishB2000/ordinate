// Users and sessions in Postgres (0003_auth.sql). Every sign-in mode ends
// here: `provision` turns a verified email into an org membership, and the
// browser modes hold a session whose id the client keeps and the DB knows
// only as a sha256.
//
// Expiry is decided by the DB clock (`now()`), never a pod's, so N pods with
// drifting clocks agree on whether a session is alive.

import { createHash, randomBytes } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type { Identity, Role } from '../context';
import type { AuthEnv } from '../env';

/** What the client holds: 256 random bits, base64url (43 chars). */
export const newSessionId = (): string => randomBytes(32).toString('base64url');

/** What the DB holds instead of the id. */
export const hashId = (id: string): string => createHash('sha256').update(id).digest('hex');

const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** A lower-cased, plausibly-shaped email, or null. */
export function normalEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 320 && EMAIL_RE.test(e) ? e : null;
}

export async function ensureOrg(pool: Pool, org: string): Promise<void> {
  await pool.query('INSERT INTO orgs (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [org]);
}

export type Refusal = 'domain' | 'disabled';

export interface Member {
  readonly userId: string;
  readonly identity: Identity;
}

/** ALLOWED_EMAIL_DOMAINS' rule (empty = any domain) — sign-in's, and so also whom email may reach (docs/email). */
export function domainAllowed(allowed: readonly string[], email: string): boolean {
  return allowed.length === 0 || allowed.includes(email.slice(email.lastIndexOf('@') + 1));
}

/**
 * The org membership for a signed-in `email` (already normalised), created on
 * first sign-in as a viewer. ORDINATE_ADMIN_EMAIL is made admin on EVERY
 * sign-in: the bootstrap on an empty org, and the way back in if the last
 * admin was demoted. ALLOWED_EMAIL_DOMAINS refuses before anything is written.
 */
export async function provision(pool: Pool, auth: AuthEnv, email: string): Promise<Member | Refusal> {
  if (!domainAllowed(auth.allowedDomains, email)) return 'domain';
  const isAdmin = auth.adminEmail === email;
  const r = await pool.query<{ id: string; role: Role; disabled: boolean }>(
    `INSERT INTO users (org_id, email, role, last_login_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (org_id, email) DO UPDATE
       SET last_login_at = now(), role = CASE WHEN $4 THEN 'admin' ELSE users.role END
     RETURNING id, role, disabled_at IS NOT NULL AS disabled`,
    [auth.org, email, isAdmin ? 'admin' : 'viewer', isAdmin],
  );
  const row = r.rows[0];
  if (row.disabled) return 'disabled';
  return { userId: row.id, identity: { user: { email, role: row.role }, org: { id: auth.org } } };
}

/**
 * The member for `email` if it exists, is enabled and has signed in before —
 * no write (header mode asks this per request). An invited member (T3.4: a row
 * with no last_login_at yet) is not returned, so their first request goes
 * through `provision`, which stamps the sign-in and keeps the invited role.
 */
export async function member(pool: Pool, auth: AuthEnv, email: string): Promise<Identity | null> {
  const r = await pool.query<{ role: Role }>('SELECT role FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL AND last_login_at IS NOT NULL', [
    auth.org,
    email,
  ]);
  return r.rows[0] ? { user: { email, role: r.rows[0].role }, org: { id: auth.org } } : null;
}

/**
 * Starts a session for `userId` and returns the id for the cookie. Rotation:
 * the session the browser arrived with (`previous`, if any) is deleted, so a
 * planted id never becomes a signed-in one. Dead sessions are swept here too —
 * sign-in is rare enough to carry the cleanup.
 */
export async function createSession(pool: Pool, auth: AuthEnv, userId: string, previous?: string): Promise<string> {
  if (previous) await endSession(pool, previous);
  await pool.query(`DELETE FROM sessions WHERE expires_at <= now() OR last_seen_at <= now() - $1 * interval '1 millisecond'`, [
    auth.sessionIdleMs,
  ]);
  const id = newSessionId();
  await pool.query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 millisecond')`, [
    hashId(id),
    userId,
    auth.sessionAbsoluteMs,
  ]);
  return id;
}

/**
 * Who holds session `id`, or null when it is unknown, idle past
 * SESSION_IDLE_MINUTES, past its absolute expiry, or its user is disabled.
 * A live lookup slides the idle window.
 * ponytail: one UPDATE per authenticated request; throttle last_seen_at to
 * once a minute if Postgres write load ever shows it.
 */
export async function sessionIdentity(pool: Pool, auth: AuthEnv, id: string): Promise<Identity | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  const r = await pool.query<{ email: string; role: Role; org_id: string; must_change_password: boolean }>(
    `WITH s AS (
       UPDATE sessions SET last_seen_at = now()
        WHERE id_hash = $1 AND expires_at > now() AND last_seen_at > now() - $2 * interval '1 millisecond'
        RETURNING user_id)
     SELECT u.email, u.role, u.org_id, u.must_change_password FROM s JOIN users u ON u.id = s.user_id WHERE u.disabled_at IS NULL`,
    [hashId(id), auth.sessionIdleMs],
  );
  const row = r.rows[0];
  if (!row) return null;
  const who: Identity = { user: { email: row.email, role: row.role }, org: { id: row.org_id } };
  // A temporary password (an admin set it): app.ts holds every /api/ call but /api/auth/* until it is
  // changed — under password sign-in only. After a move to SSO the flag is moot, and there is no page to clear it.
  return auth.mode === 'password' && row.must_change_password ? { ...who, mustChangePassword: true } : who;
}

export async function endSession(pool: Pool, id: string): Promise<void> {
  if (SESSION_ID_RE.test(id)) await pool.query('DELETE FROM sessions WHERE id_hash = $1', [hashId(id)]);
}

/** Ends every session of `userId` except `keep` (a password change keeps the browser that made it). */
export async function endOtherSessions(pool: Pool, userId: string, keep: string | undefined): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2', [userId, keep && SESSION_ID_RE.test(keep) ? hashId(keep) : '']);
}

/** Logout everywhere: every session of this member. Returns how many ended. */
export async function endAllSessions(pool: Pool, org: string, email: string): Promise<number> {
  const r = await pool.query('DELETE FROM sessions s USING users u WHERE s.user_id = u.id AND u.org_id = $1 AND u.email = $2', [
    org,
    email,
  ]);
  return r.rowCount ?? 0;
}

/**
 * Other enabled admins than `$2` in org `$1` who have signed in: the last-admin rule's question, the ONE
 * rule every path asks (Admin → People and the IdP sync). A pending invitee does not count: under IdP-managed
 * roles their first sign-in replaces the role they were invited with.
 */
export const OTHER_ADMINS = `(SELECT count(*) FROM users o WHERE o.org_id = $1 AND o.id <> $2 AND o.role = 'admin' AND o.disabled_at IS NULL AND o.last_login_at IS NOT NULL)`;

/** The org gained an admin: a last admin kept by the IdP sync is evaluated again at its next sync (`'kept:'` digests). */
export const CLEAR_KEPT = `UPDATE users SET idp_groups_digest = NULL WHERE org_id = $1 AND idp_groups_digest LIKE 'kept:%'`;

// Test seam: the people lock's negative control runs without it (scripts/test-idpGroups).
let peopleLock = true;
export function setPeopleLockForTest(on: boolean): void {
  peopleLock = on;
}

/**
 * One transaction under the org's PEOPLE LOCK (docs/sso-lifecycle/00-design.md §3.6): SHARED for an IdP sync,
 * EXCLUSIVE for an admin's change to roles, teams or the group map, and for a sync that demotes an admin. So
 * the last-admin rule holds when several demotions race, and a sync never applies a map being replaced.
 */
export async function withPeopleLock<T>(pool: Pool, org: string, mode: 'shared' | 'exclusive', fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (peopleLock) await c.query(`SELECT ${mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'}(hashtextextended($1, 0))`, ['people:' + org]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
