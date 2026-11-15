// Reach at rest (0035_dashboard_reads.sql, docs/team-folders/00-design.md D9): which datasets each dashboard's
// published copy reads. It follows the verified index (./verifiedIndex.ts) move for move:
//
//   ON WRITE   recordFs calls onDashboardReadsWrite / onDashboardReadsRangeDelete inside the write's own transaction:
//              a dashboard's rows are replaced there, under a SHARED advisory lock per (org, project), in a SAVEPOINT;
//              if anything fails, the project's marker is dropped instead and the save goes on.
//   ON ASK     a project with no marker at DASHBOARD_READS_VERSION is rebuilt from its records first, under that lock
//              EXCLUSIVE, so no write lands mid-build.
//
// What a record reads comes from `describe`, registered by src/analysis/analysis.ts (this module may not import it,
// as recordFs imports this one): the copy's own `published.reads`, or null for a copy published before them — whose
// reads `legacy` works out at the rebuild (it reads other records, so before the lock), never written back.
// Without a describer, a write drops the marker.

import type { PoolClient } from 'pg';
import { inOrg, orgDb } from './db/inOrg';
import { logger } from '../app/logger';

/** Bump when what a record describes to changes: every marker is then stale, and each project rebuilds once. */
export const DASHBOARD_READS_VERSION = 1;
const REBUILD_BATCH = 100;
const REBUILD_BYTES = 8 * 1024 * 1024;

export interface ReadsDescriber {
  /** The dataset ids (lowercase) the record's published copy reads; [] when it has none; null for a copy without `reads`. */
  describe(projectId: string, body: string): string[] | null;
  /** What such a copy reads, worked out from its definition (other records). */
  legacy(projectId: string, body: string): Promise<string[]>;
}
export type RowsUnder = (c: PoolClient, org: string, rel: string, after: string, limit: number, maxBytes: number) => Promise<Array<{ rel: string; body: string | null }>>;

let describer: ReadsDescriber | null = null;
export function useDashboardReadsDescriber(d: ReadsDescriber | null): void {
  describer = d;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const RECORD = new RegExp(`^projects/(${UUID})/analyses/(${UUID})\\.json$`);
const PROJECT_DIR = new RegExp(`^projects/(${UUID})(?:/analyses)?$`);

/** The dashboard a record path is, or null; both ids lowercase. */
export function dashboardAt(rel: string): { projectId: string; id: string } | null {
  const m = RECORD.exec(rel);
  return m ? { projectId: m[1].toLowerCase(), id: m[2].toLowerCase() } : null;
}

const lockKeyOf = (org: string, projectId: string): string => `dashboard_reads:${org}:${projectId}`;

let warned = false;
function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  logger.warn(`[reach] the dashboard reads index could not follow a write (${String((err as { code?: unknown })?.code ?? 'error')}); the next reach question rebuilds it. Further failures are not logged.`);
}

async function guarded(c: PoolClient, fn: () => Promise<void>): Promise<boolean> {
  await c.query('SAVEPOINT dashboard_reads_ix');
  try {
    await fn();
    await c.query('RELEASE SAVEPOINT dashboard_reads_ix');
    return true;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT dashboard_reads_ix; RELEASE SAVEPOINT dashboard_reads_ix');
    warnOnce(err);
    return false;
  }
}

async function insertRows(c: PoolClient, org: string, projectId: string, rows: ReadonlyArray<{ id: string; datasetId: string }>): Promise<void> {
  if (!rows.length) return;
  await c.query(
    `INSERT INTO dashboard_reads (org_id, project_id, analysis_id, dataset_id)
     SELECT $1, $2, u.a, u.d FROM unnest($3::text[], $4::text[]) AS u(a, d) ON CONFLICT DO NOTHING`,
    [org, projectId, rows.map((r) => r.id), rows.map((r) => r.datasetId)],
  );
}

const lockShared = (c: PoolClient, org: string, projectId: string) => c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [lockKeyOf(org, projectId)]);
const dropMarker = (c: PoolClient, org: string, projectId: string) => c.query('DELETE FROM dashboard_reads_built WHERE org_id = $1 AND project_id = $2', [org, projectId]);
const rowsOf = (id: string, ids: readonly string[]) => ids.map((datasetId) => ({ id, datasetId }));

/** The record at `rel` was written (`body`) or removed (null), in transaction `c`. Never throws but on a dead connection. */
export async function onDashboardReadsWrite(c: PoolClient, org: string, rel: string, body: string | null): Promise<void> {
  const at = dashboardAt(rel);
  if (!at) return;
  const d = describer;
  const held = await guarded(c, async () => {
    await lockShared(c, org, at.projectId);
    await c.query('DELETE FROM dashboard_reads WHERE org_id = $1 AND project_id = $2 AND analysis_id = $3', [org, at.projectId, at.id]);
    const reads = body === null ? [] : d ? d.describe(at.projectId, body) : null;
    if (reads === null) return void (await dropMarker(c, org, at.projectId)); // no describer, or a copy without `reads`: the rebuild works it out
    await insertRows(c, org, at.projectId, rowsOf(at.id, reads));
  });
  if (!held) await guarded(c, async () => { await lockShared(c, org, at.projectId); await dropMarker(c, org, at.projectId); });
}

