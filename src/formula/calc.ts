// ── Calculation engine — PURE JS, NO AI ────────────────────────────────────
// The AI extracts raw numbers (step 1's extractedTable + columnRoles); THIS code
// does every calculation. Each calc is a pure function of (ctx) that returns a
// typed result { id, title, lines, raw } or null. A calc NEVER throws and NEVER
// fabricates: if the data doesn't support it (wrong shape, too few periods, no
// total/primary column, non-numeric cells), it returns null = "not applicable".
//
// `lines` are display-ready strings (what the UI shows verbatim, so displayed ==
// computed). `raw` holds the underlying numbers for the self-checks / later steps.

// ponytail: the table/roles/raw shapes come straight from the model's JSON
// envelope and vary per calc — typed loosely on purpose.
export interface CalcResult { id: string; title: string; lines: string[]; raw: any }
interface Ctx {
  table: any;
  roles: any;
  rows: any[];
  periods: string[];
  primaryValue: string | null;
  colById: Record<string, any>;
  labels: string[];
}

export const CALC_IDS = [
  'yoy_pct_change', 'total_change', 'acceleration', 'pct_of_total', 'concentration_top_n',
  'rank_by_value', 'rank_by_growth', 'gap_to_average', 'cagr', 'above_below_average',
];

// ── value coercion + formatting ─────────────────────────────────────────────
// Raw cells may be numbers or numeric strings ("1,234.50", "$5", "12%"). Coerce
// to a finite number, else null. We strip grouping/currency/percent glyphs but
// keep the exact digits (no rounding) — same contract as extraction.
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.replace(/[^0-9.\-]/g, '');
    if (s === '' || s === '-' || s === '.' || s === '-.') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// % change with a safe zero/None guard. Denominator uses |prev| so a drop from a
// negative base still reads with the right sign.
export function pctChange(prev: number | null, curr: number | null): number | null {
  if (prev == null || curr == null || prev === 0) return null;
  return (curr - prev) / Math.abs(prev) * 100;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Number.isInteger(n)) return n.toLocaleString('en-US'); // exact counts: never add a decimal
  // Non-integer values are derived (a mean-based gap, a per-period diff). A
  // fractional tail on a large magnitude — the "…533.2" the user saw — is noise,
  // so drop it; keep up to 2 decimals mid-range (currency-like) and more below 1.
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return n.toLocaleString('en-US', { maximumFractionDigits: dp });
}
// Percent formatters that NEVER render a signed zero ("-0%"/"+0.00%"): when the
// value rounds to zero at this precision, show a plain "0%". (Headline rewording
// for flat values lives in src/headline.js.)
function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const f = n.toFixed(2);
  if (parseFloat(f) === 0) return '0%';
  return (parseFloat(f) > 0 ? '+' : '') + f + '%';
}
function fmtShare(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const f = n.toFixed(2);
  if (parseFloat(f) === 0) return '0%';
  return f + '%';
}

// ── shared context resolved once per table ──────────────────────────────────
function colIdSet(table: any): Set<string> { return new Set((table.columns || []).map((c: any) => c.id)); }

// Ordered period column ids: trust columnRoles.periods (validated against real
// columns); fall back to role==='period' sorted by periodOrder.
function resolvePeriods(table: any, roles: any): string[] {
  const ids = colIdSet(table);
  let periods = Array.isArray(roles.periods) ? roles.periods.filter((id: any) => ids.has(id)) : [];
  if (!periods.length) {
    periods = (table.columns || [])
      .filter((c: any) => c.role === 'period')
      .slice()
      .sort((a: any, b: any) => (a.periodOrder ?? 0) - (b.periodOrder ?? 0))
      .map((c: any) => c.id);
  }
  return periods;
}

// The value column to rank/compare by: columnRoles.primaryValue, else a value
// column, else a total column, else the most recent period. null if none.
function resolvePrimaryValue(table: any, roles: any, periods: string[]): string | null {
  const ids = colIdSet(table);
  if (roles.primaryValue && ids.has(roles.primaryValue)) return roles.primaryValue;
  const valueCol = (table.columns || []).find((c: any) => c.role === 'value');
  if (valueCol) return valueCol.id;
  const totalCol = (table.columns || []).find((c: any) => c.role === 'total');
  if (totalCol) return totalCol.id;
  return periods.length ? periods[periods.length - 1] : null;
}

