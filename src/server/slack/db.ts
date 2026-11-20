// Slack's Postgres rows (0041_slack.sql) and its four secrets. The pool and the secret store are wired once by app.ts
// (`useSlackDb`); without a database there is no Slack.
//
// ROW-LEVEL SECURITY. The tables are forced under RLS (the migration says how), so every statement runs in a transaction
// that names its scope — `scoped()` — and sees only that scope's rows:
//   { org }    the org's own rows            { team }   one Slack workspace's rows (an event names only its team)
//   { state }  one Connect button, by its token's sha256 (the callback names no org)      'system'  the worker and the sweeps
// A statement that forgot its scope sees no row. The rest of this module's tables are in ./questionStore and ./linkStore.

import type { Pool, PoolClient } from 'pg';
import type { SecretStore } from '../secrets/store';

let pool: Pool | null = null;
let secrets: SecretStore | null = null;

export interface SlackLimits { timeoutMs: number; perMinute: number }
let limits: SlackLimits = { timeoutMs: 120_000, perMinute: 1200 };

/** `lim`: the RPC time limit and the per-user budget the app applies, which a Slack question is held to as well (./ask.ts). */
export function useSlackDb(p: Pool | null, s: SecretStore | null, lim?: SlackLimits): void {
  pool = p;
  secrets = s;
  if (lim) limits = lim;
}
export const slackLimits = (): SlackLimits => limits;

export function db(): Pool {
  if (!pool) throw new Error('Slack needs a database');
  return pool;
}
export const dbOrNull = (): Pool | null => pool;

export type Scope = { org: string } | { team: string } | { state: string } | 'system';

