'use strict';

// Parity: src/analysis/dateIntel.ts `describePeriod` names every period exactly
// as the desktop's `periodLabel` (periodPicker.ts) did.
//
// The desktop kept its own copy because a chip's text was needed synchronously
// and a classic <script> could not import a CommonJS module. That copy went
// with the desktop app (T8.1); its answers for every preset under four
// calendars are the golden fixture scripts/fixtures/golden/periodLabels.json
// (scripts/golden.ts), compared with the same strict equality as before.
//
//   npm run build:ts && node scripts/test-periodLabels.js

import { describePeriod, PERIOD_PRESETS } from '../src/analysis/dateIntel';
import type { CalendarPrefs, PeriodSpec } from '../src/analysis/dateIntel';
import { golden } from './golden';

import { ok, finish } from './selfcheck';

const G = golden<{ cases: Array<[string, CalendarPrefs, PeriodSpec, string]> }>('periodLabels');

// Every preset the server offers was recorded, under each calendar.
const recorded = new Set(G.cases.map((c) => c[2].preset));
ok('the fixture covers every preset', PERIOD_PRESETS.every((p) => recorded.has(p)), PERIOD_PRESETS.filter((p) => !recorded.has(p)).join(','));
for (const [name, cal, spec, legacy] of G.cases) {
  const main = describePeriod(spec, cal);
  ok(`${name} ${spec.preset}${spec.n ? '(' + spec.n + ')' : ''}: "${main}"`, legacy === main, `the desktop said "${legacy}"`);
}

finish();
