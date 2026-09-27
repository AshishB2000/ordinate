// A scorecard's data for a published site — MAIN PROCESS.
//
// The same call the scorecard page makes (ipc/scorecards.computeScorecard), for
// the latest period, laid out as the rows the published page draws: every
// figure is the display string the app already formatted, plus the raw numbers
// a sparkline and an attainment bar need. A scorecard has no filter bar, so it
// is one answer, like a story. Like a story's metric blocks, its figures are
// metric resolutions — aggregates, never a row — so no column-level share
// policy applies to them.

import * as scorecards from '../analysis/scorecards';
import { computeScorecard } from '../ipc/scorecards';
import type { BuildProgress } from './dashboardData';

export interface PublishedScoreRow {
  name: string;
  display: string;
  targetDisplay: string;
  attainment: number | null;
  status: string;
  deltaDisplay: string;
  pct: number | null;
  tone: string;
  spark: Array<number | null>;
  owner: string;
  group: string;
}

export interface PublishedScorecard {
  id: string;
  name: string;
  period: string;
  window: { label: string; from: string; to: string };
  rows: PublishedScoreRow[];
  groups: Array<{ group: string; onTrack: number; scored: number; total: number }>;
  geoLevels: string[];
  boundaryIds: string[];
}

export async function buildScorecard(projectId: string, id: string, ctx: BuildProgress = {}): Promise<PublishedScorecard | null> {
  const sc = await scorecards.getScorecard(projectId, id);
  if (!sc) return null;
  if (ctx.checkCancelled) ctx.checkCancelled();
  if (ctx.progress) ctx.progress(0.1, 'Scoring ' + sc.name);
  const res = await computeScorecard(projectId, sc, 0);
  if (ctx.progress) ctx.progress(1);
  return {
    id: sc.id,
    name: sc.name,
    period: sc.period,
    window: { label: res.window.label, from: res.window.from, to: res.window.to },
    rows: res.rows.map((r) => ({
      name: r.name, display: r.display, targetDisplay: r.targetDisplay, attainment: r.attainment,
      status: r.status, deltaDisplay: r.deltaDisplay, pct: r.pct, tone: r.tone, spark: r.spark,
      owner: r.owner || '', group: r.group || '',
    })),
    groups: res.groups,
    geoLevels: [],
    boundaryIds: [],
  };
}
