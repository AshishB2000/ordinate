// Dataset refresh — MAIN PROCESS ONLY.
//
// ONE refresh model for every source kind. Each branch below does nothing but
// re-fetch rows the way that source was originally imported, and then funnels
// them into `datasets.updateDatasetData`. That single call is the whole point:
// when the dataset has a prepare pipeline, fresh rows become the new IMMUTABLE
// SOURCE and the derived output is recomputed from the stored steps — so a
// refresh keeps the pipeline instead of flattening it or reverting to stale
// source data. The connection path has always worked this way; this generalises
// it rather than adding a second mechanism beside it.
//
// Nothing here parses or fetches on its own: files go through src/fileImport.ts
// (the same parser and byte ceiling the import uses), URLs and connections go
// through the connector registry, and a combine goes through
// combine.combineTables. A second parser or a second fetcher would be a
// second answer to "what is in this source", and the refresh copy is the one
// nobody would notice drifting.
//
// THE INVARIANT, above everything else: a failed refresh never destroys data. On
// any error the stored table is left exactly as it was and only the refresh
// markers change (datasets.markRefresh, which rewrites three keys of the raw
// JSON and never round-trips the table).

import * as datasets from './datasets';
import type { Dataset, DatasetOrigin } from './datasets';
import * as combine from './combine';
import { parseFile, sourceKindForPath } from './fileImport';
import { runConnection } from './connectionRun';
import { refreshConnectionInto } from './ipc/connections';

/**
 * Row ceiling for a refreshed table. Deliberately the same 1,000,000 the import
 * path uses: a refreshed table is a dataset like any other and obeys the same
 * cap. Every upstream is already bounded (parse.ts caps while parsing, the
 * connector registry caps by rowLimit, combineTables takes a limit), so the
 * slice below is the defensive backstop, not the primary guard.
 */
const MAX_ROWS = 1_000_000;

/** How deep a chain of combined datasets a single refresh will walk. */
const MAX_COMBINE_DEPTH = 4;

export interface RefreshOk {
  ok: true;
  dataset: Dataset;
  /** Pipeline warnings from re-deriving the output (e.g. a step whose column is gone). */
  warnings: string[];
}
export interface RefreshErr {
  ok: false;
  error: string;
}
export type RefreshResult = RefreshOk | RefreshErr;

interface Walk {
  /** Datasets already visited on THIS refresh, so a combine cycle terminates. */
  visited: Set<string>;
  depth: number;
}

function fail(error: string): RefreshErr {
  return { ok: false, error };
}

/**
 * Re-fetch a dataset's rows from wherever it came from and re-derive its output.
 *
 * Returns a clean typed error — never throws — for: no origin (a snapshot, e.g.
 * paste or capture, or a record whose stored origin failed sanitisation), a
 * missing/renamed/unreadable file, a failed fetch, a missing parent, or a cycle.
 */
export async function refreshDataset(
  projectId: string,
  id: string,
  walk: Walk = { visited: new Set(), depth: 0 },
): Promise<RefreshResult> {
  // Cheap metadata read — the origin and the steps are all this needs to decide
  // what to do, and hydrating a million rows to find out would be absurd.
  const meta = await datasets.getDatasetMeta(projectId, id);
  if (!meta) return fail('Dataset not found');
  const origin = meta.origin;
  if (!origin) {
    return fail(`"${meta.name}" has no re-fetchable source. Re-import it to make it refreshable.`);
  }

  // A cycle is only reachable through `combined`, but the guard is checked for
  // every kind: it is the one thing that must hold before any work starts.
  if (walk.visited.has(id)) {
    return fail(`"${meta.name}" refers to itself through a combined dataset, so it was left unchanged.`);
  }
  if (walk.depth > MAX_COMBINE_DEPTH) {
    return fail(`"${meta.name}" is nested more than ${MAX_COMBINE_DEPTH} combines deep, so it was left unchanged.`);
  }
  walk.visited.add(id);

  const warnings: string[] = [];
  let result: RefreshResult;
  try {
    result = await runOrigin(projectId, id, meta.name, origin, walk, warnings);
  } catch (err: any) {
    // Belt and braces: every branch already returns a typed error, so reaching
    // here means an unexpected throw — which must still not touch the table.
    result = fail(err?.message || 'Refresh failed');
  }

  // The markers are written LAST and separately, so the stored table is either
  // the old one (on failure) or the new one (on success) — never a mix.
  await datasets.markRefresh(projectId, id, result.ok ? 'ok' : 'error', result.ok ? null : result.error);
  if (!result.ok) return result;

  // Re-read so the returned record carries the markers just written.
  const fresh = await datasets.getDataset(projectId, id);
  // Deduped: walking a combine tree can surface the same warning once per
  // parent slot, and three identical lines in the UI read as three problems.
  return { ok: true, dataset: fresh ?? result.dataset, warnings: [...new Set(warnings)] };
}

