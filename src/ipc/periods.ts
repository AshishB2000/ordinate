// Relative periods over IPC — resolving a preset for display, and a KPI card's
// Compare. MAIN PROCESS.
//
// Both answers come from main because both depend on TODAY and on the
// workspace calendar, and main owns both (src/analysis/dateIntel.ts). A
// renderer that resolved "Last 30 days" with its own clock could show dates
// that disagree with the figures computed under them.
//
// `metric:compare` is the SECOND resolution a Compare needs: the card's filters
// with their date range moved (periodScope.compareScope), run through the same
// function the card's own figure runs through — resolveMetric for a saved
// metric, computeCardMetric for a column rollup. It returns the current figure
// too, so a card with Compare makes this ONE call rather than two that could
// race. Nothing is stored.

import { ipcMain } from 'electron';

import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import type { MetricAggregation } from '../analysis/metricValue';
import { formatMetricValue } from '../analysis/metricFormat';
import { describeCompare, describePeriod, getCalendar, resolvePeriodNow, sanitizeCompare, sanitizePeriod, todayIso } from '../analysis/dateIntel';
import { compareScope } from '../analysis/periodScope';
import { computeCardMetric } from './dashboards';
import { resolveMetric } from './metrics';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CompareResult {
  ok: boolean;
  error?: string;
  /** Set when there is nothing to compare against — no date filter in scope. */
  reason?: 'no_date_filter';
  value?: number | null;
  previous?: number | null;
  delta?: number | null;
  /** (value − previous) / |previous| × 100, or null when previous is 0/unknown. */
  pct?: number | null;
  label?: string;
  prior?: { from?: string; to?: string };
  /** Saved metrics only: every figure pre-formatted by the metric's own format. */
  display?: string;
  previousDisplay?: string;
  deltaDisplay?: string;
  direction?: 'up_good' | 'down_good';
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function compareMetric(
  projectId: string,
  card: { metricId?: string; datasetId?: string; column?: string; aggregation?: string },
  rawFilters: unknown,
  rawCompare: unknown,
): Promise<CompareResult> {
  const cmp = sanitizeCompare(rawCompare);
  if (!cmp) return { ok: false, error: 'Nothing to compare with' };
  const filters = sanitizeDashboardFilters(rawFilters);
  const metric = card.metricId && UUID_RE.test(card.metricId) ? await metrics.getMetric(projectId, card.metricId) : null;
  const datasetId = metric ? metric.datasetId : String(card.datasetId || '');
  if (!UUID_RE.test(datasetId)) return { ok: false, error: 'Dataset not found' };
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };

  const moved = compareScope(filters, meta.columns, cmp);
  const label = describeCompare(cmp.mode);
  if (!moved) return { ok: true, reason: 'no_date_filter', label };

  let value: number | null;
  let previous: number | null;
  const out: CompareResult = { ok: true, label, prior: moved.prior };
  if (metric) {
    const [a, b] = [await resolveMetric(projectId, metric.id, { filters }), await resolveMetric(projectId, metric.id, { filters: moved.filters })];
    if (!a || !b) return { ok: false, error: 'Metric not found' };
    value = finite(a.value);
    previous = finite(b.value);
    out.display = a.display;
    out.previousDisplay = b.display;
    if (metric.direction) out.direction = metric.direction;
  } else {
    const spec = { column: String(card.column || ''), aggregation: card.aggregation as MetricAggregation };
    const a = await computeCardMetric(projectId, datasetId, spec, filters);
    const b = await computeCardMetric(projectId, datasetId, spec, moved.filters);
    if (!a.ok || !b.ok) return { ok: false, error: 'Dataset not found' };
    value = finite(a.value);
    previous = finite(b.value);
  }
  const delta = value !== null && previous !== null ? value - previous : null;
  out.value = value;
  out.previous = previous;
  out.delta = delta;
  out.pct = delta !== null && previous !== null && previous !== 0 ? (delta / Math.abs(previous)) * 100 : null;
  if (metric && delta !== null) {
    out.deltaDisplay = formatMetricValue(Math.abs(delta), metric.format);
    // A change in a PERCENT is in points: 13.2% vs 12.0% is "1.2 pts", and a
    // relative change of a ratio ("up 10%") reads as the ratio itself moving.
    if (metric.format.kind === 'percent') {
      out.deltaDisplay = out.deltaDisplay.replace(/%$/, ' pts');
      out.pct = null;
    }
  }
  return out;
}

export function register(): void {
  // A preset → its dates today, under the workspace calendar, plus its name.
  ipcMain.handle('period:resolve', async (_e, raw: unknown) => {
    const spec = sanitizePeriod(raw);
    if (!spec) return { ok: false, error: 'Unknown period' };
    const r = resolvePeriodNow(spec);
    if (!r) return { ok: false, error: 'Unknown period' };
    return { ok: true, from: r.from, to: r.to, label: describePeriod(spec, getCalendar()), today: todayIso() };
  });

  ipcMain.handle('metric:compare', async (_e, { projectId, card, filters, compare }: any = {}) => {
    try {
      if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) return { ok: false, error: 'Invalid project' };
      return await compareMetric(projectId, card && typeof card === 'object' ? card : {}, filters, compare);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compare' };
    }
  });
}
