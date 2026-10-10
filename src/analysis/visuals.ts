// Visual persistence — MAIN PROCESS ONLY.
// One JSON file per visual under userData/projects/<projectId>/visuals/<id>.json,
// a `visuals/` sibling of `datasets/`. A Visual persists a saved chart/map: which
// dataset, a user field/encoding, and a chart type — the numbers themselves are
// (re)computed on demand by the PURE bridge (src/vizData.ts), never stored.
//
// Mirrors src/datasets.ts conventions verbatim: the dual-UUID id-validation guard
// (BOTH projectId AND visual id are UUID-checked before either touches a path, so
// a visual path can never escape userData/projects/<projectId>/visuals), atomic
// JSON writes, graceful skip of missing/corrupt files, and a normalize() that
// fills defaults + re-sanitizes the stored encoding on load.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import { sanitizeSteps } from '../data/transforms';
import type { FilterStep } from '../data/transforms';
import { isDateGrain, sanitizeBins } from './categoryKey';
import type { DateGrain } from './categoryKey';
import { sanitizePivot } from './pivotData';
import type { PivotEncoding } from './pivotData';
import { sanitizeDriversEncoding } from './driverScope';
import type { DriversEncoding } from './driverScope';
import { sanitizeCohort } from './cohortData';
import type { CohortEncoding } from './cohortData';
import { sanitizeEventFunnel } from './funnelEvents';
import type { FunnelEncoding } from './funnelEvents';
import { sanitizeOverlays } from './analytics';
import type { Overlay } from './analytics';
import { sanitizeTableCalc } from './tableCalc';
import { sanitizeFacet } from './facets';
import type { FacetEncoding } from './facets';
import type { TableCalc } from './tableCalc';
import { sanitizeFormat, NUMBER_FORMAT_IDS, SORT_MODE_IDS } from './chartFormat';
import type { FormatOverrides, FormatContext, SortMode } from './chartFormat';
import * as recordFs from '../app/recordFs';

export type VizAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none';

export interface VizMeasure {
  column: string; // dataset column name
  aggregation: VizAggregation;
  /**
   * The saved Metric this measure IS, when the builder's measure chip was
   * filled from the metric picker.
   *
   * ADDITIVE: `column`/`aggregation` stay required and stay filled, so every
   * chart drawn before this key existed — and every chart whose metric is later
   * deleted — plots exactly as it did. `vizData.buildVizData` never reads it;
   * it is carried so the chip can show the metric's NAME and format, and so
   * `metric:usage` can say which visuals a metric appears on.
   */
  metricId?: string;
  /**
   * The RELATED dataset this measure's column belongs to, reached through the
   * project's relationships (analysis/joinPlan.ts). Absent means the visual's
   * own dataset — every visual saved before relationships existed.
   */
  datasetId?: string;
  /**
   * "Calculate as" — a table calculation over this measure's AGGREGATED
   * figures (analysis/tableCalc.ts), run after the grid exists. Absent = the
   * figures as they are, which is every chart saved before this key existed.
   */
  calc?: TableCalc;
}

export interface VizGeo {
  /**
   * `point` plots rows at their `lat`/`lon` columns; `world_city` (and
   * `us_city` / `us_zip`) places values through the offline place table
   * (analysis/places.ts); `custom` is a project-imported boundary set.
   */
  level: 'country' | 'us_state' | 'us_county' | 'us_city' | 'us_zip' | 'world_city' | 'point' | 'custom' | 'hexbin' | 'flow';
  lat?: string;
  lon?: string;
  /**
   * `flow` (r6:geo): the DESTINATION coordinates (`lat`/`lon` are the origin),
   * and optional columns naming each end. `hexbin` reads `lat`/`lon` only.
   * Both take their measure from `values[0]` — count, sum or average.
   */
  lat2?: string;
  lon2?: string;
  from?: string;
  to?: string;
  /** Colour points by this column (text → categories, number → a ramp). */
  color?: string;
  /** `custom`: the imported boundary set, and the feature property joined to the category. */
  boundaryId?: string;
  property?: string;
  /** OSM raster tiles (the default on screen) or none — an offline land/water fill (the default in exports). */
  basemap?: 'osm' | 'none';
}

