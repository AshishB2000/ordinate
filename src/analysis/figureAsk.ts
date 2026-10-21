// Which chart ids carry figures the SERVER computes (./chartShapes.ts), and what
// a chart request must say to get them — PURE, and no arithmetic: the web
// imports this file to build its requests, so the list is one list.
//
// `visual:data` answers `{labels, series}` whatever the chart is drawn as. A
// waterfall, a Pareto, a 100%-stacked chart, a histogram, a funnel, a bullet
// and a calendar also draw figures derived from those — running totals, a
// sorted order and cumulative share, shares, bins, percentages, one value per
// day — and those must come from the server too. So a request for one of
// these types names the type, and the two overrides that change a figure.

/** The chart ids whose drawn figures the server computes. */
export const FIGURE_TYPES: ReadonlySet<string> = new Set([
  'waterfall', 'pareto', 'pct_stacked_column', 'pct_stacked_bar', 'histogram', 'funnel', 'event_funnel', 'bullet', 'calendar',
]);

/** What a chart reply needs to carry its figures: the type, and the overrides that change one. */
export interface FigureAsk {
  chartType: string;
  /** A waterfall's categories drawn as totals (VizOverrides.waterfallTotals). */
  waterfallTotals?: string[];
  /** A bullet's fixed target, when there is no target measure (VizOverrides.bulletTarget). */
  bulletTarget?: number;
}

/**
 * The ask for a chart drawn as `chartType` under `overrides` (a visual's
 * overrides, or a request's own fields — the names are the same), or null for
 * a type with no figures. Untrusted input: clamped as sanitizeOverrides clamps it.
 */
export function figureAsk(chartType: unknown, overrides?: unknown): FigureAsk | null {
  if (typeof chartType !== 'string' || !FIGURE_TYPES.has(chartType)) return null;
  const o = overrides && typeof overrides === 'object' ? (overrides as Record<string, unknown>) : {};
  const ask: FigureAsk = { chartType };
  if (chartType === 'waterfall' && Array.isArray(o.waterfallTotals)) {
    ask.waterfallTotals = o.waterfallTotals.filter((s): s is string => typeof s === 'string' && s.length <= 200).slice(0, 200);
  }
  if (chartType === 'bullet' && typeof o.bulletTarget === 'number' && Number.isFinite(o.bulletTarget)) ask.bulletTarget = o.bulletTarget;
  return ask;
}

/**
 * The ask as a key: which figures a reply answers. A held reply (the last answer kept on screen while the
 * next computes) answers an older ask when the type or a figure override changed; the web shows it as
 * loading, never draws it as the answer (its figures belong to the other ask, or are missing).
 */
export function figureAskKey(chartType: unknown, overrides?: unknown): string {
  return JSON.stringify(figureAsk(chartType, overrides));
}
