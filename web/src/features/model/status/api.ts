// The four admin channels of part 4 (`model:review|certify|retire|clearStatus`) and what each refreshes.
// Contracts: src/api/governance.ts. A status is the server's word; nothing here decides one.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import type { StatusKind, StatusView } from './status';

export const refOf = (kind: StatusKind, id: string) => `${kind}:${id}`;

/** `model:review`: the pin of what the admin is looking at (certify takes it back as `base`). */
export interface Review {
  pin: string;
  status?: StatusView;
  /** The newest version of the item, to diff `status.versionKey` against. */
  newestKey?: string;
}

export const useReview = (projectId: string, ref: string) =>
  useQuery({
    queryKey: ['model:review', projectId, ref],
    gcTime: 0,
    queryFn: async () => {
      const r = (await rpc('model:review', { projectId, ref })) as ({ ok: true } & Review) | { ok: false; error: string };
      if (!r.ok) throw new Error(r.error);
      return r;
    },
  });

/** A refusal with the sentence for the box it belongs beside. */
export type Refusal = { ok: false; error: string; field: 'ref' | 'replacedBy' };

const LISTS = ['metric:list', 'metric:table', 'term:list', 'dataset:list', 'catalog:list', 'model:overview'];

export function useStatusActions(projectId: string) {
  const client = useQueryClient();
  const settle = () => Promise.all(LISTS.map((k) => client.invalidateQueries({ queryKey: [k, projectId] })));
  const useCall = <I,>(channel: 'model:certify' | 'model:retire' | 'model:clearStatus') =>
    useMutation({
      mutationFn: async (input: I) => (await rpc(channel, { projectId, ...input } as never)) as { ok: true } | Refusal,
      onSuccess: settle,
    });
  return {
    certify: useCall<{ ref: string; base: string; note?: string }>('model:certify'),
    retire: useCall<{ ref: string; replacedBy?: string; note?: string }>('model:retire'),
    clear: useCall<{ ref: string }>('model:clearStatus'),
  };
}
