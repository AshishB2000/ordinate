// Slack's Postgres rows (0041_slack.sql) and its four secrets. The pool and the secret store are wired once by
// app.ts (`useSlackDb`); without a database there is no Slack. Every statement names its org.

import { randomBytes } from 'crypto';
import type { Pool } from 'pg';
import type { SecretStore } from '../secrets/store';
import { inOrg } from '../db/inOrg';

let pool: Pool | null = null;
let secrets: SecretStore | null = null;

export function useSlackDb(p: Pool | null, s: SecretStore | null): void {
  pool = p;
  secrets = s;
}

export function db(): Pool {
  if (!pool) throw new Error('Slack needs a database');
  return pool;
}
export const dbOrNull = (): Pool | null => pool;

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
  return (await db().query<Install>(`SELECT ${INSTALL_COLS} FROM slack_installs WHERE team_id = $1`, [team])).rows[0] ?? null;
}
export async function installByOrg(org: string): Promise<Install | null> {
  return (await db().query<Install>(`SELECT ${INSTALL_COLS} FROM slack_installs WHERE org_id = $1`, [org])).rows[0] ?? null;
}
export async function allInstalls(): Promise<Install[]> {
  return (await db().query<Install>(`SELECT ${INSTALL_COLS} FROM slack_installs WHERE enabled ORDER BY created_at LIMIT 200`)).rows;
}

/** Saves the org's install (one workspace per org); a team already installed in ANOTHER org is refused. */
export async function saveInstall(i: Omit<Install, 'allowGuests' | 'allowShareOverride' | 'enabled'>): Promise<'ok' | 'taken'> {
  const other = await db().query('SELECT 1 FROM slack_installs WHERE team_id = $1 AND org_id <> $2', [i.teamId, i.orgId]);
  if (other.rowCount) return 'taken';
  // One install per org: a different workspace replaces the old one (its links and channels belong to that team).
  const old = await installByOrg(i.orgId);
  if (old && old.teamId !== i.teamId) await wipeTeam(i.orgId, old.teamId);
  await db().query(
    `INSERT INTO slack_installs (team_id, org_id, team_name, enterprise_id, app_id, bot_user_id, client_id, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (team_id) DO UPDATE SET team_name = $3, enterprise_id = $4, app_id = $5, bot_user_id = $6, client_id = $7, mode = $8, enabled = true, updated_at = now()`,
    [i.teamId, i.orgId, i.teamName, i.enterpriseId, i.appId, i.botUserId, i.clientId, i.mode],
  );
  return 'ok';
}

export async function setSettings(org: string, s: { mode?: 'events' | 'socket'; allowGuests?: boolean; allowShareOverride?: boolean; enabled?: boolean }): Promise<void> {
  await db().query(
    `UPDATE slack_installs SET mode = COALESCE($2, mode), allow_guests = COALESCE($3, allow_guests), allow_share_override = COALESCE($4, allow_share_override),
       enabled = COALESCE($5, enabled), updated_at = now() WHERE org_id = $1`,
    [org, s.mode ?? null, s.allowGuests ?? null, s.allowShareOverride ?? null, s.enabled ?? null],
  );
}

/** Installs that want a Socket Mode connection from some pod. */
export async function socketInstalls(): Promise<Install[]> {
  return (await db().query<Install>(`SELECT ${INSTALL_COLS} FROM slack_installs WHERE enabled AND mode = 'socket' ORDER BY created_at LIMIT 200`)).rows;
}

// ── Socket Mode slots: a pod holds one of SOCKET_SLOTS per install while it keeps a connection ──

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

/** Everything of a workspace: the admin uninstalled it, or another workspace replaced it. */
export async function wipeTeam(org: string, team: string): Promise<void> {
  for (const t of ['slack_links', 'slack_link_states', 'slack_questions', 'slack_threads', 'slack_channel_agents', 'slack_socket_slots', 'slack_installs']) {
    await db().query(`DELETE FROM ${t} WHERE team_id = $1 AND ${t === 'slack_socket_slots' ? `$2::text IS NOT NULL` : 'org_id = $2'}`, [team, org]);
  }
}

/** Slack said the app is gone (app_uninstalled, tokens_revoked): off, and what was waiting is dropped. */
export async function markUninstalled(team: string): Promise<void> {
  await db().query('UPDATE slack_installs SET enabled = false, updated_at = now() WHERE team_id = $1', [team]);
  await db().query(`UPDATE slack_questions SET status = 'dropped', finished_at = now() WHERE team_id = $1 AND status IN ('pending', 'awaiting_link')`, [team]);
}

// ── events and questions ─────────────────────────────────────────────────────

