// Mosaic/vgplot rendering — the SECOND chart engine, behind a default-off flag.
// Classic global-scope renderer <script>: no import/export, symbols shared with
// the sibling hub scripts (chartInstances lives in chartRender.js, the seam that
// calls in here is renderVizInArea in renderResult.js). window.vg comes from the
// committed vendor bundle (renderer/hub/vendor/vgplot.js, built by
// scripts/build-vendor.js); window.hub.mosaicView / mosaicQuery are the whole
// database contract (src/ipc/mosaic.ts).
//
// ── WHAT THIS ENGINE IS, AND WHAT IT ISN'T ──────────────────────────────────
// Chart.js is handed an ALREADY-COMPUTED `{labels, series}` grid. Mosaic is not:
// it takes a relation name and issues its OWN SQL against the typed, user-named
// view over the dataset's Parquet (`mosaic:view`). So this path needs dataset
// IDENTITY (projectId + datasetId + encoding), not data — which is exactly the
// parameter `renderVizInArea` grew for it, and exactly why the capture/analysis
// result surface (which has no dataset at all) can never take this path.
//
// ── EVERY MISS FALLS BACK TO CHART.JS ───────────────────────────────────────
// Missing window.vg, a view that won't resolve, an unsupported chart type, an
// encoding this file can't express faithfully, a query that errors mid-flight:
// all of them hand the container back to the Chart.js ladder. That is the same
// safety property the resident-query layer uses (src/residentQuery.ts) and it
// carries the same hazard — a fast path that silently stopped firing is not
// WRONG, just absent — so every outcome is recorded on the container as
// `data-mosaic` and logged at console.debug. NOT console.error: `npm run smoke`
// fails on any renderer console error, and a fallback is a normal outcome, not
// a fault.
//
// ── FIDELITY IS A GATE, NOT A BEST EFFORT ───────────────────────────────────
// A chart type is Mosaic-capable only when vgplot can draw what Ordinate MEANS
// by it. Where the honest translation would differ (a histogram of aggregates
// vs. of raw rows; a filter whose emptiness/collation rules would have to be
// re-derived in renderer-side SQL) this file declines and lets Chart.js draw.
// A slower chart is a nuisance; a different chart is a wrong answer.
//
// ── NOTHING FROM @uwdata/mosaic-inputs. NOT AN OVERSIGHT ────────────────────
// `vg.table()`, `vg.menu()`, `vg.search()`, `vg.slider()` — the input widgets —
// build a `<style>` element at runtime whose rules are genuinely DYNAMIC (a
// per-instance element id, per-column `nth-child` selectors, pixel widths taken
// from the runtime schema). Observable Plot's three static rulesets could be
// lifted into `vendor/plot.css` at build time; these cannot, so each one is a
// `style-src 'self'` violation on EVERY update, and `npm run smoke` fails on any
// renderer console error. Ordinate's `table` chart type therefore stays on
// `buildDataTable` (it is in MOSAIC_FALLBACK_TYPES below), and only MARKS are
// used here — never an input, and not the legend components either. The
// invariant this file is verified against: a Mosaic render adds zero `<style>`
// elements, fires zero `securitypolicyviolation` events and logs nothing.

// ── The flag ────────────────────────────────────────────────────────────────
// Read at CALL time, never cached at load, so toggling it in devtools takes
// effect on the next render. Same shape as the `scAllCharts` debug toggle in
// renderResult.ts: strict === '1', default off.
function mosaicEnabled(): boolean {
  return localStorage.getItem('scMosaic') === '1';
}

// ── Chart-type coverage ─────────────────────────────────────────────────────
// Two EXPLICIT lists rather than one list plus "everything else", so that a
// chart type added to ALL_CHART_TYPE_IDS without a decision here fails a test
// instead of silently defaulting to Chart.js forever. scripts/test-plotSpec.ts
// asserts the two partition the full id list.
//
// The mapping to vgplot marks, and why each one is here:
//   column/bar             → barY/barX
//   clustered_*            → barY/barX faceted by the category (fx/fy), one bar
//                            per split value — Plot's grouped-bar idiom
//   stacked_*              → barY/barX with a `fill` channel (Plot stacks by
//                            default when a fill channel is ordinal)
//   pct_stacked_*          → the same with `offset: 'normalize'`
//   line/line_markers/area → lineY / lineY+dot / areaY
//   stacked_area           → areaY with a fill channel
//   scatter/bubble         → dot, measures mapped to x / y / r as chartRender
//                            does (see its isScatter / isBubble branches)
//   heatmap                → cell (category × split, fill = the measure)
//   histogram              → rectY over bin() — RAW measures only (see buildPlotSpec)
const MOSAIC_CHART_TYPES: ReadonlySet<string> = new Set([
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar',
  'line', 'line_markers', 'area', 'stacked_area',
  'scatter', 'bubble', 'heatmap', 'histogram',
]);

