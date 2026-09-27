// RFM — recency, frequency, monetary — MAIN PROCESS, PURE.
//
// Pick a customer id, an order date and an amount; every customer gets
//
//   recency    days from their last order to the LATEST order date in the
//              data (never "today", so the same data scores the same way on
//              any day),
//   frequency  how many orders (rows) they have,
//   monetary   the sum of their amounts,
//
// and a 1–5 score for each by quintile. Rows without an id, a readable date
// (dateIntel.periodDay's shapes) or a finite amount are left out and counted.
//
// QUINTILES, EXPLICITLY. Customers are ranked by the value with ties broken
// by FIRST-SEEN order (the order their first included row appears), and the
// customer at 0-based position p of n scores floor(p·5/n) + 1 — the
// `qcut(rank(method='first'), 5)` rule most published RFM work uses. Frequency
// and monetary rank ascending (more is better → 5). Recency ranks ascending
// too, and a SMALLER recency is better, so its score is 5 − floor(p·5/n).
//
// THE SEGMENT GRID. The widely published R × F segment map (the one behind
// most RFM write-ups: "Champions", "At Risk", "Can't Lose Them"…) with
// FM = the half-up average of F and M in place of F, and its bottom-left
// corner split so that R = 1 is "Lost" and R = 2 "Hibernating":
//
//            FM=1             FM=2                 FM=3                 FM=4              FM=5
//   R=5   New Customers    Potential Loyalists  Potential Loyalists  Champions         Champions
//   R=4   Promising        Potential Loyalists  Potential Loyalists  Loyal Customers   Loyal Customers
//   R=3   About to Sleep   About to Sleep       Need Attention       Loyal Customers   Loyal Customers
//   R=2   Hibernating      Hibernating          At Risk              At Risk           Can't Lose Them
//   R=1   Lost             Lost                 At Risk              At Risk           Can't Lose Them
//
// Eleven segments, each reachable. The per-customer aggregation has a
// resident twin (engine/segmentResident.ts) held to `rfmCustomersJs` by a
// differential test; the scoring below is shared by both.

import type { Cell, TableData } from '../data/transforms';
import { periodDay } from './dateIntel';

export const RFM_SEGMENTS = [
  'Champions', 'Loyal Customers', 'Potential Loyalists', 'New Customers', 'Promising',
  'Need Attention', 'About to Sleep', 'At Risk', "Can't Lose Them", 'Hibernating', 'Lost',
] as const;
export type RfmSegment = (typeof RFM_SEGMENTS)[number];

/** RFM_GRID[5 − R][FM − 1]. */
export const RFM_GRID: RfmSegment[][] = [
  ['New Customers', 'Potential Loyalists', 'Potential Loyalists', 'Champions', 'Champions'],
  ['Promising', 'Potential Loyalists', 'Potential Loyalists', 'Loyal Customers', 'Loyal Customers'],
  ['About to Sleep', 'About to Sleep', 'Need Attention', 'Loyal Customers', 'Loyal Customers'],
  ['Hibernating', 'Hibernating', 'At Risk', 'At Risk', "Can't Lose Them"],
  ['Lost', 'Lost', 'At Risk', 'At Risk', "Can't Lose Them"],
];

/** A one-line reading of each segment, for the table. */
export const RFM_MEANING: Record<RfmSegment, string> = {
  Champions: 'Bought recently, buy often and spend the most',
  'Loyal Customers': 'Buy often and spend well',
  'Potential Loyalists': 'Recent customers with average frequency',
  'New Customers': 'Bought most recently, but not often',
  Promising: 'Recent shoppers who have not spent much yet',
  'Need Attention': 'Above-average recency, frequency and spend',
  'About to Sleep': 'Below-average recency and frequency',
  'At Risk': 'Spent well and bought often, but long ago',
  "Can't Lose Them": 'Used to buy the most, but have not returned',
  Hibernating: 'Last bought long ago, with low spend',
  Lost: 'The lowest recency, frequency and spend',
};