/** True the first time an event id is seen; a Slack retry gets false and is acknowledged as a no-op. */
export async function recordEvent(eventId: string): Promise<boolean> {
  return !!(await db().query('INSERT INTO slack_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId])).rowCount;
}

export interface NewQuestion {
  id: string; orgId: string; teamId: string; kind?: 'ask' | 'share'; channelId: string; channelType: 'channel' | 'im'; threadTs: string | null; eventTs: string | null;
  slackUserId: string; text: string; ofQuestion?: string | null;
}
export async function enqueue(q: NewQuestion): Promise<void> {
  await db().query(
    `INSERT INTO slack_questions (id, org_id, team_id, kind, channel_id, channel_type, thread_ts, event_ts, slack_user_id, text, of_question)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [q.id, q.orgId, q.teamId, q.kind ?? 'ask', q.channelId, q.channelType, q.threadTs, q.eventTs, q.slackUserId, q.text, q.ofQuestion ?? null],
  );
}

export interface Question {
  id: string; orgId: string; teamId: string; kind: 'ask' | 'share'; channelId: string; channelType: 'channel' | 'im'; threadTs: string | null; eventTs: string | null;
  slackUserId: string; text: string; placeholderTs: string | null; projectId: string | null; agentId: string | null; threadId: string | null;
  ofQuestion: string | null; attempts: number;
}
const Q_COLS = `id, org_id AS "orgId", team_id AS "teamId", kind, channel_id AS "channelId", channel_type AS "channelType", thread_ts AS "threadTs",
  event_ts AS "eventTs", slack_user_id AS "slackUserId", text, placeholder_ts AS "placeholderTs", project_id AS "projectId", agent_id AS "agentId",
  thread_id AS "threadId", of_question AS "ofQuestion", attempts`;

/** The lease a claim holds; the heartbeat pushes it on. A crashed pod's lease lapses and the next poll retakes the row. */
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;

/** Claims one due question (pending, or running with a lapsed lease) for `owner`; null when none. One statement, SKIP LOCKED. */
export async function claim(owner: string, leaseMs = LEASE_MS): Promise<Question | null> {
  const r = await db().query<Question>(
    `UPDATE slack_questions SET status = 'running', lease_owner = $1, lease_until = now() + ($2 || ' milliseconds')::interval, attempts = attempts + 1
      WHERE id = (SELECT id FROM slack_questions WHERE (status = 'pending' OR (status = 'running' AND lease_until < now()))
                   AND attempts < ${MAX_ATTEMPTS} ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${Q_COLS}`,
    [owner, String(leaseMs)],
  );
  return r.rows[0] ?? null;
}
/** A question that ran out of attempts (its pod kept dying): failed, so the thread is not left waiting forever. */
export async function failExhausted(): Promise<Question[]> {
  return (await db().query<Question>(
    `UPDATE slack_questions SET status = 'failed', outcome = 'gave_up', finished_at = now()
      WHERE status = 'running' AND lease_until < now() AND attempts >= ${MAX_ATTEMPTS} RETURNING ${Q_COLS}`,
  )).rows;
}
export async function heartbeat(id: string, owner: string, leaseMs = LEASE_MS): Promise<boolean> {
  return !!(await db().query(`UPDATE slack_questions SET lease_until = now() + ($3 || ' milliseconds')::interval WHERE id = $1 AND lease_owner = $2 AND status = 'running'`, [id, owner, String(leaseMs)])).rowCount;
}
/** The claim's own writes: only while this owner holds the row (the owner column is the fence). */
export async function setPlaceholder(id: string, owner: string, ts: string, projectId: string | null, agentId: string | null): Promise<void> {
  await db().query('UPDATE slack_questions SET placeholder_ts = $3, project_id = $4, agent_id = $5 WHERE id = $1 AND lease_owner = $2', [id, owner, ts, projectId, agentId]);
}
export async function finish(id: string, owner: string, status: 'done' | 'failed' | 'awaiting_link', outcome: string, threadId?: string | null): Promise<boolean> {
  return !!(await db().query(
    `UPDATE slack_questions SET status = $3, outcome = $4, thread_id = COALESCE($5, thread_id), lease_owner = NULL, lease_until = NULL, finished_at = CASE WHEN $3 = 'awaiting_link' THEN NULL ELSE now() END
      WHERE id = $1 AND lease_owner = $2`, [id, owner, status, outcome, threadId ?? null],
  )).rowCount;
}
export async function questionById(org: string, id: string): Promise<Question | null> {
  return (await db().query<Question>(`SELECT ${Q_COLS} FROM slack_questions WHERE id = $1 AND org_id = $2`, [id, org])).rows[0] ?? null;
}
/** A parked question goes back in the queue once its asker has linked. */
export async function resume(org: string, id: string): Promise<void> {
  await db().query(`UPDATE slack_questions SET status = 'pending', attempts = 0 WHERE id = $1 AND org_id = $2 AND status = 'awaiting_link'`, [id, org]);
}
export async function saveAnswer(id: string, owner: string, answer: unknown): Promise<void> {
  await db().query('UPDATE slack_questions SET answer = $3::jsonb WHERE id = $1 AND lease_owner = $2', [id, owner, JSON.stringify(answer)]);
}
export async function answerOf(org: string, id: string): Promise<{ answer: unknown; channelId: string; channelType: string; placeholderTs: string | null; threadTs: string | null } | null> {
  return (await db().query(`SELECT answer, channel_id AS "channelId", channel_type AS "channelType", placeholder_ts AS "placeholderTs", thread_ts AS "threadTs"
    FROM slack_questions WHERE id = $1 AND org_id = $2 AND answer IS NOT NULL`, [id, org])).rows[0] ?? null;
}
export async function shareExists(of: string): Promise<boolean> {
  return !!(await db().query(`SELECT 1 FROM slack_questions WHERE of_question = $1 AND kind = 'share' AND status IN ('pending', 'running', 'done')`, [of])).rowCount;
}
export async function setFeedback(org: string, id: string, v: 'helpful' | 'not_helpful'): Promise<boolean> {
  return !!(await db().query('UPDATE slack_questions SET feedback = $3 WHERE id = $1 AND org_id = $2', [id, org, v])).rowCount;
}

// ── links ────────────────────────────────────────────────────────────────────

export async function linkedEmail(org: string, team: string, slackUser: string): Promise<string | null> {
  return (await db().query<{ user_email: string }>('SELECT user_email FROM slack_links WHERE org_id = $1 AND team_id = $2 AND slack_user_id = $3', [org, team, slackUser])).rows[0]?.user_email ?? null;
}
/** The emails of the linked ones among `slackUsers`, by Slack id: one query. */
export async function linkedAmong(org: string, team: string, slackUsers: readonly string[]): Promise<Map<string, string>> {
  const r = await db().query<{ slack_user_id: string; user_email: string }>(
    'SELECT slack_user_id, user_email FROM slack_links WHERE org_id = $1 AND team_id = $2 AND slack_user_id = ANY($3::text[])', [org, team, slackUsers]);
  return new Map(r.rows.map((x) => [x.slack_user_id, x.user_email]));
}
export async function saveLink(org: string, team: string, slackUser: string, email: string): Promise<void> {
  await db().query(
    `INSERT INTO slack_links (org_id, team_id, slack_user_id, user_email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, team_id, slack_user_id) DO UPDATE SET user_email = $4, linked_at = now()`, [org, team, slackUser, email]);
}
export async function myLinks(org: string, email: string): Promise<Array<{ teamId: string; slackUserId: string; linkedAt: string }>> {
  return (await db().query(`SELECT team_id AS "teamId", slack_user_id AS "slackUserId", linked_at::text AS "linkedAt" FROM slack_links WHERE org_id = $1 AND user_email = $2`, [org, email])).rows;
}
export async function deleteLinksOf(org: string, email: string): Promise<number> {
  return (await db().query('DELETE FROM slack_links WHERE org_id = $1 AND user_email = $2', [org, email])).rowCount ?? 0;
}
export async function allLinks(org: string): Promise<Array<{ slackUserId: string; email: string; linkedAt: string }>> {
  return (await db().query(`SELECT slack_user_id AS "slackUserId", user_email AS email, linked_at::text AS "linkedAt" FROM slack_links WHERE org_id = $1 ORDER BY linked_at DESC LIMIT 500`, [org])).rows;
}
export async function deleteLink(org: string, slackUser: string): Promise<boolean> {
  return !!(await db().query('DELETE FROM slack_links WHERE org_id = $1 AND slack_user_id = $2', [org, slackUser])).rowCount;
}

// ── Connect states ───────────────────────────────────────────────────────────

export const STATE_MINUTES = 10;
export interface LinkState { token: string; orgId: string; teamId: string; slackUserId: string; userEmail: string | null; questionId: string | null; nonce: string }

export async function newState(org: string, team: string, slackUser: string, questionId: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db().query(
    `INSERT INTO slack_link_states (token, org_id, team_id, slack_user_id, question_id, nonce, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)`,
    [token, org, team, slackUser, questionId, randomBytes(24).toString('base64url'), String(STATE_MINUTES)]);
  return token;
}
/** /api/slack/connect (a signed-in session): the Ordinate user goes on the state row. Only an unused, unexpired, unbound-or-same row. */
export async function bindState(token: string, org: string, email: string): Promise<LinkState | null> {
  return (await db().query<LinkState>(
    `UPDATE slack_link_states SET user_email = $3 WHERE token = $1 AND org_id = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING token, org_id AS "orgId", team_id AS "teamId", slack_user_id AS "slackUserId", user_email AS "userEmail", question_id AS "questionId", nonce`,
    [token, org, email])).rows[0] ?? null;
}
/** The callback: single use. Marks the row used and returns it, or null (unknown, expired, used, or never bound to a user). */
export async function consumeState(token: string): Promise<LinkState | null> {
  return (await db().query<LinkState>(
    `UPDATE slack_link_states SET used_at = now() WHERE token = $1 AND used_at IS NULL AND expires_at > now() AND user_email IS NOT NULL
       RETURNING token, org_id AS "orgId", team_id AS "teamId", slack_user_id AS "slackUserId", user_email AS "userEmail", question_id AS "questionId", nonce`,
    [token])).rows[0] ?? null;
}

// ── channels and threads ─────────────────────────────────────────────────────

export interface ChannelAgent { teamId: string; channelId: string; orgId: string; projectId: string; agentId: string; channelName: string }
export async function channelAgent(team: string, channel: string): Promise<ChannelAgent | null> {
  return (await db().query<ChannelAgent>(
    `SELECT team_id AS "teamId", channel_id AS "channelId", org_id AS "orgId", project_id AS "projectId", agent_id AS "agentId", channel_name AS "channelName"
       FROM slack_channel_agents WHERE team_id = $1 AND channel_id = $2`, [team, channel])).rows[0] ?? null;
}
export async function channelsOfAgent(org: string, projectId: string, agentId: string): Promise<Array<{ channelId: string; channelName: string }>> {
  return (await db().query(`SELECT channel_id AS "channelId", channel_name AS "channelName" FROM slack_channel_agents WHERE org_id = $1 AND project_id = $2 AND agent_id = $3 ORDER BY channel_name`, [org, projectId, agentId])).rows;
}
/** Ties channels to ONE agent (replacing that agent's set); a channel another agent holds is moved: one agent per channel. */
export async function setAgentChannels(org: string, team: string, projectId: string, agentId: string, channels: ReadonlyArray<{ id: string; name: string }>): Promise<void> {
  await db().query('DELETE FROM slack_channel_agents WHERE org_id = $1 AND project_id = $2 AND agent_id = $3', [org, projectId, agentId]);
  for (const c of channels) {
    await db().query(
      `INSERT INTO slack_channel_agents (team_id, channel_id, org_id, project_id, agent_id, channel_name) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (team_id, channel_id) DO UPDATE SET project_id = $4, agent_id = $5, channel_name = $6, org_id = $3`, [team, c.id, org, projectId, agentId, c.name]);
  }
}
export async function dropAgentChannels(org: string, projectId: string, agentId: string): Promise<void> {
  await db().query('DELETE FROM slack_channel_agents WHERE org_id = $1 AND project_id = $2 AND agent_id = $3', [org, projectId, agentId]);
}

export interface SlackThread { projectId: string; threadId: string; askerEmail: string }
export async function threadOf(team: string, channel: string, ts: string): Promise<SlackThread | null> {
  return (await db().query<SlackThread>('SELECT project_id AS "projectId", thread_id AS "threadId", asker_email AS "askerEmail" FROM slack_threads WHERE team_id = $1 AND channel_id = $2 AND thread_ts = $3', [team, channel, ts])).rows[0] ?? null;
}
export async function saveThread(org: string, team: string, channel: string, ts: string, t: SlackThread): Promise<void> {
  await db().query(
    `INSERT INTO slack_threads (team_id, channel_id, thread_ts, org_id, project_id, thread_id, asker_email) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [team, channel, ts, org, t.projectId, t.threadId, t.askerEmail]);
}

// ── the sweep (rides src/server/sharedState.ts, once per org) ────────────────

export async function sweep(org: string): Promise<void> {
  const q = (sql: string) => db().query(sql, [org]);
  await q(`DELETE FROM slack_link_states WHERE org_id = $1 AND expires_at < now() - interval '1 hour'`);
  await db().query(`DELETE FROM slack_events WHERE received_at < now() - interval '24 hours'`);
  await q(`DELETE FROM slack_questions WHERE org_id = $1 AND finished_at < now() - interval '30 days'`);
  await q(`DELETE FROM slack_links l WHERE l.org_id = $1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = l.org_id AND u.email = l.user_email AND u.disabled_at IS NULL)`);
  // assistant_threads has forced row-level security: read it as the org, or every row looks orphaned.
  await inOrg((c) => c.query(`DELETE FROM slack_threads s WHERE s.org_id = $1 AND NOT EXISTS (SELECT 1 FROM assistant_threads a WHERE a.org_id = s.org_id AND a.project_id = s.project_id AND a.id = s.thread_id)`, [org]), org);
  await db().query(`DELETE FROM slack_socket_slots WHERE lease_until < now() - interval '1 hour'`);
}
