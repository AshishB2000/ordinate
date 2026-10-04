// The Reports area's server calls (T2.13): reports, stories, scorecards. Types
// mirror the handlers' replies (src/ipc/reports.ts, reportsServer.ts,
// stories.ts, scorecards.ts, src/analysis/reportPages.ts), narrowed by hand as
// in web/src/api/projects.ts — contracts carry inputs only. Every figure and
// every display string in these shapes is the server's.

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import type { ChartDataShape } from '../../charts/types';

export type Step = { type: string; [k: string]: unknown };
export type ReportFormat = 'pdf' | 'pptx' | 'docx';
export type PageKind = 'cover' | 'summary' | 'sheet' | 'tile' | 'notes' | 'narrative' | 'discussion' | 'scorecard';

export type ReportPage = {
  id: string;
  kind: PageKind;
  sheetIdx?: number;
  cardId?: string;
  notes?: string;
  scorecardId?: string;
  caption?: string;
  include: boolean;
  layout: 'full' | 'half';
};
export type ReportCover = {
  title: string;
  subtitle?: string;
  logo?: boolean;
};
export type ReportPaper = {
  size: 'letter' | 'a4';
  orientation: 'portrait' | 'landscape';
};
export interface Report {
  id: string;
  projectId: string;
  analysisId: string;
  scorecardId?: string;
  name: string;
  format: ReportFormat;
  pages: ReportPage[];
  cover: ReportCover;
  paper: ReportPaper;
  includeFilters: boolean;
  narrative: boolean;
  discussion: boolean;
  viewId?: string;
  schedule?: { cadence: 'off' | 'daily' | 'weekly' | 'monthly'; at: string };
  lastRunAt?: string;
  updatedAt: string;
}
export interface ReportSummary {
  id: string;
  name: string;
  analysisId: string;
  format: ReportFormat;
  cover: ReportCover;
  paper: ReportPaper;
  pageCount: number;
  schedule?: Report['schedule'];
  lastRunAt?: string;
  updatedAt: string;
}

/** A chart the browser draws from the server's own `visual:data` reply. */
export interface PageChart {
  type: string;
  data: ChartDataShape & Record<string, unknown>;
  overrides: Record<string, unknown>;
  datasetId: string;
}
export interface PageTile {
  title: string;
  chart?: PageChart | null;
  png?: string | null;
  note?: string;
}
/** One page, as the server resolved it (src/analysis/reportPages.ts RenderedPage). */
export interface RenderedPage {
  kind: string;
  title: string;
  subtitle?: string;
  caption?: string;
  body?: string;
  chart?: PageChart | null;
  png?: string | null;
  note?: string;
  tiles?: PageTile[];
  kpis?: Array<{ label: string; value: string }>;
  grid?: { head: string[][]; body: string[][] } | null;
  bullets?: string[];
  meta?: string[];
  logo?: string | null;
  layout?: string;
}
/** The Share policy's line for what is about to leave, when a sensitive column is involved. */
export interface ShareNote {
  count: number;
  action: 'mask' | 'drop' | 'include';
  line: string;
}
export type PagesReply = { ok: true; pages: RenderedPage[]; share: ShareNote | null; name?: string } | { ok: false; error: string };

export interface OpenReport {
  ok: true;
  report: Report;
  dashboard: { id: string; name: string } | null;
  sheets: Array<{ name: string; cards: Array<{ id: string; name: string; chartType: string }> }>;
  views: Array<{ id: string; name: string }>;
  missing: boolean;
}

/** A refusal's words, or a thrown error's. */
export function failure(r: unknown, fallback: string): string {
  if (r instanceof Error) return r.message;
  const e = r && typeof r === 'object' ? (r as { error?: unknown }).error : undefined;
  return typeof e === 'string' && e ? e : fallback;
}

export function useReports(projectId: string) {
  return useQuery({
    queryKey: ['reports:list', projectId],
    queryFn: async () => (await rpc('reports:list', { projectId })) as ReportSummary[],
  });
}

