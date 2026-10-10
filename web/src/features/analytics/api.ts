// The analytics workbenches' server calls (src/api/analytics.ts). Contracts
// carry inputs only, so each reply is narrowed here by hand, mirrored from the
// handlers: src/ipc/stats.ts (+ src/analysis/stats/run.ts, figures.ts),
// src/ipc/drivers.ts, src/ipc/scenarios.ts (+ analysis/scenarioResolve.ts) and
// src/ipc/segments.ts (+ analysis/segmentModel.ts, analysis/rfm.ts).
//
// Every number below arrives computed. Nothing in this folder adds, divides,
// averages or ranks one — it formats (./format.ts) and lays out.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';

/** `{ ok:false, error }` is how every handler here answers a refusal it explains. */
export type Fail = { ok: false; error: string; cancelled?: boolean };

/** Calls a channel and returns its reply; a thrown RPC error becomes a Fail with its message. */
export async function call<T>(p: Promise<unknown>, fallback: string): Promise<T | Fail> {
  try {
    const r = (await p) as T | Fail | null;
    return r ?? { ok: false, error: fallback };
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.message ? err.message : fallback };
  }
}

// ── Statistics ───────────────────────────────────────────────────────────────

export type StatsKind = 'correlation' | 'regression' | 'groups' | 'distribution';

/** src/analysis/stats/spec.ts StatsSpec — what a run names, never a figure. */
export type StatsSpec = {
  kind: StatsKind;
  datasetId: string;
  columns: string[];
  method?: 'pearson' | 'spearman';
  target?: string;
  predictors?: string[];
  group?: string;
  outcome?: string;
  levels?: string[];
  success?: string;
};

export interface CorrCell {
  r: number | null;
  n: number;
  p: number | null;
}
export interface RegTerm {
  name: string;
  estimate: number;
  se: number;
  t: number;
  p: number;
  ciLow: number;
  ciHigh: number;
}
export interface RegressionFit {
  target: string;
  n: number;
  dropped: number;
  terms: RegTerm[];
  references: Array<{ column: string; level: string }>;
  r2: number;
  adjR2: number;
  f: number;
  fDf1: number;
  fDf2: number;
  fP: number;
  sigma: number;
  residuals: { fitted: number[]; residual: number[] };
  qq: { theoretical: number[]; sample: number[] };
}
export interface GroupStat {
  label: string;
  n: number;
  mean: number;
  sd: number;
  median: number;
}
export interface GroupsResult {
  ok: true;
  kind: 'groups';
  rows: number;
  group: string;
  outcome: string;
  mode: 'two' | 'many' | 'table';
  available: Array<{ level: string; n: number }>;
  groups: GroupStat[];
  welch?: { t: number; df: number; p: number; diff: number; ciLow: number; ciHigh: number; cohenD: number; hedgesG: number };
  mannWhitney?: { u: number; z: number; p: number; rankBiserial: number };
  anova?: { f: number; df1: number; df2: number; p: number; etaSq: number };
  kruskal?: { h: number; df: number; p: number; epsilonSq: number };
  table?: { rows: string[]; cols: string[]; counts: number[][] };
  chi?: { chi2: number; df: number; p: number; cramerV: number; n: number };
  prop?: { p1: number; p2: number; diff: number; ciLow: number; ciHigh: number; z: number; p: number; cohenH: number; success: string };
  sentence: string;
  warnings: string[];
}
export interface DistributionResult {
  ok: true;
  kind: 'distribution';
  rows: number;
  column: string;
  moments: { n: number; mean: number; sd: number; min: number; max: number; median: number; skewness: number | null; kurtosis: number | null };
  histogram: { labels: string[]; counts: number[]; normal: number[] };
  normality: { method: 'shapiro-wilk' | 'dagostino'; statistic: number; p: number; zSkew?: number; zKurt?: number } | null;
  sentence: string;
}
export type StatsResult =
  | { ok: false; kind: StatsKind; error: string }
  | { ok: true; kind: 'correlation'; rows: number; matrix: { method: 'pearson' | 'spearman'; columns: string[]; cells: CorrCell[][] } }
  | { ok: true; kind: 'regression'; rows: number; fit: RegressionFit; sentence: string }
  | GroupsResult
  | DistributionResult;

