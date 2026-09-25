// The numbers a chart prints ON ITSELF — which points get a label, and the
// inline Chart.js plugins that draw them onto the canvas.
//
// Five plugins, one job between them: put the app's own figures where the eye
// already is, instead of making the reader hover. They are the only code here
// that touches a 2-D context, and they all run in `afterDatasetsDraw` (gauge in
// `afterDraw`), reading per-family state the dataset builders left on `opts`.
//
// valueLabelKeys lives here because it IS the selection rule those plugins share
// — and mapRender.js reads it too, for the same Values menu over a map's markers.
// It resolves at call time, like every cross-file renderer symbol, so its script
// order relative to mapRender.js does not matter.
//
// Loads after chartTypeSpec.js, before chartRender.js. Classic global-scope
// script — NO import/export.

/**
 * The text a value label prints, when the chart carries no explicit
 * "Number format" override.
 *
 * THE RULE, unchanged: at or above 10,000 abbreviate (`_fmtVal` → "12.2K"),
 * below it show the real number. A label is the figure the reader takes away,
 * and rounding 9,481 to "9.5K" on a chart small enough to read exactly is a
 * loss; abbreviating 1,204,388 is a gain. The threshold is where those cross.
 *
 * WHAT WAS WRONG was the "show the real number" half: it was `String(v)`, which
 * prints a float at full binary precision. A summed money column is almost never
 * exact — filter the bundled sample to one category and the line chart's minimum
 * printed `3908.359999999999` straight across the y-axis ticks. It stayed hidden
 * for as long as it did because it only shows BELOW 10,000, and most unfiltered
 * dashboards sum to more than that.
 *
 * `toLocaleString()` is the fix and also already the app's answer: it is exactly
 * what `fmtWith(v, 'plain')` does, so "no override" now agrees with the override
 * a reader would pick to mean the same thing. It groups thousands and rounds at
 * three decimals.
 *
 * …except at the bottom of the range, where that rounding turns a real figure
 * into "0". A margin of 0.0001234 is not zero, and a chart that says it is would
 * be wrong in the one way this app must never be. Below 0.001 — precisely where
 * the default rounding collapses — significant digits take over instead.
 */
function valueLabelText(v: number): string {
  if (Math.abs(v) >= 10000) return _fmtVal(v);
  if (v !== 0 && Math.abs(v) < 0.001) return v.toLocaleString(undefined, { maximumSignificantDigits: 3 });
  return v.toLocaleString();
}

/**
 * Does a round-chart slice have room to hold its label?
 *
 * The old rule was `frac >= 0.06` — a share of the TOTAL, which says nothing
 * about pixels. At a dashboard card's ~150px tile a 6% slice is a few pixels
 * wide, so "Technology" in 10px type was drawn straight across the ring and out
 * the other side. The same rule mislabels a full-size chart too, just less
 * often: a long category in a thin slice has always overflowed.
 *
 * SO TEST THE TEXT AGAINST THE SLICE, AND DO IT IN THE RIGHT DIRECTION. The
 * first attempt at this compared the text width to the slice's chord at the
 * label radius. That is rotation-independent, and the label is not: it is drawn
 * HORIZONTALLY, so a slice sitting at 4 o'clock offers far less left-to-right
 * room than its chord suggests. It fixed the pie and left the donut exactly as
 * broken, which is what sent this back for a second pass.
 *
 * What actually settles it is the label's own box. The text is a rectangle
 * centred on the slice's mid-radius, mid-angle point; it fits when all FOUR of
 * its corners are still inside the annular sector — radius within
 * [inner, outer], angle within [start, end]. That is exact, cheap, and
 * orientation-aware by construction.
 *
 * Pure and unit-testable on purpose: everything here is a number, so
 * scripts/test-roundLabels.ts can drive real thumbnail and full-size geometry
 * without a canvas. `textWidth` is measured by the caller, which is the only
 * part that needs a 2-D context.
 */