// Types Chart.js keeps. The first five are the GAPs docs/phase-3/README.md §4
// confirmed: @uwdata/vgplot exports no pie, donut, arc, gauge, treemap or
// sankey mark. The rest are judgement calls recorded here rather than implied:
//   combo        → two mark families over one y-scale; Ordinate's combo also
//                  needs the Chart.js dual-axis handling
//   funnel       → Chart.js draws it as a centred stacked bar with a spacer
//                  series; there is no funnel mark and faking one in Plot is a
//                  different chart, not the same one
//   candlestick  → the financial controller has no vgplot equivalent
//   boxplot      → vgplot does NOT re-export Plot's boxX/boxY (phase-3 §4.1);
//                  buildable from rules + ticks, but that is a build, not a swap
//   table        → not a chart
//   map_*        → MapLibre GL owns maps (Phase 4). vgplot's `geo` mark draws
//                  GeoJSON but ships no basemap, so it is not a replacement.
const MOSAIC_FALLBACK_TYPES: ReadonlySet<string> = new Set([
  'pie', 'donut', 'gauge', 'treemap', 'sankey',
  'combo', 'funnel', 'candlestick', 'boxplot',
  'table', 'map_bubble', 'map_choropleth',
]);

/** True when `type` has a vgplot mapping at all (the encoding still has to fit). */
function mosaicChartCapable(type: string): boolean {
  return MOSAIC_CHART_TYPES.has(type);
}

// ── The pure spec layer ─────────────────────────────────────────────────────
// buildPlotSpec is the whole chart-type decision and it touches no DOM, no
// vgplot and no IPC, so scripts/test-plotSpec.ts can execute the REAL function
// (it loads the emitted plotRender.js in a vm) instead of mirroring it.

type MosaicAgg = 'sum' | 'avg' | 'count' | 'min' | 'max';

/** A channel value: a bare column, or an aggregate over one. */
interface PlotField {
  column: string;
  agg?: MosaicAgg;
}

interface PlotMarkSpec {
  /** The vgplot mark function name, e.g. 'barY'. */
  mark: string;
  /** Channel name → PlotField, a bin over a column, or a literal. */
  options: Record<string, unknown>;
}

interface PlotSpec {
  /** The SQL relation to query — the view name from `mosaic:view`. */
  relation: string;
  marks: PlotMarkSpec[];
  /** Plot-level attribute directives, name → argument. */
  attributes: Record<string, unknown>;
  /** Columns that must exist (and, for aggregates, be numeric) in the view. */
  requires: { column: string; numeric: boolean }[];
}

/** Ordinate's per-measure encoding, as visuals.ts writes it. */
interface PlotEncodingMeasure {
  column: string;
  aggregation: MosaicAgg | 'none';
}
interface PlotEncoding {
  category?: string;
  values?: PlotEncodingMeasure[];
  series?: string;
  geo?: { level: string };
}

/** `agg` for a measure, or null when the measure is raw (`none`). */
function measureAgg(m: PlotEncodingMeasure): MosaicAgg | null {
  return !m || m.aggregation === 'none' ? null : (m.aggregation as MosaicAgg);
}

function field(column: string, agg: MosaicAgg | null): PlotField {
  return agg ? { column, agg } : { column };
}

// A `count` aggregate never reads its column (vgplot emits `count()`), so it
// imposes no numeric requirement; every other aggregate does. sum() over a
// VARCHAR column is a loud DuckDB binder error by design (docs/phase-3b §2) —
// this is where that error is turned into a fallback instead of a broken card.
function requirement(column: string, agg: MosaicAgg | null): { column: string; numeric: boolean } {
  return { column, numeric: !!agg && agg !== 'count' };
}