export interface RfmSpec {
  id: string;
  date: string;
  amount: string;
}

export interface RfmCustomer {
  id: string;
  /** Epoch day of the latest order. */
  last: number;
  frequency: number;
  monetary: number;
}

export interface RfmCustomers {
  customers: RfmCustomer[];
  /** Rows that went into the scores. */
  used: number;
  /** Rows left out: no id, no readable date, or no finite amount. */
  skipped: number;
}

interface ColLike {
  name: string;
  type: string;
}

/** Why these columns cannot be scored, or null. */
export function rfmProblem(columns: ColLike[], spec: Partial<RfmSpec>): string | null {
  const find = (n: unknown): ColLike | undefined => columns.find((c) => c.name === n);
  if (!find(spec.id)) return 'Pick the customer id column.';
  if (!find(spec.date)) return 'Pick the order date column.';
  const amount = find(spec.amount);
  if (!amount) return 'Pick the amount column.';
  if (amount.type !== 'number') return `"${amount.name}" is not a number column.`;
  if (spec.id === spec.date || spec.id === spec.amount || spec.date === spec.amount) return 'Pick three different columns.';
  return null;
}

/** Best guesses for the three pickers, from names and declared types; '' when nothing fits. */
export function rfmDefaults(columns: ColLike[]): RfmSpec {
  const first = (ok: (c: ColLike) => boolean): string => columns.find(ok)?.name || '';
  // A WHO column that is an identifier ("customer_id", "Client No", "email") —
  // never a category such as "customer_segment"; nothing fits → '' (the user picks).
  const who = /customer|client|user|account|member|buyer|shopper|contact/i;
  const idTail = (n: string): boolean => /(?:^|[\s_.-])(?:id|key|code|no|number|num)$/i.test(n) || /[a-z](?:Id|ID|No)$/.test(n);
  const id = first((c) => who.test(c.name) && idTail(c.name.trim())) || first((c) => /e-?mail/i.test(c.name));
  const date = first((c) => c.type === 'date' && c.name !== id) || first((c) => /date|time|day/i.test(c.name) && c.name !== id);
  const nums = columns.filter((c) => c.type === 'number' && c.name !== id);
  const amount = [/revenue|sales|amount|total|spend|paid/i, /value|price/i]
    .map((re) => nums.find((c) => re.test(c.name))?.name || '')
    .find(Boolean) || '';
  return { id, date, amount };
}

const isEmpty = (c: Cell | undefined): boolean => c == null || (typeof c === 'string' && c.trim() === '');

/** The JS REFERENCE: one entry per customer, in first-seen order. */
export function rfmCustomersJs(t: TableData, spec: RfmSpec): RfmCustomers {
  const at = (n: string): number => t.columns.findIndex((c) => c.name === n);
  const ii = at(spec.id);
  const di = at(spec.date);
  const ai = at(spec.amount);
  const byId = new Map<string, RfmCustomer>();
  let used = 0;
  for (const r of t.rows) {
    const id = r[ii];
    const day = periodDay(r[di]);
    const amt = r[ai];
    if (isEmpty(id) || day === null || typeof amt !== 'number' || !Number.isFinite(amt)) continue;
    used++;
    const key = String(id);
    const c = byId.get(key);
    if (!c) byId.set(key, { id: key, last: day, frequency: 1, monetary: amt });
    else {
      if (day > c.last) c.last = day;
      c.frequency++;
      c.monetary += amt;
    }
  }
  return { customers: [...byId.values()], used, skipped: t.rows.length - used };
}

export interface RfmScored extends RfmCustomer {
  recency: number;
  r: number;
  f: number;
  m: number;
  segment: RfmSegment;
}

