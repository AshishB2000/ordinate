// dbt's semantic layer, translated into model files (semantic layer part 7, f1; docs/semantic-layer/07-portability.md
// D10). PURE: the manifest (already parsed, ./dbtRead.ts) and the project's datasets in, a2's ParsedModel out, plus
// every dbt object it does not import, each with its reason. The plan and apply are a2's and a3's.
//
// Exact shapes only, and no model or guess anywhere: a dbt shape whose figures could differ from MetricFlow's is
// skipped and named, never approximated (anti-goal). What maps:
// - a semantic model → an existing dataset (the person's `datasetMap`, else the exact name, else a case- and
//   underscore-blind one, marked for checking); none is ever made up;
// - its primary entity → the table key; each dimension → a field doc (description; label → display name);
// - a simple metric → `{ column, aggregation }` (sum, count, average → avg, min, max, count_distinct → countd) with
//   its date (the measure's agg_time_dimension, else the model's default), a balance (non_additive_dimension, no
//   window groupings) → a snapshot, and its filters through ./dbtFilter.ts;
// - a ratio → `[num] / [den]`, a derived metric → its expression over its inputs' names, all on one model.
// Each metric carries `importedFrom: { kind: 'dbt', name }`, so a re-import updates it (b0 keeps it on every pod).
// Ids are a hash of the dbt name: the same file gives the same plan, and its hash, on any pod.

import { createHash } from 'crypto';
import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import { NUMBER_AGGREGATIONS, type Aggregation } from '../data/aggregations';
import { sanitizeDefinition, sanitizeFormat, sanitizeMetricFilters, type MetricDefinition, type MetricFormat } from '../analysis/metrics';
import { formatFor } from '../analysis/metricAuto';
import { DEFAULT_CALENDAR } from '../analysis/dateIntel';
import { clip } from './clip';
import { parseDbtWhere } from './dbtFilter';
import type { ModelDataset, ModelField, ModelMetric } from './modelFormat';
import type { ParsedModel } from './modelRead';

/** Why a dbt object is not imported. `no_dataset`: its semantic model has no dataset here (a2 says it as missing). */
export type DbtSkip =
  | 'cumulative' | 'conversion' | 'time_offset' | 'cross_model' | 'window_groupings' | 'unknown_aggregation'
  | 'not_a_column' | 'filter_shape' | 'fill_nulls' | 'live_refused' | 'unreadable' | 'no_dataset';
export type DbtKind = 'metric' | 'dimension' | 'entity' | 'semanticModel';

export interface DbtSkipped {
  /** As Ordinate would name it: a metric's label, else its dbt name; a dimension or entity as `model · name`. */
  name: string;
  kind: DbtKind;
  reason: DbtSkip;
  /** Its dbt name (`model.name` for a dimension or entity): the plan item's key. */
  dbt: string;
  /** The semantic model it sits on, when it has one. */
  model?: string;
  /** The dbt name of the skipped input a ratio or derived metric needs: it falls with it, for that input's reason. */
  because?: string;
}

/** Which dataset a semantic model landed on, and how; no `datasetId`: none here. */
export interface DbtModelMatch { name: string; datasetId?: string; how?: 'map' | 'exact' | 'name' }
export interface DbtSource { models: DbtModelMatch[]; skipped: DbtSkipped[] }
export interface DbtDataset { id: string; name: string; columns: ParsedColumn[]; live?: boolean }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const nodes = (v: unknown): unknown[] => (Array.isArray(v) ? v : isObj(v) ? Object.values(v) : []);
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A dbt name or label: a short string with no control character. */
const name = (v: unknown, max = 256): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max && !CONTROL.test(v) ? v.trim() : undefined);
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? clip(v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''), max) || undefined : undefined);

