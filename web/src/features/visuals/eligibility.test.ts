// Differential: the chip rules here and the desktop's (its renderResult.js +
// mapKinds.js) give the SAME answer on every shape × series × label count, and
// for every pooled type on a spread of replies. The desktop scripts went at the
// T8.1 cutover; their answers over these inputs are __golden__/eligibility.json.

import { describe, expect, it } from 'vitest';
import { golden } from '../../test-golden';
import { chartCanRender, countNumericSeries, eligibleChartTypes, PICKER_POOL } from './eligibility';

const G = golden<{ eligible: Record<string, string[]>; canRender: Record<string, boolean>; numeric: Record<string, number>; textOnly: number }>(
  'src/features/visuals/__golden__/eligibility.json',
);

const SHAPES = ['time_series', 'part_to_whole', 'categorical', 'single_metric', 'matrix', 'unstructured', 'nonsense'];

const reply = (series: number, labels: number, geo?: unknown) => ({
  labels: Array.from({ length: labels }, (_, i) => `L${i}`),
  series: Array.from({ length: series }, (_, j) => ({ name: `S${j}`, values: Array.from({ length: labels }, (_, i) => (i + j) % 3 === 0 ? null : i * 2 + j) })),
  ...(geo ? { geo } : {}),
});

describe('chart eligibility matches the desktop', () => {
  it('eligibleChartTypes: every shape × 0–7 series × 0–10 labels', () => {
    let n = 0;
    for (const shape of SHAPES)
      for (let s = 0; s <= 7; s++)
        for (let l = 0; l <= 10; l++, n++) expect(eligibleChartTypes(shape, s, l), `${shape} ${s}×${l}`).toEqual(G.eligible[`${shape} ${s}×${l}`]);
    expect(n).toBe(SHAPES.length * 8 * 11);
    expect(Object.keys(G.eligible)).toHaveLength(n);
  });

  it('chartCanRender and countNumericSeries: every pooled type on a spread of replies', () => {
    const geos = [undefined, { level: 'us_state', items: [] }, { level: 'hexbin', hex: {} }, { level: 'flow', flow: {} }];
    let n = 0;
    for (const geo of geos)
      for (const [s, l] of [[0, 0], [1, 1], [1, 2], [2, 3], [3, 7], [6, 12], [1, 30]] as const) {
        const data = reply(s, l, geo);
        expect(countNumericSeries(data)).toBe(G.numeric[`${s}×${l} ${JSON.stringify(geo)}`]);
        for (const type of PICKER_POOL) {
          const key = `${type} ${s}×${l} ${JSON.stringify(geo)}`;
          expect(key in G.canRender, `recorded: ${key}`).toBe(true);
          expect(chartCanRender(type, data as never, !!geo), key).toBe(G.canRender[key]);
          n++;
        }
      }
    expect(n).toBeGreaterThan(1000);
    expect(Object.keys(G.canRender)).toHaveLength(n);
  });

  it('a series of only text and nulls is not a numeric series', () => {
    const data = { labels: ['a'], series: [{ values: ['x', null] }, { values: [1] }] };
    expect(countNumericSeries(data)).toBe(1);
    expect(G.textOnly).toBe(1);
  });

  it('a broken port would be caught (negative control)', () => {
    expect(eligibleChartTypes('categorical', 1, 3)).not.toEqual(G.eligible['time_series 3×10']);
  });
});
