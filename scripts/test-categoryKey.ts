'use strict';

// Self-check for src/analysis/categoryKey.ts — the shared category-bucketing
// decisions and, above all, the LABELS.
//
// This is the one place in the category work where hand-written expectations
// are the right assertion rather than the lazy one. Everything else in this
// feature is differential (`test-vizCategory.ts` compares the SQL path against
// the JS path), but a differential test cannot catch both paths agreeing on a
// label the user should never see — `2024-Q01`, `0-1200`, a week starting on
// Sunday. So the strings are pinned here, once, and both paths reach them
// through this module.
//
//   npm run build:ts && node scripts/test-categoryKey.js

import {
  CATEGORY_CAP, DATE_GRAINS, GRAIN_MAX_POINTS, MAX_BINS, NUM_BINS, OTHER_LABEL, OTHER_NOTE,
  sanitizeBins,
  binIndex, binLabel, binPlan, chooseGrain, dateBucket, dateBucketLabel,
  isCanonicalDateCell, isDateGrain, parseDateCell,
} from '../src/analysis/categoryKey';
import type { DateGrain } from '../src/analysis/categoryKey';

import { ok, failureCount, finish } from './selfcheck';

// ── 1. The constants the renderer and both paths agree on ──────────────────
{
  ok('DATE_GRAINS coarsens day → year', DATE_GRAINS.join(',') === 'day,week,month,quarter,year');
  ok('GRAIN_MAX_POINTS === 60', GRAIN_MAX_POINTS === 60);
  ok('CATEGORY_CAP === 50', CATEGORY_CAP === 50);
  ok('NUM_BINS === 10', NUM_BINS === 10);
  ok('OTHER_LABEL === "Other"', OTHER_LABEL === 'Other');
  // The renderer shows this verbatim; changing it is a UI change, not a rename.
  ok('OTHER_NOTE is the exact note', OTHER_NOTE === 'Showing top 50 by value, others grouped');
  ok('isDateGrain accepts a grain', isDateGrain('quarter') === true);
  ok('isDateGrain rejects anything else', isDateGrain('decade') === false && isDateGrain(3) === false);
}

