// Self-check for multi-currency's JS reference (src/analysis/fx.ts): the
// nearest-earlier lookup, per-row currency, missing-rate counting, the USD
// triangulation rule, and the bundled sample — against hand-written values.
//
//   npm run build:ts && node scripts/test-fx.js

import * as fx from '../src/analysis/fx';
import type { Cell } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';
import { daysFromCivil } from '../src/analysis/categoryKey';
import { computeMetric } from '../src/analysis/metricValue';
import { sampleRates } from '../src/app/fxStore';
import { ok, finish } from './selfcheck';

const day = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return daysFromCivil(y, m, d);
};
const row = (from: string, to: string, iso: string, rate: number): fx.RateRow => ({ from, to, day: day(iso), rate });

// ── Nearest-earlier lookup ───────────────────────────────────────────────────
const t1 = fx.buildRates([
  row('EUR', 'USD', '2024-01-01', 1.1),
  row('EUR', 'USD', '2024-02-01', 1.2),
  row('EUR', 'USD', '2024-03-01', 1.3),
]);
ok('lookup: a day between two rates takes the earlier one', fx.nearestRate(t1, 'EUR', 'USD', day('2024-01-20')) === 1.1);
ok('lookup: a rate dated ON the day is used', fx.nearestRate(t1, 'EUR', 'USD', day('2024-02-01')) === 1.2);
ok('lookup: the day before it still takes the earlier one', fx.nearestRate(t1, 'EUR', 'USD', day('2024-01-31')) === 1.1);
ok('lookup: after the last rate, the last rate', fx.nearestRate(t1, 'EUR', 'USD', day('2030-01-01')) === 1.3);
ok('lookup: before the first rate there is none (never a later one)', fx.nearestRate(t1, 'EUR', 'USD', day('2023-12-31')) === null);
ok('lookup: an unknown pair has none', fx.nearestRate(t1, 'GBP', 'USD', day('2024-02-01')) === null);
const dup = fx.buildRates([row('EUR', 'USD', '2024-01-01', 1.1), row('EUR', 'USD', '2024-01-01', 1.15)]);
ok('lookup: two rates on one day — the last in table order wins', fx.nearestRate(dup, 'EUR', 'USD', day('2024-01-05')) === 1.15);
const shuffled = fx.buildRates([row('EUR', 'USD', '2024-03-01', 1.3), row('EUR', 'USD', '2024-01-01', 1.1)]);
ok('lookup: table order does not matter for dates', fx.nearestRate(shuffled, 'EUR', 'USD', day('2024-02-15')) === 1.1);

// ── Precedence ───────────────────────────────────────────────────────────────
const t2 = fx.buildRates([
  row('EUR', 'USD', '2024-01-01', 1.25),
  row('USD', 'JPY', '2024-01-01', 160),
  row('GBP', 'USD', '2024-01-01', 2), // only GBP→USD: USD→GBP is its inverse
  row('CHF', 'EUR', '2024-01-01', 1), // direct, old
  row('EUR', 'CHF', '2024-06-01', 4), // inverse, fresher — must NOT win
]);
const D = day('2024-07-01');
ok('rate: identity is 1, even with no date', fx.crossRate(t2, 'EUR', 'EUR', null) === 1);
ok('rate: direct pair', fx.crossRate(t2, 'EUR', 'USD', D) === 1.25);
ok('rate: inverse pair is 1 / rate', fx.crossRate(t2, 'USD', 'EUR', D) === 1 / 1.25);
ok('rate: triangulated via USD — EUR→JPY = 1.25 × 160', fx.crossRate(t2, 'EUR', 'JPY', D) === 200);
ok('rate: triangulated with an inverse leg — EUR→GBP = 1.25 × (1/2)', fx.crossRate(t2, 'EUR', 'GBP', D) === 0.625);
ok('rate: a direct rate beats a fresher inverse one', fx.crossRate(t2, 'CHF', 'EUR', D) === 1);
ok('rate: no legs at all → missing (never 1)', fx.crossRate(t2, 'SEK', 'JPY', D) === null);
ok('rate: no date → missing unless identity', fx.crossRate(t2, 'EUR', 'USD', null) === null);
ok('rate: no currency → missing', fx.crossRate(t2, null, 'USD', D) === null);
const early = fx.buildRates([row('EUR', 'USD', '2024-01-01', 1.25), row('USD', 'JPY', '2024-05-01', 160)]);
ok('rate: a triangle needs BOTH legs dated on or before the day', fx.crossRate(early, 'EUR', 'JPY', day('2024-03-01')) === null
  && fx.crossRate(early, 'EUR', 'JPY', day('2024-05-01')) === 200);

