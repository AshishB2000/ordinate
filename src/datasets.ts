// Dataset persistence — MAIN PROCESS ONLY.
// One JSON file per dataset under userData/projects/<projectId>/datasets/<id>.json.
// Unlike projects (one dir per project), a dataset is a single JSON blob, so a
// flat file inside the project's datasets/ dir is simpler (ponytail). Mirrors
// src/projects.ts conventions verbatim: the UUID id-validation guard, atomic
// JSON writes, and graceful skip of missing/corrupt files.
//
// SECURITY: BOTH projectId AND datasetId are validated as UUIDs before either is
// concatenated into a path, so a dataset path can never escape
// userData/projects/<projectId>/datasets.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import type { ParsedColumn } from './parse';
import { coerceValue } from './parse';
import * as projects from './projects';
import * as parquetStore from './parquetStore';
import * as transforms from './transforms';
import type { TableData, TransformStep, ApplyResult } from './transforms';

/**
 * WHERE a dataset's rows came from, so they can be fetched again.
 *
 * Distinct from `sourceKind`, which is a display/format label and is a closed
 * union of eight values that 35 connectors already collapse onto. This says how
 * to RE-RUN the import, and it is the only thing that makes a dataset
 * refreshable — a record without one is a snapshot, exactly as every dataset was
 * before this existed.
 *
 * `paste` and `capture` deliberately have no origin: pasted text has no
 * re-fetchable source, and a capture already has its own recapture flow.
 */
export type DatasetOrigin =
  | { kind: 'file'; path: string; sheetName?: string }
  | { kind: 'url'; url: string }
  | { kind: 'connection'; connId: string }
  | {
      kind: 'combined';
      leftId: string;
      rightId: string;
      mode: 'append' | 'join';
      on?: { left: string; right: string };
    };

export interface Dataset {
  id: string;
  projectId: string;
  name: string;
  sourceKind: 'csv' | 'json' | 'paste' | 'xlsx' | 'postgres' | 'url' | 'combined' | 'capture';
  columns: ParsedColumn[];
  rows: (string | number | null)[][];
  rowCount: number;
  createdAt: string;
  updatedAt: string;
  // 2 = table inline in this JSON; 3 = table in a sibling .parquet. The
  // in-memory value is always 2 once rows are hydrated — 3 describes the FILE.
  schemaVersion: 2 | 3;
  // Week 13 — screenshot provenance for a `sourceKind: 'capture'` dataset. OPTIONAL
  // so every pre-Week-13 dataset stays valid untouched. `cropPath` is the absolute
  // path to the crop already on disk under userData/history/<entryId>/crop.png
  // (written by history.saveCrop in the capture loop) — stored as a path, not a
  // data-URI, so the renderer shows a file:// thumbnail and can VERIFY extracted
  // values against the original image later. A recapture overwrites this link with
  // the newest screenshot.
  capture?: { entryId: string | null; cropPath: string | null };
  // Week 6 — reversible transform pipeline. Both OPTIONAL for backward compat: a
  // dataset with no steps behaves exactly as a v1 dataset (columns/rows ARE the
  // data). `source` is the immutable original, snapshotted the first time a step
  // is added; the stored columns/rows are the DERIVED output = applyPipeline(source,
  // steps). When steps returns to [], output === source and the dataset reverts.
  source?: TableData;
  steps?: TransformStep[];
  /**
   * Refresh provenance. All OPTIONAL, so every record written before this
   * existed stays valid untouched and simply reads as "not refreshable".
   *
   * `lastRefreshedAt` is deliberately separate from `updatedAt`: a rename or a
   * pipeline edit bumps updatedAt without the DATA being any newer, and
   * "Data as of…" must not claim otherwise.
   */
  origin?: DatasetOrigin;
  lastRefreshedAt?: string;
  lastRefreshStatus?: 'ok' | 'error';
  lastRefreshError?: string | null;
}

