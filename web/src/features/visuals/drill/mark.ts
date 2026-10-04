// The clicked mark (chartControls.ts chartMarkAt): ONE hit-test of the drawn
// Chart.js instance, so the drill panel's rows are the rows behind the mark
// the user pointed at. A click on empty canvas is null; so is a map or a table
// (no Chart.js instance) — the ⋯ menu drills those.

import type { ChartHandle } from '../../../charts/Chart';
import type { Cx } from '../../../charts/types';

export function markAt(chart: ChartHandle | null, e: MouseEvent): { category: string | number; series?: string } | null {
  const c = chart as (ChartHandle & { getElementsAtEventForMode?: (...a: Cx[]) => Cx[] }) | null;
  if (!c || typeof c.getElementsAtEventForMode !== 'function') return null;
  let hit: Cx[] = [];
  try {
    hit = c.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
  } catch {
    hit = [];
  }
  if (!hit.length) return null;
  const labels: Cx[] = (c.data && c.data.labels) || [];
  const category = labels[hit[0].index];
  if (category === undefined || category === null) return null;
  const sets: Cx[] = (c.data && c.data.datasets) || [];
  const split = sets.length > 1 ? sets[hit[0].datasetIndex] : null;
  return { category: typeof category === 'number' ? category : String(category), ...(split && typeof split.label === 'string' ? { series: split.label } : {}) };
}
