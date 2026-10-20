'use strict';

// The published site's renderer, PURE half — no DOM. Inlined (with
// publishClient.js, the app's Chart.js, format.js and geoMatch.js) into every
// page Publish writes (src/publish/siteHtml.ts). A classic script: every name
// is prefixed `pk` so it cannot collide with the hub's globals in the shared
// renderer program.
//
// NOTHING HERE COMPUTES A FIGURE. Every number was computed by the app and
// arrives in the page's data — a waterfall's levels, a Pareto's order and
// cumulative share, a 100%-stacked chart's shares and a histogram's bins as the
// payload's `figures` (src/analysis/chartShapes.ts), the same the app draws.
// This file picks which answer to show for the filter bar's state, lays it out,
// and turns it into a Chart.js config. The only arithmetic is presentational:
// a map's projection, a colour ramp, pixels.

/** The combination index for a set of option picks, or -1. */
function pkComboIndex(keys: string[], picks: number[]): number {
  return keys.indexOf(picks.join('.'));
}

/**
 * The picks after control `changed` moved to `value`. In 'single' mode a site
 * only carries states that differ from the default in ONE control, so moving
 * one resets the others; in 'all' mode the others stay.
 */
function pkNextPicks(mode: string, defaults: number[], picks: number[], changed: number, value: number): number[] {
  const next = mode === 'single' ? defaults.slice() : picks.slice();
  next[changed] = value;
  return next;
}

/** The answer a card shows for a combination (or its first, for a missing index). */
function pkPayload(card: any, combo: number): any {
  const v = Array.isArray(card.variants) ? card.variants[combo] : undefined;
  const i = typeof v === 'number' ? v : 0;
  return Array.isArray(card.payloads) ? card.payloads[i] : undefined;
}

/**
 * A dashboard sheet on a phone (docs/phone-dashboards): its tiles in the phone
 * layout's order — each card's phone cell read row by row, then left to right;
 * a card hidden on a phone left out; a card with no phone cell after the rest,
 * in desktop order — with every run of consecutive KPI cards folded into one
 * swipeable strip. A lone KPI stays a card. Cards are named by their INDEX in
 * the sheet (a published card carries no id: sanitize.ts's whitelist). The app
 * folds the same way (web/src/features/dashboards/phone/phoneBlocks.ts; its
 * test compares the two).
 */
function pkPhoneBlocks(cards: any[]): Array<{ kind: 'strip'; at: number[] } | { kind: 'card'; at: number }> {
  const key = (c: any): [number, number, number] => {
    const p = c.sizes && c.sizes.phone;
    return p && !p.hidden ? [0, p.y, p.x] : [1, c.layout.y, c.layout.x];
  };
  const order = cards
    .map((c, i) => ({ c, k: key(c), i }))
    .filter((e) => !(e.c.sizes && e.c.sizes.phone && e.c.sizes.phone.hidden))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.i - b.i);
  const out: Array<{ kind: 'strip'; at: number[] } | { kind: 'card'; at: number }> = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length > 1) out.push({ kind: 'strip', at: run });
    else if (run.length) out.push({ kind: 'card', at: run[0] });
    run = [];
  };
  for (const { c, i } of order) {
    if (c.kind === 'metric') { run.push(i); continue; }
    flush();
    out.push({ kind: 'card', at: i });
  }
  flush();
  return out;
}

/** Chart types drawn as a table here (the app draws them with plugins a page does not carry). */
const PK_TABLE_TYPES = ['treemap', 'heatmap', 'sankey', 'candlestick', 'boxplot', 'bullet', 'calendar', 'table'];

function pkRenderKind(chartType: string): 'chart' | 'table' | 'pivot' | 'map' | 'gauge' {
  if (chartType === 'pivot') return 'pivot';
  if (chartType === 'map_choropleth' || chartType === 'map_bubble' || chartType === 'map_hexbin' || chartType === 'map_flow') return 'map';
  if (chartType === 'gauge') return 'gauge';
  if (PK_TABLE_TYPES.indexOf(chartType) >= 0) return 'table';
  return 'chart';
}

