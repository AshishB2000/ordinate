// The cohort and event-funnel branch of `vizData.buildVizData` — PURE.
//
// Both are visuals whose output main computes BESIDE the ordinary
// `{labels, series}` (the pivot's arrangement): the grid / funnel rides on
// `data.cohort` / `data.eventFunnel`, and `{labels, series}` is the retention
// curve / the per-step counts, so captions, thumbnails, exports and the
// Assistant's facts read a payload they already understand. Its own file so
// vizData (at its size limit) gains one dispatch line, not two branches.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import type { VizEncoding } from './visuals';
import type { VizDataResult } from './vizData';
import { buildCohort, cohortChartData, cohortColumns } from './cohortData';
import type { CohortGrid } from './cohortData';
import { buildEventFunnel, funnelChartData, funnelColumns } from './funnelEvents';
import type { EventFunnel } from './funnelEvents';

/** Is this an encoding the two engines answer? */
export function isEngineEncoding(enc: VizEncoding | null | undefined): boolean {
  return !!enc && (!!enc.cohort || !!enc.eventFunnel);
}

/** Every column an engine encoding reads — the share policy's question. */
export function engineColumns(enc: VizEncoding): string[] {
  if (enc.cohort) return cohortColumns(enc.cohort);
  if (enc.eventFunnel) return funnelColumns(enc.eventFunnel);
  return [];
}

export function cohortVizResult(grid: CohortGrid, warnings: string[]): VizDataResult {
  const chart = cohortChartData(grid);
  return { data: { labels: chart.labels, series: chart.series, cohort: grid }, recommendedShape: 'unstructured', warnings };
}

export function funnelVizResult(funnel: EventFunnel, warnings: string[]): VizDataResult {
  const chart = funnelChartData(funnel);
  return { data: { labels: chart.labels, series: chart.series, eventFunnel: funnel }, recommendedShape: 'unstructured', warnings };
}

/** The JS reference answer for an engine encoding, or null for any other encoding. */
export function engineVizData(
  columns: ParsedColumn[], rows: Cell[][], encoding: VizEncoding, filters?: FilterStep[],
): VizDataResult | null {
  if (!encoding) return null;
  if (encoding.cohort) {
    const r = buildCohort(columns, rows, encoding.cohort, filters);
    return cohortVizResult(r.grid, r.warnings);
  }
  if (encoding.eventFunnel) {
    const r = buildEventFunnel(columns, rows, encoding.eventFunnel, filters);
    return funnelVizResult(r.funnel, r.warnings);
  }
  return null;
}