/** Every record under directory `rel` was removed, in transaction `c`: a whole project's (or org's) rows go, marker and all. */
export async function onDashboardReadsRangeDelete(c: PoolClient, org: string, rel: string): Promise<void> {
  const m = PROJECT_DIR.exec(rel);
  if (!m && rel !== '' && rel !== 'projects') return;
  await guarded(c, async () => {
    if (!m) {
      await c.query('DELETE FROM dashboard_reads WHERE org_id = $1', [org]);
      await c.query('DELETE FROM dashboard_reads_built WHERE org_id = $1', [org]);
      return;
    }
    const projectId = m[1].toLowerCase();
    await lockShared(c, org, projectId);
    await c.query('DELETE FROM dashboard_reads WHERE org_id = $1 AND project_id = $2', [org, projectId]);
    await dropMarker(c, org, projectId);
  });
}

/** Every dashboard record of the project, a page at a time, in `c`. */
async function eachBody(c: PoolClient, org: string, projectId: string, rowsUnder: RowsUnder, fn: (id: string, body: string) => void): Promise<void> {
  for (let after = ''; ;) {
    const batch = await rowsUnder(c, org, `projects/${projectId}/analyses`, after, REBUILD_BATCH, REBUILD_BYTES);
    if (!batch.length) return;
    for (const b of batch) {
      const at = dashboardAt(b.rel);
      if (b.body !== null && at && at.projectId === projectId) fn(at.id, b.body);
    }
    after = batch[batch.length - 1].rel;
  }
}

let rebuilds = 0;
/** How many rebuilds this process ran (scripts/test-dashboardReads: "once"). */
export const rebuildCount = (): number => rebuilds;

/**
 * Rebuild `projectId` from its records unless it is built at this version. A copy without `reads` is worked out FIRST,
 * outside the lock (it reads other records, on other connections); one that changed in between is left out and the
 * marker not set, so the next question builds again: a narrower reach, never a wider one.
 */
async function rebuild(projectId: string, rowsUnder: RowsUnder): Promise<void> {
  const d = describer;
  if (!d) throw new Error('dashboard reads: no describer registered');
  const legacy = new Map<string, string[]>(); // body → its reads
  const pending: string[] = [];
  await inOrg((c, org) => eachBody(c, org, projectId, rowsUnder, (_id, body) => { if (d.describe(projectId, body) === null) pending.push(body); }));
  for (const body of pending) legacy.set(body, await d.legacy(projectId, body));
  await inOrg(async (c, org) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKeyOf(org, projectId)]);
    const done = await c.query('SELECT 1 FROM dashboard_reads_built WHERE org_id = $1 AND project_id = $2 AND version = $3', [org, projectId, DASHBOARD_READS_VERSION]);
    if (done.rowCount) return; // another pod built it while this one waited for the lock
    rebuilds++;
    await c.query('DELETE FROM dashboard_reads WHERE org_id = $1 AND project_id = $2', [org, projectId]);
    const rows: Array<{ id: string; datasetId: string }> = [];
    let complete = true;
    await eachBody(c, org, projectId, rowsUnder, (id, body) => {
      const reads = d.describe(projectId, body) ?? legacy.get(body) ?? null;
      if (reads === null) complete = false;
      else rows.push(...rowsOf(id, reads));
    });
    await insertRows(c, org, projectId, rows);
    if (complete) {
      await c.query(
        `INSERT INTO dashboard_reads_built (org_id, project_id, version) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, project_id) DO UPDATE SET version = EXCLUDED.version, built_at = now()`,
        [org, projectId, DASHBOARD_READS_VERSION],
      );
    }
  });
}

/**
 * For each of `datasetIds` (lowercase), the folders of the dashboards whose published copy reads it — a dashboard in
 * Everyone as the project id — in ONE statement with `c`, and whether the project is built at this version.
 */
export async function readersIn(c: PoolClient, org: string, projectId: string, datasetIds: readonly string[]): Promise<{ built: boolean; readers: Map<string, string[]> }> {
  const rows = (await c.query<{ built: number | null; dataset_id: string | null; folder: string | null }>(
    `SELECT b.version AS built, r.dataset_id, r.folder FROM (SELECT 1) one
       LEFT JOIN dashboard_reads_built b ON b.org_id = $1 AND b.project_id = $2 AND b.version = $4
       LEFT JOIN LATERAL (SELECT DISTINCT r.dataset_id, coalesce(f.folder_id::text, $2::text) AS folder
                            FROM dashboard_reads r
                            LEFT JOIN folder_items f ON f.org_id = r.org_id AND f.project_id = r.project_id AND f.kind = 'dashboard' AND f.item_id = r.analysis_id
                           WHERE r.org_id = $1 AND r.project_id = $2 AND r.dataset_id = ANY($3::text[])) r ON true`,
    [org, projectId, datasetIds, DASHBOARD_READS_VERSION],
  )).rows;
  const readers = new Map<string, string[]>();
  for (const r of rows) if (r.dataset_id && r.folder) (readers.get(r.dataset_id) ?? readers.set(r.dataset_id, []).get(r.dataset_id) as string[]).push(r.folder);
  return { built: rows[0]?.built != null, readers };
}

/** `readersIn` in the caller's org, after a rebuild when the project is not built. Empty without a database. */
export async function readersOf(projectId: string, datasetIds: readonly string[], rowsUnder: RowsUnder): Promise<Map<string, string[]>> {
  if (!orgDb() || !datasetIds.length) return new Map();
  const p = projectId.toLowerCase();
  const ask = () => inOrg((c, org) => readersIn(c, org, p, datasetIds));
  const first = await ask();
  if (first.built) return first.readers;
  await rebuild(p, rowsUnder);
  return (await ask()).readers; // still unbuilt: a copy changed mid-build, so reach is narrower this once
}

/** Builds the project's rows when it is not built at this version (a push asks it before its recipients). */
export const buildReads = (projectId: string, rowsUnder: RowsUnder): Promise<void> => rebuild(projectId.toLowerCase(), rowsUnder);
