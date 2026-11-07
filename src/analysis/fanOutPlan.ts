// A chart whose measures live on the MANY sides of its dataset's relationships, planned as one question per
// table (drill-across, semantic layer part 8 D10–D13). PURE — no fs, no SQL. MAIN PROCESS.
//
// A chart on Customers with "sum of Orders.amount" cannot join Orders in (every customer row would repeat
// per order). Instead the chart's own measures stay its own question, and each many side M gets a question
// ON M by the same category: M's rows walk forward to J, the first table of Customers' tree M reaches, then
// along Customers' own path from J to the category. Each question is phrased in public encoding fields only
// (`categoryDatasetId` + `categoryVia`, a filter's `via`), and the planner proves with `viaPath` that the
// phrasing resolves to exactly that path; anything else is refused with a sentence, never re-chosen by
// breadth-first search (Orders reaches Regions directly by ship region). Null means no measure is on a
// many side: today's path answers, or refuses, as it always has.

import type { FilterStep } from '../data/transforms';
import type { Relationship } from './relationships';
import type { VizEncoding, VizMeasure } from './visuals';
import { pathKey, reachable, resolveColumnOwner, viaPath } from './joinPlan';
import type { DsInfo, Hop } from './joinPlan';
import type { ParsedColumn } from '../data/parse';
import { fanOutManySide, fanOutOffPath, fanOutShape, fanOutTwoOwners } from './fanOutMessages';

export interface FanQuestion {
  datasetId: string;
  encoding: VizEncoding;
  filters: FilterStep[];
  /** Indexes into the chart's `values`, in order. */
  measures: number[];
}
export type FanNote = { kind: 'ownRows'; measures: number[] } | { kind: 'narrows'; column: string; measures: number[] };
export interface FanOutPlan { questions: FanQuestion[]; notes: FanNote[] }
type Planned = { ok: true; plan: FanOutPlan } | { ok: false; error: string };

/** One many side's question in the making: M, its hops to J, and J's path from the primary. */
interface Side { m: string; mj: Hop[]; pj: Hop[]; q: FanQuestion }

const sameHops = (a: Hop[], b: Hop[] | undefined): boolean =>
  !!b && a.length === b.length && a.every((h, i) => h.relId === b[i].relId && h.to.datasetId === b[i].to.datasetId);
const startsWith = (p: Hop[], prefix: Hop[]): boolean => sameHops(p.slice(0, prefix.length), prefix);
const last = (p: Hop[]): Hop => p[p.length - 1];

/** M's default hops forward to J, the first table of the primary's tree (the primary first) it reaches; undefined when it reaches none. */
function meet(primary: string, reachP: Map<string, Hop[]>, m: string, rels: Relationship[]): Hop[] | undefined {
  const reachM = reachable(m, rels);
  const j = [primary, ...reachP.keys()].find((id) => reachM.has(id));
  return j === undefined ? undefined : reachM.get(j);
}

/** A many-side measure as its own table's: no dataset reference left. */
function own(v: VizMeasure): VizMeasure {
  const out = { ...v };
  delete out.datasetId;
  delete out.via;
  return out;
}

/** The part of a many side's question Rule 4 fills: its filters, and the measures they reach. */
type Routed = Pick<Side, 'm' | 'mj' | 'pj'> & { q: Pick<FanQuestion, 'filters' | 'measures'> };

/**
 * Rule 4 (D11): each filter keeps one meaning — the primary's owner, reached by each many side on the pinned
 * path; a column only a many side has narrows that side. Fills each side's filters; returns the primary's own
 * filters and the `narrows` notes, or the refusal's sentence.
 */
