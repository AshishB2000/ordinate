// A chart with measures on the many sides of its relationships, answered THROUGH the one chart door —
// MAIN PROCESS (semantic layer part 8, D10–D14).
//
// analysis/fanOutPlan.ts splits the chart into one question per table its measures live on. Each is
// asked of `vizDataFor`, so row access rules (each question's own door), Live (a Live many side refuses
// `related` as any join on Live does), the answer cache and the resident-or-JS decision are whatever the
// door already does for a plain chart on that table. The replies are lined up by label (./lineUp), the
// first reply's auto grain pinned on the rest, as ./vizMetricMeasures does: nothing is summed, averaged or
// rounded here. The tile's `notes` say which measures count their own rows and which filters reach only
// some of them.

import type { VizEncoding } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { planFanOut } from '../analysis/fanOutPlan';
import type { FanOutPlan } from '../analysis/fanOutPlan';
import { measureLabel } from '../analysis/vizData';
import { mergeFx } from '../analysis/fx';
import * as msg from '../analysis/fanOutMessages';
import { chartReads, projectModel } from './relationships';
import { lineUp } from './lineUp';
import type { Ok, Series } from './lineUp';
import type { VizDataReply } from './visuals';

type Ask = (datasetId: string, encoding: VizEncoding, filters: FilterStep[]) => Promise<VizDataReply>;

const older = (a: Ok['asOf'], b: Ok['asOf']): Ok['asOf'] => (!a ? b : !b ? a : b.at < a.at ? b : a);

/** Does any measure name another dataset? Every other chart skips the relationship read entirely. */
const namesOther = (datasetId: string, encoding: VizEncoding): boolean =>
  !!encoding && Array.isArray(encoding.values) && encoding.values.some((v) => v && typeof v.datasetId === 'string' && v.datasetId !== datasetId);

/** The plan's questions asked and lined up: the first alone, the rest with its auto grain. */
export async function askFanOut(plan: FanOutPlan, encoding: VizEncoding, ask: Ask): Promise<VizDataReply> {
  const [q0, ...more] = plan.questions;
  const first = await ask(q0.datasetId, q0.encoding, q0.filters);
  if (!first.ok) return first;
  const grain = !encoding.grain && first.category?.grain;
  const rest = await Promise.all(more.map((q) => ask(q.datasetId, grain ? { ...q.encoding, grain } : q.encoding, q.filters)));
  const failed = rest.find((r) => !r.ok);
  if (failed) return failed;
  const replies = [first, ...(rest as Ok[])];
  if (replies.length > 1 && replies.some((r) => r.category?.note || r.category?.binned)) return { ok: false, error: msg.fanOutOneAxis() };

  const { labels, keys, cell } = lineUp(replies);
  const align = (r: number, s: Series): Series => ({ ...s, values: keys.map((k) => cell(r, s, k)) });
  const split = typeof encoding.series === 'string' && encoding.series !== '';
  // A split draws values[0] alone: one question, its series the split values. Otherwise the chart's measure order.
  const series = split ? replies.flatMap((r, ri) => r.data.series.map((s) => align(ri, s)))
    : plan.questions.flatMap((q, ri) => q.measures.map((m, p) => ({ m, s: align(ri, replies[ri].data.series[p] ?? { name: measureLabel(encoding.values[m]), values: [] }) })))
      .sort((a, b) => a.m - b.m).map((x) => x.s);
  const nameOf = (m: number): string => `“${split ? measureLabel(encoding.values[m]) : series[m].name}”`;
  const names = (ms: number[]): string => ms.map(nameOf).join(', ');
  const ours = plan.notes.map((n) => (n.kind === 'ownRows' ? msg.fanOutOwnRows(names(n.measures))
    : n.measures.length ? msg.fanOutNarrows(n.column, names(n.measures)) : msg.fanOutNarrowsNone(n.column)));

  const out: Ok = {
    ...first, data: { ...first.data, labels, series },
    warnings: Array.from(new Set(replies.flatMap((r) => r.warnings))),
    notes: Array.from(new Set(replies.flatMap((r) => r.notes ?? []).concat(ours))),
  };
  const fx = replies.reduce<Ok['fx']>((a, r) => mergeFx(a, r.fx), undefined);
  const asOf = replies.reduce<Ok['asOf']>((a, r) => older(a, r.asOf), undefined);
  if (fx) out.fx = fx;
  if (asOf) out.asOf = asOf;
  return out;
}

/** The chart's reply by drill-across, its refusal, or null when no measure sits on a many side (today's path). */
export async function fanOutVizData(projectId: string, datasetId: string, encoding: VizEncoding, filters: FilterStep[], ask: Ask): Promise<VizDataReply | null> {
  if (!namesOther(datasetId, encoding)) return null;
  const { rels, infos } = await projectModel(projectId, datasetId);
  const planned = planFanOut(datasetId, encoding, filters, rels, infos);
  if (!planned) return null;
  return planned.ok ? askFanOut(planned.plan, encoding, ask) : { ok: false, error: planned.error };
}

/** Every table a fan-out chart's questions read besides `datasetId` — each question's dataset and its own join's tables, once (row access gates exactly these). */
export async function fanOutReads(projectId: string, datasetId: string, encoding: VizEncoding, filters: FilterStep[]): Promise<string[]> {
  if (!namesOther(datasetId, encoding)) return [];
  const { rels, infos } = await projectModel(projectId, datasetId);
  const planned = planFanOut(datasetId, encoding, filters, rels, infos);
  if (!planned || !planned.ok) return [];
  const out = new Set<string>();
  for (const q of planned.plan.questions) for (const id of [q.datasetId, ...(await chartReads(projectId, q.datasetId, q.encoding, q.filters))]) out.add(id);
  out.delete(datasetId);
  return [...out];
}
