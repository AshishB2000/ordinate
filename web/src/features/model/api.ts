// The Data model's one read for its Datasets tab (`model:overview`, src/ipc/modelOverview.ts): every
// dataset's role, key state, description, always-applied filters and calculated fields, and the
// server's ranked "To fill in next" list. Contracts carry inputs only, so the reply is narrowed here
// by hand. Every count in it is the server's; this only words it.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
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