/** Quintile score by position; `better` = 'low' when a smaller value is better. */
function quintiles(values: number[], better: 'high' | 'low'): number[] {
  const n = values.length;
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  const out = new Array<number>(n);
  order.forEach((i, p) => {
    const q = Math.floor((p * 5) / n);
    out[i] = better === 'high' ? q + 1 : 5 - q;
  });
  return out;
}

export function rfmSegment(r: number, f: number, m: number): RfmSegment {
  const fm = Math.floor((f + m + 1) / 2);
  return RFM_GRID[5 - r][fm - 1];
}

/** Scores and segments for every customer, in the order given. */
export function scoreRfm(customers: RfmCustomer[]): { scored: RfmScored[]; maxDay: number | null } {
  if (!customers.length) return { scored: [], maxDay: null };
  let maxDay = customers[0].last;
  for (const c of customers) if (c.last > maxDay) maxDay = c.last;
  const recency = customers.map((c) => maxDay - c.last);
  const r = quintiles(recency, 'low');
  const f = quintiles(customers.map((c) => c.frequency), 'high');
  const m = quintiles(customers.map((c) => c.monetary), 'high');
  const scored = customers.map((c, i) => ({ ...c, recency: recency[i], r: r[i], f: f[i], m: m[i], segment: rfmSegment(r[i], f[i], m[i]) }));
  return { scored, maxDay };
}

export interface RfmSegmentRow {
  name: RfmSegment;
  meaning: string;
  count: number;
  share: number;
  /** Averages over the segment's customers; null when it has none. */
  recency: number | null;
  frequency: number | null;
  monetary: number | null;
}

export interface RfmResult {
  customers: number;
  used: number;
  skipped: number;
  /** ISO date the recency is measured from. */
  asOf: string | null;
  segments: RfmSegmentRow[];
  /** Customers per cell, grid[5 − R][FM − 1] — the RFM_GRID layout. */
  grid: number[][];
  /** RFM_GRID itself, so the panel draws the map it was scored with. */
  layout: RfmSegment[][];
}

function isoOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** The eleven-row breakdown the panel shows (every segment listed, empty ones too). */
export function rfmBreakdown(agg: RfmCustomers): RfmResult {
  const { scored, maxDay } = scoreRfm(agg.customers);
  const n = scored.length;
  const grid = RFM_GRID.map((row) => row.map(() => 0));
  for (const c of scored) grid[5 - c.r][Math.floor((c.f + c.m + 1) / 2) - 1]++;
  const segments = RFM_SEGMENTS.map((name): RfmSegmentRow => {
    let count = 0;
    let rec = 0;
    let freq = 0;
    let mon = 0;
    for (const c of scored) {
      if (c.segment !== name) continue;
      count++;
      rec += c.recency;
      freq += c.frequency;
      mon += c.monetary;
    }
    return {
      name,
      meaning: RFM_MEANING[name],
      count,
      share: n ? count / n : 0,
      recency: count ? rec / count : null,
      frequency: count ? freq / count : null,
      monetary: count ? mon / count : null,
    };
  });
  return { customers: n, used: agg.used, skipped: agg.skipped, asOf: maxDay === null ? null : isoOfDay(maxDay), segments, grid, layout: RFM_GRID.map((row) => row.slice()) };
}

/** The customer-level table "Save as dataset" writes: an ordinary dataset. */
export function rfmTable(agg: RfmCustomers, idName: string): TableData {
  const { scored } = scoreRfm(agg.customers);
  const used = new Set([idName]);
  const name = (base: string): string => {
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
    used.add(n);
    return n;
  };
  const columns = [
    { name: idName, type: 'text' as const },
    ...['recency', 'frequency', 'monetary', 'r', 'f', 'm'].map((b) => ({ name: name(b), type: 'number' as const })),
    { name: name('rfm_segment'), type: 'text' as const },
  ];
  return {
    columns,
    rows: scored.map((c) => [c.id, c.recency, c.frequency, c.monetary, c.r, c.f, c.m, c.segment]),
  };
}
