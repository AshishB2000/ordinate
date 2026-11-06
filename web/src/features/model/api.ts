// The Data model's one read for its Datasets tab (`model:overview`, src/ipc/modelOverview.ts): every
// dataset's role, key state, description, always-applied filters and calculated fields, and the
// server's ranked "To fill in next" list. Contracts carry inputs only, so the reply is narrowed here
// by hand. Every count in it is the server's; this only words it.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc, upload } from '../../api/client';
import { okOr, type Fail, type Lineage } from '../data/api';
import { formatNumber } from '../data/format';
import type { TableRole } from '../data/tableApi';
import type { FilterStep } from '../visuals/api';

/** A gap, by rank (src/ipc/modelOverview.ts TodoKind). */
export type TodoKind = 'key_repeats' | 'verified_broken' | 'no_key' | 'no_guide' | 'no_description' | 'no_role';
export interface TodoItem {
  /** '' for verified_broken: the project's, not one dataset's. */
  datasetId: string;
  kind: TodoKind;
  /** key_repeats only: how many key values repeat, counted by the server. */
  repeats?: number;
  /** verified_broken only: how many verified questions no longer run, counted by the server. */
  count?: number;
}

export interface ModelTable {
  datasetId: string;
  role: TableRole;
  key: string;
  /** '' = no key; unchecked = never counted, or the count is hidden from this caller. */
  keyState: '' | 'unchecked' | 'unique' | 'repeats';
  description: string;
  alwaysApplied: { kind: 'prepare' | 'live'; steps: FilterStep[] };
  calculated: { name: string; formula: string }[];
  /** Row access rules: each step is its column and operator only, each formula ''. */
  valuesHidden?: true;
}

/** What an admin should look at (src/analysis/statusReview.ts): changed since certified, or retired and still used. */
export interface ReviewItem {
  ref: string;
  name: string;
  kind: 'needs_review' | 'retired_used';
  uses?: number;
}

export interface ModelOverview {
  ok: true;
  review?: ReviewItem[];
  tables: ModelTable[];
  todo: TodoItem[];
  more: number;
}

export const OVERVIEW = 'model:overview';

export const useModelOverview = (projectId: string) =>
  useQuery({
    queryKey: [OVERVIEW, projectId],
    queryFn: async () => okOr((await rpc(OVERVIEW, { projectId })) as ModelOverview | Fail, 'The data model'),
  });

/** One strip item in words: "Orders: 12 keys repeat", "Set a key on Orders". */
export function todoText(item: TodoItem, name: string): string {
  switch (item.kind) {
    case 'key_repeats': {
      const n = item.repeats ?? 0;
      return `${name}: ${formatNumber(n)} ${n === 1 ? 'key repeats' : 'keys repeat'}`;
    }
    case 'verified_broken': {
      const n = item.count ?? 0;
      return n === 1 ? '1 verified question no longer runs' : `${formatNumber(n)} verified questions no longer run`;
    }
    case 'no_key':
      return `Set a key on ${name}`;
    case 'no_guide':
      return `Write a guide for ${name}`;
    case 'no_description':
      return `Describe ${name}`;
    case 'no_role':
      return `Set a role for ${name}`;
  }
}

/** The panel tab a strip item opens: the guide for a missing guide, the overview for the rest. */
export const todoPanel = (kind: TodoKind): 'overview' | 'guide' => (kind === 'no_guide' ? 'guide' : 'overview');

/** One review chip in words: "Revenue changed since certified", "Gross revenue is retired, used by 6". */
export function reviewText(item: ReviewItem): string {
  if (item.kind === 'needs_review') return `${item.name} changed since certified`;
  return item.uses === undefined ? `${item.name} is retired, still used` : `${item.name} is retired, used by ${formatNumber(item.uses)}`;
}
/** What `lineage:column` and `lineage:fields` count: node kind → how many. Every number is the server's. */
export type UsedCounts = Partial<Record<string, number>>;

// ponytail: the order a person reads it in, and the word for each kind (a visual is a "chart" where a delete asks)
const USED_ORDER = ['metric', 'visual', 'dashboard', 'report', 'alert', 'calc', 'term', 'dataset'] as const;
const USED_WORD: Record<string, string> = { calc: 'calculated field', term: 'term' };

/** "2 metrics", "1 term": the server's counts per kind, in reading order. `word` renames a kind (visual → chart). */
export function countParts(usedIn: UsedCounts, word: Partial<Record<string, string>> = {}): string[] {
  return USED_ORDER.filter((k) => usedIn[k]).map((k) => {
    const n = usedIn[k] ?? 0;
    const w = word[k] ?? USED_WORD[k] ?? k;
    return `${formatNumber(n)} ${n === 1 ? w : `${w}s`}`;
  });
}

