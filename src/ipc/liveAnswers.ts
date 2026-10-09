// An AI answer on a Live dataset (docs/live-data/00-plan.md L2.4) — MAIN PROCESS.
//
// `answers.computeCard` asks here first; null means "not Live", and the
// extract path runs unchanged. On a Live dataset the card is built from the
// same pieces the extract card uses — the caption, the facts and their ledger,
// the chips — over the warehouse's answer (engine/live/liveQuery.liveAnswer),
// which is ranked and cut to `top` IN SQL: it is never ranked again here.
//
// The three things the extract path reads rows for, live:
//   - periods ("last quarter") resolve against the warehouse's own latest date,
//     one cached MAX() (the executor);
//   - text-filter case fixing ("west" asked, "West" stored) is a cached lookup,
//     `SELECT DISTINCT col … WHERE key(col) IN (…) LIMIT 20` — the asked values
//     bound as parameters, never inlined (engine/live/compile.compileCaseMatches);
//   - the "Split by …" chip's candidates come from `liveSplitCandidates`, which
//     the dataset's profile will feed (L2.5).
// Every figure on the card is the warehouse's, and it enters the facts' ledger
// exactly as an extract's does, so `guardAnswer` audits a narration of it.

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import { isLive } from '../data/liveDataset';
import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { utcLabel } from '../data/figureAsOf';
import type { ChartData } from '../analysis/vizData';
import { tileCaption } from '../analysis/captions';
import { displayNames } from '../app/catalog';
import { ANSWER_CHART_TYPES, answerChips, defaultAnswerChart, specFilterSteps } from '../ai/answerSpec';
import type { AnswerFilter, AnswerSpec } from '../ai/answerSpec';
import { answerFacts, describeAnswer } from '../ai/answerFacts';
import { liveAnswer, liveLookup } from '../engine/live/liveQuery';
import type { LiveFailure } from '../engine/live/liveQuery';
import type { PeriodRange } from '../engine/live/evaluate';
import { compileCaseMatches } from '../engine/live/compile';
import type { Built, Failure } from './answers';

/** The operators the case fix applies to — `answers.canonicaliseTextFilters`'s. */
const CASE_OPS: ReadonlySet<string> = new Set(['=', '!=', 'in', 'not in']);

/** How the case fix compares a stored and an asked value: JS's own trim and lower case. */
const caseKey = (v: string): string => v.trim().toLowerCase();

/**
 * Text columns worth offering as "Split by …" on a Live dataset. Until the
 * dataset's profile exists (L2.5: approximate distinct counts, sample values)
 * this is the declared text columns other than the category, in schema order —
 * the extract's rule (2–12 distinct values, fewest first) needs counts a
 * schema does not have. L2.5 fills this from the profile; nothing else changes.
 */
export function liveSplitCandidates(meta: Pick<DatasetMeta, 'columns'>, exclude: string): string[] {
  return meta.columns.filter((c) => c.type === 'text' && c.name !== exclude).map((c) => c.name);
}

function fail(f: LiveFailure): Failure {
  return { ok: false, reason: f.error, code: f.code };
}

/**
 * The spec's text filters with every asked value replaced by the spelling the
 * warehouse holds — one cached lookup per column, the keys sorted so the same
 * question in another order is the same statement. A value nothing matches is
 * left as asked (the chart then says so, as the extract's does).
 */
export async function liveCaseFix(projectId: string, datasetId: string, columns: ParsedColumn[], filters: AnswerFilter[]): Promise<{ ok: true; filters: AnswerFilter[] } | LiveFailure> {
  const asked = new Map<string, Set<string>>();
  for (const f of filters) {
    if ('period' in f || !CASE_OPS.has(f.op)) continue;
    const col = columns.find((c) => c.name === f.column);
    if (!col || col.type !== 'text') continue;
    const keys = asked.get(col.name) ?? new Set<string>();
    for (const v of [f.value, ...(f.values ?? [])]) if (typeof v === 'string') keys.add(caseKey(v));
    if (keys.size) asked.set(col.name, keys);
  }
  if (!asked.size) return { ok: true, filters };
  const stored = new Map<string, Map<string, string>>();
  for (const [column, keys] of asked) {
    const r = await liveLookup(projectId, datasetId, (t) => compileCaseMatches(column, [...keys].sort(), t.env));
    if (!r.ok) return r;
    const byKey = new Map<string, string>();
    for (const row of r.rows) {
      const v = row[0];
      if (typeof v === 'string' && !byKey.has(caseKey(v))) byKey.set(caseKey(v), v);
    }
    stored.set(column, byKey);
  }
  return {
    ok: true,
    filters: filters.map((f): AnswerFilter => {
      if ('period' in f || !CASE_OPS.has(f.op)) return f;
      const byKey = stored.get(f.column);
      if (!byKey) return f;
      const fix = (v: Cell): Cell => (typeof v === 'string' ? byKey.get(caseKey(v)) ?? v : v);
      const out = { ...f };
      if (f.value !== undefined) out.value = fix(f.value);
      if (f.values) out.values = f.values.map(fix);
      return out;
    }),
  };
}

