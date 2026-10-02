// How a chart's CATEGORY dimension is bucketed — MAIN PROCESS, PURE. No
// Electron, no fs, no DOM, no DuckDB.
//
// A Category on a high-cardinality column draws thousands of unreadable marks.
// Three fixes: a number column bins into 10 equal-width buckets, a date column
// rolls up to a grain, a text column keeps its top 50 and folds the rest into
// one "Other" group.
//
// This file exists because the SAME rewrite has to happen twice: once in the
// pure JS reference (`vizData.buildVizData`) and once in SQL (`residentQuery`).
// Any decision or label that lived on only one side would let the two paths
// disagree — a bucket boundary off by one ULP, a `2024-Q1` written `2024-Q01`.
// So both paths call the functions below and NEITHER formats a label of its
// own: SQL returns an integer bucket id and `dateBucketLabel`/`binLabel` here
// turn it into text.

import type { Cell } from '../data/transforms';
import { civilFromDays, daysFromCivil } from './civilDays';
import type { CivilDate } from './civilDays';
import { activeWeekCal, bucketStartOf, unitOfGrain, weekLabel } from './retailCalendar';

export { civilFromDays, daysFromCivil };

export type DateGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Coarsening order. `chooseGrain` walks it and stops at the first that fits. */
export const DATE_GRAINS: readonly DateGrain[] = ['day', 'week', 'month', 'quarter', 'year'];

/** Past this many marks a time axis is a smear, not a series. */
export const GRAIN_MAX_POINTS = 60;

/** Distinct text categories kept before the tail becomes one "Other" group. */
export const CATEGORY_CAP = 50;

export const NUM_BINS = 10;
export const OTHER_LABEL = 'Other';

/** The inline note a capped chart shows. One string, both paths. */
export const OTHER_NOTE = 'Showing top 50 by value, others grouped';

/** What the category axis actually ended up being — reported to the renderer. */
export interface CategoryInfo {
  kind: 'text' | 'date' | 'number';
  /** The grain actually used. Date categories only. */
  grain?: DateGrain;
  /** True when a numeric category was binned. */
  binned?: boolean;
  /** Ready-to-show inline note (the cap). NOT a warning — see ipc/visuals. */
  note?: string;
}

// ── The date grammar ─────────────────────────────────────────────────────────
//
// ONE grammar for the whole app, matching the shapes `parse.looksLikeDate`
// types as `date` (a date column is stored as the ORIGINAL STRING, never
// normalised to ISO, so every reader has to re-parse). The two regex shapes are
// CANONICAL: they are the only two SQL implements, so a column carrying
// anything else (`Jan 5, 2023`) sends the resident path home and the JS
// `Date.parse` fallback answers.

const ISO_SHAPE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const US_SHAPE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/; // MM/DD/YYYY — looksLikeDate's order

export type { CivilDate } from './civilDays';

/** Empty is `null` OR `''` OR whitespace — the same class the SQL side spells out. */
function isEmpty(cell: Cell): boolean {
  return cell == null || String(cell).trim() === '';
}

/** The components a canonical SHAPE carries, before any calendar check. */
function canonicalShape(s: string): CivilDate | null {
  const iso = ISO_SHAPE.exec(s);
  const us = iso ? null : US_SHAPE.exec(s);
  const m = iso ?? us;
  if (!m) return null;
  return iso
    ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
    : { y: Number(m[3]), m: Number(m[1]), d: Number(m[2]) };
}

/** A REAL calendar date: Feb 31 and month 13 match the shapes and are not dates. */
function isRealDate(c: CivilDate): boolean {
  const back = civilFromDays(daysFromCivil(c.y, c.m, c.d));
  return back.y === c.y && back.m === c.m && back.d === c.d;
}

/** True when SQL can parse this cell too — the resident path's precondition. */
export function isCanonicalDateCell(cell: Cell): boolean {
  if (isEmpty(cell)) return false;
  const c = canonicalShape(String(cell));
  return c !== null && isRealDate(c);
}

/**
 * A stored date cell → its civil date, or `null`.
 *
 * Text of NEITHER canonical shape falls back to `Date.parse`, read with UTC
 * getters so a timezone west of Greenwich cannot shift `2023-01-01` back into
 * 2022. A string that DOES match a shape never reaches that fallback, valid or
 * not: `Date.parse('2023-02-31')` rolls over to March 3rd, where SQL's
 * `TRY_CAST(… AS DATE)` returns NULL — so falling through would put the same
 * cell in two different buckets depending on which path answered.
 */
