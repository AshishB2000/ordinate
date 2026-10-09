// Password accounts in Postgres (0010_passwords.sql): the first-run setup
// code, the first admin, credentials for a sign-in, and setting a password.
// Every statement is confined to one org. Sessions are ./store.ts's, shared
// with OIDC.

import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { Role } from '../context';
import type { AuthEnv } from '../env';
import { newSetupCode } from './passwordHash';

/** How long a printed setup code stays usable. A restart prints a fresh one. */
export const SETUP_CODE_HOURS = 24;

// pg_advisory_xact_lock key for creating the first admin: two browsers racing
// the setup screen get one admin, and the other a "closed" answer.
const SETUP_LOCK = 'ordinate:setup:';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** True while no enabled admin of the org has a password — the setup screen is shown. */
export async function setupOpen(pool: Pool, org: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM users WHERE org_id = $1 AND role = 'admin' AND disabled_at IS NULL AND password_hash IS NOT NULL LIMIT 1`,
    [org],
  );
  return r.rowCount === 0;
}

/**
 * A new setup code for this pod, its hash stored for every pod to accept, or
 * null when setup is already done. Expired codes are swept here.
 */
export async function issueSetupCode(pool: Pool, org: string): Promise<string | null> {
  if (!(await setupOpen(pool, org))) return null;
  await pool.query('DELETE FROM setup_codes WHERE expires_at <= now()');
  const code = newSetupCode();
  await pool.query(`INSERT INTO setup_codes (code_hash, org_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 hour')`, [
    sha256(code),
    org,
    SETUP_CODE_HOURS,
  ]);
  return code;
}

/** Whether `code` (already normalised) is a live setup code of the org. */
export async function setupCodeValid(pool: Pool, org: string, code: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM setup_codes WHERE code_hash = $1 AND org_id = $2 AND expires_at > now()', [sha256(code), org]);
  return r.rowCount === 1;
}

/**
 * Creates the first admin (or makes an existing row of that email one, with
 * this password), and retires every setup code. 'closed' when an admin with a
 * password appeared meanwhile; 'code' when the code is no longer live. Checked
 * again under the lock: the caller's earlier checks only saved hashing work.
 */
export async function completeSetup(pool: Pool, org: string, email: string, hash: string, code: string): Promise<{ userId: string } | 'closed' | 'code'> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SETUP_LOCK + org]);
    const admins = await c.query(
      `SELECT 1 FROM users WHERE org_id = $1 AND role = 'admin' AND disabled_at IS NULL AND password_hash IS NOT NULL LIMIT 1`,
      [org],
    );
    if (admins.rowCount !== 0) {
      await c.query('ROLLBACK');
      return 'closed';
    }
    const live = await c.query('SELECT 1 FROM setup_codes WHERE code_hash = $1 AND org_id = $2 AND expires_at > now()', [sha256(code), org]);
    if (live.rowCount !== 1) {
      await c.query('ROLLBACK');
      return 'code';
    }
    const r = await c.query<{ id: string }>(
      `INSERT INTO users (org_id, email, role, password_hash, must_change_password, last_login_at) VALUES ($1, $2, 'admin', $3, false, now())
       ON CONFLICT (org_id, email) DO UPDATE
         SET role = 'admin', password_hash = $3, must_change_password = false, disabled_at = NULL, last_login_at = now()
       RETURNING id`,
      [org, email, hash],
    );
    await c.query('DELETE FROM setup_codes WHERE org_id = $1', [org]);
    await c.query('COMMIT');
    return { userId: r.rows[0].id };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export interface Credentials {
  readonly userId: string;
  readonly hash: string | null;
  readonly disabled: boolean;
}

/** What a sign-in checks the password against, or null for an unknown email. */
export async function credentials(pool: Pool, org: string, email: string): Promise<Credentials | null> {
  const r = await pool.query<{ id: string; password_hash: string | null; disabled: boolean }>(
    'SELECT id, password_hash, disabled_at IS NOT NULL AS disabled FROM users WHERE org_id = $1 AND email = $2',
    [org, email],
  );
  const row = r.rows[0];
  return row ? { userId: row.id, hash: row.password_hash, disabled: row.disabled } : null;
}

/**
 * Stamps a successful sign-in. ORDINATE_ADMIN_EMAIL is made admin here too,
 * as at every SSO sign-in (./store.ts provision): the way back in.
 */
export async function stampSignIn(pool: Pool, auth: AuthEnv, userId: string, email: string): Promise<{ role: Role; mustChange: boolean }> {
  const r = await pool.query<{ role: Role; must_change_password: boolean }>(
    `UPDATE users SET last_login_at = now(), role = CASE WHEN $2 THEN 'admin' ELSE role END
      WHERE id = $1 RETURNING role, must_change_password`,
    [userId, auth.adminEmail === email],
  );
  return { role: r.rows[0].role, mustChange: r.rows[0].must_change_password };
}

/**
 * Sets a member's password. `temporary`: an admin chose it, so it must be
 * changed at the next sign-in. Returns false when no such member is in the org.
 */
export async function setPassword(pool: Pool, org: string, userId: string, hash: string, temporary: boolean): Promise<boolean> {
  const r = await pool.query('UPDATE users SET password_hash = $3, must_change_password = $4 WHERE org_id = $1 AND id = $2', [
    org,
    userId,
    hash,
    temporary,
  ]);
  return r.rowCount === 1;
}