/** A palette of `n` colours from the brand ramp, cycling with lighter repeats. */
function pkPalette(ramp: string[], n: number): string[] {
  const base = ramp.length ? ramp : ['#2563eb', '#0e7490', '#14b8a6', '#6366f1', '#64748b'];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(base[i % base.length]);
  return out;
}

/** `{labels, series}` as a table model: a header row, then one row per label. */
function pkTableModel(payload: any, categoryName: string): { head: string[]; rows: Array<Array<string | number | null>> } {
  const labels: any[] = payload && Array.isArray(payload.labels) ? payload.labels : [];
  const series: any[] = payload && Array.isArray(payload.series) ? payload.series : [];
  const head = [categoryName || ''].concat(series.map((s) => String(s.label || '')));
  const rows = labels.map((l, i) => [l as string | number].concat(series.map((s) => (Array.isArray(s.values) ? s.values[i] ?? null : null))));
  return { head, rows };
}

/** Which of the payload's `figures` a chart id draws; without it the chart is not drawn at all. */
const PK_FIGURES: Record<string, string> = { waterfall: 'waterfall', pareto: 'pareto', pct_stacked_column: 'sharePct', pct_stacked_bar: 'sharePct', histogram: 'histogram' };
/** A waterfall's rises and falls — the app's own fallbacks for its --ok / --error tokens. */
const PK_UP = '#16a34a';
const PK_DOWN = '#e11d48';

/**
 * The Chart.js config for one of the app's chart ids — with `src`, each drawn
 * category's index in the payload's labels (-1: a bar of its own, like a
 * waterfall's closing Total), where the drawn order is not the labels' — or null when the payload
 * lacks the figures that id draws (a page published before they existed): the
 * card then says so, and nothing is worked out here. `fmt` renders a tick /
 * tooltip number the workspace's way (OrdFormat in the page); `shown` names the
 * labels as the axis draws them (a month as "Jan 2023").
 */
