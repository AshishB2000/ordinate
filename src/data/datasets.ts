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
import { randomUUID } from 'crypto';
import type { ParsedColumn } from './parse';
import { coerceValue } from './parse';
import * as projects from '../app/projects';
import * as parquetStore from '../engine/parquetStore';
import * as queryCache from '../engine/queryCache';
import * as jobs from '../app/jobs';
import { saltForSteps } from '../app/privacyStore';
import * as transforms from './transforms';
import { runResidentPipeline } from '../engine/pipelineDuck';
import type { TableData, TransformStep, ApplyResult } from './transforms';
// The origin whitelist and the id check both moved out; re-exported here so
// `datasets.sanitizeOrigin` and `import type { DatasetOrigin } from './datasets'`
// keep working for every existing caller and test.
import { isValidId } from '../app/ids';
import type { DatasetOrigin } from './datasetOrigin';
import { sanitizeOrigin } from './datasetOrigin';
import { summarize } from './datasetSummary';
import type { DatasetSummary } from './datasetSummary';
import { sanitizeQuality } from '../analysis/qualityRules';
import type { DatasetQuality } from '../analysis/qualityRules';
import type { StepCount } from './stepTypes';
import { loadStepRefs } from './stepRefs';
import { sanitizeInputBlock } from './inputTable/columns';
import type { InputBlock } from './inputTable/columns';
// The record FILE (paths, atomic write, metadata-only writers) moved out at the
// 800-line cap; the writers are re-exported so `datasets.markRefresh` etc. keep
// working for every caller.
import {
  datasetsDir, datasetFilePath, parquetPath, sourceParquetPath, writeJsonAtomic, sanitizeAutoRefresh,
} from './datasetRecord';
export { markRefresh, setAutoRefresh, writeQuality, writeIncremental } from './datasetRecord';
import { sanitizeIncremental } from './incremental';
import type { IncrementalSettings } from './incremental';
// Data snapshots: the refresh hook (keep the table being replaced) and the
// as-of hooks (read a dataset as it was) — each one line at its call site.
import { keepAround, removeAll as removeSnapshots } from './snapshots';
import * as asOf from './asOf';
import { scheduleIndex, removeIndex } from '../engine/dataSearchResident'; // ⌘K's value index
export type { DatasetOrigin } from './datasetOrigin';
export type { DatasetSummary } from './datasetSummary';
export { sanitizeOrigin };

export interface Dataset {
  id: string;
  projectId: string;
  name: string;
  sourceKind: 'csv' | 'json' | 'paste' | 'xlsx' | 'postgres' | 'url' | 'combined' | 'capture' | 'sql' | 'input' | 'parquet' | 'notebook';
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
  /** Rows into and out of each step at the last recompute — the step list's counts. */
  stepCounts?: StepCount[];
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
  /**
   * An unattended refresh schedule. ABSENT means off, which is every dataset
   * written before this existed and every one the user has not opted in.
   *
   * Only a dataset with an `origin` can carry one — there is nothing to re-fetch
   * otherwise — and `sanitizeAutoRefresh` enforces that on every load, so a
   * hand-edited record cannot make the scheduler try.
   *
   * `lastAutoAt` moves on every attempt, WIN OR LOSE, deliberately: a source
   * that is failing must wait its whole interval before trying again rather
   * than retrying every minute. The failure stays visible in
   * lastRefreshStatus/lastRefreshError, which is where the UI reads it.
   */
  autoRefresh?: AutoRefresh;
  /**
   * Data-quality rules and their latest results (src/analysis/qualityRules.ts).
   * Written ONLY through `writeQuality` — metadata-only, never bumps updatedAt.
   */
  quality?: DatasetQuality;
  /** An input table's typed-but-refused cells (src/data/inputTable/columns.ts). */
  input?: InputBlock;
  /** Incremental refresh settings, mark and log (src/data/incremental.ts). Written via writeIncremental. */
  incremental?: IncrementalSettings;
}

export interface AutoRefresh {
  every: AutoRefreshEvery;
  lastAutoAt?: string;
  /**
   * Opt in to anomaly watch. Off by default and stored here rather than in its
   * own block because it only means anything alongside a schedule — there is
   * nothing to watch for if nothing re-runs.
   */
  watch?: boolean;
  /**
   * The anomaly KEYS the last watched run found, so the next one can report only
   * what is new. Capped (anomalyWatch.MAX_KEYS) and sanitized like everything
   * else that comes back off disk.
   */
  lastAnomalyKeys?: string[];
}

