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
import { app } from 'electron';
import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import { sanitizeSteps } from '../data/transforms';
import type { FilterStep } from '../data/transforms';
import { isDateGrain, sanitizeBins } from './categoryKey';
import type { DateGrain } from './categoryKey';
import { sanitizePivot } from './pivotData';
import type { PivotEncoding } from './pivotData';

export type VizAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none';

export interface VizMeasure {
  column: string; // dataset column name
  aggregation: VizAggregation;
}

export interface VizGeo {
  level: 'country' | 'us_state' | 'us_county' | 'us_city' | 'us_zip';
}

export interface VizEncoding {
  category: string; // the dimension column (chart labels / geo region name / x)
  values: VizMeasure[]; // one or more measures → one or more series
  series?: string; // OPTIONAL split/pivot column (category × series → grid of series)
  geo?: VizGeo; // present only for map chart types
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
}

// Whitelisted chart-styling overrides — the SAME object shape the capture-flow ⋯
// Customize menu produces and chartRender.buildChart consumes. Stored verbatim on a
// Visual so a saved chart re-renders with its styling. All fields OPTIONAL: an
// absent field means "use the buildChart default" (identical to Week 7).
export interface VizOverrides {
  title?: string | null;
  color?: string | null;
  legendPosition?: 'bottom' | 'top' | 'left' | 'right';
  showLegend?: boolean;
  showGridlines?: boolean;
  xAxisLabel?: string | null;
  yAxisLabel?: string | null;
  yZero?: boolean;
  sort?: 'none' | 'asc' | 'desc';
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
   * crossFilter: clicking a bar/slice on this visual applies the clicked
   * category value as a dashboard-wide FilterStep. Default OFF: a click that
   * silently refilters every other card is a surprise, and the sheet has an
   * explicit filter bar for the deliberate case.
   * showTooltips: default ON when absent, matching every chart drawn before this
   * key existed.
   */
  crossFilter?: boolean;
  showTooltips?: boolean;
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

let projectsBase: string | null = null;

function getProjectsBase(): string {
  if (!projectsBase) projectsBase = path.join(app.getPath('userData'), 'projects');
  return projectsBase;
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
const GEO_LEVELS: ReadonlySet<string> = new Set(['country', 'us_state', 'us_county', 'us_city', 'us_zip']);

// Atomic JSON write: temp sibling then rename (atomic on same fs). Copied from
// datasets.ts.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file); // atomic on same fs
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
    values.push({ column, aggregation });
  }

  const enc: VizEncoding = { category, values };
  if (typeof o.series === 'string' && o.series) enc.series = o.series;
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
  const pivot = sanitizePivot(o.pivot);
  if (pivot) enc.pivot = pivot;
  if (o.geo && typeof o.geo === 'object') {
    const level = (o.geo as Record<string, unknown>).level;
    if (typeof level === 'string' && GEO_LEVELS.has(level)) enc.geo = { level: level as VizGeo['level'] };
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
 * `renderer/hub/renderResult.ts`, a classic global-scope <script> that cannot be
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
];

// Allowed enum sets for the clamped override fields.
const LEGEND_POSITIONS: ReadonlySet<string> = new Set(['bottom', 'top', 'left', 'right']);
const SORT_MODES: ReadonlySet<string> = new Set(['none', 'asc', 'desc']);
const VALUE_MODES: ReadonlySet<string> = new Set(['off', 'all', 'maxmin', 'max', 'min']);
const NUMBER_FORMATS: ReadonlySet<string> = new Set(['auto', 'plain', 'thousands', 'compact', 'percent', 'currency']);

// Whitelist untrusted (renderer/stored) chart overrides into a well-formed
// VizOverrides: keep ONLY known keys, clamp each enum to its allowed set, coerce
// booleans/numbers, drop everything else. Mirrors sanitizeEncoding's "never throw,
// whitelist" discipline. An empty/invalid input → {} (buildChart defaults). Only
// keys actually present are emitted, so overrides stay minimal.
export function sanitizeOverrides(raw: unknown): VizOverrides {
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

  // Numeric fields — finite numbers only.
  if (Array.isArray(o.hiddenSeries)) {
    out.hiddenSeries = o.hiddenSeries.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  }
  if (typeof o.periodIdx === 'number' && Number.isFinite(o.periodIdx)) out.periodIdx = o.periodIdx;

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
  return {
    id: String(data.id),
    projectId,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled visual',
    datasetId: String(data.datasetId),
    chartType: sanitizeChartType(data.chartType),
    encoding: sanitizeEncoding(data.encoding),
    // v1 files carry no overrides/filters → {} / [] (behaves exactly as Week 7).
    overrides: sanitizeOverrides(data.overrides),
    filters: sanitizeFilters(data.filters),
    // Absent (every file written before favourites existed) means false.
    favorite: data.favorite === true,
    createdAt,
    updatedAt: data.updatedAt || createdAt,
    schemaVersion: 2,
  };
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
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return []; // no visuals dir yet
  }

  const out: VisualSummary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const id = dirent.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue; // skip stray/tmp files
    try {
      const raw = await fs.promises.readFile(visualFilePath(projectId, id), 'utf8');
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
    const raw = await fs.promises.readFile(visualFilePath(projectId, id), 'utf8');
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
    overrides?: unknown; filters?: unknown; favorite?: unknown;
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
    overrides: sanitizeOverrides(input.overrides),
    filters: sanitizeFilters(input.filters),
    favorite: input.favorite === true,
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
    filters?: unknown; favorite?: unknown;
  },
): Promise<Visual | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getVisual(projectId, id);
  if (!existing) return null;

  const updated: Visual = {
    ...existing,
    name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : existing.name,
    chartType: patch.chartType !== undefined ? sanitizeChartType(patch.chartType) : existing.chartType,
    encoding: patch.encoding !== undefined ? sanitizeEncoding(patch.encoding) : existing.encoding,
    overrides: patch.overrides !== undefined ? sanitizeOverrides(patch.overrides) : existing.overrides,
    filters: patch.filters !== undefined ? sanitizeFilters(patch.filters) : existing.filters,
    favorite: patch.favorite !== undefined ? patch.favorite === true : existing.favorite,
    updatedAt: new Date().toISOString(),
  };
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
    await fs.promises.rm(visualFilePath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
