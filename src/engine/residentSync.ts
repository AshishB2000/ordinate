// SYNC twins of residentQuery's entry points, kept ONLY for consumers T4.2 has
// not made async yet: facetResident, joinResident, fxResident (all reachable
// from IPC) and insightsAgg.residentAgg (the compute worker, where blocking its
// own thread is allowed). Same plan, same read — only the transport differs —
// so these cannot drift from the async versions. Delete this file when the last
// importer is gone.

import * as duck from './duckdb';
import { aggregateStmt, catKeyStmt, metricStmt, plainFrom, runOrdered } from './residentQuery';
import type { CatKeyPlan, ResidentCatKey, ResidentChartData, ResidentMeasure, ResidentSource, Stmt } from './residentQuery';
import type { FilterStep } from '../data/transforms';
import type { MetricAggregation } from '../analysis/metricValue';
import type { DateGrain } from '../analysis/categoryKey';

function runSync<T>(s: Stmt<T> | null): T | null {
  if (!s) return null;
  const rows = s.ordered ? runOrdered(s.path, s.sql, s.params) : duck.query(s.sql(plainFrom(s.path), ''), s.params);
  return s.read(rows);
}

export function computeMetricResidentSync(
  src: ResidentSource,
  spec: { column: string; aggregation: MetricAggregation },
  filters?: FilterStep[],
): number | null {
  try {
    return runSync(metricStmt(src, spec, filters));
  } catch {
    return null;
  }
}

export function aggregateResidentSync(
  src: ResidentSource,
  category: string,
  measures: ResidentMeasure[],
  filters?: FilterStep[],
  catKey: ResidentCatKey = { kind: 'raw' },
): ResidentChartData | null {
  try {
    return runSync(aggregateStmt(src, category, measures, filters, catKey));
  } catch {
    return null;
  }
}

export function resolveCatKeySync(
  src: ResidentSource,
  category: string,
  measures: ResidentMeasure[],
  filters?: FilterStep[],
  grain?: DateGrain,
  bins?: number,
): CatKeyPlan | null {
  try {
    return runSync(catKeyStmt(src, category, measures, filters, grain, bins));
  } catch {
    return null;
  }
}
