// The dashboards screens' server calls (T2.8). Types mirror the handlers'
// replies (src/ipc/analyses.ts, analysesServer.ts, templates.ts, metrics.ts),
// narrowed by hand as in web/src/api/projects.ts — contracts carry inputs only.

import { useContext } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import { EditorCtx } from './editor/context';
import { rpc, RpcError, type RpcInput } from '../../api/client';
import type { ChartDataShape } from '../../charts/types';
import type { AsOf } from '../../ui/asOfView';

export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max';
export type Layout = { x: number; y: number; w: number; h: number };
export type Step = { type: string; [k: string]: unknown };

/** What a card needs of a saved Visual to draw it (analysesServer.ts `visualDef`). */
export interface VisualDef {
  id: string;
  name: string;
  datasetId: string;
  chartType: string;
  encoding: { category: string; values: { column: string; aggregation: string }[]; [k: string]: unknown };
  overrides: Record<string, unknown>;
  filters: Step[];
  analytics?: Record<string, unknown>[];
  updatedAt: string;
}

export type ControlKind = 'dropdown' | 'multi' | 'date_range' | 'parameter' | 'radius';
export type ControlValue = { value: string } | { values: string[] } | { from?: string; to?: string } | { preset: string; n?: number };

export interface Card {
  id: string;
  type: string;
  layout: Layout;
  visualId?: string;
  heading?: string;
  text?: string;
  metric?: {
    datasetId: string;
    column: string;
    aggregation: Agg;
    label?: string;
    format?: string;
    metricId?: string;
    compare?: { mode: 'previous_period' | 'previous_year' | 'custom'; from?: string; to?: string };
    [k: string]: unknown;
  };
  control?: { kind: ControlKind; label: string; datasetId: string; column: string; default?: ControlValue; paramId?: string; lngColumn?: string };
  container?: { title: string; background: string; padding: string; collapsible: boolean };
  tabs?: { items: { id: string; name: string }[] };
  divider?: { style: 'line' | 'spacer' };
  parentId?: string;
  tabId?: string;
  [k: string]: unknown;
}

export type SizeItem = {
  id: string;
  hidden?: true;
  h?: number;
};
export type Sheet = {
  id: string;
  name: string;
  cards: Card[];
  layouts?: { tablet?: { items: SizeItem[] }; phone?: { items: SizeItem[] } };
  /** Click-to-filter for the sheet (dashboards.ts Page.clickFilter). Absent is NOT on: only visuals that opted in. */
  clickFilter?: boolean;
};

export type Parameter = {
  id: string;
  name: string;
  kind: 'number' | 'text' | 'date' | 'list';
  value: number | string | string[] | null;
  list?: string[] | { datasetId: string; column: string };
  min?: number;
  max?: number;
  step?: number;
};

export interface Analysis {
  id: string;
  projectId: string;
  name: string;
  sheets: Sheet[];
  filters: Step[];
  style: Record<string, unknown>;
  parameters: Parameter[];
  updatedAt: string;
}

export interface GalleryItem {
  id: string;
  name: string;
  sheetCount: number;
  updatedAt: string;
  previews: VisualDef[];
  sheets: { id: string; name: string }[];
}

/** `analysis:gallery` — every dashboard with its first sheet's first two visuals. */
export const galleryQuery = (projectId: string) => ({
  queryKey: ['analysis:gallery', projectId],
  queryFn: async () => (await rpc('analysis:gallery', { projectId })) as GalleryItem[],
});
export function useGallery(projectId: string) {
  return useQuery(galleryQuery(projectId));
}

export type OpenReply = { ok: true; analysis: Analysis; visuals: VisualDef[] } | { ok: false; error: string };