export interface DatasetSummary {
  id: string;
  name: string;
  sourceKind: Dataset['sourceKind'];
  rowCount: number;
  columnCount: number;
  updatedAt: string;
  // Week 13 — just the crop path (not the full capture object) so the saved-list
  // can render a capture thumbnail + badge without a full dataset load.
  capture?: { cropPath: string | null };
  // Freshness for the saved list, WITHOUT a full dataset load. Only the origin's
  // `kind` is carried: the list needs "is this refreshable", not the path or URL.
  originKind?: DatasetOrigin['kind'];
  lastRefreshedAt?: string;
  lastRefreshStatus?: 'ok' | 'error';
}

let projectsBase: string | null = null;

function getProjectsBase(): string {
  if (!projectsBase) projectsBase = path.join(app.getPath('userData'), 'projects');
  return projectsBase;
}

// Ids arrive from the renderer over IPC. Validate the SHAPE before either id ever
// reaches a filesystem path — an id like ".." or "../../foo" would otherwise
// escape the project's datasets dir. Copied verbatim from projects.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function datasetsDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'datasets');
}

function datasetFilePath(projectId: string, id: string): string {
  return path.join(datasetsDir(projectId), id + '.json');
}

const SOURCE_KINDS: ReadonlySet<string> = new Set(['csv', 'json', 'paste', 'xlsx', 'postgres', 'url', 'combined', 'capture']);

// Coerce an untrusted `capture` link (from a stored file OR a save/recapture IPC
// payload) into the stored shape, or undefined if there is nothing usable. Accepts
// either a { entryId, cropPath } object or a bare path string. Only strings are
// kept; nothing here reaches the filesystem (the path is stored verbatim and later
// rendered as a file:// thumbnail).
function sanitizeCapture(raw: any): { entryId: string | null; cropPath: string | null } | undefined {
  if (typeof raw === 'string') {
    return raw ? { entryId: null, cropPath: raw } : undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const entryId = typeof raw.entryId === 'string' && raw.entryId ? raw.entryId : null;
  const cropPath = typeof raw.cropPath === 'string' && raw.cropPath ? raw.cropPath : null;
  if (entryId === null && cropPath === null) return undefined;
  return { entryId, cropPath };
}

/**
 * Whitelist an untrusted `origin` — from a stored file OR a save IPC payload —
 * into a well-formed DatasetOrigin, or `undefined`. Never throws.
 *
 * This is a SECURITY control, not tidying. `normalize()` runs it on every load,
 * so a hand-edited or corrupted record degrades to "not refreshable" instead of
 * turning into a file read or a fetch at an attacker's chosen target:
 *   • a relative path could escape wherever the refresh happens to resolve it
 *   • `file:`/`javascript:`/`data:` URLs are not fetchable sources
 *   • a non-UUID id would reach a path join in connections/datasets
 * Same whitelist discipline as sanitizeCapture and visuals.sanitizeEncoding:
 * keep only what is recognised, drop the rest, never repair.
 */
export function sanitizeOrigin(raw: unknown): DatasetOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  switch (o.kind) {
    case 'file': {
      const p = typeof o.path === 'string' ? o.path : '';
      // Absolute only. A relative path has no meaning outside the cwd it was
      // captured in, and main's cwd is not the user's.
      if (!p || !path.isAbsolute(p)) return undefined;
      const sheetName = str(o.sheetName);
      return sheetName ? { kind: 'file', path: p, sheetName } : { kind: 'file', path: p };
    }
    case 'url': {
      const u = str(o.url);
      if (!u) return undefined;
      try {
        const parsed = new URL(u);
        // http/https ONLY. (The URL connector itself is https-only and will
        // refuse an http one at fetch time — this is the outer guard that keeps
        // every other scheme from ever reaching a fetcher.)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
        return { kind: 'url', url: u };
      } catch (_) {
        return undefined;
      }
    }
    case 'connection': {
      const connId = str(o.connId);
      return isValidId(connId) ? { kind: 'connection', connId } : undefined;
    }
    case 'combined': {
      const leftId = str(o.leftId);
      const rightId = str(o.rightId);
      if (!isValidId(leftId) || !isValidId(rightId)) return undefined;
      if (o.mode !== 'append' && o.mode !== 'join') return undefined;
      const out: DatasetOrigin = { kind: 'combined', leftId, rightId, mode: o.mode };
      const on = o.on as Record<string, unknown> | undefined;
      if (on && typeof on === 'object' && typeof on.left === 'string' && typeof on.right === 'string') {
        out.on = { left: on.left, right: on.right };
      }
      return out;
    }
    default:
      return undefined;
  }
}

