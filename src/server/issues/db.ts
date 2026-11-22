// The issues board's rows (0048_issues_board.sql; docs/issues-board/00-design.md). Every statement runs in a transaction that set
// `ordinate.org` (src/server/db/inOrg.ts) and names its org as well. The job runs inside the org's own context, so there is no system scope.
// Nothing here holds a figure or an answer's words; a signal holds the asker's own question and who asked, and no reply names the asker.

import type { PoolClient } from 'pg';
import { MIN_QUESTIONS, mainKind, type Existing, type Group, matchIssue } from '../../ai/issueGroups';
import type { Signal, SignalKind } from '../../ai/issueSignals';
import { inOrg, orgDb } from '../db/inOrg';

export const dbOrNull = orgDb;
export type Status = 'open' | 'resolved' | 'ignored';
export const STATUSES: readonly Status[] = ['open', 'resolved', 'ignored'];
/** Signals older than this are deleted, and an issue left with none. */
export const KEEP_DAYS = 90;
/** The check runs for a project at most this often. */
export const EVERY_DAYS = 7;

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Settings { enabled: boolean; lastRunAt: string | null; lastError: string | null; checking: boolean }

export async function getSettings(org: string, projectId: string): Promise<Settings> {
  const r = await inOrg((c) => c.query<Settings>(
    `SELECT enabled, last_run_at::text AS "lastRunAt", last_error AS "lastError", check_requested_at IS NOT NULL AS checking FROM issue_settings WHERE org_id = $1 AND project_id = $2`, [org, projectId]), org);
  return r.rows[0] ?? { enabled: false, lastRunAt: null, lastError: null, checking: false };
}

/** Check now: the project is asked for, and the org's weekly job is made due at once (any pod's runner claims it). */
export async function requestCheck(org: string, projectId: string): Promise<void> {
  await inOrg(async (c) => {
    await c.query(`INSERT INTO issue_settings (org_id, project_id, check_requested_at) VALUES ($1, $2, now()) ON CONFLICT (org_id, project_id) DO UPDATE SET check_requested_at = now()`, [org, projectId]);
    await c.query(`INSERT INTO jobs (org_id, kind, next_run_at) VALUES ($1, 'issues:weekly', now()) ON CONFLICT (org_id, kind, target) DO UPDATE SET next_run_at = LEAST(jobs.next_run_at, now())`, [org]);
  }, org);
}
export async function hasRequests(org: string): Promise<boolean> {
  return ((await inOrg((c) => c.query(`SELECT 1 FROM issue_settings WHERE org_id = $1 AND check_requested_at IS NOT NULL LIMIT 1`, [org]), org)).rowCount ?? 0) > 0;
}

export async function setEnabled(org: string, projectId: string, enabled: boolean, by: string): Promise<void> {
  await inOrg((c) => c.query(
    `INSERT INTO issue_settings (org_id, project_id, enabled, enabled_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, project_id) DO UPDATE SET enabled = $3, enabled_by = $4`, [org, projectId, enabled, by]), org);
}

/** Projects with the check on whose last run is a week old (or none). */
export async function dueProjects(org: string): Promise<Array<{ projectId: string; since: Date | null }>> {
  const r = await inOrg((c) => c.query<{ projectId: string; since: Date | null }>(
    `SELECT project_id::text AS "projectId", last_run_at AS since FROM issue_settings
      WHERE org_id = $1 AND ((enabled AND (last_run_at IS NULL OR last_run_at < now() - make_interval(days => $2::int))) OR check_requested_at IS NOT NULL) ORDER BY project_id`, [org, EVERY_DAYS]), org);
  return r.rows;
}

/** A finished check: the time, and no error. */
export async function stamp(org: string, projectId: string): Promise<void> {
  await inOrg((c) => c.query(
    `INSERT INTO issue_settings (org_id, project_id, last_run_at, last_error) VALUES ($1, $2, now(), NULL)
     ON CONFLICT (org_id, project_id) DO UPDATE SET last_run_at = now(), last_error = NULL, check_requested_at = NULL`, [org, projectId]), org);
}

/** A failed check keeps the old time, so the next wake tries again; the code (never a message) is shown to the admin. */
export async function failed(org: string, projectId: string, code: string): Promise<void> {
  await inOrg((c) => c.query(`UPDATE issue_settings SET last_error = $3, check_requested_at = NULL WHERE org_id = $1 AND project_id = $2`, [org, projectId, code]), org);
}