export function parseDateCell(cell: Cell): CivilDate | null {
  if (isEmpty(cell)) return null;
  const s = String(cell);
  const c = canonicalShape(s);
  if (c) return isRealDate(c) ? c : null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * The bucket id: the epoch day number of the bucket's FIRST day.
 *
 * An integer, not a label, because that is what SQL returns — `date_trunc` then
 * the day offset from 1970-01-01. Week starts MONDAY (ISO), matching
 * `date_trunc('week', …)`: 1970-01-01 was a Thursday, so Monday-index is
 * `(day + 3) mod 7`.
 *
 * Under a week calendar (Settings → Formats → Calendar: retail or ISO) every
 * grain but `day` is that calendar's bucket instead — `month` is its period —
 * and `residentCategory.dateBucketSql` compiles the same calendar.
 */
export function dateBucket(parsed: CivilDate, grain: DateGrain): number {
  const wc = grain === 'day' ? null : activeWeekCal();
  if (wc) return bucketStartOf(daysFromCivil(parsed.y, parsed.m, parsed.d), unitOfGrain(grain)!, wc);
  if (grain === 'year') return daysFromCivil(parsed.y, 1, 1);
  if (grain === 'quarter') return daysFromCivil(parsed.y, 1 + 3 * Math.floor((parsed.m - 1) / 3), 1);
  if (grain === 'month') return daysFromCivil(parsed.y, parsed.m, 1);
  const day = daysFromCivil(parsed.y, parsed.m, parsed.d);
  if (grain === 'day') return day;
  const dow = ((day + 3) % 7 + 7) % 7; // 0 = Monday, floor-mod for pre-1970 days
  return day - dow;
}

function pad(n: number, width: number): string {
  return (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(width, '0');
}

/** The bucket id → the axis label. The ONLY place a group label is formatted. */
export function dateBucketLabel(epochDay: number, grain: DateGrain): string {
  const wc = grain === 'day' ? null : activeWeekCal();
  if (wc) return weekLabel(epochDay, unitOfGrain(grain)!, wc);
  const c = civilFromDays(epochDay);
  const y = pad(c.y, 4);
  if (grain === 'year') return y;
  if (grain === 'quarter') return `${y}-Q${Math.floor((c.m - 1) / 3) + 1}`;
  if (grain === 'month') return `${y}-${pad(c.m, 2)}`;
  return `${y}-${pad(c.m, 2)}-${pad(c.d, 2)}`; // day and week both name their first day
}

/**
 * The default grain: the FIRST (finest) that keeps the axis under
 * GRAIN_MAX_POINTS marks. Nothing qualifies (decades of daily data) → 'year',
 * which is the coarsest we have; a long axis beats a wrong one.
 */
export function chooseGrain(countsByGrain: Readonly<Record<DateGrain, number>>): DateGrain {
  for (const g of DATE_GRAINS) {
    const n = countsByGrain[g];
    if (typeof n === 'number' && n <= GRAIN_MAX_POINTS) return g;
  }
  return 'year';
}

export function isDateGrain(v: unknown): v is DateGrain {
  return typeof v === 'string' && (DATE_GRAINS as readonly string[]).includes(v);
}

// ── Numeric binning ──────────────────────────────────────────────────────────

export interface BinPlan {
  lo: number;
  hi: number;
  width: number;
  bins: number;
}

/** The most buckets an encoding may ask for. See `sanitizeBins`. */
export const MAX_BINS = 100;

/**
 * A caller-supplied bucket count, or `NUM_BINS`.
 *
 * DROPPED, never clamped — the same rule `visuals.sanitizeEncoding` applies to
 * `grain` and every other enum it whitelists. An absent `bins` already means
 * "use the default", so silently turning a bad 5,000 into 100 would draw a
 * chart nobody asked for and call it the one they did.
 *
 * Two is the floor because one bucket is the DEGENERATE case below (a flat or
 * empty column), not something an encoding gets to request. `MAX_BINS` is the
 * ceiling because the bucket count is a GROUP BY cardinality on the resident
 * path and an axis on the rendered one, and neither wants five thousand.
 */
export function sanitizeBins(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  if (raw < 2 || raw > MAX_BINS) return undefined;
  return raw;
}

/**
 * (min, max) of the filtered numeric cells → the bin geometry. Shared so the
 * degenerate cases collapse identically on both paths: a single distinct value,
 * an all-empty column (min/max NULL), or a range that underflows to zero width
 * all become ONE bucket rather than N identical ones or a division by zero.
 *
 * `bins` is the encoding's bucket count where it named one (the column-profile
 * panel asks for 20), `NUM_BINS` otherwise. It is a PARAMETER rather than a
 * module constant because both paths — `vizData.rewriteCategory` and
 * `residentQuery.binKey` — call this one function, so a per-chart count cannot
 * make the two disagree about where a bucket edge falls. Anything outside
 * `sanitizeBins`'s range falls back to the default rather than being honoured.
 */
export function binPlan(lo: number | null, hi: number | null, bins?: number): BinPlan {
  const l = typeof lo === 'number' && Number.isFinite(lo) ? lo : 0;
  const h = typeof hi === 'number' && Number.isFinite(hi) ? hi : 0;
  const n = sanitizeBins(bins) ?? NUM_BINS;
  const width = (h - l) / n;
  if (!Number.isFinite(width) || width <= 0) return { lo: l, hi: h, width: 1, bins: 1 };
  return { lo: l, hi: h, width, bins: n };
}

/**
 * Which bucket a value falls in. SQL computes `greatest(least(floor((n - lo) /
 * width), bins - 1), 0)` on the same two bound doubles: subtract, divide, floor
 * involve no reassociation, so unlike `sum` this is bit-identical to the line
 * below rather than merely close.
 */
export function binIndex(v: number, lo: number, width: number, bins: number): number {
  return Math.max(0, Math.min(Math.floor((v - lo) / width), bins - 1));
}

// Intl, not a hand-rolled formatter: 500 → "500", 1200 → "1.2K", and the
// thresholds/suffixes are the platform's, not ours to get wrong.
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * The bucket's axis label. The LAST bucket's upper edge is the observed `hi`
 * exactly, not `lo + bins*width` — floating-point accumulation would otherwise
 * print a top edge the data never reaches.
 */
export function binLabel(i: number, lo: number, width: number, bins: number, hi: number): string {
  const edgeLo = lo + i * width;
  const edgeHi = i >= bins - 1 ? hi : lo + (i + 1) * width;
  return `${COMPACT.format(edgeLo)}–${COMPACT.format(edgeHi)}`; // EN DASH
}
