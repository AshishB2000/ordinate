// A metric tree node SPLIT BY A COLUMN — MAIN PROCESS. Each segment's figure in
// both periods, and its contribution to the node's change.
//
// The figures come through the chart door (`vizDataFor`): the metric's driver
// operands (analysis/driverShape — sum, count, and an avg's numeric count) by
// the split column, one grouped question per period and per set of operand
// filters. So the resident fast path, the JS reference and a Live warehouse are
// whatever the door already does — never rows hydrated here. The contribution
// is key drivers' own arithmetic (analysis/drivers.memberEffects): a segment's
// own change for an additive metric, its midpoint mix + rate for a ratio.

import type { FilterStep } from '../data/transforms';
import type { Metric } from '../analysis/metrics';
import type { ParsedColumn } from '../data/parse';
import type { VizEncoding } from '../analysis/visuals';
import type { ParamValues } from '../analysis/params';
import { metricShape, evalLinear } from '../analysis/driverShape';
import type { DriverShape, Operand } from '../analysis/driverShape';
import { memberEffects } from '../analysis/drivers';
import type { MemberAgg } from '../analysis/drivers';
import * as metrics from '../analysis/metrics';
import * as msg from '../analysis/metricTreeMessages';
import { topSegments } from '../analysis/metricTreeMath';
import { vizDataFor } from './visuals';

/** The chart door folds a text axis past this many values — and per period, so the buckets would not line up. */
export const SPLIT_MAX_VALUES = 50;

export interface Segment {
  key: string;
  label: string;
  /** The segment's own figure (its value, or its own rate for a ratio). */
  current: number | null;
  previous: number | null;
  /** Its contribution to the node's change. */
  contribution: number;
  mix?: number;
  rate?: number;
  /** "Other (n)": the segments past the top ones, folded. */
  rest?: number;
}

export type SplitResult = { ok: true; segments: Segment[]; additive: boolean } | { ok: false; error: string; code?: string };

/** The folded tail's key: no cell can hold it. */
export const OTHER_KEY = '\u0000other';

/**
 * Finite numeric cells of `column`: an avg's denominator, asked as a count. A
 * number comparison keeps only finite numbers in both the JS fold and the SQL
 * (transforms.ts: a non-number cell is never kept by `>=`).
 * ponytail: a cell below −9e18 is dropped too — the bound must pass the strict
 * number parser AND bind as an int64 (DuckDB binds an integral JS number as
 * BIGINT; −1e308 overflows it). An `is_number` filter op is the upgrade.
 */
const finiteOnly = (column: string): FilterStep => ({ type: 'filter', column, op: '>=', value: '-9e18' } as FilterStep);

/** One question per set of filters: which operands it answers, in order. */
function questions(ops: Operand[]): Array<{ filters: FilterStep[]; ops: number[] }> {
  const out = new Map<string, { filters: FilterStep[]; ops: number[] }>();
  ops.forEach((op, i) => {
    const filters = op.agg === 'ncount' ? op.filters.concat([finiteOnly(op.column)]) : op.filters;
    const key = JSON.stringify(filters);
    const q = out.get(key) ?? { filters, ops: [] };
    q.ops.push(i);
    out.set(key, q);
  });
  return [...out.values()];
}

/** Operand values per segment key for ONE period, or a refusal. */
async function operandsBy(
  projectId: string,
  datasetId: string,
  column: string,
  shape: Exclude<DriverShape, { kind: 'none' }>,
  scope: FilterStep[],
  params: ParamValues,
): Promise<{ ok: true; by: Map<string, Array<number | null>>; order: string[] } | { ok: false; error: string; code?: string }> {
  const by = new Map<string, Array<number | null>>();
  const order: string[] = [];
  for (const q of questions(shape.operands)) {
    const encoding: VizEncoding = {
      category: column,
      values: q.ops.map((i) => ({ column: shape.operands[i].column, aggregation: shape.operands[i].agg === 'sum' ? 'sum' : 'count' })),
    };
    const reply = await vizDataFor(projectId, datasetId, encoding, q.filters.concat(scope), { params });
    if (!reply.ok) return { ok: false, error: reply.error, ...(reply.code ? { code: reply.code } : {}) };
    if (reply.category?.note) return { ok: false, error: msg.splitTooMany(column, SPLIT_MAX_VALUES) };
    reply.data.labels.forEach((label, row) => {
      const key = String(label);
      let vals = by.get(key);
      if (!vals) {
        vals = new Array<number | null>(shape.operands.length).fill(null);
        by.set(key, vals);
        order.push(key);
      }
      q.ops.forEach((op, j) => {
        const v = reply.data.series[j]?.values[row];
        (vals as Array<number | null>)[op] = typeof v === 'number' && Number.isFinite(v) ? v : null;
      });
    });
  }
  return { ok: true, by, order };
}