/** `analysis:open` — the record and every visual it could show. Never refetched under an open editor. */
export function useOpenAnalysis(projectId: string, id: string) {
  return useQuery({
    queryKey: ['analysis:open', projectId, id],
    queryFn: async () => (await rpc('analysis:open', { projectId, id })) as OpenReply,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

// ── Tiles ────────────────────────────────────────────────────────────────

export type TileRequest = RpcInput<'analysis:tiles'>['items'][number];
export type ParamPayload = NonNullable<RpcInput<'analysis:tiles'>['params']>;

export interface CompareReply {
  ok: boolean;
  reason?: 'no_date_filter';
  delta?: number | null;
  pct?: number | null;
  previous?: number | null;
  label?: string;
  prior?: { from?: string; to?: string };
  previousDisplay?: string;
  deltaDisplay?: string;
  direction?: 'up_good' | 'down_good';
}
/** Every tile's answer says how fresh it is (`asOf`, L0.2) — the card's head shows it. */
export type VisualTile =
  // `category`: how the server bucketed the axis (src/analysis/categoryKey.ts) — a `date` axis is a time series.
  | { ok: true; data: ChartDataShape & Record<string, unknown>; warnings: string[]; paramErrors?: string[]; asOf?: AsOf; category?: { kind: 'text' | 'date' | 'number'; grain?: string } }
  | { ok: false; error: string };
/** A statistics card's answer (src/ipc/stats.ts computeStatsTile): every cell a string the server wrote. */
export type StatsTile =
  | {
      ok: true;
      view: 'table' | 'chart';
      tile: {
        title: string;
        subtitle: string;
        sentence: string;
        table: { head: string[]; rows: string[][] };
        chart: { chartType: string; data: ChartDataShape & Record<string, unknown> };
      };
      asOf?: AsOf;
    }
  | { ok: false; error: string };
export type MetricTile =
  | { ok: true; value: number | null; display?: string; name?: string; paramErrors?: string[]; compare?: CompareReply; fx?: { target: string }; asOf?: AsOf }
  | { ok: false; error: string };

// A sheet is one round trip: the tiles asked for in the same tick go out as ONE
// `analysis:tiles` (at most BATCH each); each tile keeps its own query, so an
// edit refetches only the tiles whose request changed.
const BATCH = 100;
type Waiting = { req: TileRequest; resolve: (r: unknown) => void; reject: (e: unknown) => void };
/** The reader's As of and the dashboard's currency (T2.9) — one batch per scope, like per parameters. */
type Scope = { asOf?: string; currency?: string };
const waiting = new Map<string, { params: ParamPayload; scope: Scope; list: Waiting[] }>();

function flush(key: string, projectId: string): void {
  const entry = waiting.get(key);
  waiting.delete(key);
  if (!entry) return;
  for (let i = 0; i < entry.list.length; i += BATCH) {
    const part = entry.list.slice(i, i + BATCH);
    rpc('analysis:tiles', { projectId, params: entry.params, ...entry.scope, items: part.map((w) => w.req) }).then(
      (out) => part.forEach((w, j) => w.resolve(Array.isArray(out) && out[j] ? out[j] : { ok: false, error: 'No answer for this tile.' })),
      (err: unknown) => part.forEach((w) => w.reject(err)),
    );
  }
}

function loadTile(projectId: string, params: ParamPayload, scope: Scope, req: TileRequest): Promise<unknown> {
  const key = projectId + '\u0000' + JSON.stringify(params) + '\u0000' + JSON.stringify(scope);
  return new Promise((resolve, reject) => {
    let entry = waiting.get(key);
    if (!entry) {
      waiting.set(key, (entry = { params, scope, list: [] }));
      setTimeout(() => flush(key, projectId), 0);
    }
    entry.list.push({ req, resolve, reject });
  });
}

/** One tile's answer, computed by the server; batched with the sheet's other tiles. */
export function useTile<T extends VisualTile | MetricTile | StatsTile>(projectId: string, params: ParamPayload, req: TileRequest | undefined) {
  // Inside an open dashboard, the reader's As of and the dashboard's currency apply to every tile.
  const view = useContext(EditorCtx)?.view;
  const scope: Scope = { ...(view?.asOf ? { asOf: view.asOf } : {}), ...(view?.currency ? { currency: view.currency } : {}) };
  return useQuery({
    queryKey: ['analysis:tile', projectId, params, scope, req],
    queryFn: req === undefined ? skipToken : async () => (await loadTile(projectId, params, scope, req)) as T,
    retry: (count, err) => count < 2 && err instanceof RpcError && (err.status === 0 || err.status >= 500),
    // Keep the last figure on screen while the next computes (kpiTicker's hold).
    placeholderData: (prev) => prev,
  });
}

// ── Templates and plans ──────────────────────────────────────────────────

export interface TemplateRole {
  id: string;
  label: string;
  kind: string;
  required: boolean;
}
export interface Template {
  id: string;
  group: string;
  user?: boolean;
  name: string;
  blurb: string;
  thumb: string;
  roles: TemplateRole[];
  matches: { role: string; column: string; confidence: 'high' | 'medium' | 'low' }[];
  missingRequired: string[];
  reason: string;
}
export type TemplateList =
  | { ok: true; datasetId: string; datasetName: string; columns: { name: string; type: string }[]; templates: Template[] }
  | { ok: false; error: string };

/** One sheet of a drafted / previewed plan: each visual's figures computed by the app (or a note why not). */
export interface PreviewVisual {
  name?: string;
  title?: string;
  chartType?: string;
  data: (ChartDataShape & Record<string, unknown>) | null;
  note?: string;
}
export interface PlanPreview {
  ok: true;
  name?: string;
  rationale?: string;
  sheets: { name: string; visuals?: PreviewVisual[]; cards?: unknown[]; metrics?: { datasetId: string; column: string; aggregation: string; label?: string }[]; controls?: unknown[] }[];
  calculatedFields?: { name?: string; column?: string; formula?: string; expression?: string }[];
  dropped?: { kind?: string; where?: string; message?: string }[];
  plan?: Record<string, unknown>;
}
export type DraftReply = PlanPreview | { ok: false; notReady?: boolean; error?: string };

export type BuildReply = { ok: true; analysis: Analysis; dropped?: unknown[] } | { ok: false; error: string };

/** A refusal's words, or a thrown error's. */
export function failure(r: unknown, fallback: string): string {
  if (r instanceof Error) return r.message;
  const e = r && typeof r === 'object' ? (r as { error?: unknown }).error : undefined;
  return typeof e === 'string' && e ? e : fallback;
}

/** Aggregations as the editor names them (dashboards.ts DASH_AGG_LABELS). */
export const AGG_LABEL: Record<Agg, string> = { sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max' };
