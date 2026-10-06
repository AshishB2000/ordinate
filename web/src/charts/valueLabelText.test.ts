// The text a chart prints ON a data point, when no "Number format" override is set.
//
// WHY IT EXISTS. That text used to be `String(v)` for anything under 10,000, so
// a summed money column printed its full binary expansion: filter the bundled
// sample to one category and the "Revenue by month" line drew
// `3908.359999999999` straight across the y-axis ticks. It survived because it
// only shows BELOW 10,000, and an unfiltered dashboard usually sums past that —
// the dashboard filter bar is what made it easy to reach.
//
// The rule has three branches and each one is a different kind of wrong if it
// breaks: abbreviating is a LOSS of precision where the reader could have had
// it, a raw float is unreadable, and rounding a real figure to "0" is the one
// this app must never print. One case each, plus the boundaries between them.
//
// LOCALE. `toLocaleString()` is ICU- and locale-dependent, so this asserts
// DIFFERENTIALLY — the output must equal what the platform itself prints for the
// rounded number — rather than freezing "3,908.36", which would pass on a
// developer's machine and fail on a CI runner with a different default locale.
// The claim being made is "it prints the rounded figure", and that is exactly
// how it is written.
//
//
//
// Ported from scripts/test-valueLabelText.ts at the T8.1 cutover, where the same
// checks pinned the desktop's chartValueLabels.js. The abbreviation is a MARKED
// STUB of ./format's fmtVal: what matters here is only whether the ≥10,000
// branch delegates to it.

import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { valueLabelText } from './labelText';

vi.mock('./format', () => ({ fmtVal: (v: number) => 'ABBREV(' + v + ')', fmtWith: (v: number) => String(v) }));

describe("valueLabelText", () => {
  it('every check holds', () => {
    const fails: string[] = [];
    const ok = (label: string, cond: boolean, extra?: unknown): void => {
      if (!cond) fails.push(label + (extra === undefined ? '' : '  ' + String(extra)));
    };
    const failureCount = (): number => fails.length;
    const f = valueLabelText;

    // ── The bug ────────────────────────────────────────────────────────────────
    const FLOAT = 3908.359999999999;
    ok('a float sum prints as the rounded figure, not its binary expansion',
      f(FLOAT) === (3908.36).toLocaleString(), `${f(FLOAT)} vs ${(3908.36).toLocaleString()}`);
    ok('…which is to say NOT String(v)', f(FLOAT) !== String(FLOAT), f(FLOAT));
    // The shape of the old bug, independent of the rounding rule: a label is read
    // off a chart at 10px, and sixteen digits is not a figure anyone reads.
    ok('…and short enough to sit on an axis', f(FLOAT).length <= 10, f(FLOAT));

    // ── Below the threshold: the real number, grouped and rounded ──────────────
    ok('an integer is printed exactly', f(42) === (42).toLocaleString(), f(42));
    ok('a round thousand is grouped, not abbreviated',
      f(9481) === (9481).toLocaleString(), f(9481));
    ok('a negative is handled like its magnitude',
      f(-3908.359999999999) === (-3908.36).toLocaleString(), f(-3908.359999999999));
    ok('zero is zero', f(0) === (0).toLocaleString(), f(0));

    // ── The bottom of the range: never round a real figure to "0" ──────────────
    // A 0.0001234 margin is not zero, and a chart that says it is would be wrong in
    // the one direction this app must never be wrong in. toLocaleString()'s default
    // three-decimal rounding does exactly that, so significant digits take over.
    ok('a value too small for 3 decimals keeps significant digits instead of printing 0',
      f(0.0001234) === (0.0001234).toLocaleString(undefined, { maximumSignificantDigits: 3 }),
      f(0.0001234));
    ok('…and is visibly not zero', f(0.0001234) !== (0).toLocaleString(), f(0.0001234));
    ok('…as is a tiny negative', f(-0.0001234) !== (0).toLocaleString(), f(-0.0001234));
    ok('0.001, the first value the default rounding survives, uses the plain form',
      f(0.001) === (0.001).toLocaleString(), f(0.001));

    // ── At or above the threshold: abbreviate, through _fmtVal ─────────────────
    // The delegation is the assertion — `_fmtVal` is hub.ts's and has its own
    // coverage; what matters here is that this branch reaches it.
    ok('10,000 abbreviates', f(10000) === 'ABBREV(10000)', f(10000));
    ok('…and so does a million', f(1204388) === 'ABBREV(1204388)', f(1204388));
    ok('…and a large negative', f(-10000) === 'ABBREV(-10000)', f(-10000));
    // The boundary itself: one below must NOT abbreviate.
    ok('9,999.99 stays exact — the threshold is the crossover, not a rounding',
      f(9999.99) === (9999.99).toLocaleString(), f(9999.99));

    expect(fails).toEqual([]);
    void failureCount;
  });
});
