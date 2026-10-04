// The project's category colours (fmtColors.ts), on the web: the map comes from
// the server (`format:colors:get`) and rides on a chart's overrides as
// `_colorScope`, so buildChart deals tokens by the shared pure rule
// (src/analysis/colorMap.ts). When a draw dealt a value the map does not hold
// yet, the builder asks the server to deal the same values against the STORED
// map (`format:colors:assign`) and adopts its answer — a stale copy heals.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { assignColors, type ColorMap, type ColorToken } from '../../../../../src/analysis/colorMap.ts';
import { rpc } from '../../../api/client';

const key = (projectId: string) => ['format:colors:get', projectId] as const;

export function useColorMap(projectId: string) {
  return useQuery({ queryKey: key(projectId), queryFn: async () => (await rpc('format:colors:get', { projectId })) as ColorMap, staleTime: 30_000 });
}

type Edit = { colors: Record<string, ColorToken>; changed: boolean } | null;

/** Write one edit and adopt the stored column it answers with. */
function useAdopt(projectId: string) {
  const qc = useQueryClient();
  return (column: string, r: Edit) => {
    if (!r) return;
    qc.setQueryData<ColorMap>(key(projectId), (map) => ({ ...(map ?? {}), [column]: r.colors }));
  };
}

export function useColorEdits(projectId: string) {
  const adopt = useAdopt(projectId);
  return {
    set: async (column: string, value: string, token: ColorToken | null) => adopt(column, (await rpc('format:colors:set', { projectId, column, value, token })) as Edit),
    reset: async (column: string) => adopt(column, (await rpc('format:colors:reset', { projectId, column })) as Edit),
    palette: async (column: string, values: (string | number | null)[]) => adopt(column, (await rpc('format:colors:palette', { projectId, column, values })) as Edit),
  };
}

/**
 * Persist a deal the chart on screen made: when drawing these `values` of
 * `column` dealt anything new, the server deals them against the stored map.
 * Authors only (`canWrite`) — a viewer's chart deals the same way, unsaved.
 */
export function usePersistDeal(projectId: string, map: ColorMap | undefined, column: string, values: unknown[] | undefined, canWrite: boolean) {
  const adopt = useAdopt(projectId);
  // The effect runs when WHAT was drawn changes (`sig`); the map and the values are read as of that draw.
  const latest = useRef({ map, column, values, adopt });
  latest.current = { map, column, values, adopt };
  const sig = JSON.stringify([column, values]);
  const ready = !!map;
  useEffect(() => {
    const { map: m, column: col, values: vs, adopt: take } = latest.current;
    if (!canWrite || !ready || !m || !col || !vs || !vs.length) return;
    if (!assignColors(m[col], vs).changed) return;
    const vals = vs.slice(0, 1_000).map((v) => (typeof v === 'number' || typeof v === 'string' ? v : v == null ? null : String(v)));
    rpc('format:colors:assign', { projectId, column: col, values: vals }).then((r) => take(col, r as Edit), () => undefined);
  }, [projectId, sig, canWrite, ready]);
}
