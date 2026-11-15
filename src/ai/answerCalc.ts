// The chart form's `calc` — MAIN PROCESS, no fs of its own, no model (docs/assistant/00-design.md "Two ways to answer").
//
// A measure of an answer may be shown as one of the engine's table calculations (analysis/tableCalc): the
// model writes {"column":"revenue","aggregation":"sum","calc":"running_total"} — or {"calc":{"kind":"moving_avg",
// "window":3}} — and this file turns it into the `TableCalc` a saved visual's measure carries, `{kind, along,
// window?}`, so Save as visual keeps it. The figures are the engine's, worked out after the totals by the very
// function a visual's reply goes through (ipc/answers, ipc/liveAnswers: `applyChartCalcs`).
//
// Refused, never repaired (the answer validator's rule):
//   - a kind it does not know — a few common names are read as the kind they mean ("rank", "moving average");
//   - a window off a moving kind's whole 2–366;
//   - a direction other than across the category, or down a split the answer has;
//   - a kind worked out in date order (running total, differences, moving, YoY, index) off a date category,
//     or down the split: an answer on any other axis is ranked, so "the previous one" would be the next largest;
//   - any kind beside a top-N: the rest compare each category with every other, and the cut drops some;
//   - with a split, a calc on any measure but the first, which is the one a split chart draws.

import { CALC_KIND_NAMES, TABLE_CALC_KINDS, isMovingKind } from '../analysis/tableCalc';
import type { TableCalc, TableCalcKind } from '../analysis/tableCalc';
import { formatNumber } from '../app/format';
import { calcAlongOf, calcNeedsDate, calcSplitFirst, calcUnknown, calcWindow, calcWithTop } from './answerMessages';

const KINDS: ReadonlySet<string> = new Set(TABLE_CALC_KINDS);
const WINDOW_MIN = 2;
const WINDOW_MAX = 366; // tableCalc's own bounds

/** The kinds worked out in date order: each figure against the one before it, or the first. */
export const DATE_ORDER_KINDS: ReadonlySet<TableCalcKind> = new Set<TableCalcKind>(['running_total', 'diff', 'pct_diff', 'moving_avg', 'moving_sum', 'yoy', 'index']);

/** What a model may call a kind instead of its id, squashed (`key`). */
const ALIASES: Record<string, TableCalcKind> = {
  rank: 'rank_competition', dense_rank: 'rank_dense', cumulative: 'running_total', running_sum: 'running_total',
  percent_of_total: 'pct_of_total', share_of_total: 'pct_of_total', difference: 'diff', percent_difference: 'pct_diff',
  percent_change: 'pct_diff', moving_average: 'moving_avg', rolling_average: 'moving_avg', rolling_sum: 'moving_sum',
  year_over_year: 'yoy', percent_rank: 'percentile',
};

const key = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** A said kind → the kind, or null. */
export function calcKind(said: unknown): TableCalcKind | null {
  if (typeof said !== 'string') return null;
  const k = key(said);
  return KINDS.has(k) ? (k as TableCalcKind) : Object.hasOwn(ALIASES, k) ? ALIASES[k] : null;
}

export interface CalcAxis {
  /** The category is a date column. */
  date: boolean;
  /** The answer has a split. */
  split: boolean;
  /** The answer's top-N, when it keeps one. */
  top?: number;
}

/**
 * The model's `calc` on measure `index` → the TableCalc the measure keeps, or the reason it cannot be one.
 * `undefined` when nothing was asked.
 */
export function readAnswerCalc(raw: unknown, index: number, axis: CalcAxis): TableCalc | string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const o: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { kind: raw };
  const kind = calcKind(o.kind);
  if (!kind) return calcUnknown(typeof o.kind === 'string' ? o.kind : JSON.stringify(o.kind ?? null), TABLE_CALC_KINDS.join(', '));
  const name = CALC_KIND_NAMES[kind];
  if (axis.split && index > 0) return calcSplitFirst();
  const along = o.along === undefined || o.along === null || o.along === '' ? 'across' : o.along;
  if ((along !== 'across' && along !== 'down') || (along === 'down' && !axis.split)) return calcAlongOf();
  if (DATE_ORDER_KINDS.has(kind) && (!axis.date || along !== 'across')) return calcNeedsDate(name);
  if (axis.top) return calcWithTop(name, formatNumber(axis.top));
  const out: TableCalc = { kind, along };
  if (isMovingKind(kind) && o.window !== undefined && o.window !== null) {
    const w = o.window;
    if (typeof w !== 'number' || !Number.isInteger(w) || w < WINDOW_MIN || w > WINDOW_MAX) return calcWindow(formatNumber(WINDOW_MIN), formatNumber(WINDOW_MAX));
    out.window = w;
  }
  return out;
}
