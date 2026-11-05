// A Live dataset's record and its safety net (docs/live-data/00-plan.md L2.1,
// D2, D5, D6) — MAIN PROCESS ONLY.
//
// A Live dataset stores SCHEMA ONLY: its columns, declared from the
// warehouse's own types, its connection origin, and the `live` block below.
// There is no Parquet and no 1M-row cap — a question goes to the warehouse
// (compile → bind → cache, L2.2–L2.4) and comes back aggregated.
//
// `mode` lives in the record (absent = 'extract', so every record written
// before this reads as it always did) and needs no SQL migration.
//
// THE SAFETY NET (D6). Every reader not yet routed to the warehouse would,
// handed a Live dataset, find zero rows and compute a confident zero. So
// `datasets.getDataset` throws `LiveDatasetError` instead, and the RPC route
// answers it as a typed refusal (409 `live_dataset`) with the catalog's
// sentence. A metadata path (list, columns, catalog, lineage, trash, versions,
// bundles) never hydrates, so it never meets the throw; a path that walks
// every dataset to read rows skips a Live one (`isLive`) rather than fail the
// whole walk.

import type { ParsedColumn } from './parse';
import { isValidId } from '../app/ids';
import { datasetFilePath, serialized } from './datasetRecord';
import { liveRefusedMessage } from './liveMessages';
import type { LiveProfile } from './liveProfile';
import { sanitizeMissing, sanitizeProfile, sanitizeStamp } from './liveProfile';
import { sanitizeBaseFilters } from './liveBaseFilters';
import type { LiveCalc } from './liveCalcs';
import { sanitizeLiveCalcs } from './liveCalcs';
import type { FilterStep } from './transforms';

export type DatasetMode = 'extract' | 'live';

/** The `live` block of a record (plan D5). */
export interface LiveSettings {
  /** How old a cached warehouse answer may be before it is asked again. 0 = always ask. */
  maxCacheAgeSec: number;
  /** Bumped by "Refresh" (and the refresh URL): every cache key carries it, so every pod sees the reset. */
  epoch: number;
  /** When the columns were last read from the warehouse — also part of the cache key. */
  schemaSyncedAt: string;
  /** What the last schema sync learned from one sampled query (L2.5, ./liveProfile.ts). */
  profile?: LiveProfile;
  /** Columns the warehouse no longer has that a chart, KPI or metric still names (L2.5). */
  missingColumns?: string[];
  /** When the scheduler last started a daily sync — a failing warehouse is retried hourly, not every tick. */
  syncAttemptAt?: string;
  /**
   * Plain filter steps every question must carry (./liveBaseFilters). IN MEMORY ONLY: stored at the
   * record's top level beside `rowPolicy` and filled by `applyLive`, never by `sanitizeLive`, so no
   * writer that rebuilds `raw.live` can erase it. A pod that cannot apply them refuses (liveTarget).
   */
  baseFilters?: FilterStep[];
  /**
   * The stored list held something `sanitizeBaseFilters` dropped (an unknown operator, a non-object, a step
   * past the cap). In memory only, set by `applyLive`. Answering with part of a list is as wrong as with
   * none of it, so the guard refuses on it just as on `baseFilters` (./liveBaseFilters `hasBaseFilters`).
   */
  baseFiltersUnreadable?: true;
  /**
   * Calculated fields (./liveCalcs), stored at the record's top level like `baseFilters` and filled by `applyLive`, in
   * memory only. NOT in `Dataset.columns`: this pod cannot compute them, so it refuses every question instead (liveTarget).
   */
  calculated?: LiveCalc[];
  /** The stored list held something `sanitizeLiveCalcs` dropped, or was no list. In memory only; refused like `calculated` (`hasLiveCalcs`). */
  calculatedUnreadable?: true;
  /** The record has a top-level `semantic` key (part 7 b2 writes it): it asks another tool's semantic layer, which this pod cannot. In memory only; every question refuses (liveTarget). */
  semanticPending?: true;
}

/** 5 minutes (open question 1 in the plan; Omni's 6 h leans staler). A constant, not an env var. */
export const DEFAULT_MAX_CACHE_AGE_SEC = 300;
/** 30 days — the longest a cached answer may be kept (Omni's ceiling). */
export const MAX_CACHE_AGE_SEC = 30 * 24 * 60 * 60;