export interface VizEncoding {
  category: string; // the dimension column (chart labels / geo region name / x)
  values: VizMeasure[]; // one or more measures → one or more series
  series?: string; // OPTIONAL split/pivot column (category × series → grid of series)
  geo?: VizGeo; // present only for map chart types
  /** The related dataset `category` / `series` come from (analysis/joinPlan.ts); absent = the visual's own. */
  categoryDatasetId?: string;
  seriesDatasetId?: string;
  /**
   * OPTIONAL roll-up for a DATE category (day/week/month/quarter/year). Absent
   * means "pick the finest grain that keeps the axis readable", which is what
   * every chart saved before this key existed gets — so no migration.
   */
  grain?: DateGrain;
  /**
   * OPTIONAL bucket count for a NUMBER category. `bins` is to a numeric axis
   * what `grain` is to a date one: the same kind of explicit, per-chart
   * authoring choice over the same kind of derived default. Absent means
   * `categoryKey.NUM_BINS`, which is what every chart saved before this key
   * existed gets — so, again, no migration.
   *
   * The remaining category rewrite — the top-50 cap on a text column — is
   * deliberately still NOT stored: it is derived from the filtered data rather
   * than chosen, so an old saved visual over a high-cardinality column is fixed
   * by reading it, not by re-saving it.
   */
  bins?: number;
  /**
   * The PIVOT encoding — rows / columns / values / totals / sort, its own
   * shape because a pivot's shelves are not a chart's `category` + `values`
   * (three row dimensions, two column ones, four value fields).
   *
   * It sits BESIDE the chart fields rather than replacing them, and the builder
   * mirrors `rows[0]` → `category`, `columns[0]` → `series` and `values[0]` →
   * `values[0]`. That is what lets every surface that reads an encoding without
   * caring about chart type — the drill panel, the AI suggestion prompt, the
   * name suggester, a switch back to a column chart — keep working unchanged.
   *
   * Absent for every visual saved before pivots existed, which is exactly what
   * "not a pivot" means, so there is no migration.
   */
  pivot?: PivotEncoding;
  /** A COHORT visual's shelves (analysis/cohortData) — beside the mirrored chart fields, like `pivot`. */
  cohort?: CohortEncoding;
  /** An EVENT FUNNEL's shelves (analysis/funnelEvents) — beside the mirrored chart fields, like `pivot`. */
  eventFunnel?: FunnelEncoding;
  /**
   * OPTIONAL period overlay for a line/column chart on a DATE category:
   * `previous_year` adds the same slice a year earlier as a muted series,
   * aligned bucket by bucket (ipc/visualsOverlay.ts). It changes the DATA,
   * which is why it rides on the encoding and not on the styling overrides.
   */
  overlay?: 'previous_year';
  /** A KEY DRIVERS waterfall tile's question (analysis/driverScope) — recomputed on every render. */
  drivers?: DriversEncoding;
  /** Small multiples (./facets): one panel per facet value. It changes the DATA, so it rides here. */
  facet?: FacetEncoding;
}

// Whitelisted chart-styling overrides — the SAME object shape the capture-flow ⋯
// Customize menu produces and chartRender.buildChart consumes. Stored verbatim on a
// Visual so a saved chart re-renders with its styling. All fields OPTIONAL: an
// absent field means "use the buildChart default" (identical to Week 7).
export interface VizOverrides extends FormatOverrides {
  title?: string | null;
  color?: string | null;
  legendPosition?: 'bottom' | 'top' | 'left' | 'right';
  showLegend?: boolean;
  showGridlines?: boolean;
  xAxisLabel?: string | null;
  yAxisLabel?: string | null;
  yZero?: boolean;
  sort?: SortMode;
  smooth?: boolean;
  valueMode?: 'off' | 'all' | 'maxmin' | 'max' | 'min';
  hiddenSeries?: number[];
  periodIdx?: number;
  numberFormat?: 'auto' | 'plain' | 'thousands' | 'compact' | 'percent' | 'currency';
  /**
   * Interactions. Both live here rather than in a new field because overrides is
   * already the per-visual bag the editor writes and sanitizeOverrides already
   * whitelists it — a new storage field would be a new file-format decision for
   * two booleans.
   *
   * crossFilter: clicking a mark on this visual filters the other cards on the
   * sheet (dashboardFilters.clickFilterOn). Three states: `true` opts the
   * visual in on any sheet; `false` opts it OUT of a sheet whose own
   * "Click to filter" switch (Page.clickFilter) is on; absent follows the
   * sheet — which is off for a sheet saved before the switch existed, so a
   * click there never silently refilters every other card.
   * showTooltips: default ON when absent, matching every chart drawn before this
   * key existed.
   */
  crossFilter?: boolean;
  showTooltips?: boolean;
  /** Bullet: the fixed target, used when the encoding has no second (target) measure. */
  bulletTarget?: number;
  /** Waterfall: categories drawn as totals, beyond those LABELLED "Total"/"Subtotal"/"Grand total". */
  waterfallTotals?: string[];
  /** Project events on a date axis (analysis/events). Absent = shown; only `false` hides them. r8:events */
  showEvents?: boolean;
}

