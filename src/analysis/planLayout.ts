// Plan LAYOUT — where every tile of a plan sheet goes.
//
// Split out of planBuild.ts so the preview (planPreview.ts) and the build draw
// from ONE arrangement: a sketch of the page that the build then contradicted
// would break "what you previewed is what you get" as surely as a wrong figure.
//
// GEOMETRY IS THE APP'S, ENTIRELY — and it stays that way by adding no geometry
// vocabulary at all. A plan cannot name an x, a y, a width or a height, so there
// is nothing for a model to get wrong or to abuse. What a plan MAY say is which
// ROW a tile sits in (planRows.ts): a closed, app-owned set of arrangements,
// unlike raw coordinates. Every size below comes from the card KIND and the row
// type, and every position from counting.
//
// Two paths, and the first must never move:
//
//   - a sheet with NO rows is packed exactly as it was before rows existed —
//     KPI strip, charts (one full width, or two-up), notes. The sample
//     dashboard, the starters, the templates and planExec.runDashboard all write
//     flat sheets, and scripts/test-planRows.ts holds this path to the old
//     packer cell for cell;
//   - a sheet WITH rows is stacked row by row, each on a fresh grid row at x=0.
//
// No chart is ever narrower than half the grid in either: the report export
// gives a page to every chart at least that wide (reportSpec.isBigChart).

import * as dashboards from './dashboards';
import type { PlanSheet } from './analysisPlan';
import { flattenRows, shapeRows } from './planRows';
import type { DashboardShape } from './dashboardShapes';

/** The tile sizes a dashboard shape asks for (./dashboardShapes `kpi`, `chartH`); absent, the app's own. */
export type ShapeSizes = Pick<DashboardShape, 'kpi' | 'chartH'>;

const KPI_W = 3;
const KPI_H = 2;
const CHART_H = 6;
const TEXT_H = 2;
/** The chart of a `spotlight` or `annotated` row. The rail beside it gets the
 *  rest of the grid, so the row is always flush. */
const WIDE_W = 8;

/** The sizes one sheet is laid out with: a shape's, else the constants above. */
function sizes(shape?: ShapeSizes) {
  const kw = shape?.kpi?.w ?? KPI_W;
  return { kw, kh: shape?.kpi?.h ?? KPI_H, perLine: dashboards.GRID_COLS / kw, chartH: shape?.chartH ?? CHART_H };
}

/** One layout per tile, lined up with the sheet's own flat arrays. */
export interface SheetLayout {
  metrics: dashboards.CardLayout[];
  visuals: dashboards.CardLayout[];
  texts: dashboards.CardLayout[];
}

/** A placed tile and what it is — a sheet as a sketch rather than as records. */
export interface PlacedTile extends dashboards.CardLayout {
  kind: 'metric' | 'visual' | 'text';
}

/** What `arrangeSheet` reads of a sheet: how many of each, and the rows. */
type Arrangeable = Pick<PlanSheet, 'metrics' | 'visuals' | 'texts' | 'rows'>;

/** Flow packer: left→right, wrapping at GRID_COLS. */
function packer() {
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  return {
    place(w: number, h: number) {
      if (cx + w > dashboards.GRID_COLS) { cx = 0; cy += rowH; rowH = 0; }
      const layout = { x: cx, y: cy, w, h };
      cx += w;
      if (h > rowH) rowH = h;
      return layout;
    },
    /** Break to a fresh row. A KPI strip and the charts beneath it are separate
     *  BANDS, not one flow: without this, two 3-wide KPIs leave exactly enough
     *  room for a 6-wide chart beside them and the strip stops reading as a
     *  strip. */
    newRow() { if (cx > 0) { cx = 0; cy += rowH; rowH = 0; } },
  };
}