/** The code a refusal travels under: the RPC route's 409 body, and what a client switches on. */
export const LIVE_DATASET_CODE = 'live_dataset';

let raised = 0;

/** Thrown by `datasets.getDataset` (and `requireExtract`) on a Live dataset. Never caught to become an empty result. */
export class LiveDatasetError extends Error {
  readonly code = LIVE_DATASET_CODE;
  readonly datasetId: string;
  constructor(datasetId: string) {
    super(liveRefusedMessage());
    this.name = 'LiveDatasetError';
    this.datasetId = datasetId;
    raised++;
  }
}

/** How many refusals this process has raised — the RPC route walks a reply for them only when this moved. */
export function liveRefusalsRaised(): number {
  return raised;
}

/** True for a LiveDatasetError — by class, or by name and code when it crossed a module copy. */
export function isLiveDatasetError(err: unknown): err is LiveDatasetError {
  if (err instanceof LiveDatasetError) return true;
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && typeof e === 'object' && e.name === 'LiveDatasetError' && e.code === LIVE_DATASET_CODE;
}

/** The refusal as a reply, for a handler whose contract answers `{ok:false, error}`. */
export function liveRefusal(): { ok: false; code: typeof LIVE_DATASET_CODE; error: string } {
  return { ok: false, code: LIVE_DATASET_CODE, error: liveRefusedMessage() };
}

/**
 * Type the refusals inside a handler's reply. Most handlers catch what they
 * call and answer `{ok:false, error: err.message}` (137 such sites), and a
 * batch (a dashboard's tiles) answers per item — one Live tile must not fail
 * the page. So the RPC route walks the reply (objects and arrays, a few levels
 * deep) and marks every `{ok:false}` whose error IS the refusal with the code.
 * The sentence comes from one place (LiveDatasetError), so equality is exact.
 * Mutates and returns `reply`.
 */
export function tagLiveRefusals<T>(reply: T, depth = 3): T {
  tagWalk(reply, depth, liveRefusedMessage());
  return reply;
}

function tagWalk(v: unknown, depth: number, sentence: string): void {
  // Bytes (a file's content) are never a reply envelope; a Map or a Date has no own values to walk.
  if (depth < 0 || !v || typeof v !== 'object' || ArrayBuffer.isView(v)) return;
  if (Array.isArray(v)) {
    for (const item of v) tagWalk(item, depth - 1, sentence);
    return;
  }
  const o = v as Record<string, unknown>;
  if (o.ok === false && o.code === undefined && (o.error === sentence || o.reason === sentence)) o.code = LIVE_DATASET_CODE;
  for (const x of Object.values(o)) if (x && typeof x === 'object') tagWalk(x, depth - 1, sentence);
}

/** Is this handler reply the refusal — typed already, or carrying the refusal's sentence? */
export function isLiveRefusalReply(r: unknown): boolean {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return o.ok === false && (o.code === LIVE_DATASET_CODE || o.error === liveRefusedMessage() || o.reason === liveRefusedMessage());
}

/** Is this record (raw JSON, a Dataset, its meta or its summary) Live? */
export function isLive(rec: { mode?: unknown } | null | undefined): boolean {
  return !!rec && rec.mode === 'live';
}

/** Throw the typed refusal when `rec` is Live — the guard for a reader that does not go through getDataset. */
export function requireExtract(rec: { id?: unknown; mode?: unknown } | null | undefined): void {
  if (isLive(rec)) throw new LiveDatasetError(typeof rec?.id === 'string' ? rec.id : '');
}

/**
 * A stored cache age, made safe: an integer within 0 – 30 days. Clamped, not
 * refused — a hand-edited record must still load; the API refuses out-of-range
 * input before it gets here (`parseMaxCacheAge`). Anything not a number reads
 * as the default.
 */
export function sanitizeMaxCacheAge(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_CACHE_AGE_SEC;
  return Math.min(MAX_CACHE_AGE_SEC, Math.max(0, Math.floor(raw)));
}

/** A cache age from a request: the integer, or null when out of range (refused, never clamped). */
export function parseMaxCacheAge(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_MAX_CACHE_AGE_SEC;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_CACHE_AGE_SEC) return null;
  return raw;
}