async function runOrigin(
  projectId: string,
  id: string,
  name: string,
  origin: DatasetOrigin,
  walk: Walk,
  warnings: string[],
): Promise<RefreshResult> {
  switch (origin.kind) {
    case 'file':
      return refreshFromFile(projectId, id, origin, warnings);
    case 'url':
      return refreshFromUrl(projectId, id, origin, warnings);
    case 'connection': {
      // Delegated whole: the secret is resolved in main by the connections
      // layer, and the connection's own lastStatus/lastRefreshedAt still update.
      const res = await refreshConnectionInto(projectId, origin.connId, id, warnings);
      return res.ok ? { ok: true, dataset: res.dataset, warnings } : res;
    }
    case 'combined':
      return refreshCombined(projectId, id, name, origin, walk, warnings);
    case 'composed':
      return refreshComposed(projectId, id, name, origin, walk, warnings);
    default:
      return fail('This dataset has no re-fetchable source.');
  }
}

// ── file ─────────────────────────────────────────────────────────────────────
async function refreshFromFile(
  projectId: string,
  id: string,
  origin: Extract<DatasetOrigin, { kind: 'file' }>,
  warnings: string[],
): Promise<RefreshResult> {
  const kind = sourceKindForPath(origin.path);
  if (!kind) return fail('That file type is no longer supported.');

  let parsed;
  try {
    parsed = await parseFile(origin.path, kind, origin.sheetName);
  } catch (err: any) {
    // A moved/renamed/deleted file and a permissions failure are the two normal
    // ways this breaks, and both deserve the path rather than an errno.
    const code = err?.code;
    if (code === 'ENOENT') return fail(`The file is no longer at ${origin.path}`);
    if (code === 'EACCES' || code === 'EPERM') return fail(`No permission to read ${origin.path}`);
    return fail(err?.message || `Could not read ${origin.path}`);
  }
  if (!parsed || !Array.isArray(parsed.columns) || parsed.columns.length === 0) {
    return fail('That file no longer contains a readable table.');
  }
  if (Array.isArray(parsed.warnings)) warnings.push(...parsed.warnings);
  return store(projectId, id, parsed.columns, parsed.rows, warnings);
}

// ── url ──────────────────────────────────────────────────────────────────────
async function refreshFromUrl(
  projectId: string,
  id: string,
  origin: Extract<DatasetOrigin, { kind: 'url' }>,
  warnings: string[],
): Promise<RefreshResult> {
  // The registry's URL connector, unchanged: https-only, byte-capped, timed out,
  // and parsed by parse.ts. No second fetcher.
  const res = await runConnection('url', { url: origin.url }, {}, {});
  if (!res.ok) return fail(res.error);
  if (res.truncated) warnings.push(`The source returned more than ${MAX_ROWS.toLocaleString()} rows; it was truncated.`);
  return store(projectId, id, res.result.columns, res.result.rows, warnings);
}

