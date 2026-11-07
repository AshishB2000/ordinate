// The SHOP fixture of the funnel-metric suites (semantic layer part 5, step 08) — a helper, not a suite.
// Users visit, add to a cart and buy, in March 2024; every row is one event:
//
//   u0..u359   one country each (Germany, France, Spain, Italy by index). Two visits three days apart; a user whose
//              index is not a multiple of 3 adds to a cart an hour after the first and buys two days after it. A user
//              whose index is a multiple of 5 first visits in February, a month before: their cart and buy follow the
//              March visit, so they convert only when the entry is the March one. Visits are on the web or in a store
//              by index; carts and buys by index / 2, so a lock on `channel` hides some purchases and not their visits.
//   g1..g20    visit and add to a cart from Germany, then buy with country France (D6's case: who enters vs which events count)
//   x1         visits from France, then from Germany two days later, then converts (the documented D6/D7 edge)
//   t1         two visits at the same instant, Germany then France (ties go by row order), then converts
//   two rows with no user or an unreadable time, which every funnel leaves out and counts

import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';

export const SHOP_COLS: ParsedColumn[] = [
  { name: 'user', type: 'text' }, { name: 'event', type: 'text' }, { name: 'ts', type: 'date' },
  { name: 'country', type: 'text' }, { name: 'channel', type: 'text' }, { name: 'city', type: 'text' },
];

const COUNTRIES = ['Germany', 'France', 'Spain', 'Italy'];
const CH = ['web', 'store'];
const pad = (n: number): string => String(n).padStart(2, '0');
const at = (month: number, day: number, h: number): string => `2024-${pad(month)}-${pad(day)} ${pad(h)}:00:00`;

export const SHOP_USERS = 360;
export const shopCountry = (i: number): string => COUNTRIES[i % 4];
/** Whether base user i buys within 7 days of their FIRST visit (the grid's entry). */
export const shopConverts = (i: number): boolean => i % 3 !== 0 && i % 5 !== 0;

export function shopRows(): Cell[][] {
  const rows: Cell[][] = [];
  for (let i = 0; i < SHOP_USERS; i += 1) {
    const u = `u${i}`, c = shopCountry(i), d = 1 + (i % 26), vch = CH[i % 2], bch = CH[(i >> 1) % 2], city = `City ${i % 15}`;
    const late = i % 5 === 0; // first visit in February
    rows.push([u, 'visit', late ? at(2, d, 9) : at(3, d, 9), c, vch, city]);
    rows.push([u, 'visit', late ? at(3, d, 9) : at(3, d + 3, 9), c, vch, city]);
    if (i % 3 === 0) continue;
    rows.push([u, 'cart', at(3, d, 10), c, bch, city]); // an hour after the March visit
    rows.push([u, 'buy', at(3, d + 2, 9), c, bch, city]);
  }
  for (let k = 1; k <= 20; k += 1) {
    rows.push([`g${k}`, 'visit', at(3, 10, 10), 'Germany', 'web', 'Berlin']);
    rows.push([`g${k}`, 'cart', at(3, 10, 11), 'Germany', 'web', 'Berlin']);
    rows.push([`g${k}`, 'buy', at(3, 11, 12), 'France', 'store', 'Paris']);
  }
  rows.push(['x1', 'visit', at(3, 1, 8), 'France', 'web', 'Paris'], ['x1', 'visit', at(3, 3, 8), 'Germany', 'web', 'Berlin'],
    ['x1', 'cart', at(3, 3, 9), 'Germany', 'web', 'Berlin'], ['x1', 'buy', at(3, 4, 9), 'Germany', 'web', 'Berlin']);
  rows.push(['t1', 'visit', at(3, 2, 8), 'Germany', 'web', 'Berlin'], ['t1', 'visit', at(3, 2, 8), 'France', 'web', 'Paris'],
    ['t1', 'cart', at(3, 2, 9), 'France', 'web', 'Paris'], ['t1', 'buy', at(3, 2, 10), 'France', 'web', 'Paris']);
  rows.push(['', 'visit', at(3, 5, 9), 'Spain', 'web', 'Madrid'], ['u1', 'visit', 'soon', 'France', 'web', 'Paris']);
  return rows;
}

/** German entrants who buy: base Germans who convert, every g, x1 (enters at its German visit) and t1 (its first visit is German). */
export const G_BUYERS = Array.from({ length: SHOP_USERS }, (_, i) => i).filter((i) => shopCountry(i) === 'Germany' && shopConverts(i)).length + 20 + 1 + 1;

export const eq = (column: string, value: Cell): FilterStep => ({ type: 'filter', column, op: '=', value });
export const between = (from: string, to: string, column = 'ts'): FilterStep => ({ type: 'filter', column, op: 'period', period: { preset: 'custom', from, to } } as FilterStep);
export const MARCH_TS = between('2024-03-01', '2024-03-31');
export const SHOP_FUNNEL = { entity: 'user', event: 'event', time: 'ts', steps: ['visit', 'cart', 'buy'], window: { n: 7, unit: 'days' as const } };
