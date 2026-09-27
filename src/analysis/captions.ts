// Tile captions — PURE, MAIN PROCESS, NO MODEL.
//
// One sentence per report tile, written by the app from the tile's OWN
// aggregated data. This is the same rule the rest of the codebase follows and
// the reason this file exists at all: a report has to carry a sentence next to
// every picture, and a model writing that sentence would be a model writing a
// computed number. Everything here is arithmetic over figures the app already
// produced (`vizData`'s `{labels, series}`, a metric card's value, a map's geo
// items) plus a fixed set of sentence frames.
//
// Deterministic by construction: no Date.now(), no locale branching beyond
// Number.prototype.toLocaleString (which every other figure in the app already
// goes through), no randomness. scripts/test-captions.ts asserts EXACT strings
// per family, which is only possible because of that.
//
// Captions carry NO trailing period — they are set as a caption line under a
// picture, not as body prose, and the examples in the spec are written that
// way. A page that needs a paragraph gets a Notes page.

import { formatCompact } from '../app/format';
import type { ChartData } from './vizData';
import type { PivotGrid } from './pivotData';
import { waterfallFigures, paretoFigures } from './chartFigures';
import { analyticsClauses } from './analytics';
import type { ResolvedOverlay } from './analytics';

// ── the app's compact number format ──────────────────────────────────────────
//
// A DELIBERATE SECOND COPY of renderer/hub/hub.ts's `_fmtVal`, and the only one
// in this codebase. It cannot be shared: `_fmtVal` is a top-level function in a
// classic <script> with no module boundary to import across, and a caption is
// composed in MAIN. The copy is pinned by a parity assertion in
// scripts/test-captions.ts that reads hub.ts as text and fails if either side's
// thresholds or suffixes move — the house differential-test rule, applied to
// the one pair that cannot be compared by calling both.
export function compact(v: number | null | undefined): string {
  return formatCompact(v);
}

// ── chart family ─────────────────────────────────────────────────────────────
//
// The 34 chart ids collapse to a handful of shapes a sentence can be written
// about, plus `other` for the ones where the honest sentence is a count.
// Mapping by FAMILY rather than per-id is what keeps this file from growing a
// branch every time renderResult.ts gains a chart. The five that DO get their
// own family — waterfall, Pareto, bullet, radar, calendar — each say something
// no bar sentence can: where a total went, how concentrated it is, how far off
// target, who wins which axis, which day peaked.
export type CaptionFamily =
  | 'bar' | 'line' | 'part' | 'map' | 'point' | 'pivot'
  | 'waterfall' | 'pareto' | 'bullet' | 'radar' | 'calendar' | 'other';

const FAMILY: Record<string, CaptionFamily> = {
  column: 'bar', bar: 'bar',
  clustered_column: 'bar', clustered_bar: 'bar',
  stacked_column: 'bar', stacked_bar: 'bar',
  pct_stacked_column: 'bar', pct_stacked_bar: 'bar',
  treemap: 'bar', funnel: 'bar', histogram: 'bar', combo: 'bar', heatmap: 'bar',
  line: 'line', line_markers: 'line', area: 'line', stacked_area: 'line',
  candlestick: 'line',
  pie: 'part', donut: 'part',
  map_bubble: 'map', map_choropleth: 'map',
  scatter: 'point', bubble: 'point',
  pivot: 'pivot',
  waterfall: 'waterfall', pareto: 'pareto', bullet: 'bullet', radar: 'radar', calendar: 'calendar',
};

export function captionFamily(chartType: string | null | undefined): CaptionFamily {
  return FAMILY[String(chartType || '')] || 'other';
}

// ── inputs ───────────────────────────────────────────────────────────────────

/** One KPI as a caption sees it — an app-computed figure under its own label. */
export interface CaptionKpi {
  label: string;
  value: number | null;
}

/** Everything a caption may read. Every field is already app-computed. */
export interface CaptionInput {
  /** Chart id (`column`, `line`, `map_choropleth`, …). Omitted for a KPI row. */
  chartType?: string;
  /** The `{labels, series}` the renderers consume — charts only. May carry its resolved `analytics`. */
  data?: (ChartData & { analytics?: ResolvedOverlay[] }) | null;
  /**
   * The Analytics pane's resolved overlays (./analytics). A trend or a forecast
   * adds its own clause to the sentence; the rest are drawn, not narrated.
   * Defaults to `data.analytics`, which is where `visual:data` puts them.
   */
  analytics?: ResolvedOverlay[] | null;
  /** A map's resolved regions — maps only. */
  geo?: { items: Array<{ name: string; value: number }> } | null;
  /** A KPI row's figures — metric tiles only; presence selects the KPI frame. */
  kpis?: CaptionKpi[] | null;
  /** A pivot's grid — pivots only. Its shape IS the sentence, so it is read directly. */
  pivot?: PivotGrid | null;
  /** column → the display name the catalog gives it (catalog.displayNames). */
  names?: Record<string, string> | null;
  /**
   * The two chart overrides that change a FIGURE rather than a look: the
   * waterfall's "is total" categories and the bullet's fixed target. Without
   * them the sentence would describe a different chart from the picture.
   */
  overrides?: { waterfallTotals?: string[]; bulletTarget?: number } | null;
}