function buildCtx(table: any, roles: any): Ctx {
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const periods = resolvePeriods(table, roles);
  const primaryValue = resolvePrimaryValue(table, roles, periods);
  const colById: Record<string, any> = {};
  (table.columns || []).forEach((c: any) => { colById[c.id] = c; });
  const catId = roles.category && colById[roles.category] ? roles.category : null;
  const labels = rows.map((r: any, i: number) => {
    if (catId && r[catId] != null && String(r[catId]).trim()) return String(r[catId]).trim();
    return `Row ${i + 1}`;
  });
  return { table, roles, rows, periods, primaryValue, colById, labels };
}
function colLabel(ctx: Ctx, id: any): string { return (ctx.colById[id] && ctx.colById[id].label) || id; }

// primaryValue values aligned with labels; entries with non-numeric cells dropped.
function primarySeries(ctx: Ctx): Array<{ label: string; v: number }> {
  if (!ctx.primaryValue) return [];
  const out: Array<{ label: string; v: number }> = [];
  ctx.rows.forEach((r, i) => {
    const v = num(r[ctx.primaryValue as string]);
    if (v != null) out.push({ label: ctx.labels[i], v });
  });
  return out;
}

// ── individual calcs ────────────────────────────────────────────────────────
function calcYoY(ctx: Ctx): CalcResult | null {
  if (ctx.periods.length < 2) return null;
  const pPrev = ctx.periods[ctx.periods.length - 2];
  const pCur = ctx.periods[ctx.periods.length - 1];
  const out: Array<{ label: string; pct: number }> = [];
  ctx.rows.forEach((r, i) => {
    const pct = pctChange(num(r[pPrev]), num(r[pCur]));
    if (pct != null) out.push({ label: ctx.labels[i], pct });
  });
  if (!out.length) return null;
  return {
    id: 'yoy_pct_change',
    title: `Change: ${colLabel(ctx, pCur)} vs ${colLabel(ctx, pPrev)}`,
    lines: out.map(o => `${o.label}: ${fmtPct(o.pct)}`),
    raw: { from: pPrev, to: pCur, rows: out },
  };
}

function calcTotalChange(ctx: Ctx): CalcResult | null {
  if (ctx.periods.length < 2) return null;
  const first = ctx.periods[0];
  const last = ctx.periods[ctx.periods.length - 1];
  const out: Array<{ label: string; abs: number; pct: number | null }> = [];
  ctx.rows.forEach((r, i) => {
    const f = num(r[first]), l = num(r[last]);
    if (f == null || l == null) return;
    out.push({ label: ctx.labels[i], abs: l - f, pct: pctChange(f, l) });
  });
  if (!out.length) return null;
  return {
    id: 'total_change',
    title: `Total change: ${colLabel(ctx, first)} → ${colLabel(ctx, last)}`,
    lines: out.map(o => `${o.label}: ${o.abs >= 0 ? '+' : ''}${fmtNum(o.abs)} (${fmtPct(o.pct)})`),
    raw: { first, last, rows: out },
  };
}

function calcAcceleration(ctx: Ctx): CalcResult | null {
  if (ctx.periods.length < 3) return null;
  const p2 = ctx.periods[ctx.periods.length - 3];
  const p1 = ctx.periods[ctx.periods.length - 2];
  const p0 = ctx.periods[ctx.periods.length - 1];
  const out: Array<{ label: string; recent: number; prior: number; flag: string }> = [];
  ctx.rows.forEach((r, i) => {
    const v2 = num(r[p2]), v1 = num(r[p1]), v0 = num(r[p0]);
    if (v2 == null || v1 == null || v0 == null) return;
    const recent = v0 - v1, prior = v1 - v2;
    const flag = recent > prior ? 'accelerating' : (recent < prior ? 'decelerating' : 'steady');
    out.push({ label: ctx.labels[i], recent, prior, flag });
  });
  if (!out.length) return null;
  return {
    id: 'acceleration',
    title: 'Momentum (latest change vs prior change)',
    lines: out.map(o => `${o.label}: ${o.flag} (Δ ${fmtNum(o.prior)} → ${fmtNum(o.recent)})`),
    raw: { rows: out },
  };
}