// ── signals, issues ──────────────────────────────────────────────────────────────────────────────────────────────────────

const nul = (s: string): string => s.replaceAll('\0', '�');

async function insertSignals(c: PoolClient, org: string, projectId: string, issueId: string, signals: readonly Signal[]): Promise<Signal[]> {
  const fresh: Signal[] = [];
  for (const s of signals) {
    const r = await c.query(
      `INSERT INTO issue_signals (org_id, project_id, turn_id, kind, issue_id, reason, label, question, owner, dataset_ids, dashboard_ids, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12) ON CONFLICT DO NOTHING`,
      [org, projectId, s.turnId.slice(0, 100), s.kind, issueId, s.reason, s.label, nul(s.question).slice(0, 4000), s.owner, JSON.stringify(s.datasetIds), JSON.stringify(s.dashboardIds), s.at]);
    if (r.rowCount) fresh.push(s);
  }
  return fresh;
}

export interface Applied { created: number; grown: number; reopened: number; signals: number }

/**
 * Stores grouped signals: each group grows the issue it matches, or makes one. A resolved issue that gets a signal NEWER than its
 * resolution reopens; an ignored one stays ignored. One transaction.
 */
export async function apply(org: string, projectId: string, groups: readonly Group[]): Promise<Applied> {
  return inOrg(async (c) => {
    const out: Applied = { created: 0, grown: 0, reopened: 0, signals: 0 };
    const rows = (await c.query<Existing & { status: Status; statusAt: Date | null }>(
      `SELECT id::text, key, tokens, status, status_at AS "statusAt" FROM issues WHERE org_id = $1 AND project_id = $2`, [org, projectId])).rows;
    for (const g of groups) {
      const found = matchIssue(g, rows);
      let id = found;
      if (!id) {
        const made = await c.query<{ id: string }>(
          `INSERT INTO issues (org_id, id, project_id, key, tokens, kind) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5)
           ON CONFLICT (org_id, project_id, key) DO UPDATE SET updated_at = now() RETURNING id::text`, [org, projectId, g.key.slice(0, 400), g.words, mainKind(g.signals)]);
        id = made.rows[0].id;
        rows.push({ id, key: g.key, tokens: g.words, status: 'open', statusAt: null });
        out.created += 1;
      } else out.grown += 1;
      const fresh = await insertSignals(c, org, projectId, id, g.signals);
      out.signals += fresh.length;
      const row = rows.find((r) => r.id === id);
      if (fresh.length) await c.query('UPDATE issues SET updated_at = now() WHERE org_id = $1 AND id = $2', [org, id]);
      if (row?.status === 'resolved' && row.statusAt && fresh.some((s) => Date.parse(s.at) > row.statusAt!.getTime())) {
        await c.query(`UPDATE issues SET status = 'open', status_by = NULL, status_at = now(), reopened = reopened + 1 WHERE org_id = $1 AND id = $2 AND status = 'resolved'`, [org, id]);
        row.status = 'open';
        out.reopened += 1;
      }
    }
    return out;
  }, org);
}

/**
 * Old signals go, and an issue with none left. An issue that LOSES signals forgets its title and fix too (the next naming writes them from
 * what is left): the wording came from questions that are gone, and the folder rule can no longer see what those showed.
 * Returns the signals deleted.
 */
export async function sweep(org: string, projectId: string): Promise<number> {
  return inOrg(async (c) => {
    const r = await c.query<{ issue: string }>(`DELETE FROM issue_signals WHERE org_id = $1 AND project_id = $2 AND at < now() - make_interval(days => $3::int) RETURNING issue_id::text AS issue`, [org, projectId, KEEP_DAYS]);
    const lost = [...new Set(r.rows.map((x) => x.issue))];
    if (lost.length) {
      await c.query(`UPDATE issues SET title = '', fix = '', named = false, name_dataset_ids = '[]'::jsonb, name_dashboard_ids = '[]'::jsonb WHERE org_id = $1 AND id = ANY($2::uuid[])`, [org, lost]);
    }
    await c.query(`DELETE FROM issues i WHERE i.org_id = $1 AND i.project_id = $2 AND NOT EXISTS (SELECT 1 FROM issue_signals s WHERE s.org_id = i.org_id AND s.issue_id = i.id)`, [org, projectId]);
    return r.rowCount ?? 0;
  }, org);
}