const zero = (v: number | null): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Σ of each operand over some members. */
function sumOps(rows: Array<Array<number | null>>, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  for (const r of rows) for (let i = 0; i < n; i += 1) out[i] += zero(r[i]);
  return out;
}

/** The metric's figure from operand totals. */
export function figureOf(shape: Exclude<DriverShape, { kind: 'none' }>, ops: number[]): number | null {
  const n = evalLinear(shape.num, ops);
  if (shape.kind === 'additive' || n === null) return n;
  const d = evalLinear(shape.den, ops);
  return d === null || d === 0 ? null : n / d;
}

/**
 * The segments of `metric` by `column` under the two periods' filters, each
 * with its contribution to the change: the largest `SEGMENTS_SHOWN` by
 * |contribution|, then "Other (n)" — its operands summed and its figure
 * recomputed from them, its effects summed.
 */
export async function splitSegments(
  projectId: string,
  metric: Metric,
  columns: ParsedColumn[],
  column: string,
  scopes: { current: FilterStep[]; previous: FilterStep[] },
  params: ParamValues,
): Promise<SplitResult> {
  const col = columns.find((c) => c.name === column);
  if (!col) return { ok: false, error: msg.splitColumnGone(column) };
  if (col.type !== 'text') return { ok: false, error: msg.splitNotText(column) };
  const shape = metricShape(metric.datasetId, columns, metric.definition, metric.filters, await metrics.metricsByName(projectId), params, metric.name);
  if (shape.kind === 'none') return { ok: false, error: shape.reason };

  const [a, b] = await Promise.all([
    operandsBy(projectId, metric.datasetId, column, shape, scopes.current, params),
    operandsBy(projectId, metric.datasetId, column, shape, scopes.previous, params),
  ]);
  if (!a.ok) return a;
  if (!b.ok) return b;
  const keys = a.order.concat(b.order.filter((k) => !a.by.has(k)));
  const n = shape.operands.length;
  const empty = (): Array<number | null> => new Array<number | null>(n).fill(0);
  const members: MemberAgg[] = keys.map((key) => ({ key, a: a.by.get(key) ?? empty(), b: b.by.get(key) ?? empty() }));
  const totalOps = { a: sumOps(members.map((m) => m.a), n), b: sumOps(members.map((m) => m.b), n) };
  const ta = figureOf(shape, totalOps.a);
  const tb = figureOf(shape, totalOps.b);
  const effects = memberEffects(shape, { column, members }, { a: ta, b: tb, delta: ta !== null && tb !== null ? ta - tb : null }, totalOps);
  if (!effects) return { ok: false, error: msg.splitNoFigure(metric.name) };

  const all: Segment[] = effects.map((e) => ({
    key: e.key,
    label: e.label,
    current: e.a,
    previous: e.b,
    contribution: e.delta,
    ...(e.mix !== undefined ? { mix: e.mix, rate: e.rate as number } : {}),
  }));
  const pick = topSegments(all);
  const segments = pick.shown.map((i) => all[i]);
  if (pick.rest.length) {
    const rest = pick.rest.map((i) => all[i]);
    const other: Segment = {
      key: OTHER_KEY,
      label: msg.otherSegments(rest.length),
      current: figureOf(shape, sumOps(pick.rest.map((i) => members[i].a), n)),
      previous: figureOf(shape, sumOps(pick.rest.map((i) => members[i].b), n)),
      contribution: rest.reduce((s, x) => s + x.contribution, 0),
      rest: rest.length,
    };
    if (shape.kind === 'ratio') {
      other.mix = rest.reduce((s, x) => s + (x.mix ?? 0), 0);
      other.rate = rest.reduce((s, x) => s + (x.rate ?? 0), 0);
    }
    segments.push(other);
  }
  return { ok: true, segments, additive: shape.kind === 'additive' };
}