function calcPctOfTotal(ctx: Ctx): CalcResult | null {
  const ser = primarySeries(ctx);
  if (ser.length < 2) return null;
  const sum = ser.reduce((s, x) => s + x.v, 0);
  if (sum === 0) return null;
  const out = ser.map(x => ({ label: x.label, value: x.v, pct: x.v / sum * 100 }));
  return {
    id: 'pct_of_total',
    title: `Share of total (${colLabel(ctx, ctx.primaryValue)})`,
    lines: out.map(o => `${o.label}: ${fmtShare(o.pct)}`),
    raw: { column: ctx.primaryValue, sum, rows: out },
  };
}

function calcConcentration(ctx: Ctx): CalcResult | null {
  const ser = primarySeries(ctx);
  if (ser.length < 4) return null;             // top-3 only meaningful with enough rows
  const sum = ser.reduce((s, x) => s + x.v, 0);
  if (sum === 0) return null;
  const sorted = ser.slice().sort((a, b) => b.v - a.v);
  const share = (n: number) => sorted.slice(0, n).reduce((s, x) => s + x.v, 0) / sum * 100;
  const top3 = share(3);
  const lines = [`Top 3 of ${ser.length}: ${fmtShare(top3)} of total`];
  const raw: { count: number; sum: number; top3Share: number; top5Share?: number } =
    { count: ser.length, sum, top3Share: top3 };
  if (ser.length > 8) { const t5 = share(5); lines.push(`Top 5 of ${ser.length}: ${fmtShare(t5)} of total`); raw.top5Share = t5; }
  return { id: 'concentration_top_n', title: 'Concentration', lines, raw };
}

function calcRankByValue(ctx: Ctx): CalcResult | null {
  const ser = primarySeries(ctx);
  if (ser.length < 2) return null;
  const sorted = ser.slice().sort((a, b) => b.v - a.v);
  return {
    id: 'rank_by_value',
    title: `Ranked by ${colLabel(ctx, ctx.primaryValue)}`,
    lines: sorted.map((o, i) => `${i + 1}. ${o.label} — ${fmtNum(o.v)}`),
    raw: { column: ctx.primaryValue, rows: sorted.map((o, i) => ({ rank: i + 1, label: o.label, value: o.v })) },
  };
}

function calcRankByGrowth(ctx: Ctx): CalcResult | null {
  if (ctx.periods.length < 2) return null;
  const pPrev = ctx.periods[ctx.periods.length - 2];
  const pCur = ctx.periods[ctx.periods.length - 1];
  const out: Array<{ label: string; pct: number }> = [];
  ctx.rows.forEach((r, i) => {
    const pct = pctChange(num(r[pPrev]), num(r[pCur]));
    if (pct != null) out.push({ label: ctx.labels[i], pct });
  });
  if (out.length < 2) return null;
  out.sort((a, b) => b.pct - a.pct);
  return {
    id: 'rank_by_growth',
    title: 'Ranked by recent growth',
    lines: out.map((o, i) => `${i + 1}. ${o.label} — ${fmtPct(o.pct)}`),
    raw: { from: pPrev, to: pCur, rows: out.map((o, i) => ({ rank: i + 1, label: o.label, pct: o.pct })) },
  };
}