// ── Per-row currency, missing counting ───────────────────────────────────────
const cols: ParsedColumn[] = [
  { name: 'amount', type: 'number' }, { name: 'currency', type: 'text' }, { name: 'day', type: 'date' }, { name: 'region', type: 'text' },
];
const rows: Cell[][] = [
  [100, 'USD', '2024-02-10', 'West'], // identity → 100
  [100, 'EUR', '2024-02-10', 'West'], // → 125
  [10, 'eur', '2024-02-10', 'East'], // lower case reads as EUR → 12.5
  [40, 'GBP', '2024-02-10', 'East'], // → 80
  [7, 'SEK', '2024-02-10', 'West'], // no rate → missing SEK→USD
  [8, '', '2024-02-10', 'West'], // no currency → missing ?→USD
  [9, 'EUR', '', 'East'], // no date → missing EUR→USD
  [3, 'EUR', '2023-12-31', 'East'], // before the first rate → missing EUR→USD
  [null, 'EUR', '2024-02-10', 'West'], // empty amount: left alone, not counted
  ['n/a', 'EUR', '2024-02-10', 'West'], // text amount: left alone, not counted
  [50, 'USD', '', 'West'], // identity needs no date → 50
];
const plan = fx.resolvePlan(cols, { amount: { kind: 'column', column: 'currency' } }, ['amount'], 'USD');
ok('plan: a declared number column converts, dated by the first date column', !!plan && plan.cols.length === 1 && plan.cols[0].curIndex === 1 && plan.cols[0].dateIndex === 2);
const conv = fx.convertTable({ columns: cols, rows }, plan as fx.FxPlan, t2);
const amounts = conv.rows.map((r) => r[0]);
ok('per-row: amounts convert at each row\'s own currency', JSON.stringify(amounts) === JSON.stringify([100, 125, 12.5, 80, null, null, null, null, null, 'n/a', 50]), JSON.stringify(amounts));
ok('per-row: the marker column is appended and named', conv.columns.length === 5 && conv.columns[4].name === fx.FX_MARK);
const miss = fx.missingOf(conv);
ok('missing: four rows had no rate', miss.missing === 4, JSON.stringify(miss));
ok('missing: their pairs, sorted', JSON.stringify(miss.pairs) === JSON.stringify(['?→USD', 'EUR→USD', 'SEK→USD']), JSON.stringify(miss.pairs));
ok('missing: excluded from the sum, never counted as 1', computeMetric(conv.columns, conv.rows, { column: 'amount', aggregation: 'sum' }) === 367.5);
ok('missing: the warning names the pairs and the rows', fx.fxWarning({ target: 'USD', ...miss, sample: false }) === '4 rows had no EUR→USD, SEK→USD rate or no currency code — excluded');
ok('missing: one row reads singular', fx.fxWarning({ target: 'USD', missing: 1, pairs: ['EUR→USD'], sample: false }) === '1 row had no EUR→USD rate — excluded');
ok('missing: none → no warning', fx.fxWarning({ target: 'USD', missing: 0, pairs: [], sample: true }) === '');
ok('missing: the source rows are not mutated', rows[1][0] === 100 && rows[1].length === 4);

// A fixed currency, a picked date column, and a dataset with no date at all.
const fixed = fx.resolvePlan(cols, { amount: { kind: 'fixed', code: 'EUR', date: 'day' } }, ['amount', 'amount'], 'JPY');
const fx2 = fx.convertTable({ columns: cols, rows: [[2, 'USD', '2024-02-10', 'x']] }, fixed as fx.FxPlan, t2);
ok('fixed: the declared code wins over any currency column', fx2.rows[0][0] === 400 && fixed!.cols.length === 1);
const noDate = fx.resolvePlan([{ name: 'amount', type: 'number' }], { amount: { kind: 'fixed', code: 'EUR' } }, ['amount'], 'USD');
const fx3 = fx.convertTable({ columns: [{ name: 'amount', type: 'number' }], rows: [[4]] }, noDate as fx.FxPlan, t1);
ok('no date column: the latest rate applies', noDate!.cols[0].dateIndex === -1 && fx3.rows[0][0] === 4 * 1.3);
ok('plan: a declaration on a text column is ignored', fx.resolvePlan(cols, { region: { kind: 'fixed', code: 'EUR' } }, ['region'], 'USD') === null);
ok('plan: an undeclared measure does not convert', fx.resolvePlan(cols, { amount: { kind: 'fixed', code: 'EUR' } }, ['region'], 'USD') === null);
ok('plan: a declaration naming a gone currency column → every row missing', (() => {
  const p = fx.resolvePlan(cols, { amount: { kind: 'column', column: 'gone' } }, ['amount'], 'USD') as fx.FxPlan;
  return fx.missingOf(fx.convertTable({ columns: cols, rows: [[1, 'USD', '2024-02-10', 'x']] }, p, t2)).missing === 1;
})());