/** A stored epoch: a non-negative safe integer, else 0 (a fresh cache — the safe direction). */
export function sanitizeEpoch(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * The `live` block of an untrusted record, or undefined when the record is not
 * Live. `mode: 'live'` alone decides: a Live record whose block is damaged is
 * repaired to defaults, never read as an extract — an extract with no table
 * would be exactly the silent zero this file exists to prevent.
 */
export function sanitizeLive(data: { mode?: unknown; live?: unknown; updatedAt?: unknown }): LiveSettings | undefined {
  if (data.mode !== 'live') return undefined;
  const o = data.live && typeof data.live === 'object' ? (data.live as Record<string, unknown>) : {};
  const synced = typeof o.schemaSyncedAt === 'string' && Number.isFinite(Date.parse(o.schemaSyncedAt)) ? o.schemaSyncedAt
    : typeof data.updatedAt === 'string' ? data.updatedAt : new Date(0).toISOString();
  const live: LiveSettings = { maxCacheAgeSec: sanitizeMaxCacheAge(o.maxCacheAgeSec), epoch: sanitizeEpoch(o.epoch), schemaSyncedAt: synced };
  const profile = sanitizeProfile(o.profile);
  const missing = sanitizeMissing(o.missingColumns);
  const attempt = sanitizeStamp(o.syncAttemptAt);
  if (profile) live.profile = profile;
  if (missing) live.missingColumns = missing;
  if (attempt) live.syncAttemptAt = attempt;
  return live;
}

/**
 * Carry `mode` and `live` from a raw record onto its normalized form
 * (datasets.normalize). Extract keeps neither key. A Live record keeps no
 * refresh schedule and no incremental mark either — nothing is copied, so
 * nothing is re-fetched; its cache age is its schedule — so a hand-edited
 * one can never put a Live dataset on the scheduler's queue (5 / 15 min or any).
 */
export function applyLive(
  target: { mode?: DatasetMode; live?: LiveSettings; autoRefresh?: unknown; incremental?: unknown },
  data: { mode?: unknown; live?: unknown; updatedAt?: unknown; baseFilters?: unknown; calculated?: unknown; semantic?: unknown },
): void {
  const live = sanitizeLive(data);
  if (!live) return;
  if ('semantic' in data) live.semanticPending = true; // of any value: b2 replaces this presence check with the real reader
  const baseFilters = sanitizeBaseFilters(data.baseFilters);
  if (baseFilters.length) live.baseFilters = baseFilters;
  // A stored list is read in full or the dataset answers nothing: a dropped step, or a stored value that is no list, must never read as "no step".
  const stored = data.baseFilters;
  if (stored != null && (!Array.isArray(stored) || stored.length !== baseFilters.length)) live.baseFiltersUnreadable = true;
  const calculated = sanitizeLiveCalcs(data.calculated);
  if (calculated.length) live.calculated = calculated;
  // Same rule: a calc this pod cannot read in full must never read as "no calcs".
  const storedCalcs = data.calculated;
  if (storedCalcs != null && (!Array.isArray(storedCalcs) || storedCalcs.length !== calculated.length)) live.calculatedUnreadable = true;
  target.mode = 'live';
  target.live = live;
  delete target.autoRefresh;
  delete target.incremental;
}

/** A new Live record's block. */
export function newLiveSettings(maxCacheAgeSec: number = DEFAULT_MAX_CACHE_AGE_SEC, now = new Date().toISOString()): LiveSettings {
  return { maxCacheAgeSec: sanitizeMaxCacheAge(maxCacheAgeSec), epoch: 0, schemaSyncedAt: now };
}

/** The columns a Live record stores — names and declared types, nothing a value decided. */
export function liveColumnsOf(columns: ParsedColumn[]): ParsedColumn[] {
  return columns.map((c) => ({ name: c.name, type: c.type }));
}

/**
 * Reset a Live dataset's cache: bump `epoch` in the record. METADATA ONLY — a
 * read-modify-write of the record's JSON, serialized with the other metadata
 * writers, never a table. Every pod reads the record, so every pod's cache key
 * moves at once (plan D5). Resolves with the new block, or false when the record
 * is missing or not Live.
 */
export function bumpEpoch(projectId: string, id: string): Promise<LiveSettings | false> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(false);
  return serialized(datasetFilePath(projectId, id), (raw) => {
    const live = sanitizeLive(raw);
    if (!live) return false;
    const next: LiveSettings = { ...live, epoch: live.epoch + 1 };
    raw.live = next;
    return next;
  }).then((r) => r || false);
}