const NOTHING = 'No data to summarize';

/**
 * The one entry point. Never throws, never returns an empty string.
 *
 *   Revenue rose 41% from 2023-01 to 2024-12; trend +8.1K per month (R² 0.62);
 *   forecast 356.2K by 2025-03, 80% range 301K–411K
 *
 * The family's sentence, then a clause per trend / forecast overlay the chart
 * type draws — both figures app-resolved (./analytics), only put into words here.
 */
export function tileCaption(input: CaptionInput): string {
  const base = familyCaption(input);
  if (!input || typeof input !== 'object' || base === NOTHING) return base;
  return base + analyticsClauses(input.analytics || (input.data && input.data.analytics), input.chartType);
}

function familyCaption(input: CaptionInput): string {
  if (!input || typeof input !== 'object') return NOTHING;
  if (Array.isArray(input.kpis)) return kpiCaption(input.kpis);

  const family = captionFamily(input.chartType);
  const measure = measureNoun(input.data, input.names);
  // A pivot's sentence is about the GRID — how big it is and where its peak
  // sits — which `{labels, series}` cannot say: a leaf row's label is a joined
  // path and the shape of the thing is the point.
  if (family === 'pivot') return pivotCaption(input.pivot);
  // A map's figures are its RESOLVED regions, which is a shorter list than the
  // chart labels whenever a name failed to match a feature — so the sentence is
  // written off `geo`, and only the measure noun comes from the series.
  if (family === 'map') return leaderCaption(geoPairs(input.geo), measure, true);

  const pairs = chartPairs(input.data);
  const ov = input.overrides || {};
  switch (family) {
    case 'line': return lineCaption(pairs, measure);
    case 'part': return partCaption(pairs, measure);
    case 'point': return pointCaption(input.data, measure);
    case 'bar': return leaderCaption(pairs, measure, false);
    case 'waterfall': return waterfallCaption(input.data, ov.waterfallTotals, measure, pairs);
    case 'pareto': return paretoCaption(input.data, measure, pairs);
    case 'bullet': return bulletCaption(input.data, ov.bulletTarget, measure, pairs);
    case 'radar': return radarCaption(input.data);
    case 'calendar': return calendarCaption(pairs, measure);
    default: return genericCaption(pairs, measure);
  }
}

// ── shared reductions ────────────────────────────────────────────────────────

interface Pair { label: string; value: number }

/**
 * `{labels, series}` → one `{label, value}` per category, TOTALLED across
 * series. A single-series chart is unaffected; a clustered / stacked / split
 * chart reads as its stack total, which is the figure the picture's height
 * actually shows. Nulls contribute nothing; a category whose every cell is
 * null is dropped rather than reported as zero.
 */
function chartPairs(data: ChartData | null | undefined): Pair[] {
  const labels = (data && Array.isArray(data.labels)) ? data.labels : [];
  const series = (data && Array.isArray(data.series)) ? data.series : [];
  const out: Pair[] = [];
  for (let i = 0; i < labels.length; i++) {
    let total = 0;
    let seen = false;
    for (const s of series) {
      const v = s && Array.isArray(s.values) ? s.values[i] : null;
      if (typeof v === 'number' && Number.isFinite(v)) { total += v; seen = true; }
    }
    if (seen) out.push({ label: String(labels[i]), value: total });
  }
  return out;
}

function geoPairs(geo: CaptionInput['geo']): Pair[] {
  const items = (geo && Array.isArray(geo.items)) ? geo.items : [];
  return items
    .filter((i) => i && typeof i.value === 'number' && Number.isFinite(i.value))
    .map((i) => ({ label: String(i.name), value: i.value }));
}

/**
 * What the figures ARE, as a noun for the middle of a sentence.
 *
 * vizData names an aggregated series "sum of revenue" (measureLabel), which is
 * a legend entry, not English — so the aggregation prefix comes off and the
 * column name is used verbatim (never case-folded: a column called `Revenue`
 * stays `Revenue`). More than one series means the caption is talking about the
 * stack total, and no single column names that.
 */
