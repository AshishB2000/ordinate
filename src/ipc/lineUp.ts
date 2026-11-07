// Several chart-door replies on ONE axis — MAIN PROCESS, PURE. The formula measures (./vizMetricMeasures)
// and the fan-out questions (./vizFanOut) each ask the door more than once and line the answers up here:
// every label any reply drew, in first-seen order (a date's, from more than one reply, in time order, blank last), and each
// reply's figure under it. Nothing is computed: a label a reply did not draw is null, never 0.

import { keyOf } from '../analysis/vizData';
import { bucketRange } from '../analysis/periodBuckets';
import type { VizDataReply } from './visuals';

export type Ok = Extract<VizDataReply, { ok: true }>;
export type Series = Ok['data']['series'][number];

export function lineUp(replies: Ok[]): { labels: (string | number)[]; keys: string[]; cell(reply: number, series: Series | undefined, key: string): number | null } {
  const labels: (string | number)[] = [];
  const seen = new Set<string>();
  const rowOf = replies.map((r) => {
    const at = new Map<string, number>();
    r.data.labels.forEach((l, i) => {
      const k = keyOf(l);
      at.set(k, i);
      if (seen.has(k)) return;
      seen.add(k);
      labels.push(l);
    });
    return at;
  });
  // A date axis merged from several replies is in time order, blank (or unreadable) last: appended first-seen, a period
  // only a later reply drew would land after later ones. The first reply's grain is every reply's (pinned by the callers).
  const { kind, grain } = replies[0]?.category ?? {};
  if (replies.length > 1 && (kind === 'date' || grain)) {
    const day = new Map(labels.map((l) => [l, l == null || l === '' ? null : grain ? (bucketRange(String(l), grain)?.from ?? null) : String(l)]));
    labels.sort((a, b) => {
      const [x, y] = [day.get(a) ?? null, day.get(b) ?? null];
      return x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
    });
  }
  const keys = labels.map((l) => keyOf(l));
  const cell = (reply: number, series: Series | undefined, key: string): number | null => {
    const row = rowOf[reply].get(key);
    const v = series && row !== undefined ? series.values[row] : null;
    return typeof v === 'number' ? v : null;
  };
  return { labels, keys, cell };
}
