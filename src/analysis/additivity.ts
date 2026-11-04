// Can a measure be added up? (semantic layer part 1, D7) Derived from what the measure IS, never typed in.
// A running total, a percent of total and a moving sum add the measure's values, so they are right only when
// the values add: a sum of averages is not an average. A snapshot (a stock count) adds across categories but
// not across time.
//
//   categories   the values of two members of a dimension (two regions) add to the whole
//   time         the values of two periods (two days) add to the whole
//
// PURE: it reads a metric record and the dataset's column list, never a row.

import type { ParsedColumn } from '../data/parse';
import type { Metric } from './metrics';
import { isFormulaDefinition } from './metrics';
import { metricShape } from './driverShape';
import type { ParamValues } from './params';
import { CALC_KIND_NAMES } from './tableCalc';
import type { TableCalcKind } from './tableCalc';
import { calcNotAdditive, calcNotAdditiveOverTime } from './metricCheckMessages';

export interface Additivity { categories: boolean; time: boolean }

const NOT_ADDITIVE: ReadonlySet<string> = new Set(['avg', 'min', 'max']);
const ADDING: ReadonlySet<TableCalcKind> = new Set<TableCalcKind>(['running_total', 'pct_of_total', 'moving_sum']);

/** `sum`, `count` and `none` (the raw value) add; `avg`, `min` and `max` do not. */
export function aggregationAdditivity(aggregation: string): Additivity {
  const adds = !NOT_ADDITIVE.has(aggregation);
  return { categories: adds, time: adds };
}

/** Whether the metric's figures add up across categories and across time. Never throws. */
export function additivityOf(
  m: Pick<Metric, 'datasetId' | 'definition' | 'filters' | 'name'>,
  columns: ParsedColumn[],
  byName: Map<string, Metric>,
  params?: ParamValues,
): Additivity {
  const def = m.definition;
  if (!isFormulaDefinition(def)) {
    const a = aggregationAdditivity(def.aggregation);
    return def.snapshot ? { categories: a.categories, time: false } : a;
  }
  // shortcut: a formula over a snapshot metric reads as not additive (metricShape refuses snapshots); give metricShape a linearity-only mode when snapshot formulas need running totals.
  const adds = metricShape(m.datasetId, columns, def, m.filters, byName, params, m.name).kind === 'additive';
  return { categories: adds, time: adds };
}

/** The side a calc needs the measure to add on: `time` along a date axis, else `categories`. Null when it adds nothing. */
export function calcNeedsAdditive(kind: TableCalcKind, alongTime: boolean): 'categories' | 'time' | null {
  return ADDING.has(kind) ? (alongTime ? 'time' : 'categories') : null;
}

/** The sentence that refuses `kind` of `measure`, or null when the measure adds on the side the calc needs. */
export function calcRefusal(measure: string, kind: TableCalcKind, a: Additivity, alongTime: boolean): string | null {
  const needs = calcNeedsAdditive(kind, alongTime);
  if (!needs || a[needs]) return null;
  return needs === 'time' && a.categories ? calcNotAdditiveOverTime(measure, CALC_KIND_NAMES[kind]) : calcNotAdditive(measure, CALC_KIND_NAMES[kind]);
}
