'use strict';

// The published site's renderer, PURE half — no DOM. Inlined (with
// publishClient.js, the app's Chart.js, format.js and geoMatch.js) into every
// page Publish writes (src/publish/siteHtml.ts). A classic script: every name
// is prefixed `pk` so it cannot collide with the hub's globals in the shared
// renderer program.
//
// NOTHING HERE COMPUTES A FIGURE. Every number was computed by the app and
// arrives in the page's data; this file picks which answer to show for the
// filter bar's state, lays it out, and turns it into a Chart.js config. The
// only arithmetic is presentational — a slice's share of a pie, a running
// total's baseline under a waterfall bar, a map's projection — the same kind
// the hub's own renderer does on screen.

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

/**
 * The Chart.js config for one of the app's chart ids. `fmt` renders a tick /
 * tooltip number the workspace's way (OrdFormat in the page).
 */
function pkChartConfig(chartType: string, payload: any, ramp: string[], fmt: (v: number) => string): any {
  const labels: any[] = Array.isArray(payload && payload.labels) ? payload.labels : [];
  const series: any[] = Array.isArray(payload && payload.series) ? payload.series : [];
  const colors = pkPalette(ramp, Math.max(series.length, labels.length));
  const horizontal = /(^|_)bar$/.test(chartType) || chartType === 'funnel';
  const stacked = chartType.indexOf('stacked') >= 0;
  const pct = chartType.indexOf('pct_') === 0;
  const tick = { callback: (v: any) => (typeof v === 'number' ? fmt(v) : v) };
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
    // A running total's floating bars: each step drawn from where the last one ended.
    const s = series[0] || { label: '', values: [] };
    let run = 0;
    const bars = s.values.map((v: any) => { const a = run; run += Number(v) || 0; return [a, run]; });
    return {
      type: 'bar',
      data: { labels, datasets: [{ label: s.label, data: bars, backgroundColor: s.values.map((v: any) => (Number(v) < 0 ? '#e11d48' : colors[0])) }] },
      options: { ...base, scales: { y: { ticks: tick } } },
    };
  }
  const lineish = /line|area/.test(chartType);
  const datasets = series.map((s, i) => {
    let data: any[] = s.values;
    if (pct) {
      data = s.values.map((v: any, j: number) => {
        const tot = series.reduce((n: number, t: any) => n + (Number(t.values[j]) || 0), 0);
        return tot ? ((Number(v) || 0) / tot) * 100 : null;
      });
    }
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
  if (chartType === 'pareto' && series[0]) {
    // The cumulative share line over the (already sorted) bars.
    const vals = series[0].values.map((v: any) => Number(v) || 0);
    const tot = vals.reduce((a: number, b: number) => a + b, 0);
    let acc = 0;
    datasets.push({
      type: 'line', label: 'Cumulative %', data: vals.map((v: number) => { acc += v; return tot ? (acc / tot) * 100 : null; }),
      borderColor: colors[1] || colors[0], backgroundColor: colors[1] || colors[0], yAxisID: 'pct', pointRadius: 2,
    } as any);
  }
  const valueAxis = horizontal ? 'x' : 'y';
  // Only the VALUE axis gets the number formatter. An explicit `ticks:
  // undefined` on the category axis is not "use the default" to Chart.js — it
  // replaces the category callback and the axis prints indexes (0, 1, 2…).
  const scales: any = { x: { stacked }, y: { stacked } };
  scales[valueAxis].ticks = tick;
  if (pct) scales[valueAxis].max = 100;
  if (chartType === 'pareto') scales.pct = { position: 'right', min: 0, max: 100, grid: { display: false } };
  return {
    type: lineish ? 'line' : 'bar',
    data: { labels, datasets },
    options: { ...base, indexAxis: horizontal ? 'y' : 'x', scales },
  };
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
