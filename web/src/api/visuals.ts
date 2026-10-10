import { skipToken, useQuery } from '@tanstack/react-query';
import type { ChartDataShape } from '../charts/types';
import type { AsOf } from '../ui/asOfView';
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
  /** How fresh the figures are (L0.2) — the server's time; ui/AsOf words it. */
  asOf?: AsOf;
}

type Reply = ({ ok: true } & VizData) | { ok: false; error: string };

export type VizRequest = RpcInput<'visual:data'>;

// A page of charts is one round trip: the requests made in the same tick for
// one project go out as ONE `visual:dataBatch` (at most BATCH each), answered
// in order by the same server function. A lone request stays `visual:data`.
const BATCH = 50;
type Waiting = { req: VizRequest; resolve: (r: Reply) => void; reject: (e: unknown) => void };
const waiting = new Map<string, Waiting[]>();

function flush(projectId: string): void {
  const all = waiting.get(projectId) ?? [];
  waiting.delete(projectId);
  if (all.length === 1) {
    const [w] = all as [Waiting];
    rpc('visual:data', w.req).then((r) => w.resolve(r as Reply), w.reject);
    return;
  }
  for (let i = 0; i < all.length; i += BATCH) {
    const part = all.slice(i, i + BATCH);
    const items = part.map(({ req: { projectId: _p, ...item } }) => item);
    rpc('visual:dataBatch', { projectId, items }).then(
      (out) => part.forEach((w, j) => w.resolve(Array.isArray(out) && out[j] ? (out[j] as Reply) : { ok: false, error: 'No answer for this chart.' })),
      (err: unknown) => part.forEach((w) => w.reject(err)),
    );
  }
}

/** One chart's answer; batched with the others the page asks for in the same tick. */
export function loadVizData(req: VizRequest): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let list = waiting.get(req.projectId);
    if (!list) {
      waiting.set(req.projectId, (list = []));
      setTimeout(() => flush(req.projectId), 0);
    }
    list.push({ req, resolve, reject });
  });
}

/** One chart's answer, computed by the server. A refusal (`ok: false`) is a query error with its message. */
export function useVizData(req: VizRequest | undefined) {
  return useQuery({
    queryKey: ['visual:data', req],
    queryFn:
      req === undefined
        ? skipToken
        : async () => {
            const r = await loadVizData(req);
            if (!r.ok) throw new Error(r.error);
            return r;
          },
    // A refusal (`ok: false`) is about the question, not the wire: only a
    // network failure or a server error is worth asking again.
    retry: (count, err) => count < 2 && err instanceof RpcError && (err.status === 0 || err.status >= 500),
  });
}
