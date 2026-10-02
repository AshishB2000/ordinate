'use strict';

// The workbench's own plots, drawn with Chart.js directly (the app's chart
// stack): a scatter with its fit line, residuals against fitted values, a
// normal QQ plot, a histogram with its normal curve, and group means. Every
// coordinate arrives computed by main; this file only maps them to marks.
// Colours are the theme's chart tokens, read off the canvas once it is in the
// document (getComputedStyle on a detached node returns nothing).

const swCharts: any[] = [];

function swDestroyCharts(): void {
  while (swCharts.length) {
    const c = swCharts.pop();
    try { c.destroy(); } catch (_) { /* already gone */ }
  }
}

/** A titled chart frame; returns the canvas to draw on. */
function swChartFrame(host: HTMLElement, title: string, caption: string, tall?: boolean): HTMLCanvasElement {
  const fig = document.createElement('figure');
  fig.className = 'sw-fig' + (tall ? ' sw-fig--tall' : '');
  const cap = document.createElement('figcaption');
  cap.className = 'sw-fig-cap';
  const t = document.createElement('span');
  t.className = 'sw-fig-title';
  t.textContent = title;
  cap.appendChild(t);
  if (caption) {
    const c = document.createElement('span');
    c.className = 'sw-fig-note';
    c.textContent = caption;
    cap.appendChild(c);
  }
  const box = document.createElement('div');
  box.className = 'sw-fig-box';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', title + (caption ? ' — ' + caption : ''));
  box.appendChild(canvas);
  fig.append(cap, box);
  host.appendChild(fig);
  return canvas;
}

function swTheme(el: Element): { c1: string; c2: string; line: string; muted: string; grid: string; text: string } {
  return {
    c1: getCSSVar('--chart-1', el) || '#2563eb',
    c2: getCSSVar('--chart-4', el) || '#6366f1',
    line: getCSSVar('--chart-6', el) || '#b45309',
    muted: getCSSVar('--muted', el) || '#6b7280',
    grid: getCSSVar('--border', el) || '#e5e7eb',
    text: getCSSVar('--text', el) || '#18181b',
  };
}

function swAxes(th: ReturnType<typeof swTheme>, xTitle: string, yTitle: string, xLinear: boolean): any {
  const axis = (title: string, linear: boolean): any => ({
    type: linear ? 'linear' : 'category',
    title: { display: !!title, text: title, color: th.muted, font: { size: 11 } },
    ticks: { color: th.muted, font: { size: 11 }, maxTicksLimit: 8 },
    grid: { color: th.grid },
    border: { color: th.grid },
  });
  return { x: axis(xTitle, xLinear), y: axis(yTitle, true) };
}

function swMake(canvas: HTMLCanvasElement, config: any): any {
  const Chart = (window as any).Chart; // any: the Chart.js UMD global
  if (!Chart) return null;
  config.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false }, config.options);
  const chart = new Chart(canvas, config);
  swCharts.push(chart);
  return chart;
}

const swXY = (x: number[], y: number[]): Array<{ x: number; y: number }> => x.map((v, i) => ({ x: v, y: y[i] }));

/** The pair's points and its least-squares line, across the observed x range. */
function swScatterFit(host: HTMLElement, pair: any): any {
  const canvas = swChartFrame(host, `${pair.y} against ${pair.x}`,
    pair.shown < pair.n ? t('statsCharts.of_points_shown_evenly_thinned', { p0: pair.shown.toLocaleString('en-US'), p1: pair.n.toLocaleString('en-US') }) : `${pair.n.toLocaleString('en-US')} points`, true);
  const th = swTheme(canvas);
  const xs: number[] = pair.points.x;
  const datasets: any[] = [{ type: 'scatter', label: t('common.rows'), data: swXY(xs, pair.points.y), backgroundColor: th.c1, pointRadius: 2.5, pointHoverRadius: 4 }];
  if (pair.fit && xs.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of xs) { if (v < lo) lo = v; if (v > hi) hi = v; }
    datasets.push({
      type: 'line', label: t('common.fit'), data: [{ x: lo, y: pair.fit.intercept + pair.fit.slope * lo }, { x: hi, y: pair.fit.intercept + pair.fit.slope * hi }],
      borderColor: th.line, borderWidth: 2, pointRadius: 0, fill: false,
    });
  }
  return swMake(canvas, { type: 'scatter', data: { datasets }, options: { scales: swAxes(th, pair.x, pair.y, true), plugins: { legend: { display: false } } } });
}

