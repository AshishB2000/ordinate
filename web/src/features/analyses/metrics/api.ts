// The metrics layer's server calls and the words every surface shares about a
// metric (legacy metricPicker.ts / metricsPage.ts). Every figure and every
// string that renders one — `display`, `definitionText` — is the server's.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import type { Agg, ParamPayload, Step } from '../api';

export interface MetricFormat {
  kind: 'number' | 'currency' | 'percent' | 'duration';
  decimals?: number;
  prefix?: string;
  suffix?: string;
  compact?: boolean;
}
export type Definition = { formula: string } | { column: string; aggregation: Agg };

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
  updatedAt: string;
}

/** The full record (`metric:get`) — the summary plus its filters. */
export interface Metric extends Omit<MetricSummary, 'datasetName' | 'definitionText'> {
  filters: Step[];
}

export interface Usage {
  total: number;
  summary: string;
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