function roundLabelFits(
  geom: { innerRadius: number; outerRadius: number; startAngle: number; endAngle: number },
  textWidth: number, textHeight: number,
): boolean {
  const inner = Math.max(0, Number(geom.innerRadius) || 0);
  const outer = Math.max(0, Number(geom.outerRadius) || 0);
  const start = Number(geom.startAngle) || 0;
  const end = Number(geom.endAngle) || 0;
  const w = Number(textWidth) || 0;
  const h = Number(textHeight) || 0;
  if (!(outer > inner) || !(w > 0) || !(h > 0)) return false;

  const span = Math.abs(end - start);
  const TAU = Math.PI * 2;
  // A slice covering the whole circle has no edges to cross, so only the radii
  // can rule the label out. Checked first because the angle test below would
  // otherwise depend on floating-point luck at exactly 2π.
  const whole = span >= TAU - 1e-9;

  const rMid = (inner + outer) / 2;
  const mid = (start + end) / 2;
  const cx = rMid * Math.cos(mid);
  const cy = rMid * Math.sin(mid);
  // 4px of breathing room each side, or the text kisses the slice edges and
  // reads as overflowing even when it technically fits.
  const hw = w / 2 + 4;
  const hh = h / 2 + 2;

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = cx + sx * hw;
      const y = cy + sy * hh;
      const r = Math.sqrt(x * x + y * y);
      if (r < inner || r > outer) return false;
      if (whole) continue;
      // Sweep from `start` to this corner, normalised into [0, 2π), must land
      // inside the slice's own span.
      let d = (Math.atan2(y, x) - start) % TAU;
      if (d < 0) d += TAU;
      if (d > span) return false;
    }
  }
  return true;
}

// Which data points the Values menu labels, given a mode and the 2-D value grid
// (`values[seriesIdx][catIdx]`; hidden series passed as all-null so they can't win).
// Returns a Set of "seriesIdx:catIdx" keys.
//   all    → every non-null cell
//   single series → the one global max / min over categories
//   multi series  → per category column, the max series (and/or min series)  [per-group]
//   maxmin → union of max and min
function valueLabelKeys(mode: string, values: any[][]): Set<string> {
  const keys = new Set<string>();
  if (!mode || mode === 'off' || !Array.isArray(values) || !values.length) return keys;
  const S = values.length;
  const C = Math.max(0, ...values.map((r: any[]) => (Array.isArray(r) ? r.length : 0)));
  const num = (s: number, c: number): number | null => { const v = values[s] && values[s][c]; return typeof v === 'number' ? v : null; };
  const add = (s: number, c: number) => keys.add(s + ':' + c);
  if (mode === 'all') {
    for (let s = 0; s < S; s++) for (let c = 0; c < C; c++) if (num(s, c) != null) add(s, c);
    return keys;
  }
  const wantMax = mode === 'max' || mode === 'maxmin';
  const wantMin = mode === 'min' || mode === 'maxmin';
  // One max and one min per series — each line/bar's own peak and trough across
  // categories (so N series → up to N maxes + N mins).
  for (let s = 0; s < S; s++) {
    let maxC = -1, minC = -1, maxV = -Infinity, minV = Infinity;
    for (let c = 0; c < C; c++) {
      const v = num(s, c); if (v == null) continue;
      if (v > maxV) { maxV = v; maxC = c; }
      if (v < minV) { minV = v; minC = c; }
    }
    if (wantMax && maxC >= 0) add(s, maxC);
    if (wantMin && minC >= 0) add(s, minC);
  }
  return keys;
}

// Reads a numeric value out of a Chart.js data point (handles {x,y} scatter points).
const numOf = (raw: any): number | null => {
  const v = (raw && typeof raw === 'object') ? raw.y : raw;
  return typeof v === 'number' ? v : null;
};