function routeFilters(primary: string, filters: FilterStep[], mine: number[], sides: Routed[], rels: Relationship[], infos: Map<string, DsInfo>): { ours: FilterStep[]; notes: FanNote[] } | string {
  const reachP = reachable(primary, rels);
  const pathP = (ds: string): Hop[] | undefined => (ds === primary ? [] : reachP.get(ds));
  const nameOf = (id: string): string => infos.get(id)?.name || 'A dataset';
  const ours: FilterStep[] = [];
  const notes: FanNote[] = [];
  for (const f of filters || []) {
    const reached = new Set<number>();
    const give = (s: Routed, step: FilterStep): void => { s.q.filters.push(step); s.q.measures.forEach((i) => reached.add(i)); };
    const p = !f || typeof f.column !== 'string' ? null
      : f.via ? viaPath(primary, f.via, rels)
      : ((o) => (o ? { ok: true as const, value: pathP(o) as Hop[] } : null))(resolveColumnOwner(primary, f.column, rels, infos));
    if (p && p.ok) {
      ours.push(f);
      mine.forEach((i) => reached.add(i));
      for (const s of sides) {
        if (!startsWith(p.value, s.pj)) continue; // a branch of the primary's tree M does not pass through
        const pinned = [...s.mj, ...p.value.slice(s.pj.length)];
        const back = viaPath(s.m, last(pinned).relId, rels);
        if (!back.ok || !sameHops(pinned, back.value)) return fanOutOffPath(f.column, nameOf(s.m), nameOf(primary));
        give(s, { ...f, via: last(pinned).relId });
      }
    } else if (!p && f && typeof f.column === 'string' && sides.some((s) => resolveColumnOwner(s.m, f.column, rels, infos))) {
      for (const s of sides) if (resolveColumnOwner(s.m, f.column, rels, infos)) give(s, f); // a column only a many side has
    } else {
      ours.push(f); // no table has it (or its via is refused): every question keeps it, and skips or refuses it as today
      for (const s of sides) s.q.filters.push(f);
      continue;
    }
    if (reached.size < mine.length + sides.reduce((n, s) => n + s.q.measures.length, 0)) {
      notes.push({ kind: 'narrows', column: f.column, measures: [...reached].sort((a, b) => a - b) });
    }
  }
  return { ours, notes };
}

export function planFanOut(primary: string, encoding: VizEncoding, filters: FilterStep[], rels: Relationship[], infos: Map<string, DsInfo>): Planned | null {
  if (!encoding || !infos.has(primary)) return null;
  const split = typeof encoding.series === 'string' && encoding.series !== '';
  const values = (encoding.values || []).slice(0, split ? 1 : undefined); // a split draws values[0] alone (vizData.buildPivot)
  const reachP = reachable(primary, rels);
  const pathP = (ds: string): Hop[] | undefined => (ds === primary ? [] : reachP.get(ds));
  const nameOf = (id: string): string => infos.get(id)?.name || 'A dataset';

  // Rule 1–2: each measure is the primary's (its own, or a forward join's) or a many side's, reached M → J.
  const mine: number[] = [];
  const sides: Side[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const d = (v && v.datasetId) || primary;
    if (pathP(d)) { mine.push(i); continue; }
    let mj: Hop[] | undefined;
    if (v.via) {
      const r = rels.find((x) => x.id === v.via);
      if (!r || r.from.datasetId !== d || !pathP(r.to.datasetId)) return null; // not a hop from M into the tree: today's sentence
      mj = [{ relId: r.id, from: r.from, to: r.to }];
    } else mj = meet(primary, reachP, d, rels);
    if (!mj) return null; // unrelated, or reached only through another many side: today's sentence
    const key = d + '|' + pathKey(mj);
    const side = sides.find((s) => s.m + '|' + pathKey(s.mj) === key);
    if (side) { side.q.measures.push(i); continue; }
    sides.push({ m: d, mj, pj: pathP(last(mj).to.datasetId) as Hop[], q: { datasetId: d, encoding: encoding, filters: [], measures: [i] } });
  }
  if (sides.length === 0) return null;
  // Rule 5 (D13 row 4).
  if (encoding.pivot || encoding.cohort || encoding.eventFunnel || encoding.facet || encoding.geo || encoding.drivers
    || values.every((v) => v?.aggregation === 'none')) return { ok: false, error: fanOutShape() };

  // Rule 3: the category and the split, on the primary's path THROUGH J, then pinned on M's question.
  type Placed = { ds: string; via?: string } | string;
  const place = (s: Side, field: string, ds: string, via: string | undefined, viaField: boolean): Placed => {
    if (!pathP(ds)) return fanOutManySide(field, nameOf(ds), nameOf(primary));
    const off = fanOutOffPath(field, nameOf(s.m), nameOf(primary));
    const p = via ? viaPath(primary, via, rels) : { ok: true as const, value: pathP(ds) as Hop[] };
    if (!p.ok || (p.value.length ? last(p.value).to.datasetId : primary) !== ds || !startsWith(p.value, s.pj)) return off;
    const pinned = [...s.mj, ...p.value.slice(s.pj.length)];
    if (sameHops(pinned, reachable(s.m, rels).get(ds))) return { ds };
    const back = viaPath(s.m, last(pinned).relId, rels);
    return viaField && back.ok && sameHops(pinned, back.value) ? { ds, via: last(pinned).relId } : off;
  };
  for (const s of sides) {
    const enc: VizEncoding = { ...encoding, values: s.q.measures.map((i) => own(values[i])) };
    delete enc.categoryVia;
    const cat = place(s, encoding.category, encoding.categoryDatasetId || primary, encoding.categoryVia, true);
    if (typeof cat === 'string') return { ok: false, error: cat };
    enc.categoryDatasetId = cat.ds;
    if (cat.via) enc.categoryVia = cat.via;
    if (split) {
      const ser = place(s, encoding.series as string, encoding.seriesDatasetId || primary, undefined, false); // no seriesVia: the default path only
      if (typeof ser === 'string') return { ok: false, error: ser };
      enc.seriesDatasetId = ser.ds;
    }
    s.q.encoding = enc;
  }

  // Rule 4 (D11).
  const routed = routeFilters(primary, filters, mine, sides, rels, infos);
  if (typeof routed === 'string') return { ok: false, error: routed };
  const { ours, notes } = routed;

  // Rule 6: the primary's question first, then one per (M, M → J) in measure order.
  const questions = (mine.length ? [{ datasetId: primary, encoding: { ...encoding, values: mine.map((i) => values[i]) }, filters: ours, measures: mine }] : [])
    .concat(sides.map((s) => s.q));
  return { ok: true, plan: { questions, notes: [{ kind: 'ownRows', measures: sides.flatMap((s) => s.q.measures).sort((a, b) => a - b) }, ...notes] } };
}

