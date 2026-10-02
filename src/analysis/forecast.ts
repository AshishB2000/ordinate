// Forecasts — PURE, MAIN PROCESS, NO MODEL. The forecast overlay's maths,
// split out of ./analytics.ts (one job: extend a series past its last period).
//
// Three methods, all deterministic:
//
//   linear          OLS on position, extrapolated; the 80% interval is the OLS
//                   prediction interval (z = 1.2816, the normal 90th percentile,
//                   rather than Student's t — the series here are 12–60 points,
//                   where the two differ by a few percent of the width).
//   seasonal_naive  each future period repeats the same period one season ago
//                   (the last value, with no season); the interval widens with
//                   the number of seasons ahead, from the seasonal differences.
//   holt_winters    additive level + trend + season (Holt's linear without a
//                   season), smoothing weights picked by a fixed grid search on
//                   one-step squared error; interval σ·√h from those errors.
//
// Seasonality is detected at 4, 7 and 12 (quarters, days of a week, months):
// the candidate whose autocorrelation of the DETRENDED series is highest, if it
// clears 0.3 and the series holds at least two full seasons.
//
// ponytail: the Holt-Winters interval is the σ·√h approximation, not the exact
// state-space formula. Upgrade to the ETS(A,A,A) variance if a forecast's band
// is ever read as a guarantee.

import type { DateGrain } from './categoryKey';
import { civilFromDays, daysFromCivil } from './categoryKey';
import { daysFromIso, isoFromDays } from './dateIntel';
import { activeWeekCal, ordinalOf, ordinalStart, unitOfGrain, weekLabel, weekLabelStart } from './retailCalendar';

export type ForecastMethod = 'linear' | 'seasonal_naive' | 'holt_winters';

export interface ForecastResult {
  method: ForecastMethod;
  /** The season used, 0 for none. */
  season: number;
  values: number[];
  lo: number[];
  hi: number[];
}

const Z80 = 1.2815515655446004;
const CANDIDATES = [4, 7, 12];
const GRID = [0.1, 0.3, 0.5, 0.7, 0.9];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The series a forecast is fitted to: leading and trailing nulls trimmed,
 * interior nulls filled by straight-line interpolation (a missing month is not
 * a zero). `tail` is how many trailing positions were empty — the forecast has
 * to step over them to land on the periods AFTER the last label.
 */
export function fitSeries(values: unknown[]): { ys: number[]; tail: number } {
  let a = 0;
  while (a < values.length && !finite(values[a])) a++;
  let b = values.length - 1;
  while (b >= a && !finite(values[b])) b--;
  const tail = values.length - 1 - b;
  const ys: number[] = [];
  for (let i = a; i <= b; i++) {
    const v = values[i];
    if (finite(v)) { ys.push(v); continue; }
    let j = i + 1;
    while (!finite(values[j])) j++;
    const prev = ys[ys.length - 1];
    const next = values[j] as number;
    ys.push(prev + (next - prev) / (j - i + 1));
  }
  return { ys, tail };
}

function ols(ys: number[]): { slope: number; intercept: number; se: number; mx: number; sxx: number } {
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  let sxx = 0; let sxy = 0;
  ys.forEach((y, x) => { sxx += (x - mx) * (x - mx); sxy += (x - mx) * (y - my); });
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let ss = 0;
  ys.forEach((y, x) => { const e = y - (intercept + slope * x); ss += e * e; });
  const se = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return { slope, intercept, se, mx, sxx };
}

/** Lag-k autocorrelation of a series (its own mean removed). */
export function autocorrelation(xs: number[], lag: number): number {
  const n = xs.length;
  if (lag <= 0 || lag >= n) return 0;
  const m = xs.reduce((a, v) => a + v, 0) / n;
  let num = 0; let den = 0;
  for (let t = 0; t < n; t++) den += (xs[t] - m) * (xs[t] - m);
  for (let t = lag; t < n; t++) num += (xs[t] - m) * (xs[t - lag] - m);
  return den === 0 ? 0 : num / den;
}