export type AutoRefreshEvery = 'hourly' | 'daily' | 'weekly';

const SOURCE_KINDS: ReadonlySet<string> = new Set(['csv', 'json', 'paste', 'xlsx', 'postgres', 'url', 'combined', 'capture', 'sql', 'input', 'parquet', 'notebook']);

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

// Write a dataset's tables to Parquet and its metadata to JSON, or fall back to
// a v2 inline write when DuckDB is unavailable. Parquet first, JSON second: if
// the JSON write fails we are left with a stale parquet and a v2 record that
// still has its rows, and the next load re-migrates over it. The reverse order
// would lose the rows outright.
// ONE write at a time per dataset. The Parquet writes are async now (they run
// on DuckDB's async bridge so a 1M-row save never parks the main thread), and
// two interleaved persists of the same dataset could otherwise publish one
// write's .parquet beside the other's JSON — a rowCount describing the wrong
// table. Chained per id; a failed write does not poison the next one.
const writeChains = new Map<string, Promise<void>>();

// Exported for the input-table store (inputTable/store.ts): an edit replaces the
// base table like a refresh does, but keeps no snapshot — its history is versions.
export async function persist(projectId: string, dataset: Dataset, progress: parquetStore.WriteProgress = {}): Promise<void> {
  asOf.assertWritable(); // an as-of read must never write its past rows back as the present
  const prev = writeChains.get(dataset.id) || Promise.resolve();
  const run = prev.catch(() => { /* the previous write's failure was its caller's */ })
    .then(() => persistNow(projectId, dataset, progress));
  const tail = run.catch(() => { /* reported to this caller below */ });
  writeChains.set(dataset.id, tail);
  void tail.then(() => { if (writeChains.get(dataset.id) === tail) writeChains.delete(dataset.id); });
  return run;
}

