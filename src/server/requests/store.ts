// The `dashboard_requests` and `dashboard_request_inbox` rows (0037). Every statement runs as the caller's org (forced
// RLS, ../db/inOrg.ts); the caller's address comes from ctx(), never from input. A request holds its answers' chart
// forms, never a figure; the inbox is who was told (the bell), as `mentions` and `editor_asks` are.

import type { PoolClient } from 'pg';
import { sanitizeStoredSpec, type AnswerSpec } from '../../ai/answerSpec';
import { ctx } from '../context';
import { inOrg } from '../db/inOrg';

export type RequestState = 'open' | 'drafted' | 'approved' | 'declined' | 'withdrawn';
/** Inbox rows kept per member, newest first (as `mentions`). */
const MAX_ROWS = 200;
/** An approval under way older than this was cut short (a pod went away): another approver may take it. */
const CLAIM = `interval '10 minutes'`;

export interface DashboardRequest {
  projectId: string;
  id: string;
  requester: string;
  title: string;
  note: string;
  charts: AnswerSpec[];
  state: RequestState;
  decidedBy: string | null;
  answer: string;
  dashboardId: string | null;
  /** An existing dashboard the charts go onto (0038), else null: a new one. */
  targetId: string | null;
  /** The folder the requester suggested for a new dashboard (the project id: Everyone), else null. */
  folderId: string | null;
  createdAt: string;
}

interface Row {
  project_id: string; id: string; requester: string; title: string; note: string; charts: unknown; state: RequestState;
  decided_by: string | null; answer: string; dashboard_id: string | null; target_id: string | null; folder_id: string | null; created_at: Date;
}
const COLUMNS = 'project_id::text, id::text, requester, title, note, charts, state, decided_by, answer, dashboard_id::text, target_id::text, folder_id::text, created_at';

function fromRow(r: Row): DashboardRequest {
  return {
    projectId: r.project_id, id: r.id, requester: r.requester, title: r.title, note: r.note, state: r.state, decidedBy: r.decided_by,
    charts: (Array.isArray(r.charts) ? r.charts : []).map(sanitizeStoredSpec).filter((s): s is AnswerSpec => !!s),
    answer: r.answer, dashboardId: r.dashboard_id, targetId: r.target_id, folderId: r.folder_id, createdAt: r.created_at.toISOString(),
  };
}

/** Each member's newest MAX_ROWS inbox rows. */
async function trim(c: PoolClient, org: string, emails: string[]): Promise<void> {
  await c.query(
    `DELETE FROM dashboard_request_inbox i WHERE i.org_id = $1 AND i.user_email = ANY($2::text[])
       AND i.request_id NOT IN (SELECT k.request_id FROM dashboard_request_inbox k WHERE k.org_id = $1 AND k.user_email = i.user_email
                                 ORDER BY k.created_at DESC LIMIT ${MAX_ROWS})`,
    [org, emails],
  );
}

/**
 * The request, a row in each approver's bell, and the requester's own row — already seen, so their bell lists it (to
 * withdraw) without a badge — in one transaction. False, writing nothing: the requester already has `maxOpen` open
 * in the project (counted under a lock on them and the project, so two sends at once cannot both pass).
 */
