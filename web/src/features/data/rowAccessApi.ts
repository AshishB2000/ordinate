// Row access rules (docs/row-policy/00-design.md D3): the admin's two channels.
// The server enforces the rules everywhere; this file only reads and saves them.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';

export type RuleMember = { userId: string } | { teamId: string };
export type RowRule = RuleMember & { values: string[] };
/** Why saved rules do not hold right now (the server's `ruleState`). */
export type RuleState = 'ok' | 'column' | 'pipeline' | 'writers';

export type RowPolicyReply =
  | { ok: true; policy: { column: string; rules: RowRule[] } | null; state: RuleState; builtFrom: { id: string; name: string }[] }
  | { ok: false; code?: string; error: string };

const KEY = 'dataset:rowPolicy';

export function useRowPolicy(projectId: string, datasetId: string, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, projectId, datasetId],
    enabled,
    queryFn: async () => (await rpc(KEY, { projectId, datasetId })) as RowPolicyReply,
  });
}

export function useSaveRowPolicy(projectId: string, datasetId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (policy: { column: string; rules: RowRule[] } | null) =>
      (await rpc('dataset:setRowPolicy', { projectId, datasetId, policy })) as { ok: true } | { ok: false; error: string },
    onSuccess: (r) => {
      if (!r.ok) return;
      // Who sees what changed: every figure of this dataset is asked again.
      void client.invalidateQueries({ queryKey: [KEY, projectId, datasetId] });
      void client.invalidateQueries({ queryKey: ['dataset:list'] });
      void client.invalidateQueries({ queryKey: ['dataset:columns', projectId, datasetId] });
    },
  });
}