/**
 * The chart type + encoding → a vgplot spec, or null when this file cannot draw
 * that combination faithfully. PURE.
 *
 * The encoding cases mirror src/vizData.ts exactly, because that is what the
 * Chart.js path draws and the two must not disagree about what a visual MEANS:
 *
 *   (A) one measure, no split      → one series  (vizData buildAggregated / buildRaw)
 *   (B) one measure + a split      → one series per split value (vizData buildPivot)
 *   (C) two or more measures       → one series per measure
 *
 * (C) is DECLINED for every type except scatter/bubble. vizData turns N measures
 * into N sibling series; vgplot would need either N sibling marks (which do not
 * stack or cluster with each other) or an UNPIVOT of a pre-aggregated subquery —
 * at which point the app, not Mosaic, is doing the aggregation and the whole
 * point of the path is gone. scatter/bubble are the exception because Ordinate
 * already reads their measures POSITIONALLY as x / y / r, which is one mark.
 */
function buildPlotSpec(type: string, encoding: PlotEncoding, viewName: string): PlotSpec | null {
  if (!mosaicChartCapable(type)) return null;
  if (!encoding || typeof encoding.category !== 'string' || !encoding.category) return null;
  // A geo encoding is a map, and maps stay on MapLibre GL.
  if (encoding.geo) return null;

  const cat = encoding.category;
  const measures = Array.isArray(encoding.values) ? encoding.values.filter((m) => m && m.column) : [];
  if (!measures.length) return null;
  const split = typeof encoding.series === 'string' && encoding.series ? encoding.series : '';

  const m0 = measures[0];
  const agg0 = measureAgg(m0);
  const y = field(m0.column, agg0);
  const requires: { column: string; numeric: boolean }[] = [
    { column: cat, numeric: false },
    requirement(m0.column, agg0),
  ];
  if (split) requires.push({ column: split, numeric: false });

  const spec = (marks: PlotMarkSpec[], attributes: Record<string, unknown> = {}): PlotSpec =>
    ({ relation: viewName, marks, attributes, requires });

  // ── scatter / bubble: measures are POSITIONAL (x, y, r) ──
  // chartRender's isScatter/isBubble read series[0]→x, series[1]→y, series[2]→r.
  // With an aggregate on the measures the category becomes the grouping key,
  // which is also what colours the points; raw ('none') measures plot one dot
  // per row, with no GROUP BY at all — the natural scatter.
  if (type === 'scatter' || type === 'bubble') {
    const need = type === 'bubble' ? 3 : 2;
    if (measures.length < need) return null;
    const opts: Record<string, unknown> = {
      x: field(measures[0].column, measureAgg(measures[0])),
      y: field(measures[1].column, measureAgg(measures[1])),
    };
    const reqs = [
      requirement(measures[0].column, measureAgg(measures[0])),
      requirement(measures[1].column, measureAgg(measures[1])),
    ];
    // Both channels raw → no aggregate anywhere → no GROUP BY, so the category
    // would silently become a grouping key if we passed it. Only colour by it
    // when the mark is already aggregated.
    const aggregated = measures.slice(0, need).some((m) => measureAgg(m) !== null);
    if (aggregated) opts.fill = { column: cat };
    if (type === 'bubble') {
      opts.r = field(measures[2].column, measureAgg(measures[2]));
      reqs.push(requirement(measures[2].column, measureAgg(measures[2])));
    }
    reqs.push({ column: cat, numeric: false });
    return {
      relation: viewName,
      marks: [{ mark: 'dot', options: opts }],
      attributes: { xLabel: measures[0].column, yLabel: measures[1].column },
      requires: reqs,
    };
  }

  // ── histogram: bin the RAW column ──
  // Chart.js bins the SERIES values, which for an aggregated encoding is a
  // distribution of group totals; binning the raw column is a distribution of
  // rows. Those are different charts, so only the raw case is claimed here.
  if (type === 'histogram') {
    if (agg0 !== null) return null;
    return {
      relation: viewName,
      marks: [{ mark: 'rectY', options: { x: { bin: m0.column }, y: { agg: 'count' }, inset: 0.5 } }],
      attributes: { xLabel: m0.column, yLabel: 'Count' },
      requires: [{ column: m0.column, numeric: true }],
    };
  }

  // Everything below draws ONE measure. Two or more means N sibling series,
  // which only (C) above could express — decline rather than draw measure 0 and
  // silently drop the rest.
  if (measures.length > 1) return null;

  const axis = { xLabel: cat, yLabel: m0.column };

  // STACK ORDER IS NOT FREE, and getting it wrong is a wrong chart, not an ugly
  // one. Plot stacks in INPUT order, and a `GROUP BY` returns its groups in hash
  // order — measured: the same three channels came out in a different vertical
  // order in every column of the same bar chart, so one series had no fixed
  // position to read along. Of the stabilisers Plot documents, only an explicit
  // `z` series channel plus `order: 'z'` held across all five categories:
  // `order: 'sum'` / `'appearance'` / `'inside-out'` did not (Plot cannot infer
  // `z` from a Mosaic fill channel), and `sort`/`order` given a Plot channel NAME
  // is pushed into the SQL by Mosaic as a column reference and fails to bind
  // ("Binder Error: Referenced column \"fill\" not found"). `order: 'value'`
  // happens to look stable but orders by MAGNITUDE, so two series swap places the
  // moment their ranks cross. Ordering by the split VALUE is the only rule that
  // is deterministic for every dataset. `z` duplicates the fill column in the
  // GROUP BY, which costs nothing.
  const stackOrder = split ? { z: { column: split }, order: 'z' } : {};

  switch (type) {
    // ── Single-series bars ── (Ordinate caps column/bar at one series, so a
    // split here would draw the clustered chart under the plain chart's name.)
    case 'column':
      if (split) return null;
      return spec([{ mark: 'barY', options: { x: { column: cat }, y } }], axis);
    case 'bar':
      if (split) return null;
      return spec([{ mark: 'barX', options: { y: { column: cat }, x: y } }],
        { xLabel: m0.column, yLabel: cat });

    // ── Grouped bars: one bar per split value, facet-per-category ──
    case 'clustered_column':
      if (!split) return null;
      return spec(
        [{ mark: 'barY', options: { x: { column: split }, y, fill: { column: split }, fx: { column: cat } } }],
        { ...axis, xAxis: null, xTicks: [] },
      );
    case 'clustered_bar':
      if (!split) return null;
      return spec(
        [{ mark: 'barX', options: { y: { column: split }, x: y, fill: { column: split }, fy: { column: cat } } }],
        { xLabel: m0.column, yLabel: cat, yAxis: null, yTicks: [] },
      );

    // ── Stacked bars (and their 100% variants) ──
    case 'stacked_column':
      if (!split) return null;
      return spec([{ mark: 'barY', options: { x: { column: cat }, y, fill: { column: split }, ...stackOrder } }], axis);
    case 'stacked_bar':
      if (!split) return null;
      return spec([{ mark: 'barX', options: { y: { column: cat }, x: y, fill: { column: split }, ...stackOrder } }],
        { xLabel: m0.column, yLabel: cat });
    case 'pct_stacked_column':
      if (!split) return null;
      return spec(
        [{ mark: 'barY', options: { x: { column: cat }, y, fill: { column: split }, offset: 'normalize', ...stackOrder } }],
        { ...axis, yLabel: 'Share of ' + m0.column },
      );
    case 'pct_stacked_bar':
      if (!split) return null;
      return spec(
        [{ mark: 'barX', options: { y: { column: cat }, x: y, fill: { column: split }, offset: 'normalize', ...stackOrder } }],
        { xLabel: 'Share of ' + m0.column, yLabel: cat },
      );

    // ── Lines and areas ──
    case 'line':
    case 'line_markers': {
      const base: Record<string, unknown> = { x: { column: cat }, y };
      if (split) base.stroke = { column: split };
      const marks: PlotMarkSpec[] = [{ mark: 'lineY', options: base }];
      // A marker is a second mark over the SAME channels — vgplot issues one
      // query per mark, but they are identical, so the coordinator's cache
      // serves the second from the first.
      if (type === 'line_markers') marks.push({ mark: 'dot', options: { ...base, fill: base.stroke || undefined } });
      return spec(marks, axis);
    }
    case 'area': {
      const opts: Record<string, unknown> = { x: { column: cat }, y };
      if (split) Object.assign(opts, { fill: { column: split } }, stackOrder);
      return spec([{ mark: 'areaY', options: opts }], axis);
    }
    case 'stacked_area':
      if (!split) return null;
      return spec([{ mark: 'areaY', options: { x: { column: cat }, y, fill: { column: split }, ...stackOrder } }], axis);

    // ── Heatmap: the category × split grid, coloured by the measure ──
    case 'heatmap':
      if (!split) return null;
      return spec([{ mark: 'cell', options: { x: { column: cat }, y: { column: split }, fill: y } }],
        { xLabel: cat, yLabel: split });

    default:
      return null;
  }
}

