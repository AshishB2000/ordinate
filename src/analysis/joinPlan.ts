// Which datasets a visual may reach, and the ONE join chain that reaches them.
// PURE — no fs, no SQL. MAIN PROCESS.
//
// The rule that makes a cross-dataset measure safe: every hop walks a
// relationship FROM its many side TO its one side (or across a one-to-one), so
// no row of the primary dataset is ever repeated. The reverse direction would
// repeat primary rows once per match and inflate every measure on them — the
// planner REFUSES it with a sentence saying which relationship is in the way,
// rather than quietly producing a bigger number.
//
// A joined table's columns are laid out positionally, primary first, so the
// resident SQL helpers (which address `c0..cN` over one relation) and the JS
// reference (which addresses names over one table) both see ONE table.

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type { Relationship } from './relationships';
import type { VizEncoding } from './visuals';

export interface Hop {
  relId: string;
  /** The side already in the chain. */
  from: { datasetId: string; column: string };
  /** The side this hop adds. */
  to: { datasetId: string; column: string };
}

export interface DsInfo {
  id: string;
  name: string;
  columns: ParsedColumn[];
}

export interface JoinPlan {
  /** [0] is the primary dataset and has no `via`. */
  tables: { datasetId: string; via: Hop | null }[];
}

export interface JoinLayout {
  /** Primary columns under their own names, then each joined table's as "Dataset.column". */
  columns: ParsedColumn[];
  /** Merged column index → table index. */
  tableOf: number[];
  /** Merged column index → column index inside its own table. */
  srcIndex: number[];
  /** First merged index of each table. */
  offsets: number[];
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Edges walkable from `ds` without repeating a row of `ds`. */
function walks(rels: Relationship[], ds: string): Hop[] {
  const out: Hop[] = [];
  for (const r of rels) {
    if (r.from.datasetId === ds) out.push({ relId: r.id, from: r.from, to: r.to });
    else if (r.to.datasetId === ds && r.cardinality === 'one_to_one') out.push({ relId: r.id, from: r.to, to: r.from });
  }
  return out;
}

/**
 * Every dataset reachable from `primary` by safe hops, in BREADTH-FIRST order,
 * each with the shortest hop path to it. The order is load-bearing: a filter
 * naming a column the primary lacks resolves to the NEAREST dataset that has it.
 */
export function reachable(primary: string, rels: Relationship[]): Map<string, Hop[]> {
  const paths = new Map<string, Hop[]>([[primary, []]]);
  const queue = [primary];
  while (queue.length) {
    const ds = queue.shift() as string;
    for (const h of walks(rels, ds)) {
      if (paths.has(h.to.datasetId)) continue;
      paths.set(h.to.datasetId, [...(paths.get(ds) as Hop[]), h]);
      queue.push(h.to.datasetId);
    }
  }
  paths.delete(primary);
  return paths;
}

/**
 * The hop path from `primary` to `target`, or the reason there is none. A
 * target connected ONLY against a relationship's direction is a refused fan-out,
 * named as such; one not connected at all is simply unrelated.
 */
export function findPath(
  primary: string,
  target: string,
  rels: Relationship[],
  nameOf: (id: string) => string = (id) => id,
): Result<Hop[]> {
  if (target === primary) return { ok: true, value: [] };
  const safe = reachable(primary, rels).get(target);
  if (safe) return { ok: true, value: safe };

  // Undirected search, remembering the first edge taken against its direction.
  const seen = new Map<string, Relationship | null>([[primary, null]]);
  const queue = [primary];
  while (queue.length) {
    const ds = queue.shift() as string;
    for (const r of rels) {
      const forward = r.from.datasetId === ds;
      if (!forward && r.to.datasetId !== ds) continue;
      const next = forward ? r.to.datasetId : r.from.datasetId;
      if (seen.has(next)) continue;
      const against = !forward && r.cardinality !== 'one_to_one';
      seen.set(next, seen.get(ds) || (against ? r : null));
      queue.push(next);
    }
  }
  const blocker = seen.get(target);
  if (blocker) {
    return {
      ok: false,
      error:
        `${nameOf(target)} can't be used from ${nameOf(primary)}: ${nameOf(blocker.from.datasetId)} is on the ` +
        `many side of ${nameOf(blocker.from.datasetId)}.${blocker.from.column} → ` +
        `${nameOf(blocker.to.datasetId)}.${blocker.to.column}, so its rows would repeat and every measure would be inflated.`,
    };
  }
  return { ok: false, error: `${nameOf(target)} is not related to ${nameOf(primary)}.` };
}

/** The union of the paths to every target, each table once, in chain order. */
export function planTables(
  primary: string,
  targets: string[],
  rels: Relationship[],
  nameOf?: (id: string) => string,
): Result<JoinPlan> {
  const tables: JoinPlan['tables'] = [{ datasetId: primary, via: null }];
  const have = new Set([primary]);
  for (const t of targets) {
    const p = findPath(primary, t, rels, nameOf);
    if (!p.ok) return p;
    for (const h of p.value) {
      if (have.has(h.to.datasetId)) continue;
      have.add(h.to.datasetId);
      tables.push({ datasetId: h.to.datasetId, via: h });
    }
  }
  return { ok: true, value: { tables } };
}

export function mergedLayout(plan: JoinPlan, infos: Map<string, DsInfo>): JoinLayout {
  const columns: ParsedColumn[] = [];
  const tableOf: number[] = [];
  const srcIndex: number[] = [];
  const offsets: number[] = [];
  const used = new Set<string>();
  plan.tables.forEach((t, ti) => {
    const info = infos.get(t.datasetId) as DsInfo;
    offsets.push(columns.length);
    info.columns.forEach((c, ci) => {
      let name = ti === 0 ? c.name : `${info.name}.${c.name}`;
      for (let n = 2; ti > 0 && used.has(name); n++) name = `${info.name}.${c.name} (${n})`;
      used.add(name);
      columns.push({ name, type: c.type });
      tableOf.push(ti);
      srcIndex.push(ci);
    });
  });
  return { columns, tableOf, srcIndex, offsets };
}

/** The merged name of `column` in table `ti`, or null. Exact, first match — `transforms.colIndex`. */
export function mergedName(layout: JoinLayout, plan: JoinPlan, ti: number, column: string, infos: Map<string, DsInfo>): string | null {
  const info = infos.get(plan.tables[ti].datasetId);
  const ci = info ? info.columns.findIndex((c) => c.name === column) : -1;
  return ci < 0 ? null : layout.columns[layout.offsets[ti] + ci].name;
}

export interface VizJoin {
  plan: JoinPlan;
  layout: JoinLayout;
  /** The encoding over merged names, with every dataset reference gone. */
  encoding: VizEncoding;
  filters: FilterStep[];
  /** Merged measure column → its table, for the no-fan-out mask. */
  measureTable: Map<string, number>;
}

/** Which dataset a bare column name means from `primary`: its own, else the NEAREST related one. */
export function resolveColumnOwner(
  primary: string,
  column: string,
  rels: Relationship[],
  infos: Map<string, DsInfo>,
): string | null {
  const has = (id: string): boolean => !!infos.get(id)?.columns.some((c) => c.name === column);
  if (has(primary)) return primary;
  for (const id of reachable(primary, rels).keys()) if (has(id)) return id;
  return null;
}

/**
 * The join a visual needs, or `null` when it needs none — every field and every
 * filter column is the primary's own, which is today's single-dataset path,
 * untouched. An explicit reference to a dataset that cannot be reached safely
 * is an error, never a silent fallback to the primary's same-named column.
 */
export function resolveVizJoin(
  primary: string,
  encoding: VizEncoding,
  filters: FilterStep[],
  rels: Relationship[],
  infos: Map<string, DsInfo>,
): Result<VizJoin> | null {
  if (!encoding || encoding.pivot || !infos.has(primary)) return null;
  if (encoding.cohort || encoding.eventFunnel) return null; // their shelves name the primary's own columns
  const nameOf = (id: string): string => infos.get(id)?.name || 'A dataset';
  const needed = new Set<string>();
  const want = (id: string | undefined): string => {
    const ds = id && id !== primary ? id : primary;
    if (ds !== primary) needed.add(ds);
    return ds;
  };
  const catDs = want(encoding.categoryDatasetId);
  const serDs = encoding.series ? want(encoding.seriesDatasetId) : primary;
  const valDs = (encoding.values || []).map((v) => want(v.datasetId));
  const filterDs = (filters || []).map((f) => {
    const owner = f && typeof f.column === 'string' ? resolveColumnOwner(primary, f.column, rels, infos) : null;
    if (owner && owner !== primary) needed.add(owner);
    return owner;
  });
  if (needed.size === 0) return null;
  for (const id of needed) if (!infos.has(id)) return { ok: false, error: 'A related dataset no longer exists.' };

  const planned = planTables(primary, [...needed], rels, nameOf);
  if (!planned.ok) return planned;
  const plan = planned.value;
  const layout = mergedLayout(plan, infos);
  const tIndex = (id: string): number => plan.tables.findIndex((t) => t.datasetId === id);
  const rename = (id: string, col: string): string => mergedName(layout, plan, tIndex(id), col, infos) ?? col;

  const enc: VizEncoding = { ...encoding, category: rename(catDs, encoding.category) };
  delete enc.categoryDatasetId;
  delete enc.seriesDatasetId;
  if (encoding.series) enc.series = rename(serDs, encoding.series);
  const measureTable = new Map<string, number>();
  enc.values = (encoding.values || []).map((v, i) => {
    const column = rename(valDs[i], v.column);
    measureTable.set(column, tIndex(valDs[i]));
    const out = { ...v, column };
    delete out.datasetId;
    return out;
  });
  const flt = (filters || []).map((f, i) => (filterDs[i] ? { ...f, column: rename(filterDs[i] as string, f.column) } : f));
  return { ok: true, value: { plan, layout, encoding: enc, filters: flt, measureTable } };
}

/** Reachable datasets and their columns, nearest first — what the builder's pickers list. */
export function relatedColumnGroups(
  primary: string,
  rels: Relationship[],
  infos: Map<string, DsInfo>,
): { datasetId: string; name: string; columns: ParsedColumn[] }[] {
  const out: { datasetId: string; name: string; columns: ParsedColumn[] }[] = [];
  for (const id of reachable(primary, rels).keys()) {
    const info = infos.get(id);
    if (info) out.push({ datasetId: id, name: info.name, columns: info.columns });
  }
  return out;
}
