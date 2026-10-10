// DIFFERENTIAL: click-to-filter against the server's rule module
// (src/analysis/dashboardFilters.ts, as `npm run build:ts` emits it) — the
// same inputs, deep-equal results. A scripted walk of clicks covers the whole
// rule: every state it reaches is fed back in, so the two cannot agree on one
// step and part on the next.

import { deepStrictEqual, notDeepStrictEqual, strictEqual } from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'vitest';
import { clickFilterOn, clickFilterSteps, toggleClickFilter, type ClickFilter, type ClickMark } from './filters';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the server module is CommonJS
const server: any = require(path.join(ROOT, 'src', 'analysis', 'dashboardFilters.js'));

const cat = (value: unknown): ClickMark => ({ column: 'region', value });
const cell = (value: unknown, series: unknown): ClickMark => ({ column: 'region', value, seriesColumn: 'segment', series });

/** [origin, mark, additive] — plain and additive clicks, a series chart, two cards, a take-over, odd values. */
const walk: Array<[string, ClickMark, boolean]> = [
  ['a', cat('East'), false],
  ['a', cat('West'), true], // adds
  ['a', cat('East'), true], // takes one away
  ['a', cat('West'), false], // the only one: clears
  ['a', cell('East', 'B2B'), false],
  ['a', cell('West', 'B2B'), true],
  ['a', cell('West', 'B2C'), true],
  ['a', cell('East', 'B2C'), true], // selected (the rectangle): removes along the first axis with a spare value
  ['b', { column: 'year', value: 2024 }, false], // a second card, a number becomes text
  ['b', cat('North'), false], // takes `region` over from card a
  ['a', cat(null), true], // null → ''
  ['', cat('x'), false], // no origin: nothing
  ['a', { column: '', value: 'x' }, false], // no column: nothing
  ['a', { column: 'region', value: 'East', seriesColumn: 'region', series: 'East' }, false], // series = category
  ['a', { column: 'region', value: 'East', seriesColumn: 'segment' }, true], // no series value
];

describe('click-to-filter mirrors dashboardFilters', () => {
  it('toggleClickFilter and clickFilterSteps equal the server at every step of a walk', () => {
    let mine: ClickFilter[] = [];
    let theirs: ClickFilter[] = [];
    for (const [origin, mark, additive] of walk) {
      mine = toggleClickFilter(mine, origin, mark, additive);
      theirs = server.toggleClickFilter(theirs, origin, mark, additive);
      deepStrictEqual(mine, theirs);
      for (const except of [undefined, 'a', 'b', 'nobody']) deepStrictEqual(clickFilterSteps(mine, except), server.clickFilterSteps(theirs, except));
    }
    // The walk ends somewhere, not back at nothing — the equality above was not of two empty lists.
    strictEqual(mine.length > 0, true);
  });

  it('tolerates the same garbage the server does', () => {
    for (const bad of [null, undefined, [{ origin: 'a', column: 'region', values: [] }], [{ origin: '', column: 'x', values: ['1'] }]] as never[]) {
      deepStrictEqual(toggleClickFilter(bad, 'a', cat('East')), server.toggleClickFilter(bad, 'a', cat('East')));
      deepStrictEqual(clickFilterSteps(bad), server.clickFilterSteps(bad));
    }
  });

  it('clickFilterOn equals the server for every sheet × visual setting', () => {
    for (const sheet of [true, false, undefined, 'true', 1]) for (const visual of [true, false, undefined, null]) strictEqual(clickFilterOn(sheet, visual), server.clickFilterOn(sheet, visual));
  });

  it('negative control: a port that stacks instead of replacing, or exempts nobody, differs', () => {
    const one = toggleClickFilter([], 'a', cat('East'));
    const stacked = [...one, ...toggleClickFilter([], 'a', cat('West'))];
    notDeepStrictEqual(stacked, server.toggleClickFilter(one, 'a', cat('West')));
    notDeepStrictEqual(clickFilterSteps(one), server.clickFilterSteps(one, 'a'));
  });
});
