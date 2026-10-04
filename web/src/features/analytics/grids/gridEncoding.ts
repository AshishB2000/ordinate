// The grid chart types' encodings — pivotBuilder.ts (pivotFromEncoding,
// encodingFromPivot, setColumns' defaults, getPivot) and cohortBuilder.ts
// (setColumns' guesses, encodingFor, needs, suggestName), as pure functions.
//
// A grid's encoding carries its own block (`pivot`, `cohort`, `eventFunnel`)
// AND mirrored chart fields (category / series / values), so every surface
// that reads an encoding without knowing grids — the drill panel, the dock,
// lineage, a switch back to a column chart — keeps working. The server does
// every figure: nothing here reads a row.

import type { Agg, Encoding, Measure } from '../../visuals/api';
import type { Column } from '../../visuals/model';

export type Shelf = 'rows' | 'columns' | 'values';
export const SHELF_LIMITS: Record<Shelf, number> = { rows: 3, columns: 2, values: 4 };
export const PIVOT_AGGS: readonly Exclude<Agg, 'none'>[] = ['sum', 'avg', 'count', 'min', 'max'];

export interface PivotDim {
  column: string;
  grain?: string;
}
export interface PivotValue {
  column: string;
  aggregation: Exclude<Agg, 'none'>;
  format?: string;
  showAs?: string;
  metricId?: string;
  calc?: Record<string, unknown>;
}
export interface PivotCond {
  valueIdx: number;
  kind: string;
  threshold?: number;
}
export interface Pivot {
  rows: PivotDim[];
  columns: PivotDim[];
  values: PivotValue[];
  totals: { rows: boolean; columns: boolean; grand: boolean };
  sort?: { by: 'label' | number; dir: 'asc' | 'desc' };
  topN?: { n: number; byValueIdx: number };
  conditional?: PivotCond[];
}

const AGG_SET: ReadonlySet<string> = new Set(PIVOT_AGGS);
const aggOf = (a: unknown): Exclude<Agg, 'none'> => (AGG_SET.has(String(a)) ? (a as Exclude<Agg, 'none'>) : 'sum');

/** A calc's axis flips between a chart (category runs across) and a pivot (rows run down) — calcMenu tcSwapAxis. */
function swapAxis(calc: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!calc) return undefined;
  const axis = calc.axis === 'down' ? 'across' : calc.axis === 'across' ? 'down' : calc.axis;
  return axis === undefined ? { ...calc } : { ...calc, axis };
}

/** Rows/Columns take dimensions and dates; Values take any column. */
export const poolFor = (shelf: Shelf, cols: readonly Column[]): Column[] => (shelf === 'values' ? cols.slice() : cols.filter((c) => c.type !== 'number'));

/** A chart encoding carried over to a pivot: category → first row, split → first column, measures → values. */
export function pivotFromEncoding(enc: Partial<Encoding>): Pivot {
  const values = Array.isArray(enc.values) ? enc.values : [];
  return {
    rows: enc.category ? [{ column: enc.category }] : [],
    columns: enc.series ? [{ column: enc.series }] : [],
    values: values.slice(0, SHELF_LIMITS.values).map((v: Measure) => {
      const out: PivotValue = { column: v.column, aggregation: v.aggregation === 'none' ? 'sum' : aggOf(v.aggregation) };
      const calc = swapAxis(v.calc as Record<string, unknown> | undefined);
      if (calc) out.calc = calc;
      return out;
    }),
    totals: { rows: true, columns: true, grand: true },
  };
}

/** And back: only the first row / column survive — a chart has one category and one split. */
export function encodingFromPivot(p: Pivot): Encoding {
  const out: Encoding = {
    category: p.rows[0]?.column ?? '',
    values: p.values.map((v) => {
      const m: Measure = { column: v.column, aggregation: v.aggregation || 'sum' };
      const calc = swapAxis(v.calc);
      if (calc) m.calc = calc;
      return m;
    }),
  };
  if (p.columns[0]) out.series = p.columns[0].column;
  if (p.rows[0]?.grain) out.grain = p.rows[0].grain;
  return out;
}