export interface Visual {
  id: string;
  projectId: string;
  name: string;
  datasetId: string;
  chartType: string; // one of ALL_CHART_TYPE_IDS ∪ {'table','map_bubble','map_choropleth'}
  encoding: VizEncoding;
  overrides: VizOverrides; // chart-styling overrides (empty {} = defaults). schema v2.
  filters: FilterStep[]; // visual-level row filters applied BEFORE aggregation. schema v2.
  /**
   * Pinned to the top of the gallery. NOT a schema bump: `normalize()` defaults
   * a missing key to `false`, so every v2 file written before this existed reads
   * back correctly and unfavourited. A version bump would have bought a
   * migration for one boolean whose absence already means exactly what it should.
   */
  favorite: boolean;
  /**
   * The Analytics pane's overlays — reference lines, bands, targets, trends,
   * moving averages, forecasts, annotations, highlights (./analytics). Their
   * DEFINITIONS only: every figure is re-resolved on each `visual:data`.
   * ADDITIVE, like `favorite`: absent means none, so no schema bump.
   */
  analytics?: Overlay[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: 2;
}

export interface VisualSummary {
  id: string;
  name: string;
  chartType: string;
  datasetId: string;
  updatedAt: string;
  favorite: boolean;
}


function getProjectsBase(): string {
  return path.join(appPaths.userData(), 'projects');
}

// Ids arrive from the renderer over IPC. Validate the SHAPE before either id ever
// reaches a filesystem path — an id like ".." would otherwise escape the project's
// visuals dir. Copied verbatim from datasets.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function visualsDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'visuals');
}

function visualFilePath(projectId: string, id: string): string {
  return path.join(visualsDir(projectId), id + '.json');
}

const AGG_FNS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max', 'none']);
const GEO_LEVELS: ReadonlySet<string> = new Set([
  'country', 'us_state', 'us_county', 'us_city', 'us_zip', 'world_city', 'point', 'custom',
  'hexbin', 'flow', // r6:geo
]);

// Atomic JSON write: temp sibling then rename (atomic on same fs). Copied from
// datasets.ts.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file); // atomic on same fs
}