// ── Identifier quoting ──────────────────────────────────────────────────────

/**
 * A SQL identifier: `"…"` with an embedded `"` doubled. That IS the whole
 * escape — the same rule, and the same verification, as src/datasetView.ts
 * (docs/phase-3b §2 "Identifier safety").
 *
 * vgplot quotes identically on its own (measured: `vg.Query.from('t')
 * .select({a: vg.column('evil"; DROP VIEW x; --')})` emits
 * `SELECT "evil""; DROP VIEW x; --" AS "a"`), so this is not the only guard on
 * the live path. It exists because `mosaicSpecSql` below has to spell the query
 * out, and a quoting rule with no test is a quoting rule nobody has checked.
 */
function mosaicQuoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * The query a spec's FIRST mark asks vgplot to issue, spelled out. PURE.
 *
 * DIAGNOSTIC AND TEST SURFACE, NOT THE LIVE QUERY: vgplot builds its own SQL
 * from the same channels, and its aliases and clause order are its business.
 * The point of writing it here is that the spec's meaning — which columns are
 * grouped, which are aggregated, what gets quoted — becomes something a test
 * can assert and a developer can read off `data-mosaic-sql` without a DevTools
 * network tab. `scripts/test-plotSpec.ts` pins it; the Electron harness that
 * verified this phase compared it against the SQL that actually reached
 * `mosaic:query` and found them equivalent.
 */