// Atomic JSON write: temp sibling then rename (atomic on same fs), so a crash
// mid-write never leaves a half-written dataset file. Copied from projects.ts.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file); // atomic on same fs
}

// ── Phase 2: Parquet table storage ──────────────────────────────────────────
//
// v2 record: <id>.json holds metadata AND both tables inline.
// v3 record: <id>.json holds metadata only; <id>.parquet holds the derived
//            table and <id>.source.parquet the immutable source.
//
// Migration is one-way and LAZY (on write, and on read of a v2 record). It is
// gated on duck.isAvailable(): on a machine where the native binding fails to
// load we keep writing v2 inline, so the app degrades to "exactly as before"
// rather than to "your data is gone".
//
// The source parquet is keyed on `source !== undefined`, NOT on steps.length:
// updateSteps snapshots a source even when the step list is empty, and
// test-datasets.ts:232-238 asserts that source survives clearing all steps.
// Keying on steps would silently discard it.

function parquetPath(projectId: string, id: string): string {
  return path.join(datasetsDir(projectId), id + '.parquet');
}
function sourceParquetPath(projectId: string, id: string): string {
  return path.join(datasetsDir(projectId), id + '.source.parquet');
}

// Write a dataset's tables to Parquet and its metadata to JSON, or fall back to
// a v2 inline write when DuckDB is unavailable. Parquet first, JSON second: if
// the JSON write fails we are left with a stale parquet and a v2 record that
// still has its rows, and the next load re-migrates over it. The reverse order
// would lose the rows outright.
async function persist(projectId: string, dataset: Dataset): Promise<void> {
  const file = datasetFilePath(projectId, dataset.id);
  if (!parquetStore.isSupported()) {
    await writeJsonAtomic(file, dataset); // v2, rows inline
    return;
  }
  parquetStore.writeTable(parquetPath(projectId, dataset.id), dataset.columns, dataset.rows);
  if (dataset.source) {
    parquetStore.writeTable(
      sourceParquetPath(projectId, dataset.id),
      dataset.source.columns,
      dataset.source.rows,
    );
  }
  // rowCount and columns are written in the SAME operation as the table they
  // describe, always derived from what was just written — they are printed as
  // app-computed facts into model prompts, so a stale value is a number-accuracy
  // violation, not a cosmetic bug.
  const meta: Record<string, unknown> = {
    ...dataset,
    rows: undefined,
    source: dataset.source ? { columns: dataset.source.columns } : undefined,
    rowCount: dataset.rows.length,
    schemaVersion: 3,
  };
  delete meta.rows;
  if (!dataset.source) delete meta.source;
  await writeJsonAtomic(file, meta);
}

// Load the tables for a v3 record. Returns false when the data cannot be read —
// the caller must then fail VISIBLY rather than silently yielding an empty
// table, because updateSteps snapshots whatever rows it is handed and an empty
// snapshot would destroy the dataset.
function hydrate(projectId: string, data: any): boolean {
  if (Array.isArray(data.rows)) return true; // v2, already inline
  const derived = parquetStore.readTable(parquetPath(projectId, data.id), data.columns);
  if (!derived) return false;
  data.rows = derived.rows;
  if (data.source && Array.isArray(data.source.columns)) {
    const src = parquetStore.readTable(
      sourceParquetPath(projectId, data.id),
      data.source.columns,
    );
    if (!src) return false;
    data.source = { columns: data.source.columns, rows: src.rows };
  }
  return true;
}

// Basic shape validation for a parsed dataset.json (skips corrupt files).
// `rows` is NOT required: a v3 record keeps its table in a sibling .parquet and
// legitimately has no rows key. Requiring it here would make every migrated
// dataset fail validation and silently vanish from the sidebar.
function isValidDataset(data: any): data is Dataset {
  return (
    Boolean(data) &&
    typeof data.id === 'string' &&
    data.id.length > 0 &&
    Array.isArray(data.columns)
  );
}