// Whitelist an untrusted (renderer/stored) encoding into a well-formed VizEncoding:
// keep only string columns, clamp aggregation to the known set (default 'sum'), and
// accept a geo block only for a known level. Never throws.
export function sanitizeEncoding(raw: unknown): VizEncoding {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const category = typeof o.category === 'string' ? o.category : '';

  const valuesRaw = Array.isArray(o.values) ? o.values : [];
  const values: VizMeasure[] = [];
  for (const v of valuesRaw) {
    if (!v || typeof v !== 'object') continue;
    const vo = v as Record<string, unknown>;
    const column = typeof vo.column === 'string' ? vo.column : '';
    if (!column) continue;
    const aggregation: VizAggregation =
      typeof vo.aggregation === 'string' && AGG_FNS.has(vo.aggregation) ? (vo.aggregation as VizAggregation) : 'sum';
    const measure: VizMeasure = { column, aggregation };
    // UUID-shaped only — the same guard `sanitizeCard` puts on a card's
    // metricId, for the same reason: this id reaches a path in the metrics store.
    if (typeof vo.metricId === 'string' && UUID_RE.test(vo.metricId)) measure.metricId = vo.metricId;
    if (typeof vo.datasetId === 'string' && UUID_RE.test(vo.datasetId)) measure.datasetId = vo.datasetId;
    const calc = sanitizeTableCalc(vo.calc);
    if (calc) measure.calc = calc;
    values.push(measure);
  }

  const enc: VizEncoding = { category, values };
  if (typeof o.series === 'string' && o.series) enc.series = o.series;
  const catDs = o.categoryDatasetId;
  if (typeof catDs === 'string' && UUID_RE.test(catDs)) enc.categoryDatasetId = catDs;
  const serDs = o.seriesDatasetId;
  if (enc.series && typeof serDs === 'string' && UUID_RE.test(serDs)) enc.seriesDatasetId = serDs;
  // Whitelisted against DATE_GRAINS, like every other enum here: a model- or
  // plan-supplied grain survives, anything else is DROPPED rather than clamped
  // to a default, because an absent grain already means "choose one from the
  // data" and silently substituting 'day' would be a different chart.
  if (isDateGrain(o.grain)) enc.grain = o.grain;
  // Same rule as `grain` directly above, through the whitelist that owns it:
  // out of range is DROPPED, not clamped, so a bad value falls back to the
  // default instead of silently becoming a chart nobody asked for.
  const bins = sanitizeBins(o.bins);
  if (bins !== undefined) enc.bins = bins;
  // Its own whitelist, in the file that owns the shape. Same discipline as
  // `grain` and `bins`: unknown keys dropped, every enum clamped to its set.
  if (o.overlay === 'previous_year') enc.overlay = 'previous_year';
  const pivot = sanitizePivot(o.pivot);
  if (pivot) enc.pivot = pivot;
  const drivers = sanitizeDriversEncoding(o.drivers);
  if (drivers) enc.drivers = drivers;
  const cohort = sanitizeCohort(o.cohort);
  if (cohort) enc.cohort = cohort;
  const eventFunnel = sanitizeEventFunnel(o.eventFunnel);
  if (eventFunnel) enc.eventFunnel = eventFunnel;
  const facet = sanitizeFacet(o.facet);
  if (facet) enc.facet = facet;
  if (o.geo && typeof o.geo === 'object') {
    const g = o.geo as Record<string, unknown>;
    if (typeof g.level === 'string' && GEO_LEVELS.has(g.level)) {
      const geo: VizGeo = { level: g.level as VizGeo['level'] };
      for (const k of ['lat', 'lon', 'color', 'property', 'lat2', 'lon2', 'from', 'to'] as const) {
        const v = g[k];
        if (typeof v === 'string' && v) geo[k] = v;
      }
      if (typeof g.boundaryId === 'string' && UUID_RE.test(g.boundaryId)) geo.boundaryId = g.boundaryId;
      if (g.basemap === 'osm' || g.basemap === 'none') geo.basemap = g.basemap;
      enc.geo = geo;
    }
  }
  return enc;
}

export function sanitizeChartType(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'column';
}

/**
 * The chart types the AI suggestion prompt is allowed to name.
 *
 * MAIN needs its own copy: the renderer's `ALL_CHART_TYPE_IDS` lives in
 * the desktop's `renderResult.ts`, a classic global-scope <script> that cannot be
 * imported here. Two lists can drift, and the drift is SILENT — the model
 * proposes a type the renderer cannot draw and the user gets an empty option. So
 * `scripts/test-visual-chart-ids.ts` parses `ALL_CHART_TYPE_IDS` straight out of
 * that file and asserts every id below is in it.
 *
 * Deliberately a SUBSET of what a Visual may STORE: no 'table' (a fallback, not
 * a proposal) and neither map, because a map needs a geo level the model is
 * never asked for. `sanitizeChartType` is unchanged and still permissive — this
 * list constrains the PROMPT, and the picker constrains what can be drawn.
 */
export const SUGGESTABLE_CHART_TYPES: readonly string[] = [
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar',
  'line', 'line_markers', 'area', 'stacked_area',
  'pie', 'donut', 'scatter', 'gauge', 'combo', 'bubble',
  'treemap', 'heatmap', 'funnel', 'histogram',
  'sankey', 'candlestick', 'boxplot',
  'waterfall', 'bullet', 'calendar', 'radar', 'pareto',
  'word_cloud',
];

