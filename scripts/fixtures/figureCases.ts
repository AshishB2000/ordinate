// The inputs behind web/src/charts/__golden__/shapes.json: the cases today's
// in-app chart answered when its figures were recorded (web/src/charts/
// shapesGolden.test.ts), and the cases scripts/test-chartShapes.ts asks the
// server's src/analysis/chartShapes.ts — one list, so the two can never ask
// different questions. Data only.

type Cx = any; // fixture cells: numbers, nulls, and the odd string a chart must survive
interface ChartSeriesShape { name?: string; values: Cx[] }

const s = (name: string, values: Cx[]): ChartSeriesShape => ({ name, values });
const one = (values: Cx[]): ChartSeriesShape[] => [s('sum of revenue', values)];

/** Waterfall: Total rows, negatives, a two-series bridge, an empty group, named totals. */
export const WATERFALL: Array<{ name: string; labels: Cx[]; series: ChartSeriesShape[]; totals?: string[] }> = [
  { name: 'negatives', labels: ['Q1 sales', 'Returns', 'Fees', 'Q2 sales'], series: one([120, -30, -12.5, 80]) },
  { name: 'opening, subtotal and grand total', labels: ['Opening', 'Sales', 'Returns', 'Subtotal', 'Fees', 'Grand total'], series: one([100, 40, -15, null, -5, null]) },
  { name: 'a total with its own value resets the level', labels: ['Opening', 'Sales', 'Total', 'Refunds'], series: one([50, 20, 999, -9]) },
  { name: 'named totals (the drivers tile)', labels: ['Previous total', 'East', 'West', 'Current total'], series: one([10, 5, -3, 12]), totals: ['Previous total', 'Current total'] },
  { name: 'a named total that is not a label', labels: ['a', 'b'], series: one([1, 2]), totals: ['zzz'] },
  { name: 'bridge', labels: ['East', 'West', 'Total', 'North'], series: [s('2023', [0.1, 0.7, 99, null]), s('2024', [0.3, null, 1, 0.2])] },
  { name: 'bridge, falling', labels: ['A', 'B', 'C'], series: [s('Last year', [500, 300, 200]), s('This year', [420, 310, 150])] },
  { name: 'bridge, unnamed series', labels: ['x', 'y'], series: [s('', [1, 2]), s('', [3, 1])] },
  { name: 'an empty group', labels: ['A', 'B', 'C'], series: one([null, null, null]) },
  { name: 'no categories', labels: [], series: one([]) },
  { name: 'a single step', labels: ['Only'], series: one([7]) },
  { name: 'ends on a total', labels: ['a', 'b', 'Total'], series: one([1, 2, null]) },
  { name: 'float drift', labels: ['a', 'b', 'c'], series: one([0.1, 0.2, 0.3]) },
  { name: 'text and nulls are no step', labels: ['a', 'b', 'c'], series: one([3, 'n/a', null]) },
  { name: 'total-looking labels', labels: ['Sub-total', 'total 2024', 'Totally', 'grand Total'], series: one([1, 2, 3, null]) },
];

/** Pareto: unsorted input, ties, negatives, a single bar, nulls, an exact 80%. */
export const PARETO: Array<{ name: string; labels: Cx[]; values: Cx[] }> = [
  { name: 'unsorted', labels: ['C', 'A', 'D', 'B'], values: [10, 50, 5, 35] },
  { name: 'ties keep their order', labels: ['a', 'b', 'c', 'd', 'e'], values: [40, 40, 20, 0, 0] },
  { name: 'negatives and nulls', labels: ['A', 'B', 'C', 'D'], values: [60, -30, 40, null] },
  { name: 'a single bar', labels: ['Only'], values: [42] },
  { name: 'all zero', labels: ['a', 'b'], values: [0, 0] },
  { name: 'nothing positive', labels: ['a', 'b'], values: [-1, -2] },
  { name: 'exact 80% in floats', labels: ['a', 'b', 'c'], values: [0.1, 0.7, 0.2] },
  { name: 'one dominant', labels: ['A', 'B', 'C'], values: [90, 5, 5] },
  { name: 'long tail', labels: Array.from({ length: 30 }, (_, i) => 'c' + i), values: Array.from({ length: 30 }, (_, i) => 1 / (i + 1)) },
  { name: 'numbers as labels', labels: [3, 1, 2], values: [1, 3, 2] },
  { name: 'empty', labels: [], values: [] },
];