function measureNoun(data: ChartData | null | undefined, names?: Record<string, string> | null): string {
  const series = (data && Array.isArray(data.series)) ? data.series : [];
  if (series.length !== 1) return series.length > 1 ? 'the total' : 'value';
  const name = String((series[0] && series[0].name) || '').trim();
  const m = /^(?:sum|avg|min|max|count) of (.+)$/.exec(name);
  const column = (m ? m[1] : name) || 'value';
  // A column the user gave a display name reads as THAT name.
  const shown = names && Object.prototype.hasOwnProperty.call(names, column) ? names[column] : '';
  return typeof shown === 'string' && shown.trim() ? shown.trim() : column;
}

/** First letter upper-cased, rest untouched — a noun starting a sentence. */
function sentenceCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function countWord(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}

// ── the frames ───────────────────────────────────────────────────────────────

/**
 * Bar / column / treemap / funnel / map — "who is biggest, and by how much".
 *
 *   Technology leads revenue at 3.8M, 2.4× Furniture
 *
 * The multiple clause is dropped whenever it would not be informative or would
 * be a lie: a runner-up at or below zero has no meaningful ratio, and a tie
 * gets its own frame rather than a "1.0×" that reads as a rounding artefact.
 */
function leaderCaption(pairs: Pair[], measure: string, isMap: boolean): string {
  if (!pairs.length) return NOTHING;
  const sorted = pairs.slice().sort((a, b) => b.value - a.value);
  const top = sorted[0];
  const noun = measure;

  if (sorted.length === 1) {
    return `${top.label} is the only ${isMap ? 'region' : 'category'}, ${noun} ${compact(top.value)}`;
  }

  const tied = sorted.filter((p) => p.value === top.value);
  if (tied.length > 1) {
    const at = `for the lead in ${noun} at ${compact(top.value)}`;
    return tied.length === 2
      ? `${tied[0].label} and ${tied[1].label} tie ${at}`
      : `${countWord(tied.length)} ${isMap ? 'regions' : 'categories'} tie ${at}`;
  }

  const second = sorted[1];
  const lead = `${top.label} leads ${noun} at ${compact(top.value)}`;
  if (second.value <= 0) return lead;
  const ratio = top.value / second.value;
  if (!Number.isFinite(ratio)) return lead;
  return `${lead}, ${ratio.toFixed(1)}× ${second.label}`;
}

/**
 * Line / area — "which way, by how much, and where the peak was".
 *
 *   Revenue rose 41% from Jan 2023 to Dec 2024, peaking at 342.7K in Nov 2023
 *
 * The peak clause is dropped when the peak IS an endpoint, where it would only
 * restate the figure the sentence already gave. A zero first value has no
 * percentage, so the percentage is dropped rather than printed as Infinity.
 */
function lineCaption(pairs: Pair[], measure: string): string {
  if (!pairs.length) return NOTHING;
  const noun = sentenceCase(measure);
  if (pairs.length === 1) return `${noun} was ${compact(pairs[0].value)} in ${pairs[0].label}`;

  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  const span = `from ${first.label} to ${last.label}`;

  let head: string;
  const delta = last.value - first.value;
  const pct = first.value === 0 ? null : Math.round((delta / Math.abs(first.value)) * 100);
  if (pct === null) {
    head = delta === 0
      ? `${noun} held steady ${span}`
      : `${noun} ${delta > 0 ? 'rose' : 'fell'} to ${compact(last.value)} ${span}`;
  } else if (pct === 0) {
    head = `${noun} held steady ${span}`;
  } else {
    head = `${noun} ${pct > 0 ? 'rose' : 'fell'} ${Math.abs(pct)}% ${span}`;
  }

  let peakIdx = 0;
  for (let i = 1; i < pairs.length; i++) if (pairs[i].value > pairs[peakIdx].value) peakIdx = i;
  if (peakIdx === 0 || peakIdx === pairs.length - 1) return head;
  return `${head}, peaking at ${compact(pairs[peakIdx].value)} in ${pairs[peakIdx].label}`;
}

/**
 * Pie / donut — "how many slices, and how big the biggest one is".
 *
 *   Three categories; Technology is 73%
 *
 * A share needs a positive total to divide by; negatives in a part-to-whole
 * chart mean the percentage would be nonsense, so it falls back to the leader
 * frame, which only ever compares.
 */
