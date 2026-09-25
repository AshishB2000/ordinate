// The pure data shapes behind five chart families — waterfall, bullet, calendar
// heatmap, radar and Pareto. `{labels, series}` in, the numbers each family
// draws out: running totals, cumulative percentages, week/weekday cells,
// per-axis normalised values, bullet bands.
//
// PURE and DOM-free on purpose, like geoMatch.ts: the renderer loads it as a
// <script> that attaches to window, and scripts/test-chartShapes.js require()s
// the emitted sibling directly. Every figure a chart plugin draws from these —
// a connector's level, the 80% marker, a legend's min/max — is asserted there
// without a canvas. chartFamiliesExtra.ts is the only renderer consumer.
//
// src/analysis/captions.ts restates the waterfall start/end and the Pareto 80%
// count in MAIN (a caption cannot import a renderer script); the differential
// test in scripts/test-captions.ts pins the two with Object.is.

/** One bar of a waterfall. `base` → `base + delta` is the bar; `running` is the level after it. */
interface WaterfallShape {
  labels: string[];
  base: number[];
  delta: number[];
  kind: Array<'start' | 'up' | 'down' | 'total' | 'end'>;
  running: number[];
  /** Index into the INPUT labels, or -1 for a synthetic start/end bar. */
  src: number[];
  from: number;
  to: number;
}
interface ParetoShape {
  labels: any[];
  values: Array<number | null>;
  cumPct: number[];
  count80: number;
  total: number;
  src: number[];
}
interface CalendarCell { week: number; weekday: number; date: string; v: number | null }
interface CalendarShape {
  cells: CalendarCell[];
  weeks: number;
  monthMarks: Array<{ week: number; label: string; month: number; year: number }>;
  min: number;
  max: number;
}
interface RadarShape {
  axes: string[];
  datasets: Array<{ label: string; norm: Array<number | null>; raw: Array<number | null> }>;
  anyNegative: boolean;
}
interface BulletRow { label: any; value: number | null; target: number | null; bands: [number, number, number] }
interface BulletShape { rows: BulletRow[]; hasTarget: boolean; max: number }

