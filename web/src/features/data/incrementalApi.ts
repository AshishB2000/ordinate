// A dataset's incremental refresh settings (`incremental:get` / `incremental:set`,
// src/data/incrementalSettings.ts). The server decides everything the panel
// offers — which columns can be the cursor, whether the source can take it,
// why it cannot be turned on — and re-checks a save; this only words it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';

type Cell = string | number | null;

export interface IncrementalLogEntry {
  at: string;
  mode: 'full' | 'incremental';
  fetched: number;
  inserted: number | null;
  updated: number | null;
  highWater: Cell;
  how: string;
  note?: string;
}

export interface IncrementalView {
  ok: true;
  /** Why it cannot be turned on here (a catalog sentence), or null. */
  blocked: string | null;
  settings: {
    enabled: boolean;
    cursorColumn: string;
    keyColumn: string | null;
    lookback: number;
    highWater: Cell;
    runsSinceFull: number;
    lastFullAt: string | null;
    lastRunAt: string | null;
  } | null;
  log: IncrementalLogEntry[];
  cursorColumns: { name: string; type: 'number' | 'date' }[];
  keyColumns: string[];
  /** How a run reads the source; null when none does (Live, not from a connection, the connection gone). */
  fetch: 'server' | 'after' | null;
  source: string;
  fullEvery: number;
  /** When on: why the next run is full, or null. */
  nextFull: string | null;
}

type Reply = IncrementalView | { ok: false; error: string };

export interface IncrementalPatch {
  enabled: boolean;
  cursorColumn: string;
  mode: 'upsert' | 'append';
  keyColumn?: string;
  lookback: number;
}

const KEY = 'incremental:get';

/** The view; a refusal is the query's error, so the panel's error state shows the server's sentence. */
export function useIncremental(projectId: string, datasetId: string, enabled = true) {
  return useQuery({
    queryKey: [KEY, projectId, datasetId],
    queryFn: async () => {
      const r = (await rpc(KEY, { projectId, datasetId })) as Reply;
      if (!r.ok) throw new Error(r.error);
      return r;
    },
    enabled,
  });
}

/** Save; the reply is the new view. The dataset list learns `incrementalOn` (the cadence and fresh-on-ask pickers read it). */
export function useSaveIncremental(projectId: string, datasetId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (p: IncrementalPatch) => (await rpc('incremental:set', { projectId, datasetId, ...p })) as Reply,
    onSuccess: (r) => {
      if (!r.ok) return;
      client.setQueryData([KEY, projectId, datasetId], r);
      void client.invalidateQueries({ queryKey: ['dataset:list'] });
    },
  });
}

/** How a run got its rows, as the run log says it (src/data/incremental.ts FetchHow). */
export const HOW: Readonly<Record<string, string>> = {
  server: 'filtered at the source',
  after: 'filtered after fetch',
  files: 'changed files only',
  unchanged: 'nothing changed',
  full: 'full refresh',
};

/** A date cursor's lookback units; a number cursor's lookback is a count of ids. */
export const UNITS = [
  { value: '60', label: 'minutes', secs: 60 },
  { value: '3600', label: 'hours', secs: 3600 },
  { value: '86400', label: 'days', secs: 86_400 },
] as const;

/** A stored lookback in seconds, as the largest unit it is a whole number of (0 → 0 hours). */
export function splitLookback(secs: number): { amount: string; unit: string } {
  if (secs > 0) {
    for (const u of [...UNITS].reverse()) if (secs % u.secs === 0) return { amount: String(secs / u.secs), unit: u.value };
    return { amount: String(secs / 60), unit: '60' };
  }
  return { amount: '0', unit: '3600' };
}

/** A stored lookback as the form shows it: a date cursor's seconds in the largest whole unit, a number cursor's count of ids as it is. */
export function lookbackFields(lookback: number, type: 'number' | 'date' | undefined): { amount: string; unit: string } {
  return type === 'date' ? splitLookback(lookback) : { amount: String(lookback), unit: '3600' };
}