/** src/analysis/stats/figures.ts — the derived numbers a view shows. */
export interface StatsFigures {
  total?: number;
  rowTotals?: number[];
  rowShares?: number[][];
  residualSpan?: [number, number];
  qqSpan?: [number, number];
}
export type StatsReply = { ok: true; result: StatsResult; datasetName: string; figures: StatsFigures } | Fail;

export interface PairReply {
  ok: true;
  pair: {
    x: string;
    y: string;
    points: { x: number[]; y: number[] };
    shown: number;
    n: number;
    fit: { intercept: number; slope: number } | null;
    cell: CorrCell;
    sentence: string;
  };
  line: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** One run, cached per spec: switching tabs and back re-shows a reply without a call. */
export function useStatsRun(projectId: string, spec: StatsSpec | null, nonce: number) {
  return useQuery({
    queryKey: ['stats:run', projectId, spec, nonce],
    queryFn: spec ? () => call<StatsReply>(rpc('stats:run', { projectId, spec }), 'Could not run the analysis.') : skipToken,
    staleTime: Infinity,
    retry: false,
  });
}

export function useStatsPair(projectId: string, spec: StatsSpec, pair: [string, string] | null) {
  return useQuery({
    queryKey: ['stats:pair', projectId, spec, pair],
    queryFn: pair
      ? () => call<PairReply>(rpc('stats:pair', { projectId, spec, x: pair[0], y: pair[1] }), 'Could not draw that pair.')
      : skipToken,
    staleTime: Infinity,
    retry: false,
  });
}

// ── Key drivers ──────────────────────────────────────────────────────────────

export type DriversRequest = {
  datasetId: string;
  metric: { metricId?: string; column?: string; aggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max'; label?: string };
  compare: Record<string, unknown> & { mode: string };
  filters?: Array<Record<string, unknown> & { type: string }>;
  path?: Array<{ column: string; value: string }>;
  dimension?: string;
  params?: Record<string, unknown>;
};
export interface MemberView {
  key: string;
  label: string;
  delta: number;
  deltaText: string;
  share: number | null;
  moveShare: number;
  mixText?: string;
  rateText?: string;
}
export interface DriversResult {
  ok: true;
  token: string;
  metric: { name: string; kind: 'additive' | 'ratio' | 'none'; direction?: 'up_good' | 'down_good' };
  periods: { a: string; b: string; column: string };
  totals: { delta: number | null; pct: number | null; aText: string; bText: string; deltaText: string };
  unavailable?: string;
  dimensions: Array<{ column: string; explained: number; memberCount: number; lead: string | null }>;
  selected: {
    column: string;
    offsetting: boolean;
    waterfall: {
      start: number;
      end: number;
      startText: string;
      endText: string;
      steps: Array<MemberView & { from: number; to: number }>;
      other: { delta: number; deltaText: string; count: number; from: number; to: number };
    };
  } | null;
  headline: string;
  /** A chart point's header, written by the server with its figures (src/analysis/driverPoint.ts). */
  sentence?: string;
  caption: string;
  path: Array<{ column: string; value: string; label: string }>;
  alert: unknown;
  spec: DriversRequest;
}
export type DriversReply = DriversResult | Fail;

/** The cache key of one drivers question — a door that already holds its answer seeds it (./explain/api.ts). */
export const driversKey = (projectId: string, request: DriversRequest | null) => ['drivers:explain', projectId, request] as const;

export function useDrivers(projectId: string, request: DriversRequest | null) {
  return useQuery({
    queryKey: driversKey(projectId, request),
    queryFn: request ? () => call<DriversResult>(rpc('drivers:explain', { projectId, request }), 'Could not explain the change.') : skipToken,
    staleTime: Infinity,
    retry: false,
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────────

export type ScenarioDriver = {
  name: string;
  kind: 'pct' | 'abs';
  value: number;
  target: { column: string; filter?: { type: 'filter'; column: string; op: '='; value: string } } | { metricId: string };
  param?: string;
};
export interface Scenario {
  id: string;
  name: string;
  baseMetricIds: string[];
  drivers: ScenarioDriver[];
}
export interface ScenarioSummary {
  id: string;
  name: string;
  driverCount: number;
  metricCount: number;
  driverNames: string[];
  updatedAt: string;
}
export type Tone = 'good' | 'bad' | 'flat' | 'neutral';
export interface ScenarioFigure {
  metricId: string;
  name: string;
  missing?: boolean;
  display: string;
  baselineDisplay: string;
  delta: number | null;
  deltaDisplay: string;
  pct: number | null;
  tone: Tone;
}
export interface ScenarioResult {
  ok: true;
  metrics: ScenarioFigure[];
  drivers: Array<{ index: number; label: string; kind: 'pct' | 'abs'; target: unknown; targetText: string; applied: boolean }>;
  tornado: {
    metricId: string;
    name: string;
    value: number | null;
    display: string;
    step: number;
    bars: Array<{ label: string; low: number | null; high: number | null; swing: number; lowDisplay: string; highDisplay: string }>;
  } | null;
  notes: string[];
}
export interface ScenarioTargets {
  ok: true;
  columns: Array<{ column: string; datasetId: string; metrics: string[] }>;
  metrics: Array<{ id: string; name: string }>;
  datasets: Array<{ id: string; name: string; columns: Array<{ name: string; type: string }> }>;
}
export interface CompareReply {
  ok: true;
  scenarios: Array<{ id: string; name: string; drivers: string[] }>;
  rows: Array<{
    metricId: string;
    name: string;
    missing: boolean;
    baselineDisplay: string;
    best: number;
    cells: Array<{ display: string; delta: number | null; deltaDisplay: string; pct: number | null; tone: Tone }>;
  }>;
}
export interface ScenarioMetric {
  id: string;
  name: string;
  kind: 'column' | 'formula' | 'count';
}

export function useScenarios(projectId: string) {
  return useQuery({
    queryKey: ['scenario:list', projectId],
    queryFn: async () => (await rpc('scenario:list', { projectId })) as ScenarioSummary[],
  });
}

export function useScenarioMetrics(projectId: string) {
  return useQuery({
    queryKey: ['scenario:metrics', projectId],
    queryFn: async () => (await rpc('scenario:metrics', { projectId })) as ScenarioMetric[],
  });
}

// ── Find segments ────────────────────────────────────────────────────────────

export interface SegmentsInfo {
  ok: true;
  name: string;
  rowCount: number;
  sampleCap: number;
  features: Array<{ name: string; checked: boolean; reason?: string }>;
  otherColumns: number;
  columns: Array<{ name: string; type: string }>;
  rfm: { id: string; date: string; amount: string };
}
export interface FitResult {
  features: string[];
  k: number;
  silhouettes: Array<{ k: number; score: number }>;
  names: string[];
  step: Record<string, unknown> & { type: 'segment'; column: string };
  total: number;
  complete: number;
  fitted: number;
  sizes: number[];
  empty: number;
  profile: { overall: number[]; segments: Array<Array<number | null>>; deviation: Array<Array<number | null>> };
  pca: { variance: [number, number]; points: Array<[number, number, number]> };
}
export type FitReply = { ok: true; result: FitResult; shares: { sizes: number[]; empty: number } } | Fail;
export interface RfmResult {
  customers: number;
  used: number;
  skipped: number;
  asOf: string | null;
  segments: Array<{ name: string; meaning: string; count: number; share: number; recency: number | null; frequency: number | null; monetary: number | null }>;
  layout: string[][];
  grid: number[][];
}
export type RfmReply = { ok: true; result: RfmResult } | Fail;

export function useSegmentFeatures(projectId: string, datasetId: string) {
  return useQuery({
    queryKey: ['segments:features', projectId, datasetId],
    queryFn: () => call<SegmentsInfo>(rpc('segments:features', { projectId, datasetId }), 'This dataset could not be read.'),
  });
}
