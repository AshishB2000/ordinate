// A published KPI tile's change against another period — the canvas's own
// `metric:compare` (src/ipc/periods.ts compareMetric), run here once per
// combination. The page only lays out what this returns: the signed delta is
// formatted and its tone decided on the server, never in the page's script.

import { compareMetric } from '../ipc/periods';
import { formatValue } from '../app/format';
import { isLiveFigureError } from '../engine/live/liveFigureError';
import type { CardMetric } from '../analysis/dashboards';
import type { ParamValues } from '../analysis/params';
import type { FilterStep } from '../data/transforms';

export interface KpiChange {
  /** "+$412.3K" / "−1.2 pts" — the metric's own format, a real minus sign. */
  deltaDisplay: string;
  /** Relative change in percent; null when the earlier figure is 0 or the metric is a percent (points instead). */
  pct: number | null;
  /** Whether the move is good news: up, unless the metric says down is good. */
  tone: 'good' | 'bad' | 'flat';
  /** "vs previous period" … (dateIntel.describeCompare). */
  label: string;
}

/**
 * The change line, or null: no Compare on the card, no date filter in scope to
 * move (`no_date_filter`), no earlier figure, or a Live warehouse that could not
 * answer — the tile then shows its figure alone.
 */
export async function kpiCompare(projectId: string, m: CardMetric, filters: FilterStep[], params: ParamValues): Promise<KpiChange | null> {
  if (!m.compare) return null;
  let r: Awaited<ReturnType<typeof compareMetric>>;
  try {
    // compareMetric re-reads its params as a list (paramValues), so the bound values go back in as one.
    r = await compareMetric(projectId, m, filters, m.compare, [...params.values()]);
  } catch (err) {
    if (isLiveFigureError(err)) return null;
    throw err;
  }
  if (!r.ok || r.reason || typeof r.delta !== 'number') return null;
  const d = r.delta;
  const up = d > 0;
  return {
    deltaDisplay: (up ? '+' : d < 0 ? '−' : '') + (r.deltaDisplay || formatValue(Math.abs(d), m.format || 'auto')),
    pct: typeof r.pct === 'number' && Number.isFinite(r.pct) ? r.pct : null,
    tone: d === 0 ? 'flat' : (r.direction === 'down_good' ? !up : up) ? 'good' : 'bad',
    label: r.label || '',
  };
}
