// Exact repair of a chart after a column rename (docs/autopilot/00-design.md, phase 3). Pure.
//
// It rewrites EXACTLY the fields `visualColumns` (src/analysis/lineage.ts) reads — the category, the split, a measure's column, the
// pivot's rows, columns and values, a filter's column — and nothing else: the same fields that decide a chart is broken decide what a
// repair touches. A measure that follows a saved metric (`metricId`) names no column of its own and is left alone.

type Rec = Record<string, any>; // any: a stored chart's loose shape, as lineage reads it

const rename = (name: unknown, map: ReadonlyMap<string, string>): unknown => (typeof name === 'string' && map.has(name) ? map.get(name) : name);

/** `rows`/`columns` entries are a column name or `{ column }`. */
const field = (f: unknown, map: ReadonlyMap<string, string>): unknown =>
  f && typeof f === 'object' ? { ...(f as Rec), column: rename((f as Rec).column, map) } : rename(f, map);

/** Does this encoding reach into a related dataset? Its columns may belong to the other table, so the chart is not judged. */
export function joinsOtherData(encoding: Rec): boolean {
  const e = encoding ?? {};
  const measures = [...(Array.isArray(e.values) ? e.values : []), ...(Array.isArray(e.pivot?.values) ? e.pivot.values : [])];
  return !!(e.categoryDatasetId || e.seriesDatasetId || e.categoryVia || measures.some((m: Rec) => m && (m.datasetId || m.via)));
}

/** The chart's encoding and filters with every column in `map` (old → new) renamed. The inputs are not changed. */
export function repairedDefinition(v: { encoding: Rec; filters: unknown }, map: ReadonlyMap<string, string>): { encoding: Rec; filters: unknown[] } {
  const e: Rec = JSON.parse(JSON.stringify(v.encoding ?? {}));
  if ('category' in e) e.category = rename(e.category, map);
  if ('series' in e) e.series = rename(e.series, map);
  if (Array.isArray(e.values)) e.values = e.values.map((m: Rec) => (m && !m.metricId ? { ...m, column: rename(m.column, map) } : m));
  if (e.pivot && typeof e.pivot === 'object') {
    const p: Rec = e.pivot;
    if (Array.isArray(p.rows)) p.rows = p.rows.map((r: unknown) => field(r, map));
    if (Array.isArray(p.columns)) p.columns = p.columns.map((c: unknown) => field(c, map));
    if (Array.isArray(p.values)) p.values = p.values.map((m: Rec) => (m && !m.metricId ? { ...m, column: rename(m.column, map) } : m));
  }
  const filters = (Array.isArray(v.filters) ? (JSON.parse(JSON.stringify(v.filters)) as Rec[]) : []).map((f) => (f && typeof f === 'object' && 'column' in f ? { ...f, column: rename(f.column, map) } : f));
  return { encoding: e, filters };
}

/** The columns of the fields a repair does NOT rewrite but that name dataset columns: a map's, a facet's, a cohort's, a funnel's. */
export function otherColumns(encoding: Rec): string[] {
  const e = encoding ?? {};
  const out: unknown[] = [];
  for (const k of ['lat', 'lon', 'lat2', 'lon2', 'from', 'to', 'color']) out.push(e.geo?.[k]);
  out.push(e.facet?.rows, e.facet?.cols, e.cohort?.entity, e.cohort?.date, e.cohort?.value);
  for (const k of ['entity', 'event', 'time', 'breakdown']) out.push(e.eventFunnel?.[k]);
  return [...new Set(out.filter((x): x is string => typeof x === 'string' && x !== ''))];
}

/** Does `name` appear anywhere in `value` as a string (an object's key does not count)? */
export function namesString(value: unknown, name: string): boolean {
  if (typeof value === 'string') return value === name;
  if (Array.isArray(value)) return value.some((x) => namesString(x, name));
  if (value && typeof value === 'object') return Object.values(value).some((x) => namesString(x, name));
  return false;
}
