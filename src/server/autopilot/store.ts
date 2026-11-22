// Autopilot's Postgres rows (0046_autopilot.sql) and the reads the weekly run makes of phase 1's (0044). Every statement runs in `inOrg`:
// forced row-level security, one org per transaction. Without a database there is no Autopilot (`orgDb()` null: the callers say so).

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { inOrg } from '../db/inOrg';

export interface Settings {
  projectId: string;
  enabled: boolean;
  windowDays: number;
  slowMs: number;
  trashUnused: boolean;
  repairRenames: boolean;
  runAs: string | null;
  pausedReason: 'lost_admin' | null;
  updatedBy: string | null;
  updatedAt: string;
}

export const DEFAULTS = { enabled: false, windowDays: 90, slowMs: 5000, trashUnused: true, repairRenames: true } as const;
export const WINDOW = { min: 30, max: 365 } as const;
export const SLOW = { min: 500, max: 600_000 } as const;

const COLS = `project_id::text AS "projectId", enabled, window_days AS "windowDays", slow_ms AS "slowMs", trash_unused AS "trashUnused",
  repair_renames AS "repairRenames", run_as AS "runAs", paused_reason AS "pausedReason", updated_by AS "updatedBy", updated_at::text AS "updatedAt"`;

export const defaultsFor = (projectId: string): Settings => ({ projectId, ...DEFAULTS, runAs: null, pausedReason: null, updatedBy: null, updatedAt: '' });

export async function getSettings(projectId: string): Promise<Settings> {
  const r = await inOrg((c, org) => c.query<Settings>(`SELECT ${COLS} FROM autopilot_settings WHERE org_id = $1 AND project_id = $2`, [org, projectId]));
  return r.rows[0] ?? defaultsFor(projectId);
}

export async function allSettings(): Promise<Map<string, Settings>> {
  const r = await inOrg((c, org) => c.query<Settings>(`SELECT ${COLS} FROM autopilot_settings WHERE org_id = $1`, [org]));
  return new Map(r.rows.map((s) => [s.projectId, s]));
}

export interface Patch { enabled?: boolean; windowDays?: number; slowMs?: number; trashUnused?: boolean; repairRenames?: boolean }

/**
 * Save a partial update by `by`. Switching it ON (off to on) records them as the admin it acts as and clears a pause; so does
 * turning it on again after a pause. Returns false when a value is outside its bounds (the CHECKs are the second line after zod).
 */
export async function saveSettings(projectId: string, patch: Patch, by: string): Promise<Settings | null> {
  const cur = await getSettings(projectId);
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Settings;
  if (!Number.isInteger(next.windowDays) || next.windowDays < WINDOW.min || next.windowDays > WINDOW.max) return null;
  if (!Number.isInteger(next.slowMs) || next.slowMs < SLOW.min || next.slowMs > SLOW.max) return null;
  const turnsOn = patch.enabled === true && (!cur.enabled || cur.pausedReason !== null);
  const runAs = turnsOn ? by : cur.runAs;
  const paused = turnsOn ? null : cur.pausedReason;
  await inOrg((c, org) => c.query(
    `INSERT INTO autopilot_settings (org_id, project_id, enabled, window_days, slow_ms, trash_unused, repair_renames, run_as, paused_reason, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (org_id, project_id) DO UPDATE SET enabled = $3, window_days = $4, slow_ms = $5, trash_unused = $6, repair_renames = $7,
       run_as = $8, paused_reason = $9, updated_by = $10, updated_at = now()`,
    [org, projectId, next.enabled, next.windowDays, next.slowMs, next.trashUnused, next.repairRenames, runAs, paused, by],
  ));
  return getSettings(projectId);
}

export async function pause(projectId: string, reason: 'lost_admin'): Promise<void> {
  await inOrg((c, org) => c.query('UPDATE autopilot_settings SET paused_reason = $3, updated_at = now() WHERE org_id = $1 AND project_id = $2', [org, projectId, reason]));
}

// ── Runs ────────────────────────────────────────────────────────────────────

export type RunState = 'running' | 'done' | 'paused' | 'failed';
export interface Run {
  id: string; projectId: string; week: string | null; manual: boolean; state: RunState; ranAs: string | null; windowDays: number;
  coveredFrom: string | null; counts: Record<string, number>; startedAt: string; finishedAt: string | null;
}
const RUN_COLS = `id::text AS id, project_id::text AS "projectId", to_char(week, 'YYYY-MM-DD') AS week, manual, state, ran_as AS "ranAs", window_days AS "windowDays",
  to_char(covered_from, 'YYYY-MM-DD') AS "coveredFrom", counts, started_at::text AS "startedAt", finished_at::text AS "finishedAt"`;

/** The UTC Monday of `day`'s week. */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

export const STALE_CLAIM_MIN = 30;