/** 4, 7 or 12 — or 0 when no candidate clears the bar. Ties go to the shorter season. */
export function detectSeason(ys: number[]): number {
  if (ys.length < 8) return 0;
  const { slope, intercept } = ols(ys);
  const resid = ys.map((y, x) => y - (intercept + slope * x));
  let best = 0;
  let bestAcf = 0.3;
  for (const m of CANDIDATES) {
    if (ys.length < 2 * m) continue;
    const a = autocorrelation(resid, m);
    if (a > bestAcf) { best = m; bestAcf = a; }
  }
  return best;
}

function linearForecast(ys: number[], steps: number): ForecastResult {
  const n = ys.length;
  const { slope, intercept, se, mx, sxx } = ols(ys);
  const out: ForecastResult = { method: 'linear', season: 0, values: [], lo: [], hi: [] };
  for (let h = 1; h <= steps; h++) {
    const x = n - 1 + h;
    const v = intercept + slope * x;
    const half = Z80 * se * Math.sqrt(1 + 1 / n + (sxx === 0 ? 0 : ((x - mx) * (x - mx)) / sxx));
    out.values.push(v); out.lo.push(v - half); out.hi.push(v + half);
  }
  return out;
}

function seasonalNaive(ys: number[], m: number, steps: number): ForecastResult {
  const n = ys.length;
  const lag = m || 1;
  let ss = 0; let k = 0;
  for (let t = lag; t < n; t++) { const e = ys[t] - ys[t - lag]; ss += e * e; k++; }
  const sigma = k ? Math.sqrt(ss / k) : 0;
  const out: ForecastResult = { method: 'seasonal_naive', season: m, values: [], lo: [], hi: [] };
  for (let h = 1; h <= steps; h++) {
    const back = lag * Math.ceil(h / lag);
    const v = ys[n - 1 + h - back];
    const half = Z80 * sigma * Math.sqrt(Math.floor((h - 1) / lag) + 1);
    out.values.push(v); out.lo.push(v - half); out.hi.push(v + half);
  }
  return out;
}

/** One Holt-Winters pass: the one-step SSE and the final state. `m` = 0 is Holt's linear. */
function hwRun(ys: number[], m: number, alpha: number, beta: number, gamma: number):
  { sse: number; count: number; level: number; trend: number; season: number[] } {
  const n = ys.length;
  let level: number; let trend: number; let start: number;
  const season: number[] = [];
  if (m) {
    const first = ys.slice(0, m).reduce((a, v) => a + v, 0) / m;
    const second = ys.slice(m, 2 * m).reduce((a, v) => a + v, 0) / m;
    level = first;
    trend = (second - first) / m;
    for (let i = 0; i < m; i++) season.push(ys[i] - first);
    start = m;
  } else {
    level = ys[0];
    trend = ys[1] - ys[0];
    start = 1;
  }
  let sse = 0; let count = 0;
  for (let t = start; t < n; t++) {
    const s = m ? season[t % m] : 0;
    const e = ys[t] - (level + trend + s);
    sse += e * e; count++;
    const prevLevel = level;
    level = alpha * (ys[t] - s) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    if (m) season[t % m] = gamma * (ys[t] - level) + (1 - gamma) * s;
  }
  return { sse, count, level, trend, season };
}

function holtWinters(ys: number[], m: number, steps: number): ForecastResult {
  let best = { sse: Infinity, a: GRID[0], b: GRID[0], g: 0 };
  for (const a of GRID) for (const b of GRID) for (const g of (m ? GRID : [0])) {
    const r = hwRun(ys, m, a, b, g);
    if (r.sse < best.sse) best = { sse: r.sse, a, b, g };
  }
  const run = hwRun(ys, m, best.a, best.b, best.g);
  const sigma = run.count ? Math.sqrt(run.sse / run.count) : 0;
  const n = ys.length;
  const out: ForecastResult = { method: 'holt_winters', season: m, values: [], lo: [], hi: [] };
  for (let h = 1; h <= steps; h++) {
    const v = run.level + h * run.trend + (m ? run.season[(n + h - 1) % m] : 0);
    const half = Z80 * sigma * Math.sqrt(h);
    out.values.push(v); out.lo.push(v - half); out.hi.push(v + half);
  }
  return out;
}