/** 100%-stacked: zeros, an all-zero group, negatives, a single series, nulls. */
export const SHARES: Array<{ name: string; labels: Cx[]; series: ChartSeriesShape[] }> = [
  { name: 'two series', labels: ['East', 'West', 'North'], series: [s('Online', [30, 10, 5]), s('Store', [70, 30, 15])] },
  { name: 'zeros and an all-zero group', labels: ['a', 'b', 'c'], series: [s('x', [0, 0, 3]), s('y', [5, 0, 0])] },
  { name: 'negatives', labels: ['a', 'b'], series: [s('x', [-10, 20]), s('y', [30, -5])] },
  { name: 'a single series', labels: ['a', 'b', 'c'], series: [s('only', [1, 2, 0])] },
  { name: 'nulls', labels: ['a', 'b'], series: [s('x', [null, 4]), s('y', [6, null]), s('z', [4, 4])] },
  { name: 'thirds', labels: ['a'], series: [s('x', [1]), s('y', [1]), s('z', [1])] },
];

/** Histogram: what the browser bins today (the first series' numbers). */
export const HISTOGRAM: Array<{ name: string; values: number[] }> = [
  { name: 'empty', values: [] },
  { name: 'one value', values: [5] },
  { name: 'all equal', values: [2, 2, 2] },
  { name: 'spread', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] },
  { name: 'negatives and floats', values: [-3.5, -1.25, 0, 0.1, 2.75, 9.9, 10] },
  { name: 'big', values: Array.from({ length: 200 }, (_, i) => (i * 7919) % 1000) },
];

/** Funnel: each stage against the first, as the tooltip prints it. */
export const FUNNEL: Array<{ name: string; labels: Cx[]; values: Cx[] }> = [
  { name: 'narrowing', labels: ['Visit', 'Cart', 'Pay'], values: [1000, 420, 133] },
  { name: 'a negative and a null', labels: ['a', 'b', 'c'], values: [200, -50, null] },
  { name: 'a zero top', labels: ['a', 'b'], values: [0, 5] },
];

/** Bullet: each row against its target (the second measure, else a fixed target), as the tooltip prints it. */
export const BULLET: Array<{ name: string; labels: Cx[]; series: ChartSeriesShape[]; target?: number }> = [
  { name: 'against a target series', labels: ['A', 'B', 'C'], series: [s('actual', [90, 130, null]), s('target', [100, 100, 80])] },
  { name: 'against a fixed target', labels: ['A', 'B'], series: [s('actual', [40, 80])], target: 100 },
  { name: 'a zero and a missing target', labels: ['A', 'B'], series: [s('actual', [40, 80]), s('target', [0, null])] },
];

/** Calendar: days as written, two labels on one day, impossible dates. */
export const CALENDAR: Array<{ name: string; labels: Cx[]; values: Cx[] }> = [
  { name: 'a week', labels: ['2024-01-01', '2024-01-02', '2024-01-04', '2024-01-07', '2024-01-08'], values: [5, 7, 3, 1, 9] },
  { name: 'two labels on one day', labels: ['2024-01-02T23:30:00-05:00', '2024-01-02 08:00', '2024-01-03T00:00:00Z'], values: [1, 2, 4] },
  { name: 'a null beside a value on one day', labels: ['2024-03-01', '2024-03-01T12:00', '2024-03-02'], values: [null, 6, null] },
  { name: 'across a leap day', labels: ['2024-02-28', '2024-02-29', '2024-03-01'], values: [1, 2, 3] },
  { name: 'not dates', labels: ['North', 'South'], values: [1, 2] },
  { name: 'an impossible date', labels: ['2023-02-30'], values: [1] },
  { name: 'a span past twenty years', labels: ['1990-01-01', '2024-01-01'], values: [1, 2] },
];
