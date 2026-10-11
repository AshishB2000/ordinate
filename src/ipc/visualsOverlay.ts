// A line/column chart's PERIOD OVERLAY — the same slice a year earlier, as a
// muted second series. MAIN PROCESS.
//
// A second resolution through the ordinary path, never a second computation:
// the prior series is `vizDataFor` again, with the date range in scope moved
// back a year (periodScope.overlayFilters) and the grain PINNED to the one the
// current chart ended up with, so both sides bucket identically. Each current
// bucket is then paired with the bucket twelve months before it
// (dateIntel.shiftBucketLabel), which is what "aligned by period" means — a
// missing month on either side is a gap, never a shift of every later point.
//
// Applies only where it can be read: one measure, no split, no pivot, no map,
// on a category that was bucketed as a date. Anything else returns the chart
// untouched rather than an overlay that means something other than it says.

import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import type { VizEncoding } from '../analysis/visuals';
import type { DateGrain } from '../analysis/categoryKey';
import { shiftBucketLabel } from '../analysis/dateIntel';
import { compareScope, overlayCaption, overlayFilters } from '../analysis/periodScope';
import { rangeLabel } from '../analysis/driverScope';
import { OTHER_LABEL } from '../analysis/categoryKey';
import type { VizDataReply } from './visuals';

type Base = (projectId: string, datasetId: string, enc: VizEncoding, filters: FilterStep[]) => Promise<VizDataReply>;

/**
 * The grain the caption should NAME. A `day` axis whose every bucket is the 1st
 * of a month is a monthly series (the sample's `Month` field is exactly that),
 * and "the same days last year" would be the wrong noun for it.
 */
function captionGrain(labels: (string | number)[], grain: DateGrain): DateGrain {
  if (grain !== 'day' || labels.length === 0) return grain;
  return labels.every((l) => /^\d{4}-\d{2}-01$/.test(String(l))) ? 'month' : grain;
}

export async function withPeriodOverlay(
  reply: VizDataReply,
  projectId: string,
  datasetId: string,
  enc: VizEncoding,
  filters: FilterStep[],
  base: Base,
): Promise<VizDataReply> {
  try {
    if (enc.overlay !== 'previous_year' || !reply.ok) return reply;
    if (enc.series || enc.pivot || enc.geo || enc.values.length !== 1) return reply;
    const cat = reply.category;
    if (!cat || cat.kind !== 'date' || !cat.grain) return reply;
    const cur = reply.data.series[0];
    if (!cur) return reply;

    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta) return reply;
    const priorEnc: VizEncoding = { ...enc, grain: cat.grain };
    delete priorEnc.overlay;
    // No date filter in scope → the chart already spans every date, and the
    // prior buckets are in THIS answer; asking again would be the same query.
    const priorFilters = overlayFilters(filters, meta.columns);
    const same = JSON.stringify(priorFilters) === JSON.stringify(filters);
    const prior = same ? reply : await base(projectId, datasetId, priorEnc, priorFilters);
    if (!prior.ok || !prior.data.series[0]) return reply;

    const byLabel = new Map<string, number | null>();
    prior.data.labels.forEach((l, i) => byLabel.set(String(l), prior.data.series[0].values[i] ?? null));
    const grain = cat.grain;
    const values = reply.data.labels.map((l) => {
      const key = shiftBucketLabel(String(l), grain);
      return key !== null && byLabel.has(key) ? (byLabel.get(key) as number | null) : null;
    });

    const series = reply.data.series.concat([{ name: `${cur.name} · last year`, values, role: 'overlay' as const }]);
    const cap = overlayCaption(enc.values[0].column, cur.values, values, captionGrain(reply.data.labels, grain));
    return {
      ...reply,
      data: { ...reply.data, series },
      overlay: cap ? { kind: 'previous_year', caption: cap.caption, pct: cap.pct } : { kind: 'previous_year' },
    };
  } catch (_) {
    return reply;
  }
}

/**
 * A dashboard's COMPARE on a chart: the same chart over the comparison period,
 * as a muted second series beside its own — before and after, bar by bar.
 *
 * The comparison period is the one a KPI card's Compare uses (periodScope.
 * compareScope — the date range in scope moved back, or a custom range), so a
 * sheet's KPIs and its charts compare the same two stretches of time. Like the
 * overlay above it is a second resolution through the ordinary path: the prior
 * chart is `base` again under the moved filters, paired with this one BY LABEL.
 * A category with rows only in the comparison period is appended (it had a
 * figure then and has none now); "Other" is never paired — it is whichever
 * categories fell outside the top of EACH period, so its two sides are not the
 * same thing.
 *
 * Applies where two bars side by side can be read: one measure, no split, a
 * category axis of labels. A DATED axis pairs bucket with bucket, which only
 * "a year earlier" defines — that is the overlay above, asked for here.
 * ponytail: previous period / custom dates leave a dated axis as it is;
 * pairing buckets by their offset from each range's start is the upgrade.
 */
export async function withCompareSeries(
  reply: VizDataReply,
  projectId: string,
  datasetId: string,
  enc: VizEncoding,
  filters: FilterStep[],
  base: Base,
): Promise<VizDataReply> {
  try {
    const compare = enc.compare;
    if (!compare || !reply.ok || reply.overlay) return reply;
    if (enc.series || enc.pivot || enc.geo || enc.cohort || enc.eventFunnel || enc.facet || enc.drivers) return reply;
    if (enc.values.length !== 1 || enc.values[0].aggregation === 'none' || reply.data.series.length !== 1) return reply;
    const cat = reply.category;
    if (cat && cat.kind === 'date') {
      return compare.mode === 'previous_year' ? withPeriodOverlay(reply, projectId, datasetId, { ...enc, overlay: 'previous_year' }, filters, base) : reply;
    }
    if (cat && cat.kind !== 'text') return reply; // a binned number axis is cut from each period's own range

    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta) return reply;
    const moved = compareScope(filters, meta.columns, compare);
    if (!moved) return reply; // no date in scope to move: the chart stays whole rather than compare with itself
    const priorEnc: VizEncoding = { ...enc };
    delete priorEnc.compare;
    const prior = await base(projectId, datasetId, priorEnc, moved.filters);
    if (!prior.ok || !prior.data.series[0]) return reply;

    const cur = reply.data.series[0];
    const before = new Map<string, number | null>();
    prior.data.labels.forEach((l, i) => {
      if (String(l) !== OTHER_LABEL) before.set(String(l), prior.data.series[0].values[i] ?? null);
    });
    const labels = reply.data.labels.slice();
    const now = cur.values.slice();
    const then: Array<number | null> = labels.map((l) => {
      const v = before.get(String(l));
      before.delete(String(l));
      return v === undefined ? null : v;
    });
    for (const [label, v] of before) {
      labels.push(label);
      now.push(null);
      then.push(v);
    }
    const name = `${cur.name} · ${rangeLabel(moved.prior) || 'comparison period'}`;
    return { ...reply, data: { ...reply.data, labels, series: [{ ...cur, values: now }, { name, values: then, role: 'overlay' as const }] } };
  } catch (_) {
    return reply;
  }
}