function mosaicSpecSql(spec: PlotSpec): string {
  if (!spec || !spec.marks.length) return '';
  const opts = spec.marks[0].options;
  const select: string[] = [];
  const groupBy: string[] = [];
  let aggregated = false;

  for (const channel of Object.keys(opts)) {
    const v = opts[channel] as { column?: string; agg?: MosaicAgg; bin?: string } | undefined;
    if (!v || typeof v !== 'object') continue; // a literal (offset, inset, …)
    if (typeof v.bin === 'string') {
      select.push(`bin(${mosaicQuoteIdent(v.bin)}) AS ${mosaicQuoteIdent(channel)}`);
      groupBy.push(mosaicQuoteIdent(channel));
      continue;
    }
    if (v.agg === 'count') {
      select.push(`count() AS ${mosaicQuoteIdent(channel)}`);
      aggregated = true;
      continue;
    }
    if (typeof v.column !== 'string') continue;
    if (v.agg) {
      select.push(`${v.agg}(${mosaicQuoteIdent(v.column)}) AS ${mosaicQuoteIdent(channel)}`);
      aggregated = true;
    } else {
      select.push(`${mosaicQuoteIdent(v.column)} AS ${mosaicQuoteIdent(channel)}`);
      groupBy.push(mosaicQuoteIdent(channel));
    }
  }

  let sql = 'SELECT ' + select.join(', ') + ' FROM ' + mosaicQuoteIdent(spec.relation);
  if (aggregated && groupBy.length) sql += ' GROUP BY ' + groupBy.join(', ');
  return sql;
}

// ── The connector ───────────────────────────────────────────────────────────

/**
 * Mosaic's ENTIRE database contract is one method — `query({type, sql})` — so
 * the connector is a five-line adapter over `window.hub.mosaicQuery`.
 *
 * `type: 'arrow'` is never requested and never forwarded: `@duckdb/node-api`
 * ships no Arrow support, and `src/ipc/mosaic.ts` rejects it explicitly rather
 * than downgrade it silently. The Coordinator below is what guarantees Arrow is
 * never asked for.
 */