// ── 2. Bin labels ───────────────────────────────────────────────────────────
//
// The compact formatter is Intl's, not ours, and the point of this block is
// that it is actually being used: 1200 must read "1.2K", not "1200" and not
// "1.2k".
{
  const plan = binPlan(0, 12000);
  ok('binPlan(0, 12000): ten buckets', plan.bins === 10);
  ok('binPlan(0, 12000): width 1200', plan.width === 1200);

  const labels = Array.from({ length: plan.bins }, (_, i) =>
    binLabel(i, plan.lo, plan.width, plan.bins, plan.hi));
  ok('bin 0 is "0–1.2K"', labels[0] === '0–1.2K', labels[0]);
  ok('bin 1 is "1.2K–2.4K"', labels[1] === '1.2K–2.4K', labels[1]);
  ok('bin 9 is "10.8K–12K"', labels[9] === '10.8K–12K', labels[9]);
  ok('every label uses an EN DASH', labels.every((l) => l.includes('–')));
  ok('ten distinct labels', new Set(labels).size === 10);

  // A three-digit edge must NOT be compacted — 500 is "500", not "0.5K".
  ok('500 formats as "500"', binLabel(0, 0, 500, 2, 1000) === '0–500', binLabel(0, 0, 500, 2, 1000));

  // Degenerate: one distinct value, or none at all.
  const flat = binPlan(5, 5);
  ok('hi === lo → ONE bucket', flat.bins === 1);
  ok('hi === lo → "5–5"', binLabel(0, flat.lo, flat.width, flat.bins, flat.hi) === '5–5');
  const none = binPlan(null, null);
  ok('no numeric cells → ONE bucket', none.bins === 1 && none.lo === 0 && none.hi === 0);

  // Negative ranges keep their sign on both edges.
  const neg = binPlan(-100, 100);
  ok('negative range: width 20', neg.width === 20);
  ok('negative range: first bucket "-100–-80"',
    binLabel(0, neg.lo, neg.width, neg.bins, neg.hi) === '-100–-80',
    binLabel(0, neg.lo, neg.width, neg.bins, neg.hi));

  // THE LAST EDGE IS THE OBSERVED MAX, exactly. lo + 10*0.1 is
  // 0.9999999999999999 in IEEE-754, and printing that as the top of the axis
  // would be a figure the data never reaches.
  // ── A caller-named bucket count ───────────────────────────────────────────
  //
  // `bins` is the numeric twin of `grain` (the column-profile panel asks for
  // 20). The geometry has to follow the count, not just the count itself: a
  // `bins` that changed `plan.bins` while leaving `width` on the default would
  // put every edge in the wrong place and still look like a 20-bar histogram.
  ok('MAX_BINS === 100', MAX_BINS === 100);
  const twenty = binPlan(0, 12000, 20);
  ok('binPlan(0, 12000, 20): twenty buckets', twenty.bins === 20);
  ok('binPlan(0, 12000, 20): width follows the count (600, not 1200)', twenty.width === 600);
  ok('binPlan(0, 12000, 20): lo/hi unchanged', twenty.lo === 0 && twenty.hi === 12000);
  const two = binPlan(0, 10, 2);
  ok('binPlan(0, 10, 2): the floor of the range', two.bins === 2 && two.width === 5);
  const maxed = binPlan(0, 100, MAX_BINS);
  ok('binPlan(0, 100, MAX_BINS): the ceiling of the range', maxed.bins === 100 && maxed.width === 1);

  // Out of range is DROPPED, not clamped — so it is indistinguishable from
  // naming nothing, which is what `sanitizeEncoding` promises for every enum.
  for (const bad of [0, 1, -5, 101, 7.5, NaN, Infinity]) {
    const p2 = binPlan(0, 12000, bad);
    ok(`binPlan(0, 12000, ${String(bad)}) falls back to NUM_BINS`,
      p2.bins === NUM_BINS && p2.width === 1200);
  }
  ok('binPlan with no count is still the default', binPlan(0, 12000).bins === NUM_BINS);
  // The degenerate collapse wins over a named count: a flat column is ONE
  // bucket whether or not the encoding asked for twenty.
  ok('a flat column is one bucket even at bins=20', binPlan(5, 5, 20).bins === 1);

  ok('sanitizeBins passes an integer in range', sanitizeBins(20) === 20);
  ok('sanitizeBins takes the bounds themselves', sanitizeBins(2) === 2 && sanitizeBins(MAX_BINS) === MAX_BINS);
  for (const bad of [1, 0, -1, MAX_BINS + 1, 7.5, NaN, Infinity, '20', null, undefined, {}]) {
    ok(`sanitizeBins(${typeof bad === 'string' ? `"${bad}"` : String(bad)}) → undefined`,
      sanitizeBins(bad as unknown) === undefined);
  }

  const frac = binPlan(0, 1);
  ok('last bucket ends on hi, not lo + bins*width',
    binLabel(9, frac.lo, frac.width, frac.bins, frac.hi).endsWith('–1'),
    binLabel(9, frac.lo, frac.width, frac.bins, frac.hi));
}

// ── 3. binIndex clamps at both ends ────────────────────────────────────────
{
  ok('binIndex: below lo clamps to 0', binIndex(-50, 0, 10, 10) === 0);
  ok('binIndex: lo is bucket 0', binIndex(0, 0, 10, 10) === 0);
  ok('binIndex: hi is the LAST bucket', binIndex(100, 0, 10, 10) === 9);
  ok('binIndex: above hi clamps to the last bucket', binIndex(1e9, 0, 10, 10) === 9);
  ok('binIndex: an interior value', binIndex(35, 0, 10, 10) === 3);
  ok('binIndex: an exact edge belongs to the upper bucket', binIndex(30, 0, 10, 10) === 3);
}

