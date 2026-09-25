// The Chart.js dataset objects for one chart — the per-family block that turns
// {labels, series} into whatever shape that family's controller wants.
//
// This is the widest fan-out in the render path, and the reason is not
// avoidable: a treemap wants a `tree` array, a matrix wants {x,y,v} cells, a
// sankey wants {from,to,flow} flows, a candlestick wants {x,o,h,l,c} bars, a
// funnel wants a transparent spacer stack, and a boxplot wants raw value arrays.
// Thirteen shapes, one per family, sharing only the palette and the formatter.
//
// It also owns the two gradient makers, because gradients are dataset paint and
// nothing outside a dataset asks for one. They return SCRIPTABLE options —
// Chart.js calls them back with a live chart, so they must not close over a
// chart area that does not exist yet, which is why each re-reads ctx.chart.
//
// The per-family state the scales and the inline plugins need (_gaugeValue,
// _matrixCols/_matrixGrid, _funnelMax/_funnelVals) is written back onto `opts`
// here. That is why this runs BEFORE chartScales and chartValueLabels.
//
// Loads after chartTypeSpec.js, before chartRender.js. Classic global-scope
// script — NO import/export.

// Bar: gradient along the bar's length, darkest at the value end.
function makeBarGradient(color: string, isHoriz: boolean) {
  return (ctx: ChartJsCtx) => {
    const chart = ctx.chart;
    const { ctx: cx, chartArea } = chart;
    if (!chartArea) return color + 'e0';
    let g;
    if (isHoriz) {
      // horizontal bars: subtle fade on left (base), full on right (value end)
      g = cx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
      g.addColorStop(0, color + 'b0');
      g.addColorStop(1, color + 'f2');
    } else {
      // vertical bars: full on top (value end), subtle fade at base
      g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      g.addColorStop(0, color + 'f2');
      g.addColorStop(1, color + 'b0');
    }
    return g;
  };
}

// Area fill: opaque near the line, transparent at the bottom.
function makeAreaGradient(color: string) {
  return (ctx: ChartJsCtx) => {
    const chart = ctx.chart;
    const { ctx: cx, chartArea } = chart;
    if (!chartArea) return color + '28';
    const g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, color + '50');
    g.addColorStop(1, color + '00');
    return g;
  };
}