/** The project's runs are started one at a time: this lock is held only for the check and the insert, the `running` row is what lasts. */
const lockProject = (c: PoolClient, org: string, projectId: string) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`autopilot:${org}:${projectId}`]);
/** Is a run of the project going (and not a dead server's: running for over STALE_CLAIM_MIN minutes)? */
const busy = async (c: PoolClient, org: string, projectId: string): Promise<boolean> =>
  (await c.query(`SELECT 1 FROM autopilot_runs WHERE org_id = $1 AND project_id = $2 AND state = 'running' AND started_at > now() - $3 * interval '1 minute'`, [org, projectId, STALE_CLAIM_MIN])).rowCount === 1;

/**
 * Claim this week's scheduled run of the project: exactly one caller gets an id, whatever the servers (the partial unique index
 * decides the race). A claim left `running` for STALE_CLAIM_MIN minutes (a pod that died) is retaken by the next caller. Null: the week
 * is taken, or a run of the project is going now (a Run now): the week is not used up, the next poll tries again.
 */
export async function claimWeek(projectId: string, week: string, windowDays: number): Promise<string | null> {
  const id = randomUUID();
  const r = await inOrg(async (c, org) => {
    await lockProject(c, org, projectId);
    if (await busy(c, org, projectId)) return null;
    return (await c.query<{ id: string }>(
      `INSERT INTO autopilot_runs AS u (org_id, project_id, id, week, window_days) VALUES ($1, $2, $3, $4::date, $5)
       ON CONFLICT (org_id, project_id, week) WHERE week IS NOT NULL DO UPDATE SET started_at = now()
         WHERE u.state = 'running' AND u.started_at < now() - $6 * interval '1 minute'
       RETURNING id::text AS id`,
      [org, projectId, id, week, windowDays, STALE_CLAIM_MIN],
    )).rows[0]?.id ?? null;
  });
  return r;
}

/** A manual "Run now": its own run, off the weekly key. Null while a run of the project is going (a double click, a second admin, the weekly tick). */
export async function startManual(projectId: string, windowDays: number): Promise<string | null> {
  const id = randomUUID();
  return inOrg(async (c, org) => {
    await lockProject(c, org, projectId);
    if (await busy(c, org, projectId)) return null;
    await c.query('INSERT INTO autopilot_runs (org_id, project_id, id, manual, window_days) VALUES ($1, $2, $3, true, $4)', [org, projectId, id, windowDays]);
    return id;
  });
}

export async function finishRun(id: string, state: Exclude<RunState, 'running'>, o: { ranAs: string | null; coveredFrom: string | null; counts: Record<string, number> }): Promise<void> {
  await inOrg((c, org) => c.query(
    `UPDATE autopilot_runs SET state = $3, ran_as = $4, covered_from = $5::date, counts = $6::jsonb, finished_at = now() WHERE org_id = $1 AND id = $2`,
    [org, id, state, o.ranAs, o.coveredFrom, JSON.stringify(o.counts)],
  ));
}

export async function getRun(runId: string): Promise<Run | null> {
  const r = await inOrg((c, org) => c.query<Run>(`SELECT ${RUN_COLS} FROM autopilot_runs WHERE org_id = $1 AND id = $2`, [org, runId]));
  return r.rows[0] ?? null;
}

/** The project's newest runs. */
export async function listRuns(projectId: string, limit = 20): Promise<Run[]> {
  const r = await inOrg((c, org) => c.query<Run>(`SELECT ${RUN_COLS} FROM autopilot_runs WHERE org_id = $1 AND project_id = $2 ORDER BY started_at DESC LIMIT $3`, [org, projectId, limit]));
  return r.rows;
}

/** The newest finished run of each project that has one. */
export async function latestRuns(): Promise<Map<string, Run>> {
  const r = await inOrg((c, org) => c.query<Run>(
    `SELECT DISTINCT ON (project_id) ${RUN_COLS} FROM autopilot_runs WHERE org_id = $1 AND state <> 'running' ORDER BY project_id, started_at DESC`, [org]));
  return new Map(r.rows.map((x) => [x.projectId, x]));
}

// ── Items ───────────────────────────────────────────────────────────────────

export type ItemKind = 'trashed' | 'repaired' | 'broken' | 'slow';
export type ItemState = 'applied' | 'listed' | 'undone' | 'failed';
export interface Item { seq: number; kind: ItemKind; visualId: string; name: string; state: ItemState; detail: Record<string, unknown>; undo: Record<string, unknown> | null }
export type NewItem = Omit<Item, 'seq'>;

