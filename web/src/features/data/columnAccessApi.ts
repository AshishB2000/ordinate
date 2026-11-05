// Column access rules (semantic layer part 4, step 07): the admin's two channels. The server enforces them
// everywhere and adds the carriers; this file only reads and saves the admin's own rules.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import type { RuleMember } from './rowAccessApi';

/** `from`: a carrier, computed from that hidden column. The server adds it; it is never sent. */
export interface ColumnRule { column: string; visibleTo: RuleMember[]; from?: string }
/** `pipeline`: a step that reads a hidden column changed; `gone`: a hidden column is not in the dataset now; `closed`: the stored rules do not read. */
export type ColumnState = 'none' | 'ok' | 'pipeline' | 'gone' | 'closed';

export type ColumnAccessReply =
  | { ok: true; rules: ColumnRule[]; state: ColumnState; suggest: string[]; builtFrom: { id: string; name: string }[] }
  | { ok: false; code?: string; error: string };

const KEY = 'dataset:columnAccess';

export function useColumnAccess(projectId: string, datasetId: string) {
  return useQuery({
    queryKey: [KEY, projectId, datasetId],
    queryFn: async () => (await rpc(KEY, { projectId, datasetId })) as ColumnAccessReply,
  });
}

/** Saves the admin's own rules (null or [] removes them all). */
export function useSaveColumnAccess(projectId: string, datasetId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (columns: Array<{ column: string; visibleTo: RuleMember[] }> | null) =>
      (await rpc('dataset:setColumnAccess', { projectId, datasetId, columns })) as { ok: true; rules: ColumnRule[] } | { ok: false; error: string },
    onSuccess: (r) => {
      if (!r.ok) return;
      // Only the rules change for the admin who saves them (an admin sees every column), so only they are asked again.
      void client.invalidateQueries({ queryKey: [KEY, projectId, datasetId] });
    },
  });
}
