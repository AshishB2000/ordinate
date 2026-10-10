// The chart point under a right-click, as the SERVER names it: the bucket's own
// axis label and, on a chart with several lines, the series. A bar or a marker
// is hit exactly; anywhere else inside the plot area means the nearest point —
// the one whose tooltip is showing. Outside the plot area there is no point
// (null), and the browser's own menu opens.
//
// The drawn axis is not always the server's: a re-sorted chart reorders it and
// a first-of-month axis is rewritten ("2025-03-01" → "Mar 2025", build.ts
// asMonthLabels). The label sent back is always the server's own, looked up by
// the drawn one — never a date worked out here.

import type { ChartHandle } from '../../../charts/Chart';
import { asMonthLabels } from '../../../charts/build';
import type { Cx } from '../../../charts/types';

export interface ChartPoint {
  bucket: string;
  series?: string;
}

export function pointAt(chart: ChartHandle | null, e: MouseEvent, serverLabels: readonly unknown[]): ChartPoint | null {
  const c = chart as (ChartHandle & { getElementsAtEventForMode?: (...a: Cx[]) => Cx[] }) | null;
  if (!c || typeof c.getElementsAtEventForMode !== 'function') return null;
  // Bars and lines index their marks by axis label. A matrix, a treemap or a radar does not, so a point there names no bucket.
  if (c.config?.type !== 'bar' && c.config?.type !== 'line') return null;
  let hit: Cx[] = [];
  try {
    hit = c.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
    if (!hit.length) hit = c.getElementsAtEventForMode(e, 'nearest', { intersect: false, axis: 'xy' }, true);
  } catch {
    hit = [];
  }
  if (!hit.length) return null;
  const drawn = ((c.data && c.data.labels) || [])[hit[0].index];
  if (drawn === undefined || drawn === null) return null;
  const shown = asMonthLabels(serverLabels as Cx[]);
  const at = shown.findIndex((l) => String(l) === String(drawn));
  // A label the server never sent (a forecast's) goes back as drawn: the server says it is not a period.
  const bucket = String(at >= 0 ? serverLabels[at] : drawn);
  const sets: Cx[] = (c.data && c.data.datasets) || [];
  const split = sets.length > 1 ? sets[hit[0].datasetIndex] : null;
  return { bucket, ...(split && typeof split.label === 'string' ? { series: split.label } : {}) };
}
