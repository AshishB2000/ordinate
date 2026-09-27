// RFM — the grid, the quintile scores and their edges, the per-customer
// aggregation (JS reference), the eleven-row breakdown and the saved table.
// The resident twin of the aggregation is held to this one in
// scripts/test-segmentsDuck.ts.
//
//   npm run build:ts && node scripts/test-rfm.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Cell, TableData } from '../src/data/transforms';

const rfm: typeof import('../src/analysis/rfm') = require('../src/analysis/rfm');

const C = (id: string, last: number, frequency: number, monetary: number) => ({ id, last, frequency, monetary });

// ── the grid ──────────────────────────────────────────────────────────────────
{
  const all = new Set<string>();
  for (let r = 1; r <= 5; r++) for (let f = 1; f <= 5; f++) for (let m = 1; m <= 5; m++) all.add(rfm.rfmSegment(r, f, m));
  ok('grid: all eleven segments are reachable, and nothing else', all.size === 11 && [...all].every((s) => (rfm.RFM_SEGMENTS as readonly string[]).includes(s)), [...all].join(', '));
  ok('grid: R5 F5 M5 is Champions', rfm.rfmSegment(5, 5, 5) === 'Champions');
  ok('grid: R1 F1 M1 is Lost', rfm.rfmSegment(1, 1, 1) === 'Lost');
  ok('grid: R2 F1 M1 is Hibernating', rfm.rfmSegment(2, 1, 1) === 'Hibernating');
  ok("grid: R1 F5 M5 is Can't Lose Them", rfm.rfmSegment(1, 5, 5) === "Can't Lose Them");
  ok('grid: R1 F4 M3 is At Risk (FM rounds half up to 4)', rfm.rfmSegment(1, 4, 3) === 'At Risk');
  ok('grid: R5 F1 M1 is New Customers', rfm.rfmSegment(5, 1, 1) === 'New Customers');
  ok('grid: R4 F1 M1 is Promising', rfm.rfmSegment(4, 1, 1) === 'Promising');
  ok('grid: R3 F3 M3 is Need Attention', rfm.rfmSegment(3, 3, 3) === 'Need Attention');
  ok('grid: R3 F2 M1 is About to Sleep', rfm.rfmSegment(3, 2, 1) === 'About to Sleep');
  ok('grid: R4 F5 M5 is Loyal Customers', rfm.rfmSegment(4, 5, 5) === 'Loyal Customers');
  ok('grid: R5 F2 M3 is Potential Loyalists', rfm.rfmSegment(5, 2, 3) === 'Potential Loyalists');
  ok('grid: R5 F4 M3 is Champions (FM 3.5 → 4)', rfm.rfmSegment(5, 4, 3) === 'Champions');
}

// ── scores ────────────────────────────────────────────────────────────────────
{
  const five = rfm.scoreRfm([C('a', 100, 1, 10), C('b', 90, 2, 20), C('c', 80, 3, 30), C('d', 70, 4, 40), C('e', 60, 5, 50)]);
  ok('five customers: one per quintile', five.scored.map((c) => c.f).join('') === '12345' && five.scored.map((c) => c.m).join('') === '12345');
  ok('recency is measured from the latest date in the data', five.maxDay === 100 && five.scored.map((c) => c.recency).join(',') === '0,10,20,30,40');
  ok('a smaller recency scores higher', five.scored.map((c) => c.r).join('') === '54321');
  ok('R5 F1 M1 → New Customers; R1 F5 M5 → Can\'t Lose Them',
    five.scored[0].segment === 'New Customers' && five.scored[4].segment === "Can't Lose Them", five.scored.map((c) => c.segment).join(', '));

  const one = rfm.scoreRfm([C('solo', 5, 3, 99)]);
  ok('one customer: R5 F1 M1, recency 0', one.scored[0].r === 5 && one.scored[0].f === 1 && one.scored[0].m === 1 && one.scored[0].recency === 0);

  const ties = rfm.scoreRfm([C('a', 10, 1, 5), C('b', 10, 1, 5), C('c', 10, 1, 5), C('d', 10, 1, 5), C('e', 10, 1, 5)]);
  ok('ties break on first-seen order (the ntile rule), deterministically',
    ties.scored.map((c) => c.f).join('') === '12345' && ties.scored.map((c) => c.r).join('') === '54321',
    ties.scored.map((c) => `${c.r}${c.f}`).join(' '));
  const again = rfm.scoreRfm([C('a', 10, 1, 5), C('b', 10, 1, 5), C('c', 10, 1, 5), C('d', 10, 1, 5), C('e', 10, 1, 5)]);
  ok('the same customers score the same way twice', JSON.stringify(again) === JSON.stringify(ties));

  const ten = rfm.scoreRfm(Array.from({ length: 10 }, (_, i) => C('c' + i, 50, 10 - i, i)));
  ok('ten customers: two per quintile', ten.scored.map((c) => c.m).join('') === '1122334455' && ten.scored.map((c) => c.f).join('') === '5544332211');
  ok('no customers: nothing scored, no date', rfm.scoreRfm([]).scored.length === 0 && rfm.scoreRfm([]).maxDay === null);
  ok('a negative amount ranks lowest, not rejected', rfm.scoreRfm([C('a', 1, 1, -5), C('b', 1, 1, 0)]).scored[0].m === 1);
}

