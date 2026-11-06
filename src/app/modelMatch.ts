// Which project object each model file object is (semantic layer part 7, a2; docs/semantic-layer/07-portability.md
// D4) — PURE, over two ParsedModels: the upload and the project's own export (./modelExport.ts read back).
//
// Datasets, terms and metrics: by id, then by EXACT name (case counts); a metric a dbt import tagged, by its tag first. A term or a metric matched by name must sit on
// the same dataset: an import never moves a definition between datasets, so one on another dataset is new (and its name
// is then refused as taken). Relationships: by id, then the same two columns in either direction (`sameEdge`). A project
// object is matched at most once, and an id match is claimed before any name match. Datasets are never created: a file
// dataset with no match stays `null`, and every reference to it is missing.
//
// `mapRefs` rewrites an object's references from file ids into project ids, so both sides compare in one shape.

import { sameEdge } from '../analysis/relationships';
import type { ParsedModel } from './modelRead';
import type { ModelRelationship } from './modelFormat';

export type RefKind = 'dataset' | 'term' | 'metric' | 'relationship';

export interface ModelMatch {
  /** File id → project id; `null`: no match (a dataset is then missing, anything else is new). */
  datasets: Map<string, string | null>;
  terms: Map<string, string | null>;
  metrics: Map<string, string | null>;
  relationships: Map<string, string | null>;
  /** `kind:fileId` → how it matched; absent for no match. */
  how: Map<string, 'id' | 'name'>;
  /** `kind:id` of every project object: a reference to one the files leave out still resolves. */
  here: Set<string>;
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function matchKind<T extends { id: string }>(
  kind: RefKind, file: readonly T[], here: readonly T[], how: ModelMatch['how'], same: (f: T, h: T) => boolean, tagged?: (f: T, h: T) => boolean,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const ids = new Set(here.map((h) => h.id));
  const claimed = new Set<string>();
  for (const f of file) if (ids.has(f.id)) claimed.add(f.id);
  // An import tag names its object as an id does (f1: a dbt metric found again after a rename here), before any name.
  const byTag = new Map<string, string>();
  for (const f of tagged ? [...file].sort(byId) : []) {
    const h = ids.has(f.id) ? undefined : here.find((x) => !claimed.has(x.id) && (tagged as (f: T, h: T) => boolean)(f, x));
    if (h) {
      claimed.add(h.id);
      byTag.set(f.id, h.id);
    }
  }
  for (const f of [...file].sort(byId)) {
    if (ids.has(f.id) || byTag.has(f.id)) {
      out.set(f.id, byTag.get(f.id) ?? f.id);
      how.set(`${kind}:${f.id}`, 'id');
      continue;
    }
    const h = here.find((x) => !claimed.has(x.id) && same(f, x));
    out.set(f.id, h ? h.id : null);
    if (h) {
      claimed.add(h.id);
      how.set(`${kind}:${f.id}`, 'name');
    }
  }
  return out;
}

const edge = (r: ModelRelationship) => ({ from: { datasetId: r.from.dataset, column: r.from.column }, to: { datasetId: r.to.dataset, column: r.to.column } });

export function matchModel(file: ParsedModel, here: ParsedModel): ModelMatch {
  const how: ModelMatch['how'] = new Map();
  const set = new Set<string>();
  for (const [kind, list] of [['dataset', here.datasets], ['term', here.terms], ['metric', here.metrics], ['relationship', here.relationships]] as const) {
    for (const o of list) set.add(`${kind}:${o.id}`);
  }
  const datasets = matchKind('dataset', file.datasets, here.datasets, how, (f, h) => f.name === h.name);
  const onDataset = (f: { name: string; dataset: string }, h: { name: string; dataset: string }): boolean => f.name === h.name && datasets.get(f.dataset) === h.dataset;
  const m: ModelMatch = {
    datasets,
    terms: matchKind('term', file.terms, here.terms, how, onDataset),
    metrics: matchKind('metric', file.metrics, here.metrics, how, onDataset, (f, h) =>
      !!f.importedFrom && f.importedFrom.kind === h.importedFrom?.kind && f.importedFrom.name === h.importedFrom.name && datasets.get(f.dataset) === h.dataset),
    relationships: new Map(),
    how,
    here: set,
  };
  m.relationships = matchKind('relationship', file.relationships, here.relationships, how, (f, h) => {
    const mapped = mapRefs(f, m);
    return mapped.missing.length === 0 && sameEdge({ ...edge(h), id: h.id, cardinality: h.cardinality, verified: { matched: 0, unmatchedFrom: 0 } }, edge(mapped.value));
  });
  return m;
}

const mapOf = (m: ModelMatch, kind: RefKind): Map<string, string | null> =>
  kind === 'dataset' ? m.datasets : kind === 'term' ? m.terms : kind === 'metric' ? m.metrics : m.relationships;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `o` with every reference in project ids, the `kind:id` of each that resolves to nothing (`missing`) and of every one
 * read, as the files name it (`refs`: what a skip of that object takes down with it). A reference to a file
 * object with no match keeps its file id (it is new; the apply gives it its id), except a dataset, which is missing.
 * Read: `dataset`, `from`/`to.dataset`, filter and base-filter steps' `term`, `via` and `datasetId`, a period
 * definition's `base` and a target's `source.metricId`. A copy: `o` is never touched.
 */
export function mapRefs<T>(o: T, m: ModelMatch): { value: T; missing: string[]; refs: string[] } {
  const value = JSON.parse(JSON.stringify(o)) as T;
  const missing: string[] = [];
  const refs: string[] = [];
  const to = (kind: RefKind, id: unknown): unknown => {
    if (typeof id !== 'string') return id;
    refs.push(`${kind}:${id}`);
    const map = mapOf(m, kind);
    const hit = map.has(id) ? map.get(id) ?? (kind === 'dataset' ? undefined : id) : m.here.has(`${kind}:${id}`) ? id : undefined;
    if (hit === undefined) missing.push(`${kind}:${id}`);
    return hit ?? id;
  };
  const v = value as Obj;
  if ('dataset' in v) v.dataset = to('dataset', v.dataset);
  for (const end of [v.from, v.to]) if (isObj(end)) end.dataset = to('dataset', end.dataset);
  for (const list of [v.filters, v.baseFilters]) {
    for (const s of Array.isArray(list) ? list : []) {
      if (!isObj(s)) continue;
      if (s.type === 'term') s.term = to('term', s.term);
      if (s.via !== undefined) s.via = to('relationship', s.via);
      if (s.datasetId !== undefined) s.datasetId = to('dataset', s.datasetId);
    }
  }
  if (isObj(v.definition) && v.definition.base !== undefined) v.definition.base = to('metric', v.definition.base);
  const source = isObj(v.target) ? v.target.source : undefined;
  if (isObj(source) && source.metricId !== undefined) source.metricId = to('metric', source.metricId);
  return { value, missing, refs };
}
