// Explore's server calls. Two, and only reads: `explore:suggest` (the fields
// and the suggested questions, structure only) and `visual:data` — through
// loadVizData, so the thumbnails a page asks for in one tick go out as one
// `visual:dataBatch` — for every figure on the page. Both data channels run
// the server's `vizDataFor`. Nothing here computes, sums or sorts a figure.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc, RpcError } from '../../api/client';
import { loadVizData } from '../../api/visuals';
import { replyError } from '../live/refusal';
import type { Encoding, FilterStep, Preview } from '../visuals/api';
import type { Field } from './spec';

export interface Suggestion {
  chartType: string;
  encoding: Encoding;
}

/** `explore:suggest`'s reply, as the page holds it: one field list, in the server's order. */
export interface Fields {
  fields: Field[];
  suggestions: Suggestion[];
}

type SuggestReply =
  | {
      ok: true;
      dimensions: { name: string; type: 'text' | 'number' }[];
      dates: { name: string }[];
      measures: { name: string; aggregation: 'sum' | 'avg' }[];
      suggestions: Suggestion[];
    }
  | { ok: false; error?: string };

export function useExploreFields(projectId: string, datasetId: string) {
  return useQuery({
    queryKey: ['explore:suggest', projectId, datasetId],
    queryFn: async (): Promise<Fields> => {
      const r = (await rpc('explore:suggest', { projectId, datasetId })) as SuggestReply;
      if (!r.ok) throw new Error(r.error || 'The fields could not be read.');
      return {
        fields: [
          ...r.dimensions.map((d): Field => ({ name: d.name, kind: 'dimension', type: d.type })),
          ...r.dates.map((d): Field => ({ name: d.name, kind: 'date', type: 'date' })),
          ...r.measures.map((m): Field => ({ name: m.name, kind: 'measure', type: 'number', aggregation: m.aggregation })),
        ],
        suggestions: r.suggestions,
      };
    },
    staleTime: 60_000,
  });
}

/** One question as `visual:data` takes it. */
export interface Ask {
  projectId: string;
  datasetId: string;
  encoding: Encoding;
  filters: FilterStep[];
}

/**
 * The answer to `ask`, computed by the server. A refusal keeps its code (a Live
 * dataset's "off for Live" → <LiveRefusal>); the last answer stays up while the
 * next computes. Keyed by the question, so a suggestion's thumbnail IS the
 * answer when it is clicked.
 */
export function useAnswer(ask: Ask | undefined, keep = true) {
  return useQuery({
    queryKey: ['explore:answer', ask],
    queryFn:
      ask === undefined
        ? skipToken
        : async () => {
            const r = (await loadVizData(ask)) as ({ ok: true } & Preview) | { ok: false; error: string };
            if (!r.ok) throw replyError(r, 'Could not answer this question.');
            return r;
          },
    placeholderData: keep ? (prev) => prev : undefined,
    staleTime: 30_000,
    // A refusal is about the question, not the wire: only a network failure or a server error is worth asking again.
    retry: (n, err) => n < 2 && err instanceof RpcError && (err.status === 0 || err.status >= 500),
  });
}
