// The live-parity COMPARATORS — helper for scripts/test-liveParity.ts.
//
// Every function returns a list of PROBLEMS (empty = agree) instead of asserting,
// so the negative control can run the very same comparison and assert that it
// does find something.
//
// What "agree" means, exactly:
//   - labels and every non-sum value: `Object.is`;
//   - sum and avg values (and so "Other" and every roll-up built from them): the
//     documented float-summation divergence only — parallel summation differs
//     from a JS left fold by ~1e-13 relative (CLAUDE.md, the resident layer). The
//     largest deviation seen is recorded so the log can quote it;
//   - order: NOT compared across paths — each path is checked against its own
//     rule (extract: first-seen; live: dates/bins ascending, text by value).

import type { LiveChart } from '../src/engine/live/shape';

export interface ChartLike {
  labels: (string | number)[];
  series: { name: string; values: (number | null)[] }[];
}

export const REL_TOL = 1e-13;
export const stats = { maxRelDev: 0, tolerated: 0 };

/** `Object.is`, or — for a sum/avg figure — within the documented float tolerance. */
export function sameNumber(a: number | null, b: number | null, tolerant: boolean): boolean {
  if (Object.is(a, b)) return true;
  if (!tolerant || typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  const dev = Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
  if (dev > REL_TOL) return false;
  stats.maxRelDev = Math.max(stats.maxRelDev, dev);
  stats.tolerated += 1;
  return true;
}

function show(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x));
}

/**
 * The two charts hold the same (label, values…) rows as MULTISETS. Series are
 * aligned by position when `byName` is false (one series per measure, same
 * order on both paths) and by name for a split (each path orders its own).
 */
export function compareCharts(ext: ChartLike, live: ChartLike, tolerant: (seriesIndex: number) => boolean, byName: boolean): string[] {
  const out: string[] = [];
  if (ext.series.length !== live.series.length) {
    return [`series count ${ext.series.length} vs ${live.series.length}: ${show(ext.series.map((s) => s.name))} / ${show(live.series.map((s) => s.name))}`];
  }
  let align: number[];
  if (byName) {
    align = ext.series.map((s) => live.series.findIndex((l) => l.name === s.name));
    if (align.some((i) => i < 0) || new Set(align).size !== align.length) {
      return [`series names differ: ${show(ext.series.map((s) => s.name))} / ${show(live.series.map((s) => s.name))}`];
    }
  } else {
    align = ext.series.map((_s, i) => i);
    ext.series.forEach((s, i) => { if (s.name !== live.series[i].name) out.push(`series ${i} named ${show(s.name)} vs ${show(live.series[i].name)}`); });
  }
  if (ext.labels.length !== live.labels.length) out.push(`label count ${ext.labels.length} vs ${live.labels.length}`);
  const used = new Set<number>();
  ext.labels.forEach((label, r) => {
    const want = ext.series.map((s) => s.values[r]);
    const hit = live.labels.findIndex((l, j) => !used.has(j) && Object.is(l, label)
      && want.every((v, k) => sameNumber(v, live.series[align[k]].values[j], tolerant(k))));
    if (hit < 0) {
      const near = live.labels.findIndex((l) => Object.is(l, label));
      out.push(`row ${show(label)} ${show(want)} has no twin` +
        (near >= 0 ? ` (live ${show(align.map((a) => live.series[a].values[near]))})` : ' (label missing)'));
    } else {
      used.add(hit);
    }
  });
  live.labels.forEach((l, j) => { if (!used.has(j)) out.push(`live row ${show(l)} is extra`); });
  return out.slice(0, 6);
}

/** Code-point order — DuckDB's VARCHAR order, the bench's tie-break. */
function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!); // code points, on purpose: DuckDB's order
  return out;
}

function codePointCompare(a: string, b: string): number {
  const x = codePoints(a);
  const y = codePoints(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** −1/0/1 for two keys: NULL last, numbers numerically, text by code point. */
export function keyCompare(a: string | number | null, b: string | number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return codePointCompare(String(a), String(b));
}

/** Live's own order: keys ascending (natural), or the first series largest-first then key (value). */
export function liveOrderProblems(chart: LiveChart, order: 'natural' | 'value'): string[] {
  const out: string[] = [];
  const keys = chart.keys;
  const first = chart.data.series[0];
  for (let i = 1; i < keys.length; i += 1) {
    if (order === 'natural') {
      if (keyCompare(keys[i - 1], keys[i]) >= 0) out.push(`keys out of order at ${i}: ${show(keys[i - 1])} then ${show(keys[i])}`);
      continue;
    }
    const a = first ? first.values[i - 1] : null;
    const b = first ? first.values[i] : null;
    const byValue = a === null || b === null ? (a === b ? 0 : a === null ? 1 : -1) : b - a;
    if (byValue > 0 || (byValue === 0 && keyCompare(keys[i - 1], keys[i]) >= 0)) {
      out.push(`value order broken at ${i}: ${show([keys[i - 1], a])} then ${show([keys[i], b])}`);
    }
  }
  return out.slice(0, 3);
}

/** `answers.ranked`'s rule on the extract: the first series largest-first, empties last. */
export function rankedProblems(chart: ChartLike): string[] {
  const v = chart.series[0] ? chart.series[0].values : [];
  for (let i = 1; i < v.length; i += 1) {
    const a = v[i - 1];
    const b = v[i];
    if (a === null && b !== null) return [`extract ranking puts an empty value before ${b}`];
    if (a !== null && b !== null && b > a) return [`extract ranking breaks at ${i}: ${a} then ${b}`];
  }
  return [];
}

/** The labels in first-seen order of `keys` (one key per filtered row; label via `labelOf`). */
export function firstSeenProblems(extLabels: (string | number)[], rowKeys: unknown[], labelOf: (k: unknown) => string | number): string[] {
  const seen = new Set<string>();
  const want: (string | number)[] = [];
  for (const k of rowKeys) {
    const id = JSON.stringify(k ?? null);
    if (seen.has(id)) continue;
    seen.add(id);
    want.push(labelOf(k));
  }
  if (want.length !== extLabels.length || want.some((l, i) => !Object.is(l, extLabels[i]))) {
    return [`extract is not in first-seen order: ${show(extLabels.slice(0, 8))} vs ${show(want.slice(0, 8))}`];
  }
  return [];
}

/**
 * Labels ordered largest total first (empty totals last), where two totals
 * within the float tolerance may come in either order — they are equal up to
 * summation order. Used where a rank is computed from a different summation
 * than the figure it is checked against (a split's category or series rank).
 */
export function orderedByTotal(labels: string[], totalOf: (l: string, i: number) => number | null): string[] {
  for (let i = 1; i < labels.length; i += 1) {
    const a = totalOf(labels[i - 1], i - 1);
    const b = totalOf(labels[i], i);
    if (a === null && b !== null) return [`${show(labels[i - 1])} (empty) ranks before ${show(labels[i])} (${b})`];
    if (a !== null && b !== null && b > a && !sameNumber(a, b, true)) return [`${show(labels[i - 1])} (${a}) ranks before ${show(labels[i])} (${b})`];
  }
  return [];
}
