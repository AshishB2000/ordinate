// REBUILD FROM A SCREENSHOT — the model's half (docs/rebuild-from-screenshot/).
//
// One model call reads a screenshot of another BI tool's dashboard and says
// what is ON it: which tiles, where, of what kind, titled what, over which
// fields. STRUCTURE ONLY. It is not shown the user's dataset — matching a field
// it read to a column is app code (src/analysis/rebuildMatch.ts) — and nothing
// it reads off the image as a figure survives `sanitizeReading`: the reading
// is rebuilt field by field from closed vocabularies, so a `value` the model
// adds is simply never copied, and a figure-shaped token in a title is cut.
//
// The call goes the captures' way: `dispatch` with the image on the first user
// turn (./analyze.ts), the org's own provider through ./providerFetch.ts.

import { dispatch, parseFirstObject, type NeutralMsg, type TypedError } from './analyze';
import * as execConfig from '../app/execConfig';
import { CHART_TYPE_IDS } from '../analysis/analysisPlan';

export const TILE_KINDS = ['kpi', 'chart', 'table', 'filter', 'text'] as const;
export type TileKind = (typeof TILE_KINDS)[number];
export const READ_AGGS = ['sum', 'avg', 'count', 'min', 'max'] as const;
export type ReadAgg = (typeof READ_AGGS)[number];
export const FILTER_KINDS = ['dropdown', 'multi', 'date_range'] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];
export const TOOLS = ['tableau', 'power_bi', 'looker', 'metabase', 'other'] as const;

/** Where a tile sits on the screenshot, in percent of its width and height. Geometry of the image, never data. */
export interface Box { x: number; y: number; w: number; h: number }

export interface ReadTile {
  /** 1-based, in the order read — the number on the outline and on the tile's card. */
  id: number;
  kind: TileKind;
  /** The chart as the model named it, lower case — mapped to an Ordinate type by rebuildMatch.chartTypeOf. */
  chart: string;
  title: string;
  box: Box | null;
  /** The category / rows / x-axis field, as written on the screenshot. */
  dimension: string;
  measures: { field: string; aggregation: ReadAgg | '' }[];
  /** The legend / colour field. */
  series: string;
  filterKind: FilterKind | '';
}

export interface Reading {
  title: string;
  tool: (typeof TOOLS)[number];
  tiles: ReadTile[];
}

export const MAX_TILES = 24;
const MAX_MEASURES = 4;
const TEXT_MAX = 80;

// Figure-shaped tokens: money, percents, separated thousands, decimals, and
// K/M/B-suffixed counts. A bare integer stays — "2024", "Top 10" are labels.
const FIGURE_RE = new RegExp(
  [
    '[-+]?[$€£¥₹]\\s?\\d[\\d,.]*\\s?(?:[kKmMbB]n?)?\\b',
    '[-+]?\\d[\\d,.]*\\s?%',
    '[-+]?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?',
    '[-+]?\\d+\\.\\d+(?:\\s?[kKmMbB]\\b)?',
    '[-+]?\\d+\\s?[kKmMbB]\\b',
  ].join('|'),
  'g',
);

/** A label with every figure-shaped token cut out, its leftover separators tidied. */
export function stripFigures(s: string): string {
  return s
    .replace(FIGURE_RE, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:|·•–—-]+|[\s:|·•–—-]+$/g, '')
    .trim();
}

function text(v: unknown): string {
  return typeof v === 'string' ? stripFigures(v.replace(/\p{Cc}/gu, ' ')).slice(0, TEXT_MAX) : '';
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | '' {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  return (list as readonly string[]).includes(s) ? (s as T) : '';
}

function pct(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

/** `[x, y, w, h]` or `{x, y, w, h}`, in percent; null unless it is a real box on the image. */
function boxOf(raw: unknown): Box | null {
  const a = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [(raw as any).x, (raw as any).y, (raw as any).w, (raw as any).h] : [];
  const [x, y, w, h] = a.map(pct);
  if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) return null;
  return { x, y, w: Math.min(w, 100 - x), h: Math.min(h, 100 - y) };
}

function measuresOf(raw: unknown): ReadTile['measures'] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ReadTile['measures'] = [];
  for (const m of list) {
    const o: Record<string, unknown> = m && typeof m === 'object' ? (m as Record<string, unknown>) : { field: m };
    const field = text(o.field ?? o.column ?? o.name);
    if (field) out.push({ field, aggregation: oneOf(READ_AGGS, o.aggregation) });
    if (out.length >= MAX_MEASURES) break;
  }
  return out;
}

