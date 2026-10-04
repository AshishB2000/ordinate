// DIFFERENTIAL: click-to-filter against the server's rule module
// (src/analysis/dashboardFilters.ts, as `npm run build:ts` emits it) — the
// same inputs, deep-equal results.

import { deepStrictEqual, notDeepStrictEqual } from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'vitest';
import type { Step } from '../api';
import { toggleCrossFilter } from './filters';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the server module is CommonJS
const server: any = require(path.join(ROOT, 'src', 'analysis', 'dashboardFilters.js'));

const base: Step[] = [
  { type: 'filter', column: 'region', op: '=', value: 'East' },
  { type: 'filter', column: 'amount', op: '>', value: 10 },
  { type: 'sort', column: 'x' },
];
const cases: Array<[Step[], string, unknown]> = [
  [base, 'region', 'East'], // toggles off
  [base, 'region', 'West'], // replaces
  [base, 'segment', 'B2B'], // adds
  [base, '', 'x'], // no column: filters only
  [[], 'year', 2024], // a number becomes text
  [base, 'region', null], // null → ''
  [[{ type: 'filter', column: 'region', op: '=', value: 7 }], 'region', '7'],
];

describe('toggleCrossFilter', () => {
  it('equals dashboardFilters.toggleCrossFilter on every case', () => {
    for (const [f, col, v] of cases) deepStrictEqual(toggleCrossFilter(f, col, v), server.toggleCrossFilter(f, col, v));
  });
  it('negative control: a port that stacks instead of replacing differs', () => {
    const stacked = [...toggleCrossFilter(base, 'region', 'West'), base[0]];
    notDeepStrictEqual(stacked, server.toggleCrossFilter(base, 'region', 'West'));
  });
});