/** "Used by 2 metrics · 6 visuals · 1 term"; '' when nothing uses it. */
export function usedByText(usedIn: UsedCounts): string {
  const parts = countParts(usedIn);
  return parts.length ? `Used by ${parts.join(' · ')}` : '';
}

export interface LineageFields {
  ok: true;
  fields: Record<string, { usedIn: UsedCounts }>;
  steps: { index: number; produces: string[]; usedIn: UsedCounts }[];
}

/** The graph around one column, or null when nothing reads it. Not asked for until a column is picked. */
export const useColumnLineage = (projectId: string, datasetId: string, column: string | null) =>
  useQuery({
    queryKey: ['lineage:column', projectId, datasetId, column],
    queryFn: column === null ? skipToken : async () => (await rpc('lineage:column', { projectId, datasetId, column })) as Lineage | null,
  });

/** "Used by" for every field of a dataset and for each Prepare step that makes one: one read per dataset. */
export const useLineageFields = (projectId: string, datasetId: string) =>
  useQuery({
    queryKey: ['lineage:fields', projectId, datasetId],
    queryFn: async () => okOr((await rpc('lineage:fields', { projectId, datasetId })) as LineageFields | Fail, 'The usage'),
  });

/** `model:export` (src/ipc/modelFiles.ts): a download token, the counts, and the kinds the files leave out. */
export type ModelExportReply =
  | { ok: true; downloadToken: string; counts: Record<'datasets' | 'metrics' | 'terms' | 'relationships', number>; notCarried: string[] }
  | { ok: false; error: string };

export const exportModel = async (projectId: string) => (await rpc('model:export', { projectId })) as ModelExportReply;

/** `model:exportOssie` (src/ipc/modelFiles.ts): a download token, the spec version it is pinned to, and what did not map. */
export interface OssieReport { notMapped: { kind: string; name: string; reason: string }[]; noSource: string[] }
export type OssieExportReply = { ok: true; downloadToken: string; version: string; report: OssieReport } | { ok: false; error: string };

export const exportOssie = async (projectId: string) => (await rpc('model:exportOssie', { projectId })) as OssieExportReply;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const OSSIE_KINDS: Record<string, (n: number) => string> = {
  term: (n) => plural(n, 'term', 'terms'),
  valueLabels: (n) => `Value labels on ${plural(n, 'field', 'fields')}`,
  metric: (n) => plural(n, 'metric', 'metrics'),
  metricDate: (n) => `Counting dates on ${plural(n, 'metric', 'metrics')}`,
  metricSettings: (n) => `Formats or targets on ${plural(n, 'metric', 'metrics')}`,
  baseFilters: (n) => `Always-applied filters on ${plural(n, 'dataset', 'datasets')}`,
  role: (n) => `Roles on ${plural(n, 'dataset', 'datasets')}`,
  sensitivity: (n) => `Sensitivity on ${plural(n, 'field', 'fields')}`,
  relationship: (n) => plural(n, 'relationship', 'relationships'),
  cardinality: (n) => `One-to-one on ${plural(n, 'relationship', 'relationships')}`,
  calendar: () => 'Calendar settings',
};

/** What did not map, one group per kind: a heading ("2 terms"), the server's reason, and the names. */
export function ossieGroups(report: OssieReport): { kind: string; title: string; reason: string; names: string[] }[] {
  const by = new Map<string, OssieReport['notMapped']>();
  for (const n of report.notMapped) by.set(n.kind, [...(by.get(n.kind) ?? []), n]);
  return [...by].map(([kind, items]) => ({ kind, title: (OSSIE_KINDS[kind] ?? ((n: number) => `${n} × ${kind}`))(items.length), reason: items[0].reason, names: items.map((i) => i.name) }));
}

/** src/app/modelExport.ts NOT_CARRIED, in words. */
const NOT_CARRIED_WORDS: Record<string, string> = {
  metricTrees: 'metric trees',
  hierarchies: 'drill hierarchies',
  status: 'certified and retired marks',
  instructions: 'Assistant instructions',
  verifiedQuestions: 'verified questions',
  sourceDocs: 'source table notes',
  liveCalcs: 'Live calculated fields',
  topics: 'topics',
  externalMetrics: 'metrics another tool defines',
};

/** "Exported the model files." plus, when something was left out, "Not in them: a, b and c." */
export function exportedText(notCarried: readonly string[]): string {
  const words = notCarried.map((k) => NOT_CARRIED_WORDS[k] ?? k);
  if (!words.length) return 'Exported the model files.';
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `Exported the model files. Not in them: ${list}.`;
}

// ── Import (semantic layer part 7, a3): `model:importPlan` and `model:importApply` (src/ipc/modelFiles.ts) ──
// The file is uploaded once for the dry run and again for the apply: an upload token is used once (any pod).