function calcGapToAverage(ctx: Ctx): CalcResult | null {
  const ser = primarySeries(ctx);
  if (ser.length < 2) return null;
  const mean = ser.reduce((s, x) => s + x.v, 0) / ser.length;
  const out = ser.map(x => ({
    label: x.label, value: x.v, absGap: x.v - mean, pctGap: pctChange(mean, x.v), above: x.v >= mean,
  }));
  return {
    id: 'gap_to_average',
    title: `Gap to average (${colLabel(ctx, ctx.primaryValue)})`,
    lines: out.map(o => `${o.label}: ${o.above ? 'above' : 'below'} avg by ${fmtNum(Math.abs(o.absGap))} (${fmtPct(o.pctGap)})`),
    raw: { mean, rows: out },
  };
}

function calcCagr(ctx: Ctx): CalcResult | null {
  if (ctx.periods.length < 2) return null;
  const first = ctx.periods[0];
  const last = ctx.periods[ctx.periods.length - 1];
  // Prefer real year gaps from the period labels; fall back to evenly-spaced
  // periods derived from order (and say so).
  const yearOf = (id: string): number | null => { const m = String(colLabel(ctx, id)).match(/\b(19|20)\d{2}\b/); return m ? parseInt(m[0], 10) : null; };
  const y0 = yearOf(first), y1 = yearOf(last);
  let span: number, assumed = false;
  if (y0 != null && y1 != null && y1 > y0) { span = y1 - y0; }
  else { span = ctx.periods.length - 1; assumed = true; }
  if (span <= 0) return null;
  const out: Array<{ label: string; cagr: number }> = [];
  ctx.rows.forEach((r, i) => {
    const f = num(r[first]), l = num(r[last]);
    if (f == null || l == null || f <= 0 || l <= 0) return;
    out.push({ label: ctx.labels[i], cagr: (Math.pow(l / f, 1 / span) - 1) * 100 });
  });
  if (!out.length) return null;
  const unit = assumed ? 'per period' : 'per year';
  const lines = out.map(o => `${o.label}: ${fmtPct(o.cagr)} ${unit}`);
  if (assumed) lines.push('(periods assumed evenly spaced — exact year gaps unknown)');
  return { id: 'cagr', title: `CAGR over ${span} ${assumed ? 'periods' : 'years'}`, lines, raw: { span, assumed, rows: out } };
}

function calcAboveBelowAverage(ctx: Ctx): CalcResult | null {
  const ser = primarySeries(ctx);
  if (ser.length < 2) return null;
  const mean = ser.reduce((s, x) => s + x.v, 0) / ser.length;
  const out = ser.map(x => ({ label: x.label, value: x.v, above: x.v >= mean }));
  return {
    id: 'above_below_average',
    title: `Above / below average (${colLabel(ctx, ctx.primaryValue)})`,
    lines: out.map(o => `${o.label}: ${o.above ? 'above' : 'below'} average`),
    raw: { mean, rows: out },
  };
}

const CALCS: Record<string, (ctx: Ctx) => CalcResult | null> = {
  yoy_pct_change: calcYoY,
  total_change: calcTotalChange,
  acceleration: calcAcceleration,
  pct_of_total: calcPctOfTotal,
  concentration_top_n: calcConcentration,
  rank_by_value: calcRankByValue,
  rank_by_growth: calcRankByGrowth,
  gap_to_average: calcGapToAverage,
  cagr: calcCagr,
  above_below_average: calcAboveBelowAverage,
};

// ── public entry point ──────────────────────────────────────────────────────
// Compute the suggested calcs that the DATA actually supports (each calc re-checks
// applicability — the AI's list is a hint, not the truth). Returns:
//   { selected: [<up to 5 result objects, AI order>], results: { id: resultObj } }
// `selected` is what the UI shows; `results` keeps every applicable calc available.
export function computeMetrics(extractedTable: any, columnRoles: any, suggestedCalculations: any): { selected: CalcResult[]; results: Record<string, CalcResult> } {
  const table = (extractedTable && typeof extractedTable === 'object') ? extractedTable : {};
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  if (!columns.length || !rows.length) return { selected: [], results: {} };

  const roles = (columnRoles && typeof columnRoles === 'object') ? columnRoles : {};
  const ctx = buildCtx({ columns, rows }, roles);

  const suggested: string[] = Array.isArray(suggestedCalculations)
    ? suggestedCalculations.filter((id: any) => CALCS[id])
    : [];

  const results: Record<string, CalcResult> = {};
  for (const id of suggested) {
    let r: CalcResult | null = null;
    try { r = CALCS[id](ctx); } catch (_) { r = null; } // a calc must never break a turn
    if (r) results[id] = r;
  }
  // gap_to_average is the gap of each row to the MEAN of the same value column, so
  // when we're already showing a value ranking (rank_by_value) it just restates the
  // order and reads as noise. Hide it from the displayed list, but keep it in
  // `results` — the engine and the headline writer can still use it.
  const suppressGap = !!results.rank_by_value;
  const selected = suggested
    .filter(id => results[id] && !(id === 'gap_to_average' && suppressGap))
    .slice(0, 5)
    .map(id => results[id]);
  return { selected, results };
}

