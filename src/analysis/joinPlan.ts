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
import { termNoJoinHere } from '../data/termMessages';
import { viaElsewhere, viaGone, viaNoColumn } from './joinMessages';

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

/**
 * One table of a join, keyed by its hop PATH (relationship ids), not its dataset: one dataset can be
 * joined twice (Sales → Dates by order date and by ship date).
 */
export interface PlanTable {
  /** `pathKey` of the hops that reach it; '' for the primary. */
  key: string;
  datasetId: string;
  /** The hop that adds it; null for the primary. */
  via: Hop | null;
  /** The table index `via.from` sits in; -1 for the primary. */
  parent: number;
  /** Its columns' prefix when it is NOT its dataset's default path ("Ship date"); else the dataset's name. */
  label?: string;
}

export interface JoinPlan {
  /** [0] is the primary dataset: key '', via null, parent -1. */
  tables: PlanTable[];
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
  if (blocker) return { ok: false, error: fanOutError(target, primary, blocker, nameOf) };
  return { ok: false, error: `${nameOf(target)} is not related to ${nameOf(primary)}.` };
}

function fanOutError(target: string, primary: string, blocker: Relationship, nameOf: (id: string) => string): string {
  return `${nameOf(target)} can't be used from ${nameOf(primary)}: ${nameOf(blocker.from.datasetId)} is on the ` +
    `many side of ${nameOf(blocker.from.datasetId)}.${blocker.from.column} → ` +
    `${nameOf(blocker.to.datasetId)}.${blocker.to.column}, so its rows would repeat and every measure would be inflated.`;
}

/** A plan table's identity: its hops' relationship ids, joined by '>'. */
export function pathKey(hops: readonly Hop[]): string {
  return hops.map((h) => h.relId).join('>');
}

/** What a hop's table is called when it is not its dataset's default: the relationship's label, else "Dates (ship_date)". */
function hopLabel(h: Hop, rels: Relationship[], nameOf: (id: string) => string): string {
  return rels.find((r) => r.id === h.relId)?.label ?? `${nameOf(h.to.datasetId)} (${h.from.column})`;
}

/**
 * The hops a reference naming relationship `relId` takes: the DEFAULT path to the relationship's near
 * side, then that one hop. The near side is its `from` when the primary reaches it (not through this
 * relationship); otherwise, for a one-to-one, its `to`. Walking a many-to-one backwards is refused as
 * a fan-out, never re-routed.
 */
export function viaPath(primary: string, relId: string, rels: Relationship[], nameOf: (id: string) => string = (id) => id): Result<Hop[]> {
  const r = rels.find((x) => x.id === relId);
  if (!r) return { ok: false, error: viaGone() };
  const reach = reachable(primary, rels);
  // A one-to-one's far side is reached THROUGH it; that is no near side (the hop would walk straight back).
  const near = (ds: string): Hop[] | undefined => {
    const p = ds === primary ? [] : reach.get(ds);
    return p && !p.some((h) => h.relId === relId) ? p : undefined;
  };
  const fwd = near(r.from.datasetId);
  if (fwd) return { ok: true, value: [...fwd, { relId, from: r.from, to: r.to }] };
  const back = near(r.to.datasetId);
  if (back && r.cardinality === 'one_to_one') return { ok: true, value: [...back, { relId, from: r.to, to: r.from }] };
  if (back) return { ok: false, error: fanOutError(r.from.datasetId, primary, r, nameOf) };
  const p = findPath(primary, r.from.datasetId, rels, nameOf); // neither side is reached: findPath says why
  return p.ok ? { ok: true, value: [...p.value, { relId, from: r.from, to: r.to }] } : p;
}

/** The OTHER datasets a plan reads, each once (row access rules gate exactly these). */
export function planReads(plan: JoinPlan): string[] {
  return [...new Set(plan.tables.map((t) => t.datasetId))].filter((id) => id !== plan.tables[0].datasetId);
}

/**
 * The union of `paths`, each table once by its path key, in chain order. A table reached by anything
 * but its dataset's default path is labelled, so its columns never take the default table's names.
 */
export function planPaths(primary: string, paths: Hop[][], rels: Relationship[], nameOf: (id: string) => string = (id) => id): JoinPlan {
  const tables: PlanTable[] = [{ key: '', datasetId: primary, via: null, parent: -1 }];
  const reach = reachable(primary, rels);
  const defaultKey = (ds: string): string | null => (ds === primary ? '' : reach.has(ds) ? pathKey(reach.get(ds) as Hop[]) : null);
  for (const p of paths) {
    p.forEach((h, i) => {
      const key = pathKey(p.slice(0, i + 1));
      if (tables.some((t) => t.key === key)) return;
      const parent = tables.findIndex((t) => t.key === pathKey(p.slice(0, i)));
      const t: PlanTable = { key, datasetId: h.to.datasetId, via: h, parent };
      if (key !== defaultKey(h.to.datasetId)) t.label = hopLabel(h, rels, nameOf);
      tables.push(t);
    });
  }
  return { tables };
}