// ── naming ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ToName {
  id: string; key: string; kind: SignalKind;
  signals: Array<{ kind: SignalKind; reason: string | null; count: number }>;
  labels: string[]; datasetIds: string[]; questions: string[];
}

/** Issues on the board (three questions) with no name yet: what the model is told, never more. At most `limit`. */
export async function toName(org: string, projectId: string, limit: number): Promise<ToName[]> {
  return inOrg(async (c) => {
    const ids = (await c.query<{ id: string; key: string; kind: SignalKind }>(
      `SELECT i.id::text, i.key, i.kind FROM issues i WHERE i.org_id = $1 AND i.project_id = $2 AND NOT i.named
        AND (SELECT count(DISTINCT s.turn_id) FROM issue_signals s WHERE s.org_id = i.org_id AND s.issue_id = i.id) >= $3
        ORDER BY i.updated_at DESC, i.id LIMIT $4`, [org, projectId, MIN_QUESTIONS, limit])).rows;
    const out: ToName[] = [];
    for (const i of ids) {
      const s = (await c.query<{ turn_id: string; kind: SignalKind; reason: string | null; label: string | null; question: string; dataset_ids: string[]; at: Date }>(
        `SELECT turn_id, kind, reason, label, question, dataset_ids, at FROM issue_signals WHERE org_id = $1 AND issue_id = $2 ORDER BY at DESC, turn_id LIMIT 300`, [org, i.id])).rows;
      const by = new Map<string, { kind: SignalKind; reason: string | null; turns: Set<string> }>();
      for (const x of s) { const k = `${x.kind}|${x.reason ?? ''}`; (by.get(k) ?? (by.set(k, { kind: x.kind, reason: x.reason, turns: new Set() }), by.get(k)!)).turns.add(x.turn_id); }
      out.push({
        id: i.id, key: i.key, kind: i.kind,
        signals: [...by.values()].map((v) => ({ kind: v.kind, reason: v.reason, count: v.turns.size })),
        labels: [...new Set(s.flatMap((x) => (x.label ? [x.label] : [])))].slice(0, 6),
        datasetIds: [...new Set(s.flatMap((x) => x.dataset_ids))].slice(0, 6),
        questions: [...new Set(s.map((x) => x.question))],
      });
    }
    return out;
  }, org);
}

const NAMED_FROM = `name_dataset_ids = COALESCE((SELECT jsonb_agg(DISTINCT d) FROM issue_signals s, jsonb_array_elements_text(s.dataset_ids) d WHERE s.org_id = issues.org_id AND s.issue_id = issues.id), '[]'::jsonb),
  name_dashboard_ids = COALESCE((SELECT jsonb_agg(DISTINCT d) FROM issue_signals s, jsonb_array_elements_text(s.dashboard_ids) d WHERE s.org_id = issues.org_id AND s.issue_id = issues.id), '[]'::jsonb)`;
/** A title and fix, and every dataset and dashboard the group's questions showed (a superset of what the model was told): the folder rule counts them. */
export async function setName(org: string, id: string, title: string, fix: string): Promise<void> {
  await inOrg((c) => c.query(`UPDATE issues SET title = $3, fix = $4, named = true, ${NAMED_FROM} WHERE org_id = $1 AND id = $2`, [org, id, title, fix]), org);
}
/** The app's own wording stands in, until a model names it (a later run tries again). Its words come from the same questions, so it records the same ids. */
export async function setFallback(org: string, id: string, title: string, fix: string): Promise<void> {
  await inOrg((c) => c.query(`UPDATE issues SET title = $3, fix = $4, ${NAMED_FROM} WHERE org_id = $1 AND id = $2 AND NOT named`, [org, id, title, fix]), org);
}

// ── the board ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Issue {
  id: string; key: string; kind: SignalKind; title: string; fix: string; named: boolean; status: Status; statusBy: string | null; reopened: number; proposalId: string | null;
  createdAt: string; updatedAt: string; questions: number; people: number;
  /** Every dataset and dashboard any of its signals showed: the folder rule hides the issue from a caller closed to one. */
  datasetIds: string[]; dashboardIds: string[];
}
export interface Example { turnId: string; kind: SignalKind; reason: string | null; question: string; at: string }
export interface TicketRow { provider: 'linear' | 'jira'; ref: string; url: string }