// ── aggregation (the JS reference) ────────────────────────────────────────────
const T: TableData = {
  columns: [{ name: 'customer', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }],
  rows: [
    ['007', '2024-01-05', 10],
    ['B', '2024-03-01', 5.5],
    ['007', '2024-02-10', 20],
    ['', '2024-02-10', 1], // no id
    ['  ', '2024-02-10', 1], // whitespace id
    ['C', 'not a date', 3], // no date
    ['C', '2024-02-30', 3], // not a civil date
    ['C', '2024-02-29', null], // no amount
    ['C', '02/28/2024', 7], // US shape reads
    [null, '2024-01-01', 2],
  ] as Cell[][],
};
{
  const agg = rfm.rfmCustomersJs(T, { id: 'customer', date: 'day', amount: 'amount' });
  ok('aggregation: customers in first-seen order, ids kept as text', agg.customers.map((c) => c.id).join(',') === '007,B,C');
  ok('aggregation: frequency and monetary', agg.customers[0].frequency === 2 && agg.customers[0].monetary === 30 && agg.customers[2].monetary === 7);
  ok('aggregation: the latest order day per customer',
    agg.customers[0].last === Date.UTC(2024, 1, 10) / 86_400_000 && agg.customers[2].last === Date.UTC(2024, 1, 28) / 86_400_000);
  ok('aggregation: rows without id, date or amount are counted, not guessed', agg.used === 4 && agg.skipped === 6, `${agg.used} / ${agg.skipped}`);

  const res = rfm.rfmBreakdown(agg);
  ok('breakdown: all eleven segments listed, in order', res.segments.length === 11 && res.segments.map((s) => s.name).join('|') === rfm.RFM_SEGMENTS.join('|'));
  ok('breakdown: counts add up to the customers', res.segments.reduce((a, s) => a + s.count, 0) === 3 && res.customers === 3);
  ok('breakdown: shares add up to 1', Math.abs(res.segments.reduce((a, s) => a + s.share, 0) - 1) < 1e-12);
  ok('breakdown: an empty segment has no averages', res.segments.filter((s) => !s.count).every((s) => s.recency === null && s.monetary === null));
  ok('breakdown: as of the latest order date', res.asOf === '2024-03-01', String(res.asOf));
  ok('breakdown: the grid holds every customer', res.grid.flat().reduce((a, b) => a + b, 0) === 3 && res.grid.length === 5 && res.grid.every((r) => r.length === 5));

  const t = rfm.rfmTable(agg, 'recency');
  ok('table: a clashing id name is kept, the score column renamed', t.columns.map((c) => c.name).join(',') === 'recency,recency_2,frequency,monetary,r,f,m,rfm_segment', t.columns.map((c) => c.name).join(','));
  ok('table: one row per customer, id as text', t.rows.length === 3 && t.columns[0].type === 'text' && t.rows[0][0] === '007');
}

// ── pickers and problems ──────────────────────────────────────────────────────
{
  const cols = [{ name: 'order_id', type: 'text' }, { name: 'Customer ID', type: 'text' }, { name: 'order_date', type: 'date' }, { name: 'units', type: 'number' }, { name: 'revenue', type: 'number' }];
  const d = rfm.rfmDefaults(cols);
  ok('defaults: the customer column, the date, the revenue', d.id === 'Customer ID' && d.date === 'order_date' && d.amount === 'revenue', JSON.stringify(d));
  const retail = rfm.rfmDefaults([{ name: 'order_date', type: 'date' }, { name: 'customer_segment', type: 'text' }, { name: 'unit_price', type: 'number' }, { name: 'revenue', type: 'number' }]);
  ok('defaults: a category is never guessed as the id, and revenue beats price', retail.id === '' && retail.amount === 'revenue', JSON.stringify(retail));
  ok('problem: a text amount is refused', /not a number column/.test(rfm.rfmProblem(cols, { id: 'Customer ID', date: 'order_date', amount: 'order_id' }) || ''));
  ok('problem: a missing column is refused', rfm.rfmProblem(cols, { id: 'nope', date: 'order_date', amount: 'revenue' }) !== null);
  ok('problem: the same column twice is refused', rfm.rfmProblem(cols, { id: 'revenue', date: 'order_date', amount: 'revenue' }) !== null);
  ok('problem: a good pick passes', rfm.rfmProblem(cols, d) === null);
}

finish();