/**
 * The model's reply, rebuilt from what may be in it. Total: never throws, and
 * returns a reading with no tiles for anything that is not one. Run on the
 * model's reply AND again on every reading a browser sends back, so neither can
 * carry a figure through.
 */
export function sanitizeReading(raw: unknown): Reading {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const tiles: ReadTile[] = [];
  for (const t of Array.isArray(o.tiles) ? o.tiles : []) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    const r = t as Record<string, unknown>;
    const kind = oneOf(TILE_KINDS, r.kind);
    if (!kind) continue;
    const chart = typeof r.chart === 'string' ? r.chart.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().slice(0, 40) : '';
    tiles.push({
      id: tiles.length + 1,
      kind,
      chart,
      title: text(r.title),
      box: boxOf(r.box),
      dimension: text(r.dimension),
      measures: measuresOf(r.measures),
      series: text(r.series),
      filterKind: oneOf(FILTER_KINDS, r.filterKind),
    });
    if (tiles.length >= MAX_TILES) break;
  }
  return { title: text(o.title), tool: oneOf(TOOLS, o.tool) || 'other', tiles };
}

export const REBUILD_SYSTEM_PROMPT =
  'You read a SCREENSHOT OF A BUSINESS-INTELLIGENCE DASHBOARD (Tableau, Power BI, Looker, Metabase or similar) ' +
  'and describe its STRUCTURE as ONLY a single JSON object — no markdown, no code fences, no prose. The app ' +
  'rebuilds the dashboard on the user\'s own data and computes every figure itself, so NEVER output a number, ' +
  'value, total, percentage or axis tick you can see; a figure in your reply is discarded. Shape:\n' +
  '  { "title":"<the dashboard title, or \'\'>", "tool":"' + TOOLS.join('|') + '",\n' +
  '    "tiles":[ { "kind":"' + TILE_KINDS.join('|') + '",\n' +
  '      "title":"<the tile\'s title as written, without any figure>",\n' +
  '      "chart":"<for a chart: one of ' + Array.from(CHART_TYPE_IDS).join(', ') + '>",\n' +
  '      "box":[<left>,<top>,<width>,<height>]   percent of the screenshot, 0-100,\n' +
  '      "dimension":"<the field on the category axis, the rows, or the slices>",\n' +
  '      "measures":[ {"field":"<the measured field as written>","aggregation":"' + READ_AGGS.join('|') + '"} ],\n' +
  '      "series":"<the legend or colour field, or \'\'>",\n' +
  '      "filterKind":"<for a filter: ' + FILTER_KINDS.join('|') + '>" } ] }\n' +
  'A "kpi" is a single big number with a label: give its label as the title and its field as the one measure. ' +
  'A "filter" is a slicer, dropdown or date picker: give the field it filters as the dimension. A "text" is a ' +
  'heading or note: give only its heading as the title. Name fields EXACTLY as the screenshot writes them in ' +
  'titles, axis labels, legends and column headers ("Sales by Region" → measure Sales, dimension Region). ' +
  'List tiles top to bottom, left to right. Return ONLY the JSON object.';

/** The read itself. `not_ready` with no model, as every AI surface says it. */
export async function readDashboardImage(dataUrl: string): Promise<{ ok: true; reading: Reading } | TypedError> {
  if (!(await execConfig.executionReady())) return { ok: false, errorType: 'not_ready', message: '' };
  const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
  const messages: NeutralMsg[] = [{ role: 'user', text: 'Describe this dashboard\'s structure.', image: base64 }];
  const { rawText, error } = await dispatch(REBUILD_SYSTEM_PROMPT, messages);
  if (error) return error;
  const parsed = parseFirstObject(rawText);
  if (!parsed) return { ok: false, errorType: 'bad_reply', message: '' };
  return { ok: true, reading: sanitizeReading(parsed) };
}
