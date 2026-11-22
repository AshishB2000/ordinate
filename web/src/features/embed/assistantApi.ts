// The embedded Assistant's setup (docs/embedded-assistant) — the server calls. Replies mirror src/ipc/embedAssistant.ts, narrowed by hand.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';

export type MarkState = 'ok' | 'gone' | 'folder' | 'column' | 'rules' | 'pipeline' | 'changed';

export interface MarkedDataset { id: string; name: string; column: string; state: MarkState }
export interface MarkedAgent { agentId: string; projectId: string; projectName: string; agentName: string; gone: boolean; enabled: boolean; datasets: MarkedDataset[] }
export interface Caps { daily: number; perMinute: number }

export interface AssistantSettings {
  canStore: boolean;
  org: string;
  embeddingOn: boolean;
  agents: MarkedAgent[];
  caps: Caps;
  limits: { maxDaily: number; maxPerMinute: number; maxDatasets: number; defaultDaily: number; defaultPerMinute: number };
  counts: { today: number; limited: number };
}

export type Options = { ok: true; agents: { id: string; name: string }[]; datasets: { id: string; name: string; textColumns: string[] }[] } | { ok: false; error: string };
export type Done = { ok: true } | { ok: false; error: string };

const KEY = 'embedAssistant:settings';

export const useAssistantSettings = () => useQuery({ queryKey: [KEY], queryFn: async () => (await rpc(KEY)) as AssistantSettings });

export const useAssistantOptions = (projectId: string | null) =>
  useQuery({ queryKey: ['embedAssistant:options', projectId], enabled: !!projectId, queryFn: async () => (await rpc('embedAssistant:options', { projectId: projectId as string })) as Options });

function useDone<I>(channel: 'embedAssistant:save' | 'embedAssistant:setEnabled' | 'embedAssistant:remove' | 'embedAssistant:setLimits') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: I) => (await rpc(channel, input as RpcInput<typeof channel>)) as Done,
    onSuccess: async (r) => { if (r.ok) await client.invalidateQueries({ queryKey: [KEY] }); },
  });
}

export const useAssistantSave = () => useDone<RpcInput<'embedAssistant:save'>>('embedAssistant:save');
export const useAssistantEnabled = () => useDone<RpcInput<'embedAssistant:setEnabled'>>('embedAssistant:setEnabled');
export const useAssistantRemove = () => useDone<RpcInput<'embedAssistant:remove'>>('embedAssistant:remove');
export const useAssistantLimits = () => useDone<RpcInput<'embedAssistant:setLimits'>>('embedAssistant:setLimits');
