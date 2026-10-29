// The dashboards screens' server calls (T2.8). Types mirror the handlers'
// replies (src/ipc/analyses.ts, analysesServer.ts, templates.ts, metrics.ts),
// narrowed by hand as in web/src/api/projects.ts — contracts carry inputs only.

import { useContext } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorCtx } from './editor/context';
import { rpc, RpcError, type RpcInput } from '../../api/client';
import type { ChartDataShape } from '../../charts/types';
import type { AsOf } from '../../ui/asOfView';
import { figureAskKey } from '../../../../src/analysis/figureAsk.ts';

export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max';
/** A starter layout, spelled as the `analysis:starterCards` contract spells it. */
export type StarterKind = RpcInput<'analysis:starterCards'>['kind'];
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
  /** The visual's content tag (src/app/editConflict.ts): the dashboard's Interactions send it as `base`. */
  tag?: string;
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
    /** Show the saved metric under this what-if scenario (analytics/scenarios); needs `metricId`. */
    scenarioId?: string;
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
  /** Saved views and the one the dashboard opens on ('' = none). Edited only through `analysis:view`. */
  views?: SavedView[];
  defaultViewId?: string;
  updatedAt: string;
}

// ── Drafts and Publish (src/analysis/publishedCopy.ts) ───────────────────
// Every dashboard is a draft only editors and admins see; Publish freezes it
// (layout, filters, text, KPIs and each chart's definition) as the published
// copy viewers read until the next Publish. Figures stay live.

/** never published · published, the draft is what was published · published, with edits not live yet. */
export type DashboardStatus = 'draft' | 'published' | 'edited';
/** About the published copy — never its sheets. `versionKey`: the version recorded at Publish (`versions:diff` from it to now); absent once unknown. */
export interface PublishedMeta {
  publishedAt: string;
  publishedBy?: string;
  versionKey?: string;
}

// ── Saved views (src/analysis/savedViews.ts) ─────────────────────────────
// Mirrored by hand: that module pulls in `crypto` (through dashboards.ts) and
// never ships to the browser. Only Vitest loads its compiled JS, to compare.

/** A reader's state of a dashboard, as a view stores it. */
export type ViewState = {
  /** The page (sheet) id; '' = the first. */
  page: string;
  /** Control card id → its selection; null = "All". */
  controls: Record<string, ControlValue | null>;
  /** Parameter id → its value; absent = the saved default. */
  params: Record<string, unknown>;
  /** The sheet-wide selection. */
  selection: Step[];
  /** Per-tile narrowing: card id → steps. */
  tiles: Record<string, Step[]>;
  /** Tabs card id → its open tab. */
  groupTabs: Record<string, string>;
  /** A snapshot time (ISO), or null for Latest. */
  asOf: string | null;
};

export interface SavedView {
  id: string;
  name: string;
  state: ViewState;
  createdAt: string;
  updatedAt: string;
}

/** One `analysis:view` edit, without the state the client gathers for create/update. */
export type ViewOp =
  | { op: 'create'; name: string }
  | { op: 'rename'; viewId: string; name: string }
  | { op: 'update'; viewId: string }
  | { op: 'delete'; viewId: string }
  | { op: 'default'; viewId: string };

export type ViewOpReply = { ok: true; views: SavedView[]; defaultViewId: string; viewId: string } | { ok: false; error: string };

export interface GalleryItem {
  id: string;
  name: string;
  sheetCount: number;
  updatedAt: string;
  status: DashboardStatus;
  publishedAt?: string;
  publishedBy?: string;
  previews: VisualDef[];
  sheets: { id: string; name: string }[];
}

/**
 * `analysis:gallery` — every dashboard with its first sheet's first two visuals and its status. A viewer's holds
 * published ones only (status `published`), each card built from the published copy.
 */