function pkChartConfig(
  chartType: string, payload: any, ramp: string[], fmt: (v: number) => string,
  shown: (labels: any[]) => any[] = (l) => l, share: (v: number) => string = (v) => v + '%',
): any {
  const raw: any[] = Array.isArray(payload && payload.labels) ? payload.labels : [];
  const labels: any[] = shown(raw);
  const series: any[] = Array.isArray(payload && payload.series) ? payload.series : [];
  const figures: any = (payload && payload.figures) || {};
  if (PK_FIGURES[chartType] && !figures[PK_FIGURES[chartType]]) return null;
  const colors = pkPalette(ramp, Math.max(series.length, labels.length));
  const horizontal = /(^|_)bar$/.test(chartType) || chartType === 'funnel';
  const stacked = chartType.indexOf('stacked') >= 0;
  const pct = chartType.indexOf('pct_') === 0;
  const tick = { callback: (v: any) => (typeof v === 'number' ? fmt(v) : v) };
  // The app's axes (web/src/charts/scales.ts): no frame, no gridlines down from the categories, a label tilted at most 40°.
  const catAxis = (extra: any = {}): any => ({ grid: { display: false }, border: { display: false }, ticks: { maxRotation: 40 }, ...extra });
  const valAxis = (extra: any = {}): any => ({ border: { display: false }, ticks: tick, ...extra });
  const tooltip = { callbacks: { label: (c: any) => `${c.dataset.label ? c.dataset.label + ': ' : ''}${fmt(Number(c.raw && typeof c.raw === 'object' ? c.raw.y : c.raw))}` } };
  const base = { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: series.length > 1 }, tooltip } };

  if (chartType === 'pie' || chartType === 'donut') {
    const s = series[0] || { label: '', values: [] };
    return {
      type: chartType === 'donut' ? 'doughnut' : 'pie',
      data: { labels, datasets: [{ label: s.label, data: s.values, backgroundColor: colors }] },
      options: { ...base, plugins: { legend: { display: true, position: 'right' }, tooltip } },
    };
  }
  if (chartType === 'radar') {
    return {
      type: 'radar',
      data: { labels, datasets: series.map((s, i) => ({ label: s.label, data: s.values, borderColor: colors[i], backgroundColor: colors[i] + '33' })) },
      options: { ...base, scales: { r: { ticks: tick } } },
    };
  }
  if (chartType === 'scatter' || chartType === 'bubble') {
    const s = series[0] || { label: '', values: [] };
    const size = series[1];
    const points = labels.map((l, i) => ({
      x: typeof l === 'number' ? l : i,
      y: s.values[i],
      ...(chartType === 'bubble' ? { r: Math.max(3, Math.min(24, Math.sqrt(Math.abs(Number(size ? size.values[i] : 1)) || 1))) } : {}),
    }));
    return {
      type: chartType,
      data: { datasets: [{ label: s.label, data: points, backgroundColor: colors[0] + 'aa' }] },
      options: { ...base, scales: { x: { ticks: tick }, y: { ticks: tick } } },
    };
  }
  if (chartType === 'waterfall') {
    // The server's steps: each bar from its start to its end, a total from 0; a step names its category by index.
    const steps: any[] = figures.waterfall.steps || [];
    return {
      type: 'bar',
      data: {
        labels: steps.map((x) => (x.src >= 0 && x.src < labels.length ? labels[x.src] : x.label)),
        datasets: [{
          label: series[0] ? series[0].label : '', data: steps.map((x) => [x.start, x.end]),
          backgroundColor: steps.map((x) => (x.kind === 'up' ? PK_UP : x.kind === 'down' ? PK_DOWN : colors[0])),
        }],
      },
      options: { ...base, plugins: { legend: { display: false }, tooltip }, scales: { x: catAxis(), y: valAxis() } },
      plugins: [pkValueLabels((ds, j) => {
        // A waterfall's totals always; of its rises and falls, the largest and the smallest — signed (the app's rule).
        const x = steps[j];
        if (x.kind !== 'up' && x.kind !== 'down') return fmt(x.value);
        const moves = steps.map((y, k) => (y.kind === 'up' || y.kind === 'down' ? k : -1)).filter((k) => k >= 0);
        const vals = moves.map((k) => steps[k].value);
        return moves[pkArgOf(vals, 1)] === j || moves[pkArgOf(vals, -1)] === j ? (x.value > 0 ? '+' : '') + fmt(x.value) : '';
      }, (j) => steps[j].value)],
      src: steps.map((x) => x.src),
    };
  }
  if (chartType === 'pareto') {
    // The server's order (largest first) and cumulative share; the bars are the series' own figures in that order.
    const p = figures.pareto;
    const vals: any[] = series[0] && Array.isArray(series[0].values) ? series[0].values : [];
    return {
      type: 'bar',
      data: {
        labels: p.order.map((i: number) => labels[i]),
        datasets: [
          { type: 'bar', label: series[0] ? series[0].label : '', data: p.order.map((i: number) => (vals[i] === undefined ? null : vals[i])), backgroundColor: colors[0], order: 2 },
          { type: 'line', label: 'Cumulative %', data: p.cumPct, yAxisID: 'pct', borderColor: colors[1] || colors[0], backgroundColor: colors[1] || colors[0], pointRadius: 2, order: 1 },
        ],
      },
      options: { ...base, scales: { x: catAxis(), y: valAxis(), pct: { position: 'right', min: 0, max: 100, grid: { display: false }, border: { display: false }, ticks: { callback: (v: any) => v + '%' } } } },
      src: p.order,
    };
  }
  if (chartType === 'histogram') {
    // The server's bins for the first series: touching columns, each labelled by its edges.
    const bins: any[] = figures.histogram[0] || [];
    return {
      type: 'bar',
      data: {
        labels: bins.map((b) => (b.from === b.to ? fmt(b.from) : fmt(b.from) + '–' + fmt(b.to))),
        datasets: [{ label: 'Count', data: bins.map((b) => b.count), backgroundColor: colors[0], barPercentage: 1, categoryPercentage: 1 }],
      },
      options: { ...base, plugins: { legend: { display: false }, tooltip }, scales: { x: catAxis(), y: valAxis() } },
      plugins: [pkValueLabels(pkMaxMin(fmt))],
    };
  }
  const lineish = /line|area/.test(chartType);
  const datasets = series.map((s, i) => {
    // A 100%-stacked bar is the server's share of its category (figures.sharePct).
    const data: any[] = pct ? figures.sharePct[i] || [] : s.values;
    const asLine = lineish || (chartType === 'combo' && i > 0);
    return {
      type: asLine ? 'line' : 'bar',
      label: s.label,
      data,
      backgroundColor: asLine ? colors[i] + (chartType.indexOf('area') >= 0 ? '44' : '') : colors[i],
      borderColor: colors[i],
      fill: chartType.indexOf('area') >= 0 ? (stacked ? 'stack' : 'origin') : false,
      pointRadius: chartType === 'line_markers' ? 3 : lineish ? 0 : undefined,
      tension: lineish ? 0.25 : undefined,
      ...(chartType === 'histogram' ? { barPercentage: 1, categoryPercentage: 1 } : {}),
    };
  });
  const valueAxis = horizontal ? 'x' : 'y';
  // Only the VALUE axis gets the number formatter. An explicit `ticks:
  // undefined` on the category axis is not "use the default" to Chart.js — it
  // replaces the category callback and the axis prints indexes (0, 1, 2…).
  const scales: any = { [valueAxis]: valAxis({ stacked }), [horizontal ? 'y' : 'x']: catAxis({ stacked }) };
  if (pct) scales[valueAxis] = valAxis({ stacked, max: 100, ticks: { callback: (v: any) => v + '%' } });
  // The app's default value labels: each series' largest and smallest (a 100% bar's own share).
  const labelled = [pkValueLabels(pkMaxMin(pct ? share : fmt))];
  return {
    type: lineish ? 'line' : 'bar',
    data: { labels, datasets },
    options: { ...base, indexAxis: horizontal ? 'y' : 'x', scales },
    plugins: labelled.concat(horizontal ? [] : pkEventPlugins(payload)),
  };
}

