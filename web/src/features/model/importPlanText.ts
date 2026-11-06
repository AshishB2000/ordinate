// The import dry run in words, for ImportDialog (docs/semantic-layer/07-portability.md "What you will see"): one
// section per status, in the spec's order, each object as a line. Pure. Every count is the server's (a dbt file's matched
// datasets aside: they are said under Datasets); this only words it.

import { formatNumber } from '../data/format';
import type { DbtNote, ImportPlan, PlanItem, PlanKind, PlanStatus } from './api';

export interface PlanLine {
  key: string;
  text: string;
  detail?: string;
}

export interface PlanSection {
  status: PlanStatus;
  /** "3 updated", "1 conflict". */
  title: string;
  lines: PlanLine[];
  note?: string;
}

const ORDER: readonly PlanStatus[] = ['unchanged', 'updated', 'renamed', 'new', 'conflict', 'skipped', 'onlyHere'];
const LABEL: Record<PlanStatus, [string, string]> = {
  unchanged: ['unchanged', 'unchanged'],
  updated: ['updated', 'updated'],
  renamed: ['renamed', 'renamed'],
  new: ['new', 'new'],
  conflict: ['conflict', 'conflicts'],
  skipped: ['skipped', 'skipped'],
  onlyHere: ['only here', 'only here'],
};

const KIND: Record<PlanKind, [string, string]> = {
  dataset: ['Dataset', 'datasets'],
  table: ['Table notes', 'table notes'],
  field: ['Field', 'fields'],
  baseFilters: ['Always-applied filters', 'always-applied filters'],
  relationship: ['Relationship', 'relationships'],
  term: ['Term', 'terms'],
  metric: ['Metric', 'metrics'],
};

/** What each key the files carry is called on screen. */
const FIELD: Record<string, string> = {
  description: 'description', guide: 'guide', role: 'role', key: 'key', grain: 'grain',
  displayName: 'display name', aliases: 'other names', example: 'example', sensitivity: 'sensitivity', values: 'value labels',
  baseFilters: 'filters', filters: 'filters', definition: 'definition', format: 'format', direction: 'direction',
  timeColumn: 'date', target: 'target', name: 'name', label: 'label', cardinality: 'cardinality', from: 'columns', to: 'columns',
  importedFrom: 'link to dbt',
};

const kindOne = (k: PlanKind): string => KIND[k][0];
const fieldsOf = (i: PlanItem, except = ''): string =>
  [...new Set((i.changes ?? []).filter((c) => c.field !== except).map((c) => FIELD[c.field] ?? c.field))].join(', ');
const quoted = (v: unknown): string => `"${typeof v === 'string' ? v : ''}"`;

/** "1 metric", "2 terms and 1 metric". */
function dependents(list: PlanItem[]): string {
  const by = new Map<PlanKind, number>();
  for (const i of list) by.set(i.kind, (by.get(i.kind) ?? 0) + 1);
  return [...by].map(([k, n]) => `${formatNumber(n)} ${n === 1 ? KIND[k][1].replace(/s$/, '') : KIND[k][1]}`).join(' and ');
}