export function useOpenReport(projectId: string, id: string) {
  return useQuery({
    queryKey: ['reports:open', projectId, id],
    queryFn: async () => (await rpc('reports:open', { projectId, id })) as OpenReport | { ok: false; error: string },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

// ── Stories ──────────────────────────────────────────────────────────────

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger';
export type StoryBlock =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'callout'; tone: CalloutTone; text: string }
  | { id: string; kind: 'divider' }
  | { id: string; kind: 'visual'; visualId: string; filters: Step[]; caption?: string }
  | { id: string; kind: 'metric'; metricId: string; filters: Step[]; caption?: string }
  | { id: string; kind: 'metrics_row'; metricIds: string[]; filters: Step[] }
  | { id: string; kind: 'image'; src: string; alt: string; caption?: string };
export interface Story {
  id: string;
  name: string;
  blocks: StoryBlock[];
  updatedAt: string;
}
export interface StorySummary {
  id: string;
  name: string;
  excerpt: string;
  blockCount: number;
  updatedAt: string;
}
export type VisualFigure = { title: string; visualId: string; datasetId: string; chart: PageChart | null; caption: string; note?: string } | { missing: true };
export type MetricFigure = { figures: Array<{ name: string; display: string; value: number | null }>; caption: string };

export function useStories(projectId: string) {
  return useQuery({
    queryKey: ['story:list', projectId],
    queryFn: async () => (await rpc('story:list', { projectId })) as StorySummary[],
  });
}

// ── Scorecards ───────────────────────────────────────────────────────────

export type ScorePeriod = 'week' | 'month' | 'quarter' | 'year';
export type RowStatus = 'good' | 'warn' | 'off' | 'none';
export type ScorecardRowDef = {
  metricId: string;
  target?: number | { metricId: string };
  owner?: string;
  group?: string;
  thresholds?: { good: number; warn: number };
};
export interface Scorecard {
  id: string;
  name: string;
  period: ScorePeriod;
  rows: ScorecardRowDef[];
  updatedAt: string;
}
export interface ScorecardSummary {
  id: string;
  name: string;
  period: ScorePeriod;
  rowCount: number;
  groups: string[];
  updatedAt: string;
}
export interface ScoreRow {
  metricId: string;
  name: string;
  missing?: boolean;
  undated?: boolean;
  display: string;
  targetDisplay: string;
  targetName?: string;
  attainment: number | null;
  attainmentDisplay: string;
  status: RowStatus;
  delta: number | null;
  deltaDisplay: string;
  pctDisplay: string;
  tone: 'good' | 'bad' | 'flat' | 'neutral';
  spark: Array<number | null>;
  sparkLabels: string[];
  owner?: string;
  group?: string;
  alert?: { message: string; at: string };
  comments?: number;
}
export interface ScoreResult {
  ok: true;
  id: string;
  name: string;
  period: ScorePeriod;
  window: { from: string; to: string; label: string; offset: number };
  rows: ScoreRow[];
  groups: Array<{ group: string; onTrack: number; scored: number; total: number; share: number }>;
  counts: Record<RowStatus, number>;
}
export interface ScoreDetail {
  ok: true;
  metric: { id: string; name: string; datasetId: string; definitionText: string; definition: Record<string, unknown> };
  window: { label: string } | null;
  display: string;
  targetDisplay: string;
  attainmentDisplay: string;
  status: RowStatus;
  statusWord: string;
  series: ChartDataShape & { analytics?: Array<{ kind: string; text?: string; forecast?: { season?: number } }> };
  breakdown: { dimension: string; labels: string[]; values: Array<number | null>; display: string[] } | null;
  dateColumn: string | null;
}

export function useScorecards(projectId: string) {
  return useQuery({
    queryKey: ['scorecard:list', projectId],
    queryFn: async () => (await rpc('scorecard:list', { projectId })) as ScorecardSummary[],
  });
}

export const STATUS_WORD: Record<RowStatus, string> = { good: 'On track', warn: 'At risk', off: 'Off track', none: 'No target' };
export const PERIOD_WORD: Record<ScorePeriod, string> = { week: 'Weekly', month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' };