export const galleryQuery = (projectId: string) => ({
  queryKey: ['analysis:gallery', projectId],
  queryFn: async () => (await rpc('analysis:gallery', { projectId })) as GalleryItem[],
});
export function useGallery(projectId: string) {
  return useQuery(galleryQuery(projectId));
}

/**
 * `tag`: the record's content tag, the editor's first base (src/app/editConflict.ts). `showing`: which one `analysis`
 * is — the draft, or the published copy (its cards' charts frozen: `visuals` are those definitions). A viewer's is
 * always the copy, with `status` `published`.
 */
export type OpenReply =
  | { ok: true; analysis: Analysis; visuals: VisualDef[]; tag?: string; status: DashboardStatus; showing: 'draft' | 'published'; published?: PublishedMeta }
  | { ok: false; error: string };

/** The query key of a dashboard's open reply: the draft's, or (`published`) the published copy's. */
export const openKey = (projectId: string, id: string, published = false) => (published ? ['analysis:open', projectId, id, 'published'] : ['analysis:open', projectId, id]);

/**
 * `analysis:open` — the record and every visual it could show. Never refetched under an open editor. `published`:
 * the published copy (the view page) — an editor gets the draft when there is none yet (`showing: 'draft'`, a
 * Preview); a viewer gets the copy whatever is asked, and a draft never published is a refusal.
 */
