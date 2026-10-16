// REBUILD FROM A SCREENSHOT — a reading, matched to one dataset, as a PLAN.
//
// Pure. The model's reading (src/ai/rebuildRead.ts) and the user's corrections
// on the check screen go in; out come the tiles as the screen shows them —
// each field mapped to a column with a confidence, or the reason it is not —
// and the plan envelope `validatePlan` accepts, so creation goes through the
// one door every plan takes (`analysis:buildPlan`). The plan carries no x, y,
// width or height: the screenshot's boxes are grouped into bands and each band
// written as plan ROWS (./planRows.ts); ./planLayout.ts places them.
//
// Each tile is also put through `validatePlan` ALONE, so a tile the validator
// would drop is shown with the validator's own sentence and left out — never
// built broken, never coerced into something else.

import type { ParsedColumn } from '../data/parse';
import type { Box, Reading, ReadTile } from '../ai/rebuildRead';
import { validatePlan, type PlanContext, type PlanDataset } from './analysisPlan';
import { CHART_TYPE_IDS } from './analysisPlan';
import { chartTypeOf, fits, matchField, splitAggregation, tokens, type Confidence, type FieldRole, type MatchAgg } from './rebuildMatch';
import * as m from './rebuildMessages';

export type RebuiltKind = 'kpi' | 'chart' | 'filter' | 'text';

export interface TileField {
  /** Stable per tile: `category`, `split`, `filter`, `value0`… — what an override names. */
  key: string;
  role: FieldRole;
  /** The field as the screenshot names it; '' when it names none. */
  said: string;
  column: string | null;
  aggregation?: MatchAgg;
  /** `picked` = the user chose it. Null with no column. */
  confidence: Confidence | 'picked' | null;
  /** Why there is no column, when there is none. */
  note?: string;
}

export interface RebuiltTile {
  id: number;
  kind: RebuiltKind;
  /** The chart as the screenshot was read ('' for a KPI, a filter or a note). */
  said: string;
  /** An Ordinate chart id; null for a KPI, a filter, a note — or a chart Ordinate does not draw. */
  chartType: string | null;
  title: string;
  box: Box | null;
  /** A filter that picks several values at once (the screenshot's multi-select), rather than one. */
  multi?: boolean;
  fields: TileField[];
  status: 'ready' | 'unmapped' | 'dropped';
  reason?: string;
}

/** The user's corrections to one tile, from the check screen. Re-checked here, every one. */
export interface TileOverride {
  id: number;
  /** `false` keeps a tile the app would leave out on its own (a heading that repeats the dashboard's title). */
  dropped?: boolean;
  /** An Ordinate chart id, or 'kpi'. */
  chartType?: string;
  title?: string;
  /** By TileField.key. A null column leaves a split out; on any other field it keeps matching by name, with the aggregation given. */
  fields?: Record<string, { column: string | null; aggregation?: MatchAgg }>;
}

const AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const AGG_WORD: Record<MatchAgg, string> = { sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max' };

/** "Sales by Region" → ["Sales", "Region"]: what a chart's title says when its axes are not readable. */
function byTitle(title: string): [string, string] {
  const at = title.search(/\s(?:by|per|across)\s/i);
  return at > 0 ? [title.slice(0, at).trim(), title.slice(at).replace(/^\s\S+\s/, '').trim()] : [title, ''];
}

/** One field: the user's pick (checked against the declared type) or the best match by name. */
function resolveField(
  key: string, role: FieldRole, said: string, columns: ParsedColumn[], aggregation: MatchAgg | undefined,
  override: { column: string | null; aggregation?: MatchAgg } | undefined,
): TileField {
  const base: TileField = { key, role, said, column: null, confidence: null, ...(aggregation ? { aggregation } : {}) };
  const refuse = (column: string, type: ParsedColumn['type']): TileField => ({
    ...base, note: role === 'date_filter' ? m.needsDate(column, type) : m.needsNumber(AGG_WORD[aggregation ?? 'sum'], column, type),
  });
  // A null column clears a split; anywhere else it means "match by name" (an aggregation changed, nothing picked yet).
  if (override && override.column === null && role === 'split') return base;
  if (override && override.column !== null) {
    const col = columns.find((c) => c.name === override.column);
    if (!col) return { ...base, note: m.noColumnLike(override.column) };
    if (!fits(col.type, role, aggregation)) return refuse(col.name, col.type);
    return { ...base, column: col.name, confidence: 'picked' };
  }
  if (!said) return base;
  const hit = matchField(said, columns, role, aggregation);
  if (hit.column) return { ...base, column: hit.column, confidence: hit.confidence };
  if ('refusedType' in hit && hit.refusedType) return refuse(hit.refusedType.column, hit.refusedType.type);
  return { ...base, note: m.noColumnLike(said) };
}

function kindOf(t: ReadTile, chartType: string | null): RebuiltKind {
  if (chartType === 'kpi') return 'kpi';
  if (t.kind === 'filter' || t.kind === 'text') return t.kind;
  if (t.kind === 'kpi' && !chartType) return 'kpi';
  return 'chart';
}

const same = (a: string, b: string): boolean => tokens(a).join(' ') === tokens(b).join(' ');

/** A tile's fields and status against one dataset, with the user's corrections applied. `dashboardTitle` is the reading's. */
export function rebuildTile(t: ReadTile, columns: ParsedColumn[], o: TileOverride | undefined, dashboardTitle = ''): RebuiltTile {
  const picked = o?.chartType && (o.chartType === 'kpi' || CHART_TYPE_IDS.has(o.chartType)) ? o.chartType : '';
  const read = t.kind === 'kpi' ? 'kpi' : chartTypeOf(t.chart || (t.kind === 'table' ? 'table' : ''));
  const typed = t.kind === 'filter' || t.kind === 'text' ? null : picked || read;
  const kind = kindOf(t, typed);
  const title = (o?.title ?? '').trim().slice(0, 80) || t.title;
  const said = t.kind === 'chart' || t.kind === 'table' ? t.chart || (t.kind === 'table' ? 'table' : '') : '';
  const tile: RebuiltTile = { id: t.id, kind, said, chartType: kind === 'chart' ? typed : null, title, box: t.box, fields: [], status: 'ready' };
  const over = o?.fields ?? {};
  const value = (key: string, saidField: string, saidAgg: MatchAgg | ''): TileField => {
    const split = splitAggregation(saidField);
    const ov = over[key];
    const aggregation = (ov?.aggregation && AGGS.has(ov.aggregation) ? ov.aggregation : saidAgg || split.aggregation || 'sum') as MatchAgg;
    return resolveField(key, 'value', split.field, columns, aggregation, ov);
  };
  const [titleMeasure, titleDim] = byTitle(t.title);

  if (kind === 'kpi') {
    const first = t.measures[0];
    tile.fields = [value('value0', first?.field || t.title, first?.aggregation || '')];
  } else if (kind === 'chart') {
    tile.fields.push(resolveField('category', 'category', t.dimension || titleDim, columns, undefined, over.category));
    const measures = t.measures.length ? t.measures : [{ field: titleMeasure, aggregation: '' as const }];
    measures.forEach((mm, i) => tile.fields.push(value(`value${i}`, mm.field, mm.aggregation)));
    if (t.series || over.split) tile.fields.push(resolveField('split', 'split', t.series, columns, undefined, over.split));
  } else if (kind === 'filter') {
    const said2 = t.dimension || t.title;
    const role: FieldRole = t.filterKind === 'date_range' ? 'date_filter' : 'filter';
    tile.fields = [resolveField('filter', role, said2, columns, undefined, over.filter)];
    if (t.filterKind === 'multi') tile.multi = true;
  }

  if (o?.dropped) tile.status = 'dropped';
  else if (o?.dropped === undefined && kind === 'text' && title && dashboardTitle && same(title, dashboardTitle)) {
    // The screenshot's own heading: it names the dashboard, so it is not also a note — unless the user restores it.
    Object.assign(tile, { status: 'dropped', reason: m.namesTheDashboard() });
  }
  else if (kind === 'text' && !title) Object.assign(tile, { status: 'unmapped', reason: m.noHeading() });
  else if (kind === 'chart' && !tile.chartType) Object.assign(tile, { status: 'unmapped', reason: tile.said ? m.unknownChart(tile.said) : m.noChartType() });
  else {
    const missing = tile.fields.find((f) => f.key !== 'split' && !f.column);
    if (missing) {
      const pick = missing.role === 'category' ? m.pickCategory() : missing.role === 'value' ? m.pickValue() : m.pickFilter();
      Object.assign(tile, { status: 'unmapped', reason: missing.note || pick });
    }
  }
  const split = tile.fields.find((f) => f.key === 'split');
  if (split && !split.column && split.said && !over.split) split.note = m.splitLeftOut(split.said);
  return tile;
}

const col = (t: RebuiltTile, key: string): TileField | undefined => t.fields.find((f) => f.key === key && f.column);

/** The raw plan item a READY tile becomes — the shapes `validatePlan` reads. */
export function planItem(t: RebuiltTile, ds: PlanDataset): Record<string, unknown> | null {
  if (t.status !== 'ready') return null;
  if (t.kind === 'text') return { heading: t.title };
  if (t.kind === 'kpi') {
    const v = col(t, 'value0');
    return v ? { datasetId: ds.id, column: v.column, aggregation: v.aggregation, ...(t.title ? { label: t.title } : {}) } : null;
  }
  if (t.kind === 'filter') {
    const f = col(t, 'filter');
    if (!f) return null;
    const type = ds.columns.find((c) => c.name === f.column)?.type;
    return { datasetId: ds.id, kind: type === 'date' ? 'date_range' : t.multi ? 'multi' : 'dropdown', column: f.column, ...(t.title ? { label: t.title } : {}) };
  }
  const values = t.fields.filter((f) => f.role === 'value' && f.column).map((f) => ({ column: f.column, aggregation: f.aggregation }));
  const split = col(t, 'split');
  return {
    datasetId: ds.id,
    name: t.title || undefined,
    chartType: t.chartType,
    encoding: { category: col(t, 'category')?.column, values, ...(split ? { series: split.column } : {}) },
    filters: [],
  };
}

/** Where a tile goes in a sheet: a KPI, a chart, a note, or a filter chip. */
const SLOT: Record<RebuiltKind, 'metrics' | 'visuals' | 'texts' | 'controls'> = { kpi: 'metrics', chart: 'visuals', text: 'texts', filter: 'controls' };

/**
 * A ready tile through `validatePlan` on its own. A drop becomes the tile's
 * reason, in the validator's words without its "Sheet … visual 1 dropped:"
 * preamble — the card already says which tile.
 */
export function checkTile(t: RebuiltTile, ds: PlanDataset, ctx: PlanContext): RebuiltTile {
  const item = planItem(t, ds);
  if (!item) return t;
  const { dropped } = validatePlan({ sheets: [{ name: 'check', [SLOT[t.kind]]: [item] }] }, ctx);
  if (!dropped.length) return t;
  const msg = dropped[0].message;
  const cut = msg.search(/dropped(?::| —) /);
  return { ...t, status: 'unmapped', reason: cut >= 0 ? msg.slice(cut).replace(/^dropped(?::| —) /, '').replace(/^./, (c) => c.toUpperCase()) : msg };
}

/** Top-to-bottom bands: a tile joins the band its middle sits inside. Tiles with no box follow, one band each. */
export function bands<T extends { box: Box | null }>(tiles: T[]): T[][] {
  const boxed = tiles.filter((t) => t.box).sort((a, b) => a.box!.y - b.box!.y || a.box!.x - b.box!.x);
  const out: { top: number; bottom: number; tiles: T[] }[] = [];
  for (const t of boxed) {
    const b = t.box!;
    const mid = b.y + b.h / 2;
    const band = out.find((x) => mid > x.top && mid < x.bottom);
    if (band) {
      band.tiles.push(t);
      band.bottom = Math.max(band.bottom, b.y + b.h);
    } else out.push({ top: b.y, bottom: b.y + b.h, tiles: [t] });
  }
  return [...out.map((x) => x.tiles.sort((a, b) => a.box!.x - b.box!.x)), ...tiles.filter((t) => !t.box).map((t) => [t])];
}

/** One band as plan rows: a chart with KPIs beside it is a spotlight, a chart with a note an annotated row. */
function bandRows(items: { kind: RebuiltKind; item: Record<string, unknown> }[]): Record<string, unknown>[] {
  const of = (k: RebuiltKind) => items.filter((x) => x.kind === k).map((x) => x.item);
  const [metrics, visuals, texts] = [of('kpi'), of('chart'), of('text')];
  if (visuals.length === 1 && metrics.length >= 2) return [{ type: 'spotlight', visual: visuals[0], metrics }, ...texts.map((text) => ({ type: 'note', text }))];
  if (visuals.length === 1 && texts.length && !metrics.length) {
    return [{ type: 'annotated', visual: visuals[0], text: texts[0] }, ...texts.slice(1).map((text) => ({ type: 'note', text }))];
  }
  const rows: Record<string, unknown>[] = [];
  if (metrics.length) rows.push({ type: 'kpis', metrics });
  for (let i = 0; i < visuals.length; i += 2) rows.push({ type: 'charts', visuals: visuals.slice(i, i + 2) });
  for (const text of texts) rows.push({ type: 'note', text });
  return rows;
}

const TOOL_NAME: Record<string, string> = { tableau: 'Tableau', power_bi: 'Power BI', looker: 'Looker', metabase: 'Metabase' };

/**
 * Tile ids by kind in the order the plan places them. Each kind keeps its order
 * through rows (planRows.flattenRows), so the n-th KPI of the built sheet — and
 * of its preview and its layout — is `order.kpi[n]`.
 */
export type PlaceOrder = Record<'kpi' | 'chart' | 'text', number[]>;

/** Every ready tile, arranged as the screenshot has them, as the plan envelope `validatePlan` accepts. */
export function toPlan(reading: Reading, tiles: RebuiltTile[], ds: PlanDataset): { plan: Record<string, unknown>; order: PlaceOrder } {
  const placed = tiles.flatMap((t) => {
    const item = t.kind === 'filter' ? null : planItem(t, ds);
    return item ? [{ id: t.id, kind: t.kind, box: t.box, item }] : [];
  });
  const banded = bands(placed);
  const ids = (k: RebuiltKind) => banded.flat().filter((x) => x.kind === k).map((x) => x.id);
  const controls = tiles.filter((t) => t.kind === 'filter').flatMap((t) => planItem(t, ds) ?? []);
  const tool = TOOL_NAME[reading.tool];
  return {
    plan: {
      name: reading.title || m.defaultName(),
      rationale: tool ? m.rationale(tool) : m.rationaleAnyTool(),
      calculatedFields: [],
      sheets: [{ name: m.sheetName(), rows: banded.flatMap(bandRows), controls }],
    },
    order: { kpi: ids('kpi'), chart: ids('chart'), text: ids('text') },
  };
}

/** The whole check: every tile matched, corrected and checked, and the plan of the ready ones. */
export function rebuild(reading: Reading, ds: PlanDataset, ctx: PlanContext, overrides: TileOverride[] = []): { tiles: RebuiltTile[]; plan: Record<string, unknown>; order: PlaceOrder } {
  const byId = new Map(overrides.map((o) => [o.id, o]));
  const tiles = reading.tiles.map((t) => checkTile(rebuildTile(t, ds.columns, byId.get(t.id), reading.title), ds, ctx));
  return { tiles, ...toPlan(reading, tiles, ds) };
}
