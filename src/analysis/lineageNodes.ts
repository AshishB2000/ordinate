// Column and term nodes (semantic layer D16) — MAIN, PURE. `buildGraph` draws today's picture; this pass lays columns
// and glossary terms on top of it, from the same records and nothing else. Only `lineage:column` and `lineage:fields`
// call it, so `lineage:get` draws exactly what it drew before.
//
// A node carries a name and a fixed word, never a formula, a filter value, a table, a path, a URL or SQL. A column
// gets a node only when something reads it (or a column that gets one is computed from it).

import { KIND_RANK } from './lineage';
import type { LineageEdge, LineageGraph, LineageInput, LineageKind, LineageNode } from './lineage';
import { columnFlow, formulaColumns, stepProduces } from './lineageFlow';
import type { FlowColumn } from './lineageFlow';
import { alertReads, cardReads, consumerColumns, keyColumns, metricColumns } from './lineageColumns';
import type { TransformStep } from '../data/transforms';

// ponytail: loose record shapes — each store's own sanitizer already shaped them (as ./lineage does)
type Rec = Record<string, any>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export type UsedIn = Partial<Record<LineageKind, number>>;

interface DsFlow {
  d: Rec;
  flow: FlowColumn[];
  byKey: Map<string, FlowColumn>;
  /** Names of the calculated_field steps, and the Live calcs a dataset keeps (00a). */
  calcSteps: Set<string>;
  liveCalcs: Map<string, string>; // name → expression
}

function flowOf(d: Rec): DsFlow {
  const liveCalcs = new Map<string, string>(arr(d.live && d.live.calculated).filter((c) => c && str(c.name)).map((c) => [str(c.name), str(c.expression)]));
  const names = (cs: unknown): string[] => arr(cs).map((c) => str(c && c.name)).filter((n) => n && !liveCalcs.has(n));
  const steps = arr(d.steps).filter((s) => s && typeof s === 'object') as TransformStep[];
  // a stored record that keeps no source columns folds from its own columns, as the plan says (`sourceColumns ?? columns`)
  const flow = columnFlow(names(d.sourceColumns ?? d.columns), arr(d.steps) as TransformStep[], names(d.columns));
  const byKey = new Map<string, FlowColumn>();
  for (const fc of flow) if (!byKey.has(fc.key) || !fc.dropped) byKey.set(fc.key, fc);
  return { d, flow, byKey, calcSteps: new Set(steps.filter((s) => s.type === 'calculated_field').map((s) => str((s as { name?: unknown }).name))), liveCalcs };
}

/** The node a flow column is drawn as: today's `calc:` node for a calculated field, else `column:`. */
function nodeId(ds: string, F: DsFlow, fc: FlowColumn): string {
  const made = fc.was[0] ?? fc.key;
  return fc.how === 'calc' && F.calcSteps.has(made) ? `calc:${ds}:${made}` : `column:${ds}:${fc.key}`;
}

const subOf = (fc: FlowColumn): string => (fc.how === 'masked' ? 'Masked' : fc.how === 'approximate' ? 'Approximate' : fc.was.length ? `Renamed from ${fc.was.join(', ')}` : 'Column');

/** Every `{type:'term', term}` reference anywhere in a record. */
function termIdsIn(rec: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (!rec || typeof rec !== 'object' || depth > 14) return into;
  const o = rec as Rec;
  if (o.type === 'term' && typeof o.term === 'string') into.add(o.term);
  for (const v of Array.isArray(o) ? o : Object.values(o)) termIdsIn(v, into, depth + 1);
  return into;
}