/** The flat packing: every sheet's layout before rows existed, unchanged. */
function arrangeFlat(sheet: Arrangeable, shape?: ShapeSizes): SheetLayout {
  // PER SHEET. It was once created for the whole plan, so sheet 2's first card
  // inherited sheet 1's cursor and started N rows down its own empty grid.
  const pk = packer();
  const { kw, kh, chartH } = sizes(shape);
  const metrics = sheet.metrics.map(() => pk.place(kw, kh));
  pk.newRow();
  // One chart fills the sheet; two or more share the row. Counted here rather
  // than declared in the plan — a flat sheet says nothing about arrangement.
  const chartW = sheet.visuals.length > 1 ? dashboards.GRID_COLS / 2 : dashboards.GRID_COLS;
  const visuals = sheet.visuals.map(() => pk.place(chartW, chartH));
  pk.newRow();
  const texts = sheet.texts.map(() => pk.place(dashboards.GRID_COLS, TEXT_H));
  return { metrics, visuals, texts };
}

/**
 * Every tile of a sheet, placed. Pure and total: it never throws, and it never
 * puts two tiles on the same cell.
 *
 * The rows are shaped again (planRows.shapeRows) rather than trusted. A plan
 * that came through validatePlan is already in shape and comes out unchanged;
 * one built in code may not be, and the arithmetic below divides by a row's
 * item count. Rows that do not account for exactly the sheet's tiles are not an
 * arrangement of that sheet, so they are ignored whole — the flat arrays are
 * what gets built, and a layout for some other set of tiles would be handed to
 * the wrong cards.
 */
export function arrangeSheet(sheet: Arrangeable, shape?: ShapeSizes): SheetLayout {
  const rows = shapeRows(sheet.rows);
  const flat = flattenRows(rows);
  const accounted = flat.metrics.length === sheet.metrics.length
    && flat.visuals.length === sheet.visuals.length
    && flat.texts.length === sheet.texts.length;
  if (!rows.length || !accounted) return arrangeFlat(sheet, shape);
  const { kw, kh, perLine, chartH } = sizes(shape);

  const cols = dashboards.GRID_COLS;
  const out: SheetLayout = { metrics: [], visuals: [], texts: [] };
  let y = 0; // the top of the row being placed — every row starts at x=0 on it
  for (const row of rows) {
    if (row.type === 'kpis') {
      row.metrics.forEach((_m, i) => out.metrics.push({
        x: (i % perLine) * kw, y: y + Math.floor(i / perLine) * kh, w: kw, h: kh,
      }));
      y += Math.ceil(row.metrics.length / perLine) * kh;
    } else if (row.type === 'charts') {
      const w = cols / row.visuals.length; // one or two — shapeRows guarantees it
      row.visuals.forEach((_v, i) => out.visuals.push({ x: i * w, y, w, h: chartH }));
      y += chartH;
    } else if (row.type === 'spotlight') {
      // Two KPIs split the chart's height and three fill it. A fourth makes the
      // ROW taller, never the tiles shorter: KPI_H is the smallest a KPI is drawn.
      const n = row.metrics.length; // two to four — shapeRows guarantees it
      const h = n === 2 ? CHART_H / 2 : KPI_H;
      out.visuals.push({ x: 0, y, w: WIDE_W, h: n * h });
      row.metrics.forEach((_m, i) => out.metrics.push({ x: WIDE_W, y: y + i * h, w: cols - WIDE_W, h }));
      y += n * h;
    } else if (row.type === 'annotated') {
      out.visuals.push({ x: 0, y, w: WIDE_W, h: chartH });
      out.texts.push({ x: WIDE_W, y, w: cols - WIDE_W, h: chartH });
      y += chartH;
    } else {
      out.texts.push({ x: 0, y, w: cols, h: TEXT_H });
      y += TEXT_H;
    }
  }
  return out;
}

/**
 * A layout as a reader meets it: every tile, top to bottom and then left to
 * right. Within one kind that is the flat array's own order, in both paths —
 * so the n-th `visual` here is the sheet's `visuals[n]`.
 */
export function readingOrder(at: SheetLayout): PlacedTile[] {
  const tiles: PlacedTile[] = [
    ...at.metrics.map((l) => ({ kind: 'metric' as const, ...l })),
    ...at.visuals.map((l) => ({ kind: 'visual' as const, ...l })),
    ...at.texts.map((l) => ({ kind: 'text' as const, ...l })),
  ];
  return tiles.sort((a, b) => a.y - b.y || a.x - b.x);
}