// Coerce a parsed object into a well-formed Dataset (fills sane defaults).
// Backward-compatible: a stored v1 dataset (no source/steps) normalizes to
// steps=[], source=undefined and reads schemaVersion 2 — its columns/rows are the
// data, exactly as before. Untrusted stored `steps` are re-sanitized on load.
function normalize(data: any, projectId: string): Dataset {
  const createdAt = data.createdAt || new Date().toISOString();
  const kind: Dataset['sourceKind'] = SOURCE_KINDS.has(data.sourceKind) ? data.sourceKind : 'csv';
  const rows: (string | number | null)[][] = Array.isArray(data.rows) ? data.rows : [];
  const columns: ParsedColumn[] = Array.isArray(data.columns) ? data.columns : [];
  const steps: TransformStep[] = transforms.sanitizeSteps(data.steps);
  const ds: Dataset = {
    id: String(data.id),
    projectId,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled dataset',
    sourceKind: kind,
    columns,
    rows,
    rowCount: typeof data.rowCount === 'number' ? data.rowCount : rows.length,
    createdAt,
    updatedAt: data.updatedAt || createdAt,
    schemaVersion: 2,
    steps,
  };
  // Only carry a `source` when one was persisted (i.e. steps were ever added). A
  // pristine v1/v2 dataset keeps source undefined until its first step.
  if (data.source && typeof data.source === 'object' && Array.isArray(data.source.columns) && Array.isArray(data.source.rows)) {
    ds.source = { columns: data.source.columns, rows: data.source.rows };
  }
  // Week 13 — carry a screenshot link through when present (shape-checked).
  const capture = sanitizeCapture(data.capture);
  if (capture) ds.capture = capture;
  // Refresh provenance. sanitizeOrigin runs on EVERY load, so a hand-edited or
  // corrupt origin reads back as "not refreshable" rather than as a file read.
  const origin = sanitizeOrigin(data.origin);
  if (origin) ds.origin = origin;
  if (typeof data.lastRefreshedAt === 'string' && data.lastRefreshedAt) ds.lastRefreshedAt = data.lastRefreshedAt;
  if (data.lastRefreshStatus === 'ok' || data.lastRefreshStatus === 'error') {
    ds.lastRefreshStatus = data.lastRefreshStatus;
  }
  if (typeof data.lastRefreshError === 'string') ds.lastRefreshError = data.lastRefreshError;
  return ds;
}

// No-op stub kept for symmetry with projects.init() (main.ts may call it). The
// datasets dir is created lazily on first saveDataset.
export async function init(): Promise<void> {
  // Intentionally empty — per-project datasets/ dirs are created on demand.
}

// Return summaries for a project's datasets, newest-updated first. Skips
// corrupt/missing files quietly (ENOENT silent; real damage logged).
export async function listDatasets(projectId: string): Promise<DatasetSummary[]> {
  if (!isValidId(projectId)) return [];
  const dir = datasetsDir(projectId);
  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return []; // no datasets dir yet
  }

  const out: DatasetSummary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const id = dirent.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue; // skip stray/tmp files
    try {
      const raw = await fs.promises.readFile(datasetFilePath(projectId, id), 'utf8');
      const data = JSON.parse(raw);
      if (!isValidDataset(data)) continue;
      const ds = normalize(data, projectId);
      const summary: DatasetSummary = {
        id: ds.id,
        name: ds.name,
        sourceKind: ds.sourceKind,
        rowCount: ds.rowCount,
        columnCount: ds.columns.length,
        updatedAt: ds.updatedAt,
      };
      if (ds.capture) summary.capture = { cropPath: ds.capture.cropPath };
      if (ds.origin) summary.originKind = ds.origin.kind;
      if (ds.lastRefreshedAt) summary.lastRefreshedAt = ds.lastRefreshedAt;
      if (ds.lastRefreshStatus) summary.lastRefreshStatus = ds.lastRefreshStatus;
      out.push(summary);
    } catch (err: any) { // ponytail: fs errors carry .code, JSON errors don't
      if (err.code !== 'ENOENT') {
        console.error('[datasets] Skipping corrupt or unreadable dataset:', id, err.message);
      }
    }
  }

  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