/** The primary's many sides — each dataset off its forward tree that walks forward onto it — with their columns, nearest first. */
export function manySideColumnGroups(primary: string, rels: Relationship[], infos: Map<string, DsInfo>): { datasetId: string; name: string; columns: ParsedColumn[] }[] {
  const reachP = reachable(primary, rels);
  const sides: { hops: number; g: { datasetId: string; name: string; columns: ParsedColumn[] } }[] = [];
  for (const [id, info] of infos) {
    if (id === primary || reachP.has(id)) continue;
    const mj = meet(primary, reachP, id, rels);
    if (mj) sides.push({ hops: mj.length, g: { datasetId: id, name: info.name, columns: info.columns } });
  }
  return sides.sort((a, b) => a.hops - b.hops).map((s) => s.g);
}

/**
 * Which many side a BARE column name means from `primary`: null when the primary or its forward tree has it
 * (today's rule wins) or no many side does; the one many side that has it; refused when two do.
 */
export function manySideOwner(primary: string, column: string, rels: Relationship[], infos: Map<string, DsInfo>): { ok: true; datasetId: string } | { ok: false; error: string } | null {
  if (resolveColumnOwner(primary, column, rels, infos)) return null;
  const owners = manySideColumnGroups(primary, rels, infos).filter((g) => g.columns.some((c) => c.name === column));
  if (owners.length > 1) return { ok: false, error: fanOutTwoOwners(column, owners[0].name, owners[1].name) };
  return owners.length ? { ok: true, datasetId: owners[0].datasetId } : null;
}

/** The table a BARE column is read on from `primary`, as the KPI door reads it: its own or a forward join's, else its one many side's, else the primary; null when two many sides have it (refused). */
export function bareColumnTable(primary: string, column: string, rels: Relationship[], infos: Map<string, DsInfo>): string | null {
  const many = manySideOwner(primary, column, rels, infos);
  return resolveColumnOwner(primary, column, rels, infos) ?? (!many ? primary : many.ok ? many.datasetId : null);
}

/** A KPI over a many-side column, as that table's KPI: on which dataset, under which filters, with which notes (one measure, index 0). */
export interface FanMetricPlan { datasetId: string; filters: FilterStep[]; notes: FanNote[] }

/**
 * A KPI on `primary` whose BARE column only one many side M has (D12): M's KPI, with the primary's filters
 * reaching it by Rule 4's pinned paths. Null when the column is the primary's or its forward tree's (today's
 * path), or no many side's; refused when two many sides have it, or a filter is off M's path.
 */
export function planFanOutMetric(primary: string, column: string, filters: FilterStep[], rels: Relationship[], infos: Map<string, DsInfo>): { ok: true; plan: FanMetricPlan } | { ok: false; error: string } | null {
  if (!infos.has(primary)) return null;
  const owner = manySideOwner(primary, column, rels, infos);
  if (!owner || !owner.ok) return owner;
  const reachP = reachable(primary, rels);
  const mj = meet(primary, reachP, owner.datasetId, rels) as Hop[]; // a many side reaches the tree by definition
  const j = last(mj).to.datasetId;
  const side: Routed = { m: owner.datasetId, mj, pj: j === primary ? [] : (reachP.get(j) as Hop[]), q: { filters: [], measures: [0] } };
  const routed = routeFilters(primary, filters, [], [side], rels, infos);
  if (typeof routed === 'string') return { ok: false, error: routed };
  return { ok: true, plan: { datasetId: side.m, filters: side.q.filters, notes: [{ kind: 'ownRows', measures: [0] }, ...routed.notes] } };
}