function mosaicConnector(): { query(q: { type?: string; sql: string }): Promise<unknown> } {
  return {
    async query(q) {
      const type = q && q.type === 'exec' ? 'exec' : 'json';
      const res = await window.hub.mosaicQuery(String(q && q.sql), type);
      if (!res || res.ok === false) {
        throw new Error((res && (res as { error?: string }).error) || 'Mosaic query failed');
      }
      // 'exec' runs for side effects; Mosaic expects void back.
      return type === 'exec' ? undefined : res.rows;
    },
  };
}

/**
 * A Coordinator + API context for ONE card.
 *
 * `consolidate: false` is MANDATORY, not a tuning choice. Consolidation rewrites
 * sibling queries into one and then slices the shared result with a
 * flechette-only `data.select`; against JSON rows that is
 * `TypeError: data.select is not a function` and a blank chart with no other
 * diagnostic (docs/phase-3 §2). It costs one query per mark, which is why
 * line_markers leans on the query cache instead of a second scan.
 *
 * PER-CARD, not a singleton: `vg.createAPIContext({coordinator})` returns a full
 * copy of the API bound to that coordinator (measured: 406 members, `plot` and
 * `from` among them), and every directive resolves the coordinator through
 * `this.context` rather than the module-level default. A dashboard page renders
 * several cards at once, each finishing at its own time; sharing one coordinator
 * would mean one `clear()` on teardown wiping another live card's clients.
 */
function mosaicContext(onError: (err: unknown) => void): { ctx: any; coordinator: any } | null {
  const vg = window.vg;
  if (!vg || typeof vg.createAPIContext !== 'function' || typeof vg.Coordinator !== 'function') return null;
  const coordinator = new vg.Coordinator(mosaicConnector(), {
    consolidate: false,
    // The default logger is `console`, and a failed query would reach it as a
    // console.error — which fails `npm run smoke` and tells the user nothing.
    // Route it into the fallback instead: an error here is precisely the signal
    // that this card should be drawn by Chart.js.
    logger: {
      debug: () => {},
      info: () => {},
      log: () => {},
      warn: () => {},
      error: (...args: unknown[]) => onError(args.length === 1 ? args[0] : args),
    },
  });
  return { ctx: vg.createAPIContext({ coordinator }), coordinator };
}

// ── Spec → vgplot ───────────────────────────────────────────────────────────

/** A PlotField (or a bin, or a literal) → the value vgplot wants for a channel. */
function mosaicChannelValue(ctx: any, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const v = value as { column?: string; agg?: MosaicAgg; bin?: string };
  if (typeof v.bin === 'string') return ctx.bin(v.bin);
  if (v.agg === 'count') return ctx.count();
  if (v.agg && typeof v.column === 'string') return ctx[v.agg](v.column);
  if (typeof v.column === 'string') return v.column;
  return value;
}

// Ordinate's chart palette, so a Mosaic card sits beside a Chart.js card without
// looking like a different app. CHART_PALETTE is chartRender.js's, resolved at
// call time like every other cross-file symbol in the hub.
function mosaicPalette(): string[] {
  return typeof CHART_PALETTE !== 'undefined' ? CHART_PALETTE : ['#2563eb'];
}

/** Build the DOM element for a spec. Throws on a malformed spec — the caller falls back. */
function mosaicPlotElement(ctx: any, spec: PlotSpec, width: number, height: number): HTMLElement {
  const palette = mosaicPalette();
  const source = ctx.from(spec.relation);
  let colored = false;
  // A colour channel over a BARE column is categorical (one swatch per split
  // value → the brand palette). A colour channel over an AGGREGATE is
  // continuous — the heatmap case — and feeding five unordered brand colours to
  // a continuous scale makes Plot interpolate through them, producing a ramp
  // that is not monotone in lightness and reads as noise. Sequential data gets a
  // sequential scheme.
  let continuousColor = false;

  const marks = spec.marks.map((m) => {
    const options: Record<string, unknown> = {};
    for (const key of Object.keys(m.options)) {
      const raw = m.options[key];
      if (raw === undefined) continue;
      options[key] = mosaicChannelValue(ctx, raw);
      if ((key === 'fill' || key === 'stroke') && raw && typeof raw === 'object') {
        colored = true;
        if ((raw as PlotField).agg) continuousColor = true;
      }
    }
    // No colour channel → one flat brand colour, matching a single-series
    // Chart.js bar/line rather than Plot's default near-black.
    if (!colored && m.mark !== 'cell') {
      if (m.mark === 'lineY') options.stroke = options.stroke || palette[0];
      else options.fill = options.fill || palette[0];
    }
    return ctx[m.mark](source, options);
  });

  const directives: unknown[] = [ctx.width(width), ctx.height(height), ctx.marginLeft(56), ctx.marginBottom(44)];
  for (const name of Object.keys(spec.attributes)) {
    if (typeof ctx[name] === 'function') directives.push(ctx[name](spec.attributes[name]));
  }
  if (colored) directives.push(continuousColor ? ctx.colorScheme('blues') : ctx.colorRange(palette));

  return ctx.plot(...marks, ...directives);
}

