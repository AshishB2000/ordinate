// The figures of an answer whose category, split, a measure, a filter or a term is a RELATED dataset's (docs/assistant/
// 00-design.md, "Joins in the chart form, as built") — MAIN PROCESS. Not a second join: the card asks THE chart door (./visuals `vizDataFor`) with the spec's
// encoding (../ai/answerJoin `specEncoding`), so the join plan (many → one only, the reverse refused in the planner's
// sentence), the fan-out rules, the folder check, row lock and hidden columns of every table it reads, and the answer
// cache are a visual's own. A spec with no related field never comes here: ./answers draws it on its rows.
//
// A Live asked dataset's joined card (./liveAnswers) takes its figures here too: the door sends a chart whose tables are
// all Live on one connection to the Live join's executor (./liveJoin, its `orgKey` cache), and any other mix (a copy
// beside a Live dataset, two connections) answers in its own typed sentence (`live_refused`), never `live_dataset`.

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type { ChartData, VizDataResult } from '../analysis/vizData';
import type { CalcSeries } from '../analysis/tableCalc';
import type { AsOf } from '../api/asOf';
import { specFilterSteps, type AnswerFilter } from '../ai/answerSpec';
import { hiddenColumnsFor } from '../data/rowAccess';
import { RowPolicyError, type RowPolicyReason } from '../data/rowPolicyError';
import { FolderError, isFolderError, type FolderReason } from '../server/authz/folders';
import { folderGate } from '../server/authz/folderGate';
import { TERM_CODE } from '../data/termStep';
import { dropHidden } from '../ai/hiddenFacts';
import { withheldColumns } from '../app/sharePolicy';
import { isLive } from '../data/liveDataset';
import { liveWithheld } from './liveProfile';
import type { LiveFailureCode } from '../engine/live/liveQuery';
import { filterOn, relatedIds, relatedRefs, specEncoding } from '../ai/answerJoin';
import type { AnswerSpec, SpecDataset } from '../ai/answerSpec';
import { chartReads, projectModel } from './relationships';
import { findPath } from '../analysis/joinPlan';
import { vizDataFor } from './visuals';
import type { Failure } from './answers';

/** A related side as the card reads it: its record, and its columns as the caller sees them (a hidden one is no chip). */
export interface JoinedSide { meta: DatasetMeta; columns: ParsedColumn[] }

/**
 * `withheld`: the category, split or a filter's column a related dataset marks personal or financial (a model never reads
 * their labels or values). `names`: each related dataset's name by id, for the card's words.
 */
export interface Joined { ok: true; category?: JoinedSide; series?: JoinedSide; withheld: string[]; metas: DatasetMeta[]; names: Record<string, string> }

/**
 * The related sides of a joined spec, or why its card cannot be drawn: a related dataset in a folder the caller cannot
 * open or only reaches (typed `folder`), or a related column no longer there. A related dataset that is gone is left to
 * the planner, and a mix of Live and copies to the chart door, each of which says so in its own sentence.
 */
export async function joinedSides(projectId: string, spec: AnswerSpec): Promise<Joined | Failure> {
  const out: Joined = { ok: true, withheld: [], metas: [], names: {} };
  for (const [key, id, column] of relatedRefs(spec)) {
    if (!id || !column || id === spec.datasetId) continue;
    const meta = await datasets.getDatasetMeta(projectId, id);
    if (!meta) {
      // A folder the caller cannot open, or one they only REACH (D9): refused as the answer door refuses its own dataset
      // (`open`: `closed` / `figures_only`), raised and caught so the route types it. Else it is gone: the planner says so.
      try {
        await folderGate(projectId, id, undefined, 'open');
      } catch (err) {
        if (isFolderError(err)) return { ok: false, reason: err.message };
        throw err;
      }
      continue;
    }
    if (!meta.columns.some((c) => c.name === column)) return { ok: false, reason: `"${column}" is no longer a column of ${meta.name}.` };
    if (key === 'category' || key === 'series') out[key] = { meta, columns: dropHidden(meta.columns, await hiddenColumnsFor(projectId, id)) };
    // A Live one's set is its facts' own, stricter one (./liveProfile): pending and detected columns too. A measure's figure is no label.
    if (key !== 'measure' && (isLive(meta) ? await liveWithheld(projectId, id, meta) : await withheldColumns(projectId, id)).has(column)) out.withheld.push(column);
    if (!out.metas.some((m) => m.id === meta.id)) out.metas.push(meta);
    out.names[meta.id] = meta.name;
  }
  // A filter pinned to a dataset the planner cannot reach (the many side): its sentence, as a related category's is.
  // The planner itself says a glossary term's (the pin's first use) for one, which a plain filter is not.
  // A many-side measure's own dataset is the door's to judge (a drill-across narrows that side by it).
  const measured = new Set(spec.measures.map((m) => m.datasetId));
  const pinned = spec.filters.flatMap((f) => (!('term' in f) && filterOn(f) && filterOn(f) !== spec.datasetId && !measured.has(filterOn(f)) ? [filterOn(f) as string] : []));
  if (pinned.length) {
    const { rels, infos } = await projectModel(projectId, spec.datasetId);
    for (const id of new Set(pinned)) {
      const p = infos.has(id) ? findPath(spec.datasetId, id, rels, (x) => infos.get(x)?.name || 'A dataset') : { ok: true as const };
      if (!p.ok) return { ok: false, reason: p.error };
    }
  }
  return out;
}