// Load a single dataset. Returns null if either id is invalid, or the file is
// missing/corrupt.
// ── Phase 2.5: metadata-only load, and the resident-query source ────────────
//
// `getDataset` hydrates the whole table into Cell[][]. That is the right shape
// for anything that needs the rows, and the wrong one for the many callers that
// only want columns/name/rowCount — `analysis:draft` (formerly `dashboard:draft`)
// loads EVERY dataset in a project just to read `ds.columns`, and the renderer's column pickers pay for a
// full structured-clone over IPC to populate a dropdown.

/** Everything in a Dataset except the tables. Cheap: one small JSON read. */
export type DatasetMeta = Omit<Dataset, 'rows' | 'source'> & {
  /** Column metadata of the immutable source, when the record has one. */
  sourceColumns?: ParsedColumn[];
  /** True when the table lives in a sibling .parquet (v3), i.e. resident-queryable. */
  resident: boolean;
};

export async function getDatasetMeta(projectId: string, id: string): Promise<DatasetMeta | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const raw = await fs.promises.readFile(datasetFilePath(projectId, id), 'utf8');
    const data = JSON.parse(raw);
    if (!isValidDataset(data)) return null;
    // Deliberately does NOT hydrate and does NOT migrate. Migration is a write,
    // and a metadata read must stay a read — otherwise every column-picker open
    // could trigger a table rewrite.
    const ds = normalize({ ...data, rows: Array.isArray(data.rows) ? data.rows : [] }, projectId);
    const meta: DatasetMeta = {
      ...ds,
      rowCount: typeof data.rowCount === 'number' ? data.rowCount : ds.rowCount,
      resident: !Array.isArray(data.rows) && fs.existsSync(parquetPath(projectId, id)),
    } as DatasetMeta;
    delete (meta as Partial<Dataset>).rows;
    delete (meta as Partial<Dataset>).source;
    if (data.source && Array.isArray(data.source.columns)) meta.sourceColumns = data.source.columns;
    return meta;
  } catch (_) {
    return null;
  }
}

/**
 * The stored derived table, addressable by SQL without materialising it.
 *
 * Returns null for a v2 record (table still inline in the JSON), a missing
 * Parquet, or an unavailable bridge — the caller must then fall back to
 * `getDataset` + the JS path. Note the `.parquet` holds the table AFTER the
 * prepare pipeline, so a resident query needs no step replay.
 */
export async function residentSource(
  projectId: string,
  id: string,
): Promise<{ parquetPath: string; columns: ParsedColumn[] } | null> {
  if (!parquetStore.isSupported()) return null;
  const meta = await getDatasetMeta(projectId, id);
  if (!meta || !meta.resident) return null;
  return { parquetPath: parquetPath(projectId, id), columns: meta.columns };
}

export async function getDataset(projectId: string, id: string): Promise<Dataset | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const raw = await fs.promises.readFile(datasetFilePath(projectId, id), 'utf8');
    const data = JSON.parse(raw);
    if (!isValidDataset(data)) return null;
    const wasInline = Array.isArray(data.rows);
    if (!hydrate(projectId, data)) return null;
    const ds = normalize(data, projectId);
    // Lazy one-way migration: a v2 record read on a machine with a working
    // bridge is rewritten as v3. Deterministic from the same input, and every
    // write is temp-then-rename, so two concurrent readers racing here degrade
    // to last-writer-wins with identical bytes.
    if (wasInline && parquetStore.isSupported()) {
      try {
        await persist(projectId, ds);
      } catch (_) {
        /* migration is best-effort: the record is still valid as v2 and will be
           retried on the next read. Never fail a load because of it. */
      }
    }
    return ds;
  } catch (_) {
    return null;
  }
}