// ── 4. One date grammar ────────────────────────────────────────────────────
{
  const same = (a: unknown, b: { y: number; m: number; d: number }): boolean =>
    JSON.stringify(a) === JSON.stringify(b);
  const jan5 = { y: 2023, m: 1, d: 5 };

  ok('YYYY-MM-DD', same(parseDateCell('2023-01-05'), jan5));
  ok('YYYY/M/D', same(parseDateCell('2023/1/5'), jan5));
  ok('MM/DD/YYYY is US order', same(parseDateCell('01/05/2023'), jan5));
  ok('M-D-YYYY is US order', same(parseDateCell('1-5-2023'), jan5));
  // The permissive fallback, read with UTC getters so a timezone west of
  // Greenwich cannot shift the day back into the previous year.
  ok('Date.parse fallback', same(parseDateCell('Jan 5, 2023'), jan5));

  ok('empty → null', parseDateCell('') === null);
  ok('whitespace-only → null', parseDateCell('   ') === null);
  ok('null → null', parseDateCell(null) === null);
  ok('unparseable → null', parseDateCell('not a date') === null);
  // Shape-valid, calendar-invalid. SQL's TRY_CAST(… AS DATE) returns NULL here,
  // so JS must too or the two paths would bucket it differently.
  ok('2023-02-31 → null', parseDateCell('2023-02-31') === null);
  ok('2023-13-01 → null', parseDateCell('2023-13-01') === null);

  ok('canonical: YYYY-MM-DD', isCanonicalDateCell('2023-01-05') === true);
  ok('canonical: MM/DD/YYYY', isCanonicalDateCell('01/05/2023') === true);
  ok('NOT canonical: Jan 5, 2023', isCanonicalDateCell('Jan 5, 2023') === false);
  ok('NOT canonical: 2023-02-31', isCanonicalDateCell('2023-02-31') === false);
  ok('NOT canonical: empty', isCanonicalDateCell('') === false);
}

// ── 5. Buckets and their labels ────────────────────────────────────────────
{
  const at = (s: string, g: DateGrain): string => {
    const p = parseDateCell(s);
    return p ? dateBucketLabel(dateBucket(p, g), g) : '(null)';
  };

  ok('epoch day 0 is 1970-01-01', dateBucket({ y: 1970, m: 1, d: 1 }, 'day') === 0);
  // 1970-01-01 was a THURSDAY, so the ISO week it belongs to starts three days
  // earlier — the same day DuckDB's date_trunc('week', …) returns.
  ok('week starts MONDAY', dateBucket({ y: 1970, m: 1, d: 1 }, 'week') === -3);
  ok('week label names its Monday', at('1970-01-01', 'week') === '1969-12-29');
  ok('week label for a Monday is itself', at('2023-01-02', 'week') === '2023-01-02');
  ok('week label for the Sunday after', at('2023-01-08', 'week') === '2023-01-02');
  ok('week label for the Monday after', at('2023-01-09', 'week') === '2023-01-09');

  ok('day label', at('2023-03-15', 'day') === '2023-03-15');
  ok('month label', at('2023-03-15', 'month') === '2023-03');
  ok('quarter label Q1', at('2023-03-15', 'quarter') === '2023-Q1');
  ok('quarter label Q2', at('2023-05-20', 'quarter') === '2023-Q2');
  ok('quarter label Q4', at('2023-12-31', 'quarter') === '2023-Q4');
  ok('year label', at('2023-05-20', 'year') === '2023');

  // Leap day, and the pre-1970 side of the floor-mod in the week arithmetic.
  ok('leap day', at('2024-02-29', 'day') === '2024-02-29');
  ok('pre-epoch day', at('1965-07-04', 'day') === '1965-07-04');
  ok('pre-epoch week names a Monday', at('1965-07-04', 'week') === '1965-06-28');

  // Both canonical shapes of the same date land in the same bucket — the
  // property the whole grammar exists for.
  for (const g of DATE_GRAINS) {
    ok(`same date, both shapes, same ${g} bucket`, at('2023-01-05', g) === at('01/05/2023', g));
  }
}

// ── 6. The default grain ───────────────────────────────────────────────────
{
  const counts = (o: Partial<Record<DateGrain, number>>): Record<DateGrain, number> => {
    const out = {} as Record<DateGrain, number>;
    for (const g of DATE_GRAINS) out[g] = o[g] ?? 0;
    return out;
  };
  ok('picks the FINEST grain that fits',
    chooseGrain(counts({ day: 1000, week: 200, month: 59, quarter: 20, year: 5 })) === 'month');
  ok('day when day already fits',
    chooseGrain(counts({ day: 60, week: 10, month: 3, quarter: 1, year: 1 })) === 'day');
  ok('exactly GRAIN_MAX_POINTS still fits',
    chooseGrain(counts({ day: GRAIN_MAX_POINTS, week: 1, month: 1, quarter: 1, year: 1 })) === 'day');
  ok('one past it does not',
    chooseGrain(counts({ day: GRAIN_MAX_POINTS + 1, week: 1, month: 1, quarter: 1, year: 1 })) === 'week');
  ok('nothing fits → year',
    chooseGrain(counts({ day: 1e6, week: 1e5, month: 1e4, quarter: 1e3, year: 500 })) === 'year');
}

if (failureCount() > 0) {
  console.error(`\n${failureCount()} categoryKey check(s) failed`);
}
finish();