// ── Derive chart data from the extracted table ───────────────────────────────
// Produces the SAME { labels, series } shape buildChart() consumes, but FROM the
// numbers the AI already put in extractedTable — so the model emits each number
// ONCE (in extractedTable) instead of twice (also in data.series). Orientation by
// data shape:
//   time_series → labels = category values; one series per period column (chrono).
//   everything else (categorical / part_to_whole / single_metric / unknown) →
//                   labels = category values; one series per value column
//                   (primaryValue first), period/total/category columns excluded.
// Returns { labels: [], series: [] } when there is nothing plottable (empty or
// unstructured table) — the same "no usable data" state the chart already handles.
// ponytail: rank/ordinal columns are excluded by trusting the extraction roles
// (we only chart role==='value'/period cols); there is no explicit "rank" flag in
// the schema. If a rank column ever leaks in as a 'value', the chart-derive verify
// log surfaces it — add a rank role to the schema then.
export function deriveChartData(extractedTable: any, columnRoles: any, dataShape: any): { labels: string[]; series: Array<{ name: string; values: Array<number | null> }> } {
  const table = (extractedTable && typeof extractedTable === 'object') ? extractedTable : {};
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  if (!columns.length || !rows.length) return { labels: [], series: [] };

  const roles = (columnRoles && typeof columnRoles === 'object') ? columnRoles : {};
  const ctx = buildCtx({ columns, rows }, roles);
  const periodSet = new Set(ctx.periods);

  // The metric columns to plot when there's no explicit value series: numeric
  // columns that are neither the category/label, a period, nor a total.
  const metricCols = (): string[] => columns
    .filter((c: any) => c.id !== roles.category && !periodSet.has(c.id) && c.role !== 'total')
    .filter((c: any) => rows.some((r: any) => num(r[c.id]) != null))
    .map((c: any) => c.id);

  let seriesCols: string[];
  if (dataShape === 'time_series') {
    // Guard against a TIDY/long table (each ROW is a period, metrics are columns):
    // a "period" column that is also the category/label column — or whose own cell
    // values ARE the row labels — is the x-axis, never a value series, so we must not
    // plot the year numbers themselves as bars. (The else-branch already excludes the
    // category; this mirrors that for time_series, which was missing it.)
    const labelStr = ctx.labels.map(String);
    seriesCols = ctx.periods.filter(id => {
      if (id === roles.category) return false;
      const vals = rows.map((r: any) => r[id]);
      const isLabelColumn = vals.every((v: any, i: number) => v != null && String(v).trim() === labelStr[i]);
      return !isLabelColumn;
    });
    // If that removed every period, the period WAS the row entity → plot the metric
    // columns across those rows instead (e.g. employers/beneficiaries/registrations).
    if (!seriesCols.length) seriesCols = metricCols();
  } else {
    // value columns: primaryValue first, then any other role==='value' column;
    // never the category column, a period column, or a total column.
    const valueCols: string[] = columns
      .filter((c: any) => c.role === 'value' && c.id !== roles.category && !periodSet.has(c.id))
      .map((c: any) => c.id);
    seriesCols = [];
    if (ctx.primaryValue && ctx.primaryValue !== roles.category && !periodSet.has(ctx.primaryValue)) {
      seriesCols.push(ctx.primaryValue);
    }
    valueCols.forEach(id => { if (!seriesCols.includes(id)) seriesCols.push(id); });
    // Fallback: nothing tagged 'value' → any numeric non-category/period/total col.
    if (!seriesCols.length) seriesCols = metricCols();
  }

  const series: Array<{ name: string; values: Array<number | null> }> = [];
  for (const id of seriesCols) {
    const values = rows.map((r: any) => num(r[id]));
    if (values.some((v: any) => v != null)) series.push({ name: colLabel(ctx, id), values });
  }
  if (!series.length) return { labels: [], series: [] };
  return { labels: ctx.labels.slice(), series };
}