// Allowed enum sets for the clamped override fields.
const LEGEND_POSITIONS: ReadonlySet<string> = new Set(['bottom', 'top', 'left', 'right']);
const SORT_MODES: ReadonlySet<string> = new Set(SORT_MODE_IDS);
const VALUE_MODES: ReadonlySet<string> = new Set(['off', 'all', 'maxmin', 'max', 'min']);
const NUMBER_FORMATS: ReadonlySet<string> = new Set(NUMBER_FORMAT_IDS);

// Whitelist untrusted (renderer/stored) chart overrides into a well-formed
// VizOverrides: keep ONLY known keys, clamp each enum to its allowed set, coerce
// booleans/numbers, drop everything else. Mirrors sanitizeEncoding's "never throw,
// whitelist" discipline. An empty/invalid input → {} (buildChart defaults). Only
// keys actually present are emitted, so overrides stay minimal.
//
// `ctx` — the visual's chart type and encoding — is what the formatting-depth
// keys are clamped against (chartFormat.ts). Without it a dual axis is dropped
// rather than trusted.
export function sanitizeOverrides(raw: unknown, ctx?: FormatContext): VizOverrides {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: VizOverrides = {};

  // Nullable string fields ("" is a legit value; null means "explicitly cleared").
  const strOrNull = (v: unknown): string | null | undefined =>
    typeof v === 'string' ? v : v === null ? null : undefined;
  if ('title' in o) { const v = strOrNull(o.title); if (v !== undefined) out.title = v; }
  if ('color' in o) { const v = strOrNull(o.color); if (v !== undefined) out.color = v; }
  if ('xAxisLabel' in o) { const v = strOrNull(o.xAxisLabel); if (v !== undefined) out.xAxisLabel = v; }
  if ('yAxisLabel' in o) { const v = strOrNull(o.yAxisLabel); if (v !== undefined) out.yAxisLabel = v; }

  // Clamped enums — a value off the allowed list is dropped entirely.
  if (typeof o.legendPosition === 'string' && LEGEND_POSITIONS.has(o.legendPosition)) {
    out.legendPosition = o.legendPosition as VizOverrides['legendPosition'];
  }
  if (typeof o.sort === 'string' && SORT_MODES.has(o.sort)) out.sort = o.sort as VizOverrides['sort'];
  if (typeof o.valueMode === 'string' && VALUE_MODES.has(o.valueMode)) {
    out.valueMode = o.valueMode as VizOverrides['valueMode'];
  }
  if (typeof o.numberFormat === 'string' && NUMBER_FORMATS.has(o.numberFormat)) {
    out.numberFormat = o.numberFormat as VizOverrides['numberFormat'];
  }

  // Booleans (coerce only when the key is present).
  if ('showLegend' in o) out.showLegend = Boolean(o.showLegend);
  if ('showGridlines' in o) out.showGridlines = Boolean(o.showGridlines);
  if ('yZero' in o) out.yZero = Boolean(o.yZero);
  if ('smooth' in o) out.smooth = Boolean(o.smooth);
  if ('crossFilter' in o) out.crossFilter = Boolean(o.crossFilter);
  if ('showTooltips' in o) out.showTooltips = Boolean(o.showTooltips);
  if (o.showEvents === false) out.showEvents = false; // r8:events — absent = on

  // Numeric fields — finite numbers only.
  if (Array.isArray(o.hiddenSeries)) {
    out.hiddenSeries = o.hiddenSeries.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  }
  if (typeof o.periodIdx === 'number' && Number.isFinite(o.periodIdx)) out.periodIdx = o.periodIdx;
  if (typeof o.bulletTarget === 'number' && Number.isFinite(o.bulletTarget)) out.bulletTarget = o.bulletTarget;
  // Category labels, so strings only — bounded, since a record is untrusted.
  if (Array.isArray(o.waterfallTotals)) {
    out.waterfallTotals = o.waterfallTotals
      .filter((s): s is string => typeof s === 'string' && s.length <= 200)
      .slice(0, 200);
  }

  // Formatting depth: axes, dual axis, labels, custom sort, colours (chartFormat.ts).
  Object.assign(out, sanitizeFormat(o, ctx));
  return out;
}

