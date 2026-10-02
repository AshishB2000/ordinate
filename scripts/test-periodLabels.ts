'use strict';

// Parity: renderer/hub/periodPicker.ts `periodLabel` names every period exactly
// as src/analysis/dateIntel.ts `describePeriod` does.
//
// The renderer keeps its own copy because a chip's text is needed
// synchronously and a classic <script> cannot import a CommonJS module (see
// periodPicker.ts's header). A copy is only safe if something fails when the
// two drift — this is that something. The renderer file runs in a vm, the
// way scripts/test-chartMonthLabels.ts runs chartRender.js.
//
//   npm run build:ts && node scripts/test-periodLabels.js

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describePeriod, PERIOD_PRESETS, N_PRESETS } from '../src/analysis/dateIntel';
import type { CalendarPrefs, PeriodSpec } from '../src/analysis/dateIntel';

import { ok, finish } from './selfcheck';

const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub', 'periodPicker.js'), 'utf8');
// The one formatter, as the renderer binds it (formatBind.ts).
const ctx = vm.createContext({ OrdFormat: require('../src/app/format') });
vm.runInContext(code, ctx);

const specs: PeriodSpec[] = [];
for (const p of PERIOD_PRESETS) {
  if (p === 'custom') specs.push({ preset: p, from: '2024-01-01', to: '2024-03-31' }, { preset: p, from: '2024-01-01' }, { preset: p, to: '2024-03-31' });
  else if (N_PRESETS.has(p)) specs.push({ preset: p, n: 1 }, { preset: p, n: 12 });
  else specs.push({ preset: p });
}

const cals: Array<[string, CalendarPrefs]> = [
  ['fy1', { weekStart: 1, fiscalYearStart: 1 }],
  ['fy7', { weekStart: 1, fiscalYearStart: 7 }],
  ['454', { weekStart: 1, fiscalYearStart: 1, calendarType: '454', yearEnd: 'nearest' }],
  ['iso', { weekStart: 1, fiscalYearStart: 7, calendarType: 'iso', yearEnd: 'nearest' }],
];
for (const [name, cal] of cals) {
  for (const spec of specs) {
    const main = describePeriod(spec, cal);
    const renderer = vm.runInContext(`wsFormats = ${JSON.stringify(cal)}; periodLabel(${JSON.stringify(spec)})`, ctx);
    ok(`${name} ${spec.preset}${spec.n ? '(' + spec.n + ')' : ''}: "${main}"`, renderer === main, `renderer said "${renderer}"`);
  }
}

// The closed chip's text for the three shapes a date control holds.
vm.runInContext(`wsFormats = { weekStart: 1, fiscalYearStart: 7 }`, ctx);
ok('chip: a preset shows its name', vm.runInContext(`periodValueText({ preset: 'this_year' })`, ctx) === 'This fiscal year');
ok('chip: nothing picked reads "All dates"', vm.runInContext(`periodValueText({})`, ctx) === 'All dates');
ok('chip: fixed dates show as a range', /–/.test(vm.runInContext(`periodValueText({ from: '2024-01-01', to: '2024-03-31' })`, ctx)));

finish();