/** src/app/modelPlan.ts PlanStatus, PlanKind and SkipReason. */
export type PlanStatus = 'unchanged' | 'updated' | 'renamed' | 'new' | 'conflict' | 'skipped' | 'onlyHere';
export type PlanKind = 'dataset' | 'table' | 'field' | 'baseFilters' | 'relationship' | 'term' | 'metric';
export type SkipReason = 'dataset_missing' | 'column_missing' | 'depends_on_skipped' | 'sensitivity_lowered' | 'not_live' | 'invalid' | 'external' | DbtSkip;
/** src/app/dbtImport.ts DbtSkip: why a dbt object is not imported (f1). */
export type DbtSkip =
  | 'cumulative' | 'conversion' | 'time_offset' | 'cross_model' | 'window_groupings' | 'unknown_aggregation'
  | 'not_a_column' | 'filter_shape' | 'fill_nulls' | 'live_refused' | 'unreadable' | 'no_dataset';

export interface PlanItem {
  key: string;
  kind: PlanKind;
  name: string;
  status: PlanStatus;
  /** The project object it lands on; for a dbt semantic model, its dataset. */
  targetId?: string;
  changes?: { field: string; here?: unknown; file?: unknown }[];
  newerHere?: true;
  reason?: SkipReason;
  /** The key of the skipped or missing object this one names. */
  because?: string;
  /** The editor's own sentence, for `invalid`. */
  error?: string;
}

export interface ImportPlan {
  hash: string;
  items: PlanItem[];
  counts: Record<PlanStatus, number>;
  /** `kind: 'dbt'`: a dbt semantic manifest, translated (a copy). */
  source: { appVersion: string; project: string; kind?: 'dbt' };
  notCarried: string[];
}

/** A dbt semantic model's name → the dataset the person picked for it (f1). Sent only when it holds one. */
export type DatasetMap = Record<string, string>;
const withMap = (map: DatasetMap | undefined) => (map && Object.keys(map).length ? { datasetMap: map } : {});

export type ImportPlanReply = { ok: true; plan: ImportPlan } | { ok: false; error: string };
export type ImportApplyReply =
  | { ok: true; written: string[]; failed: { key: string; error: string }[]; before?: { downloadToken: string } }
  | { ok: false; code?: 'plan_changed'; error: string };

export async function planModelImport(projectId: string, file: File, datasetMap?: DatasetMap): Promise<ImportPlanReply> {
  const { fileToken } = await upload(file, file.name);
  return (await rpc('model:importPlan', { projectId, fileToken, ...withMap(datasetMap) })) as ImportPlanReply;
}

/**
 * The reads an import's writes change, by the kinds it wrote: what each kind's own editor refreshes after a save
 * (catalog:set and catalog:setTable for a table, catalog:setColumn for a field and its value labels, the Live base
 * filters' write, relationship:save, term:save, metric:save), plus the Data model's own summary. Nothing written,
 * nothing refetched; never the whole cache (an import of one description is not a reload of every screen).
 */
const IMPORT_REFRESH: Record<PlanKind, readonly string[]> = {
  dataset: [], // a dataset the files name: skipped when this project lacks it, confirmed for a dbt manifest; never written
  table: ['catalog:getTable', 'catalog:get', 'catalog:list', 'relationship:list'],
  field: ['catalog:columns', 'dataset:columns', 'dataset:distinct', 'visual:data', 'analysis:tile', 'explore:answer', 'answer:card', 'story:figures', 'report:preview', 'subscription:preview'],
  baseFilters: ['dataset:liveSchema', 'dataset:columns', 'dataset:list', 'dataset:source', 'dataset:distinct', 'lineage:get'],
  relationship: ['relationship:list', 'relationship:related', 'lineage:get'],
  term: ['term:list', 'term:usage', 'lineage:get'],
  metric: ['metric:list', 'metric:table', 'lineage:get'],
};

export function importRefresh(plan: ImportPlan, written: readonly string[]): string[] {
  const kinds = new Set(plan.items.filter((i) => written.includes(i.key)).map((i) => i.kind));
  if (!kinds.size) return [];
  return [...new Set([...[...kinds].flatMap((k) => IMPORT_REFRESH[k]), 'model:overview', 'model:navigation', 'model:review'])];
}

export async function applyModelImport(projectId: string, file: File, planHash: string, choices: Record<string, 'file' | 'here'>, datasetMap?: DatasetMap): Promise<ImportApplyReply> {
  const { fileToken } = await upload(file, file.name);
  return (await rpc('model:importApply', { projectId, fileToken, planHash, choices, ...withMap(datasetMap) })) as ImportApplyReply;
}

/** "This project also has a and b: an import leaves them as they are.", or '' when it has none of them. */
export function notCarriedText(notCarried: readonly string[]): string {
  const words = notCarried.map((k) => NOT_CARRIED_WORDS[k] ?? k);
  if (!words.length) return '';
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `Model files never carry ${list}: an import leaves this project's as they are.`;
}