/** A saved (or carried-over) pivot made to fit these columns; a fresh one gets the first dimension and measure. */
export function fitPivot(raw: unknown, cols: readonly Column[]): Pivot {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const has = (name: unknown) => typeof name === 'string' && cols.some((c) => c.name === name);
  const dims = (list: unknown, cap: number): PivotDim[] =>
    (Array.isArray(list) ? list : [])
      .filter((d) => d && has(d.column))
      .slice(0, cap)
      .map((d) => (typeof d.grain === 'string' && d.grain ? { column: String(d.column), grain: d.grain } : { column: String(d.column) }));
  const out: Pivot = {
    rows: dims(p.rows, SHELF_LIMITS.rows),
    columns: dims(p.columns, SHELF_LIMITS.columns),
    values: (Array.isArray(p.values) ? p.values : [])
      .filter((v) => v && has(v.column))
      .slice(0, SHELF_LIMITS.values)
      .map((v) => {
        const o: PivotValue = { column: String(v.column), aggregation: aggOf(v.aggregation) };
        if (typeof v.format === 'string') o.format = v.format;
        if (typeof v.showAs === 'string' && v.showAs !== 'value') o.showAs = v.showAs;
        if (typeof v.metricId === 'string') o.metricId = v.metricId;
        if (v.calc && typeof v.calc === 'object') o.calc = v.calc;
        return o;
      }),
    totals: { rows: true, columns: true, grand: true },
  };
  if (!out.rows.length) {
    const first = poolFor('rows', cols)[0];
    if (first) out.rows.push({ column: first.name });
  }
  if (!out.values.length) {
    const num = cols.find((c) => c.type === 'number') ?? cols[0];
    if (num) out.values.push({ column: num.name, aggregation: num.type === 'number' ? 'sum' : 'count' });
  }
  const t = p.totals && typeof p.totals === 'object' ? (p.totals as Record<string, unknown>) : null;
  if (t) out.totals = { rows: !!t.rows, columns: !!t.columns, grand: !!t.grand };
  const sort = p.sort as Pivot['sort'] | undefined;
  if (sort && (sort.by === 'label' || typeof sort.by === 'number')) out.sort = { by: sort.by, dir: sort.dir === 'desc' ? 'desc' : 'asc' };
  const top = p.topN as Pivot['topN'] | undefined;
  if (top && typeof top.n === 'number' && top.n > 0) out.topN = { n: Math.floor(top.n), byValueIdx: 0 };
  const conds = (Array.isArray(p.conditional) ? p.conditional : []).filter(
    (c): c is PivotCond => !!c && typeof c.valueIdx === 'number' && c.valueIdx < out.values.length && typeof c.kind === 'string',
  );
  if (conds.length) out.conditional = conds.map((c) => (c.kind === 'threshold' ? { valueIdx: c.valueIdx, kind: c.kind, threshold: c.threshold ?? 0 } : { valueIdx: c.valueIdx, kind: c.kind }));
  return out;
}

/** The full encoding a pivot draws with: its block plus the mirrored chart fields (and small multiples, kept). */
export function pivotEncoding(p: Pivot, facet?: unknown): Encoding {
  return { ...encodingFromPivot(p), pivot: p, ...(facet ? { facet } : {}) };
}

/** Removing value `i` shifts the conditional rules that point past it. */
export function dropValue(p: Pivot, i: number): Pivot {
  const conditional = (p.conditional ?? []).filter((c) => c.valueIdx !== i).map((c) => (c.valueIdx > i ? { ...c, valueIdx: c.valueIdx - 1 } : c));
  const next: Pivot = { ...p, values: p.values.filter((_, j) => j !== i) };
  if (conditional.length) next.conditional = conditional;
  else delete next.conditional;
  return next;
}

/** "First seen" · "Row labels, descending" · "Column 2, ascending" — the Sort row's summary. */
export function sortSummary(sort: Pivot['sort']): string {
  if (!sort) return 'First seen';
  const dir = sort.dir === 'desc' ? 'descending' : 'ascending';
  return sort.by === 'label' ? `Row labels, ${dir}` : `Column ${sort.by + 1}, ${dir}`;
}