export function useOpenAnalysis(projectId: string, id: string, opts: { published?: boolean } = {}) {
  const published = opts.published === true;
  return useQuery({
    queryKey: openKey(projectId, id, published),
    queryFn: async () => (await rpc('analysis:open', { projectId, id, ...(published ? { published } : {}) })) as OpenReply,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export type PublishReply = { ok: true; status: DashboardStatus; published: PublishedMeta };
export type UnpublishReply = { ok: true; status: DashboardStatus };
/** The restored draft and its tag (the editor's next base). */
export type DiscardReply = { ok: true; analysis: Analysis; tag: string; status: DashboardStatus; published: PublishedMeta };

async function done<T>(p: Promise<unknown>, fallback: string): Promise<T> {
  const r = (await p) as { ok?: boolean };
  if (!r || r.ok !== true) throw new Error(failure(r, fallback));
  return r as T;
}

/**
 * Publish, Unpublish and Discard edits for one dashboard (editors: the channels are `write`). Each keeps the
 * gallery and the published copy's open reply current, and the draft's open reply's status — never refetching the
 * draft under an open editor. `publish(base)`: the editor's tag; a draft that moved since is a 409 (RpcError).
 * Discard's reply carries the restored draft and its tag for the editor to adopt.
 */
export function useDraftActions(projectId: string, id: string) {
  const client = useQueryClient();
  const settle = (patch: Partial<Extract<OpenReply, { ok: true }>>) => {
    client.setQueryData<OpenReply>(openKey(projectId, id), (o) => (o && o.ok ? { ...o, ...patch } : o));
    void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });
    void client.invalidateQueries({ queryKey: openKey(projectId, id, true) });
  };
  return {
    publish: useMutation({
      mutationFn: (base?: string) => done<PublishReply>(rpc('analysis:publish', { projectId, id, ...(base ? { base } : {}) }), 'The dashboard could not be published.'),
      onSuccess: (r) => settle({ status: r.status, published: r.published }),
    }),
    unpublish: useMutation({
      mutationFn: () => done<UnpublishReply>(rpc('analysis:unpublish', { projectId, id }), 'The dashboard could not be unpublished.'),
      onSuccess: (r) => settle({ status: r.status, published: undefined }),
    }),
    discard: useMutation({
      mutationFn: () => done<DiscardReply>(rpc('analysis:discard', { projectId, id }), 'The edits could not be discarded.'),
      onSuccess: (r) => settle({ analysis: r.analysis, tag: r.tag, status: r.status, published: r.published }),
    }),
  };
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
  | { ok: true; data: ChartDataShape & Record<string, unknown>; warnings: string[]; paramErrors?: string[]; asOf?: AsOf; category?: { kind: 'text' | 'date' | 'number'; grain?: string }; ask?: string }
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
/** A what-if card's figure under its scenario, beside the baseline — `scenario:card`'s reply, every string the server's. */
export type ScenarioReply =
  | { ok: true; scenarioName: string; baseline: number | null; baselineDisplay: string; value: number | null; display: string; delta: number | null; deltaDisplay: string; pct: number | null; tone: 'good' | 'bad' | 'flat' | 'neutral' }
  | { ok: false; error: string };
export type MetricTile =
  | { ok: true; value: number | null; display?: string; name?: string; paramErrors?: string[]; compare?: CompareReply; scenario?: ScenarioReply; fx?: { target: string }; asOf?: AsOf }
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
export function useTile<T extends VisualTile | MetricTile | StatsTile | { ok: boolean }>(projectId: string, params: ParamPayload, req: TileRequest | undefined) {
  // Inside an open dashboard, the reader's As of and the dashboard's currency apply to every tile.
  const view = useContext(EditorCtx)?.view;
  const scope: Scope = { ...(view?.asOf ? { asOf: view.asOf } : {}), ...(view?.currency ? { currency: view.currency } : {}) };
  return useQuery({
    queryKey: ['analysis:tile', projectId, params, scope, req],
    // Each answer says which figure ask it answers, so a held one for another ask is never drawn as this one's.
    queryFn: req === undefined ? skipToken : async () => ({ ...((await loadTile(projectId, params, scope, req)) as object), ask: figureAskKey((req as { chartType?: string }).chartType, req) }) as unknown as T,
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
  sheets: {
    name: string;
    visuals?: PreviewVisual[];
    cards?: unknown[];
    metrics?: { datasetId: string; column: string; aggregation: string; label?: string }[];
    controls?: unknown[];
    /** Where each tile will sit on the 12-column grid, in reading order (planPreview.ts). Absent from an older reply. */
    layout?: { kind: 'metric' | 'visual' | 'text'; x: number; y: number; w: number; h: number }[];
  }[];
  calculatedFields?: { name?: string; column?: string; formula?: string; expression?: string }[];
  dropped?: { kind?: string; where?: string; message?: string }[];
  plan?: Record<string, unknown>;
}
/** A draft that was not asked to ask first (`story:draft`): a plan, or a refusal. */
export type PlanReply = PlanPreview | { ok: false; notReady?: boolean; error?: string };

// ASK FIRST (src/analysis/planClarify.ts). The kind and the look are spelled as
// their contracts spell them, so a renamed one fails `tsc` here too.
export type DraftKind = NonNullable<RpcInput<'analysis:draft'>['kind']>;
/** A look by preset id — what `analysis:buildPlan` takes; the server holds what each one is. */
export type LookId = NonNullable<RpcInput<'analysis:buildPlan'>['style']>;
/** One of the model's own questions about the request: structure, validated by the server, never a figure. */
export interface DraftQuestion {
  ask: string;
  options: string[];
}
export type DraftAnswer = NonNullable<RpcInput<'analysis:draft'>['answers']>[number];
/** `analysis:draft` asked with `clarify`: the plan, a refusal — or, once, QUESTIONS instead of a plan. */
export type DraftReply = PlanReply | { ok: true; questions: DraftQuestion[] };

export type BuildReply = { ok: true; analysis: Analysis; dropped?: unknown[] } | { ok: false; error: string };

/** A refusal's words, or a thrown error's. */
export function failure(r: unknown, fallback: string): string {
  if (r instanceof Error) return r.message;
  const e = r && typeof r === 'object' ? (r as { error?: unknown }).error : undefined;
  return typeof e === 'string' && e ? e : fallback;
}

/** Aggregations as the editor names them (dashboards.ts DASH_AGG_LABELS). */
export const AGG_LABEL: Record<Agg, string> = { sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max' };
