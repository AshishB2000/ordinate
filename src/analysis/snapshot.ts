// A snapshot metric (semantic layer part 1): a stock count is the last (or first) day's value, not a sum over
// every day. This file is the TYPE and its whitelist; metrics.ts imports from here, never the other way round.

/** Which row of each group a snapshot metric reads: the latest or the earliest by `column` (a date column). */
export interface MetricSnapshot {
  column: string;
  take: 'last' | 'first';
}

const MAX_COLUMN = 512;

/** The snapshot when `raw` is well formed, else undefined (the caller then leaves the key out). */
export function sanitizeSnapshot(raw: unknown): MetricSnapshot | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.column !== 'string' || !o.column || o.column.length > MAX_COLUMN) return undefined;
  if (o.take !== 'last' && o.take !== 'first') return undefined;
  return { column: o.column, take: o.take };
}