export function addColumnNodes(g: LineageGraph, input: LineageInput): LineageGraph {
  const nodes = new Map<string, LineageNode>(g.nodes.map((n) => [n.id, n]));
  const edges: LineageEdge[] = [...g.edges];
  const seenEdge = new Set(edges.map((e) => e.from + '>' + e.to));
  const link = (from: string | null, to: string): void => {
    if (!from || from === to || seenEdge.has(from + '>' + to) || !nodes.has(from) || !nodes.has(to)) return;
    if (KIND_RANK[nodes.get(to)!.kind] < KIND_RANK[nodes.get(from)!.kind]) return; // never right to left
    seenEdge.add(from + '>' + to);
    edges.push({ from, to });
  };
  const flows = new Map<string, DsFlow>();
  for (const d of input.datasets) if (str(d.id)) flows.set(str(d.id), flowOf(d));
  const done = new Set<string>();

  /** The node that stands for column `name` of dataset `ds`, drawn (with what it is computed from) on first ask; null when the dataset has no such column. */
  const need = (ds: string, name: string): string | null => {
    const F = flows.get(ds);
    if (!F) return null;
    const expr = F.liveCalcs.get(name);
    if (expr !== undefined) {
      const id = `calc:${ds}:${name}`;
      if (!done.has(id)) {
        done.add(id);
        nodes.set(id, { id, kind: 'calc', name, sub: 'Calculated field', ref: { type: 'dataset', id: ds } });
        link('dataset:' + ds, id);
        for (const ref of formulaColumns(expr)) link(need(ds, ref), id);
      }
      return id;
    }
    const fc = F.byKey.get(name);
    if (!fc) return null;
    const id = nodeId(ds, F, fc);
    if (done.has(id)) return id;
    done.add(id);
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'column', name: fc.key, sub: subOf(fc), ref: { type: 'dataset', id: ds } });
    for (const f of fc.from) link(need(ds, f), id);
    if (fc.lookup) link(need(fc.lookup.datasetId, fc.lookup.column), id);
    if (!fc.from.length && !fc.lookup) {
      const derived = fc.how === 'calc' || fc.how === 'aggregate' || fc.how === 'approximate';
      link(derived && nodes.has('prepare:' + ds) ? 'prepare:' + ds : 'dataset:' + ds, id);
    } else if (!fc.from.length) link('dataset:' + ds, id);
    return id;
  };

  const consume = (consumer: string, byDs: Map<string, string[]> | null): void => {
    if (!byDs || !nodes.has(consumer)) return;
    const [primary] = [...byDs.keys()];
    const all = new Map<string, string[]>();
    for (const m of [byDs, keyColumns(primary, [...byDs.keys()].slice(1), input)]) {
      for (const [ds, cols] of m) all.set(ds, [...new Set([...(all.get(ds) ?? []), ...cols])]);
    }
    for (const [ds, cols] of all) for (const c of cols) link(need(ds, c), consumer);
  };

  const terms = new Map((input.terms ?? []).map((t) => [str(t.id), t]));
  const useTerms = (consumer: string, rec: unknown): void => {
    if (!nodes.has(consumer)) return;
    for (const tid of termIdsIn(rec)) {
      const t = terms.get(tid);
      if (!t) continue;
      const id = 'term:' + tid;
      if (!done.has(id)) {
        done.add(id);
        nodes.set(id, { id, kind: 'term', name: str(t.name) || 'Term', sub: 'Glossary term', ref: { type: 'term', id: tid } });
        for (const f of arr(t.filters)) link(need(str(t.datasetId), str(f && f.column)), id);
      }
      link(id, consumer);
    }
  };

  for (const m of input.metrics) { consume('metric:' + str(m.id), metricColumns(m, input)); useTerms('metric:' + str(m.id), m); }
  for (const v of input.visuals) { consume('visual:' + str(v.id), consumerColumns(v, input)); useTerms('visual:' + str(v.id), v); }
  for (const a of input.dashboards) {
    for (const c of arr(a.sheets).flatMap((p) => arr(p && p.cards))) consume('dashboard:' + str(a.id), cardReads(c, input));
    useTerms('dashboard:' + str(a.id), a);
  }
  for (const al of input.alerts) {
    const m: Rec = al.metric || {};
    if (!(m.metricId && nodes.has('metric:' + m.metricId))) consume('alert:' + str(al.id), alertReads(al, input));
    useTerms('alert:' + str(al.id), al);
  }
  // A Live dataset's calcs are drawn whether or not anything reads them yet: they are what a person edits.
  for (const [ds, F] of flows) for (const name of F.liveCalcs.keys()) need(ds, name);
  return { nodes: [...nodes.values()], edges };
}

/** Everything downstream of `id` (the walk `focus` counts "Used in" from). */
function downstream(g: LineageGraph, id: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of g.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) for (const n of out.get(stack.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  return seen;
}

function count(g: LineageGraph, ids: Iterable<string>): UsedIn {
  const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const out: UsedIn = {};
  for (const id of ids) { const k = kind.get(id); if (k) out[k] = (out[k] || 0) + 1; }
  return out;
}

/** "Used by" for one dataset: per column that has a node, and per Prepare step that makes a column. `g` comes from `addColumnNodes`. */
export function columnFields(g: LineageGraph, input: LineageInput, datasetId: string): { fields: Record<string, { usedIn: UsedIn }>; steps: Array<{ index: number; produces: string[]; usedIn: UsedIn }> } {
  const fields: Record<string, { usedIn: UsedIn }> = Object.create(null);
  const d = input.datasets.find((x) => str(x.id) === datasetId);
  if (!d) return { fields, steps: [] };
  const F = flowOf(d);
  const have = new Set(g.nodes.map((n) => n.id));
  const idOf = new Map<string, string>(); // flow key → node id
  for (const fc of F.flow) { const id = nodeId(datasetId, F, fc); if (have.has(id)) { idOf.set(fc.key, id); fields[fc.key] = { usedIn: count(g, downstream(g, id)) }; } }
  for (const name of F.liveCalcs.keys()) { const id = `calc:${datasetId}:${name}`; if (have.has(id)) fields[name] = { usedIn: count(g, downstream(g, id)) }; }
  const names = (cs: unknown): string[] => arr(cs).map((c) => str(c && c.name)).filter(Boolean);
  const made = stepProduces(names(d.sourceColumns ?? d.columns), arr(d.steps) as TransformStep[], names(d.columns));
  const steps = [...made].sort((a, b) => a[0] - b[0]).map(([index, produces]) => {
    const own = new Set(produces.map((k) => idOf.get(k)).filter((x): x is string => !!x));
    const all = new Set<string>();
    for (const id of own) for (const n of downstream(g, id)) if (!own.has(n)) all.add(n);
    return { index, produces, usedIn: count(g, all) };
  });
  return { fields, steps };
}