// ── The render entry point ──────────────────────────────────────────────────

/** Dataset identity — everything the Mosaic path needs and `{labels, series}` lacks. */
interface MosaicSource {
  projectId: string;
  datasetId: string;
  encoding: PlotEncoding;
  /** Visual-level + dashboard-wide row filters. Their presence declines Mosaic. */
  filters?: unknown[];
}

// One render token per container. A container can be re-rendered (chart-type
// switch, dashboard filter change) while an earlier Mosaic attempt is still
// awaiting its view; without this the loser would append its plot on top of the
// winner, or fire a fallback that redraws a stale chart.
const mosaicTokens = new WeakMap<HTMLElement, number>();
let mosaicTokenSeq = 0;

/** Record why this container did or didn't take the Mosaic path. Never console.error. */
function mosaicNote(container: HTMLElement, state: string, detail?: string): void {
  container.dataset.mosaic = state;
  console.debug('[mosaic] ' + state + (detail ? ': ' + detail : ''));
}

/**
 * Could this render even attempt Mosaic? Cheap, synchronous, no IPC — so the
 * seam in renderVizInArea can ask before it commits to an async path.
 */
function mosaicCanRender(type: string, source?: MosaicSource | null): boolean {
  if (!mosaicChartCapable(type)) return false;
  if (!source || !source.projectId || !source.datasetId || !source.encoding) return false;
  // Ordinate's filter semantics (empty means null OR '' OR whitespace; text vs
  // number comparison; `contains`) are defined by src/transforms.ts and compiled
  // to SQL by src/sqlGen.ts — in MAIN, where they are tested. Re-deriving them in
  // renderer SQL would risk a chart that is quietly filtered differently from the
  // Chart.js one, which is the one failure this path must not have.
  if (Array.isArray(source.filters) && source.filters.length) return false;
  // NOTE: deliberately does NOT test `window.vg`. The 608 KB vendor bundle is
  // loaded lazily by `ensureVgplot()` on first use, so it is legitimately absent
  // here. `renderMosaicViz` awaits the load and returns false if it fails, which
  // is the same Chart.js fallback this check used to produce.
  return buildPlotSpec(type, source.encoding, 'probe') !== null;
}

// ── Lazy vendor load ─────────────────────────────────────────────────────────
//
// vendor/vgplot.js is 608 KB and used to be a static <script src> in index.html,
// parsed on every launch even though the flag defaults OFF and 12 of 28 chart
// types can never use it. It is now injected on first Mosaic render.
//
// A dynamically-created <script src="vendor/vgplot.js"> is same-origin, so the
// hub CSP (`script-src 'self'`) allows it unchanged — no nonce, no hash.

let vgplotLoad: Promise<boolean> | null = null;

/** Loads the vendor bundle once. Resolves TRUE when `window.vg` is usable. */
function ensureVgplot(): Promise<boolean> {
  if (window.vg) return Promise.resolve(true);
  if (vgplotLoad) return vgplotLoad;
  vgplotLoad = new Promise<boolean>((resolve) => {
    const s = document.createElement('script');
    s.src = 'vendor/vgplot.js';
    s.onload = () => resolve(!!window.vg);
    // Reset on failure so a later render retries rather than being poisoned by
    // one transient miss.
    s.onerror = () => { vgplotLoad = null; resolve(false); };
    document.head.appendChild(s);
  });
  return vgplotLoad;
}