/** A UUID from the dbt name: the same on every run and pod, never one of the project's. */
function dbtId(kind: string, n: string): string {
  const h = createHash('sha256').update(`dbt:${kind}:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const QUOTED = /^"((?:[^"]|"")+)"$/;
/** A SQL `expr` that is one column of the dataset: quoted exactly, or unquoted (case-blind, as SQL reads it, when one column answers). */
function columnOf(columns: readonly ParsedColumn[], expr: string): ParsedColumn | null {
  const e = expr.trim();
  const q = QUOTED.exec(e);
  if (q) return columns.find((c) => c.name === q[1].replace(/""/g, '"')) ?? null;
  if (!IDENT.test(e)) return null;
  const exact = columns.find((c) => c.name === e);
  if (exact) return exact;
  const loose = columns.filter((c) => c.name.toLowerCase() === e.toLowerCase());
  return loose.length === 1 ? loose[0] : null;
}

const AGG: Readonly<Record<string, Aggregation>> = { sum: 'sum', count: 'count', average: 'avg', min: 'min', max: 'max', count_distinct: 'countd' };
const NEEDS_NUMBER: ReadonlySet<string> = new Set(NUMBER_AGGREGATIONS);
const FORMULA_FORMAT: MetricFormat = { kind: 'number', decimals: 2, compact: false };
const MAX_FORMULA = 2_000;

interface Dim { column: ParsedColumn | null; time: boolean }
interface Model { name: string; ds?: DbtDataset; entity?: string; defaultTime?: string; dims: Map<string, Dim> }
type Result = { metric: ModelMetric; model: string } | { skip: DbtSkip; model?: string; because?: string };

const aliasOf = (i: Obj): string => String(name(own(i, 'alias')) ?? own(i, 'name'));

/** `{ name, filter, fill_nulls_with, … }` from a measure or metric input, written as a name or an object. */
function input(v: unknown): Obj | null {
  if (typeof v === 'string') return name(v) ? { name: v.trim() } : null;
  return isObj(v) && name(own(v, 'name')) ? v : null;
}

/** The where texts of a dbt filter (`{ where_filters: [{ where_sql_template }] }`, or one template); null: unreadable. */
function whereTexts(f: unknown): string[] | null {
  if (f === undefined || f === null) return [];
  const list = own(f, 'where_filters');
  const items = Array.isArray(list) ? list : own(f, 'where_sql_template') !== undefined ? [f] : null;
  if (!items) return null;
  const out: string[] = [];
  for (const w of items) {
    const t = own(w, 'where_sql_template');
    if (typeof t !== 'string') return null;
    out.push(t);
  }
  return out;
}

/** The project's datasets for each semantic model: map, then exact, then blind name; one model per dataset. */
function matchModels(sms: Obj[], datasets: readonly DbtDataset[], datasetMap: Readonly<Record<string, string>>): Map<string, DbtModelMatch> {
  const out = new Map<string, DbtModelMatch>(sms.map((s) => [s.name as string, { name: s.name as string }]));
  const taken = new Set<string>();
  const land = (m: DbtModelMatch, d: DbtDataset | undefined, how: DbtModelMatch['how']): void => {
    if (!d || taken.has(d.id) || m.how) return;
    taken.add(d.id);
    Object.assign(m, { datasetId: d.id, how });
  };
  const blind = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '');
  const one = (list: DbtDataset[]): DbtDataset | undefined => (list.length === 1 ? list[0] : undefined);
  const mapped = new Set(Object.keys(datasetMap).filter((k) => out.has(k)));
  for (const m of out.values()) if (mapped.has(m.name)) land(m, datasets.find((d) => d.id === datasetMap[m.name]), 'map');
  for (const m of out.values()) if (!mapped.has(m.name)) land(m, one(datasets.filter((d) => d.name === m.name && !taken.has(d.id))), 'exact');
  for (const m of out.values()) if (!mapped.has(m.name)) land(m, one(datasets.filter((d) => blind(d.name) === blind(m.name) && !taken.has(d.id))), 'name');
  return out;
}

export function translateDbt(json: unknown, datasets: readonly DbtDataset[], datasetMap: Readonly<Record<string, string>>): { model: ParsedModel; skipped: DbtSkipped[] } {
  const skipped: DbtSkipped[] = [];
  const seenModel = new Set<string>();
  const sms = nodes(own(json, 'semantic_models')).filter((s): s is Obj => {
    const n = name(own(s, 'name'));
    if (!n || seenModel.has(n)) return false;
    seenModel.add(n);
    return true;
  });
  const matches = matchModels(sms, datasets, datasetMap);
  const files: ModelDataset[] = [];
  const models = new Map<string, Model>();
  const measures = new Map<string, { measure: Obj; model: Model }>();

  for (const sm of sms) {
    const match = matches.get(sm.name as string) as DbtModelMatch;
    const ds = datasets.find((d) => d.id === match.datasetId);
    const entities = nodes(own(sm, 'entities')).filter(isObj);
    const primary = entities.find((e) => own(e, 'type') === 'primary' && name(own(e, 'name')));
    const model: Model = {
      name: match.name, ds, entity: name(own(primary, 'name')) ?? name(own(sm, 'primary_entity')), defaultTime: name(own(own(sm, 'defaults'), 'agg_time_dimension')), dims: new Map(),
    };
    models.set(model.name, model);
    for (const me of nodes(own(sm, 'measures'))) {
      const n = name(own(me, 'name'));
      if (n && !measures.has(n)) measures.set(n, { measure: me as Obj, model });
    }
    if (!ds) {
      files.push({ id: dbtId('semantic_model', model.name), name: model.name, base: '' }); // a2 skips it as missing, with what names it
      skipped.push({ name: model.name, kind: 'semanticModel', reason: 'no_dataset', dbt: model.name });
      continue;
    }
    const file: ModelDataset = { id: ds.id, name: model.name, base: '' };
    if (primary) {
      const col = columnOf(ds.columns, String(name(own(primary, 'expr')) ?? own(primary, 'name')));
      if (col) file.key = col.name;
      else skipped.push({ name: `${model.name} · ${own(primary, 'name')}`, kind: 'entity', reason: 'not_a_column', dbt: `${model.name}.${own(primary, 'name')}`, model: model.name });
    }
    const fields = new Map<string, ModelField>();
    for (const d of nodes(own(sm, 'dimensions'))) {
      const n = name(own(d, 'name'));
      if (!n || model.dims.has(n)) continue;
      const time = own(d, 'type') === 'time';
      const expr = own(d, 'expr');
      const found = columnOf(ds.columns, typeof expr === 'string' ? expr : n);
      const column = found && (!time || found.type === 'date') ? found : null;
      model.dims.set(n, { column, time });
      if (!column) {
        skipped.push({ name: `${model.name} · ${n}`, kind: 'dimension', reason: 'not_a_column', dbt: `${model.name}.${n}`, model: model.name });
        continue;
      }
      const description = text(own(d, 'description'), 2_000);
      const displayName = text(own(d, 'label'), 120);
      if (!description && !displayName) continue;
      const f = fields.get(column.name) ?? { name: column.name };
      if (description && !f.description) f.description = description;
      if (displayName && !f.displayName) f.displayName = displayName;
      fields.set(column.name, f);
    }
    if (fields.size) file.fields = [...fields.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    files.push(file);
  }

  // ── Metrics: simple ones first; a ratio or derived one after the inputs it names (memoized, a cycle unreadable) ──
  const raw = new Map<string, Obj>();
  for (const m of nodes(own(json, 'metrics'))) {
    const n = name(own(m, 'name'));
    if (n && !raw.has(n)) raw.set(n, m as Obj); // one with no name, or a second of one name, is not dbt's: nothing to name it by
  }
  const done = new Map<string, Result>();
  const visiting = new Set<string>();
  const nameOf = (m: Obj): string => (name(own(m, 'label'), 200) ?? name(own(m, 'name'), 200) ?? '').slice(0, 200);
  const shell = (n: string, m: Obj, ds: DbtDataset): Pick<ModelMetric, 'id' | 'name' | 'dataset' | 'base' | 'importedFrom'> & { description?: string } => {
    const description = typeof own(m, 'description') === 'string' ? (own(m, 'description') as string).trim().slice(0, 500) : '';
    return { id: dbtId('metric', n), name: nameOf(m), dataset: ds.id, base: '', importedFrom: { kind: 'dbt', name: n }, ...(description && { description }) };
  };
  const where = (texts: string[], model: Model): FilterStep[] | null => {
    const steps: FilterStep[] = [];
    for (const t of texts) {
      const s = model.entity ? parseDbtWhere(t, model.entity, (dim) => { const d = model.dims.get(dim); return d && !d.time ? d.column : null; }) : null;
      if (!s) return null;
      steps.push(...s);
    }
    const kept = sanitizeMetricFilters(steps);
    return kept.length === steps.length ? kept : null; // a step the store would drop is a filter we did not read
  };
  const dateOf = (model: Model, dim: string | undefined): string | null | undefined => {
    if (!dim) return undefined; // no time dimension at all: no date
    const d = model.dims.get(dim);
    return d?.time && d.column ? d.column.name : null;
  };

  const simple = (n: string, m: Obj): Result => {
    const inp = input(own(own(m, 'type_params'), 'measure'));
    const found = inp ? measures.get(own(inp, 'name') as string) : undefined;
    if (!inp || !found) return { skip: 'unreadable' };
    const { measure, model } = found;
    const ds = model.ds;
    if (!ds) return { skip: 'no_dataset', model: model.name };
    const at = { model: model.name };
    if (own(inp, 'fill_nulls_with') !== undefined && own(inp, 'fill_nulls_with') !== null) return { skip: 'fill_nulls', ...at };
    const agg = AGG[String(own(measure, 'agg'))];
    if (!agg || (own(measure, 'agg_params') !== undefined && own(measure, 'agg_params') !== null)) return { skip: 'unknown_aggregation', ...at };
    const expr = own(measure, 'expr');
    const column = columnOf(ds.columns, typeof expr === 'string' ? expr : String(own(measure, 'name')));
    if (!column || (NEEDS_NUMBER.has(agg) && column.type !== 'number')) return { skip: 'not_a_column', ...at };
    let snapshot: { column: string; take: 'last' | 'first' } | undefined;
    const nad = own(measure, 'non_additive_dimension');
    if (nad !== undefined && nad !== null) {
      if (nodes(own(nad, 'window_groupings')).length) return { skip: 'window_groupings', ...at };
      const col = dateOf(model, name(own(nad, 'name')));
      if (!col) return { skip: 'not_a_column', ...at };
      const choice = own(nad, 'window_choice');
      if (choice !== 'max' && choice !== 'min') return { skip: 'unknown_aggregation', ...at };
      if (ds.live) return { skip: 'live_refused', ...at }; // part 1 D8: a snapshot's day is not compiled for a warehouse yet
      snapshot = { column: col, take: choice === 'max' ? 'last' : 'first' };
    }
    const timeColumn = dateOf(model, name(own(measure, 'agg_time_dimension')) ?? model.defaultTime);
    if (timeColumn === null) return { skip: 'not_a_column', ...at };
    const texts = [whereTexts(own(inp, 'filter')), whereTexts(own(m, 'filter'))];
    const filters = texts[0] && texts[1] ? where([...new Set([...texts[0], ...texts[1]])], model) : null; // one condition twice is once
    if (!filters) return { skip: 'filter_shape', ...at };
    const definition = sanitizeDefinition({ column: column.name, aggregation: agg, ...(snapshot && { snapshot }) });
    return {
      metric: { ...shell(n, m, ds), definition, ...(filters.length && { filters }), format: sanitizeFormat(formatFor(column.name, agg)), ...(timeColumn && { timeColumn }) },
      model: model.name,
    };
  };

  /** A ratio's or derived metric's inputs: each one's translation, by its alias (else its name). */
  const formula = (n: string, m: Obj, inputs: Obj[], body: (refs: Map<string, ModelMetric>) => string | null): Result => {
    if (!inputs.length) return { skip: 'unreadable' };
    if (inputs.some((i) => own(i, 'offset_window') != null || own(i, 'offset_to_grain') != null)) return { skip: 'time_offset' };
    const results = inputs.map((i) => ({ i, r: translate(own(i, 'name') as string) }));
    const at = new Set(results.map(({ r }) => r.model).filter((x) => x !== undefined));
    if (at.size > 1) return { skip: 'cross_model' };
    const model = [...at][0];
    const fell = results.find(({ r }) => 'skip' in r);
    if (fell) {
      const r = fell.r as { skip: DbtSkip; because?: string };
      return { skip: r.skip, model, because: r.because ?? (own(fell.i, 'name') as string) };
    }
    if (inputs.some((i) => own(i, 'filter') != null) || own(m, 'filter') != null) return { skip: 'filter_shape', model }; // a formula's filters reach none of the metrics it names
    const refs = new Map<string, ModelMetric>();
    for (const { i, r } of results) {
      const key = aliasOf(i);
      const metric = (r as { metric: ModelMetric }).metric;
      if (refs.has(key) && refs.get(key) !== metric) return { skip: 'unreadable', model }; // one alias, two metrics
      refs.set(key, metric);
    }
    const metrics = [...refs.values()];
    if (metrics.some((x) => /[[\]]/.test(x.name)) || new Set(metrics.map((x) => x.timeColumn ?? '')).size > 1) return { skip: 'unreadable', model };
    const f = body(refs);
    if (!f || f.length > MAX_FORMULA) return { skip: 'unreadable', model };
    const ds = models.get(model as string)?.ds as DbtDataset;
    const definition: MetricDefinition = sanitizeDefinition({ formula: f });
    return { metric: { ...shell(n, m, ds), definition, format: FORMULA_FORMAT, ...(metrics[0].timeColumn && { timeColumn: metrics[0].timeColumn }) }, model: model as string };
  };

  function translate(n: string): Result {
    const hit = done.get(n);
    if (hit) return hit;
    const m = raw.get(n);
    if (!m || visiting.has(n)) return { skip: 'unreadable' };
    visiting.add(n);
    const tp = own(m, 'type_params');
    let r: Result;
    switch (own(m, 'type')) {
      case 'simple':
        r = simple(n, m);
        break;
      case 'ratio': {
        const num = input(own(tp, 'numerator'));
        const den = input(own(tp, 'denominator'));
        r = num && den ? formula(n, m, [num, den], (refs) => `[${refs.get(aliasOf(num))?.name}] / [${refs.get(aliasOf(den))?.name}]`) : { skip: 'unreadable' };
        break;
      }
      case 'derived': {
        const expr = own(tp, 'expr');
        const inputs = nodes(own(tp, 'metrics')).map(input);
        r = typeof expr === 'string' && inputs.every((x) => x) ? formula(n, m, inputs as Obj[], (refs) => derivedFormula(expr, refs)) : { skip: 'unreadable' };
        break;
      }
      case 'cumulative':
        r = { skip: 'cumulative' };
        break;
      case 'conversion':
        r = { skip: 'conversion' };
        break;
      default:
        r = { skip: 'unreadable' };
    }
    visiting.delete(n);
    done.set(n, r);
    return r;
  }

  const metrics: ModelMetric[] = [];
  for (const [n, m] of raw) {
    const r = translate(n);
    if ('metric' in r) metrics.push(r.metric);
    else skipped.push({ name: nameOf(m) || n, kind: 'metric', reason: r.skip, dbt: n, ...(r.model && { model: r.model }), ...(r.because && { because: r.because }) });
  }

  const model: ParsedModel = {
    manifest: { format: 'dbt', formatVersion: 1, appVersion: '', project: { name: '' }, calendar: DEFAULT_CALENDAR },
    datasets: files,
    guides: new Map(),
    metrics,
    terms: [],
    relationships: [],
    invalid: [],
    dbt: { models: [...matches.values()], skipped },
  };
  return { model, skipped };
}

const TOKEN = /\s*(?:([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)(?![\w.])|([-+*/()]))/y;

/** A derived metric's `expr` over its inputs' aliases, as an Ordinate formula; null for anything but names, numbers, + − × ÷ and brackets. */
function derivedFormula(expr: string, refs: ReadonlyMap<string, ModelMetric>): string | null {
  let out = '';
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.length) {
    const at = TOKEN.lastIndex;
    const t = TOKEN.exec(expr);
    if (!t) return /^\s*$/.test(expr.slice(at)) ? `(${out.trim()})` : null;
    const space = expr.slice(at, at + t[0].length - (t[1] ?? t[2] ?? t[3]).length);
    if (t[1] !== undefined) {
      const ref = refs.get(t[1]);
      if (!ref) return null;
      out += `${space}[${ref.name}]`;
    } else out += space + (t[2] ?? t[3]);
  }
  return out.trim() ? `(${out.trim()})` : null;
}