export async function insertRequest(
  r: Pick<DashboardRequest, 'id' | 'projectId' | 'requester' | 'title' | 'note' | 'charts' | 'targetId' | 'folderId'>, approvers: string[], maxOpen: number,
): Promise<boolean> {
  return inOrg(async (c, org) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('dashboard_requests:' || $1 || ':' || $2 || ':' || $3, 0))", [org, r.projectId, r.requester]);
    const open = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM dashboard_requests WHERE org_id = $1 AND project_id = $2 AND requester = $3 AND state = 'open'",
      [org, r.projectId, r.requester],
    );
    if ((open.rows[0]?.n ?? 0) >= maxOpen) return false;
    await c.query(
      `INSERT INTO dashboard_requests (org_id, id, project_id, requester, title, note, charts, target_id, folder_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid, $9::uuid)`,
      [org, r.id, r.projectId, r.requester, r.title, r.note, JSON.stringify(r.charts), r.targetId, r.folderId],
    );
    await c.query(
      `INSERT INTO dashboard_request_inbox (org_id, user_email, request_id, project_id, role)
       SELECT $1, u, $2, $3, 'approver' FROM unnest($4::text[]) AS u ON CONFLICT DO NOTHING`,
      [org, r.id, r.projectId, approvers],
    );
    await c.query(
      `INSERT INTO dashboard_request_inbox (org_id, user_email, request_id, project_id, role, seen_at) VALUES ($1, $2, $3, $4, 'requester', now())
       ON CONFLICT DO NOTHING`,
      [org, r.requester, r.id, r.projectId],
    );
    await trim(c, org, [...approvers, r.requester]);
    return true;
  });
}

/**
 * The requester takes their open request back — unless an approval holds it — and the approvers' bell rows go.
 * Null: not theirs, not open, or being approved. Else the request and whose rows went.
 */
export async function withdraw(projectId: string, id: string): Promise<{ request: DashboardRequest; told: string[] } | null> {
  const me = ctx().user.email;
  return inOrg(async (c, org) => {
    const r = await c.query<Row>(
      `UPDATE dashboard_requests SET state = 'withdrawn', decided_by = requester, decided_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3 AND requester = $4 AND state = 'open'
          AND (decided_at IS NULL OR decided_at < now() - ${CLAIM})
        RETURNING ${COLUMNS}`,
      [org, projectId, id, me],
    );
    if (!r.rows[0]) return null;
    const gone = await c.query<{ user_email: string }>("DELETE FROM dashboard_request_inbox WHERE org_id = $1 AND request_id = $2 AND role = 'approver' RETURNING user_email", [org, id]);
    return { request: fromRow(r.rows[0]), told: gone.rows.map((x) => x.user_email) };
  });
}

/** The request `id` of `projectId`, or null. */
export async function getRequest(projectId: string, id: string): Promise<DashboardRequest | null> {
  const r = await inOrg((c, org) => c.query<Row>(`SELECT ${COLUMNS} FROM dashboard_requests WHERE org_id = $1 AND project_id = $2 AND id = $3`, [org, projectId, id]));
  return r.rows[0] ? fromRow(r.rows[0]) : null;
}

/** Takes an open request for the caller's approval, unless another approval is under way. */
export async function claim(projectId: string, id: string): Promise<boolean> {
  const r = await inOrg((c, org) => c.query(
    `UPDATE dashboard_requests SET decided_by = $4, decided_at = now()
      WHERE org_id = $1 AND project_id = $2 AND id = $3 AND state = 'open' AND (decided_at IS NULL OR decided_at < now() - ${CLAIM})`,
    [org, projectId, id, ctx().user.email],
  ));
  return r.rowCount === 1;
}

/** Gives back the caller's claim: the approval made nothing. */
export async function release(projectId: string, id: string): Promise<void> {
  await inOrg((c, org) => c.query(
    `UPDATE dashboard_requests SET decided_by = NULL, decided_at = NULL WHERE org_id = $1 AND project_id = $2 AND id = $3 AND state = 'open' AND decided_by = $4`,
    [org, projectId, id, ctx().user.email],
  ));
}

/** The requester's bell row (new again, unseen) and the approvers' rows seen: it no longer waits on them. */
async function toRequester(c: PoolClient, org: string, r: { id: string; projectId: string; requester: string }): Promise<void> {
  await c.query(
    `INSERT INTO dashboard_request_inbox (org_id, user_email, request_id, project_id, role) VALUES ($1, $2, $3, $4, 'requester')
     ON CONFLICT (org_id, user_email, request_id) DO UPDATE SET created_at = now(), seen_at = NULL`,
    [org, r.requester, r.id, r.projectId],
  );
  await trim(c, org, [r.requester]);
}