export async function addItem(runId: string, projectId: string, it: NewItem): Promise<number> {
  const r = await inOrg((c, org) => c.query<{ seq: number }>(
    `INSERT INTO autopilot_items (org_id, run_id, seq, project_id, kind, visual_id, name, state, detail, undo)
     SELECT $1, $2, coalesce(max(seq), 0) + 1, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb FROM autopilot_items WHERE org_id = $1 AND run_id = $2
     RETURNING seq`,
    [org, runId, projectId, it.kind, it.visualId, it.name, it.state, JSON.stringify(it.detail), it.undo === null ? null : JSON.stringify(it.undo)],
  ));
  return r.rows[0].seq;
}

const ITEM_COLS = `seq, kind, visual_id::text AS "visualId", name, state, detail, undo`;

export async function items(runId: string): Promise<Item[]> {
  const r = await inOrg((c, org) => c.query<Item>(`SELECT ${ITEM_COLS} FROM autopilot_items WHERE org_id = $1 AND run_id = $2 ORDER BY seq`, [org, runId]));
  return r.rows;
}

export async function getItem(runId: string, seq: number): Promise<Item | null> {
  const r = await inOrg((c, org) => c.query<Item>(`SELECT ${ITEM_COLS} FROM autopilot_items WHERE org_id = $1 AND run_id = $2 AND seq = $3`, [org, runId, seq]));
  return r.rows[0] ?? null;
}

/** applied to undone, once: false when it was not applied (a second Undo changes nothing). */
export async function markUndone(runId: string, seq: number): Promise<boolean> {
  const r = await inOrg((c, org) => c.query(`UPDATE autopilot_items SET state = 'undone' WHERE org_id = $1 AND run_id = $2 AND seq = $3 AND state = 'applied'`, [org, runId, seq]));
  return r.rowCount === 1;
}

/** Items of a chart already handled in a run: a retaken claim does not act twice. */
export async function handledIn(runId: string): Promise<Set<string>> {
  return new Set((await items(runId)).map((i) => `${i.kind}:${i.visualId}`));
}

// ── What the run reads of phase 1 ───────────────────────────────────────────

export interface UsageRead {
  /** The first day THIS PROJECT has a usage row (null: none yet): coverage is the project's, not the org's. */
  firstDay: string | null;
  openedSince: Set<string>;
  week: Map<string, { computes: number; totalMs: number; maxMs: number }>;
  trashedBefore: Set<string>;
}

export async function readUsage(projectId: string, cutoff: string, today: string, windowDays: number): Promise<UsageRead> {
  return inOrg(async (c, org) => {
    const first = await c.query<{ d: string | null }>(`SELECT to_char(min(day), 'YYYY-MM-DD') AS d FROM item_usage_daily WHERE org_id = $1 AND project_id = $2`, [org, projectId]);
    const opened = await c.query<{ id: string }>(`SELECT DISTINCT item_id::text AS id FROM item_usage_daily WHERE org_id = $1 AND project_id = $2 AND kind = 'visual' AND opened AND day >= $3::date`, [org, projectId, cutoff]);
    const week = await c.query<{ id: string; n: string; s: string; m: number }>(
      `SELECT item_id::text AS id, sum(computes)::text AS n, sum(total_ms)::text AS s, max(max_ms) AS m FROM item_usage_daily
        WHERE org_id = $1 AND project_id = $2 AND kind = 'visual' AND day > ($3::date - 7) AND computes > 0 GROUP BY item_id`, [org, projectId, today]);
    const back = await c.query<{ id: string }>(
      `SELECT DISTINCT visual_id::text AS id FROM autopilot_items WHERE org_id = $1 AND project_id = $2 AND kind = 'trashed' AND state IN ('applied', 'undone') AND at > now() - $3 * interval '1 day'`, [org, projectId, windowDays]);
    return {
      firstDay: first.rows[0]?.d ?? null,
      openedSince: new Set(opened.rows.map((r) => r.id)),
      week: new Map(week.rows.map((r) => [r.id, { computes: Number(r.n), totalMs: Number(r.s), maxMs: r.m }])),
      trashedBefore: new Set(back.rows.map((r) => r.id)),
    };
  });
}

/** The project's logged renames, in the order they were made (old and new name, both kinds). */
export async function readRenames(projectId: string): Promise<Array<{ datasetId: string; from: string; to: string; at: string; seq: number }>> {
  const r = await inOrg((c, org) => c.query<{ datasetId: string; from: string; to: string; at: string; seq: string }>(
    `SELECT dataset_id::text AS "datasetId", old_name AS "from", new_name AS "to", to_char(dataset_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS at, seq::text AS seq
       FROM column_renames WHERE org_id = $1 AND project_id = $2 ORDER BY dataset_at, seq`, [org, projectId]));
  return r.rows.map((x) => ({ ...x, seq: Number(x.seq) }));
}

