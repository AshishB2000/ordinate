// The answer cache for aggregates, metrics, pivots and insights — MAIN PROCESS.
//
// A dashboard open asks the same questions every time: six tiles, six
// aggregates over data that has not changed since the last open. Each one is
// cheap off Parquet (~6 ms) and dear off a hydrated table (~1 s), but none of
// them is free, and a warm open should cost nothing but the paint.
//
// ── THE KEY ──────────────────────────────────────────────────────────────────
// (op, datasetId, updatedAt, pipelineHash, spec). `updatedAt` moves on every
// write that can change the data (datasets.ts persist), and `pipelineHash`
// covers the prepare steps, so a key cannot outlive the data it describes even
// if an invalidation were missed. `spec` is everything else the answer depends
// on — encoding, filters, parameter values — stringified with SORTED keys, so
// two renderers building the same object in a different key order share an
// entry.
//
// ── INVALIDATION ─────────────────────────────────────────────────────────────
// Belt and braces: the key already goes stale on a write, and
// `invalidateDataset` (called from datasets.ts on EVERY persist and delete)
// also drops the entries at once so dead answers do not sit on the byte budget.
// An entry lists the datasets it DEPENDS on — its own, plus any related
// dataset a join read — and a write to any of them drops it.
//
// ── EVICTION ─────────────────────────────────────────────────────────────────
// LRU by BYTES, not by count: one pivot grid can outweigh a thousand KPI
// numbers. The budget is 64 MB of serialized JSON. A Map iterates in insertion
// order, so "touch" is delete-then-set and the oldest entry is the first key.
// A single answer larger than a quarter of the budget is not cached at all —
// it would evict everything else to make room for one entry.

import { createHash } from 'crypto';
import * as trace from './residentTrace';

export type CacheOp = 'aggregate' | 'pivot' | 'metric' | 'insights';

export const MAX_BYTES = 64 * 1024 * 1024;

interface Entry {
  value: unknown;
  bytes: number;
  deps: string[];
}

const entries = new Map<string, Entry>();
let totalBytes = 0;
let budget = MAX_BYTES;

/** JSON with object keys sorted at every depth — the spec half of the key. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

/** A short digest of a dataset's prepare steps. Order matters; key order does not. */
export function pipelineHash(steps: unknown): string {
  return createHash('sha1').update(stableStringify(Array.isArray(steps) ? steps : [])).digest('hex').slice(0, 16);
}

export interface KeyParts {
  datasetId: string;
  updatedAt: string;
  pipelineHash: string;
}

export function cacheKey(op: CacheOp, parts: KeyParts, spec: unknown): string {
  return [op, parts.datasetId, parts.updatedAt, parts.pipelineHash, stableStringify(spec)].join('\u0000');
}

/** The cached answer, or undefined. Counts a hit or a miss under `cache:<op>`. */
export function get<T>(op: CacheOp, key: string): T | undefined {
  const e = entries.get(key);
  if (!e) {
    trace.recordCache(op, 'miss');
    return undefined;
  }
  // Touch: move to the young end.
  entries.delete(key);
  entries.set(key, e);
  trace.recordCache(op, 'hit');
  // A copy: callers decorate replies (the period overlay adds a series), and a
  // mutated cache entry would be a wrong answer served to the NEXT caller.
  return structuredClone(e.value) as T;
}

/**
 * Store an answer. `deps` are the dataset ids whose write must drop it (the
 * key's own dataset is always included). Returns whether it was kept.
 */
export function set(key: string, value: unknown, deps: string[]): boolean {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  } catch (_) {
    return false; // a cycle or a BigInt: not an answer we can size, so not cached
  }
  if (bytes > budget / 4) return false;
  const old = entries.get(key);
  if (old) {
    totalBytes -= old.bytes;
    entries.delete(key);
  }
  entries.set(key, { value: structuredClone(value), bytes, deps: [...new Set(deps.filter(Boolean))] });
  totalBytes += bytes;
  while (totalBytes > budget) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    drop(oldest.value);
  }
  return true;
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * Look up `key`; on a miss run `compute` ONCE however many callers ask at the
 * same moment (a dashboard repaint fires the same tile twice; Home asks for a
 * dataset's insights from two cards), and keep the answer when `keep` says so.
 * Every caller gets its own copy.
 */
export async function through<T>(
  op: CacheOp,
  key: string,
  deps: string[],
  compute: () => Promise<T>,
  keep: (value: T) => boolean = (v) => v !== null && v !== undefined,
): Promise<T> {
  const hit = get<T>(op, key);
  if (hit !== undefined) return hit;
  let p = inflight.get(key) as Promise<T> | undefined;
  const owner = !p;
  if (!p) {
    p = compute();
    inflight.set(key, p);
  }
  try {
    const value = await p;
    if (owner && keep(value)) set(key, value, deps);
    return owner ? value : structuredClone(value);
  } finally {
    if (owner) inflight.delete(key);
  }
}

/**
 * Memoise one computation. A `null`/`undefined` answer is NOT cached — every
 * resident path uses null for "could not answer", and caching that would pin
 * a transient failure.
 */
export async function memo<T>(
  op: CacheOp,
  parts: KeyParts,
  spec: unknown,
  compute: () => Promise<T>,
  extraDeps: string[] = [],
): Promise<T> {
  return through(op, cacheKey(op, parts, spec), [parts.datasetId, ...extraDeps], compute);
}

/** The dependency tag an answer carries when it may read ANY dataset of its project. */
export function projectDep(projectId: string): string {
  return 'project:' + projectId;
}

/**
 * Drop every entry that depends on this dataset — and, given its project, every
 * entry that may have read it indirectly (a join through a relationship, a
 * map's boundaries). Called on every dataset write and delete.
 *
 * ponytail: project-wide is coarse — a refresh of one dataset drops its
 * siblings' answers too. Writes are rare next to reads, and a precise join
 * graph here would be a second copy of relationships.ts to keep in step.
 */
export function invalidateDataset(datasetId: string, projectId?: string): number {
  const tags = projectId ? [datasetId, projectDep(projectId)] : [datasetId];
  let n = 0;
  // Deleting the current entry while iterating a Map is safe by spec.
  for (const [key, e] of entries) {
    if (e.deps.some((d) => tags.includes(d))) {
      drop(key);
      n++;
    }
  }
  return n;
}

/** Drop a whole project's answers — a relationship, boundary or trash change. */
export function invalidateProject(projectId: string): number {
  const tag = projectDep(projectId);
  let n = 0;
  for (const [key, e] of entries) {
    if (e.deps.includes(tag)) {
      drop(key);
      n++;
    }
  }
  return n;
}

export function clear(): void {
  entries.clear();
  inflight.clear();
  totalBytes = 0;
}

export function stats(): { entries: number; bytes: number; maxBytes: number } {
  return { entries: entries.size, bytes: totalBytes, maxBytes: budget };
}

/** Test hook: shrink the budget so eviction can be exercised without 64 MB. */
export function setBudgetForTest(bytes: number): void {
  budget = bytes;
  while (totalBytes > budget) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    drop(oldest.value);
  }
}

function drop(key: string): void {
  const e = entries.get(key);
  if (!e) return;
  totalBytes -= e.bytes;
  entries.delete(key);
}
