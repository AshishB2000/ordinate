// Who a Slack account is, the Connect buttons, which agent answers a channel, and the Slack threads (0041). Every
// statement runs in its scope (./db.ts `scoped`): the org's own, or one workspace's (an event names only its team).

import { createHash, randomBytes } from 'crypto';
import { q, scoped } from './db';

// ── links ────────────────────────────────────────────────────────────────────

export async function linkedEmail(org: string, team: string, slackUser: string): Promise<string | null> {
  return (await q<{ user_email: string }>({ org }, 'SELECT user_email FROM slack_links WHERE org_id = $1 AND team_id = $2 AND slack_user_id = $3', [org, team, slackUser])).rows[0]?.user_email ?? null;
}
/** The emails of the linked ones among `slackUsers`, by Slack id: one query. */
export async function linkedAmong(org: string, team: string, slackUsers: readonly string[]): Promise<Map<string, string>> {
  const r = await q<{ slack_user_id: string; user_email: string }>({ org },
    'SELECT slack_user_id, user_email FROM slack_links WHERE org_id = $1 AND team_id = $2 AND slack_user_id = ANY($3::text[])', [org, team, slackUsers]);
  return new Map(r.rows.map((x) => [x.slack_user_id, x.user_email]));
}
export async function saveLink(org: string, team: string, slackUser: string, email: string): Promise<void> {
  await q({ org },
    `INSERT INTO slack_links (org_id, team_id, slack_user_id, user_email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, team_id, slack_user_id) DO UPDATE SET user_email = $4, linked_at = now()`, [org, team, slackUser, email]);
}
export async function myLinks(org: string, email: string): Promise<Array<{ teamId: string; slackUserId: string; linkedAt: string }>> {
  return (await q<{ teamId: string; slackUserId: string; linkedAt: string }>({ org }, `SELECT team_id AS "teamId", slack_user_id AS "slackUserId", linked_at::text AS "linkedAt" FROM slack_links WHERE org_id = $1 AND user_email = $2`, [org, email])).rows;
}
export async function deleteLinksOf(org: string, email: string): Promise<number> {
  return (await q({ org }, 'DELETE FROM slack_links WHERE org_id = $1 AND user_email = $2', [org, email])).rowCount ?? 0;
}
export async function allLinks(org: string): Promise<Array<{ slackUserId: string; email: string; linkedAt: string }>> {
  return (await q<{ slackUserId: string; email: string; linkedAt: string }>({ org }, `SELECT slack_user_id AS "slackUserId", user_email AS email, linked_at::text AS "linkedAt" FROM slack_links WHERE org_id = $1 ORDER BY linked_at DESC LIMIT 500`, [org])).rows;
}
/** A person's user token was revoked in Slack: their link goes (the next question asks them to connect again). */
export async function deleteLinkOf(team: string, slackUser: string): Promise<void> {
  await q({ team }, 'DELETE FROM slack_links WHERE team_id = $1 AND slack_user_id = $2', [team, slackUser]);
}

// ── Connect states: the token is in the URL, only its sha256 is stored (as file tokens and refresh hooks) ──

export const STATE_MINUTES = 10;
export const stateHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export interface LinkState { orgId: string; teamId: string; slackUserId: string; userEmail: string | null; questionId: string | null; nonce: string }
const STATE_COLS = `org_id AS "orgId", team_id AS "teamId", slack_user_id AS "slackUserId", user_email AS "userEmail", question_id AS "questionId", nonce`;

export async function newState(org: string, team: string, slackUser: string, questionId: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await q({ org },
    `INSERT INTO slack_link_states (token_hash, org_id, team_id, slack_user_id, question_id, nonce, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)`,
    [stateHash(token), org, team, slackUser, questionId, randomBytes(24).toString('base64url'), String(STATE_MINUTES)]);
  return token;
}
/** /api/slack/connect (a signed-in session): the Ordinate user goes on the state row — once. The same person may open their own button again; nobody else may take it over. */
export async function bindState(token: string, org: string, email: string): Promise<LinkState | null> {
  return (await q<LinkState>({ org },
    `UPDATE slack_link_states SET user_email = $3 WHERE token_hash = $1 AND org_id = $2 AND used_at IS NULL AND expires_at > now() AND (user_email IS NULL OR user_email = $3)
       RETURNING ${STATE_COLS}`, [stateHash(token), org, email])).rows[0] ?? null;
}
/** The callback: single use. Marks the row used and returns it, or null (unknown, expired, used, or never bound to a user). It names no org: the token's hash is the scope. */
export async function consumeState(token: string): Promise<LinkState | null> {
  const hash = stateHash(token);
  return (await q<LinkState>({ state: hash },
    `UPDATE slack_link_states SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND user_email IS NOT NULL RETURNING ${STATE_COLS}`, [hash])).rows[0] ?? null;
}

// ── channels and threads ─────────────────────────────────────────────────────