// ── self-check: `node src/calc.js` ──────────────────────────────────────────
// Hand-verifiable assertions so a regression in any calc fails loudly.
if (require.main === module) {
  // Explicit annotation (not a cast): assert.ok is an assertion function, and
  // TS requires the call target itself to carry a declared type (TS2775).
  const assert: typeof import('assert') = require('assert');
  const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

  // Population-style table: category + two year columns. Texas 30,000,000 →
  // 30,375,000 is exactly +1.25%.
  const table = {
    columns: [
      { id: 'state', label: 'State', role: 'category', type: 'text' },
      { id: 'y2024', label: '2024', role: 'period', type: 'number', periodOrder: 1 },
      { id: 'y2025', label: '2025', role: 'period', type: 'number', periodOrder: 2 },
    ],
    rows: [
      { state: 'California', y2024: 39000000, y2025: 39200000 },
      { state: 'Texas', y2024: 30000000, y2025: 30375000 },
      { state: 'Florida', y2024: 22000000, y2025: 22600000 },
      { state: 'New York', y2024: 19500000, y2025: 19400000 },
    ],
  };
  const roles = { category: 'state', periods: ['y2024', 'y2025'], total: null, primaryValue: 'y2025' };

  const m = computeMetrics(table, roles, [
    'yoy_pct_change', 'pct_of_total', 'rank_by_value', 'rank_by_growth',
    'concentration_top_n', 'total_change', 'gap_to_average', 'above_below_average',
    'acceleration', // NOT applicable: only 2 periods -> must be dropped
  ]);

  // yoy: Texas 30,000,000 -> 30,375,000 = +1.25%
  const yoy = m.results.yoy_pct_change.raw.rows.find((r: any) => r.label === 'Texas');
  assert.strictEqual(round(yoy.pct), 1.25, 'Texas YoY should be +1.25%');
  console.log('CHECK yoy: Texas 2024→2025 =', fmtPct(yoy.pct));

  // pct_of_total sums to ~100
  const sumShare = m.results.pct_of_total.raw.rows.reduce((s: number, r: any) => s + r.pct, 0);
  assert.ok(Math.abs(sumShare - 100) < 1e-6, 'pct_of_total must sum to 100');
  console.log('CHECK pct_of_total: shares sum to', round(sumShare, 6) + '%');

  // rank_by_value: California (39.2M) is #1, New York (19.4M) is last
  const rank = m.results.rank_by_value.raw.rows;
  assert.strictEqual(rank[0].label, 'California');
  assert.strictEqual(rank[rank.length - 1].label, 'New York');
  console.log('CHECK rank_by_value: #1 =', rank[0].label, '/ last =', rank[rank.length - 1].label);

  // rank_by_growth: Florida (+2.73%) fastest, New York (-0.51%) slowest
  const rg = m.results.rank_by_growth.raw.rows;
  assert.strictEqual(rg[0].label, 'Florida');
  assert.strictEqual(rg[rg.length - 1].label, 'New York');
  console.log('CHECK rank_by_growth: fastest =', rg[0].label, fmtPct(rg[0].pct), '/ slowest =', rg[rg.length - 1].label, fmtPct(rg[rg.length - 1].pct));

  // total_change: Texas +375,000
  const tc = m.results.total_change.raw.rows.find((r: any) => r.label === 'Texas');
  assert.strictEqual(tc.abs, 375000, 'Texas total change should be +375,000');
  console.log('CHECK total_change: Texas =', fmtNum(tc.abs));

  // applicability: acceleration needs >=3 periods -> must be absent + not selected
  assert.ok(!m.results.acceleration, 'acceleration must be N/A with 2 periods');
  assert.ok(!m.selected.find(r => r.id === 'acceleration'), 'N/A calc must not be selected');
  console.log('CHECK applicability: acceleration correctly dropped (only 2 periods)');

  // selection caps at 5
  assert.ok(m.selected.length <= 5 && m.selected.length >= 1, 'selected capped 1..5');
  console.log('CHECK selection: showing', m.selected.length, 'of', Object.keys(m.results).length, 'computed');

  // gap_to_average restates a value ranking -> computed but hidden from the list
  assert.ok(m.results.gap_to_average, 'gap_to_average still computed (engine/headline use it)');
  assert.ok(!m.selected.find(r => r.id === 'gap_to_average'), 'gap_to_average hidden when rank_by_value shown');
  console.log('CHECK gap_to_average: computed but not surfaced alongside a value ranking');

  // fmtNum: a mean-based gap (non-integer, large) must NOT leak a ".2" tail
  assert.strictEqual(fmtNum(20871533.2), '20,871,533', 'large non-integer rounds clean');
  assert.strictEqual(fmtNum(12.5), '12.5', 'mid-range keeps decimals');
  assert.strictEqual(fmtNum(375000), '375,000', 'exact count stays exact');
  console.log('CHECK fmtNum: no ".2" leak on large gaps; small values keep precision');

  // rounds-to-zero in detail lines: never "-0%"/"+0%"
  const flat = computeMetrics(
    {
      columns: [
        { id: 'n', label: 'N', role: 'category', type: 'text' },
        { id: 'a', label: '2023', role: 'period', type: 'number', periodOrder: 1 },
        { id: 'b', label: '2024', role: 'period', type: 'number', periodOrder: 2 },
      ],
      rows: [{ n: 'X', a: 1000000, b: 1000010 }, { n: 'Y', a: 100, b: 140 }],
    },
    { category: 'n', periods: ['a', 'b'], total: null, primaryValue: 'b' },
    ['yoy_pct_change']);
  const flatLines = flat.results.yoy_pct_change.lines.join(' | ');
  assert.ok(!/[+\-]0%/.test(flatLines), 'detail yoy must not show signed zero: ' + flatLines);
  console.log('CHECK detail rounds-to-zero:', flatLines);

  // empty / legacy table -> no metrics, no throw
  assert.deepStrictEqual(computeMetrics({}, {}, ['yoy_pct_change']), { selected: [], results: {} });
  assert.deepStrictEqual(computeMetrics(null, null, null), { selected: [], results: {} });
  console.log('CHECK guards: empty/legacy tables return no metrics, no throw');

  // ── deriveChartData: same { labels, series } shape buildChart() consumes ────
  // time_series: labels = categories, one series per period column (chronological)
  const tsChart = deriveChartData(table, roles, 'time_series');
  assert.deepStrictEqual(tsChart.labels, ['California', 'Texas', 'Florida', 'New York']);
  assert.deepStrictEqual(tsChart.series.map(s => s.name), ['2024', '2025']);
  assert.deepStrictEqual(tsChart.series[1].values, [39200000, 30375000, 22600000, 19400000]);
  console.log('CHECK deriveChartData[time_series]: labels=states, series=[2024,2025]');

  // categorical: labels = categories, series = value columns (primaryValue first)
  const catTable = {
    columns: [
      { id: 'product', label: 'Product', role: 'category', type: 'text' },
      { id: 'revenue', label: 'Revenue', role: 'value', type: 'number' },
      { id: 'units', label: 'Units', role: 'value', type: 'number' },
    ],
    rows: [
      { product: 'Widget', revenue: 1200, units: 40 },
      { product: 'Gadget', revenue: 900, units: 75 },
    ],
  };
  const catChart = deriveChartData(catTable, { category: 'product', periods: [], total: null, primaryValue: 'revenue' }, 'categorical');
  assert.deepStrictEqual(catChart.labels, ['Widget', 'Gadget']);
  assert.deepStrictEqual(catChart.series.map(s => s.name), ['Revenue', 'Units']); // primaryValue first
  assert.deepStrictEqual(catChart.series[0].values, [1200, 900]);
  console.log('CHECK deriveChartData[categorical]: labels=products, series=[Revenue,Units]');

  // part_to_whole: labels = categories, single value series (drives a pie/donut)
  const pwTable = {
    columns: [
      { id: 'seg', label: 'Segment', role: 'category', type: 'text' },
      { id: 'share', label: 'Share', role: 'value', type: 'number' },
      { id: 'total', label: 'Total', role: 'total', type: 'number' },
    ],
    rows: [
      { seg: 'A', share: 50, total: 100 },
      { seg: 'B', share: 30, total: 100 },
      { seg: 'C', share: 20, total: 100 },
    ],
  };
  const pwChart = deriveChartData(pwTable, { category: 'seg', periods: [], total: 'total', primaryValue: 'share' }, 'part_to_whole');
  assert.deepStrictEqual(pwChart.labels, ['A', 'B', 'C']);
  assert.deepStrictEqual(pwChart.series.map(s => s.name), ['Share']); // total column excluded
  assert.deepStrictEqual(pwChart.series[0].values, [50, 30, 20]);
  console.log('CHECK deriveChartData[part_to_whole]: labels=segments, series=[Share] (total excluded)');

  // tidy/long table: rows ARE the fiscal years, metrics are columns. Even when the
  // model mis-tags the year column as a period with dataShape time_series, the chart
  // must plot the THREE METRICS across the years — never the year values as bars.
  // The "Approximately 52,700" cell must also coerce to 52700 (num strips the word).
  const tidyTable = {
    columns: [
      { id: 'fy', label: 'Fiscal year', role: 'period', type: 'number', periodOrder: 1 },
      { id: 'emp', label: 'Number of unique employers', role: 'value', type: 'text' },
      { id: 'ben', label: 'Number of unique beneficiaries', role: 'value', type: 'number' },
      { id: 'reg', label: 'Selected Registrations', role: 'value', type: 'number' },
    ],
    rows: [
      { fy: 2025, emp: 'Approximately 52,700', ben: 423028, reg: 135137 },
      { fy: 2026, emp: 'Approximately 57,600', ben: 336153, reg: 120141 },
    ],
  };
  const tidyRoles = { category: 'fy', periods: ['fy'], total: null, primaryValue: 'ben' };
  const tidyChart = deriveChartData(tidyTable, tidyRoles, 'time_series');
  assert.deepStrictEqual(tidyChart.labels, ['2025', '2026'], 'tidy: x-axis = the years');
  assert.deepStrictEqual(
    tidyChart.series.map(s => s.name),
    ['Number of unique employers', 'Number of unique beneficiaries', 'Selected Registrations'],
    'tidy: series = the 3 metrics, not the year column');
  assert.ok(!tidyChart.series.some(s => s.name === 'Fiscal year'), 'tidy: year column is NOT a series');
  assert.deepStrictEqual(tidyChart.series[0].values, [52700, 57600], 'tidy: "Approximately 52,700" -> 52700');
  assert.deepStrictEqual(tidyChart.series[1].values, [423028, 336153], 'tidy: beneficiaries plotted');
  assert.deepStrictEqual(tidyChart.series[2].values, [135137, 120141], 'tidy: registrations plotted');
  console.log('CHECK deriveChartData[tidy/long]: 3 metrics across years, not the year bars');

  // empty / unstructured table -> nothing to plot (same as today's no-data path)
  assert.deepStrictEqual(deriveChartData({}, {}, 'unstructured'), { labels: [], series: [] });
  assert.deepStrictEqual(deriveChartData(null, null, null), { labels: [], series: [] });
  console.log('CHECK deriveChartData guards: empty/unstructured -> { labels:[], series:[] }');

  console.log('\nALL CALC SELF-CHECKS PASSED');
}