/**
 * Decides an open request — the caller's claim, or one nobody holds — as `state`. Approved or declined, the
 * requester's row is written in the same transaction; the approvers' rows are marked seen. Null: it was not open, or
 * another approval holds it.
 */
export async function finish(projectId: string, id: string, to: { state: Exclude<RequestState, 'open'>; answer?: string; dashboardId?: string }): Promise<DashboardRequest | null> {
  return inOrg(async (c, org) => {
    const r = await c.query<Row>(
      `UPDATE dashboard_requests SET state = $4, answer = $5, dashboard_id = $6::uuid, decided_by = $7, decided_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3 AND state = 'open'
          AND (decided_by = $7 OR decided_at IS NULL OR decided_at < now() - ${CLAIM})
        RETURNING ${COLUMNS}`,
      [org, projectId, id, to.state, to.answer ?? '', to.dashboardId ?? null, ctx().user.email],
    );
    const row = r.rows[0];
    if (!row) return null;
    await c.query(`UPDATE dashboard_request_inbox SET seen_at = now() WHERE org_id = $1 AND request_id = $2 AND role = 'approver' AND seen_at IS NULL`, [org, id]);
    if (to.state !== 'drafted') await toRequester(c, org, { id, projectId, requester: row.requester });
    return fromRow(row);
  });
}

/** A drafted request's dashboard was published: approved now, and its requester's row written. One statement when there is none. */
export async function publishedNow(projectId: string, dashboardId: string): Promise<DashboardRequest[]> {
  return inOrg(async (c, org) => {
    const r = await c.query<Row>(
      `UPDATE dashboard_requests SET state = 'approved' WHERE org_id = $1 AND project_id = $2 AND dashboard_id = $3::uuid AND state = 'drafted' RETURNING ${COLUMNS}`,
      [org, projectId, dashboardId],
    );
    for (const row of r.rows) await toRequester(c, org, { id: row.id, projectId, requester: row.requester });
    return r.rows.map(fromRow);
  });
}

/**
 * Who may see a bell row now ($1 org, $2 email, $3 is an org admin): a requester's row on a project they read, an
 * approver's on one they edit (authz `readable` and `writable`, in SQL, as ../mentions/store.ts has them).
 */
export const INBOX_SHOWN = `$3::boolean OR i.project_id IN (
                SELECT g.project_id FROM users u
                  JOIN project_grants g ON g.org_id = u.org_id AND (i.role = 'requester' OR g.role IN ('editor', 'admin'))
                   AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))
                 WHERE u.org_id = $1 AND u.email = $2 AND u.disabled_at IS NULL)`;

export interface InboxRow extends DashboardRequest {
  role: 'approver' | 'requester';
  at: string;
  seen: boolean;
}

/** The caller's bell rows, unseen first, then newest. */
export async function listInbox(limit: number): Promise<InboxRow[]> {
  const { user } = ctx();
  const r = await inOrg((c, org) => c.query<Row & { role: InboxRow['role']; at: Date; seen_at: Date | null }>(
    `SELECT ${COLUMNS.split(', ').map((x) => `r.${x}`).join(', ')}, i.role, i.created_at AS at, i.seen_at
       FROM dashboard_request_inbox i JOIN dashboard_requests r ON r.org_id = i.org_id AND r.id = i.request_id
      WHERE i.org_id = $1 AND i.user_email = $2 AND (${INBOX_SHOWN})
      ORDER BY (i.seen_at IS NULL) DESC, i.created_at DESC
      LIMIT $4`,
    [org, user.email, user.role === 'admin', limit],
  ));
  return r.rows.map((x) => ({ ...fromRow(x), role: x.role, at: x.at.toISOString(), seen: x.seen_at !== null }));
}