// Create a new dataset file. Id is generated (never derived from the name). The
// project's datasets/ dir is created lazily. Returns the created dataset, or
// null if the projectId is invalid or its parent project does not exist.
export async function saveDataset(
  projectId: string,
  input: {
    name: string;
    sourceKind: Dataset['sourceKind'];
    columns: ParsedColumn[];
    rows: (string | number | null)[][];
    capture?: { entryId: string | null; cropPath: string | null };
    origin?: unknown;
  },
): Promise<Dataset | null> {
  if (!isValidId(projectId)) return null;
  // Don't orphan a dataset under a bogus-but-UUID-shaped project id.
  const parent = await projects.getProject(projectId);
  if (!parent) return null;

  const id = randomUUID();
  const now = new Date().toISOString();
  const rows: (string | number | null)[][] = Array.isArray(input.rows) ? input.rows : [];
  const dataset: Dataset = {
    id,
    projectId,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled dataset',
    sourceKind: SOURCE_KINDS.has(input.sourceKind) ? input.sourceKind : 'csv',
    columns: Array.isArray(input.columns) ? input.columns : [],
    rows,
    rowCount: rows.length,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2,
    steps: [],
  };
  // Week 13 — persist the screenshot link for a capture-sourced dataset.
  const capture = sanitizeCapture(input.capture);
  if (capture) dataset.capture = capture;
  // An import IS a fetch, so a freshly saved dataset's data is as of now. Without
  // this the first "Data as of…" would read from updatedAt and drift the moment
  // the dataset is renamed.
  const origin = sanitizeOrigin(input.origin);
  if (origin) {
    dataset.origin = origin;
    dataset.lastRefreshedAt = now;
    dataset.lastRefreshStatus = 'ok';
    dataset.lastRefreshError = null;
  }
  await fs.promises.mkdir(datasetsDir(projectId), { recursive: true });
  await persist(projectId, dataset);
  return dataset;
}

// Replace an existing dataset's columns + rows in place (used by a connection
// refresh: re-run the source, overwrite the linked dataset's data, bump
// updatedAt). Preserves id/name/sourceKind/createdAt. Returns null if either id
// is invalid or the dataset does not exist. Rows are capped defensively.
export async function updateDatasetData(
  projectId: string,
  id: string,
  data: { columns: ParsedColumn[]; rows: (string | number | null)[][] },
  capture?: { entryId: string | null; cropPath: string | null },
): Promise<Dataset | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getDataset(projectId, id);
  if (!existing) return null;
  const rows: (string | number | null)[][] = Array.isArray(data.rows) ? data.rows : [];
  const cols = Array.isArray(data.columns) ? data.columns : existing.columns;
  const now = new Date().toISOString();

  let updated: Dataset;
  if (existing.source !== undefined) {
    // A transform pipeline exists: the fresh data becomes the new immutable
    // SOURCE and the derived output is recomputed, so a connection refresh keeps
    // the pipeline instead of dropping it or reverting to stale source data.
    const source: TableData = { columns: cols, rows };
    const output = transforms.applyPipeline(source, existing.steps ?? []);
    updated = {
      ...existing, source, columns: output.columns, rows: output.rows,
      rowCount: output.rowCount, updatedAt: now,
    };
  } else {
    updated = { ...existing, columns: cols, rows, rowCount: rows.length, updatedAt: now };
  }
  // Week 13 — a recapture passes the newest screenshot link, which WINS; without
  // one the `...existing` spread preserves the stored link untouched.
  const cap = sanitizeCapture(capture);
  if (cap) updated.capture = cap;
  await fs.promises.mkdir(datasetsDir(projectId), { recursive: true });
  await persist(projectId, updated);
  return updated;
}