/**
 * The card's filters as steps ("Save as visual", "Open in builder"), in spec
 * order, as `specFilterSteps` writes them: a period as its two inclusive day
 * bounds — the range the warehouse's latest date resolved it to — and a column
 * with no date at all as the extract's empty `in`.
 */
function cardSteps(filters: AnswerFilter[], columns: ParsedColumn[], ranges: PeriodRange[]): FilterStep[] {
  const steps: FilterStep[] = [];
  const left = ranges.slice();
  for (const f of filters) {
    if (!columns.some((c) => c.name === f.column)) continue;
    if (!('period' in f)) {
      steps.push(...specFilterSteps({ filters: [f] }, columns, []).steps);
      continue;
    }
    const r = left.shift();
    if (!r) continue;
    if (r.from === null) steps.push({ type: 'filter', column: f.column, op: 'in', values: [] });
    else steps.push({ type: 'filter', column: f.column, op: '>=', value: r.from }, { type: 'filter', column: f.column, op: '<=', value: r.to });
  }
  return steps;
}

/**
 * The labels as the extract writes them — from the values AS ASKED (it fixes
 * the steps, not the labels), each period's from the warehouse's answer.
 */
function cardLabels(spec: AnswerSpec, columns: ParsedColumn[], answered: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  for (const f of spec.filters) {
    if (!columns.some((c) => c.name === f.column)) continue;
    const label = answered[i++];
    if ('period' in f) {
      if (label !== undefined) out.push(label);
    } else {
      out.push(...specFilterSteps({ filters: [f] }, columns, []).labels);
    }
  }
  return out;
}

/** `computeCard` for a Live dataset, or null when the dataset is not Live. */
export async function liveCardFor(projectId: string, spec: AnswerSpec): Promise<Built | Failure | null> {
  const meta = await datasets.getDatasetMeta(projectId, spec && spec.datasetId);
  if (!meta || !isLive(meta)) return null;
  // computeCard's own first check, with its own words.
  const has = (n: string): boolean => meta.columns.some((c) => c.name === n);
  const used = [spec.category, ...spec.measures.map((m) => m.column), ...spec.filters.map((f) => f.column)].concat(spec.series ? [spec.series] : []);
  const missing = used.find((n) => !has(n));
  if (missing) return { ok: false, reason: `"${missing}" is no longer a column of ${meta.name}.` };

  const fixed = await liveCaseFix(projectId, meta.id, meta.columns, spec.filters);
  if (!fixed.ok) return fail(fixed);
  const r = await liveAnswer(projectId, { ...spec, filters: fixed.filters });
  if (!r.ok) return fail(r);

  const catCol = meta.columns.find((c) => c.name === spec.category);
  const isDate = !!catCol && catCol.type === 'date';
  const data: ChartData = { labels: r.data.labels, series: r.data.series };
  const chartType = ANSWER_CHART_TYPES.has(spec.chartType) ? spec.chartType : defaultAnswerChart(catCol ? catCol.type : 'text', !!spec.series);
  const caption = tileCaption({ chartType, data, names: await displayNames(projectId, meta.id).catch(() => ({})) });
  const additive = spec.measures.every((m) => m.aggregation === 'sum' || m.aggregation === 'count');
  const filterLabels = cardLabels(spec, meta.columns, r.filterLabels);
  const facts = answerFacts({
    title: spec.title, datasetName: meta.name, describe: describeAnswer(spec), data, categoryIsDate: isDate, additive, filterLabels, caption, asOf: utcLabel(r.asOf.at),
  });
  return {
    card: {
      ok: true, spec, title: spec.title, chartType, datasetName: meta.name, data, caption,
      headline: facts.headline, bullets: facts.bullets,
      chips: answerChips(spec, { columns: meta.columns, splitCandidates: liveSplitCandidates(meta, spec.category) }),
      filterLabels, steps: cardSteps(fixed.filters, meta.columns, r.periodRanges), notes: r.notes, asOf: r.asOf,
    },
    factsText: facts.text,
    ledger: facts.ledger,
    provenance: {
      kind: 'dataset',
      name: meta.name,
      columns: used.filter((n, i) => used.indexOf(n) === i),
      note: 'chart computed live by the warehouse',
    },
  };
}
