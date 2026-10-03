import { skipToken, useQuery } from '@tanstack/react-query';
import type { ChartDataShape } from '../charts/types';
import { rpc, RpcError, type RpcInput } from './client';

/**
 * What `visual:data` returns — the fields the web reads, mirrored from
 * src/ipc/visuals.ts `VizDataReply` (narrowed by hand, as in ./projects.ts).
 * `data` is the `{labels, series}` a chart draws, plus the family extras
 * (pivot, cohort, eventFunnel, geo, analytics, events) the server attached.
 */
export interface VizData {
  data: ChartDataShape & Record<string, unknown>;
  recommendedShape: string;
  warnings: string[];
}

type Reply = ({ ok: true } & VizData) | { ok: false; error: string };

export type VizRequest = RpcInput<'visual:data'>;

/** One chart's answer, computed by the server. A refusal (`ok: false`) is a query error with its message. */
export function useVizData(req: VizRequest | undefined) {
  return useQuery({
    queryKey: ['visual:data', req],
    queryFn:
      req === undefined
        ? skipToken
        : async () => {
            const r = (await rpc('visual:data', req)) as Reply;
            if (!r.ok) throw new Error(r.error);
            return r;
          },
    // A refusal (`ok: false`) is about the question, not the wire: only a
    // network failure or a server error is worth asking again.
    retry: (count, err) => count < 2 && err instanceof RpcError && (err.status === 0 || err.status >= 500),
  });
}
