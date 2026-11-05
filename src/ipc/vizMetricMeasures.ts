// A chart's metric measures, answered THROUGH the one chart door — MAIN PROCESS.
//
// analysis/metricMeasures.ts plans a formula measure (or a simple metric under
// its own filters) into the plain totals it is made of. This asks `vizDataFor`
// for those totals — so the resident fast path, the JS reference, the sampled
// preview, a Live warehouse and every typed refusal are whatever the door
// already does for a plain measure — and then evaluates the formula on each
// cell's totals. `[Profit] / [Revenue]` by region is each region's profit over
// each region's revenue.
//
// ── How many questions ──────────────────────────────────────────────────────
// One, in the ordinary case: the chart's plain measures and every unfiltered
// leaf ride in a single grouped query. A leaf whose metric has its OWN filters
// ("revenue, excluding refunds") is a different set of rows, so it is asked
// separately; and a split draws one measure per query (vizData.buildPivot), so
// each leaf is its own question there. Replies are lined up by label (and by
// series name under a split).
//
// A snapshot leaf (D8) is its own question too, answered on its latest day
// (./snapshotDoors.snapshotAnswer): a region with no row on that day has no
// figure, never its own older one.
//
// ponytail: several questions cannot be lined up when the axis itself depends
// on the rows asked — a text axis folded into "Other" keeps the top 50 BY THE
// FIRST MEASURE, numeric bins span the filtered range — so that combination is
// refused with a sentence rather than drawn misaligned. Lifting it means the
// door taking the kept keys / the bin plan as an argument.

import type { VizEncoding, VizMeasure } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { evaluateOperand } from '../analysis/metricMeasures';
import type { MeasurePlan, PlanResult } from '../analysis/metricMeasures';
import { mergeFx } from '../analysis/fx';
import * as msg from '../analysis/metricCheckMessages';
import type { MetricSnapshot } from '../analysis/snapshot';
import type { VizDataReply } from './visuals';
import { snapshotAnswer } from './snapshotDoors';
import { lineUp } from './lineUp';
import type { Ok, Series } from './lineUp';
import type { PerAt } from './snapshotPer';
import { periodChartData } from './periodChart';
import { funnelChartData } from './funnelChart';

type Ask = (encoding: VizEncoding, filters: FilterStep[]) => Promise<VizDataReply>;

/** One question for the door, and which leaves its series answer (in order, after `plain`). */
interface Call {
  own: FilterStep[];
  /** Its leaves' snapshot: the call is asked on that day (./snapshotDoors). */
  snapshot?: MetricSnapshot;
  /** `encoding.values` indexes of the plain measures leading this call. */
  plain: number[];
  leaves: number[];
}

function callsFor(plan: MeasurePlan, values: VizMeasure[], split: boolean): Call[] {
  if (split && plan.leaves.length) return plan.leaves.map((l, i) => ({ own: l.filters, ...(l.snapshot ? { snapshot: l.snapshot } : {}), plain: [], leaves: [i] }));
  const plain = values.map((_, i) => i).filter((i) => !plan.formulas.has(i));
  const byFilters = new Map<string, Call>();
  // The plain measures are under the chart's filters alone — the unfiltered leaves' call.
  if (plain.length) byFilters.set(JSON.stringify([[], null]), { own: [], plain, leaves: [] });
  plan.leaves.forEach((l, i) => {
    const key = JSON.stringify([l.filters, l.snapshot ?? null]);
    const call = byFilters.get(key) ?? { own: l.filters, ...(l.snapshot ? { snapshot: l.snapshot } : {}), plain: [], leaves: [] };
    call.leaves.push(i);
    byFilters.set(key, call);
  });
  // A formula with no total in it (`[Missing] * 2`) still needs the axis: one question, no leaves.
  return byFilters.size ? Array.from(byFilters.values()) : [{ own: [], plain: [], leaves: [] }];
}

const older = (a: Ok['asOf'], b: Ok['asOf']): Ok['asOf'] => (!a ? b : !b ? a : b.at < a.at ? b : a);

/** A chart whose measures name saved metrics, drawn as the metrics define them now (analysis/metricMeasures). */
/** `at`: the door's own project, dataset and options, where a per-entity snapshot leaf is asked (./snapshotPer). */
export function followMetricMeasures(res: Extract<PlanResult, { ok: true }>, encoding: VizEncoding, filters: FilterStep[], ask: Ask, at: PerAt): Promise<VizDataReply> {
  if (res.special?.kind === 'period') return periodChartData(res.special.metric, encoding, filters, ask, res.special.params); // charted alone (./periodChart)
  if (res.special?.kind === 'funnel') return funnelChartData(res.special.metric, encoding, filters, ask, res.special.params); // charted alone (./funnelChart)
  if (res.plan) return metricMeasureData(res.plan, { ...encoding, values: res.values }, filters, ask, at);
  // One question: the shared metric filters ahead of the chart's, and no metricId (the door would plan again).
  return ask({ ...encoding, values: res.values.map(({ metricId: _m, ...v }) => v) }, res.filters.concat(filters));
}