/** Why a dbt object was not imported, in words (f1): the shapes the translator does not read exactly. */
const DBT_WORDS: Partial<Record<NonNullable<PlanItem['reason']>, string>> = {
  cumulative: 'not a window over a plain metric: over a balance, or with both a window and a grain',
  conversion: "dbt pairs each conversion with the closest base event before it and counts conversions; Ordinate's funnel counts people from their first, so the figures differ",
  time_offset: 'dbt shifts each day and then adds the days up, so its periods don\'t line up with Ordinate\'s "same period last year". Make it here as a change on last year',
  cross_model: 'its inputs are on more than one semantic model',
  window_groupings: "a balance kept per entity (window_groupings): how dbt groups it by other fields isn't documented, so Ordinate can't match it yet",
  unknown_aggregation: "an aggregation Ordinate doesn't compute exactly (median, percentile, sum_boolean)",
  not_a_column: 'its expr is SQL, not one column of the dataset, or a column of another type',
  filter_shape: "its filter is not one Ordinate reads exactly: comparisons joined by AND, on a simple metric's own dimensions",
  fill_nulls: 'dbt shows a value where there are no rows (fill_nulls_with); Ordinate shows no figure',
  live_refused: "a balance can't be computed on a Live dataset yet",
  unreadable: "a metric type or definition Ordinate doesn't read",
  no_dataset: 'its semantic model has no dataset here',
  all_time: 'a running total since the first day: Ordinate\'s windows are "to date" or "last N days"',
  period_agg: 'dbt reads it at the start of each week or month (period_agg: first, its default); Ordinate at the end. Set period_agg: last in dbt to import it',
  window_unit: "a window in months, quarters, years or hours, or a custom grain: Ordinate's rolling windows count whole days, up to 366",
  calendar_differs: "a week to date, or a to-date on a calendar unlike dbt's: dbt's weeks are its warehouse's, and its quarters and years start in January",
  no_base_metric: 'no unfiltered simple metric on its measure to build on: add one in dbt and import again',
  count_window: 'a count over a window: with no rows in it, Ordinate counts 0 where dbt shows no figure',
};

const NOTE_WORDS: Record<DbtNote, string> = {
  in_progress: 'Window metrics match dbt for every day, and for every period that has ended with rows in its last window; where that window has none, Ordinate shows no figure and dbt repeats its last day with rows. For the period in progress Ordinate counts up to today, and a "last N days" window up to yesterday.',
  follows_calendar: "To-date metrics follow this workspace's calendar: they match dbt while the year starts in January.",
};

/** What a dbt file's windows match dbt on, in words (f2); none for a plan without notes. */
export const dbtNotes = (plan: ImportPlan): string[] => (plan.source.notes ?? []).map((n) => NOTE_WORDS[n]).filter(Boolean);

function skippedLine(i: PlanItem, under: PlanItem[]): PlanLine {
  const more = under.length ? `and ${dependents(under)} on it` : undefined;
  const dbt = i.reason ? DBT_WORDS[i.reason] : undefined;
  const what = i.kind === 'field' ? 'Dimension ' : i.kind === 'table' ? 'Primary entity ' : '';
  if (dbt) return { key: i.key, text: `${what}${i.name}`, detail: under.length ? `${dbt} · with ${dependents(under)} built on it` : dbt };
  switch (i.reason) {
    case 'dataset_missing':
      return { key: i.key, text: `Dataset ${quoted(i.name)} is not in this project`, detail: more };
    case 'column_missing':
      return { key: i.key, text: i.name, detail: `not a column here${more ? `, ${more}` : ''}` };
    case 'sensitivity_lowered':
      return { key: i.key, text: i.name, detail: 'would lower its sensitivity mark: an import only raises one' };
    case 'not_live':
      return { key: i.key, text: i.name, detail: 'always-applied filters are for Live datasets only' };
    case 'external':
      return { key: i.key, text: i.name, detail: 'defined in another tool: edit it there' };
    case 'invalid':
      return { key: i.key, text: i.name, detail: [i.error, more].filter(Boolean).join(' · ') || undefined };
    default:
      return { key: i.key, text: `${kindOne(i.kind)} ${quoted(i.name)}`, detail: 'names something that is neither in the files nor in this project' };
  }
}

