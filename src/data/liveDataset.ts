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

export type DatasetMode = 'extract' | 'live';

/** The `live` block of a record (plan D5). */
export interface LiveSettings {
  /** How old a cached warehouse answer may be before it is asked again. 0 = always ask. */
  maxCacheAgeSec: number;
  /** Bumped by "Refresh" (and the refresh URL): every cache key carries it, so every pod sees the reset. */
  epoch: number;
  /** When the columns were last read from the warehouse — also part of the cache key. */
  schemaSyncedAt: string;
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
  return { maxCacheAgeSec: sanitizeMaxCacheAge(o.maxCacheAgeSec), epoch: sanitizeEpoch(o.epoch), schemaSyncedAt: synced };
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
  data: { mode?: unknown; live?: unknown; updatedAt?: unknown },
): void {
  const live = sanitizeLive(data);
  if (!live) return;
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