/** Count `visualId` as used today: a chart Autopilot's Undo (or a person) brought back must not look unopened. */
export async function markUsed(projectId: string, visualId: string, today: string): Promise<void> {
  await inOrg((c: PoolClient, org) => c.query(
    `INSERT INTO item_usage_daily (org_id, project_id, kind, item_id, day, opened) VALUES ($1, $2, 'visual', $3, $4::date, true)
     ON CONFLICT (org_id, project_id, kind, item_id, day) DO UPDATE SET opened = true`, [org, projectId, visualId, today]));
}

/** Usage rows older than 400 days, and older than 100 days of an item that is neither a record nor in the Trash. Returns how many. */
export async function pruneUsage(): Promise<number> {
  const r = await inOrg((c, org) => c.query(
    `DELETE FROM item_usage_daily u WHERE u.org_id = $1 AND (u.day < current_date - 400 OR (u.day < current_date - 100 AND NOT EXISTS (
       SELECT 1 FROM records r WHERE r.org_id = u.org_id AND r.path IN (
         'projects/' || u.project_id || '/' || CASE u.kind WHEN 'visual' THEN 'visuals' ELSE 'analyses' END || '/' || u.item_id || '.json',
         'projects/' || u.project_id || '/trash/' || u.kind || '/' || u.item_id || '.json'))))`, [org]));
  await inOrg((c, org) => c.query(
    `DELETE FROM autopilot_seen s WHERE s.org_id = $1 AND s.first_seen < current_date - 100 AND NOT EXISTS (
       SELECT 1 FROM records r WHERE r.org_id = s.org_id AND r.path IN (
         'projects/' || s.project_id || '/visuals/' || s.visual_id || '.json', 'projects/' || s.project_id || '/trash/visual/' || s.visual_id || '.json'))`, [org]));
  return r.rowCount ?? 0;
}

/** Each project's first usage day: usage is watched from the day after it. */
export async function firstUsageDays(): Promise<Map<string, string>> {
  const r = await inOrg((c, org) => c.query<{ p: string; d: string }>(`SELECT project_id::text AS p, to_char(min(day), 'YYYY-MM-DD') AS d FROM item_usage_daily WHERE org_id = $1 GROUP BY project_id`, [org]));
  return new Map(r.rows.map((x) => [x.p, x.d]));
}

/**
 * Remember today as the first day Autopilot knew each of `ids` (kept if earlier), then return, per chart, the earliest day it can have been
 * watched: that day, or its first usage row if sooner. A chart not in the map is unknown: never a candidate.
 */
export async function noteSeen(projectId: string, ids: readonly string[], today: string): Promise<Map<string, string>> {
  return inOrg(async (c, org) => {
    if (ids.length) {
      await c.query(
        `INSERT INTO autopilot_seen (org_id, project_id, visual_id, first_seen) SELECT $1, $2, u::uuid, $3::date FROM unnest($4::text[]) AS u ON CONFLICT DO NOTHING`,
        [org, projectId, today, [...ids]],
      );
    }
    const r = await c.query<{ id: string; d: string }>(
      `SELECT s.visual_id::text AS id, to_char(least(s.first_seen, coalesce(min(u.day), s.first_seen)), 'YYYY-MM-DD') AS d
         FROM autopilot_seen s LEFT JOIN item_usage_daily u ON u.org_id = s.org_id AND u.project_id = s.project_id AND u.kind = 'visual' AND u.item_id = s.visual_id
        WHERE s.org_id = $1 AND s.project_id = $2 GROUP BY s.visual_id, s.first_seen`, [org, projectId]);
    return new Map(r.rows.map((x) => [x.id, x.d]));
  });
}

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Every chart-id-shaped string in every record of the project that could MENTION a chart, read from the stored text itself: dashboards (their
 * published copies, and those in the Trash too: a dashboard brought back must still have its charts), Stories, reports, alerts, and the rest.
 * The chart's own record, its version history, the Trash copy of a chart and the datasets are not mentions. A record that does not parse still
 * counts: it is the text that is read. ANY database error propagates: a scan that cannot be completed must never read as "nothing mentions it".
 */
export async function scanMentions(projectId: string): Promise<Set<string>> {
  const root = `projects/${projectId}/`;
  const skip = ['visuals/', 'history/', 'datasets/', 'trash/visual/'].map((d) => `${root}${d}%`);
  const found = new Set<string>();
  let after = root;
  for (;;) {
    const page = await inOrg((c, org) => c.query<{ path: string; body: string }>(
      `SELECT path, body FROM records WHERE org_id = $1 AND path > $2 AND path < $3 AND NOT (path LIKE ANY($4::text[])) ORDER BY path LIMIT 200`,
      [org, after, `${root.slice(0, -1)}0`, skip])); // "…/" up to "…0": every path under the project directory
    if (!page.rows.length) return found;
    for (const r of page.rows) for (const m of r.body.match(UUID_G) ?? []) found.add(m.toLowerCase());
    after = page.rows[page.rows.length - 1].path;
  }
}