function swResidualPlot(host: HTMLElement, fitted: number[], residual: number[]): any {
  const canvas = swChartFrame(host, t('statsCharts.residuals_vs_fitted'), t('statsCharts.a_shapeless_band_around_zero_is'));
  const th = swTheme(canvas);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of fitted) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return swMake(canvas, {
    type: 'scatter',
    data: {
      datasets: [
        { type: 'scatter', label: t('statsCharts.residual'), data: swXY(fitted, residual), backgroundColor: th.c1, pointRadius: 2 },
        { type: 'line', label: t('statsCharts.zero'), data: [{ x: lo, y: 0 }, { x: hi, y: 0 }], borderColor: th.line, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0 },
      ],
    },
    options: { scales: swAxes(th, t('statsCharts.fitted_value'), t('statsCharts.residual'), true), plugins: { legend: { display: false } } },
  });
}

function swQQPlot(host: HTMLElement, theoretical: number[], sample: number[]): any {
  const canvas = swChartFrame(host, t('statsCharts.normal_q_q'), t('statsCharts.standardised_residuals_against_normal'));
  const th = swTheme(canvas);
  const lo = theoretical.length ? Math.min(theoretical[0], sample[0]) : -3;
  const hi = theoretical.length ? Math.max(theoretical[theoretical.length - 1], sample[sample.length - 1]) : 3;
  return swMake(canvas, {
    type: 'scatter',
    data: {
      datasets: [
        { type: 'scatter', label: t('statsCharts.residual'), data: swXY(theoretical, sample), backgroundColor: th.c2, pointRadius: 2 },
        { type: 'line', label: t('statsCharts.normal'), data: [{ x: lo, y: lo }, { x: hi, y: hi }], borderColor: th.line, borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: { scales: swAxes(th, t('statsCharts.theoretical_quantile'), t('statsCharts.sample_quantile'), true), plugins: { legend: { display: false } } },
  });
}

function swHistogram(host: HTMLElement, column: string, h: any): any {
  const canvas = swChartFrame(host, t('common.distribution_of', { column }), t('statsCharts.bars_are_counts_the_line_is'), true);
  const th = swTheme(canvas);
  return swMake(canvas, {
    type: 'bar',
    data: {
      labels: h.labels,
      datasets: [
        { type: 'bar', label: t('common.count'), data: h.counts, backgroundColor: th.c1, borderRadius: 3, barPercentage: 0.96, categoryPercentage: 0.96, order: 2 },
        { type: 'line', label: t('statsCharts.normal_curve'), data: h.normal, borderColor: th.line, borderWidth: 2, pointRadius: 0, tension: 0.35, order: 1 },
      ],
    },
    options: {
      scales: swAxes(th, column, t('common.count'), false),
      plugins: { legend: { display: true, labels: { color: th.muted, boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

function swMeansBar(host: HTMLElement, outcome: string, groups: any[]): any {
  const canvas = swChartFrame(host, t('statsCharts.average_by_group', { outcome }), '');
  const th = swTheme(canvas);
  return swMake(canvas, {
    type: 'bar',
    data: { labels: groups.map((g) => g.label), datasets: [{ label: t('statsCharts.mean', { outcome }), data: groups.map((g) => g.mean), backgroundColor: th.c1, borderRadius: 4, maxBarThickness: 56 }] },
    options: { scales: swAxes(th, '', t('statsCharts.mean', { outcome }), false), plugins: { legend: { display: false } } },
  });
}