export async function metricMeasureData(plan: MeasurePlan, encoding: VizEncoding, filters: FilterStep[], ask: Ask, at: PerAt): Promise<VizDataReply> {
  if (encoding.facet) return { ok: false, error: msg.measureNoFacets() };
  const split = typeof encoding.series === 'string' && encoding.series !== '';
  const values = split ? encoding.values.slice(0, 1) : encoding.values;
  const calls = callsFor(plan, values, split);
  // Inner measures are plain: no metricId (the door would plan again), no calc (it runs on the finished reply).
  const bare = (m: VizMeasure): VizMeasure => (m.datasetId ? { column: m.column, aggregation: m.aggregation, datasetId: m.datasetId } : { column: m.column, aggregation: m.aggregation });
  const run = (c: Call, enc: VizEncoding): Promise<VizDataReply> => {
    // A leaf on another table names it, so the door joins it in (forward) or asks it on its own table (a many side, ./vizFanOut).
    const asked = c.plain.map((i) => bare(values[i])).concat(c.leaves.map((i) => bare(plan.leaves[i])));
    // The axis-only question counts the category: its labels are read, its figures are not.
    const e = { ...enc, values: asked.length ? asked : [{ column: enc.category, aggregation: 'count' as const }] };
    return c.snapshot ? snapshotAnswer(c.snapshot, e, c.own.concat(filters), ask, at) : ask(e, c.own.concat(filters));
  };

  const first = await run(calls[0], encoding);
  if (!first.ok) return first;
  // An auto-grained date axis is chosen from the rows asked: every later question keeps the first one's grain.
  const pinned = !encoding.grain && first.category?.grain ? { ...encoding, grain: first.category.grain } : encoding;
  const rest = await Promise.all(calls.slice(1).map((c) => run(c, pinned)));
  const failed = rest.find((r) => !r.ok);
  if (failed) return failed;
  const replies = [first, ...(rest as Ok[])];
  if (replies.length > 1 && replies.some((r) => r.category?.note || r.category?.binned)) {
    return { ok: false, error: msg.measureNeedsOneAxis(Array.from(plan.formulas.values())[0].name) };
  }

  // The axis: every label any reply drew, in first-seen order (./lineUp).
  const { labels, keys, cell } = lineUp(replies);

  let series: Series[];
  if (split) {
    // One reply per leaf, each a label × split-value grid: line the grids up by series name.
    const names: string[] = [];
    for (const r of replies) for (const s of r.data.series) if (!names.includes(s.name)) names.push(s.name);
    const root = plan.formulas.get(0)?.root ?? null;
    series = names.map((name) => ({
      name,
      values: keys.map((k) => evaluateOperand(root, (leaf) => cell(leaf, replies[leaf].data.series.find((s) => s.name === name), k))),
    }));
  } else {
    // Where each plain measure and each leaf was answered: (reply, series position).
    const plainAt = new Map<number, Series | undefined>();
    const leafAt = new Map<number, { reply: number; series: Series | undefined }>();
    calls.forEach((c, r) => {
      c.plain.forEach((i, p) => plainAt.set(i, replies[r].data.series[p]));
      c.leaves.forEach((l, p) => leafAt.set(l, { reply: r, series: replies[r].data.series[c.plain.length + p] }));
    });
    series = values.map((_, i) => {
      const f = plan.formulas.get(i);
      if (f) {
        const cells = keys.map((k) => evaluateOperand(f.root, (leaf) => {
          const at = leafAt.get(leaf);
          return at ? cell(at.reply, at.series, k) : null;
        }));
        // A simple metric keeps the door's own series (its name, so per-series formatting still applies).
        return f.simple && 'leaf' in f.root ? { ...(leafAt.get(f.root.leaf)?.series ?? { name: f.name }), values: cells } : { name: f.name, values: cells };
      }
      const s = plainAt.get(i);
      return { ...(s ?? { name: values[i].column }), values: keys.map((k) => cell(0, s, k)) };
    });
  }

  const data: Ok['data'] = { ...first.data, labels, series };
  // A map's regions come from the first series (vizData.buildVizData): a no-data region is omitted, never 0.
  if (first.data.geo) {
    const items: { name: string; value: number }[] = [];
    labels.forEach((name, k) => {
      const v = series[0]?.values[k];
      if (typeof v === 'number') items.push({ name: String(name), value: v });
    });
    data.geo = { ...first.data.geo, items };
  }
  const out: Ok = { ...first, data, warnings: Array.from(new Set(replies.flatMap((r) => r.warnings))) };
  const notes = Array.from(new Set(replies.flatMap((r) => r.notes ?? []))); // a many-side leaf's (./vizFanOut)
  if (notes.length) out.notes = notes;
  const fx = replies.reduce<Ok['fx']>((a, r) => mergeFx(a, r.fx), undefined);
  const asOf = replies.reduce<Ok['asOf']>((a, r) => older(a, r.asOf), undefined);
  if (fx) out.fx = fx;
  if (asOf) out.asOf = asOf;
  return out;
}