/** The index of the largest (`dir` 1) or smallest (-1) number in `vals`, or -1 — a choice among figures, never a new one. */
function pkArgOf(vals: any[], dir: 1 | -1): number {
  let at = -1;
  vals.forEach((v, i) => { if (typeof v === 'number' && (at < 0 || (dir > 0 ? v > vals[at] : v < vals[at]))) at = i; });
  return at;
}

/** The app's default bar labels (valueMode 'maxmin'): a bar series' largest and smallest figure, in `text`. */
function pkMaxMin(text: (v: number) => string): (ds: any, j: number) => string {
  return (ds, j) => {
    const v = ds.data[j];
    return typeof v === 'number' && (pkArgOf(ds.data, 1) === j || pkArgOf(ds.data, -1) === j) ? text(v) : '';
  };
}

/**
 * A chart's value labels: `textAt(dataset, index)` says what a bar or point carries ('' for none); the
 * label sits past the bar's end (above a point), out of the way of the next. `valueAt` (a waterfall's step) says which way
 * the bar points when its data is a [from, to] pair. Pixel placement only.
 */
function pkValueLabels(textAt: (ds: any, j: number) => string, valueAt?: (j: number) => number): any {
  return {
    id: 'pkValueLabels',
    afterDatasetsDraw(chart: any) {
      const ctx = chart.ctx;
      const horiz = chart.options.indexAxis === 'y';
      ctx.save();
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillStyle = chart.options.color || '#6b7280';
      chart.data.datasets.forEach((ds: any, di: number) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden || ds.yAxisID === 'pct') return; // a Pareto's cumulative line is read off its own axis
        const line = meta.type === 'line' || ds.type === 'line';
        meta.data.forEach((el: any, j: number) => {
          const t = textAt(ds, j);
          if (!t || !el) return;
          const v = valueAt ? valueAt(j) : ds.data[j];
          const up = typeof v !== 'number' || v >= 0;
          if (line) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(t, el.x, el.y - 6);
          } else if (horiz) {
            ctx.textAlign = up ? 'left' : 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(t, up ? Math.max(el.x, el.base) + 4 : Math.min(el.x, el.base) - 4, el.y);
          } else {
            ctx.textAlign = 'center';
            ctx.textBaseline = up ? 'bottom' : 'top';
            ctx.fillText(t, el.x, up ? Math.min(el.y, el.base) - 4 : Math.max(el.y, el.base) + 4);
          }
        });
      });
      ctx.restore();
    },
  };
}

