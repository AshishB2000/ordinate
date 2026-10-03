// The shapes the chart engine passes around. Ported from renderer/hub's
// chartRender.ts (ChartSeriesShape, ChartDataShape, ChartCtx) and calcMenu.ts
// (TcCalc); the pipeline they describe is build.ts.

import type { ChartTypeSpec } from './typeSpec';

/**
 * Chart.js scriptable-option contexts, plugin hook arguments, legend and
 * tooltip items, element/meta objects: what Chart.js hands back across a
 * callback boundary. Each family reads a different shape off them at runtime,
 * so naming the boundary says more than 60 per-site casts would.
 */
export type Cx = any; // the Chart.js callback boundary (above)

/** A stored table calculation, as `analysis/tableCalc.TableCalc`. */
export interface TcCalc {
  kind: string;
  along: 'across' | 'down' | { dimension: string };
  restart?: string;
  window?: number;
}

/**
 * One series of the `{labels, series}` reply `visual:data` produces.
 * `values` is `Cx[]` on purpose: a cell is a number, a text value or null, and
 * Ordinate's own ColumnType decides how it may be read — every consumer
 * narrows with `typeof v === 'number'` before doing arithmetic.
 */
export interface ChartSeriesShape {
  name?: string;
  values: Cx[];
  /** 'overlay' = a prior period drawn muted beside its own series (visualsOverlay.ts). */
  role?: string;
  /** A table calculation: `values` calculated, `raw` the figures (analysis/tableCalc.ts). */
  raw?: Cx[];
  calc?: TcCalc;
}

export interface ChartDataShape {
  labels?: Cx[];
  series?: ChartSeriesShape[];
  /** Analytics-pane overlays, resolved by the server (analysis/analytics.ts). */
  analytics?: Cx[];
  /** Project events placed on the label axis by the server (analysis/events.ts). */
  events?: Cx[];
}

/**
 * The per-chart customisation bag a saved visual, a dashboard tile and the
 * Customize menu all write (VizOverrides, plus render-only keys such as
 * noAnimate and devicePixelRatio). Open on purpose: it grows per family and
 * every read is guarded.
 */
export type Overrides = Record<string, Cx>;

/**
 * Everything one chart's family blocks need: the resolved type spec plus the
 * data, the overrides, the formatter and the theme tokens read off THIS
 * canvas. Flat on purpose — each family destructures what it uses.
 */
export interface ChartCtx extends ChartTypeSpec {
  canvas: HTMLCanvasElement;
  labels: Cx[];
  series: ChartSeriesShape[];
  overrides: Overrides;
  fmt: (v: Cx) => string;
  valueMode: string;
  lineTension: number;
  palette: string[];
  textColor: string;
  gridColor: string;
  surfColor: string;
  titleColor: string;
  fontFamily: string;
  showLegend: boolean;
  showGridlines: boolean;
  tickFont: { family: string; size: number };
}