// Whitelist visual-level filters. Delegates to transforms.sanitizeSteps so filter
// validation stays single-source, then keeps ONLY 'filter' steps (a Visual never
// carries an aggregate/rename/etc. — its aggregation comes from the encoding).
export function sanitizeFilters(raw: unknown): FilterStep[] {
  return sanitizeSteps(raw).filter((s): s is FilterStep => s.type === 'filter');
}

// Basic shape validation for a parsed visual.json (skips corrupt files).
function isValidVisual(data: any): boolean {
  return Boolean(data) && typeof data.id === 'string' && data.id.length > 0 && typeof data.datasetId === 'string';
}

// Coerce a parsed object into a well-formed Visual (fills sane defaults, re-
// sanitizes the stored encoding on load).
function normalize(data: any, projectId: string): Visual {
  const createdAt = data.createdAt || new Date().toISOString();
  const chartType = sanitizeChartType(data.chartType);
  const encoding = sanitizeEncoding(data.encoding);
  return {
    id: String(data.id),
    projectId,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled visual',
    datasetId: String(data.datasetId),
    chartType,
    encoding,
    // v1 files carry no overrides/filters → {} / [] (behaves exactly as Week 7).
    overrides: sanitizeOverrides(data.overrides, { chartType, encoding }),
    filters: sanitizeFilters(data.filters),
    // Absent (every file written before favourites existed) means false.
    favorite: data.favorite === true,
    ...withAnalytics(data.analytics),
    createdAt,
    updatedAt: data.updatedAt || createdAt,
    schemaVersion: 2,
  };
}

/** `{ analytics }` when there are any overlays, else nothing — records stay minimal. */
function withAnalytics(raw: unknown): { analytics?: Overlay[] } {
  const list = sanitizeOverlays(raw);
  return list.length ? { analytics: list } : {};
}

// No-op stub kept for symmetry with projects.init()/datasets.init(). The per-
// project visuals/ dir is created lazily on first saveVisual.
export async function init(): Promise<void> {
  // Intentionally empty — per-project visuals/ dirs are created on demand.
}

// Return summaries for a project's visuals, newest-updated first. Skips
// corrupt/missing files quietly (ENOENT silent; real damage logged).
export async function listVisuals(projectId: string): Promise<VisualSummary[]> {
  if (!isValidId(projectId)) return [];
  const dir = visualsDir(projectId);
  let dirents;
  try {
    dirents = await recordFs.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return []; // no visuals dir yet
  }

  const out: VisualSummary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const id = dirent.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue; // skip stray/tmp files
    try {
      const raw = await recordFs.readFile(visualFilePath(projectId, id), 'utf8');
      const data = JSON.parse(raw);
      if (!isValidVisual(data)) continue;
      const v = normalize(data, projectId);
      out.push({
        id: v.id, name: v.name, chartType: v.chartType, datasetId: v.datasetId,
        updatedAt: v.updatedAt, favorite: v.favorite,
      });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[visuals] Skipping corrupt or unreadable visual:', id, err.message);
      }
    }
  }

  // Favourites first, then newest-updated. Two keys, one comparator — a
  // separate partition-then-concat would sort the two halves independently and
  // is the same thing written twice.
  out.sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  return out;
}

// Load a single visual. Returns null if either id is invalid, or the file is
// missing/corrupt.
export async function getVisual(projectId: string, id: string): Promise<Visual | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const raw = await recordFs.readFile(visualFilePath(projectId, id), 'utf8');
    const data = JSON.parse(raw);
    if (!isValidVisual(data)) return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

