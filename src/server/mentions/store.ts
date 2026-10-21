// The `mentions` rows (0020) and the member's "Email me when someone mentions me"
// (users.mention_email). Every statement is the CALLER's: the address comes from
// ctx(), never from input. Forced RLS: one org per transaction (../db/inOrg.ts).

import type { PoolClient } from 'pg';
import { ctx } from '../context';
import { inOrg, orgDb } from '../db/inOrg';

/** Rows kept per member, newest first. */
export const MAX_ROWS = 200;

export interface MentionRow {
  projectId: string;
  pieceId: string;
  commentId: string;
  author: string;
  at: string;
  seen: boolean;
}

/**
 * Record that `emails` were named in a piece. Returns the addresses for which a
 * row was INSERTED — the gate for the push and the email: a person is told once
 * per piece, so a mention removed and added back tells no one again.
 */
export async function recordMentions(p: { projectId: string; pieceId: string; commentId: string; author: string }, emails: string[]): Promise<string[]> {
  if (!emails.length) return [];
  return inOrg(async (c, org) => {
    const r = await c.query<{ user_email: string }>(
      `INSERT INTO mentions (org_id, user_email, piece_id, project_id, comment_id, author)
       SELECT $1, u, $2, $3, $4, $5 FROM unnest($6::text[]) AS u
       ON CONFLICT DO NOTHING RETURNING user_email`,
      [org, p.pieceId, p.projectId, p.commentId, p.author, emails],
    );
    const fresh = r.rows.map((x) => x.user_email);
    if (fresh.length) await trim(c, org, fresh);
    return fresh;
  });
}

/** Keep each member's newest MAX_ROWS. */
async function trim(c: PoolClient, org: string, emails: string[]): Promise<void> {
  await c.query(
    `DELETE FROM mentions m WHERE m.org_id = $1 AND m.user_email = ANY($2::text[])
       AND (m.project_id, m.piece_id) NOT IN (
         SELECT k.project_id, k.piece_id FROM mentions k WHERE k.org_id = $1 AND k.user_email = m.user_email
          ORDER BY k.created_at DESC LIMIT ${MAX_ROWS})`,
    [org, emails],
  );
}

/**
 * The caller's rows on projects they may read NOW (authz `readable`'s rule, in
 * SQL: an org admin reads every project; anyone else, a direct or team grant),
 * unseen first, then newest. `limit` leaves room for pieces deleted since.
 */
export async function listMine(limit: number): Promise<MentionRow[]> {
  const { user } = ctx();
  const r = await inOrg((c, org) =>
    c.query<{ project_id: string; piece_id: string; comment_id: string; author: string; created_at: Date; seen_at: Date | null }>(
      `SELECT m.project_id::text, m.piece_id::text, m.comment_id::text, m.author, m.created_at, m.seen_at
         FROM mentions m
        WHERE m.org_id = $1 AND m.user_email = $2
          AND ($3::boolean OR m.project_id IN (
                SELECT g.project_id FROM users u
                  JOIN project_grants g ON g.org_id = u.org_id
                   AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))
                 WHERE u.org_id = $1 AND u.email = $2 AND u.disabled_at IS NULL))
        ORDER BY (m.seen_at IS NULL) DESC, m.created_at DESC
        LIMIT $4`,
      [org, user.email, user.role === 'admin', limit],
    ),
  );
  return r.rows.map((x) => ({ projectId: x.project_id, pieceId: x.piece_id, commentId: x.comment_id, author: x.author, at: x.created_at.toISOString(), seen: x.seen_at !== null }));
}

/** Mark the caller's row of one piece seen — or, with neither id, all of theirs. */
export async function markSeen(projectId?: string, pieceId?: string): Promise<void> {
  const one = projectId && pieceId ? [projectId, pieceId] : [null, null];
  await inOrg((c, org) =>
    c.query(
      `UPDATE mentions SET seen_at = now()
        WHERE org_id = $1 AND user_email = $2 AND seen_at IS NULL
          AND ($3::uuid IS NULL OR (project_id = $3::uuid AND piece_id = $4::uuid))`,
      [org, ctx().user.email, ...one],
    ),
  );
}

/** The caller's "Email me when someone mentions me" (on unless they turned it off). */
export async function emailMe(): Promise<boolean> {
  const pool = orgDb();
  if (!pool) return false;
  const r = await pool.query<{ mention_email: boolean }>('SELECT mention_email FROM users WHERE org_id = $1 AND email = $2', [ctx().org.id, ctx().user.email]);
  return r.rows[0]?.mention_email ?? true;
}

export async function setEmailMe(on: boolean): Promise<boolean> {
  const pool = orgDb();
  if (!pool) return false;
  const r = await pool.query('UPDATE users SET mention_email = $3 WHERE org_id = $1 AND email = $2', [ctx().org.id, ctx().user.email, on]);
  return r.rowCount === 1;
}

/** The recipient's row as the email needs it: their id and their setting; null when they are not a member. */
export async function recipient(email: string): Promise<{ id: string; emailMe: boolean } | null> {
  const pool = orgDb();
  if (!pool) return null;
  const r = await pool.query<{ id: string; mention_email: boolean }>('SELECT id::text, mention_email FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [ctx().org.id, email]);
  return r.rows[0] ? { id: r.rows[0].id, emailMe: r.rows[0].mention_email } : null;
}
