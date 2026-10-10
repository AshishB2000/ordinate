// "Explain this change" from a point on a chart: the one call behind it
// (`drivers:explainPoint`, src/ipc/driversPoint.ts). The browser names what was
// pointed at; the SERVER picks the two periods, lists the baselines the chart
// offers, computes every figure and writes the header sentence. Nothing here
// derives a period, a delta or a percentage.

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../../api/client';
import { driversKey, type DriversResult } from '../api';

/** What a tile sends: its own definition and filters, the reader's view state, and the point. */
export type PointRequest = Omit<RpcInput<'drivers:explainPoint'>, 'projectId'>;

/** One bucket of the chart: its axis label (the key the server takes back) and how it reads. */
export interface PointPeriod {
  label: string;
  text: string;
}
export interface PointBaseline extends PointPeriod {
  kind: 'previous' | 'year' | 'earlier';
}

export type PointReply =
  | { ok: true; bucket: string; baseline: string; periods: PointPeriod[]; baselines: PointBaseline[]; result: DriversResult }
  // A refusal is a sentence (`error`); `periods` rides along when another period can still be picked.
  | { ok: false; error: string; code?: string; reason?: string; bucket?: string; periods?: PointPeriod[] };

export function useExplainPoint(projectId: string, request: PointRequest) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['drivers:explainPoint', projectId, request],
    queryFn: async () => {
      const r = (await rpc('drivers:explainPoint', { projectId, ...request })) as PointReply;
      // <DriversView> asks `drivers:explain` with the question the server echoes; seeded with the
      // answer that came with it, the panel costs ONE call. A drill or another dimension asks afresh.
      if (r.ok) client.setQueryData(driversKey(projectId, r.result.spec), r.result);
      return r;
    },
    // The last answer stays up while the next period or baseline computes.
    placeholderData: keepPreviousData,
    // One answer for as long as the panel is open; asked afresh the next time it opens (the data may have been refreshed).
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}
