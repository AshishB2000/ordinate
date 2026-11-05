// The calls behind a dataset's suggested meanings (src/ipc/sourceSuggestions.ts). Both channels are `write`: the web asks
// for an editor only. A pod without them answers 404; the query then errors quietly and nothing is drawn.

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { okOr, type Fail } from '../../data/api';
import { toast } from '../../../ui/Toast';

export const SUGGESTIONS = 'catalog:suggestions';

/** src/analysis/sourceSuggestions.ts Suggestion. */
export interface Suggestion {
  datasetId: string;
  kind: 'column' | 'table' | 'key';
  column?: string;
  text: string;
  hash: string;
  connId: string;
  docId: string;
  table: string;
}
export interface Suggestions { ok: true; suggestions: Suggestion[]; total: number; datasets: number }

/** `datasetId` omitted: the whole project. `on` is the caller's `useCanEdit`, so a viewer never asks. */
export const useSuggestions = (projectId: string, datasetId: string | undefined, on: boolean) =>
  useQuery({
    queryKey: [SUGGESTIONS, projectId, datasetId ?? '*'],
    queryFn: on ? async () => okOr((await rpc(SUGGESTIONS, { projectId, ...(datasetId ? { datasetId } : {}) })) as Suggestions | Fail, 'The suggestions') : skipToken,
    retry: false,
    throwOnError: false,
  });

const REFRESH = [SUGGESTIONS, 'catalog:columns', 'catalog:get', 'catalog:getTable', 'model:overview'];

/** Use writes through the editor's own channels (nothing new writes a dataset's docs); Dismiss stores a hash in the source doc. */
export function useSuggestionActions(projectId: string) {
  const client = useQueryClient();
  const useRun = (go: (s: Suggestion) => Promise<unknown>) =>
    useMutation({
      mutationFn: async (s: Suggestion) => {
        const r = (await go(s)) as { ok?: boolean; error?: string };
        if (r?.ok === false) throw new Error(r.error || 'The change was refused.');
      },
      onSettled: () => Promise.all(REFRESH.map((k) => client.invalidateQueries({ queryKey: [k] }))),
      onError: (err) => toast(`The change did not go through: ${err.message}`, { kind: 'error' }),
    });
  const use = useRun((s) => {
    if (s.kind === 'column') return rpc('catalog:setColumn', { projectId, datasetId: s.datasetId, column: s.column as string, patch: { description: s.text } });
    if (s.kind === 'table') return rpc('catalog:set', { projectId, ref: `dataset:${s.datasetId}`, patch: { description: s.text } });
    return rpc('catalog:setTable', { projectId, datasetId: s.datasetId, patch: { key: s.text } });
  });
  const dismiss = useRun((s) => rpc('catalog:dismissSuggestion', { projectId, datasetId: s.datasetId, connId: s.connId, docId: s.docId, kind: s.kind, ...(s.column !== undefined ? { column: s.column } : {}), hash: s.hash }));
  return { use, dismiss };
}
