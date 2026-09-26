// A chart's axes — the two axis makers, the per-family axis set, and the two
// overrides that reach into it afterwards (start-at-zero, axis titles).
//
// Six families want six different axis sets and three want none at all
// (pie/donut/treemap/sankey have no scales), so this cannot be one literal. What
// it can be is one place: every `scales` key any chart ever gets is written
// here, which is what makes "why is this gridline showing?" answerable by
// reading a single function.
//
// Reads the per-family state chartDatasets left on `opts` (_matrixCols/_matrixRows
// for the heatmap's category axes, _funnelMax to pin the funnel's hidden value
// axis), so it must run AFTER buildChartDatasets.
//
// Loads after chartTypeSpec.js, before chartRender.js. Classic global-scope
// script — NO import/export.

// `any` throughout: each branch builds a DIFFERENT axis set (x/y, x only,
// neither), and the override blocks after it add `y1`, `title`, `beginAtZero`
// and `min` to whichever axes exist. Inferring a union of the branch literals
// makes every one of those later writes an error on the branches that lack the
// key, which is a description of Chart.js's option bag being open, not a bug to
// fix here. Locals are destructured under their ORIGINAL names so each branch is
// the same code it was inside buildChart.
function buildChartScales(c: ChartCtx): any {
  const {
    labels, series, opts, overrides, fmt, textColor, gridColor, tickFont, showGridlines,
    isRound, isTreemap, isSankey, isCandlestick, isMatrix, isFunnel, isScatter, isBubble, isHoriz,
  } = c;

  // Value axis: faint horizontal gridlines, no frame border.
  // `any` return: the axis object grows a `title`, `beginAtZero` and `min` later
  // (see the override blocks below), and a literal's inferred type would freeze
  // the shape at what the first branch happens to set.
  const makeValueAxis = (stacked: boolean, pct: boolean): any => ({
    stacked: stacked || false,
    ticks: {
      color: textColor, font: tickFont, padding: 6,
      // Readable axis numbers: thousands separators + K/M/B abbreviations.
      callback: pct ? ((v: any) => v + '%') : ((v: any) => fmt(v)),
    },
    grid: { color: gridColor, lineWidth: 1, display: showGridlines },
    border: { display: false },
    ...(pct ? { min: 0, max: 100 } : {}),
  });

  // Category axis: no gridlines, no frame border.
  // Tick labels drop a redundant " County" suffix for legibility; tooltips and
  // the data table still show the full label (they read data.labels directly).
  const makeCategoryAxis = (stacked: boolean, rotate: boolean): any => ({
    stacked: stacked || false,
    ticks: {
      color: textColor, font: tickFont, padding: 4,
      ...(rotate ? { maxRotation: 40 } : {}),
      callback(value: any) {
        const label = (this as any).getLabelForValue(value); // ponytail: Chart.js scale `this`
        return typeof label === 'string' ? label.replace(/ County$/i, '') : label;
      },
    },
    grid: { display: false },
    border: { display: false },
  });

  let scales: any;
  if (isExtraFamily(c)) {
    // Waterfall / bullet / calendar / radar / Pareto: chartFamiliesExtra.js,
    // with these two makers so their axes read like every other chart's.
    scales = buildExtraScales(c, makeValueAxis, makeCategoryAxis);
  } else if (isRound || isTreemap || isSankey) {
    scales = {};
  } else if (isCandlestick) {
    // category x (avoids needing a date adapter) + linear value axis
    scales = {
      x: { type: 'category', labels, offset: true, grid: { display: false },
           ticks: { color: textColor, font: tickFont, maxRotation: 40 }, border: { display: false } },
      y: makeValueAxis(false, false),
    };
  } else if (isMatrix) {
    // category axes; offset centers the cells, reverse puts the first row on top
    const catTick = { color: textColor, font: tickFont, padding: 4 };
    scales = {
      x: { type: 'category', labels: opts._matrixCols, offset: true, grid: { display: false }, ticks: catTick, border: { display: false } },
      y: { type: 'category', labels: opts._matrixRows, offset: true, reverse: true, grid: { display: false }, ticks: catTick, border: { display: false } },
    };
  } else if (isFunnel) {
    // hidden value axis (fixed to max so bars stay centered); category axis = stages
    scales = {
      x: { stacked: true, max: opts._funnelMax, display: false, grid: { display: false }, border: { display: false } },
      y: makeCategoryAxis(false, false),
    };
  } else if (isScatter || isBubble) {
    // scatter / bubble: both axes are value axes with light grid
    const valTick = { color: textColor, font: tickFont, padding: 6, callback: (v: any) => fmt(v) };
    scales = {
      x: { ticks: valTick, grid: { color: gridColor, lineWidth: 1 }, border: { display: false } },
      y: { ticks: valTick, grid: { color: gridColor, lineWidth: 1 }, border: { display: false } },
    };
  } else if (isHoriz) {
    // horizontal bars: x = value axis (gridlines useful), y = category axis
    scales = {
      x: makeValueAxis(opts.stacked, opts.pct),
      y: makeCategoryAxis(opts.stacked, false),
    };
  } else {
    // vertical bars / lines: x = category axis, y = value axis
    scales = {
      x: makeCategoryAxis(opts.stacked, true),
      y: makeValueAxis(opts.stacked, opts.pct),
    };
    if (opts.combo && series.length >= 2) {
      // secondary axis on the right for the line series; no gridlines of its own
      scales.y1 = {
        position: 'right',
        ticks: { color: textColor, font: tickFont, padding: 6, callback: (v: any) => fmt(v) },
        grid: { drawOnChartArea: false, display: false },
        border: { display: false },
      };
    }
  }

  // Y-axis "start at zero" override → the value axis (y for vertical, x for horizontal).
  // Not for a calendar: its y is the weekday grid, pinned to -0.5..6.5.
  if (overrides.yZero !== undefined && !c.isCalendar) {
    const valueAxis = isHoriz ? scales.x : scales.y;
    if (valueAxis) {
      valueAxis.beginAtZero = !!overrides.yZero;
      if (overrides.yZero) valueAxis.min = 0; else delete valueAxis.min;
    }
  }

  // ── Axis titles from overrides ────────────────────────────────────────────
  if (!isRound && !isScatter && scales.x && overrides.xAxisLabel) {
    scales.x.title = { display: true, text: overrides.xAxisLabel, color: textColor, font: tickFont };
  }
  if (!isRound && scales.y && overrides.yAxisLabel) {
    scales.y.title = { display: true, text: overrides.yAxisLabel, color: textColor, font: tickFont };
  }
  if (isScatter) {
    if (overrides.xAxisLabel) scales.x.title = { display: true, text: overrides.xAxisLabel, color: textColor, font: tickFont };
    if (overrides.yAxisLabel) scales.y.title = { display: true, text: overrides.yAxisLabel, color: textColor, font: tickFont };
  }

  return scales;
}