/** Set the cache age of a Live dataset (metadata only). False when not Live. */
export function setMaxCacheAge(projectId: string, id: string, maxCacheAgeSec: number): Promise<LiveSettings | false> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(false);
  return serialized(datasetFilePath(projectId, id), (raw) => {
    const live = sanitizeLive(raw);
    if (!live) return false;
    const next: LiveSettings = { ...live, maxCacheAgeSec: sanitizeMaxCacheAge(maxCacheAgeSec) };
    raw.live = next;
    return next;
  }).then((r) => r || false);
}

/** A profile without its sampled figures: the column names and the warehouse's type names (the compiler reads those). */
export function unsampled(profile: LiveProfile): LiveProfile {
  return { columns: profile.columns.map(({ name, sourceType }) => (sourceType ? { name, sourceType } : { name })) };
}

/**
 * Set a Live dataset's base filters (./liveBaseFilters): the top-level key (`[]` deletes it) and an epoch
 * bump, in ONE write (D5). The validated steps are stored as given; `applyLive` reads them. The sampled
 * figures go in the same write — they were read under the old filters, and a value picker must never offer
 * a value the new ones exclude — so pickers say "not sampled yet" until the caller's queued sync lands.
 * False when the record is missing or not Live.
 */
export function setBaseFilters(projectId: string, id: string, steps: FilterStep[]): Promise<LiveSettings | false> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(false);
  return serialized(datasetFilePath(projectId, id), (raw) => {
    const live = sanitizeLive(raw);
    if (!live) return false;
    if (steps.length) raw.baseFilters = steps;
    else delete raw.baseFilters;
    const next: LiveSettings = { ...live, epoch: live.epoch + 1 };
    if (live.profile) next.profile = unsampled(live.profile);
    raw.live = next;
    return next;
  }).then((r) => r || false);
}

/** What a schema sync writes (L2.5, src/engine/live/schemaSync.ts). */
export interface SchemaSyncWrite {
  columns: ParsedColumn[];
  profile: LiveProfile;
  missingColumns: string[];
  syncedAt: string;
  /** The columns themselves changed (added, removed, retyped): the dataset's `updatedAt` moves too. */
  changed: boolean;
  /**
   * The base filters the sample was read under. When the record's differ by the time of the write
   * (an editor changed them during the sync), the figures are not stored: they describe rows the new
   * filters may exclude. Absent: not checked.
   */
  sampledUnder?: FilterStep[];
}

/**
 * Land a schema sync: the warehouse's columns, the profile, the missing list
 * and the new `schemaSyncedAt` — ONE read-modify-write of the record, so the
 * columns and the cache key move together (a question compiled against the old
 * columns can only ever be cached under the old key). False when the record is
 * missing or no longer Live.
 */
export function writeSchemaSync(projectId: string, id: string, w: SchemaSyncWrite): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(false);
  return serialized(datasetFilePath(projectId, id), (raw) => {
    const live = sanitizeLive(raw);
    if (!live) return false;
    const profile = sanitizeProfile(w.profile) ?? { columns: [] };
    const moved = w.sampledUnder !== undefined && JSON.stringify(sanitizeBaseFilters(raw.baseFilters)) !== JSON.stringify(w.sampledUnder);
    const next: LiveSettings = { ...live, schemaSyncedAt: w.syncedAt, profile: moved ? unsampled(profile) : profile };
    if (w.missingColumns.length) next.missingColumns = w.missingColumns;
    else delete next.missingColumns;
    raw.columns = liveColumnsOf(w.columns);
    raw.live = next;
    if (w.changed) raw.updatedAt = w.syncedAt;
    return true;
  }).then((r) => r === true);
}

/** Stamp a scheduled sync's start (win or lose), so a failing warehouse is not asked again every tick. */
export function stampSyncAttempt(projectId: string, id: string, at: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(false);
  return serialized(datasetFilePath(projectId, id), (raw) => {
    const live = sanitizeLive(raw);
    if (!live) return false;
    raw.live = { ...live, syncAttemptAt: at };
    return true;
  }).then((r) => r === true);
}
