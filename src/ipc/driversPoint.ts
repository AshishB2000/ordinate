// "Explain this change" from a point on a chart, over IPC — MAIN PROCESS.
//
// The browser sends what it pointed AT — the tile's own definition and filters,
// the clicked bucket's axis label, the series when the chart has one — and
// nothing it worked out. The server asks the chart's own question again
// (`vizDataFor`, the answer cache makes that free for a tile just drawn), reads
// the buckets off ITS answer, builds the drivers question (analysis/driverPoint)
// and runs it through the same engine every other door uses (./drivers). So
// the two figures in the header are the two points on the chart, and no period,
// delta or percentage is ever derived in React.
//
// Refused before anything is computed, each with a catalog sentence
// (analysis/driverPointMessages): a Live dataset (no rows to split by member —
// the typed `live_refused`, before its warehouse is asked anything), an "As of"
// view, converted money, and everything `pointPlan` refuses.

import { ipcMain } from './bus';
import * as visuals from '../analysis/visuals';
import { sanitizeEncoding } from '../analysis/visuals';
import { paramValues, resolveFilterParams } from '../analysis/params';
import { MAX_MEMBERS, MIN_MEMBERS } from '../analysis/drivers';
import { pointPlan, refusePoint } from '../analysis/driverPoint';
import type { PointBaseline, PointInput, PointPeriod, PointRefusal } from '../analysis/driverPoint';
import * as msg from '../analysis/driverPointMessages';
import { formatNumber } from '../app/format';
import { refuse } from '../engine/live/liveSpec';
import { liveMetaOf } from './liveRoute';
import { fxScope, fxVizContext } from './fxQuery';
import { vizDataFor } from './visuals';
import { runDrivers } from './drivers';
import type { DriversResult } from './drivers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PointReply =
  | { ok: true; bucket: string; baseline: string; periods: PointPeriod[]; baselines: PointBaseline[]; result: DriversResult }
  | PointRefusal
  // A Live dataset (engine/live/liveSpec `refuse('drivers')`): what `liveRefusalOf` reads in the browser.
  | { ok: false; code: 'live_refused'; error: string; reason: string }
  | { ok: false; error: string; bucket?: string; periods?: PointPeriod[] };

export interface PointRequest {
  datasetId: string;
  encoding: unknown;
  filters?: unknown;
  params?: unknown;
  point?: PointInput;
  asOf?: unknown;
  currency?: unknown;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The whole answer for one pointed-at bucket. EXPORTED for scripts/test-driversPoint.ts. */
export async function explainPoint(projectId: string, req: PointRequest): Promise<PointReply> {
  const datasetId = req.datasetId;
  if (await liveMetaOf(projectId, datasetId)) {
    const r = refuse('drivers');
    return { ok: false, code: 'live_refused', error: r.message, reason: r.code };
  }
  if (typeof req.asOf === 'string' && req.asOf) return refusePoint('as_of', msg.pointAsOf());

  // The same two whitelists and the same parameter resolution `visual:data` runs, so the buckets are the tile's.
  const enc = sanitizeEncoding(req.encoding);
  const values = paramValues(req.params);
  const filters = resolveFilterParams(visuals.sanitizeFilters(req.filters), values).steps;
  if (await fxScope(req.currency, () => fxVizContext(projectId, datasetId, enc, filters))) return refusePoint('converted', msg.pointConverted());

  const chart = await vizDataFor(projectId, datasetId, enc, filters, { params: values });
  if (!chart.ok) return { ok: false, error: chart.error };
  const p = req.point && typeof req.point === 'object' ? req.point : {};
  const plan = pointPlan(datasetId, enc, { category: chart.category, labels: chart.data.labels, series: chart.data.series }, filters, {
    bucket: text(p.bucket), series: text(p.series), baseline: text(p.baseline),
  });
  if (!plan.ok) return plan;

  const r = await runDrivers(projectId, plan.spec, values);
  if (!r.ok) return { ok: false, error: r.error, bucket: plan.bucket, periods: plan.periods };
  // Why nothing is broken down, in the catalog's words — the header keeps its two figures.
  if (r.unavailable) {
    r.unavailable = r.metric.kind === 'none'
      ? msg.pointNotSplittable()
      : r.totals.a === null || r.totals.b === null ? msg.pointNoFigure() : msg.pointNoDimension(formatNumber(MIN_MEMBERS), formatNumber(MAX_MEMBERS));
  }
  return { ok: true, bucket: plan.bucket, baseline: plan.baseline, periods: plan.periods, baselines: plan.baselines, result: r };
}

export function register(): void {
  ipcMain.handle('drivers:explainPoint', async (_e, { projectId, ...req }: any = {}) => { // any: zod-checked at the door
    try {
      if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) return { ok: false, error: 'Invalid project' };
      if (typeof req.datasetId !== 'string' || !UUID_RE.test(req.datasetId)) return { ok: false, error: 'Dataset not found' };
      return await explainPoint(projectId, req as PointRequest);
    } catch (err: any) { // any: a handler's throw
      return { ok: false, error: err?.message || 'Could not explain the change.' };
    }
  });
}