function partCaption(pairs: Pair[], measure: string): string {
  if (!pairs.length) return NOTHING;
  const total = pairs.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return leaderCaption(pairs, measure, false);
  const top = pairs.slice().sort((a, b) => b.value - a.value)[0];
  const share = Math.round((top.value / total) * 100);
  const n = pairs.length;
  return `${sentenceCase(countWord(n))} ${n === 1 ? 'category' : 'categories'}; ${top.label} is ${share}%`;
}

/** Scatter / bubble — a cloud has no leader, so it gets its count and range. */
function pointCaption(data: ChartData | null | undefined, measure: string): string {
  const values: number[] = [];
  const series = (data && Array.isArray(data.series)) ? data.series : [];
  for (const s of series) {
    for (const v of (s && Array.isArray(s.values) ? s.values : [])) {
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
  }
  if (!values.length) return NOTHING;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const n = values.length;
  if (lo === hi) return `${n} ${n === 1 ? 'point' : 'points'}, ${measure} ${compact(lo)} throughout`;
  return `${n} ${n === 1 ? 'point' : 'points'}, ${measure} from ${compact(lo)} to ${compact(hi)}`;
}

/** Gauge / sankey / boxplot / table — the honest sentence is a count. */
function genericCaption(pairs: Pair[], measure: string): string {
  if (!pairs.length) return NOTHING;
  if (pairs.length === 1) return `${sentenceCase(measure)} is ${compact(pairs[0].value)}`;
  const total = pairs.reduce((a, p) => a + p.value, 0);
  return `${sentenceCase(measure)} across ${pairs.length} categories, totalling ${compact(total)}`;
}

/**
 * A pivot — "24 rows × 3 columns; Technology · West is highest at 1.1M".
 *
 * The size comes first because that is what a reader checks first, and the peak
 * names its full CELL — the row path and the column path — since a pivot's
 * biggest figure is identified by both. LEAF cells only: a subtotal is larger
 * than its own children by construction and would win every time.
 */
function pivotCaption(grid: PivotGrid | null | undefined): string {
  if (!grid || !Array.isArray(grid.cells) || grid.rowGroupCount === 0) return NOTHING;
  const rows = grid.rowGroupCount;
  const cols = grid.colGroupCount;
  const size = `${rows} ${rows === 1 ? 'row' : 'rows'} × ${cols} ${cols === 1 ? 'column' : 'columns'}`;

  let best: { path: string; v: number } | null = null;
  for (let r = 0; r < grid.cells.length; r += 1) {
    if (grid.rowKinds[r] !== 'leaf') continue;
    for (let c = 0; c < grid.cells[r].length; c += 1) {
      const v = grid.cells[r][c];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (best && v <= best.v) continue;
      const parts = (grid.rowHeaders[r] || []).concat(grid.colHeaders[c] || []).filter((p) => p !== '');
      best = { path: parts.join(' · '), v };
    }
  }
  if (!best) return `${size}; no figures to compare`;
  // No measure noun: with more than one value field the cells are not all the
  // same quantity, and the cell path already names which figure this is.
  return `${size}; ${best.path} is highest at ${compact(best.v)}`;
}

/**
 * A row of KPI tiles — "Revenue 5.2M · Profit 686.2K · Units 19.4K".
 *
 * The one frame that is a list rather than a sentence, because the tile is a
 * list. An unavailable figure prints as an em dash rather than being skipped:
 * a reader counting four tiles on the page should find four in the caption.
 */
function kpiCaption(kpis: CaptionKpi[]): string {
  const parts = kpis
    .filter((k) => k && typeof k.label === 'string')
    .map((k) => `${k.label} ${k.value == null ? '—' : compact(k.value)}`);
  return parts.length ? parts.join(' · ') : 'No metrics on this sheet';
}

// ── waterfall · Pareto · bullet · radar · calendar ───────────────────────────
//
// The waterfall's start/end and the Pareto's 80% count come from ./chartFigures,
// the main-side twin of the renderer's chartShapes (differential-tested).

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "Four steps take revenue from 4.1M to 5.2M; the largest is Technology at +1.3M" */
function waterfallCaption(
  data: ChartData | null | undefined, totals: string[] | undefined, measure: string, pairs: Pair[],
): string {
  const f = waterfallFigures(data, totals);
  if (!f.steps.length) return genericCaption(pairs, measure);
  let big = f.steps[0];
  for (const s of f.steps) if (Math.abs(s.value) > Math.abs(big.value)) big = s;
  const n = f.steps.length;
  const head = `${sentenceCase(countWord(n))} ${n === 1 ? 'step takes' : 'steps take'} ${measure} from ${compact(f.from)} to ${compact(f.to)}`;
  const at = `${big.label} at ${big.value > 0 ? '+' : ''}${compact(big.value)}`;
  return n === 1 ? `${head}: ${at}` : `${head}; the largest is ${at}`;
}

/** "Three categories make 80% of revenue" */
function paretoCaption(data: ChartData | null | undefined, measure: string, pairs: Pair[]): string {
  const p = paretoFigures(data);
  if (!p.count80) return leaderCaption(pairs, measure, false);
  if (p.count80 === 1) return `${p.top} alone makes 80% of ${measure}`;
  if (p.count80 >= p.positives) {
    return `It takes ${p.positives === 2 ? 'both' : 'all ' + countWord(p.positives)} categories to make 80% of ${measure}`;
  }
  return `${sentenceCase(countWord(p.count80))} categories make 80% of ${measure}`;
}

/** "Two of three categories reach target; Technology leads at 128%" */
function bulletCaption(
  data: ChartData | null | undefined, fixed: number | undefined, measure: string, pairs: Pair[],
): string {
  const labels = (data && Array.isArray(data.labels)) ? data.labels : [];
  const series = (data && Array.isArray(data.series)) ? data.series : [];
  const s0: unknown[] = (series[0] && series[0].values) || [];
  const s1: unknown[] | null = series[1] ? series[1].values || [] : null;
  const rows = labels
    .map((l, i) => ({ label: String(l), v: finite(s0[i]), t: s1 ? finite(s1[i]) : finite(fixed) }))
    .filter((r): r is { label: string; v: number; t: number } => r.v !== null && r.t !== null && r.t > 0);
  // No usable target: say what the bars say, about the MEASURE (not measure + target).
  if (!rows.length) return leaderCaption(s1 ? chartPairs({ labels, series: [series[0]] }) : pairs, measure, false);
  const pct = (r: { v: number; t: number }): number => Math.round((r.v / r.t) * 100);
  if (rows.length === 1) return `${rows[0].label} is at ${pct(rows[0])}% of its ${compact(rows[0].t)} target`;
  let best = rows[0];
  for (const r of rows) if (r.v / r.t > best.v / best.t) best = r;
  const n = rows.length;
  const met = rows.filter((r) => r.v >= r.t).length;
  const head = met === n ? (n === 2 ? 'Both categories reach target' : `All ${countWord(n)} categories reach target`)
    : met === 0 ? (n === 2 ? 'Neither category reaches target' : `None of ${countWord(n)} categories reach target`)
    : `${sentenceCase(countWord(met))} of ${countWord(n)} categories ${met === 1 ? 'reaches' : 'reach'} target`;
  return `${head}; ${best.label} ${met === 0 ? 'is closest' : 'leads'} at ${pct(best)}%`;
}

/**
 * "West leads on four of five measures" — within the radar's own caps (six
 * axes, eight categories); a category WINS an axis by its raw figure.
 */
function radarCaption(data: ChartData | null | undefined): string {
  const labels = ((data && Array.isArray(data.labels)) ? data.labels : []).slice(0, 8);
  const axes = ((data && Array.isArray(data.series)) ? data.series : []).slice(0, 6);
  if (axes.length < 2) return leaderCaption(chartPairs(data), measureNoun(data), false);
  if (!labels.length) return NOTHING;
  const m = axes.length;
  if (labels.length === 1) return `${labels[0]} is the only category, across ${countWord(m)} measures`;
  const wins = labels.map(() => 0);
  for (const s of axes) {
    let bi = -1;
    let bv = -Infinity;
    labels.forEach((_, i) => {
      const v = finite(s && Array.isArray(s.values) ? s.values[i] : null);
      if (v !== null && v > bv) { bv = v; bi = i; }
    });
    if (bi >= 0) wins[bi] += 1;
  }
  let lead = 0;
  wins.forEach((w, i) => { if (w > wins[lead]) lead = i; });
  if (!wins[lead]) return NOTHING;
  return wins[lead] === m
    ? `${labels[lead]} leads on all ${countWord(m)} measures`
    : `${labels[lead]} leads on ${countWord(wins[lead])} of ${countWord(m)} measures`;
}

/** "Revenue peaked at 12.3K on 2024-11-29, across 731 days" */
function calendarCaption(pairs: Pair[], measure: string): string {
  if (!pairs.length) return NOTHING;
  const noun = sentenceCase(measure);
  if (pairs.length === 1) return `${noun} was ${compact(pairs[0].value)} on ${pairs[0].label}`;
  let peak = pairs[0];
  for (const p of pairs) if (p.value > peak.value) peak = p;
  return `${noun} peaked at ${compact(peak.value)} on ${peak.label}, across ${pairs.length} days`;
}