/** The skipped items, each one a dependent skip traces back to listed once with what fell with it. */
function skippedLines(items: PlanItem[]): PlanLine[] {
  const skipped = items.filter((i) => i.status === 'skipped');
  const byKey = new Map(skipped.map((i) => [i.key, i]));
  const rootOf = (i: PlanItem): PlanItem => {
    const seen = new Set<string>();
    let cur = i;
    while (cur.reason === 'depends_on_skipped' && cur.because && byKey.has(cur.because) && !seen.has(cur.key)) {
      seen.add(cur.key);
      cur = byKey.get(cur.because) as PlanItem;
    }
    return cur;
  };
  const under = new Map<string, PlanItem[]>();
  for (const i of skipped) {
    const root = rootOf(i);
    if (root !== i) under.set(root.key, [...(under.get(root.key) ?? []), i]);
  }
  return skipped.filter((i) => rootOf(i) === i).map((i) => skippedLine(i, under.get(i.key) ?? []));
}

function lineOf(i: PlanItem): PlanLine {
  switch (i.status) {
    case 'updated':
      return { key: i.key, text: i.name, detail: fieldsOf(i, i.kind === 'field' ? 'name' : '') || undefined }; // a field doc's name is its column
    case 'renamed': {
      const name = i.changes?.find((c) => c.field === 'name');
      return { key: i.key, text: `${quoted(name?.here)} → ${quoted(name?.file ?? i.name)}`, detail: fieldsOf(i, 'name') || undefined };
    }
    case 'new':
      return { key: i.key, text: `${kindOne(i.kind)} ${quoted(i.name)}` };
    case 'conflict':
      return { key: i.key, text: i.name, detail: 'changed here and in the file' };
    default:
      return { key: i.key, text: i.name };
  }
}

/** A dbt file's semantic models, each with the dataset it landed on (none: not in this project) and whether a blind name matched it. */
export interface DbtModelLine { key: string; model: string; datasetId?: string; loose: boolean }
export function dbtModels(plan: ImportPlan): DbtModelLine[] {
  if (plan.source.kind !== 'dbt') return [];
  return plan.items
    .filter((i) => i.kind === 'dataset' && (i.status === 'unchanged' || i.reason === 'dataset_missing'))
    .map((i) => ({ key: i.key, model: i.name, ...(i.status === 'unchanged' && i.targetId && { datasetId: i.targetId }), loose: !!i.changes?.some((c) => c.field === 'matchedByName') }));
}

export function planSections(plan: ImportPlan): PlanSection[] {
  // A dbt file's matched datasets are said under Datasets (ImportDialog), not counted here as unchanged objects.
  const counts = { ...plan.counts, unchanged: plan.counts.unchanged - (plan.source.kind === 'dbt' ? plan.items.filter((i) => i.kind === 'dataset' && i.status === 'unchanged').length : 0) };
  return ORDER.filter((s) => counts[s] > 0).map((status) => {
    const n = counts[status];
    const title = `${formatNumber(n)} ${LABEL[status][n === 1 ? 0 : 1]}`;
    if (status === 'unchanged') {
      const newer = plan.items.filter((i) => i.status === 'unchanged' && i.newerHere).length;
      return { status, title, lines: [], ...(newer > 0 && { note: `${formatNumber(newer)} ${newer === 1 ? 'is newer in this project and stays as it is' : 'are newer in this project and stay as they are'}.` }) };
    }
    if (status === 'onlyHere') return { status, title, lines: [], note: 'Not in the files. An import never deletes.' };
    if (status === 'skipped') return { status, title, lines: skippedLines(plan.items) };
    return { status, title, lines: plan.items.filter((i) => i.status === status).map(lineOf) };
  });
}

/** How many objects an apply writes: every update, rename and new object, and each conflict the file's side was picked for. */
export function changesToApply(plan: ImportPlan, choices: Readonly<Record<string, 'file' | 'here'>>): number {
  const picked = plan.items.filter((i) => i.status === 'conflict' && choices[i.key] === 'file').length;
  return plan.counts.updated + plan.counts.renamed + plan.counts.new + picked;
}

/** "Apply 6 changes", or "Nothing to apply". */
export const applyLabel = (n: number): string => (n === 0 ? 'Nothing to apply' : `Apply ${formatNumber(n)} ${n === 1 ? 'change' : 'changes'}`);