// Edit a dataset's column DEFINITIONS: rename columns and/or correct types.
// `patch.columns` is the FULL new columns array (same length + order as stored).
// A renamed column needs no cell work; a column whose TYPE changed has all its
// cells re-coerced through parse.coerceValue (text→number parses / nulls
// non-numeric, number→text keeps the digits, etc). Bumps updatedAt. Returns null
// if either id is invalid or the dataset does not exist. A column-count mismatch
// is clamped defensively (extra patch columns ignored, missing ones kept).
export async function updateDataset(
  projectId: string,
  id: string,
  patch: { columns?: ParsedColumn[] },
): Promise<Dataset | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getDataset(projectId, id);
  if (!existing) return null;

  const incoming = Array.isArray(patch.columns) ? patch.columns : null;
  if (!incoming) return existing; // nothing to change

  // Edit the SOURCE when a pipeline exists (so the change survives the next
  // recompute and the invariant output === applyPipeline(source, steps) holds);
  // otherwise edit the stored columns/rows directly (the no-pipeline case, i.e.
  // the Week-5 explorer on a plain dataset — unchanged behavior).
  // ponytail: patch is indexed against the base being edited; for a stepped
  // dataset that base is `source`, so edits map to source columns (rename a
  // step-generated column via a rename_column step instead).
  const base: TableData = existing.source ?? { columns: existing.columns, rows: existing.rows };
  const width = base.columns.length;
  const newColumns: ParsedColumn[] = base.columns.map((old, c) => {
    const next = incoming[c];
    if (!next || typeof next !== 'object') return old;
    const name = typeof next.name === 'string' && next.name.trim() ? next.name.trim() : old.name;
    const type: ParsedColumn['type'] =
      next.type === 'text' || next.type === 'number' || next.type === 'date' ? next.type : old.type;
    return { name, type };
  });

  // Re-coerce only the columns whose type actually changed (cheap; a pure rename
  // skips the rows rewrite).
  const retyped: number[] = [];
  for (let c = 0; c < width; c += 1) {
    if (newColumns[c].type !== base.columns[c].type) retyped.push(c);
  }
  let baseRows = base.rows;
  if (retyped.length > 0) {
    baseRows = base.rows.map((row) => {
      const out = row.slice();
      for (const c of retyped) out[c] = coerceValue(row[c] ?? null, newColumns[c].type);
      return out;
    });
  }

  const now = new Date().toISOString();
  let updated: Dataset;
  if (existing.source !== undefined) {
    const source: TableData = { columns: newColumns, rows: baseRows };
    const output = transforms.applyPipeline(source, existing.steps ?? []);
    updated = {
      ...existing, source, columns: output.columns, rows: output.rows,
      rowCount: output.rowCount, updatedAt: now,
    };
  } else {
    updated = { ...existing, columns: newColumns, rows: baseRows, rowCount: baseRows.length, updatedAt: now };
  }
  await fs.promises.mkdir(datasetsDir(projectId), { recursive: true });
  await persist(projectId, updated);
  return updated;
}

// Week 6 — set/replace a dataset's transform pipeline, recompute, and persist.
// The ONLY new mutating helper: every step edit (add/update/remove/reorder/set)
// resolves to a fresh `steps` array which the IPC layer passes here.
//
// Reversibility: the pipeline is recomputed from the IMMUTABLE `source` each time,
// so removing a step yields exactly the output of never having added it. `source`
// is snapshotted (= the current columns/rows) the FIRST time steps are applied,
// then never mutated. When `steps` becomes [] again the derived output === source,
// so the dataset reverts to showing the original data (source is kept, harmless).
//
// Returns { dataset, output } — output carries `warnings` for the IPC preview — or
// null if either id is invalid or the dataset is missing.
export async function updateSteps(
  projectId: string,
  id: string,
  rawSteps: unknown,
): Promise<{ dataset: Dataset; output: ApplyResult } | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getDataset(projectId, id);
  if (!existing) return null;

  const steps: TransformStep[] = transforms.sanitizeSteps(rawSteps);
  // Snapshot the current data as the immutable source the first time steps exist.
  const source: TableData = existing.source ?? {
    columns: existing.columns.map((c) => ({ ...c })),
    rows: existing.rows.map((r) => r.slice()),
  };
  const output = transforms.applyPipeline(source, steps);

  const updated: Dataset = {
    ...existing,
    schemaVersion: 2,
    source,
    steps,
    columns: output.columns,
    rows: output.rows,
    rowCount: output.rowCount,
    updatedAt: new Date().toISOString(),
  };
  await fs.promises.mkdir(datasetsDir(projectId), { recursive: true });
  await persist(projectId, updated);
  return { dataset: updated, output };
}

// Delete a dataset file. Returns true on success (force → missing is success).
export async function deleteDataset(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    // All three files, or a delete orphans the table data forever: listDatasets
    // filters on `.json`, so an abandoned .parquet is invisible but never
    // reclaimed. Both paths are built from ids already validated above.
    await fs.promises.rm(datasetFilePath(projectId, id), { force: true });
    await fs.promises.rm(parquetPath(projectId, id), { force: true });
    await fs.promises.rm(sourceParquetPath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
