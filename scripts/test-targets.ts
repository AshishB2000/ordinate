// Targets on a metric (semantic layer part 5, step 09): the period arithmetic (math), the target under a scope
// (resolve) and the surfaces that show it (surfaces).
//
//   npm run build:ts && node scripts/test-targets.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const { isDeepStrictEqual } = require('util') as typeof import('util');
const tmath: typeof import('../src/analysis/targetMath') = require('../src/analysis/targetMath');
const model: typeof import('../src/analysis/scorecardModel') = require('../src/analysis/scorecardModel');

const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);

function mathSection(): void {
  const G = { weekStart: 1, fiscalYearStart: 1 } as import('../src/analysis/dateIntel').CalendarPrefs;
  const W445 = { ...G, calendarType: '445' } as import('../src/analysis/dateIntel').CalendarPrefs;
  const p = tmath.periodParts({ from: '2026-11-01', to: '2026-11-20' }, 'month', G);
  ok('Nov 1–20 is 20 of 30 days of November', p.length === 1 && p[0].covered === 20 && p[0].days === 30);
  ok('1.2M a month, pro-rated to Nov 20, is 800k', Object.is(tmath.fixedTarget(1_200_000, p), 800_000));
  ok('February 2024 has 29 days', tmath.periodParts({ from: '2024-02-10', to: '2024-02-29' }, 'month', G)[0].days === 29);
  const span = tmath.periodParts({ from: '2024-01-15', to: '2024-04-10' }, 'month', G);
  ok('a span: partial Jan, whole Feb–Mar, partial Apr', span.length === 4 && span[0].covered === 17 && span[3].covered === 10);
  ok('…planned as three asks, the middle as one', same(tmath.planAsks(span), [
    { from: '2024-01-01', to: '2024-01-31', fraction: 17 / 31 },
    { from: '2024-02-01', to: '2024-03-31', fraction: 1 },
    { from: '2024-04-01', to: '2024-04-30', fraction: 10 / 30 },
  ]));
  ok('a whole month is one ask with fraction 1', same(tmath.planAsks(tmath.periodParts({ from: '2024-03-01', to: '2024-03-31' }, 'month', G)), [{ from: '2024-03-01', to: '2024-03-31', fraction: 1 }]));
  ok('a partial month alone is one ask with its share', same(tmath.planAsks(p), [{ from: '2026-11-01', to: '2026-11-30', fraction: 20 / 30 }]));
  // A 4-4-5 year has 28- and 35-day "months": find a 35-day one by walking the calendar, then cover part of it.
  let five: { from: string; to: string } | null = null;
  for (let k = 0; k < 12 && !five; k++) {
    const w = model.periodWindow('2024-09-15', 'month', k, W445);
    if (w && Date.parse(w.to) - Date.parse(w.from) === 34 * 86_400_000) five = w;
  }
  ok('the 4-4-5 calendar has a 35-day month', five !== null);
  const w = tmath.periodParts({ from: five!.from, to: five!.from }, 'month', W445);
  ok('a 4-4-5 period divides by its own 35 days, never 30', w.length === 1 && w[0].days === 35 && w[0].covered === 1 && Object.is(tmath.fixedTarget(350, w), 10));
  ok('fiscal quarters follow the fiscal year', tmath.periodParts({ from: '2024-04-01', to: '2024-04-30' }, 'quarter', { ...G, fiscalYearStart: 4 })[0].days === 91);
  ok('widened to whole periods', same(tmath.widened(span), { from: '2024-01-01', to: '2024-04-30' }));
  ok('NEGATIVE CONTROL: a reversed range has no parts', tmath.periodParts({ from: '2024-05-01', to: '2024-04-01' }, 'month', G).length === 0);
}

async function main(): Promise<void> {
  mathSection();
  void same;
  finish();
}

void main();