const ISSUE = `i.id::text, i.key, i.kind, i.title, i.fix, i.named, i.status, i.status_by AS "statusBy", i.reopened, i.proposal_id::text AS "proposalId",
  i.created_at::text AS "createdAt", i.updated_at::text AS "updatedAt"`;

/** The project's issues with `MIN_QUESTIONS` or more questions, newest activity first. `id`: just that one. */
export async function board(org: string, projectId: string, id?: string): Promise<Issue[]> {
  return inOrg(async (c) => {
    const r = await c.query<Omit<Issue, 'datasetIds' | 'dashboardIds'>>(
      `SELECT ${ISSUE}, count(DISTINCT s.turn_id)::int AS questions, count(DISTINCT s.owner)::int AS people
         FROM issues i JOIN issue_signals s ON s.org_id = i.org_id AND s.issue_id = i.id
        WHERE i.org_id = $1 AND i.project_id = $2 AND ($4::uuid IS NULL OR i.id = $4::uuid)
        AND i.title <> ''
        GROUP BY i.org_id, i.id HAVING count(DISTINCT s.turn_id) >= $3
        ORDER BY (i.status = 'open') DESC, i.updated_at DESC, i.id LIMIT 200`, [org, projectId, MIN_QUESTIONS, id ?? null]);
    if (!r.rows.length) return [];
    const ids = r.rows.map((x) => x.id);
    const ds = await c.query<{ issue: string; d: string }>(
      `SELECT issue_id::text AS issue, jsonb_array_elements_text(dataset_ids) AS d FROM issue_signals WHERE org_id = $1 AND issue_id = ANY($2::uuid[])
       UNION SELECT id::text, jsonb_array_elements_text(name_dataset_ids) FROM issues WHERE org_id = $1 AND id = ANY($2::uuid[])`, [org, ids]);
    const bd = await c.query<{ issue: string; d: string }>(
      `SELECT issue_id::text AS issue, jsonb_array_elements_text(dashboard_ids) AS d FROM issue_signals WHERE org_id = $1 AND issue_id = ANY($2::uuid[])
       UNION SELECT id::text, jsonb_array_elements_text(name_dashboard_ids) FROM issues WHERE org_id = $1 AND id = ANY($2::uuid[])`, [org, ids]);
    return r.rows.map((x) => ({ ...x, datasetIds: ds.rows.filter((y) => y.issue === x.id).map((y) => y.d), dashboardIds: bd.rows.filter((y) => y.issue === x.id).map((y) => y.d) }));
  }, org);
}

export interface ExampleRow extends Example { issue: string; datasetIds: string[]; dashboardIds: string[]; owner: string }

/**
 * A few of each issue's signals, newest first, one per question, for all of `issueIds` in ONE statement (`limit` each). `owner` is for the
 * server's own use (the proposal's askers): never in a reply.
 */
export async function examplesFor(org: string, projectId: string, issueIds: readonly string[], limit: number): Promise<ExampleRow[]> {
  if (!issueIds.length) return [];
  const r = await inOrg((c) => c.query<ExampleRow>(
    `SELECT issue_id::text AS issue, turn_id AS "turnId", kind, reason, question, owner, dataset_ids AS "datasetIds", dashboard_ids AS "dashboardIds", at::text AS at FROM (
       SELECT d.*, row_number() OVER (PARTITION BY d.issue_id ORDER BY d.at DESC, d.turn_id) AS rn
         FROM (SELECT DISTINCT ON (issue_id, turn_id) * FROM issue_signals WHERE org_id = $1 AND project_id = $2 AND issue_id = ANY($3::uuid[]) ORDER BY issue_id, turn_id, at DESC) d) r
      WHERE rn <= $4 ORDER BY issue_id, rn`, [org, projectId, issueIds, limit]), org);
  return r.rows;
}

/** The kinds of trouble in an issue, with how many questions each. */
export async function kindsOf(org: string, issueIds: readonly string[]): Promise<Map<string, Array<{ kind: SignalKind; count: number }>>> {
  const out = new Map<string, Array<{ kind: SignalKind; count: number }>>();
  if (!issueIds.length) return out;
  const r = await inOrg((c) => c.query<{ issue: string; kind: SignalKind; n: number }>(
    `SELECT issue_id::text AS issue, kind, count(DISTINCT turn_id)::int AS n FROM issue_signals WHERE org_id = $1 AND issue_id = ANY($2::uuid[]) GROUP BY issue_id, kind ORDER BY n DESC, kind`, [org, issueIds]), org);
  for (const x of r.rows) out.set(x.issue, [...(out.get(x.issue) ?? []), { kind: x.kind, count: x.n }]);
  return out;
}

