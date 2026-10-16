// The metric tree's server calls (src/ipc/metricTree.ts) and their shapes.
// Every figure, display string, share, the lead branch and the headline are
// the server's: this screen places them, it never computes one.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../../../api/client';
import { replyError } from '../../../live/refusal';

export type Relation = 'sum' | 'product' | 'ratio';
export type PeriodKey = 'latest_month' | 'latest_quarter' | 'last_month' | 'last_quarter' | 'last_30_days' | 'ytd' | 'custom';
export type CompareMode = 'previous_period' | 'previous_year' | 'custom';

/** The tree as stored on the metric (analysis/metricTree.ts TreeNode). */
export interface TreeSpec {
  id: string;
  metricId: string;
  negative?: true;
  relation?: Relation;
  children?: TreeSpec[];
  split?: string;
}

export interface TreeNode {
  key: string;
  kind: 'metric' | 'segment' | 'residual';
  name: string;
  metricId?: string;
  current: number | null;
  previous: number | null;
  change: number | null;
  pct: number | null;
  display: string;
  previousDisplay: string;
  changeDisplay: string;
  pctDisplay: string;
  contribution?: number | null;
  contributionDisplay?: string;
  share?: number | null;
  shareDisplay?: string;
  mixDisplay?: string;
  rateDisplay?: string;
  direction?: 'up_good' | 'down_good';
  spark: (number | null)[] | null;
  breakdown?: { kind: Relation | 'split'; text: string };
  children: TreeNode[];
  note?: string;
  lead?: boolean;
}

export interface TreeReply {
  ok: true;
  root: TreeNode;
  tree: TreeSpec | null;
  headline: string;
  period: { key: PeriodKey | 'scope'; label: string; from?: string; to?: string };
  prior: { label: string; from?: string; to?: string };
  compareLabel: string;
}

export type ComputeInput = RpcInput<'metricTree:compute'>;

export async function computeTree(input: ComputeInput): Promise<TreeReply> {
  const r = (await rpc('metricTree:compute', input)) as TreeReply | { ok: false; error: string; code?: string };
  if (!r.ok) throw replyError(r, 'The tree could not be computed.');
  return r;
}

export function useTree(input: ComputeInput | null) {
  return useQuery({
    queryKey: ['metricTree:compute', input],
    queryFn: input ? () => computeTree(input) : skipToken,
    placeholderData: (prev) => prev,
    retry: false,
  });
}

export interface Suggestion {
  relation: Relation;
  children: { metricId: string; negative?: true }[];
  from: string;
}

export interface SuggestReply {
  /** By metric id: the breakdowns read from the project's formulas. */
  suggestions: Record<string, Suggestion[]>;
  metrics: { id: string; name: string }[];
  columns: string[];
}

export function useSuggest(projectId: string, id: string) {
  return useQuery({
    queryKey: ['metricTree:suggest', projectId, id],
    queryFn: async () => {
      const r = (await rpc('metricTree:suggest', { projectId, id })) as (SuggestReply & { ok: true }) | { ok: false; error: string };
      if (!r.ok) throw new Error(r.error || 'The metrics could not be read.');
      return r;
    },
  });
}

export async function saveTree(projectId: string, id: string, tree: TreeSpec | null): Promise<string | null> {
  const r = (await rpc('metricTree:save', { projectId, id, tree })) as { ok: boolean; error?: string };
  return r.ok ? null : r.error || 'The tree could not be saved.';
}

/** Words for a relation's operator, as the editor and the cards write it. */
export const RELATION_WORD: Record<Relation, string> = { sum: 'Sum', product: 'Product', ratio: 'Ratio' };