// Create a new visual file. Id is generated (never derived from the name).
// Rejects (returns null) when: projectId or datasetId is not a UUID, the parent
// project does not exist, or the referenced dataset does not exist — so a visual
// can never orphan-reference a missing dataset the bridge would fail to load.
export async function saveVisual(
  projectId: string,
  input: {
    name: string; datasetId: string; chartType: string; encoding: unknown;
    overrides?: unknown; filters?: unknown; favorite?: unknown; analytics?: unknown;
  },
): Promise<Visual | null> {
  if (!isValidId(projectId) || !isValidId(input.datasetId)) return null;
  const parent = await projects.getProject(projectId);
  if (!parent) return null;
  // Existence check only — nothing below reads a row, so don't hydrate a table
  // to answer "does this dataset exist".
  const ds = await datasets.getDatasetMeta(projectId, input.datasetId);
  if (!ds) return null;

  const id = randomUUID();
  const now = new Date().toISOString();
  const visual: Visual = {
    id,
    projectId,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled visual',
    datasetId: input.datasetId,
    chartType: sanitizeChartType(input.chartType),
    encoding: sanitizeEncoding(input.encoding),
    overrides: sanitizeOverrides(input.overrides, {
      chartType: sanitizeChartType(input.chartType), encoding: sanitizeEncoding(input.encoding),
    }),
    filters: sanitizeFilters(input.filters),
    favorite: input.favorite === true,
    ...withAnalytics(input.analytics),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2,
  };
  await fs.promises.mkdir(visualsDir(projectId), { recursive: true });
  await writeJsonAtomic(visualFilePath(projectId, id), visual);
  return visual;
}

// Patch an existing visual's name / chartType / encoding in place, bumping
// updatedAt. datasetId is immutable (a re-target is a new visual). Returns null if
// either id is invalid or the visual does not exist.
export async function updateVisual(
  projectId: string,
  id: string,
  patch: {
    name?: string; chartType?: string; encoding?: unknown; overrides?: unknown;
    filters?: unknown; favorite?: unknown; analytics?: unknown;
  },
): Promise<Visual | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getVisual(projectId, id);
  if (!existing) return null;

  const chartType = patch.chartType !== undefined ? sanitizeChartType(patch.chartType) : existing.chartType;
  const encoding = patch.encoding !== undefined ? sanitizeEncoding(patch.encoding) : existing.encoding;
  const updated: Visual = {
    ...existing,
    name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : existing.name,
    chartType,
    encoding,
    // Re-clamped even when only the type or encoding changed: a dual axis that
    // was valid on a combo is not valid on the pie it just became.
    overrides: sanitizeOverrides(patch.overrides !== undefined ? patch.overrides : existing.overrides, { chartType, encoding }),
    filters: patch.filters !== undefined ? sanitizeFilters(patch.filters) : existing.filters,
    favorite: patch.favorite !== undefined ? patch.favorite === true : existing.favorite,
    updatedAt: new Date().toISOString(),
  };
  if (patch.analytics !== undefined) {
    delete updated.analytics;
    Object.assign(updated, withAnalytics(patch.analytics));
  }
  await fs.promises.mkdir(visualsDir(projectId), { recursive: true });
  await writeJsonAtomic(visualFilePath(projectId, id), updated);
  return updated;
}

// Duplicate an existing visual into a NEW file with a fresh UUID, copying
// dataset/chartType/encoding/overrides/filters verbatim and appending " (copy)" to
// the name. Returns null if either id is invalid or the source is missing. Reuses
// the same dual-UUID guard, atomic write, and visualsDir as saveVisual; the parent
// project + referenced dataset are already known-valid (the source loaded), so no
// re-check is needed beyond the id guards.
export async function duplicateVisual(projectId: string, id: string): Promise<Visual | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const source = await getVisual(projectId, id);
  if (!source) return null;

  const newId = randomUUID();
  const now = new Date().toISOString();
  const copy: Visual = {
    id: newId,
    projectId,
    name: `${source.name} (copy)`,
    datasetId: source.datasetId,
    chartType: source.chartType,
    encoding: source.encoding,
    overrides: source.overrides,
    filters: source.filters,
    // A copy starts unpinned: duplicating a favourite to tweak it should not
    // put two near-identical cards at the top of the gallery.
    favorite: false,
    ...withAnalytics(source.analytics),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2,
  };
  await fs.promises.mkdir(visualsDir(projectId), { recursive: true });
  await writeJsonAtomic(visualFilePath(projectId, newId), copy);
  return copy;
}

// Delete a visual file. Returns true on success (force → missing is success).
export async function deleteVisual(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await recordFs.rm(visualFilePath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
