// Admin → Integrations: Linear and Jira Cloud (src/api/issues.ts). A reply carries settings that are not secret and a has-token flag:
// never the token. A token typed here goes to the server's encrypted store and is not shown again.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../../api/client';

export type Provider = 'linear' | 'jira';
export interface ProviderView { provider: Provider; connected: boolean; hasToken: boolean; settings: Record<string, string>; connectedBy: string; connectedAt: string }
export interface Status { ok: true; available: boolean; canSave: boolean; providers: ProviderView[] }
type Refusal = { ok: false; error: string };

const KEY = ['tracker:status'];
export const useTrackers = () => useQuery({ queryKey: KEY, queryFn: async () => (await rpc('tracker:status')) as Status | Refusal });

export function useConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RpcInput<'tracker:connect'>) => (await rpc('tracker:connect', input)) as { ok: true } | Refusal,
    onSuccess: async (r) => { if (r.ok) await qc.invalidateQueries({ queryKey: KEY }); },
  });
}
export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider: Provider) => (await rpc('tracker:disconnect', { provider })) as { ok: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