/**
 * Draw `type` into `container` through vgplot. Resolves TRUE when a plot is on
 * screen, FALSE when the caller should draw it with Chart.js instead. Never
 * throws, never leaves a half-built container behind.
 *
 * `onLateFailure` covers what a promise cannot: vgplot's queries run AFTER
 * `plot()` returns its element, so a binder error arrives late. The custom
 * logger routes it here, and the card is redrawn with Chart.js.
 */
async function renderMosaicViz(
  container: HTMLElement,
  type: string,
  source: MosaicSource,
  onLateFailure: () => void,
): Promise<boolean> {
  const token = ++mosaicTokenSeq;
  mosaicTokens.set(container, token);
  const current = () => mosaicTokens.get(container) === token;

  // First Mosaic render in this session pays for the vendor bundle; every launch
  // that never draws a Mosaic chart pays nothing.
  const haveVg = await ensureVgplot();
  if (!current()) return true; // superseded while the bundle was loading
  if (!haveVg) {
    mosaicNote(container, 'fallback', 'window.vg missing');
    return false;
  }

  let view: any;
  try {
    view = await window.hub.mosaicView(source.projectId, source.datasetId);
  } catch (err) {
    view = { ok: false, error: err instanceof Error ? err.message : 'mosaic:view failed' };
  }
  if (!current()) return true; // superseded — the newer render owns the container
  if (!view || view.ok === false) {
    mosaicNote(container, 'fallback', (view && view.error) || 'no view');
    return false;
  }

  const spec = buildPlotSpec(type, source.encoding, view.name);
  if (!spec) {
    mosaicNote(container, 'fallback', 'no spec for ' + type);
    return false;
  }

  // The view is the ONLY source of truth for names and types — `viewColumns()`,
  // never DESCRIBE (a leading U+FEFF is lost on read-back, docs/phase-3b §3).
  // Checking here turns "sum over a text column" into a fallback rather than a
  // late binder error and an empty card.
  const byName = new Map<string, { sqlType: string }>();
  for (const c of view.columns || []) byName.set(c.name, c);
  for (const req of spec.requires) {
    const col = byName.get(req.column);
    if (!col) {
      mosaicNote(container, 'fallback', 'view has no column ' + req.column);
      return false;
    }
    if (req.numeric && col.sqlType !== 'DOUBLE') {
      mosaicNote(container, 'fallback', req.column + ' is not numeric in the view');
      return false;
    }
  }

  let failed = false;
  const fail = (err: unknown) => {
    if (failed || !current()) return;
    failed = true;
    mosaicNote(container, 'fallback', 'query error: ' + (err instanceof Error ? err.message : String(err)));
    container.innerHTML = '';
    onLateFailure();
  };

  const made = mosaicContext(fail);
  if (!made) {
    mosaicNote(container, 'fallback', 'window.vg missing');
    return false;
  }

  let el: HTMLElement;
  try {
    const width = Math.max(240, Math.floor(container.clientWidth) || 640);
    const height = Math.max(180, Math.floor(container.clientHeight) || 340);
    el = mosaicPlotElement(made.ctx, spec, width, height);
  } catch (err) {
    try { made.coordinator.clear(); } catch (_) { /* nothing connected yet */ }
    mosaicNote(container, 'fallback', err instanceof Error ? err.message : 'plot() threw');
    return false;
  }
  if (!current()) {
    try { made.coordinator.clear(); } catch (_) {}
    return true;
  }

  const wrap = document.createElement('div');
  wrap.className = 'cv-plot-wrap';
  wrap.appendChild(el);
  container.innerHTML = '';
  container.appendChild(wrap);
  container.dataset.mosaicSql = mosaicSpecSql(spec);
  mosaicNote(container, 'ok', type);

  // The teardown handle. renderVizInArea and dashboards.destroyDashCharts both
  // call .destroy() BLIND on whatever sits in chartInstances, so this must be a
  // working method — `clear()` disconnects every client from the coordinator so
  // a removed card cannot keep querying.
  chartInstances.set(container, {
    destroy() {
      mosaicTokens.delete(container);
      try { made.coordinator.clear({ clients: true, cache: true }); } catch (_) { /* already torn down */ }
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    },
  });
  return true;
}
