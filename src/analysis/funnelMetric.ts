// A funnel metric (semantic layer part 5, D5): "Visit → buy", the share of entities that reached a funnel's last step.
// This file is PURE — the type and its whitelist; ./metrics imports from here, never the other way round. A release
// that cannot compute one keeps it verbatim and shows no figure (./pendingKinds).

import { FUNNEL_MIN_STEPS, sanitizeEventFunnel } from './funnelEvents';
import type { FunnelEncoding } from './funnelEvents';

/** What the metric's figure is: converted ÷ entered, the converted count, or the entered count. */
export type FunnelShow = 'rate' | 'converted' | 'entered';

export interface MetricFunnelDefinition {
  /** The funnel grid's encoding, without a breakdown. */
  funnel: Omit<FunnelEncoding, 'breakdown'>;
  show: FunnelShow;
}

const SHOWS: ReadonlySet<string> = new Set<FunnelShow>(['rate', 'converted', 'entered']);

/** The definition when `raw` is a well-formed funnel kind (at least FUNNEL_MIN_STEPS steps), else undefined. Idempotent. */
export function sanitizeFunnelDefinition(raw: unknown): MetricFunnelDefinition | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.show !== 'string' || !SHOWS.has(o.show)) return undefined;
  const enc = sanitizeEventFunnel(o.funnel);
  if (!enc || enc.steps.length < FUNNEL_MIN_STEPS) return undefined;
  const { entity, event, time, steps, window } = enc;
  return { funnel: { entity, event, time, steps, window }, show: o.show as FunnelShow };
}
