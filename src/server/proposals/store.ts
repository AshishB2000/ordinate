// The `metric_proposals`, `metric_proposal_asks` and `metric_proposal_inbox` rows (0047). Every statement runs as the
// caller's org (forced RLS, ../db/inOrg.ts). A proposal holds a checked draft, never a figure; an ask holds a question's
// words only; the inbox is who was told (the bell), as dashboard requests keep it.

import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { ctx } from '../context';
import { inOrg } from '../db/inOrg';

export type ProposalState = 'open' | 'approved' | 'declined';
/** Inbox rows kept per member, newest first. */
const MAX_ROWS = 200;
/** Open proposals one project may hold: a bound on the table, never reached by one need. */
export const MAX_OPEN = 200;
/** An approval under way older than this was cut short (a pod went away): another approver may take it. */
const CLAIM = `interval '10 minutes'`;

/** What is stored of a draft once checked: the dataset is an id, the rest is the model's structure. */
export type StoredDraft = Record<string, unknown> & { kind: 'metric' | 'term'; name: string; datasetId: string; description: string; aliases: string[] };

export interface Proposal {
  projectId: string;
  id: string;
  kind: 'metric' | 'term';
  name: string;
  datasetId: string;
  draft: StoredDraft;
  state: ProposalState;
  decidedBy: string | null;
  edited: boolean;
  answer: string;
  savedId: string | null;
  createdAt: string;
  /** People who needed it (their distinct questions). */
  asks: number;
}

interface Row {
  project_id: string; id: string; kind: 'metric' | 'term'; name: string; dataset_id: string; draft: StoredDraft; state: ProposalState;
  decided_by: string | null; edited: boolean; answer: string; saved_id: string | null; created_at: Date; asks: number;
}
const COLUMNS = `p.project_id::text, p.id::text, p.kind, p.name, p.dataset_id::text, p.draft, p.state, p.decided_by, p.edited, p.answer, p.saved_id::text, p.created_at,
  (SELECT count(*)::int FROM metric_proposal_asks a WHERE a.org_id = p.org_id AND a.proposal_id = p.id) AS asks`;

const fromRow = (r: Row): Proposal => ({
  projectId: r.project_id, id: r.id, kind: r.kind, name: r.name, datasetId: r.dataset_id, draft: r.draft, state: r.state, decidedBy: r.decided_by,
  edited: r.edited, answer: r.answer, savedId: r.saved_id, createdAt: r.created_at.toISOString(), asks: r.asks,
});

export const nameKey = (name: string): string => name.trim().toLowerCase();
/** One question, one key: the same words from the same person are one ask. */
export const questionKey = (q: string): string => createHash('sha256').update(q.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 32);

export interface AskIn { email: string; question: string }

async function trim(c: PoolClient, org: string, emails: string[]): Promise<void> {
  if (!emails.length) return;
  await c.query(
    `DELETE FROM metric_proposal_inbox i WHERE i.org_id = $1 AND i.user_email = ANY($2::text[])
       AND i.proposal_id NOT IN (SELECT k.proposal_id FROM metric_proposal_inbox k WHERE k.org_id = $1 AND k.user_email = i.user_email
                                  ORDER BY k.created_at DESC LIMIT ${MAX_ROWS})`,
    [org, emails],
  );
}

