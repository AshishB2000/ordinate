// Rebuild a dashboard from a screenshot — the two channels (src/api/rebuild.ts)
// and the shapes they answer with. The reading is the model's STRUCTURE (no
// figure: the server sanitized it); every figure in a match is the engine's.

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { rpc, upload, type RpcInput } from '../../../api/client';
import type { PreviewVisual } from '../api';

export type Reading = RpcInput<'rebuild:match'>['reading'];
export type Override = NonNullable<RpcInput<'rebuild:match'>['overrides']>[number];
export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max';
export interface Box { x: number; y: number; w: number; h: number }

export type ReadReply =
  | { ok: true; reading: Reading & { tiles: (Reading['tiles'][number] & { id: number; box: Box | null })[] } }
  | { ok: false; notReady: true }
  | { ok: false; errorType: string; message: string; detail?: string };

export interface TileField {
  key: string;
  role: 'category' | 'value' | 'split' | 'filter' | 'date_filter';
  said: string;
  column: string | null;
  aggregation?: Agg;
  confidence: 'exact' | 'likely' | 'guess' | 'picked' | null;
  note?: string;
}

export interface MatchedTile {
  id: number;
  kind: 'kpi' | 'chart' | 'filter' | 'text';
  said: string;
  chartType: string | null;
  title: string;
  box: Box | null;
  multi?: boolean;
  fields: TileField[];
  status: 'ready' | 'unmapped' | 'dropped';
  reason?: string;
  preview?: { data: PreviewVisual['data']; note?: string };
  figure?: { value: number | null; error?: string };
}

export interface Column { name: string; type: 'text' | 'number' | 'date' }

export type MatchReply =
  | {
      ok: true;
      name: string;
      columns: Column[];
      tiles: MatchedTile[];
      layout: { kind: 'metric' | 'visual' | 'text'; x: number; y: number; w: number; h: number; tileId: number | null }[];
      controls: number;
      dropped: { kind?: string; where?: string; message: string }[];
      plan: Record<string, unknown>;
    }
  | { ok: false; error: string };

/** Upload the readied PNG and have the model read its structure. */
export async function readScreenshot(projectId: string, png: Blob): Promise<ReadReply> {
  const up = await upload(png, 'dashboard.png');
  return (await rpc('rebuild:read', { projectId, fileToken: up.fileToken })) as ReadReply;
}

/** The reading matched to one dataset with the user's corrections. App code: re-asked on every change, the last answer kept on screen meanwhile. */
export function useMatch(projectId: string, datasetId: string | null, reading: Reading | null, overrides: Override[]) {
  return useQuery({
    queryKey: ['rebuild:match', projectId, datasetId, reading, overrides],
    enabled: !!datasetId && !!reading,
    placeholderData: keepPreviousData,
    queryFn: async () => (await rpc('rebuild:match', { projectId, datasetId: datasetId as string, reading: reading as Reading, overrides })) as MatchReply,
  });
}
