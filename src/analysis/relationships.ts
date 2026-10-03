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

export type Cardinality = 'many_to_one' | 'one_to_one';
export const CARDINALITIES: readonly Cardinality[] = ['many_to_one', 'one_to_one'];

export interface RelEnd {
  datasetId: string;
  column: string;
}

export interface Relationship {
  id: string;
  from: RelEnd;
  to: RelEnd;
  cardinality: Cardinality;
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
  return {
    id: isValidId(o.id) ? o.id : randomUUID(),
    from,
    to,
    cardinality,
    verified: { matched: count(v.matched), unmatchedFrom: count(v.unmatchedFrom) },
  };
}

/** Same two datasets on the same two columns, in either direction. */
export function sameEdge(a: Relationship, b: { from: RelEnd; to: RelEnd }): boolean {
  const eq = (x: RelEnd, y: RelEnd): boolean => x.datasetId === y.datasetId && x.column === y.column;
  return (eq(a.from, b.from) && eq(a.to, b.to)) || (eq(a.from, b.to) && eq(a.to, b.from));
}

// ── Disk ─────────────────────────────────────────────────────────────────────

function modelFile(projectId: string): string {
  return path.join(appPaths.userData(), 'projects', projectId, 'relationships.json');
}

export async function listRelationships(projectId: string): Promise<Relationship[]> {
  if (!isValidId(projectId)) return [];
  let raw: any;
  try {
    raw = JSON.parse(await fs.promises.readFile(modelFile(projectId), 'utf8'));
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
    await fs.promises.writeFile(tmp, JSON.stringify({ schemaVersion: 1, relationships: list }, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
    // A joined chart or KPI read through the old edges; drop the project's answers.
    queryCache.invalidateProject(projectId);
    return true;
  } catch (err: any) {
    console.error('[relationships] Could not write relationships.json:', err && err.message);
    return false;
  }
}

/**
 * Create, or replace by id. A second edge between the same two columns replaces
 * the first rather than stacking a duplicate the canvas would draw twice.
 */
export async function saveRelationship(projectId: string, raw: unknown): Promise<Relationship | null> {
  if (!isValidId(projectId)) return null;
  const rel = sanitizeRelationship(raw);
  if (!rel) return null;
  const list = (await listRelationships(projectId)).filter((r) => r.id !== rel.id && !sameEdge(r, rel));
  if (list.length >= MAX_RELATIONSHIPS) return null;
  list.push(rel);
  return (await writeAll(projectId, list)) ? rel : null;
}

export async function deleteRelationship(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  const list = await listRelationships(projectId);
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  return writeAll(projectId, next);
}
