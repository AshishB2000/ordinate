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

import type { ChartData } from './vizData';

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
  if (v == null || !Number.isFinite(v)) return '';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toLocaleString();
}

// ── chart family ─────────────────────────────────────────────────────────────
//
// The 28 chart ids collapse to five shapes a sentence can be written about,
// plus `other` for the ones where the honest sentence is a count. Mapping by
// FAMILY rather than per-id is what keeps this file from growing a branch every
// time renderResult.ts gains a chart.
export type CaptionFamily = 'bar' | 'line' | 'part' | 'map' | 'point' | 'other';

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
  /** The `{labels, series}` the renderers consume — charts only. */
  data?: ChartData | null;
  /** A map's resolved regions — maps only. */
  geo?: { items: Array<{ name: string; value: number }> } | null;
  /** A KPI row's figures — metric tiles only; presence selects the KPI frame. */
  kpis?: CaptionKpi[] | null;
}

const NOTHING = 'No data to summarize';

/** The one entry point. Never throws, never returns an empty string. */
export function tileCaption(input: CaptionInput): string {
  if (!input || typeof input !== 'object') return NOTHING;
  if (Array.isArray(input.kpis)) return kpiCaption(input.kpis);

  const family = captionFamily(input.chartType);
  const measure = measureNoun(input.data);
  // A map's figures are its RESOLVED regions, which is a shorter list than the
  // chart labels whenever a name failed to match a feature — so the sentence is
  // written off `geo`, and only the measure noun comes from the series.
  if (family === 'map') return leaderCaption(geoPairs(input.geo), measure, true);

  const pairs = chartPairs(input.data);
  switch (family) {
    case 'line': return lineCaption(pairs, measure);
    case 'part': return partCaption(pairs, measure);
    case 'point': return pointCaption(input.data, measure);
    case 'bar': return leaderCaption(pairs, measure, false);
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
function measureNoun(data: ChartData | null | undefined): string {
  const series = (data && Array.isArray(data.series)) ? data.series : [];
  if (series.length !== 1) return series.length > 1 ? 'the total' : 'value';
  const name = String((series[0] && series[0].name) || '').trim();
  const m = /^(?:sum|avg|min|max|count) of (.+)$/.exec(name);
  return (m ? m[1] : name) || 'value';
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
