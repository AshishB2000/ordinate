// Explore's server calls. Two, and only reads: `explore:suggest` (the fields
// and the suggested questions, structure only) and `visual:data` — through
// loadVizData, so the thumbnails a page asks for in one tick go out as one
// `visual:dataBatch` — for every figure on the page. Both data channels run
// the server's `vizDataFor`. Nothing here computes, sums or sorts a figure.
//
// An editor may also explore a SOURCE TABLE with no dataset (Assistant phase D): every call then sends `table` (its
// connection) beside `datasetId` (its doc), and the server reads the table's Live view. The tables are the Source
// tables list's documented, read ones; Keep as a dataset (`explore:keepTable`) makes its Live dataset. A viewer's are the
// tables their teams were given (team folders E8, `teamTables:mine`), by the name an editor wrote for viewers: no
// connection, no warehouse name, and no Keep (an editor's).

import { skipToken, useMutation, useQuery } from '@tanstack/react-query';
import { rpc, RpcError } from '../../api/client';
import { okOr, type Fail } from '../data/api';
import type { SourceList } from '../model/sources/api';
import { loadVizData } from '../../api/visuals';
import { replyError } from '../live/refusal';
import type { Encoding, FilterStep, Preview } from '../visuals/api';
import { figureAskKey, type FigureAsk } from '../../../../src/analysis/figureAsk.ts';
import type { Field } from './spec';

export interface Suggestion {
  chartType: string;
  encoding: Encoding;
}

/** `explore:suggest`'s reply, as the page holds it: one field list, in the server's order. */
export interface Fields {
  fields: Field[];
  suggestions: Suggestion[];
  /** The columns hidden from you (part 4): their names only. */
  hidden: string[];
}

type SuggestReply =
  | {
      ok: true;
      dimensions: { name: string; type: 'text' | 'number' }[];
      dates: { name: string }[];
      measures: { name: string; aggregation: 'sum' | 'avg'; metricId?: string }[];
      suggestions: Suggestion[];
      hidden?: string[];
    }
  | { ok: false; error?: string };

/** A source table Explore can open: `live` when its connection is asked live, else it must be copied first. */
export interface ExploreTable {
  connId: string;
  docId: string;
  /** What the picker names it: the warehouse name for an editor, the label for a viewer. */
  table: string;
  /** Its connection's name: an editor's only. */
  connection?: string;
  live: boolean;
}

/** A viewer's given tables, by label (`teamTables:mine`). `enabled: false` (an editor) asks nothing. */
export const useGivenTables = (projectId: string, enabled: boolean) =>
  useQuery({
    queryKey: ['teamTables:mine', projectId],
    queryFn: enabled
      ? async () => {
          const r = okOr((await rpc('teamTables:mine', { projectId })) as { ok: true; tables: { connId: string; docId: string; name: string; live: boolean }[] } | Fail, 'Tables');
          return r.tables.map((t): ExploreTable => ({ connId: t.connId, docId: t.docId, table: t.name, live: t.live }));
        }
      : skipToken,
  });

/** The documented tables whose columns were read, from the Source tables list (an editor's). */
export const exploreTables = (list: SourceList | undefined): ExploreTable[] =>
  (list?.connections ?? []).flatMap((c) =>
    c.rows.flatMap((r) => (r.docId && r.readAt ? [{ connId: c.connId, docId: r.docId, table: r.table, connection: c.name, live: !!c.live }] : [])),
  );

/** `table`: the connection of the source table `datasetId` names. `enabled: false` (a table to copy first) asks nothing. */
export function useExploreFields(projectId: string, datasetId: string, topicId?: string, table?: string, enabled = true) {
  return useQuery({
    queryKey: ['explore:suggest', projectId, datasetId, topicId ?? null, table ?? null],
    enabled,
    queryFn: async (): Promise<Fields> => {
      const r = (await rpc('explore:suggest', { projectId, datasetId, ...(topicId ? { topicId } : {}), ...(table ? { table } : {}) })) as SuggestReply;
      if (!r.ok) throw new Error(r.error || 'The fields could not be read.');
      return {
        fields: [
          ...r.dimensions.map((d): Field => ({ name: d.name, kind: 'dimension', type: d.type })),
          ...r.dates.map((d): Field => ({ name: d.name, kind: 'date', type: 'date' })),
          ...r.measures.map((m): Field => ({ name: m.name, kind: 'measure', type: 'number', aggregation: m.aggregation, ...(m.metricId ? { metricId: m.metricId } : {}) })),
        ],
        suggestions: r.suggestions,
        hidden: r.hidden ?? [],
      };
    },
    staleTime: 60_000,
  });
}

/** One question as `visual:data` takes it; a figure type also names itself (figureAsk), or its figures are not sent. */
export interface Ask extends Partial<FigureAsk> {
  projectId: string;
  datasetId: string;
  /** A source table's question: its connection (`datasetId` is then its doc). */
  table?: string;
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
            return { ...r, ask: figureAskKey(ask.chartType, ask) }; // which figures it answers: a held one is never drawn as another type's
          },
    placeholderData: keep ? (prev) => prev : undefined,
    staleTime: 30_000,
    // A refusal is about the question, not the wire: only a network failure or a server error is worth asking again.
    retry: (n, err) => n < 2 && err instanceof RpcError && (err.status === 0 || err.status >= 500),
  });
}

/** Keep as a dataset: the table's Live dataset, made by the server; its id. */
export function useKeepTable(projectId: string) {
  return useMutation({
    mutationFn: async (t: ExploreTable) => okOr((await rpc('explore:keepTable', { projectId, datasetId: t.docId, table: t.connId })) as { ok: true; datasetId: string } | Fail, 'Keep as a dataset'),
  });
}
