// A metric's target (semantic layer part 5, D12): a fixed figure, or another metric over a plan dataset, with the
// period one figure covers and the status thresholds. This file is PURE — the type and its whitelist; ./metrics
// imports from here, never the other way round. A release that cannot compute one keeps it and shows nothing.

import { isScorePeriod, sanitizeThresholds } from './scorecardModel';
import type { ScorePeriod, Thresholds } from './scorecardModel';

export interface MetricTargetSpec {
  source: { value: number } | { metricId: string };
  per?: ScorePeriod;
  thresholds?: Thresholds;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeSource(raw: unknown): MetricTargetSpec['source'] | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return undefined;
  if (typeof o.value === 'number' && Number.isFinite(o.value)) return { value: o.value };
  if (typeof o.metricId === 'string' && UUID_RE.test(o.metricId)) return { metricId: o.metricId };
  return undefined;
}

/** The target when `raw` has a usable source, else undefined (the caller then leaves the key out). Idempotent. */
export function sanitizeTarget(raw: unknown): MetricTargetSpec | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const source = o ? sanitizeSource(o.source) : undefined;
  if (!o || !source) return undefined;
  const out: MetricTargetSpec = { source };
  if (isScorePeriod(o.per)) out.per = o.per;
  const thresholds = sanitizeThresholds(o.thresholds);
  if (thresholds) out.thresholds = thresholds;
  return out;
}