// ── combined ─────────────────────────────────────────────────────────────────
async function refreshCombined(
  projectId: string,
  id: string,
  name: string,
  origin: Extract<DatasetOrigin, { kind: 'combined' }>,
  walk: Walk,
  warnings: string[],
): Promise<RefreshResult> {
  // Refresh the parents FIRST, so a combine re-runs over fresh inputs rather
  // than re-combining two stale ones. A parent that cannot be refreshed is NOT
  // fatal: it may simply be a snapshot (paste/capture), and combining a fresh
  // table with a legitimately static one is a normal thing to want.
  for (const parentId of [origin.leftId, origin.rightId]) {
    const res = await refreshDataset(projectId, parentId, { visited: walk.visited, depth: walk.depth + 1 });
    if (!res.ok) warnings.push(res.error);
    else warnings.push(...res.warnings);
  }

  const left = await datasets.getDataset(projectId, origin.leftId);
  const right = await datasets.getDataset(projectId, origin.rightId);
  if (!left || !right) {
    return fail(`"${name}" needs both of the datasets it was built from, and one is missing.`);
  }

  const combined = combine.combineTables(
    { columns: left.columns, rows: left.rows },
    { columns: right.columns, rows: right.rows },
    origin.mode,
    origin.on,
    MAX_ROWS, // bound a join's OUTPUT during the build — a join is inherently m×n
  );
  if (Array.isArray(combined.warnings)) warnings.push(...combined.warnings);
  if (!combined.columns.length) {
    return fail(`"${name}" could not be rebuilt from its two datasets.`);
  }
  return store(projectId, id, combined.columns, combined.rows, warnings);
}

// ── composed (the composer's N-table chain) ──────────────────────────────────
//
// Same shape as refreshCombined, and deliberately so: refresh every parent
// first, then re-run the pure fold over their FRESH derived tables. The only
// real difference is that "one parent is missing" has to name which one — with
// two you can guess, with six you cannot.
async function refreshComposed(
  projectId: string,
  id: string,
  name: string,
  origin: Extract<DatasetOrigin, { kind: 'composed' }>,
  walk: Walk,
  warnings: string[],
): Promise<RefreshResult> {
  const parentIds = [origin.baseId, ...origin.joins.map((j) => j.datasetId)];

  // The existing visited-set + depth cap generalise unchanged: each recursive
  // call carries the SAME visited set, so a chain that reaches the same parent
  // twice refreshes it once, and a cycle terminates.
  for (const parentId of parentIds) {
    const res = await refreshDataset(projectId, parentId, { visited: walk.visited, depth: walk.depth + 1 });
    if (!res.ok) warnings.push(res.error);
    else warnings.push(...res.warnings);
  }

  const loaded = await Promise.all(parentIds.map((pid) => datasets.getDataset(projectId, pid)));
  const missing = parentIds.filter((_, i) => !loaded[i]);
  if (missing.length) {
    return fail(
      `"${name}" is built from ${parentIds.length} datasets and ${missing.length} of them ` +
      `${missing.length === 1 ? 'is' : 'are'} missing. Its data has been left as it was.`,
    );
  }

  const table = (d: Dataset): { columns: Dataset['columns']; rows: Dataset['rows'] } =>
    ({ columns: d.columns, rows: d.rows });

  const composed = combine.composeTables(
    table(loaded[0] as Dataset),
    origin.joins.map((j, i) => ({ table: table(loaded[i + 1] as Dataset), mode: j.mode, on: j.on })),
    MAX_ROWS, // bound EVERY step — a join is inherently m×n, and so is the next one
  );
  if (Array.isArray(composed.warnings)) warnings.push(...composed.warnings);
  if (!composed.columns.length) {
    return fail(`"${name}" could not be rebuilt from the datasets it was composed from.`);
  }
  return store(projectId, id, composed.columns, composed.rows, warnings);
}

// ── the one write ────────────────────────────────────────────────────────────
async function store(
  projectId: string,
  id: string,
  columns: Dataset['columns'],
  rows: Dataset['rows'],
  warnings: string[],
): Promise<RefreshResult> {
  if (rows.length > MAX_ROWS) {
    warnings.push(`Kept the first ${MAX_ROWS.toLocaleString()} rows; the source now has more.`);
    rows = rows.slice(0, MAX_ROWS);
  }
  // updateDatasetData is the primitive that keeps the prepare pipeline: with a
  // source present it re-derives the output from the stored steps, collecting
  // any warnings (a step whose column the fresh source no longer has is SKIPPED
  // with a warning — drift is reported, never a crash and never a wrong number).
  const updated = await datasets.updateDatasetData(projectId, id, { columns, rows }, undefined, warnings);
  if (!updated) return fail('Could not write the refreshed data.');
  return { ok: true, dataset: updated, warnings };
}