// ── Cohort and event funnel (cohortBuilder.ts) ─────────────────────────────

export type EngineKind = 'cohort' | 'event_funnel';
export const engineKind = (type: string): EngineKind | '' => (type === 'cohort' || type === 'event_funnel' ? type : '');

export interface CohortBlock {
  entity: string;
  date: string;
  value?: string;
  grain: 'week' | 'month' | 'quarter';
  show: 'retention' | 'value';
  curve: boolean;
}
export interface FunnelBlock {
  entity: string;
  event: string;
  time: string;
  steps: string[];
  window: { n: number; unit: 'hours' | 'days' };
  breakdown?: string;
}

const ID_RE = /(^|[\s_-])(user|customer|client|account|member|visitor|player|patient|entity|id)([\s_-]|id$|$)/i;
const EVENT_RE = /event|action|activity|step|stage|type|name/i;
export const MAX_STEPS = 8;

/** Non-date columns, for an entity. */
export const entityPool = (cols: readonly Column[]): Column[] => cols.filter((c) => c.type !== 'date');

function guessEntity(cols: readonly Column[]): string {
  const pool = entityPool(cols);
  return (pool.find((c) => ID_RE.test(c.name)) ?? pool.find((c) => c.type === 'text') ?? pool[0])?.name ?? '';
}
const firstDate = (cols: readonly Column[]): string => cols.find((c) => c.type === 'date')?.name ?? '';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A saved cohort block made to fit these columns, or the builder's first guess. */
export function fitCohort(raw: unknown, cols: readonly Column[]): CohortBlock {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const has = (n: string) => cols.some((x) => x.name === n);
  const value = c && has(str(c.value)) ? str(c.value) : '';
  const out: CohortBlock = {
    entity: c && has(str(c.entity)) ? str(c.entity) : guessEntity(cols),
    date: c && has(str(c.date)) ? str(c.date) : firstDate(cols),
    grain: c && (c.grain === 'week' || c.grain === 'quarter') ? c.grain : 'month',
    show: c && c.show === 'value' && value ? 'value' : 'retention',
    curve: !!(c && c.curve),
  };
  if (value) out.value = value;
  return out;
}

/** A saved funnel block made to fit these columns, or the builder's first guess. */
export function fitFunnel(raw: unknown, cols: readonly Column[]): FunnelBlock {
  const f = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const has = (n: string) => cols.some((x) => x.name === n);
  const entity = f && has(str(f.entity)) ? str(f.entity) : guessEntity(cols);
  const texts = cols.filter((x) => x.type === 'text' && x.name !== entity);
  const w = f && f.window && typeof f.window === 'object' ? (f.window as Record<string, unknown>) : null;
  const out: FunnelBlock = {
    entity,
    event: f && has(str(f.event)) ? str(f.event) : ((texts.find((x) => EVENT_RE.test(x.name)) ?? texts[0])?.name ?? ''),
    time: f && has(str(f.time)) ? str(f.time) : firstDate(cols),
    steps: f && Array.isArray(f.steps) ? f.steps.filter((s): s is string => typeof s === 'string').slice(0, MAX_STEPS) : [],
    window: w ? { n: Number(w.n) > 0 ? Number(w.n) : 7, unit: w.unit === 'hours' ? 'hours' : 'days' } : { n: 7, unit: 'days' },
  };
  if (f && has(str(f.breakdown))) out.breakdown = str(f.breakdown);
  return out;
}