/** `fn` in ONE transaction that can see `scope`'s rows and nothing else's. */
export async function scoped<T>(scope: Scope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  let broken: Error | undefined;
  try {
    await c.query('BEGIN');
    const [key, value] = scope === 'system' ? ['ordinate.slack_scope', 'system'] : 'org' in scope ? ['ordinate.org', scope.org] : 'team' in scope ? ['ordinate.slack_team', scope.team] : ['ordinate.slack_state', scope.state];
    await c.query('SELECT set_config($1, $2, true)', [key, value]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch((e: Error) => { broken = e; });
    throw err;
  } finally {
    c.release(broken);
  }
}
/** One statement in `scope`. */
export const q = <R extends object = Record<string, unknown>>(scope: Scope, sql: string, params: unknown[] = []) => scoped(scope, (c) => c.query<R>(sql, params));

// ── secrets ──────────────────────────────────────────────────────────────────

export const SLACK_SECRETS = { botToken: 'slack.botToken', signingSecret: 'slack.signingSecret', clientSecret: 'slack.clientSecret', appToken: 'slack.appToken' } as const;
export type SlackSecretName = keyof typeof SLACK_SECRETS;
const REF = 'workspace';

export async function getSecret(org: string, name: SlackSecretName): Promise<string | null> {
  return secrets ? secrets.get(org, SLACK_SECRETS[name], REF) : null;
}
export async function putSecret(org: string, name: SlackSecretName, value: string): Promise<void> {
  if (!secrets) throw new Error('Saving a Slack key needs ORDINATE_MASTER_KEY');
  await secrets.put(org, SLACK_SECRETS[name], REF, value);
}
export async function dropSecrets(org: string): Promise<void> {
  if (secrets) for (const k of Object.keys(SLACK_SECRETS) as SlackSecretName[]) await secrets.delete(org, SLACK_SECRETS[k], REF);
}
export const canStoreSecrets = (): boolean => secrets !== null;

// ── installs ─────────────────────────────────────────────────────────────────

export interface Install {
  teamId: string; orgId: string; teamName: string; enterpriseId: string | null; appId: string; botUserId: string; clientId: string;
  mode: 'events' | 'socket'; enabled: boolean; allowGuests: boolean; allowShareOverride: boolean;
}
const INSTALL_COLS = `team_id AS "teamId", org_id AS "orgId", team_name AS "teamName", enterprise_id AS "enterpriseId", app_id AS "appId",
  bot_user_id AS "botUserId", client_id AS "clientId", mode, enabled, allow_guests AS "allowGuests", allow_share_override AS "allowShareOverride"`;

export async function installByTeam(team: string): Promise<Install | null> {
  return (await q<Install>({ team }, `SELECT ${INSTALL_COLS} FROM slack_installs WHERE team_id = $1`, [team])).rows[0] ?? null;
}
export async function installByOrg(org: string): Promise<Install | null> {
  return (await q<Install>({ org }, `SELECT ${INSTALL_COLS} FROM slack_installs WHERE org_id = $1`, [org])).rows[0] ?? null;
}
export async function allInstalls(): Promise<Install[]> {
  return (await q<Install>('system', `SELECT ${INSTALL_COLS} FROM slack_installs WHERE enabled ORDER BY created_at LIMIT 200`)).rows;
}
/** Installs that want a Socket Mode connection from some pod. */
export async function socketInstalls(): Promise<Install[]> {
  return (await q<Install>('system', `SELECT ${INSTALL_COLS} FROM slack_installs WHERE enabled AND mode = 'socket' ORDER BY created_at LIMIT 200`)).rows;
}
/** Is any workspace switched on? The worker idles while none is. */
export async function anyEnabledInstall(): Promise<boolean> {
  return !!(await q('system', 'SELECT 1 FROM slack_installs WHERE enabled LIMIT 1')).rowCount;
}

/** Saves the org's install (one workspace per org); a team already installed in ANOTHER org is refused. */
export async function saveInstall(i: Omit<Install, 'allowGuests' | 'allowShareOverride' | 'enabled'>): Promise<'ok' | 'taken'> {
  if ((await q('system', 'SELECT 1 FROM slack_installs WHERE team_id = $1 AND org_id <> $2', [i.teamId, i.orgId])).rowCount) return 'taken';
  // One install per org: a different workspace replaces the old one (its links and channels belong to that team).
  const old = await installByOrg(i.orgId);
  if (old && old.teamId !== i.teamId) await wipeTeam(i.orgId, old.teamId);
  await q({ org: i.orgId },
    `INSERT INTO slack_installs (team_id, org_id, team_name, enterprise_id, app_id, bot_user_id, client_id, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (team_id) DO UPDATE SET team_name = $3, enterprise_id = $4, app_id = $5, bot_user_id = $6, client_id = $7, mode = $8, enabled = true, updated_at = now()`,
    [i.teamId, i.orgId, i.teamName, i.enterpriseId, i.appId, i.botUserId, i.clientId, i.mode]);
  return 'ok';
}

export async function setSettings(org: string, s: { mode?: 'events' | 'socket'; allowGuests?: boolean; allowShareOverride?: boolean; enabled?: boolean }): Promise<void> {
  await q({ org },
    `UPDATE slack_installs SET mode = COALESCE($2, mode), allow_guests = COALESCE($3, allow_guests), allow_share_override = COALESCE($4, allow_share_override),
       enabled = COALESCE($5, enabled), updated_at = now() WHERE org_id = $1`,
    [org, s.mode ?? null, s.allowGuests ?? null, s.allowShareOverride ?? null, s.enabled ?? null]);
}

/** Everything of a workspace: the admin uninstalled it, or another workspace replaced it. */
export async function wipeTeam(org: string, team: string): Promise<void> {
  await scoped({ org }, async (c) => {
    for (const t of ['slack_links', 'slack_link_states', 'slack_questions', 'slack_threads', 'slack_channel_agents', 'slack_installs']) await c.query(`DELETE FROM ${t} WHERE team_id = $1 AND org_id = $2`, [team, org]);
  });
  await q('system', 'DELETE FROM slack_socket_slots WHERE team_id = $1', [team]);
}

/** Slack said the app is gone (app_uninstalled, or its BOT token revoked): off, and what was waiting is dropped. */
export async function markUninstalled(team: string): Promise<void> {
  await scoped({ team }, async (c) => {
    await c.query('UPDATE slack_installs SET enabled = false, updated_at = now() WHERE team_id = $1', [team]);
    await c.query(`UPDATE slack_questions SET status = 'dropped', text = '', finished_at = now() WHERE team_id = $1 AND status IN ('pending', 'awaiting_link')`, [team]);
  });
}

// ── Socket Mode slots: a pod holds one of SOCKET_SLOTS per install while it keeps a connection (no org data: no RLS) ──

export const SOCKET_SLOTS = 10;

/** Takes a free (or lapsed) slot for `owner`, or returns null when all ten are held. One statement per slot; the unique key decides a race. */
export async function takeSlot(team: string, owner: string, leaseMs: number): Promise<number | null> {
  for (let slot = 1; slot <= SOCKET_SLOTS; slot += 1) {
    const r = await db().query(
      `INSERT INTO slack_socket_slots (team_id, slot, lease_owner, lease_until) VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (team_id, slot) DO UPDATE SET lease_owner = $3, lease_until = now() + ($4 || ' milliseconds')::interval WHERE slack_socket_slots.lease_until < now()`,
      [team, slot, owner, String(leaseMs)]);
    if (r.rowCount) return slot;
  }
  return null;
}
/** Pushes the lease on; false when the slot is no longer this owner's (it lapsed and another pod took it). */
export async function renewSlot(team: string, slot: number, owner: string, leaseMs: number): Promise<boolean> {
  return !!(await db().query(`UPDATE slack_socket_slots SET lease_until = now() + ($4 || ' milliseconds')::interval WHERE team_id = $1 AND slot = $2 AND lease_owner = $3`, [team, slot, owner, String(leaseMs)])).rowCount;
}
export async function releaseSlot(team: string, slot: number, owner: string): Promise<void> {
  await db().query('DELETE FROM slack_socket_slots WHERE team_id = $1 AND slot = $2 AND lease_owner = $3', [team, slot, owner]);
}

export * from './questionStore';
export * from './linkStore';
