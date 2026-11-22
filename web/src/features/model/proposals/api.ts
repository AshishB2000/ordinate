// Metric proposals' calls (src/api/proposals.ts; src/server/proposals/). The queue returns STRUCTURE only: a card's live
// preview is the existing `metric:check` (a formula) or `metric:preview` (a column metric; a term as a count of the rows
// it matches), computed by the server for whoever is reviewing. This module never computes or rounds a figure.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { useServerEvent } from '../../../api/events';

export interface ProposalFilter { column: string; op: string; value?: string | number; values?: Array<string | number> }
export interface Proposal {
  id: string;
  kind: 'metric' | 'term';
  name: string;
  datasetId: string;
  datasetName: string;
  description: string;
  aliases: string[];
  formula?: string;
  column?: string;
  aggregation?: string;
  format?: string;
  filters?: ProposalFilter[];
  asks: number;
  questions: string[];
  state: 'open' | 'approved' | 'declined';
  decidedBy: string;
  answer: string;
  edited: boolean;
  savedId: string | null;
  createdAt: string;
  problem?: string;
}
export type Failed = { ok: false; error?: string; notReady?: boolean; code?: string };
export interface Edit { name?: string; description?: string; aliases?: string[]; formula?: string }

export const proposalsKey = (projectId: string, decided: boolean) => ['proposal:list', projectId, decided] as const;

export function useProposals(projectId: string, decided: boolean) {
  const qc = useQueryClient();
  // A card opened, raised or decided elsewhere: ids and a state only (never the definition).
  useServerEvent('proposals:changed', (p) => {
    if ((p as { projectId?: string } | null)?.projectId === projectId) void qc.invalidateQueries({ queryKey: ['proposal:list', projectId] });
  });
  return useQuery({
    queryKey: proposalsKey(projectId, decided),
    queryFn: async () => {
      const r = (await rpc('proposal:list', { projectId, decided })) as { ok: true; proposals: Proposal[] } | Failed;
      if (!r.ok) throw new Error(r.error || 'The proposals could not be loaded.');
      return r.proposals;
    },
  });
}

/** A definition's words, as the card states it (a column metric: "sum of revenue"). */
export function definitionOf(p: Proposal): string {
  if (p.kind === 'metric') return p.formula !== undefined ? p.formula : `${p.aggregation === 'countd' ? 'count distinct' : p.aggregation} of ${p.column}`;
  return (p.filters ?? []).map((f) => `${f.column} ${f.op} ${f.values ? f.values.join(', ') : String(f.value)}`).join(' and ');
}

export interface Preview { ok: boolean; display?: string; error?: string; rows?: boolean }

/** The reviewer's live figure for the draft (as edited): the server's own display string, or why there is none. */
export function usePreview(projectId: string, p: Proposal, formula: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['proposal:preview', projectId, p.id, formula ?? '', p.problem ?? ''],
    enabled: enabled && !p.problem,
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<Preview> => {
      const format = p.format ? { kind: p.format as 'number' | 'currency' | 'percent' | 'duration' } : undefined;
      if (p.kind === 'metric' && formula !== undefined) {
        const r = (await rpc('metric:check', { projectId, datasetId: p.datasetId, expression: formula, name: p.name, ...(format ? { format } : {}) })) as { valid?: boolean; ok?: boolean; error?: string; preview?: { display?: string } };
        return r.preview?.display !== undefined ? { ok: true, display: r.preview.display } : { ok: false, error: r.error || 'No figure could be computed.' };
      }
      if (p.kind === 'metric') {
        const r = (await rpc('metric:preview', { projectId, datasetId: p.datasetId, definition: { column: p.column ?? '', aggregation: (p.aggregation ?? 'sum') as 'sum' }, ...(format ? { format } : {}) })) as { ok: boolean; display?: string; error?: string };
        return r.ok ? { ok: true, display: r.display } : { ok: false, error: r.error || 'No figure could be computed.' };
      }
      // A term: how many rows it matches, counted by the engine under the reviewer's access.
      const filters = (p.filters ?? []).map((f) => ({ type: 'filter', column: f.column, op: f.op, ...(f.values ? { values: f.values } : { value: f.value }) }));
      const r = (await rpc('metric:preview', { projectId, datasetId: p.datasetId, definition: { column: filters[0]?.column ?? '', aggregation: 'count' }, filters })) as { ok: boolean; display?: string; error?: string };
      return r.ok ? { ok: true, display: r.display, rows: true } : { ok: false, error: r.error || 'No figure could be computed.' };
    },
  });
}

export function useDecide(projectId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['proposal:list', projectId] });
    void qc.invalidateQueries({ queryKey: ['metric:table', projectId] });
    void qc.invalidateQueries({ queryKey: ['metric:list', projectId] });
    void qc.invalidateQueries({ queryKey: ['term:list', projectId] });
  };
  const approve = useMutation({
    mutationFn: async (v: { id: string; edit?: Edit }) => (await rpc('proposal:approve', { projectId, ...v })) as { ok: true; savedId: string } | Failed,
    onSuccess: done,
  });
  const decline = useMutation({
    mutationFn: async (v: { id: string; note: string }) => (await rpc('proposal:decline', { projectId, ...v })) as { ok: true } | Failed,
    onSuccess: done,
  });
  return { approve, decline };
}

/** "Propose a definition" on the caller's own refused turn. */
export async function proposeDefinition(projectId: string, threadId: string, turnId: string): Promise<{ ok: true; raised: boolean; asks: number } | Failed> {
  return (await rpc('proposal:propose', { projectId, threadId, turnId })) as never;
}
