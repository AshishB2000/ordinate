// A chart's formula measures, answered THROUGH the one chart door — MAIN PROCESS.
//
// analysis/metricMeasures.ts plans a formula measure into the plain totals it
// is made of. This asks `vizDataFor` for those totals — so the resident fast
// path, the JS reference, the sampled preview, a Live warehouse and every typed
// refusal are whatever the door already does for a plain measure — and then
// evaluates the formula on each cell's totals. `[Profit] / [Revenue]` by region
// is each region's profit over each region's revenue.
//
// ── How many questions ──────────────────────────────────────────────────────
// One, in the ordinary case: the chart's plain measures and every unfiltered
// leaf ride in a single grouped query. A leaf whose metric has its OWN filters
// ("revenue, excluding refunds") is a different set of rows, so it is asked
// separately; and a split draws one measure per query (vizData.buildPivot), so
// each leaf is its own question there. Replies are lined up by label (and by
// series name under a split).
//
// ponytail: several questions cannot be lined up when the axis itself depends
// on the rows asked — a text axis folded into "Other" keeps the top 50 BY THE
// FIRST MEASURE, numeric bins span the filtered range — so that combination is
// refused with a sentence rather than drawn misaligned. Lifting it means the
// door taking the kept keys / the bin plan as an argument.

import type { VizEncoding, VizMeasure } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { keyOf } from '../analysis/vizData';
import { evaluateOperand } from '../analysis/metricMeasures';
import type { MeasurePlan } from '../analysis/metricMeasures';
import { mergeFx } from '../analysis/fx';
import * as msg from '../analysis/metricCheckMessages';
import type { VizDataReply } from './visuals';

type Ok = Extract<VizDataReply, { ok: true }>;
type Series = Ok['data']['series'][number];
type Ask = (encoding: VizEncoding, filters: FilterStep[]) => Promise<VizDataReply>;

/** One question for the door, and which leaves its series answer (in order, after `plain`). */
interface Call {
  own: FilterStep[];
  /** `encoding.values` indexes of the plain measures leading this call. */
  plain: number[];
  leaves: number[];
}

function callsFor(plan: MeasurePlan, values: VizMeasure[], split: boolean): Call[] {
  if (split && plan.leaves.length) return plan.leaves.map((l, i) => ({ own: l.filters, plain: [], leaves: [i] }));
  const plain = values.map((_, i) => i).filter((i) => !plan.formulas.has(i));
  const byFilters = new Map<string, Call>();
  // The plain measures are under the chart's filters alone — the unfiltered leaves' call.
  if (plain.length) byFilters.set('[]', { own: [], plain, leaves: [] });
  plan.leaves.forEach((l, i) => {
    const key = JSON.stringify(l.filters);
    const call = byFilters.get(key) ?? { own: l.filters, plain: [], leaves: [] };
    call.leaves.push(i);
    byFilters.set(key, call);
  });
  // A formula with no total in it (`[Missing] * 2`) still needs the axis: one question, no leaves.
  return byFilters.size ? Array.from(byFilters.values()) : [{ own: [], plain: [], leaves: [] }];
}

const older = (a: Ok['asOf'], b: Ok['asOf']): Ok['asOf'] => (!a ? b : !b ? a : b.at < a.at ? b : a);

export async function metricMeasureData(plan: MeasurePlan, encoding: VizEncoding, filters: FilterStep[], ask: Ask): Promise<VizDataReply> {
  if (encoding.facet) return { ok: false, error: msg.measureNoFacets() };
  const split = typeof encoding.series === 'string' && encoding.series !== '';
  const values = split ? encoding.values.slice(0, 1) : encoding.values;
  const calls = callsFor(plan, values, split);
  // Inner measures are plain: no metricId (the door would plan again), no calc (it runs on the finished reply).
  const bare = (m: VizMeasure): VizMeasure => (m.datasetId ? { column: m.column, aggregation: m.aggregation, datasetId: m.datasetId } : { column: m.column, aggregation: m.aggregation });
  const run = (c: Call, enc: VizEncoding): Promise<VizDataReply> => {
    const asked = c.plain.map((i) => bare(values[i])).concat(c.leaves.map((i) => ({ column: plan.leaves[i].column, aggregation: plan.leaves[i].aggregation })));
    // The axis-only question counts the category: its labels are read, its figures are not.
    return ask({ ...enc, values: asked.length ? asked : [{ column: enc.category, aggregation: 'count' }] }, c.own.concat(filters));
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

  // The axis: every label any reply drew, in first-seen order.
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
  const keys = labels.map((l) => keyOf(l));
  const cell = (reply: number, series: Series | undefined, key: string): number | null => {
    const row = rowOf[reply].get(key);
    const v = series && row !== undefined ? series.values[row] : null;
    return typeof v === 'number' ? v : null;
  };

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
        return { name: f.name, values: keys.map((k) => evaluateOperand(f.root, (leaf) => {
          const at = leafAt.get(leaf);
          return at ? cell(at.reply, at.series, k) : null;
        })) };
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
  const fx = replies.reduce<Ok['fx']>((a, r) => mergeFx(a, r.fx), undefined);
  const asOf = replies.reduce<Ok['asOf']>((a, r) => older(a, r.asOf), undefined);
  if (fx) out.fx = fx;
  if (asOf) out.asOf = asOf;
  return out;
}