const LIVE_CODES: ReadonlySet<string> = new Set<LiveFailureCode>(['live_refused', 'live_unavailable', 'live_failed', 'live_timeout', 'live_cancelled']);

/** The chart's figures through THE chart door, as a visual of this encoding draws them. A refusal keeps its type, as the answer door's do. */
export async function joinedViz(projectId: string, spec: AnswerSpec, steps: FilterStep[]): Promise<Pick<VizDataResult, 'data' | 'warnings' | 'category'> & { asOf?: AsOf } | Failure> {
  const r = await vizDataFor(projectId, spec.datasetId, specEncoding(spec), steps);
  if (r.ok) return { data: r.data, warnings: [...r.warnings, ...(r.notes ?? []).filter((n) => !r.warnings.includes(n))], ...(r.category ? { category: r.category } : {}), ...(r.asOf ? { asOf: r.asOf } : {}) };
  // A row access or folder refusal is raised and caught HERE, so the route types the reply that carries its sentence
  // (rowPolicyRaised / folderRaised: answer:card's `{ok:false}`), and an ask keeps its turn with "(No chart: …)".
  if (r.code === 'row_policy') return { ok: false, reason: new RowPolicyError(r.reason as RowPolicyReason).message };
  if (r.code === 'folder') return { ok: false, reason: new FolderError(r.reason as FolderReason).message };
  const code = r.code === TERM_CODE || (r.code && LIVE_CODES.has(r.code)) ? { code: r.code as Failure['code'] } : {};
  return { ok: false, reason: r.error, ...code };
}

/**
 * Largest first, and at most `top` of them. An answer about categories reads
 * best ranked; a date axis keeps time order and never takes a top-N.
 */
export function ranked(data: ChartData, top?: number): ChartData {
  const first: CalcSeries | undefined = data.series[0];
  if (!first) return data;
  const by = first.raw ?? first.values; // the figures, never a calculated one: rank 1 is the largest
  const order = data.labels.map((_, i) => i).sort((a, b) => {
    const va = by[a];
    const vb = by[b];
    if (typeof va !== 'number') return typeof vb === 'number' ? 1 : a - b;
    if (typeof vb !== 'number') return -1;
    return vb - va || a - b;
  });
  const keep = top && top > 0 ? order.slice(0, top) : order;
  const pick = <T>(xs: T[]): T[] => keep.map((i) => xs[i]);
  return {
    labels: pick(data.labels),
    series: data.series.map((s: CalcSeries) => ({ name: s.name, values: pick(s.values), ...(s.calc && s.raw ? { raw: pick(s.raw), calc: s.calc } : {}) })),
  };
}

/**
 * A Live asked dataset's joined chart in `liveAnswer`'s shape (../engine/live/liveQuery): the door's figures for the spec's
 * filters (a period read from no row, as the Live card labels it) and `extra` (its lock and its terms' steps), ranked and
 * cut as a copy's card is (`ranked`, here, after the door), its warnings and category note as the card's notes.
 */
export async function joinedLive(projectId: string, spec: AnswerSpec, filters: AnswerFilter[], columns: ParsedColumn[], extra: readonly FilterStep[], isDate: boolean)
  : Promise<{ ok: true; data: ChartData; category: VizDataResult['category']; warnings: string[]; notes: string[]; asOf: AsOf } | Failure> {
  const v = await joinedViz(projectId, spec, [...specFilterSteps({ filters }, columns, []).steps, ...extra]);
  if ('ok' in v) return v;
  if (!v.asOf) throw new Error('A Live chart came back undated'); // the door dates every Live figure (stampAsOf): never one undated
  const data: ChartData = { labels: v.data.labels, series: v.data.series };
  return { ok: true, data: isDate ? data : ranked(data, spec.top), category: v.category, warnings: [], notes: [...v.warnings, ...(v.category?.note ? [v.category.note] : [])], asOf: v.asOf };
}

/**
 * Every dataset a joined answer reads, its own first: the related ones and its join plan's tables (./relationships
 * chartReads), a related filter's path too. A related term's own table is in `relatedIds`.
 */
export async function answerReads(projectId: string, spec: AnswerSpec): Promise<string[]> {
  const pinned = specFilterSteps({ filters: spec.filters.filter((f) => !('term' in f) && filterOn(f)) }, [], []).steps;
  return [...new Set([spec.datasetId, ...relatedIds(spec), ...(await chartReads(projectId, spec.datasetId, specEncoding(spec), pinned))])];
}

/**
 * A stored joined spec's related datasets as the validator reads them, and their names; null when one is gone or no
 * longer has its column (by exact name, as the card reads it): a follow-up then starts afresh.
 */
export async function relatedOfStored(projectId: string, spec: AnswerSpec): Promise<{ datasets: SpecDataset[]; on: { category?: string; series?: string; datasets: Record<string, string> } } | null> {
  const out: SpecDataset[] = [];
  const on: { category?: string; series?: string; datasets: Record<string, string> } = { datasets: {} };
  for (const [key, id, column] of relatedRefs(spec)) {
    if (!id || id === spec.datasetId || (!column && key !== 'filter')) continue; // a term's dataset has no column of its own here
    const meta = await datasets.getDatasetMeta(projectId, id);
    if (!meta || (column && !meta.columns.some((c) => c.name === column))) return null;
    if (key === 'category' || key === 'series') on[key] = meta.name;
    on.datasets[meta.id] = meta.name;
    if (!out.some((d) => d.id === meta.id)) out.push({ id: meta.id, name: meta.name, columns: meta.columns });
  }
  return { datasets: out, on };
}