export interface ChannelAgent { teamId: string; channelId: string; orgId: string; projectId: string; agentId: string; channelName: string }
export async function channelAgent(team: string, channel: string): Promise<ChannelAgent | null> {
  return (await q<ChannelAgent>({ team },
    `SELECT team_id AS "teamId", channel_id AS "channelId", org_id AS "orgId", project_id AS "projectId", agent_id AS "agentId", channel_name AS "channelName"
       FROM slack_channel_agents WHERE team_id = $1 AND channel_id = $2`, [team, channel])).rows[0] ?? null;
}
export async function channelsOfAgent(org: string, projectId: string, agentId: string): Promise<Array<{ channelId: string; channelName: string }>> {
  return (await q<{ channelId: string; channelName: string }>({ org }, `SELECT channel_id AS "channelId", channel_name AS "channelName" FROM slack_channel_agents WHERE org_id = $1 AND project_id = $2 AND agent_id = $3 ORDER BY channel_name`, [org, projectId, agentId])).rows;
}
/** Ties channels to ONE agent (replacing that agent's set); a channel another agent holds is moved: one agent per channel. The caller has checked who may move what (./rpc.ts). */
export async function setAgentChannels(org: string, team: string, projectId: string, agentId: string, channels: ReadonlyArray<{ id: string; name: string }>): Promise<void> {
  await scoped({ org }, async (c) => {
    await c.query('DELETE FROM slack_channel_agents WHERE org_id = $1 AND project_id = $2 AND agent_id = $3', [org, projectId, agentId]);
    for (const ch of channels) {
      await c.query(
        `INSERT INTO slack_channel_agents (team_id, channel_id, org_id, project_id, agent_id, channel_name) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (team_id, channel_id) DO UPDATE SET project_id = $4, agent_id = $5, channel_name = $6, org_id = $3`, [team, ch.id, org, projectId, agentId, ch.name]);
    }
  });
}
export async function dropAgentChannels(org: string, projectId: string, agentId: string): Promise<void> {
  await q({ org }, 'DELETE FROM slack_channel_agents WHERE org_id = $1 AND project_id = $2 AND agent_id = $3', [org, projectId, agentId]);
}
export async function dropProjectChannels(org: string, projectId: string): Promise<void> {
  await q({ org }, 'DELETE FROM slack_channel_agents WHERE org_id = $1 AND project_id = $2', [org, projectId]);
}
export async function channelProjects(org: string): Promise<string[]> {
  return (await q<{ project_id: string }>({ org }, 'SELECT DISTINCT project_id FROM slack_channel_agents WHERE org_id = $1', [org])).rows.map((r) => r.project_id);
}

export interface SlackThread { projectId: string; threadId: string; askerEmail: string }
export async function threadOf(team: string, channel: string, ts: string): Promise<SlackThread | null> {
  return (await q<SlackThread>({ team }, 'SELECT project_id AS "projectId", thread_id AS "threadId", asker_email AS "askerEmail" FROM slack_threads WHERE team_id = $1 AND channel_id = $2 AND thread_ts = $3', [team, channel, ts])).rows[0] ?? null;
}
export async function saveThread(org: string, team: string, channel: string, ts: string, t: SlackThread): Promise<void> {
  await q({ org },
    `INSERT INTO slack_threads (team_id, channel_id, thread_ts, org_id, project_id, thread_id, asker_email) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [team, channel, ts, org, t.projectId, t.threadId, t.askerEmail]);
}

// ── the sweep (rides src/server/sharedState.ts, once per org) ────────────────

export async function sweep(org: string): Promise<void> {
  await scoped({ org }, async (c) => {
    await c.query(`DELETE FROM slack_link_states WHERE org_id = $1 AND expires_at < now() - interval '1 hour'`, [org]);
    // A question parked for a Connect button nobody pressed: when its state has expired it is dropped, and its words go with it.
    await c.query(
      `UPDATE slack_questions q SET status = 'dropped', text = '', finished_at = now()
        WHERE q.org_id = $1 AND q.status = 'awaiting_link'
          AND NOT EXISTS (SELECT 1 FROM slack_link_states s WHERE s.org_id = q.org_id AND s.question_id = q.id AND s.used_at IS NULL AND s.expires_at > now())`, [org]);
    await c.query(`DELETE FROM slack_questions WHERE org_id = $1 AND finished_at < now() - interval '30 days'`, [org]);
    await c.query(`DELETE FROM slack_links l WHERE l.org_id = $1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = l.org_id AND u.email = l.user_email AND u.disabled_at IS NULL)`, [org]);
    // assistant_threads is under forced row-level security on the same setting: read as the org, or every row looks orphaned.
    await c.query(`DELETE FROM slack_threads s WHERE s.org_id = $1 AND NOT EXISTS (SELECT 1 FROM assistant_threads a WHERE a.org_id = s.org_id AND a.project_id = s.project_id AND a.id = s.thread_id)`, [org]);
  });
  // A channel tied to a project that is gone or archived stops answering (it is also checked when a question arrives).
  const projects = require('../../app/projects') as typeof import('../../app/projects');
  for (const id of await channelProjects(org)) {
    const p = await projects.getProject(id).catch(() => null);
    if (!p || p.archivedAt) await dropProjectChannels(org, id);
  }
  await q('system', `DELETE FROM slack_events WHERE received_at < now() - interval '24 hours'`);
  await q('system', `DELETE FROM slack_socket_slots WHERE lease_until < now() - interval '1 hour'`);
}
