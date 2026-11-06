// The metrics layer's server calls and the words every surface shares about a
// metric (legacy metricPicker.ts / metricsPage.ts). Every figure and every
// string that renders one — `display`, `definitionText` — is the server's.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import type { StatusView } from '../../model/status/status';
import type { Agg, ParamPayload, Step } from '../api';

export interface MetricFormat {
  kind: 'number' | 'currency' | 'percent' | 'duration';
  decimals?: number;
  prefix?: string;
  suffix?: string;
  compact?: boolean;
}
/** A snapshot (semantic D8): only the rows on the latest (or earliest) day of a date column. `null` clears it on save. */
export interface Snapshot {
  column: string;
  take: 'last' | 'first';
  /** Each entity's own latest (or earliest) day (part 5, D11): the entity column. `null` clears it on save. */
  per?: string | null;
}
/** A period metric (semantic part 5, D8): its base metric over a window, compared with an earlier period, or both. */
export type PeriodWindow = { to_date: 'week' | 'month' | 'quarter' | 'year' } | { last: number; unit: 'day' | 'week' | 'month' };
export interface PeriodCompare {
  vs: 'previous_period' | 'previous_year';
  show: 'change' | 'pct_change' | 'prior';
}
export interface PeriodDefinition {
  base: string;
  window?: PeriodWindow;
  compare?: PeriodCompare;
}
/** A funnel metric (semantic part 5, D5): the funnel grid's steps, as its conversion rate, converted or entered count. */
export interface FunnelDefinition {
  funnel: { entity: string; event: string; time: string; steps: string[]; window: { n: number; unit: 'hours' | 'days' } };
  show: 'rate' | 'converted' | 'entered';
}
/** A metric's target (semantic part 5, D12): a figure, or a metric over a plan dataset, for the period one figure covers. */
export interface Target {
  source: { value: number } | { metricId: string };
  per?: 'week' | 'month' | 'quarter' | 'year';
  thresholds?: { good: number; warn: number };
}
/** A metric a semantic layer computes (part 7): its name there, never math. `additive`: the layer says plain sum or count. Read-only here. */
export interface ExternalDefinition {
  external: string;
  additive?: true;
  layer?: string;
}
export type Definition = { formula: string } | { column: string; aggregation: Agg; snapshot?: Snapshot | null } | PeriodDefinition | FunnelDefinition | ExternalDefinition;
/** What an editor may send: a layer's definition is its layer's to change. */
export type EditableDefinition = Exclude<Definition, ExternalDefinition>;

/** `metric:list`'s decorated summary. */
export interface MetricSummary {
  id: string;
  name: string;
  datasetId: string;
  datasetName: string | null;
  definition: Definition;
  definitionText: string;
  format: MetricFormat;
  description?: string;
  direction?: 'up_good' | 'down_good';
  /** The date column it counts by (semantic layer D9): a dashboard date control's period lands on it. Unset: the dashboard's date. */
  timeColumn?: string;
  /** It has a metric tree (./tree). */
  hasTree?: true;
  target?: Target;
  updatedAt: string;
  /** Certified, changed since, or retired (part 4): the server's word, drawn as it came. */
  status?: StatusView;
  /** The content tag from `metric:get`, when an editor opened it: its save's base (docs/edit-conflicts). */
  tag?: string;
}

/** The full record (`metric:get`) — the summary plus its filters. */
export interface Metric extends Omit<MetricSummary, 'datasetName' | 'definitionText'> {
  filters: Step[];
}

export interface Usage {
  total: number;
  summary: string;
  /** `change` (visuals only): the chart now draws this metric as defined today, so its numbers moved once (`metric:usage`). */
  refs: { kind: string; name: string; id: string; change?: 'filters' | 'definition' }[];
}

/** The format chip's word — short, it sits beside a name (mpkFormatBadge). */
export function formatBadge(format: MetricFormat | undefined): string {
  const kind = format?.kind ?? 'number';
  if (kind === 'currency') return format?.prefix || '$';
  if (kind === 'percent') return '%';
  if (kind === 'duration') return 'time';
  return format?.compact ? '123' : '1.0';
}

export const isFormula = (d: Definition): d is { formula: string } => typeof (d as { formula?: unknown }).formula === 'string';
export const isPeriod = (d: Definition): d is PeriodDefinition => typeof (d as { base?: unknown }).base === 'string';
export const isFunnel = (d: Definition): d is FunnelDefinition => !!(d as { funnel?: unknown }).funnel && typeof (d as { funnel?: unknown }).funnel === 'object';
export const isExternal = (d: Definition): d is ExternalDefinition => typeof (d as { external?: unknown }).external === 'string';

const RANGE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const utc = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** The days a period metric's figure covers, as the server resolved them: "Jan 1 – Oct 31, 2024"; '' without both ends. */
export function periodRangeText(r: { from?: string; to?: string } | undefined): string {
  return r?.from && r.to ? RANGE.formatRange(utc(r.from), utc(r.to)) : '';
}

export function useMetricList(projectId: string) {
  return useQuery({
    queryKey: ['metric:list', projectId],
    queryFn: async () => {
      const r = (await rpc('metric:list', { projectId })) as { ok: boolean; metrics?: MetricSummary[]; error?: string };
      if (!r.ok) throw new Error(r.error || 'Metrics could not be loaded.');
      return r.metrics ?? [];
    },
  });
}

/** Each metric's figure under the sheet's filters, in one call (`metric:values`). */
export function useMetricValues(projectId: string, ids: string[], filters: Step[], params: ParamPayload) {
  return useQuery({
    queryKey: ['metric:values', projectId, ids, filters, params],
    queryFn: ids.length
      ? async () => {
          const r = (await rpc('metric:values', { projectId, ids, filters, params })) as { id: string; ok: boolean; display?: string }[];
          return new Map(r.map((x) => [x.id, x.ok ? (x.display ?? '—') : '—']));
        }
      : skipToken,
  });
}
