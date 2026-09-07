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
            const formatted = overrides.numberFormat ? fmt(displayVal)
              : (Math.abs(displayVal) >= 10000 ? _fmtVal(displayVal) : String(displayVal));
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

  if (isRound) {
    // Pie/donut have no axes, so label each big-enough slice with its category name
    // directly (always on — readable without hovering or colour-matching the legend);
    // small slices fall back to the legend. When Values is on, the slice's value is
    // added below the name. White text + shadow keeps it legible on any slice colour.
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
          if (showVal) lines.push(overrides.numberFormat ? fmt(val)
            : (Math.abs(val) >= 10000 ? _fmtVal(val) : String(val)));
          const pos = el.tooltipPosition();
          const lh = 12;
          const y0 = pos.y - ((lines.length - 1) * lh) / 2;
          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 3;
          ctx.fillStyle = '#ffffff';
          lines.forEach((ln: string, k: number) => {
            ctx.font = `${(k === 0 && showName) ? 600 : 500} 10px ${fontFamily}`;
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
          const formatted = overrides.numberFormat ? fmt(v)
            : (Math.abs(v) >= 10000 ? _fmtVal(v) : String(v));
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