async function addAsks(c: PoolClient, org: string, id: string, asks: readonly AskIn[]): Promise<void> {
  for (const a of asks) {
    await c.query(
      `INSERT INTO metric_proposal_asks (org_id, proposal_id, user_email, qkey, question) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [org, id, a.email.toLowerCase(), questionKey(a.question), a.question.replace(/\s+/g, ' ').trim().slice(0, 300)],
    );
  }
}

/**
 * Opens the proposal, or raises the open one of the same kind and name: its asks grow, no second card. The
 * approvers get a bell row when it is NEW. `created`: a new card; `proposal`: the card now. Null: the project already
 * holds MAX_OPEN open ones. Two at once cannot make two cards (the partial unique index decides).
 */
export async function openOrRaise(
  projectId: string, draft: StoredDraft, asks: readonly AskIn[], approvers: string[],
): Promise<{ created: boolean; proposal: Proposal } | null> {
  return inOrg(async (c, org) => {
    const key = nameKey(draft.name);
    const id: string = randomUUID();
    const ins = await c.query<{ id: string }>(
      `INSERT INTO metric_proposals (org_id, id, project_id, kind, name, name_key, dataset_id, draft)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb
        WHERE (SELECT count(*) FROM metric_proposals WHERE org_id = $1 AND project_id = $3 AND state = 'open') < ${MAX_OPEN}
       ON CONFLICT (org_id, project_id, dataset_id, kind, name_key) WHERE state = 'open' DO NOTHING RETURNING id::text`,
      [org, id, projectId, draft.kind, draft.name, key, draft.datasetId, JSON.stringify(draft)],
    );
    const created = !!ins.rows[0];
    let at = id;
    if (!created) {
      const open = await c.query<{ id: string }>(
        "SELECT id::text FROM metric_proposals WHERE org_id = $1 AND project_id = $2 AND dataset_id = $5 AND kind = $3 AND name_key = $4 AND state = 'open'",
        [org, projectId, draft.kind, key, draft.datasetId],
      );
      if (!open.rows[0]) return null; // the cap
      at = open.rows[0].id;
    }
    await addAsks(c, org, at, asks);
    if (created) {
      await c.query(
        `INSERT INTO metric_proposal_inbox (org_id, user_email, proposal_id, project_id, role)
         SELECT $1, u, $2, $3, 'approver' FROM unnest($4::text[]) AS u ON CONFLICT DO NOTHING`,
        [org, at, projectId, approvers],
      );
      await trim(c, org, approvers);
    }
    const r = await c.query<Row>(`SELECT ${COLUMNS} FROM metric_proposals p WHERE p.org_id = $1 AND p.id = $2`, [org, at]);
    return { created, proposal: fromRow(r.rows[0]) };
  });
}

/** The proposals of a project on `datasetIds` (the ones the caller edits) in `state` ('decided': approved or declined), newest first. */
export async function list(projectId: string, decided: boolean, datasetIds: readonly string[], limit: number): Promise<Proposal[]> {
  const r = await inOrg((c, org) => c.query<Row>(
    `SELECT ${COLUMNS} FROM metric_proposals p WHERE p.org_id = $1 AND p.project_id = $2 AND (p.state = 'open') <> $3 AND p.dataset_id = ANY($5::uuid[])
      ORDER BY p.created_at DESC LIMIT $4`,
    [org, projectId, decided, limit, datasetIds],
  ));
  return r.rows.map(fromRow);
}

export async function get(projectId: string, id: string): Promise<Proposal | null> {
  const r = await inOrg((c, org) => c.query<Row>(`SELECT ${COLUMNS} FROM metric_proposals p WHERE p.org_id = $1 AND p.project_id = $2 AND p.id = $3`, [org, projectId, id]));
  return r.rows[0] ? fromRow(r.rows[0]) : null;
}

/** The questions people needed it for, newest first (a handful for the card). */
export async function questions(id: string, limit: number): Promise<string[]> {
  const r = await inOrg((c, org) => c.query<{ question: string }>(
    'SELECT question FROM metric_proposal_asks WHERE org_id = $1 AND proposal_id = $2 ORDER BY created_at DESC LIMIT $3', [org, id, limit]));
  return r.rows.map((x) => x.question);
}

/** The people who asked, for telling them. */
export async function askers(id: string): Promise<string[]> {
  const r = await inOrg((c, org) => c.query<{ user_email: string }>('SELECT DISTINCT user_email FROM metric_proposal_asks WHERE org_id = $1 AND proposal_id = $2', [org, id]));
  return r.rows.map((x) => x.user_email);
}

/** Takes an open proposal for the caller's decision, unless another approval is under way. */
export async function claim(projectId: string, id: string): Promise<boolean> {
  const r = await inOrg((c, org) => c.query(
    `UPDATE metric_proposals SET decided_by = $4, decided_at = now()
      WHERE org_id = $1 AND project_id = $2 AND id = $3 AND state = 'open' AND (decided_at IS NULL OR decided_at < now() - ${CLAIM})`,
    [org, projectId, id, ctx().user.email],
  ));
  return r.rowCount === 1;
}

export async function release(projectId: string, id: string): Promise<void> {
  await inOrg((c, org) => c.query(
    `UPDATE metric_proposals SET decided_by = NULL, decided_at = NULL WHERE org_id = $1 AND project_id = $2 AND id = $3 AND state = 'open' AND decided_by = $4`,
    [org, projectId, id, ctx().user.email],
  ));
}

/**
 * Decides an open proposal (the caller's claim, or one nobody holds). Each asker's bell row is written in the same
 * transaction (new again, unseen); the approvers' rows are marked seen. Null: it was not open, or another approval holds it.
 */
export async function finish(
  projectId: string, id: string, to: { state: 'approved' | 'declined'; answer?: string; savedId?: string; edited?: boolean },
): Promise<{ proposal: Proposal; told: string[] } | null> {
  return inOrg(async (c, org) => {
    const r = await c.query(
      `UPDATE metric_proposals SET state = $4, answer = $5, saved_id = $6::uuid, edited = $7, decided_by = $8, decided_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3 AND state = 'open'
          AND (decided_by = $8 OR decided_at IS NULL OR decided_at < now() - ${CLAIM})`,
      [org, projectId, id, to.state, to.answer ?? '', to.savedId ?? null, to.edited === true, ctx().user.email],
    );
    if (r.rowCount !== 1) return null;
    await c.query("UPDATE metric_proposal_inbox SET seen_at = now() WHERE org_id = $1 AND proposal_id = $2 AND role = 'approver' AND seen_at IS NULL", [org, id]);
    const who = await c.query<{ user_email: string }>('SELECT DISTINCT user_email FROM metric_proposal_asks WHERE org_id = $1 AND proposal_id = $2', [org, id]);
    const told = who.rows.map((x) => x.user_email);
    if (told.length) {
      await c.query(
        `INSERT INTO metric_proposal_inbox (org_id, user_email, proposal_id, project_id, role)
         SELECT $1, u, $2, $3, 'asker' FROM unnest($4::text[]) AS u
         ON CONFLICT (org_id, user_email, proposal_id) DO UPDATE SET role = 'asker', created_at = now(), seen_at = NULL`,
        [org, id, projectId, told],
      );
      await trim(c, org, told);
    }
    const row = await c.query<Row>(`SELECT ${COLUMNS} FROM metric_proposals p WHERE p.org_id = $1 AND p.id = $2`, [org, id]);
    return { proposal: fromRow(row.rows[0]), told };
  });
}

/**
 * Who may see a bell row ($1 org, $2 email, $3 is an org admin): an asker's row on a project they read, an approver's
 * on one they edit (authz `readable` and `writable`, in SQL, as ../requests/store.ts INBOX_SHOWN).
 */
export const INBOX_SHOWN = `$3::boolean OR i.project_id IN (
                SELECT g.project_id FROM users u
                  JOIN project_grants g ON g.org_id = u.org_id AND (i.role = 'asker' OR g.role IN ('editor', 'admin'))
                   AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))
                 WHERE u.org_id = $1 AND u.email = $2 AND u.disabled_at IS NULL)`;

export interface InboxRow extends Proposal { role: 'approver' | 'asker'; at: string; seen: boolean; question: string }

/** The caller's bell rows, unseen first, then newest. `question`: the caller's own first question (an asker's "ask again"). */
export async function listInbox(limit: number): Promise<InboxRow[]> {
  const { user } = ctx();
  const r = await inOrg((c, org) => c.query<Row & { role: InboxRow['role']; at: Date; seen_at: Date | null; question: string | null }>(
    `SELECT ${COLUMNS}, i.role, i.created_at AS at, i.seen_at,
            (SELECT a.question FROM metric_proposal_asks a WHERE a.org_id = p.org_id AND a.proposal_id = p.id AND a.user_email = i.user_email ORDER BY a.created_at LIMIT 1) AS question
       FROM metric_proposal_inbox i JOIN metric_proposals p ON p.org_id = i.org_id AND p.id = i.proposal_id
      WHERE i.org_id = $1 AND i.user_email = $2 AND (${INBOX_SHOWN})
      ORDER BY (i.seen_at IS NULL) DESC, i.created_at DESC
      LIMIT $4`,
    [org, user.email, user.role === 'admin', limit],
  ));
  return r.rows.map((x) => ({ ...fromRow(x), role: x.role, at: x.at.toISOString(), seen: x.seen_at !== null, question: x.question ?? '' }));
}