// ── A rate TABLE read from a dataset ─────────────────────────────────────────
const rateCols: ParsedColumn[] = [{ name: 'Date', type: 'date' }, { name: 'From', type: 'text' }, { name: 'To', type: 'text' }, { name: 'Rate', type: 'number' }];
const rr = fx.rateRowsFromTable({ columns: rateCols, rows: [
  ['2024-01-01', 'eur', 'usd', 1.5], ['', 'EUR', 'USD', 1], ['2024-01-01', 'EURO', 'USD', 1], ['2024-01-01', 'EUR', 'USD', 0],
  ['2024-01-01', 'EUR', 'USD', -1], ['2024-01-01', 'EUR', 'USD', '1.2'], ['01/15/2024', 'GBP', 'USD', 2],
] }, { date: 'Date', from: 'From', to: 'To', rate: 'Rate' });
ok('rate table: only valid rows survive (codes, a date, a finite rate > 0)', rr.length === 2 && rr[0].from === 'EUR' && rr[0].to === 'USD' && rr[1].day === day('2024-01-15'), JSON.stringify(rr));
ok('rate table: a missing mapped column yields no rates', fx.rateRowsFromTable({ columns: rateCols, rows: [] }, { date: 'x', from: 'From', to: 'To', rate: 'Rate' }).length === 0);

// ── Sanitizers ───────────────────────────────────────────────────────────────
ok('codes: ISO-4217 shape, upper case only', fx.isCurrencyCode('EUR') && !fx.isCurrencyCode('eur') && !fx.isCurrencyCode('EURO') && !fx.isCurrencyCode(1));
ok('decl: fixed with a bad code is refused', fx.sanitizeDecl({ kind: 'fixed', code: 'eur' }) === null);
ok('decl: column + date round-trip', JSON.stringify(fx.sanitizeDecl({ kind: 'column', column: 'cur', date: 'day', x: 1 })) === JSON.stringify({ kind: 'column', column: 'cur', date: 'day' }));
const s = fx.sanitizeSettings({ target: 'xx', source: { datasetId: '../x', date: 'd', from: 'f', to: 't', rate: 'r' },
  columns: { 'not-a-uuid': { a: { kind: 'fixed', code: 'EUR' } }, '00000000-0000-4000-8000-000000000001': { a: { kind: 'fixed', code: 'EUR' }, b: { kind: 'nope' } } },
  dashboards: { '00000000-0000-4000-8000-000000000002': 'GBP', bad: 'GBP' } });
ok('settings: bad target, bad source, bad ids are dropped', s.target === '' && s.source === null
  && JSON.stringify(Object.keys(s.columns)) === '["00000000-0000-4000-8000-000000000001"]'
  && JSON.stringify(Object.keys(s.columns['00000000-0000-4000-8000-000000000001'])) === '["a"]'
  && JSON.stringify(s.dashboards) === '{"00000000-0000-4000-8000-000000000002":"GBP"}', JSON.stringify(s));
ok('merge: two operands\' notes add up', JSON.stringify(fx.mergeFx({ target: 'USD', missing: 2, pairs: ['SEK→USD'], sample: false }, { target: 'USD', missing: 1, pairs: ['EUR→USD', 'SEK→USD'], sample: true }))
  === JSON.stringify({ target: 'USD', missing: 3, pairs: ['EUR→USD', 'SEK→USD'], sample: true, warning: '3 rows had no EUR→USD, SEK→USD rate — excluded' }));

// ── The bundled sample ───────────────────────────────────────────────────────
const sample = sampleRates();
ok('sample: labelled "Sample rates, not live"', sample.label === fx.SAMPLE_LABEL);
ok('sample: monthly X→USD for the major currencies', ['EUR', 'GBP', 'JPY', 'INR', 'CAD'].every((c) => sample.currencies.includes(c)) && sample.rows.every((r) => r.to === 'USD' && r.rate > 0));
ok('sample: EUR→GBP triangulates through USD', (fx.crossRate(sample.table, 'EUR', 'GBP', day('2025-06-15')) ?? 0) > 0);
ok('sample: before its first month there is no rate', fx.crossRate(sample.table, 'EUR', 'USD', day('2022-12-31')) === null);

finish();
