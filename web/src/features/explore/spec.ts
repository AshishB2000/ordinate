// Explore's question (docs/explore/00-design.md): the URL form, the edits a
// click makes, and its title in words. PURE, with type-only imports, so the
// e2e (Node, type-stripped) builds its links with this same code.
//
// `q` = base64url of the UTF-8 JSON {t: chartType, e: encoding, f: filters}.
// A link is user input: this file only checks its SHAPE, so a bad one cannot
// crash the page (it opens on the suggestions instead). The server is the
// validator — `VizDataInput`, then sanitizeEncoding / sanitizeFilters — on
// every read. `t` never leaves the browser. Nothing here computes a figure.

import type { Agg, Encoding, FilterStep, Measure } from '../visuals/encoding';

export interface Question {
  /** '' = the first chart the answer suits. */
  chartType: string;
  encoding: Encoding;
  filters: FilterStep[];
}

export type FieldKind = 'dimension' | 'date' | 'measure';

/** A field as the field list and the pickers hold it (explore:suggest's groups). */
export interface Field {
  name: string;
  kind: FieldKind;
  type: 'text' | 'number' | 'date';
  /** A measure's aggregate when it is added: the server's (starterPlan.aggregationFor). */
  aggregation?: 'sum' | 'avg';
}

export const EMPTY: Question = { chartType: '', encoding: { category: '', values: [] }, filters: [] };

const AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max', 'none']);
const GRAINS: ReadonlySet<string> = new Set(['day', 'week', 'month', 'quarter', 'year']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

export function encodeQuestion(q: Question): string {
  const json = JSON.stringify({ ...(q.chartType ? { t: q.chartType } : {}), e: q.encoding, ...(q.filters.length ? { f: q.filters } : {}) });
  let bin = '';
  for (const b of new TextEncoder().encode(json)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The question a `q` parameter holds, or null — absent, not base64url JSON, or not the right shape. */
export function decodeQuestion(raw: string | null | undefined): Question | null {
  if (!raw || raw.length > 20_000) return null;
  let o: unknown;
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
  if (!isObj(o) || !isObj(o.e)) return null;
  const { category, values: rows, grain, series, geo } = o.e;
  if (!str(category) || !Array.isArray(rows)) return null;
  const values: Measure[] = [];
  for (const v of rows as unknown[]) {
    if (isObj(v) && str(v.column) && v.column && str(v.aggregation) && AGGS.has(v.aggregation)) values.push({ column: v.column, aggregation: v.aggregation as Agg });
  }
  const encoding: Encoding = { category, values };
  if (str(grain) && GRAINS.has(grain)) encoding.grain = grain;
  if (str(series) && series) encoding.series = series;
  if (isObj(geo) && str(geo.level)) encoding.geo = { level: geo.level as NonNullable<Encoding['geo']>['level'] };
  const filters = (Array.isArray(o.f) ? o.f : []).filter((f): f is FilterStep => isObj(f) && f.type === 'filter' && str(f.column) && str(f.op));
  return { chartType: str(o.t) ? o.t : '', encoding, filters };
}

/** Enough to ask: something to group by and something to show. */
export const isComplete = (q: Question): boolean => !!q.encoding.category && q.encoding.values.length > 0;

/** Where a field sits in the question, if it does. */
export function roleOf(q: Question, name: string): 'measure' | 'category' | 'series' | null {
  if (q.encoding.values.some((v) => v.column === name)) return 'measure';
  if (q.encoding.category === name) return 'category';
  if (q.encoding.series === name) return 'series';
  return null;
}

/** `e` without the date-only keys (a grain), and without the map regions of the old axis. */
function axis(e: Encoding, category: string, kind: FieldKind | null): Encoding {
  const { grain: _g, geo: _m, ...rest } = e;
  return { ...rest, category, ...(kind === 'date' ? { grain: 'month' } : {}) };
}

/** Which kind of field a column is — the field list's, so the question needs no column types of its own. */
export type KindOf = (name: string) => FieldKind | undefined;

/**
 * A click on a field: a measure joins (or leaves) what is shown; a dimension or
 * a date becomes what the answer is grouped by (or stops being it, or stops
 * splitting it). A date starts at month grain.
 */
export function withField(q: Question, f: Field, kindOf: KindOf): Question {
  const e = q.encoding;
  if (f.kind === 'measure') {
    return withValues(
      q,
      e.values.some((v) => v.column === f.name) ? e.values.filter((v) => v.column !== f.name) : [...e.values, { column: f.name, aggregation: f.aggregation ?? 'sum' }],
    );
  }
  if (e.series === f.name) return withSplit(q);
  if (e.category === f.name) return { ...q, encoding: axis(e, '', null) };
  return groupBy(q, f, kindOf);
}

/**
 * The measures shown, replaced. One measure and several are different shapes
 * of answer: crossing between them goes back to the chart that suits the new
 * one (CONTROL in spec.test: a swap of one measure for another keeps the pick).
 */
export function withValues(q: Question, values: Measure[]): Question {
  const several = (n: number) => n > 1;
  return { ...q, chartType: several(values.length) === several(q.encoding.values.length) ? q.chartType : '', encoding: { ...q.encoding, values } };
}

/** Split by `series`, or by nothing — a split is several series: the chart goes back to the one that suits it. */
export function withSplit(q: Question, series?: string): Question {
  const e = withoutSplit(q.encoding);
  return { ...q, chartType: !!series === !!q.encoding.series ? q.chartType : '', encoding: series ? { ...e, series } : e };
}

export function withoutSplit(e: Encoding): Encoding {
  const { series: _s, seriesDatasetId: _d, ...rest } = e;
  return rest;
}

/**
 * Group by `f`. An axis of another kind (a date for a text column, or back)
 * goes back to the chart that suits it: a column chart picked for regions is
 * not what a run of months asks for.
 */
export function groupBy(q: Question, f: Field, kindOf: KindOf): Question {
  const e = q.encoding.series === f.name ? withoutSplit(q.encoding) : q.encoding;
  const sameKind = !!e.category && kindOf(e.category) === f.kind;
  return { ...q, chartType: sameKind ? q.chartType : '', encoding: axis(e, f.name, f.kind) };
}

/** Group by nothing (the Group by well's remove). */
export const ungroup = (q: Question): Question => ({ ...q, encoding: axis(q.encoding, '', null) });

const AGG_WORD: Record<Agg, string> = { sum: 'total', avg: 'average', count: 'count of', min: 'lowest', max: 'highest', none: '' };

const listed = (xs: string[]): string => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "Total revenue by region", "Average discount by month of order_date, split by segment". Words, never a figure. */
export function questionTitle(e: Encoding): string {
  const shown = listed(e.values.map((v) => `${AGG_WORD[v.aggregation] ?? ''} ${v.column}`.trim()));
  if (!shown || !e.category) return 'New question';
  const by = e.grain ? `by ${e.grain} of ${e.category}` : `by ${e.category}`;
  const text = `${shown} ${by}${e.series ? `, split by ${e.series}` : ''}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
