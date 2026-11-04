// The project DATA MODEL — relationships between datasets. MAIN PROCESS.
//
// A relationship says "rows of FROM find their row of TO where these two columns
// agree". It is a live join, resolved at query time (engine/joinResident.ts),
// never a copy: Combine datasets is the materialised alternative and keeps
// existing for that.
//
// One file per project, `projects/<id>/relationships.json`, the alertStore
// pattern: a missing or corrupt file is an empty model, every record is
// re-sanitized on read, writes are atomic.
//
// CARDINALITY IS A PROMISE ABOUT DIRECTION. `many_to_one` means many FROM rows
// share one TO row, so walking FROM → TO can never repeat a FROM row. Walking
// it backwards could, which is why joinPlan refuses that direction outright.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import { isValidId } from '../app/ids';
import * as queryCache from '../engine/queryCache';
import * as recordFs from '../app/recordFs';
import { logger } from '../app/logger';
import type { KeyStats } from './joinJs';

export type Cardinality = 'many_to_one' | 'one_to_one';
export const CARDINALITIES: readonly Cardinality[] = ['many_to_one', 'one_to_one'];

/** `repeats` = one side's keyed rows minus its distinct keys. Derived when the key is checked; never typed. */
export type RelWarning = { kind: 'repeats'; repeats: number } | { kind: 'not_key'; key: string };

export interface RelEnd {
  datasetId: string;
  column: string;
}

export interface Relationship {
  id: string;
  from: RelEnd;
  to: RelEnd;
  cardinality: Cardinality;
  /** What the user calls this edge ("Order date"), trimmed, 1-60 characters, no control characters. */
  label?: string;
  warning?: RelWarning;
  /** Counted over the FULL tables when the relationship was saved. */
  verified: { matched: number; unmatchedFrom: number };
}

// ponytail: fixed cap; a model this size is already a wall of edges on the canvas
export const MAX_RELATIONSHIPS = 200;

function sanitizeEnd(raw: unknown): RelEnd | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (!isValidId(o.datasetId)) return null;
  if (typeof o.column !== 'string' || o.column === '' || o.column.length > 500) return null;
  return { datasetId: o.datasetId, column: o.column };
}

function sanitizeLabel(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.length >= 1 && s.length <= 60 && !/\p{Cc}/u.test(s) ? s : undefined;
}

function sanitizeWarning(raw: unknown): RelWarning | undefined {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return undefined;
  if (o.kind === 'repeats') return Number.isSafeInteger(o.repeats) && (o.repeats as number) >= 0 ? { kind: 'repeats', repeats: o.repeats as number } : undefined;
  if (o.kind === 'not_key') return typeof o.key === 'string' && o.key !== '' && o.key.length <= 500 ? { kind: 'not_key', key: o.key } : undefined;
  return undefined;
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Whitelist one record. A self-join or a malformed end is refused, not repaired. */
export function sanitizeRelationship(raw: unknown): Relationship | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const from = sanitizeEnd(o.from);
  const to = sanitizeEnd(o.to);
  if (!from || !to || from.datasetId === to.datasetId) return null;
  const cardinality = CARDINALITIES.includes(o.cardinality as Cardinality)
    ? (o.cardinality as Cardinality)
    : 'many_to_one';
  const v = (o.verified || {}) as Record<string, unknown>;
  const label = sanitizeLabel(o.label);
  const warning = sanitizeWarning(o.warning);
  return {
    id: isValidId(o.id) ? o.id : randomUUID(),
    from,
    to,
    cardinality,
    ...(label !== undefined && { label }),
    ...(warning !== undefined && { warning }),
    verified: { matched: count(v.matched), unmatchedFrom: count(v.unmatchedFrom) },
  };
}

/**
 * What is wrong with the TO column as the "one" side, from a full-table count: `not_key` when the dataset's
 * declared key is another column (`declaredKey` '' = none declared), else `repeats` (keyed rows minus distinct keys)
 * when the column repeats. Nothing when it is the key, or unique.
 */
export function relWarning(stats: KeyStats, declaredKey: string, toColumn: string): RelWarning | undefined {
  if (declaredKey !== '' && declaredKey !== toColumn) return { kind: 'not_key', key: declaredKey };
  return stats.toKeys !== stats.toKeyed ? { kind: 'repeats', repeats: stats.toKeyed - stats.toKeys } : undefined;
}

/** Same two datasets on the same two columns, in either direction. */
export function sameEdge(a: Relationship, b: { from: RelEnd; to: RelEnd }): boolean {
  const eq = (x: RelEnd, y: RelEnd): boolean => x.datasetId === y.datasetId && x.column === y.column;
  return (eq(a.from, b.from) && eq(a.to, b.to)) || (eq(a.from, b.to) && eq(a.to, b.from));
}