// The datasets plus the category labels Chart.js should draw them against —
// gauge, histogram and boxplot all replace the labels with their own.
// Locals are destructured under their ORIGINAL names so every family block below
// is the same code it was inside buildChart.
function buildChartDatasets(c: ChartCtx): { datasets: any[]; chartLabels: any[] } | null {
  // Waterfall / bullet / calendar / radar / Pareto: chartFamiliesExtra.js.
  if (isExtraFamily(c)) return buildExtraDatasets(c);
  const {
    canvas, labels, series, opts, overrides, palette, fmt, lineTension,
    gridColor, surfColor, fontFamily,
    isGauge, isTreemap, isMatrix, isRound, isScatter, isBubble, isFunnel,
    isHistogram, isSankey, isCandlestick, isBoxplot, isLine, isHoriz,
  } = c;

  let datasets: any[];   // Chart.js dataset objects — shape differs per chart family
  let chartLabels = labels;
  if (isGauge) {
    // Half-circle gauge: the first numeric value drawn against a sensible max,
    // as a 2-slice doughnut (filled arc + faint track). Single_metric finally
    // gets a visual. Degrades to value-vs-1 / value-vs-niceCeil when no total.
    const niceCeil = (v: number): number => {
      if (!(v > 0)) return 1;
      const mag = Math.pow(10, Math.floor(Math.log10(v)));
      const n = v / mag;
      const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
      return step * mag;
    };
    const gv = series[0].values.find((v: any) => typeof v === 'number');
    const value = gv == null ? 0 : gv;
    const gmax = (value >= 0 && value <= 1) ? 1 : niceCeil(Math.abs(value));
    const filled = Math.max(0, Math.min(value, gmax));
    datasets = [{
      data: [filled, Math.max(gmax - filled, 0)],
      backgroundColor: [palette[0], gridColor],
      borderColor: surfColor,
      borderWidth: 0,
      hoverOffset: 0,
    }];
    chartLabels = [series[0].name || 'Value', ''];
    opts._gaugeValue = value;   // for the center-label plugin
    opts._gaugeLabel = series[0].name || (labels && labels[0]) || '';   // metric name
  } else if (isTreemap) {
    // Flat treemap of the first series: rectangle area ∝ value, labelled inside.
    const tree = labels.map((lab: any, i: number) => ({
      _label: lab,
      value: typeof series[0].values[i] === 'number' ? Math.abs(series[0].values[i]) : 0,
    }));
    const treePalette = interpolatePalette(palette, tree.length);
    datasets = [{
      tree,
      key: 'value',
      borderWidth: 1,
      borderColor: surfColor,
      spacing: 1,
      backgroundColor: (ctx: ChartJsCtx) => ctx.type === 'data' ? treePalette[ctx.dataIndex % treePalette.length] : 'transparent',
      labels: {
        display: true,
        color: '#ffffff',
        font: { family: fontFamily, size: 11, weight: '600' },
        formatter: (ctx: ChartJsCtx) => {
          const d = ctx.raw && ctx.raw._data;
          return d ? [String(d._label), fmt(d.value)] : '';
        },
      },
    }];
  } else if (isMatrix) {
    // Heatmap: rows = labels, cols = series; cell color = value intensity (accent alpha).
    // Period dropdown filters columns by dropping hidden series before building cells.
    const hiddenSet = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
    const visSeries = series.filter((_: ChartSeriesShape, j: number) => !hiddenSet.has(j));
    const useSeries = visSeries.length ? visSeries : series;   // never empty
    const cols = useSeries.map((s: ChartSeriesShape) => s.name || '');
    let vmin = Infinity, vmax = -Infinity;
    useSeries.forEach((s: ChartSeriesShape) => s.values.forEach((v: any) => { if (typeof v === 'number') { if (v < vmin) vmin = v; if (v > vmax) vmax = v; } }));
    if (!isFinite(vmin)) { vmin = 0; vmax = 1; }
    const span = (vmax - vmin) || 1;
    const accent = getCSSVar('--accent', canvas) || palette[0];
    const alphaHex = (f: number) => Math.round(Math.max(0, Math.min(1, f)) * 255).toString(16).padStart(2, '0');
    const heat = (v: any) => (typeof v === 'number') ? accent + alphaHex(0.15 + 0.85 * ((v - vmin) / span)) : gridColor;
    const cells: any[] = [];
    useSeries.forEach((s: ChartSeriesShape, j: number) => labels.forEach((lab: any, i: number) => cells.push({ x: cols[j], y: lab, v: s.values[i] })));
    datasets = [{
      data: cells,
      backgroundColor: (ctx: ChartJsCtx) => heat(ctx.raw && ctx.raw.v),
      borderColor: surfColor,
      borderWidth: 1,
      width: (ctx: ChartJsCtx) => { const a = ctx.chart.chartArea; return a ? a.width / cols.length - 2 : 20; },
      height: (ctx: ChartJsCtx) => { const a = ctx.chart.chartArea; return a ? a.height / labels.length - 2 : 20; },
    }];
    opts._matrixCols = cols;
    opts._matrixRows = labels;
    opts._matrixGrid = useSeries.map((s: ChartSeriesShape) => s.values);   // [colIdx][rowIdx] for value labels
    opts._matrixVmin = vmin;
    opts._matrixVmax = vmax;
  } else if (isRound) {
    datasets = [{
      data: series[0].values,
      backgroundColor: interpolatePalette(palette, labels.length),
      borderColor: surfColor,
      borderWidth: 3,
      hoverOffset: 6,
    }];
  } else if (isScatter) {
    if (series.length >= 2) {
      const xVals = series[0].values, yVals = series[1].values;
      datasets = [{
        label: series[0].name + ' vs ' + series[1].name,
        data: xVals.map((x: any, i: number) => ({ x, y: yVals[i] || 0 })),
        backgroundColor: palette[0] + 'cc', borderColor: palette[0], pointRadius: 5,
      }];
    } else {
      datasets = [{
        label: series[0].name || '',
        data: series[0].values.map((y: any, i: number) => ({ x: i, y })),
        backgroundColor: palette[0] + 'cc', borderColor: palette[0], pointRadius: 5,
      }];
    }
  } else if (isBubble) {
    // 3-var relational: x=series0, y=series1, r=scaled(series2). Degrades to a
    // scatter-with-size when only 2 series, or value-vs-index with one.
    const sx = series[0].values;
    const sy = series[1] ? series[1].values : null;
    const sz = series[2] ? series[2].values : null;
    const sizes = (sz || []).filter((v: any) => typeof v === 'number');
    // reduce, not Math.min/max(...sizes): a raw scatter/bubble over a >130k-row
    // combined dataset passes one value per row, and argument-spread that wide
    // throws RangeError (chart fails to render). Same guard as transforms/metricValue.
    const zmin = sizes.length ? sizes.reduce((a: number, b: number) => (b < a ? b : a)) : 0;
    const zmax = sizes.length ? sizes.reduce((a: number, b: number) => (b > a ? b : a)) : 0;
    const rOf = (v: any): number => {
      if (typeof v !== 'number') return 8;
      if (zmax === zmin) return 14;
      return 6 + ((v - zmin) / (zmax - zmin)) * 20;  // px radius 6–26
    };
    const pts = labels.map((_: any, i: number) => ({
      x: sy ? (typeof sx[i] === 'number' ? sx[i] : 0) : i,
      y: sy ? (typeof sy[i] === 'number' ? sy[i] : 0)
            : (typeof sx[i] === 'number' ? sx[i] : 0),
      r: sz ? rOf(sz[i]) : 12,
    }));
    datasets = [{
      label: series.map((s: ChartSeriesShape) => s.name).filter(Boolean).join(' · ') || '',
      data: pts,
      backgroundColor: palette[0] + 'cc',
      borderColor: palette[0],
    }];
  } else if (isFunnel) {
    // Centered funnel: a transparent left "spacer" stack pushes each value bar to
    // the middle, so widths read as a funnel narrowing down the stages.
    const vals = series[0].values.map((v: any) => typeof v === 'number' ? Math.abs(v) : 0);
    const maxV = vals.reduce((a: number, b: number) => (b > a ? b : a), 0) || 1; // reduce, not spread (see zmin/zmax above)
    datasets = [
      { data: vals.map((v: number) => (maxV - v) / 2), backgroundColor: 'transparent', borderWidth: 0, stack: 'f' },
      {
        label: series[0].name || 'Value',
        data: vals,
        backgroundColor: vals.map((_: number, i: number) => palette[i % palette.length]),
        borderWidth: 0, borderRadius: 4, stack: 'f',
      },
    ];
    opts._funnelMax = maxV;
    opts._funnelVals = vals;
  } else if (isHistogram) {
    // Distribution of the first numeric series, binned into touching columns.
    const bins = histogramBins(series[0].values.filter((v: any) => typeof v === 'number'));
    chartLabels = bins.labels;
    datasets = [{
      label: 'Count',
      data: bins.counts,
      backgroundColor: makeBarGradient(palette[0], isHoriz),
      borderColor: 'transparent', borderWidth: 0, borderRadius: 3,
      barPercentage: 1.0, categoryPercentage: 1.0,
    }];
  } else if (isSankey) {
    // We don't carry true flow data, so render a fan-in: each category flows into
    // a single "Total" node, widths ∝ value. Like maps, a grouped (multi-series)
    // sankey shows ONE period at a time (default: latest) — switched via the period
    // dropdown, not split into small multiples.
    const pIdx = Number.isInteger(overrides.periodIdx)
      ? Math.max(0, Math.min(overrides.periodIdx, series.length - 1))
      : series.length - 1;
    const vals = (series[pIdx] || series[0]).values;
    const flows = labels
      .map((lab: any, i: number) => ({ from: String(lab), to: 'Total', flow: typeof vals[i] === 'number' ? Math.abs(vals[i]) : 0 }))
      .filter((f: { flow: number }) => f.flow > 0);
    datasets = [{
      data: flows,
      colorFrom: (c: ChartJsCtx) => palette[c.dataIndex % palette.length],
      colorTo: () => palette[palette.length - 1],
      colorMode: 'gradient',
      borderWidth: 0,
    }];
  } else if (isCandlestick) {
    // OHLC if there are >=4 series (open/high/low/close); otherwise synthesize a
    // candle from the single series + its previous value so it still renders.
    const get = (idx: number, i: number) => (series[idx] && typeof series[idx].values[i] === 'number') ? series[idx].values[i] : null;
    const pts = labels.map((lab: any, i: number) => {
      let o: number | null, h: number | null, l: number | null, c: number | null;
      if (series.length >= 4) { o = get(0, i); h = get(1, i); l = get(2, i); c = get(3, i); }
      else {
        c = get(0, i);
        const prev = i > 0 ? get(0, i - 1) : c;
        o = (prev == null) ? c : prev;
        h = Math.max(o == null ? 0 : o, c == null ? 0 : c);
        l = Math.min(o == null ? 0 : o, c == null ? 0 : c);
      }
      return { x: String(lab), o, h, l, c };
    });
    const up = getCSSVar('--ok', canvas) || '#16a34a';
    const down = getCSSVar('--error', canvas) || '#dc2626';
    datasets = [{
      label: 'OHLC',
      data: pts,
      color: { up, down, unchanged: palette[0] },
      borderColor: { up, down, unchanged: palette[0] },
    }];
  } else if (isBoxplot) {
    // One box per series, computed from that series' values across all rows. The
    // Series dropdown filters boxes; boxplot is a single dataset, so (like the
    // heatmap) we drop hidden series here rather than via setDatasetVisibility.
    const hiddenSet = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
    const visSeries = series.filter((_: ChartSeriesShape, j: number) => !hiddenSet.has(j));
    const useSeries = visSeries.length ? visSeries : series;
    const cols = useSeries.map((s: ChartSeriesShape) => s.name || '');
    chartLabels = cols;
    datasets = [{
      label: 'Distribution',
      data: useSeries.map((s: ChartSeriesShape) => s.values.filter((v: any) => typeof v === 'number')),
      backgroundColor: palette[0] + '55',
      borderColor: palette[0],
      borderWidth: 1,
      itemRadius: 2,
      outlierBackgroundColor: palette[4 % palette.length],
    }];
  } else if (isLine) {
    datasets = series.map((s: ChartSeriesShape, i: number) => ({
      label: s.name || '',
      data: s.values,
      borderColor: palette[i % palette.length],
      backgroundColor: opts.fill ? makeAreaGradient(palette[i % palette.length]) : 'transparent',
      borderWidth: 2.2,
      fill: opts.fill ? (opts.stacked && i > 0 ? '-1' : true) : false,
      tension: lineTension,
      pointRadius: opts.markers ? 3 : 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: palette[i % palette.length],
      pointHoverBorderColor: surfColor,
      pointHoverBorderWidth: 2,
    }));
  } else {
    // bars / columns (including pct-stacked)
    const buildBarData = (s: ChartSeriesShape, i: number) => {
      if (opts.pct) {
        const totals = labels.map((_: any, j: number) => series.reduce((sum: number, ss: ChartSeriesShape) => sum + (ss.values[j] || 0), 0));
        return s.values.map((v: any, j: number) => totals[j] ? Math.round((v / totals[j]) * 100) : 0);
      }
      return s.values;
    };
    if (opts.combo && series.length >= 2) {
      // Mixed chart: first series as columns, the rest as lines on a 2nd y-axis.
      datasets = series.map((s: ChartSeriesShape, i: number) => i === 0
        ? {
            label: s.name || '',
            data: buildBarData(s, i),
            backgroundColor: makeBarGradient(palette[0], isHoriz),
            borderColor: 'transparent', borderWidth: 0, borderRadius: 7,
            barPercentage: 0.65, categoryPercentage: 0.8, order: 2,
          }
        : {
            type: 'line',
            label: s.name || '',
            data: s.values,
            yAxisID: 'y1',
            borderColor: palette[i % palette.length],
            backgroundColor: palette[i % palette.length],
            borderWidth: 2.2, tension: lineTension,
            pointRadius: 3, pointHoverRadius: 5,
            fill: false, order: 1,
          });
    } else {
      datasets = series.map((s: ChartSeriesShape, i: number) => ({
        label: s.name || '',
        data: buildBarData(s, i),
        backgroundColor: makeBarGradient(palette[i % palette.length], isHoriz),
        borderColor: 'transparent',
        borderWidth: 0,
        borderRadius: 7,
        barPercentage: 0.65,
        categoryPercentage: 0.8,
      }));
    }
  }

  return { datasets, chartLabels };
}