export async function ticketsOf(org: string, issueIds: readonly string[]): Promise<Map<string, TicketRow[]>> {
  const out = new Map<string, TicketRow[]>();
  if (!issueIds.length) return out;
  const r = await inOrg((c) => c.query<TicketRow & { issue: string }>(
    `SELECT issue_id::text AS issue, provider, ref, url FROM issue_tickets WHERE org_id = $1 AND issue_id = ANY($2::uuid[]) AND ref <> '' ORDER BY sent_at`, [org, issueIds]), org);
  for (const x of r.rows) out.set(x.issue, [...(out.get(x.issue) ?? []), { provider: x.provider, ref: x.ref, url: x.url }]);
  return out;
}

/** Sets the status. False: no such issue in the project. Resolving or ignoring stamps who and when; reopening clears the reopen mark. */
export async function setStatus(org: string, projectId: string, id: string, status: Status, by: string): Promise<boolean> {
  const r = await inOrg((c) => c.query(`UPDATE issues SET status = $4, status_by = $5, status_at = now() WHERE org_id = $1 AND project_id = $2 AND id = $3`, [org, projectId, id, status, by]), org);
  return (r.rowCount ?? 0) > 0;
}

export async function setProposal(org: string, id: string, proposalId: string): Promise<void> {
  await inOrg((c) => c.query(`UPDATE issues SET proposal_id = $3 WHERE org_id = $1 AND id = $2`, [org, id, proposalId]), org);
}

/** A ticket must not be made twice: a press takes the (issue, tracker) slot first. A slot never filled (a crash) is free again after two minutes. */
export async function claimTicket(org: string, issueId: string, provider: Provider, by: string): Promise<boolean> {
  const r = await inOrg((c) => c.query(
    `INSERT INTO issue_tickets (org_id, issue_id, provider, ref, url, sent_by) VALUES ($1, $2, $3, '', '', $4)
     ON CONFLICT (org_id, issue_id, provider) DO UPDATE SET sent_by = $4, sent_at = now() WHERE issue_tickets.ref = '' AND issue_tickets.sent_at < now() - interval '2 minutes'`, [org, issueId, provider, by]), org);
  return (r.rowCount ?? 0) > 0;
}
export async function fillTicket(org: string, issueId: string, t: TicketRow): Promise<void> {
  await inOrg((c) => c.query(`UPDATE issue_tickets SET ref = $4, url = $5, sent_at = now() WHERE org_id = $1 AND issue_id = $2 AND provider = $3`, [org, issueId, t.provider, t.ref.slice(0, 100), t.url.slice(0, 500)]), org);
}
/** The ticket call failed: the slot is free again. */
export async function freeTicket(org: string, issueId: string, provider: Provider): Promise<void> {
  await inOrg((c) => c.query(`DELETE FROM issue_tickets WHERE org_id = $1 AND issue_id = $2 AND provider = $3 AND ref = ''`, [org, issueId, provider]), org);
}

// ── tracker settings (the token is in the secrets store) ─────────────────────────────────────────────────────────────────

export type Provider = 'linear' | 'jira';
export interface Integration { provider: Provider; settings: Record<string, string>; connectedBy: string; connectedAt: string }

export async function integrations(org: string): Promise<Integration[]> {
  return (await inOrg((c) => c.query<Integration>(
    `SELECT provider, settings, connected_by AS "connectedBy", connected_at::text AS "connectedAt" FROM tracker_integrations WHERE org_id = $1 ORDER BY provider`, [org]), org)).rows;
}
export async function saveIntegration(org: string, provider: Provider, settings: Record<string, string>, by: string): Promise<void> {
  await inOrg((c) => c.query(
    `INSERT INTO tracker_integrations (org_id, provider, settings, connected_by) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (org_id, provider) DO UPDATE SET settings = $3::jsonb, connected_by = $4, connected_at = now()`, [org, provider, JSON.stringify(settings), by]), org);
}
export async function dropIntegration(org: string, provider: Provider): Promise<boolean> {
  return ((await inOrg((c) => c.query('DELETE FROM tracker_integrations WHERE org_id = $1 AND provider = $2', [org, provider]), org)).rowCount ?? 0) > 0;
}