/** The union of the DEFAULT paths to every target, each table once, in chain order. */
export function planTables(
  primary: string,
  targets: string[],
  rels: Relationship[],
  nameOf?: (id: string) => string,
): Result<JoinPlan> {
  const paths: Hop[][] = [];
  for (const t of targets) {
    const p = findPath(primary, t, rels, nameOf);
    if (!p.ok) return p;
    paths.push(p.value);
  }
  return { ok: true, value: planPaths(primary, paths, rels, nameOf) };
}

export function mergedLayout(plan: JoinPlan, infos: Map<string, DsInfo>): JoinLayout {
  const columns: ParsedColumn[] = [];
  const tableOf: number[] = [];
  const srcIndex: number[] = [];
  const offsets: number[] = [];
  const used = new Set<string>();
  plan.tables.forEach((t, ti) => {
    const info = infos.get(t.datasetId) as DsInfo;
    const prefix = t.label ?? info.name;
    offsets.push(columns.length);
    info.columns.forEach((c, ci) => {
      let name = ti === 0 ? c.name : `${prefix}.${c.name}`;
      for (let n = 2; ti > 0 && used.has(name); n++) name = `${prefix}.${c.name} (${n})`;
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

/**
 * Which dataset a bare column name means from `primary`: its own, else the NEAREST related one. `pinned`: a
 * glossary term's step from another dataset (semantic D11) means exactly that one, when it is reachable and
 * has the column — never a same-named column of another table — or nothing.
 */
export function resolveColumnOwner(
  primary: string,
  column: string,
  rels: Relationship[],
  infos: Map<string, DsInfo>,
  pinned?: string,
): string | null {
  const has = (id: string): boolean => !!infos.get(id)?.columns.some((c) => c.name === column);
  if (pinned) return has(pinned) && (pinned === primary || reachable(primary, rels).has(pinned)) ? pinned : null;
  if (has(primary)) return primary;
  for (const id of reachable(primary, rels).keys()) if (has(id)) return id;
  return null;
}

/** Does any reference name a relationship (`via`, `categoryVia`, a filter's `via`)? Paths with no join planner decline these. */
export function hasVia(encoding: VizEncoding, filters: FilterStep[]): boolean {
  return !!(encoding && (encoding.categoryVia || (encoding.values || []).some((v) => v && v.via)))
    || (filters || []).some((f) => f && f.via);
}

/** A column a question names: through its dataset's DEFAULT path (`ds`), or through the relationship `via`. */
interface Ref { ds?: string; via?: string; column: string }

interface Resolved { plan: JoinPlan; layout: JoinLayout; name: (r: Ref) => string; table: (r: Ref) => number }

/**
 * The plan reaching every reference, or null when each is the primary's own. A `via` that cannot
 * resolve (gone, not walkable, leading elsewhere, or lacking the column) is an error, never the first
 * relationship or a same-named column.
 */
function resolveRefs(primary: string, refs: Ref[], rels: Relationship[], infos: Map<string, DsInfo>): Result<Resolved> | null {
  if (!refs.some((r) => r.via || (r.ds && r.ds !== primary))) return null;
  for (const r of refs) if (r.ds && !infos.has(r.ds)) return { ok: false, error: 'A related dataset no longer exists.' };
  const nameOf = (id: string): string => infos.get(id)?.name || 'A dataset';
  const keys = new Map<Ref, string>();
  const paths: Hop[][] = [];
  for (const r of refs) {
    if (!r.via && (!r.ds || r.ds === primary)) { keys.set(r, ''); continue; }
    const p = r.via ? viaPath(primary, r.via, rels, nameOf) : findPath(primary, r.ds as string, rels, nameOf);
    if (!p.ok) return p;
    if (r.via) {
      const last = p.value[p.value.length - 1];
      const label = hopLabel(last, rels, nameOf);
      if (r.ds && last.to.datasetId !== r.ds) return { ok: false, error: viaElsewhere(label, nameOf(r.ds)) };
      if (!infos.get(last.to.datasetId)?.columns.some((c) => c.name === r.column)) return { ok: false, error: viaNoColumn(label, r.column) };
    }
    paths.push(p.value);
    keys.set(r, pathKey(p.value));
  }
  const plan = planPaths(primary, paths, rels, nameOf);
  const layout = mergedLayout(plan, infos);
  const table = (r: Ref): number => plan.tables.findIndex((t) => t.key === keys.get(r));
  const name = (r: Ref): string => mergedName(layout, plan, table(r), r.column, infos) ?? r.column;
  return { ok: true, value: { plan, layout, name, table } };
}

/**
 * Each filter's reference: its `via`, else its column's NEAREST owner, or a glossary term's pinned dataset
 * (`datasetId`, semantic D11); null when no dataset has the column, or the pinned one cannot be reached.
 */
function filterRefs(primary: string, filters: FilterStep[], rels: Relationship[], infos: Map<string, DsInfo>): (Ref | null)[] {
  return filters.map((f) => {
    if (!f || typeof f.column !== 'string') return null;
    if (f.via) return { via: f.via, column: f.column };
    const owner = resolveColumnOwner(primary, f.column, rels, infos, f.datasetId);
    return owner ? { ds: owner, column: f.column } : null;
  });
}

/** The filters over merged names; a resolved step loses its `via` and its `datasetId`, so no evaluator skips it. */
function renamedFilters(filters: FilterStep[], refs: (Ref | null)[], name: (r: Ref) => string): FilterStep[] {
  return filters.map((f, i) => {
    const r = refs[i];
    if (!r) return f;
    const out = { ...f, column: name(r) };
    delete out.via;
    delete out.datasetId; // renamed onto its table's merged column: what every engine can apply
    return out;
  });
}

const isRef = (r: Ref | null): r is Ref => r !== null;

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
  const pinned = (filters || []).some((f) => f && f.datasetId);
  // A term on another dataset filters THAT table: a figure that cannot join refuses it, never filters its own same-named column.
  if (pinned && (!encoding || encoding.pivot || encoding.cohort || encoding.eventFunnel)) return { ok: false, error: termNoJoinHere() };
  if (!encoding || encoding.pivot || !infos.has(primary)) return null;
  if (encoding.cohort || encoding.eventFunnel) return null; // their shelves name the primary's own columns
  const cat: Ref = { ds: encoding.categoryDatasetId || primary, via: encoding.categoryVia, column: encoding.category };
  const ser: Ref | null = encoding.series ? { ds: encoding.seriesDatasetId || primary, column: encoding.series } : null;
  const vals: Ref[] = (encoding.values || []).map((v) => ({ ds: v.datasetId || primary, via: v.via, column: v.column }));
  const flts = filterRefs(primary, filters || [], rels, infos);
  if ((filters || []).some((f, i) => f && f.datasetId && !flts[i])) return { ok: false, error: termNoJoinHere() };
  const resolved = resolveRefs(primary, [cat, ...(ser ? [ser] : []), ...vals, ...flts.filter(isRef)], rels, infos);
  if (!resolved || !resolved.ok) return resolved;
  const { plan, layout, name, table } = resolved.value;

  const enc: VizEncoding = { ...encoding, category: name(cat) };
  delete enc.categoryDatasetId;
  delete enc.categoryVia;
  delete enc.seriesDatasetId;
  if (ser) enc.series = name(ser);
  const measureTable = new Map<string, number>();
  enc.values = (encoding.values || []).map((v, i) => {
    const column = name(vals[i]);
    measureTable.set(column, table(vals[i]));
    const out = { ...v, column };
    delete out.datasetId;
    delete out.via;
    return out;
  });
  return { ok: true, value: { plan, layout, encoding: enc, filters: renamedFilters(filters || [], flts, name), measureTable } };
}

export interface MetricJoin {
  plan: JoinPlan;
  layout: JoinLayout;
  /** The measure's merged name, and the table it is read from (the no-fan-out mask). */
  column: string;
  table: number;
  filters: FilterStep[];
}

/**
 * The join a metric's column and filters need — each resolved to its NEAREST owner, through its
 * `via`, or (a glossary term's step) to its pinned dataset — or null when every one is the dataset's own.
 */
export function planMetricJoin(
  primary: string,
  column: string,
  filters: FilterStep[],
  rels: Relationship[],
  infos: Map<string, DsInfo>,
): Result<MetricJoin> | null {
  const m: Ref = { ds: resolveColumnOwner(primary, column, rels, infos) ?? primary, column };
  const flts = filterRefs(primary, filters, rels, infos);
  const resolved = resolveRefs(primary, [m, ...flts.filter(isRef)], rels, infos);
  if (!resolved || !resolved.ok) return resolved;
  const { plan, layout, name, table } = resolved.value;
  return { ok: true, value: { plan, layout, column: name(m), table: table(m), filters: renamedFilters(filters, flts, name) } };
}

export interface ColumnGroup { datasetId: string; name: string; columns: ParsedColumn[]; via?: string }

/**
 * Reachable datasets and their columns, nearest first — what the builder's pickers list — then one
 * group per walkable relationship that is NOT its dataset's default hop ("Ship date"), carrying its `via`.
 */
export function relatedColumnGroups(primary: string, rels: Relationship[], infos: Map<string, DsInfo>): ColumnGroup[] {
  const out: ColumnGroup[] = [];
  const reach = reachable(primary, rels);
  for (const id of reach.keys()) {
    const info = infos.get(id);
    if (info) out.push({ datasetId: id, name: info.name, columns: info.columns });
  }
  const nameOf = (id: string): string => infos.get(id)?.name || 'A dataset';
  for (const r of rels) {
    const p = viaPath(primary, r.id, rels, nameOf);
    if (!p.ok) continue;
    const last = p.value[p.value.length - 1];
    const info = infos.get(last.to.datasetId);
    const dflt = last.to.datasetId === primary ? '' : pathKey(reach.get(last.to.datasetId) ?? []);
    if (info && pathKey(p.value) !== dflt) out.push({ datasetId: info.id, name: hopLabel(last, rels, nameOf), columns: info.columns, via: r.id });
  }
  return out;
}