/**
 * The label another relationship between the same two datasets (either direction) already has, ignoring
 * case, or null. The same edge is no clash: a save replaces it.
 */
export function labelClash(list: Relationship[], rel: Relationship): string | null {
  const name = rel.label?.toLowerCase();
  if (!name) return null;
  const pair = (r: Relationship): string => [r.from.datasetId, r.to.datasetId].sort().join();
  return list.find((r) => r.id !== rel.id && !sameEdge(r, rel) && pair(r) === pair(rel) && r.label?.toLowerCase() === name)?.label ?? null;
}

// ── Disk ─────────────────────────────────────────────────────────────────────

function modelFile(projectId: string): string {
  return path.join(appPaths.userData(), 'projects', projectId, 'relationships.json');
}

export async function listRelationships(projectId: string): Promise<Relationship[]> {
  if (!isValidId(projectId)) return [];
  let raw: any;
  try {
    raw = JSON.parse(await recordFs.readFile(modelFile(projectId), 'utf8'));
  } catch (_) {
    return []; // missing, unreadable or corrupt — never fatal
  }
  const out: Relationship[] = [];
  for (const r of Array.isArray(raw?.relationships) ? raw.relationships : []) {
    const clean = sanitizeRelationship(r);
    if (clean && !out.some((x) => x.id === clean.id)) out.push(clean);
    if (out.length >= MAX_RELATIONSHIPS) break;
  }
  return out;
}

async function writeAll(projectId: string, list: Relationship[]): Promise<boolean> {
  try {
    const file = modelFile(projectId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + randomUUID() + '.tmp';
    await recordFs.writeFile(tmp, JSON.stringify({ schemaVersion: 1, relationships: list }, null, 2), 'utf8');
    await recordFs.rename(tmp, file);
    // A joined chart or KPI read through the old edges; drop the project's answers.
    queryCache.invalidateProject(projectId);
    return true;
  } catch (err: any) {
    logger.error('[relationships] Could not write relationships.json:', err && err.message);
    return false;
  }
}

/**
 * Every write to relationships.json: read, change and write under one lock (`recordFs.locked`, every pod), so a
 * person's save and the re-check after a refresh cannot lose each other's edit. `fn` returns the new list — the same
 * array to change nothing, which writes nothing — and may be async (it holds the lock meanwhile: keep it short).
 * False when the write failed.
 */
export async function updateRelationships(projectId: string, fn: (list: Relationship[]) => Relationship[] | Promise<Relationship[]>): Promise<boolean> {
  if (!isValidId(projectId)) return false;
  return recordFs.locked(modelFile(projectId), async () => {
    const list = await listRelationships(projectId);
    const next = await fn(list);
    return next === list ? true : writeAll(projectId, next);
  });
}

/**
 * Create, or replace IN PLACE: by id, else the same edge (which keeps that entry's id). "The first
 * relationship" is the default a chart joins through, so a re-save must not move it. A second edge
 * between the same two columns replaces the first rather than stacking a duplicate.
 */
export async function saveRelationship(projectId: string, raw: unknown): Promise<Relationship | null> {
  const parsed = sanitizeRelationship(raw);
  if (!parsed) return null;
  let saved: Relationship | null = null;
  const written = await updateRelationships(projectId, (list) => {
    const old = list.find((r) => r.id === parsed.id) ?? list.find((r) => sameEdge(r, parsed));
    // A save without a label (every release-1 save) keeps the same edge's own; a changed edge does not. Never the
    // warning: it is derived, and the release that writes it recomputes it (absent once the edge no longer warns).
    // An empty label that IS sent clears it (Rename to nothing).
    const same = old && sameEdge(old, parsed) && !(raw && typeof raw === 'object' && 'label' in raw) ? old : null;
    const rel = old ? { ...parsed, id: old.id, ...(same && same.label !== undefined && { label: same.label }) } : parsed;
    const next = (old ? list.map((r) => (r === old ? rel : r)) : [...list, rel]).filter((r) => r === rel || (r.id !== rel.id && !sameEdge(r, rel)));
    if (next.length > MAX_RELATIONSHIPS) return list;
    saved = rel;
    return next;
  });
  return written ? saved : null;
}

export async function deleteRelationship(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  let found = false;
  const written = await updateRelationships(projectId, (list) => {
    const next = list.filter((r) => r.id !== id);
    found = next.length !== list.length;
    return found ? next : list;
  });
  return written && found;
}