/** The engine block plus the mirrored chart fields (category = the date / event column, values = a count of the entity). */
export function engineEncoding(kind: EngineKind, block: CohortBlock | FunnelBlock): Encoding {
  if (kind === 'cohort') {
    const c = block as CohortBlock;
    const cohort: CohortBlock = { entity: c.entity, date: c.date, grain: c.grain, show: c.show, curve: c.curve };
    if (c.value) cohort.value = c.value;
    const values: Measure[] = c.entity || c.value ? [{ column: c.value || c.entity, aggregation: c.value ? 'sum' : 'count' }] : [];
    return { category: c.date, values, cohort };
  }
  const f = block as FunnelBlock;
  const eventFunnel: FunnelBlock = { entity: f.entity, event: f.event, time: f.time, steps: f.steps.slice(), window: { ...f.window } };
  if (f.breakdown) eventFunnel.breakdown = f.breakdown;
  return { category: f.event, values: f.entity ? [{ column: f.entity, aggregation: 'count' }] : [], eventFunnel };
}

/** '' when `kind` can be saved; otherwise what is missing. */
export function engineNeeds(kind: EngineKind, enc: Encoding): string {
  if (kind === 'cohort') {
    const c = enc.cohort as CohortBlock | undefined;
    if (!c?.entity || !c.date) return 'Pick an entity and an event date for the cohort.';
    if (c.show === 'value' && !c.value) return 'Pick a value column, or show retention.';
    return '';
  }
  const f = enc.eventFunnel as FunnelBlock | undefined;
  if (!f?.entity || !f.event || !f.time) return 'Pick an entity, an event name and a timestamp for the funnel.';
  if (f.steps.length < 2) return 'Add at least two steps before saving the funnel.';
  return '';
}

/** "Retention cohorts of customer_id (monthly)" · "Funnel: visit → purchase". */
export function engineName(kind: EngineKind, enc: Encoding): string {
  if (kind === 'cohort') {
    const c = enc.cohort as CohortBlock | undefined;
    if (!c) return '';
    const grain = c.grain === 'week' ? 'weekly' : c.grain === 'quarter' ? 'quarterly' : 'monthly';
    return c.show === 'value' ? `${c.value} per ${c.entity} cohorts (${grain})` : `Retention cohorts of ${c.entity} (${grain})`;
  }
  const f = enc.eventFunnel as FunnelBlock | undefined;
  return f && f.steps.length ? `Funnel: ${f.steps[0]} → ${f.steps[f.steps.length - 1]}` : '';
}

/** What a grid's block lacks before the server can draw it, so the stage does not ask yet ('' = ready). */
export function gridReady(type: string, enc: Encoding): boolean {
  if (type === 'pivot') {
    const p = enc.pivot as Pivot | undefined;
    return !!p && p.rows.length > 0 && p.values.length > 0;
  }
  const kind = engineKind(type);
  return kind ? !!(kind === 'cohort' ? enc.cohort : enc.eventFunnel) : true;
}

/** Strip every grid block: what an ordinary chart type keeps of an encoding. */
function plain(enc: Encoding): Encoding {
  const { pivot: _p, cohort: _c, eventFunnel: _f, ...rest } = enc;
  return rest as Encoding;
}

/** A chart type's encoding family: the pivot, one of the two engines, or an ordinary chart. */
const family = (type: string): string => (type === 'pivot' ? 'pivot' : engineKind(type) || 'chart');

/**
 * The encoding after the chart type moves `from` → `to` (vizBuilder's onSelect):
 * entering a pivot carries the chart fields over, leaving one hands its first
 * row / column / values back; a cohort / funnel hands back its mirrored fields.
 * Within one family the encoding is returned unchanged.
 */
export function switchEncoding(enc: Encoding, from: string, to: string, cols: readonly Column[]): Encoding {
  if (family(from) === family(to)) return enc;
  const facet = enc.facet;
  if (to === 'pivot') return pivotEncoding(fitPivot(enc.pivot ?? pivotFromEncoding(plain(enc)), cols), facet);
  if (to === 'cohort') return engineEncoding('cohort', fitCohort(enc.cohort, cols));
  if (to === 'event_funnel') return engineEncoding('event_funnel', fitFunnel(enc.eventFunnel, cols));
  // Back to an ordinary chart: a pivot's first row / column / values, or the engine's mirrored fields.
  return enc.pivot ? { ...encodingFromPivot(enc.pivot as Pivot), ...(facet ? { facet } : {}) } : plain(enc);
}