// The per-chart inline plugins for one chart, in the order Chart.js should see
// them. Locals are destructured out of the context under their ORIGINAL names so
// each plugin body below is the same code it was inside buildChart.
function buildChartPlugins(c: ChartCtx): any[] {
  // Waterfall / bullet / calendar / radar / Pareto draw their own marks and
  // labels: chartFamiliesExtra.js.
  if (isExtraFamily(c)) return buildExtraPlugins(c);
  const {
    opts, overrides, fmt, valueMode, fontFamily, textColor, titleColor,
    isRound, isGauge, isTreemap, isMatrix, isFunnel, isSankey, isCandlestick, isBoxplot, isHoriz,
  } = c;

  const inlinePlugins: any[] = [];   // Chart.js plugin objects, hooks typed per-use

  if (isGauge) {
    // Print the actual value at the hub of the half-circle.
    inlinePlugins.push({
      id: 'gaugeCenter',
      afterDraw(chart: ChartJsCtx) {
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        const v = opts._gaugeValue;
        const txt = (v >= 0 && v <= 1) ? Math.round(v * 100) + '%' : fmt(v);
        const cx = (chartArea.left + chartArea.right) / 2;
        const cy = (chartArea.top + chartArea.bottom) / 2 + 4;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = `700 22px ${fontFamily}`;
        ctx.fillStyle = titleColor;
        ctx.textBaseline = 'top';
        ctx.fillText(txt, cx, cy);
        // Name the metric below the value so the gauge isn't a context-free number.
        // (Skipped in small multiples — the per-mini caption already shows the name.)
        const label = opts._gaugeLabel;
        if (label && !overrides._smallMultiple) {
          ctx.font = `500 11px ${fontFamily}`;
          ctx.fillStyle = textColor;
          ctx.fillText(label, cx, cy + 26);
        }
        ctx.restore();
      },
    });
  }

  if (isFunnel) {
    // Always print each stage's value, centered on its bar.
    inlinePlugins.push({
      id: 'funnelLabels',
      afterDatasetsDraw(chart: ChartJsCtx) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(1);   // the value dataset
        if (!meta) return;
        const vals = opts._funnelVals;
        meta.data.forEach((el: ChartJsCtx, i: number) => {
          if (vals[i] == null) return;
          const pos = el.tooltipPosition();
          ctx.save();
          ctx.font = `600 11px ${fontFamily}`;
          // ON the filled stage, not floating over the plot — white is right in
          // both themes. The floating labels above use titleColor, which is the
          // token. Do not "theme" this one.
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(fmt(vals[i]), pos.x, pos.y);
          ctx.restore();
        });
      },
    });
  }

  if (valueMode !== 'off' && !isRound && !isTreemap && !isMatrix && !isFunnel
      && !isSankey && !isCandlestick && !isBoxplot) {
    // Draw the data value near selected bars/points after the chart renders.
    inlinePlugins.push({
      id: 'valueLabels',
      afterDatasetsDraw(chart: ChartJsCtx) {
        const { ctx } = chart;
        // Build the value grid from visible datasets only (hidden → all-null row).
        const grid = chart.data.datasets.map((ds: ChartJsCtx, di: number) =>
          chart.getDatasetMeta(di).hidden ? [] : (ds.data || []).map(numOf));
        const keys = valueLabelKeys(valueMode, grid);
        // Place each label in the first free vertical slot near its point so labels never
        // overlap. Sparse max/min modes nudge a collision into a small stack (keeping every
        // series' peak/trough visible even when lines nearly coincide); dense 'all' mode
        // just drops overlaps. Nudged slots stay inside the plot; the natural slot doesn't.
        const placed: { x: number; y: number; w: number; h: number }[] = [];
        const overlaps = (x: number, y: number, w: number, h: number) => placed.some((r) =>
          x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y);
        // Drop duplicate labels: identical value at the same x (e.g. several near-equal
        // series peaking at the same category) collapses to one, so it never piles up.
        const seen = new Set<string>();
        const area = chart.chartArea;
        const h = 12;
        const offsets = valueMode === 'all'
          ? [0]
          : [0, -(h + 1), h + 1, -2 * (h + 1), 2 * (h + 1), -3 * (h + 1), 3 * (h + 1), -4 * (h + 1), 4 * (h + 1)];
        ctx.save();
        ctx.font = `600 10px ${fontFamily}`;
        ctx.fillStyle = titleColor;
        ctx.textAlign = 'center';
        chart.data.datasets.forEach((dataset: ChartJsCtx, di: number) => {
          const meta = chart.getDatasetMeta(di);
          if (meta.hidden) return;
          meta.data.forEach((element: ChartJsCtx, j: number) => {
            if (!keys.has(di + ':' + j)) return;
            let displayVal = numOf(dataset.data[j]);
            if (displayVal == null) return;
            // Stacked charts position each point at the cumulative top, so label the running
            // total (visible series 0..di) — otherwise the raw number won't match the axis.
            if (opts.stacked) {
              let cum = 0;
              for (let d = 0; d <= di; d++) {
                if (chart.getDatasetMeta(d).hidden) continue;
                const dv = numOf(chart.data.datasets[d].data[j]);
                if (typeof dv === 'number') cum += dv;
              }
              displayVal = cum;
            }
            const pos = element.tooltipPosition();
            const formatted = overrides.numberFormat ? fmt(displayVal) : valueLabelText(displayVal);
            const w = ctx.measureText(formatted).width;
            const tx = isHoriz ? pos.x + 8 : pos.x;
            const ty0 = isHoriz ? pos.y : pos.y - 4;
            const bx = isHoriz ? tx : tx - w / 2;
            const dedupeKey = formatted + '@' + Math.round(tx);
            if (seen.has(dedupeKey)) return;
            for (const dy of offsets) {
              const ty = ty0 + dy;
              const by = isHoriz ? ty - h / 2 : ty - h;
              if (dy !== 0 && area && (by < area.top || by + h > area.bottom)) continue;
              if (overlaps(bx, by, w, h)) continue;
              placed.push({ x: bx, y: by, w, h });
              seen.add(dedupeKey);
              ctx.textBaseline = isHoriz ? 'middle' : 'bottom';
              ctx.fillText(formatted, tx, ty);
              break;
            }
          });
        });
        ctx.restore();
      },
    });
  }

  // A gauge is DRAWN as a doughnut, so isRound is true for it — correctly, for
  // datasets, cutout and rotation. Not for this plugin: a gauge's two "slices"
  // are a value and its remainder, not categories, and its label IS the metric
  // name the gaugeCenter plugin above already prints under the big number. So
  // roundLabels drew the same words twice on one small chart.
  if (isRound && !isGauge) {
    // Pie/donut have no axes, so label each big-enough slice with its category name
    // directly (always on — readable without hovering or colour-matching the legend);
    // slices that cannot hold their label fall back to the legend. When Values is
    // on, the slice's value is added below the name. White text + shadow keeps it
    // legible on any slice colour.
    //
    // "Big enough" is TWO tests, and the second is the one that matters at small
    // sizes: a share of the total (a product judgement about which slices deserve
    // a name at all), and then whether the measured text actually fits the slice's
    // geometry (roundLabelFits above). Without the second, a dashboard card's
    // ~150px donut drew its category names straight across the ring.
    inlinePlugins.push({
      id: 'roundLabels',
      afterDatasetsDraw(chart: ChartJsCtx) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        const ds = chart.data.datasets[0];
        const row = ((ds && ds.data) || []).map(numOf);
        const total = row.reduce((a: number, v: number | null) => a + (typeof v === 'number' ? Math.abs(v) : 0), 0) || 1;
        const cats = chart.data.labels || [];
        const valueKeys = valueMode !== 'off' ? valueLabelKeys(valueMode, [row]) : new Set<string>();
        const clip = (s: string) => (s.length > 14 ? s.slice(0, 13) + '…' : s);
        meta.data.forEach((el: ChartJsCtx, j: number) => {
          if (!el) return;
          const val = row[j];
          const frac = (typeof val === 'number' ? Math.abs(val) : 0) / total;
          const name = cats[j] == null ? '' : String(cats[j]);
          const showName = frac >= 0.06 && name !== '';   // only slices big enough to read
          const showVal = val != null && valueKeys.has('0:' + j);
          if (!showName && !showVal) return;
          const lines: string[] = [];
          if (showName) lines.push(clip(name));
          if (showVal) lines.push(overrides.numberFormat ? fmt(val) : valueLabelText(val));
          const lh = 12;
          // Measure with each line's OWN font — the name is 600 weight and the
          // value 500, and the widest line is what has to fit.
          const fontFor = (k: number) => `${(k === 0 && showName) ? 600 : 500} 10px ${fontFamily}`;
          ctx.save();
          let textWidth = 0;
          lines.forEach((ln: string, k: number) => {
            ctx.font = fontFor(k);
            textWidth = Math.max(textWidth, ctx.measureText(ln).width);
          });
          if (!roundLabelFits(el, textWidth, lines.length * lh)) { ctx.restore(); return; }
          const pos = el.tooltipPosition();
          const y0 = pos.y - ((lines.length - 1) * lh) / 2;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 3;
          // Inside the slice — roundLabelFits() above refuses to draw otherwise —
          // so this sits on a filled arc in the accent palette, never on the
          // plot background. White plus the shadow is correct in both themes.
          ctx.fillStyle = '#ffffff';
          lines.forEach((ln: string, k: number) => {
            ctx.font = fontFor(k);
            ctx.fillText(ln, pos.x, y0 + k * lh);
          });
          ctx.restore();
        });
      },
    });
  }

  if (valueMode !== 'off' && isMatrix) {
    inlinePlugins.push({
      id: 'matrixValueLabels',
      afterDatasetsDraw(chart: ChartJsCtx) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        const rows = (opts._matrixRows || []).length;
        if (!rows) return;
        const keys = valueLabelKeys(valueMode, opts._matrixGrid || []);   // [colIdx][rowIdx]
        meta.data.forEach((el: ChartJsCtx, k: number) => {
          const colIdx = Math.floor(k / rows), rowIdx = k % rows;
          if (!keys.has(colIdx + ':' + rowIdx)) return;
          const v = numOf((chart.data.datasets[0].data[k] || {}).v);
          if (v == null) return;
          const pos = el.getCenterPoint ? el.getCenterPoint() : { x: el.x, y: el.y };
          const formatted = overrides.numberFormat ? fmt(v) : valueLabelText(v);
          // Ink picked by cell darkness (the same accent-alpha ramp the cell is filled
          // with) — replaces the old halo stroke, which left a smudge behind the digits.
          const span = (opts._matrixVmax - opts._matrixVmin) || 1;
          const cellAlpha = 0.15 + 0.85 * ((v - opts._matrixVmin) / span);
          ctx.save();
          ctx.font = `600 10px ${fontFamily}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = cellAlpha >= 0.55 ? '#ffffff' : titleColor;
          ctx.fillText(formatted, pos.x, pos.y);
          ctx.restore();
        });
      },
    });
  }

  return inlinePlugins;
}
