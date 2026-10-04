// The Visuals screen's server calls (src/api/visuals.ts). Contracts carry
// inputs only, so each reply is narrowed here by hand, mirrored from
// src/analysis/visuals.ts (Visual, VisualSummary, VizEncoding) and
// src/ipc/visuals.ts (VizDataReply). Nothing here computes a figure: every
// number on the screen arrives in a reply.

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, RpcError } from '../../api/client';
import type { VizData } from '../../api/visuals';
import type { Overrides } from '../../charts/types';

export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none';

export interface Measure {
  column: string;
  aggregation: Agg;
  /** A measure from a RELATED dataset (the "from …" groups). */
  datasetId?: string;
  metricId?: string;
  calc?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Geo {
  level: 'country' | 'us_state' | 'us_county' | 'us_city' | 'us_zip' | 'world_city' | 'point' | 'custom' | 'hexbin' | 'flow';
  lat?: string;
  lon?: string;
  lat2?: string;
  lon2?: string;
  from?: string;
  to?: string;
  color?: string;
  boundaryId?: string;
  property?: string;
  basemap?: 'osm' | 'none';
}

/**
 * A chart's encoding as the server stores it. Open on purpose: the shelves this
 * screen does not edit yet (pivot, cohort, eventFunnel, facet, drivers, bins)
 * ride through untouched, so opening and saving never drops them.
 */
export interface Encoding {
  category: string;
  values: Measure[];
  series?: string;
  grain?: string;
  overlay?: 'previous_year';
  geo?: Geo;
  categoryDatasetId?: string;
  seriesDatasetId?: string;
  [shelf: string]: unknown;
}

/** A visual-level row filter (a transforms `filter` step). */
export interface FilterStep {
  type: 'filter';
  column: string;
  op: string;
  value?: string | number | null;
  values?: (string | number | null)[];
  [k: string]: unknown;
}

export interface VisualSummary {
  id: string;
  name: string;
  chartType: string;
  datasetId: string;
  updatedAt: string;
  favorite: boolean;
}

export interface Visual extends VisualSummary {
  encoding: Encoding;
  overrides: Overrides;
  filters: FilterStep[];
  analytics?: Record<string, unknown>[];
}

/** `visual:data` / `visual:preview`, with the builder's extras. */
export interface Preview extends VizData {
  category?: { kind?: string; grain?: string; binned?: boolean; note?: string };
  sample?: { note: string; by?: string };
  overlay?: { caption?: string; pct?: number };
}

type Fail = { ok: false; error: string };

export interface Thumb {
  id: string;
  chartType: string;
  overrides: Overrides;
  ok: boolean;
  data?: VizData['data'];
  error?: string;
}

export interface Boundary {
  id: string;
  name: string;
  featureCount: number;
  properties: { key: string; unique: boolean }[];
}

export interface RelatedCol {
  /** The select value: `@<datasetId>/<column>`. */
  key: string;
  column: string;
  type: string;
  datasetId: string;
  group: string;
}

export interface Suggestion {
  encoding: Encoding;
  chartType: string;
  why: string;
}

const qk = {
  list: (p: string) => ['visual:list', p] as const,
  one: (p: string, id: string) => ['visual:get', p, id] as const,
};

export function useVisualList(projectId: string) {
  return useQuery({ queryKey: qk.list(projectId), queryFn: async () => (await rpc('visual:list', { projectId })) as VisualSummary[] });
}

/** One saved visual; `null` data = it does not exist (deleted, or another project's). */
export function useVisual(projectId: string, id: string | undefined) {
  return useQuery({
    queryKey: qk.one(projectId, id ?? ''),
    queryFn: id === undefined ? skipToken : async () => (await rpc('visual:get', { projectId, id })) as Visual | null,
  });
}

/** Re-read the gallery (and the one visual) after a write. */
export function useRefreshVisuals(projectId: string) {
  const qc = useQueryClient();
  return (id?: string) => {
    void qc.invalidateQueries({ queryKey: qk.list(projectId) });
    if (id) void qc.invalidateQueries({ queryKey: qk.one(projectId, id) });
  };
}

// The gallery's thumbnails: every card that scrolls into view in the same
// tick goes out as ONE `visual:thumbs` (≤ 50 ids each), as the chart batch does.
type Waiting = { id: string; resolve: (t: Thumb) => void; reject: (e: unknown) => void };
const waiting = new Map<string, Waiting[]>();

function flush(projectId: string): void {
  const all = waiting.get(projectId) ?? [];
  waiting.delete(projectId);
  for (let i = 0; i < all.length; i += 50) {
    const part = all.slice(i, i + 50);
    rpc('visual:thumbs', { projectId, ids: part.map((w) => w.id) }).then(
      (out) => part.forEach((w, j) => w.resolve(Array.isArray(out) && out[j] ? (out[j] as Thumb) : { id: w.id, chartType: '', overrides: {}, ok: false })),
      (err: unknown) => part.forEach((w) => w.reject(err)),
    );
  }
}

export function loadThumb(projectId: string, id: string): Promise<Thumb> {
  return new Promise((resolve, reject) => {
    let list = waiting.get(projectId);
    if (!list) {
      waiting.set(projectId, (list = []));
      setTimeout(() => flush(projectId), 0);
    }
    list.push({ id, resolve, reject });
  });
}

/** A card's thumbnail, fetched once it is on screen; keyed by `updatedAt` so an edit redraws it. */
export function useThumb(projectId: string, v: VisualSummary, visible: boolean) {
  return useQuery({
    queryKey: ['visual:thumbs', projectId, v.id, v.updatedAt],
    queryFn: visible ? () => loadThumb(projectId, v.id) : skipToken,
    staleTime: 60_000,
    retry: false,
  });
}

/** The builder's preview — `visual:preview`, the sampled sibling of `visual:data`. */
export function usePreview(req: Parameters<typeof rpcPreview>[0] | undefined) {
  return useQuery({
    queryKey: ['visual:preview', req],
    queryFn: req === undefined ? skipToken : () => rpcPreview(req),
    placeholderData: (prev) => prev, // keep the last chart up while the next one computes
    retry: (n, err) => n < 2 && err instanceof RpcError && (err.status === 0 || err.status >= 500),
  });
}

async function rpcPreview(req: { projectId: string; datasetId: string; encoding: Encoding; filters: FilterStep[]; analytics?: Record<string, unknown>[] }) {
  const r = (await rpc('visual:preview', req)) as ({ ok: true } & Preview) | Fail;
  if (!r.ok) throw new Error(r.error || 'Could not compute the visual.');
  return r;
}

/** The chart's figures shaped by the project's Share policy — what "Copy data" puts on the clipboard. */
export async function sharedData(req: { projectId: string; datasetId: string; encoding: Encoding; filters: FilterStep[] }) {
  const r = (await rpc('visual:data', { ...req, share: 'export' })) as ({ ok: true } & VizData) | Fail;
  if (!r.ok) throw new Error(r.error || 'Could not read the data.');
  return r.data;
}

export async function saveVisual(input: {
  projectId: string;
  datasetId: string;
  name: string;
  chartType: string;
  encoding: Encoding;
  overrides: Overrides;
  filters: FilterStep[];
  analytics?: Record<string, unknown>[];
}): Promise<Visual> {
  const r = (await rpc('visual:save', input)) as Visual | Fail;
  if (!r || ('ok' in r && r.ok === false)) throw new Error((r && 'error' in r && r.error) || 'Failed to save the visual.');
  return r as Visual;
}

export async function updateVisual(
  projectId: string,
  id: string,
  patch: Partial<Pick<Visual, 'name' | 'chartType' | 'encoding' | 'overrides' | 'filters' | 'favorite' | 'analytics'>>,
): Promise<Visual> {
  const r = (await rpc('visual:update', { projectId, id, ...patch })) as { ok: true; visual: Visual } | Fail;
  if (!r.ok) throw new Error(r.error || 'Could not update the visual.');
  return r.visual;
}

export async function duplicateVisual(projectId: string, id: string): Promise<Visual> {
  const r = (await rpc('visual:duplicate', { projectId, id })) as { ok: true; visual: Visual } | Fail;
  if (!r.ok) throw new Error(r.error || 'Could not duplicate the visual.');
  return r.visual;
}

/** To the project's Trash: the reply `toastMovedToTrash` words (null = the call failed). */
export async function deleteVisual(projectId: string, id: string): Promise<{ ok?: boolean; cascaded?: number } | null> {
  return (await rpc('visual:delete', { projectId, id }).catch(() => null)) as { ok?: boolean; cascaded?: number } | null;
}

export type SuggestReply = { ok: true; options: Suggestion[] } | { ok: false; notReady?: boolean; error?: string };

export async function suggestCharts(projectId: string, datasetId: string, intent: string): Promise<SuggestReply> {
  return (await rpc('visual:suggest', { projectId, datasetId, ...(intent ? { intent } : {}) })) as SuggestReply;
}

/** Hand a saved visual to the Assistant: it narrates the app's facts in a new dock thread. */
export async function explainVisual(projectId: string, visualId: string): Promise<void> {
  const r = (await rpc('answer:explain', { projectId, visualId })) as { ok: true } | { ok: false; reason?: string };
  if (!r.ok) throw new Error(r.reason || 'This chart cannot be explained.');
}

export function useBoundaries(projectId: string) {
  return useQuery({
    queryKey: ['boundary:list', projectId],
    queryFn: async () => {
      const r = (await rpc('boundary:list', { projectId })) as { ok: true; boundaries: Boundary[] } | Fail;
      return r.ok ? r.boundaries : [];
    },
  });
}

export async function importBoundaries(projectId: string, fileToken: string): Promise<Boundary> {
  const r = (await rpc('boundary:import', { projectId, fileToken })) as { ok: true; boundary: Boundary } | Fail;
  if (!r.ok) throw new Error(r.error || 'Could not import those boundaries.');
  return r.boundary;
}

/**
 * Columns of the datasets related to this one. A server without the
 * relationships handler (or a failure) means none — the form simply offers the
 * dataset's own columns, as it does when the project has no relationships.
 */
export function useRelated(projectId: string, datasetId: string | undefined) {
  return useQuery({
    queryKey: ['relationship:related', projectId, datasetId],
    queryFn:
      datasetId === undefined
        ? skipToken
        : async (): Promise<RelatedCol[]> => {
            const r = (await rpc('relationship:related', { projectId, datasetId }).catch(() => null)) as {
              ok: boolean;
              groups?: { datasetId: string; name: string; columns: { name: string; type: string }[] }[];
            } | null;
            return (r && r.ok && r.groups ? r.groups : []).flatMap((g) =>
              g.columns.map((c) => ({ key: `@${g.datasetId}/${c.name}`, column: c.name, type: c.type, datasetId: g.datasetId, group: g.name })),
            );
          },
    staleTime: 60_000,
  });
}