/**
 * Forecast `horizon` periods past the LAST LABEL. `season: 'auto'` detects one;
 * a number forces it (0 = none). Returns `{ error }` instead of a guess when the
 * series is too short for the method.
 */
export function forecastSeries(
  values: unknown[],
  opts: { method: ForecastMethod; horizon: number; season: 'auto' | number },
): ForecastResult | { error: string } {
  const { ys, tail } = fitSeries(values);
  const horizon = Math.max(1, Math.min(36, Math.floor(opts.horizon) || 1));
  const steps = tail + horizon;
  if (ys.length < 3) return { error: 'Needs at least three periods' };
  const m = opts.season === 'auto' ? detectSeason(ys) : Math.max(0, Math.floor(opts.season));
  let r: ForecastResult;
  if (opts.method === 'seasonal_naive') {
    if (m && ys.length < m) return { error: `Needs at least ${m} periods for a season of ${m}` };
    r = seasonalNaive(ys, m, steps);
  } else if (opts.method === 'holt_winters') {
    if (m && ys.length < 2 * m) return { error: `Needs at least ${2 * m} periods for a season of ${m}` };
    r = holtWinters(ys, m, steps);
  } else {
    r = linearForecast(ys, steps);
  }
  return { ...r, values: r.values.slice(tail), lo: r.lo.slice(tail), hi: r.hi.slice(tail) };
}

// ── the future axis ──────────────────────────────────────────────────────────

/**
 * The grain the axis actually STEPS by. A `day` axis whose every bucket is the
 * 1st of a month is a monthly series (the sample's Month field is exactly that),
 * and its next period is next month, not tomorrow.
 */
export function stepGrainOf(labels: string[], grain: DateGrain): DateGrain {
  if (grain !== 'day' || !labels.length) return grain;
  return labels.every((l) => /^\d{4}-\d{2}-01$/.test(l)) ? 'month' : grain;
}

/** The `count` bucket labels after the last one, in the axis's own format. Null if it does not parse. */
export function futureLabels(labels: string[], grain: DateGrain, count: number): string[] | null {
  const last = labels[labels.length - 1];
  if (last === undefined) return null;
  const out: string[] = [];
  const wc = grain === 'day' ? null : activeWeekCal();
  if (wc) {
    const unit = unitOfGrain(grain)!;
    const first = weekLabelStart(last, unit, wc);
    if (first === null) return null;
    const o = ordinalOf(first, unit, wc);
    for (let i = 1; i <= count; i++) out.push(weekLabel(ordinalStart(o + i, unit, wc), unit, wc));
    return out;
  }
  if (grain === 'year') {
    if (!/^\d{4}$/.test(last)) return null;
    for (let i = 1; i <= count; i++) out.push(String(Number(last) + i).padStart(4, '0'));
    return out;
  }
  if (grain === 'quarter') {
    const m = /^(\d{4})-Q([1-4])$/.exec(last);
    if (!m) return null;
    let y = Number(m[1]); let q = Number(m[2]);
    for (let i = 0; i < count; i++) { q++; if (q > 4) { q = 1; y++; } out.push(`${String(y).padStart(4, '0')}-Q${q}`); }
    return out;
  }
  if (grain === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(last);
    if (!m) return null;
    let y = Number(m[1]); let mo = Number(m[2]);
    for (let i = 0; i < count; i++) { mo++; if (mo > 12) { mo = 1; y++; } out.push(`${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}`); }
    return out;
  }
  const day = daysFromIso(last);
  if (day === null) return null;
  const step = stepGrainOf(labels, grain);
  if (step === 'month') {
    const c = civilFromDays(day);
    let y = c.y; let mo = c.m;
    for (let i = 0; i < count; i++) { mo++; if (mo > 12) { mo = 1; y++; } out.push(isoFromDays(daysFromCivil(y, mo, 1))); }
    return out;
  }
  const inc = grain === 'week' ? 7 : 1;
  for (let i = 1; i <= count; i++) out.push(isoFromDays(day + inc * i));
  return out;
}