(function (global: any) {

  const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // ── Waterfall ─────────────────────────────────────────────────────────────
  // A category is a TOTAL when the chart's `waterfallTotals` override names it
  // or its label reads as one ("Total", "Subtotal", "Sub-total Q1", "Grand
  // total"). A total is drawn from 0 at its own value — which resets the running
  // level — or at the running level when the cell is empty.
  const TOTAL_RE = /^(sub[ -]?|grand )?total\b/i;

  function waterfallSteps(labels: any[], series: any[], totals?: string[] | null): WaterfallShape {
    const named = new Set((Array.isArray(totals) ? totals : []).map(String));
    const isTotal = (l: any): boolean => named.has(String(l)) || TOTAL_RE.test(String(l));
    const out: WaterfallShape = { labels: [], base: [], delta: [], kind: [], running: [], src: [], from: 0, to: 0 };
    const push = (label: any, base: number, delta: number, kind: WaterfallShape['kind'][number], src: number): void => {
      out.labels.push(String(label));
      out.base.push(base);
      out.delta.push(delta);
      out.kind.push(kind);
      out.running.push(kind === 'up' || kind === 'down' ? base + delta : delta);
      out.src.push(src);
    };
    const s0: any[] = (series[0] && series[0].values) || [];

    if (series.length >= 2) {
      // A BRIDGE: series[0] → series[1] (last year → this year), one step per
      // category. A total-labelled category would count its children twice, so
      // it is left out of both ends and of the steps.
      const s1: any[] = series[1].values || [];
      const keep = labels.map((l, i) => i).filter((i) => !isTotal(labels[i]));
      for (const i of keep) { out.from += num(s0[i]) ?? 0; out.to += num(s1[i]) ?? 0; }
      push(series[0].name || 'Start', 0, out.from, 'start', -1);
      let running = out.from;
      for (const i of keep) {
        const d = (num(s1[i]) ?? 0) - (num(s0[i]) ?? 0);
        push(labels[i], running, d, d >= 0 ? 'up' : 'down', i);
        running += d;
      }
      push(series[1].name || 'End', 0, out.to, 'end', -1);
      return out;
    }

    let running = 0;
    labels.forEach((l, i) => {
      const v = num(s0[i]);
      if (isTotal(l)) {
        running = v ?? running;
        if (i === 0) out.from = running;
        push(l, 0, running, 'total', i);
        return;
      }
      const d = v ?? 0;
      push(l, running, d, d >= 0 ? 'up' : 'down', i);
      running += d;
    });
    if (labels.length && !isTotal(labels[labels.length - 1])) push('Total', 0, running, 'end', -1);
    out.to = running;
    return out;
  }

  // ── Pareto ────────────────────────────────────────────────────────────────
  // Descending by value (stable, nulls last); the cumulative line runs over the
  // POSITIVE values only, so a negative category can neither push the line past
  // 100% nor drag it backwards. count80 is how many categories it takes for the
  // cumulative share to reach 80% — 0 when there is nothing positive to share.
  const REACH = 0.8 * (1 - 1e-12); // ponytail: 1e-12 absorbs float drift at an exact 80%

  function paretoShape(labels: any[], values: any[]): ParetoShape {
    const rows = labels.map((l, i) => ({ l, v: num(values[i]), i }));
    rows.sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : (a.v === null ? 1 : -1);
      return b.v - a.v || a.i - b.i;
    });
    let total = 0;
    for (const r of rows) if (r.v !== null && r.v > 0) total += r.v;
    let cum = 0;
    let count80 = 0;
    const cumPct = rows.map((r, k) => {
      if (r.v !== null && r.v > 0) cum += r.v;
      if (!count80 && total > 0 && cum >= total * REACH) count80 = k + 1;
      return total > 0 ? (cum / total) * 100 : 0;
    });
    return { labels: rows.map((r) => r.l), values: rows.map((r) => r.v), cumPct, count80, total, src: rows.map((r) => r.i) };
  }

  // ── Calendar ──────────────────────────────────────────────────────────────
  // 'YYYY-MM-DD' or an ISO datetime; the CALENDAR DATE AS WRITTEN is the day
  // (no timezone shift), and all arithmetic is on UTC epoch days so the local
  // zone can never move a cell. Weeks start Monday (ISO), matching the day and
  // week grains in src/analysis/categoryKey.ts. The week index runs on from the
  // first date's Monday and does NOT restart at a new year.
  const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/;
  const MS_DAY = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // ponytail: a span past 20 years is refused (null → "couldn't draw"), not
  // truncated — a stray 1900-01-01 would otherwise mean 45k cells.
  const MAX_SPAN_DAYS = 366 * 20;

  function epochDay(label: any): number | null {
    const m = DAY_RE.exec(String(label == null ? '' : label).trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const dt = new Date(0);
    dt.setUTCFullYear(y, mo - 1, d);
    // Rejects 2023-02-30 and month 13 instead of letting Date roll them over.
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(dt.getTime() / MS_DAY);
  }
  const weekdayOf = (day: number): number => (((day + 3) % 7) + 7) % 7; // 0 = Monday; 1970-01-01 was a Thursday
  const isoOf = (day: number): string => new Date(day * MS_DAY).toISOString().slice(0, 10);

  function calendarCells(labels: any[], values: any[]): CalendarShape | null {
    // ponytail: two labels on one day are SUMMED — right for sum/count, not avg;
    // the builder forces the day grain for this type, so it only bites raw data.
    const byDay = new Map<number, number | null>();
    labels.forEach((l, i) => {
      const day = epochDay(l);
      if (day === null) return;
      const v = num(values[i]);
      const prev = byDay.has(day) ? byDay.get(day)! : null;
      byDay.set(day, v === null ? prev : (prev ?? 0) + v);
    });
    if (!byDay.size) return null;
    let lo = Infinity, hi = -Infinity;
    for (const d of byDay.keys()) { if (d < lo) lo = d; if (d > hi) hi = d; }
    if (hi - lo > MAX_SPAN_DAYS) return null;

    const monday = lo - weekdayOf(lo);
    const weekOf = (day: number): number => Math.floor((day - monday) / 7);
    const cells: CalendarCell[] = [];
    const monthMarks: CalendarShape['monthMarks'] = [];
    let min = Infinity, max = -Infinity;
    for (let d = lo; d <= hi; d++) {
      const iso = isoOf(d);
      const v = byDay.has(d) ? byDay.get(d)! : null;
      if (v !== null) { if (v < min) min = v; if (v > max) max = v; }
      cells.push({ week: weekOf(d), weekday: weekdayOf(d), date: iso, v });
      if (d === lo || iso.slice(8) === '01') {
        const month = +iso.slice(5, 7) - 1;
        monthMarks.push({ week: weekOf(d), label: MONTHS[month], month, year: +iso.slice(0, 4) });
      }
    }
    if (min === Infinity) { min = 0; max = 0; }
    return { cells, weeks: weekOf(hi) + 1, monthMarks, min, max };
  }

  // How to wrap the continuous week strip into horizontal BANDS for a box of
  // availW × availH px. Two years of days as one strip is a 105-column barcode
  // 60px tall; the same weeks in three bands of 35 fill the box with cells
  // three times the size. A band is a line break, not a restart: the week index
  // stays continuous. More bands only when they buy ≥10% bigger cells.
  // `gapRows` is the space between bands (room for month names), in cell rows.
  function calendarBands(weeks: number, availW: number, availH: number, gapRows: number, maxCell = 30):
    { bands: number; perRow: number; rows: number } {
    const shape = (perRow: number) => {
      const bands = Math.ceil(weeks / perRow);
      return { bands, perRow, rows: bands * 7 + (bands - 1) * gapRows };
    };
    let best = shape(Math.max(1, weeks));
    if (!(availW > 0 && availH > 0) || weeks < 1) return best;
    let bestCell = Math.min(availW / best.perRow, availH / best.rows, maxCell);
    for (let k = 2; k <= Math.min(6, weeks); k++) {
      const next = shape(Math.ceil(weeks / k));
      const cell = Math.min(availW / next.perRow, availH / next.rows, maxCell);
      if (cell > bestCell * 1.1) { best = next; bestCell = cell; }
    }
    return best;
  }

  // ── Radar ─────────────────────────────────────────────────────────────────
  // Axes are the MEASURES (at most six) and each category is one polygon (at
  // most eight — past that a radar is a scribble). Measures carry different
  // units, so each axis is scaled by its own largest magnitude: v / max|v|,
  // 0..1 (or -1..1 with a negative), and 0 on an axis whose values are all 0.
  // The raw figure rides along for the tooltip — a normalised 0.83 is not a
  // number anyone should be shown.
  const RADAR_AXES = 6;
  const RADAR_ROWS = 8;

  function radarShape(labels: any[], series: any[]): RadarShape {
    const axes = series.slice(0, RADAR_AXES);
    const rows = labels.slice(0, RADAR_ROWS);
    let anyNegative = false;
    const scale = axes.map((s) => {
      let m = 0;
      rows.forEach((_, i) => {
        const v = num(s.values[i]);
        if (v === null) return;
        if (v < 0) anyNegative = true;
        if (Math.abs(v) > m) m = Math.abs(v);
      });
      return m;
    });
    const datasets = rows.map((l, i) => {
      const raw = axes.map((s) => num(s.values[i]));
      const norm = raw.map((v, j) => (v === null ? null : scale[j] ? v / scale[j] : 0));
      return { label: String(l), norm, raw };
    });
    return { axes: axes.map((s) => String(s.name || '')), datasets, anyNegative };
  }

  // ── Bullet ────────────────────────────────────────────────────────────────
  // One row per category: the value, its target (the SECOND measure when there
  // is one, else the fixed `target` — the `bulletTarget` override — else none),
  // and three qualitative bands at 60 / 90 / 120% of that target. A row with no
  // positive target is banded against the largest |value| on the chart instead,
  // and draws no target tick.
  function bulletShape(labels: any[], series: any[], target?: number | null): BulletShape {
    const vals: any[] = (series[0] && series[0].values) || [];
    const tgts: any[] | null = series[1] ? series[1].values || [] : null;
    const fixed = num(target);
    let peak = 0;
    const base = labels.map((label, i) => {
      const value = num(vals[i]);
      if (value !== null && Math.abs(value) > peak) peak = Math.abs(value);
      return { label, value, target: tgts ? num(tgts[i]) : fixed };
    });
    let max = 0;
    const rows = base.map((r) => {
      const ref = r.target !== null && r.target > 0 ? r.target : peak;
      const bands: [number, number, number] = [ref * 0.6, ref * 0.9, ref * 1.2];
      max = Math.max(max, bands[2], r.value ?? 0, r.target ?? 0);
      return { label: r.label, value: r.value, target: r.target, bands };
    });
    return { rows, hasTarget: rows.some((r) => r.target !== null), max };
  }

  const api = { waterfallSteps, paretoShape, calendarCells, calendarBands, radarShape, bulletShape, epochDay };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;                 // Node (scripts/test-chartShapes.js)
  } else {
    Object.assign(global, api);           // Browser: chartFamiliesExtra.js reads these globals
  }

})(typeof window !== 'undefined' ? window : globalThis);