// r8:events — a chart's event markers, placed by main on label indices: a line
// for a single date, a shaded band for a range, the title along the top (a
// page has no hover to reveal it). Colours are the hub's kind colours.
const PK_EVENT_COLORS: Record<string, string> = { launch: '#2563eb', campaign: '#c77d11', incident: '#e11d48', holiday: '#059669', other: '#64748b' };

function pkEventPlugins(payload: any): any[] {
  const evs: any[] = payload && Array.isArray(payload.events) ? payload.events : [];
  if (!evs.length) return [];
  const geom = (chart: any, e: any): { l: number; r: number } | null => {
    const x = chart.scales && chart.scales.x;
    const a = chart.chartArea;
    if (!x || !a) return null;
    const n = Array.isArray(payload.labels) ? payload.labels.length : 0;
    const step = n > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : a.right - a.left;
    const l = x.getPixelForValue(e.from);
    const r = x.getPixelForValue(e.to);
    return e.range ? { l: Math.max(a.left, l - step / 2), r: Math.min(a.right, r + step / 2) } : { l, r: l };
  };
  return [{
    id: 'pkEvents',
    beforeDatasetsDraw(chart: any) {
      const a = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      for (const e of evs) {
        const g = geom(chart, e);
        if (!g) continue;
        ctx.fillStyle = ctx.strokeStyle = PK_EVENT_COLORS[e.kind] || PK_EVENT_COLORS.other;
        if (e.range) { ctx.globalAlpha = 0.1; ctx.fillRect(g.l, a.top, g.r - g.l, a.bottom - a.top); }
        else { ctx.globalAlpha = 0.7; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(g.l, a.top); ctx.lineTo(g.l, a.bottom); ctx.stroke(); ctx.setLineDash([]); }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart: any) {
      const a = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      evs.forEach((e: any, i: number) => {
        const g = geom(chart, e);
        if (!g) return;
        const t = String(e.title).length > 28 ? String(e.title).slice(0, 27) + '…' : String(e.title);
        ctx.fillStyle = PK_EVENT_COLORS[e.kind] || PK_EVENT_COLORS.other;
        const w = ctx.measureText(t).width;
        ctx.fillText(t, Math.max(a.left, Math.min(a.right - w, g.l + 3)), a.top + 2 + (i % 3) * 12);
      });
      ctx.restore();
    },
  }];
}

// ── Maps: projections (unit space, y down) ───────────────────────────────────

const PK_RAD = Math.PI / 180;

/** d3's conic equal-area raw projection, rotated and centred, in unit space. */
function pkConic(parallels: [number, number], rotate: number, center: [number, number]): (lng: number, lat: number) => [number, number] {
  const sy0 = Math.sin(parallels[0] * PK_RAD);
  const n = (sy0 + Math.sin(parallels[1] * PK_RAD)) / 2;
  const c = 1 + sy0 * (2 * n - sy0);
  const r0 = Math.sqrt(c) / n;
  const raw = (lam: number, phi: number): [number, number] => {
    const r = Math.sqrt(Math.max(0, c - 2 * n * Math.sin(phi))) / n;
    const x = lam * n;
    return [r * Math.sin(x), r0 - r * Math.cos(x)];
  };
  const ctr = raw((center[0]) * PK_RAD, center[1] * PK_RAD);
  return (lng: number, lat: number) => {
    let lam = (lng + rotate) * PK_RAD;
    if (lam > Math.PI) lam -= 2 * Math.PI;
    if (lam < -Math.PI) lam += 2 * Math.PI;
    const p = raw(lam, lat * PK_RAD);
    return [p[0] - ctr[0], -(p[1] - ctr[1])];
  };
}

const pkLower48 = pkConic([29.5, 45.5], 96, [-0.6, 38.7]);
const pkAlaska = pkConic([55, 65], 154, [-2, 58.5]);
const pkHawaii = pkConic([8, 18], 157, [-3, 19.9]);

/** The Albers USA composite (lower 48, Alaska inset, Hawaii inset), as d3 lays it out. */
function pkAlbersUsa(lng: number, lat: number): [number, number] {
  if (lat >= 50 && lng <= -128) {
    const p = pkAlaska(lng, lat);
    return [0.35 * p[0] - 0.307, 0.35 * p[1] + 0.201];
  }
  if (lat <= 24 && lng <= -150) {
    const p = pkHawaii(lng, lat);
    return [p[0] - 0.205, p[1] + 0.212];
  }
  return pkLower48(lng, lat);
}

/**
 * Whether Albers USA draws this point: the lower 48, Alaska and Hawaii. Like
 * d3's, it has no place for Puerto Rico and the other territories — drawn
 * anyway, they land far off the map's right edge and shrink everything else.
 */
function pkUsaCovers(lng: number, lat: number): boolean {
  if (lat >= 50 && lng <= -128) return true; // Alaska
  if (lat <= 24 && lng <= -150) return true; // Hawaii
  return lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66;
}

/** A feature's first vertex — enough to place a whole state or county. */
function pkFirstPoint(geometry: any): [number, number] | null {
  let c = geometry && geometry.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === 'number' ? [c[0], c[1]] : null;
}

/** World: plate carrée, north up. */
function pkWorld(lng: number, lat: number): [number, number] {
  return [lng / 360, -lat / 360];
}

function pkProjectionFor(level: string): (lng: number, lat: number) => [number, number] {
  return level === 'us_state' || level === 'us_county' || level === 'us_city' || level === 'us_zip' ? pkAlbersUsa : pkWorld;
}

/** An SVG path `d` for a (Multi)Polygon geometry under a projection. */
function pkPathD(geometry: any, project: (lng: number, lat: number) => [number, number], scale: number, dx: number, dy: number): string {
  if (!geometry) return '';
  const polys: any[] = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let d = '';
  for (const poly of polys) {
    for (const ring of poly || []) {
      let first = true;
      for (const pt of ring || []) {
        const p = project(pt[0], pt[1]);
        d += (first ? 'M' : 'L') + ((p[0] - dx) * scale).toFixed(1) + ',' + ((p[1] - dy) * scale).toFixed(1);
        first = false;
      }
      if (!first) d += 'Z';
    }
  }
  return d;
}

/** Projected bounds of a feature list, so the SVG can fit them. */
function pkBounds(features: any[], project: (lng: number, lat: number) => [number, number]): [number, number, number, number] {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const f of features) {
    const g = f && f.geometry;
    if (!g) continue;
    const polys: any[] = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    for (const poly of polys) for (const ring of poly || []) for (const pt of ring || []) {
      const p = project(pt[0], pt[1]);
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 1, 1];
}

/** 0..1 position of a value in [min, max] for the colour ramp (null for no value). */
function pkRampT(value: number | null, min: number, max: number): number | null {
  if (value === null || typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (max <= min) return 1;
  return (value - min) / (max - min);
}