async function persistNow(projectId: string, dataset: Dataset, explicit: parquetStore.WriteProgress): Promise<void> {
  // Inside a background job, a write reports to it (as the last 75% of its
  // bar — whatever the job did first, a fetch or a parse, is the first part)
  // and stops on its Cancel, whichever caller several frames up started it.
  const job = jobs.current();
  const progress: parquetStore.WriteProgress = explicit.onProgress || explicit.checkCancelled || !job
    ? explicit
    : { onProgress: (f, note) => job.progress(0.2 + 0.75 * f, note), checkCancelled: () => job.checkCancelled() };
  // Every data write passes through here, so this is the one place the answer
  // cache hears about it (the key's updatedAt would go stale anyway; this also
  // frees the bytes at once and drops answers that JOINED this dataset).
  queryCache.invalidateDataset(dataset.id, projectId);
  const file = datasetFilePath(projectId, dataset.id);
  if (!(await parquetStore.isSupportedAsync())) {
    await writeJsonAtomic(file, dataset); // v2, rows inline
    return;
  }
  // The derived table is the bulk of a first save; the source (when a pipeline
  // exists) is written second and reported as the last stretch.
  const hasSource = Boolean(dataset.source);
  const share = hasSource ? 0.5 : 1;
  await parquetStore.writeTableAsync(parquetPath(projectId, dataset.id), dataset.columns, dataset.rows, {
    checkCancelled: progress.checkCancelled,
    onProgress: progress.onProgress ? (f, note) => progress.onProgress!(f * share, note) : undefined,
  });
  if (dataset.source) {
    await parquetStore.writeTableAsync(
      sourceParquetPath(projectId, dataset.id),
      dataset.source.columns,
      dataset.source.rows,
      {
        checkCancelled: progress.checkCancelled,
        onProgress: progress.onProgress ? (f, note) => progress.onProgress!(0.5 + f * 0.5, note) : undefined,
      },
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
  scheduleIndex({ parquetPath: parquetPath(projectId, dataset.id), columns: dataset.columns }); // save AND refresh land here
}

// Load the tables for a v3 record. Returns false when the data cannot be read —
// the caller must then fail VISIBLY rather than silently yielding an empty
// table, because updateSteps snapshots whatever rows it is handed and an empty
// snapshot would destroy the dataset.
// Async since the jobs work: the scan runs on DuckDB's async bridge, so even a
// 1M-row hydrate (~1.8 s) no longer parks every window while it reads.
async function hydrate(projectId: string, data: any): Promise<boolean> {
  if (Array.isArray(data.rows)) return true; // v2, already inline
  const derived = await parquetStore.readTableAsync(parquetPath(projectId, data.id), data.columns);
  if (!derived) return false;
  data.rows = derived.rows;
  if (data.source && Array.isArray(data.source.columns)) {
    const src = await parquetStore.readTableAsync(
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
  const counts = sanitizeStepCounts(data.stepCounts, steps.length);
  if (counts) ds.stepCounts = counts;
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
  const auto = sanitizeAutoRefresh(data.autoRefresh, Boolean(origin));
  if (auto) ds.autoRefresh = auto;
  if (typeof data.lastRefreshedAt === 'string' && data.lastRefreshedAt) ds.lastRefreshedAt = data.lastRefreshedAt;
  if (data.lastRefreshStatus === 'ok' || data.lastRefreshStatus === 'error') ds.lastRefreshStatus = data.lastRefreshStatus;
  if (typeof data.lastRefreshError === 'string') ds.lastRefreshError = data.lastRefreshError;
  // Re-sanitized on every load, like origin: a hand-edited rule cannot reach SQL.
  const quality = sanitizeQuality(data.quality);
  if (quality) ds.quality = quality;
  const input = kind === 'input' ? sanitizeInputBlock(data.input) : undefined;
  if (input) ds.input = input;
  const incremental = sanitizeIncremental(data.incremental, origin?.kind); // connection origins only
  if (incremental) ds.incremental = incremental;
  return ds;
}

// Stored counts are trusted only when they still line up with the steps.
function sanitizeStepCounts(raw: unknown, n: number): StepCount[] | undefined {
  if (!Array.isArray(raw) || raw.length !== n || n === 0) return undefined;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const out = raw.map((c) => (c && ok(c.before) && ok(c.after) ? { before: c.before, after: c.after } : null));
  return out.every((c) => c !== null) ? (out as StepCount[]) : undefined;
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
      out.push(summarize(normalize(data, projectId)));
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
  const past = await asOf.metaHook(projectId, id); // inside an as-of read: the snapshot's
  if (past !== undefined) return past;
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
  const past = await asOf.residentHook(projectId, id); // inside an as-of read: the snapshot's file
  if (past !== undefined) return past;
  if (!parquetStore.isSupported()) return null;
  const meta = await getDatasetMeta(projectId, id);
  if (!meta || !meta.resident) return null;
  return { parquetPath: parquetPath(projectId, id), columns: meta.columns };
}

export async function getDataset(projectId: string, id: string): Promise<Dataset | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const past = await asOf.datasetHook(projectId, id); // inside an as-of read: the snapshot's rows
  if (past !== undefined) return past;
  try {
    const raw = await fs.promises.readFile(datasetFilePath(projectId, id), 'utf8');
    const data = JSON.parse(raw);
    if (!isValidDataset(data)) return null;
    const wasInline = Array.isArray(data.rows);
    if (!(await hydrate(projectId, data))) return null;
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
  progress: parquetStore.WriteProgress = {},
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
  await persist(projectId, dataset, progress);
  return dataset;
}

// Replace an existing dataset's columns + rows in place (used by a connection
// refresh: re-run the source, overwrite the linked dataset's data, bump
// updatedAt). Preserves id/name/sourceKind/createdAt. Returns null if either id
// is invalid or the dataset does not exist. Rows are capped defensively.
// `outWarnings`, when supplied, collects the warnings applyPipeline produced
// while re-deriving the output. They matter to a REFRESH and to nothing else: if
// the fresh source has lost a column a step references, applyPipeline skips that
// step with a warning, and swallowing it would leave the user with a silently
// shorter pipeline. An out-param rather than a changed return type keeps the two
// existing callers (capture recapture, connection refresh) untouched.
// Overlapping refreshes of ONE dataset run in the order they were ISSUED. The
// write chain in persist() only orders writes by when they reach it, and a
// refresh reaches it after several reads whose timing varies with load (the
// record, the salt, the tables a union / lookup step reads) — so without this
// an earlier, slower refresh could land last and win.
const updateChains = new Map<string, Promise<unknown>>();

export function updateDatasetData(
  projectId: string,
  id: string,
  data: { columns: ParsedColumn[]; rows: (string | number | null)[][] },
  capture?: { entryId: string | null; cropPath: string | null },
  outWarnings?: string[],
  progress: parquetStore.WriteProgress = {},
): Promise<Dataset | null> {
  const prev = updateChains.get(id) || Promise.resolve();
  const run = prev.catch(() => { /* the previous refresh's failure was its caller's */ })
    .then(() => updateDatasetDataNow(projectId, id, data, capture, outWarnings, progress));
  const tail = run.catch(() => { /* reported to this caller */ });
  updateChains.set(id, tail);
  void tail.then(() => { if (updateChains.get(id) === tail) updateChains.delete(id); });
  return run;
}

async function updateDatasetDataNow(
  projectId: string,
  id: string,
  data: { columns: ParsedColumn[]; rows: (string | number | null)[][] },
  capture: { entryId: string | null; cropPath: string | null } | undefined,
  outWarnings: string[] | undefined,
  progress: parquetStore.WriteProgress,
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
    const salt = await saltForSteps(projectId, existing.steps);
    const ctx = { salt, ...(await loadStepRefs(projectId, id, existing.steps)) };
    const output = transforms.applyPipeline(source, existing.steps ?? [], ctx);
    if (outWarnings && Array.isArray(output.warnings)) outWarnings.push(...output.warnings);
    updated = {
      ...existing, source, columns: output.columns, rows: output.rows,
      rowCount: output.rowCount, stepCounts: output.stepCounts, updatedAt: now,
    };
  } else {
    updated = { ...existing, columns: cols, rows, rowCount: rows.length, updatedAt: now };
  }
  // Week 13 — a recapture passes the newest screenshot link, which WINS; without
  // one the `...existing` spread preserves the stored link untouched.
  const cap = sanitizeCapture(capture);
  if (cap) updated.capture = cap;
  await fs.promises.mkdir(datasetsDir(projectId), { recursive: true });
  // The one place a refresh replaces the table: keep the table it replaces.
  await keepAround(projectId, existing, () => persist(projectId, updated, progress));
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
    return { ...old, name, type }; // keeps an input table's required/lookup
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
    const salt = await saltForSteps(projectId, existing.steps);
    const output = transforms.applyPipeline(source, existing.steps ?? [], { salt, ...(await loadStepRefs(projectId, id, existing.steps)) });
    updated = {
      ...existing, source, columns: output.columns, rows: output.rows,
      rowCount: output.rowCount, stepCounts: output.stepCounts, updatedAt: now,
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

  // Resident first: fold the steps over <id>.source.parquet in place. Only
  // possible once a source Parquet exists — on the FIRST edit the source is
  // being snapshotted from memory here and there is no file yet, so that call
  // takes the fold and the file appears on persist.
  //
  // This skips the fold, NOT the read: `existing` above is already hydrated,
  // because persist() rewrites source.parquet from memory and the IPC handler
  // returns the whole dataset (source.rows included) to the renderer. Removing
  // the read means changing both of those contracts — see the PR.
  // A mask step makes sqlGen bail, so a masked pipeline always takes the fold —
  // the only path that holds the salt.
  const residentReady = existing.source !== undefined && parquetStore.isSupported();
  // A union/lookup step reads other datasets: the resident path declines those
  // pipelines, and the fold gets the tables here (src/data/stepRefs.ts).
  const output =
    (residentReady
      ? runResidentPipeline(sourceParquetPath(projectId, id), source.columns, steps)
      : null) ?? transforms.applyPipeline(source, steps, { salt: await saltForSteps(projectId, steps), ...(await loadStepRefs(projectId, id, steps)) });

  const updated: Dataset = {
    ...existing,
    schemaVersion: 2,
    source,
    steps,
    columns: output.columns,
    rows: output.rows,
    rowCount: output.rowCount,
    stepCounts: output.stepCounts,
    updatedAt: new Date().toISOString(),
  };
  await fs.promises.mkdir(datasetsDir(projectId), { recursive: true });
  await persist(projectId, updated);
  return { dataset: updated, output };
}

// Delete a dataset file. Returns true on success (force → missing is success).
export async function deleteDataset(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  queryCache.invalidateDataset(id, projectId);
  try {
    // All three files, or a delete orphans the table data forever: listDatasets
    // filters on `.json`, so an abandoned .parquet is invisible but never
    // reclaimed. Both paths are built from ids already validated above.
    await fs.promises.rm(datasetFilePath(projectId, id), { force: true });
    await fs.promises.rm(parquetPath(projectId, id), { force: true });
    await fs.promises.rm(sourceParquetPath(projectId, id), { force: true });
    await removeSnapshots(projectId, id);
    await removeIndex(parquetPath(projectId, id));
    return true;
  } catch (_) {
    return false;
  }
}
