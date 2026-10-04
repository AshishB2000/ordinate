// Differential: the chip rules here and the desktop's (renderer/hub/
// renderResult.js + mapKinds.js, as the root build emits them) give the SAME
// answer on every shape × series × label count, and for every pooled type on
// a spread of replies. Needs `npm run build:ts` at the repo root.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { chartCanRender, countNumericSeries, eligibleChartTypes, PICKER_POOL } from './eligibility';

const HUB = path.join(path.resolve(process.cwd(), '..'), 'renderer', 'hub');

function slice(file: string, from: string, to: string): string {
  const src = readFileSync(path.join(HUB, file), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`${file}: markers not found — has it changed shape?`);
  return src.slice(a, b);
}

interface Legacy {
  eligibleChartTypes(shape: string, s: number, l: number): string[];
  chartCanRender(type: string, data: unknown, hasGeo: boolean): boolean;
  countNumericSeries(data: unknown): number;
}

const legacy = (() => {
  const sandbox: Record<string, unknown> = { console, t: (k: string) => k };
  vm.createContext(sandbox);
  const src = [
    readFileSync(path.join(HUB, 'mapKinds.js'), 'utf8'),
    slice('renderResult.js', 'const SHAPE_CHARTS', '// Shared chart-type picker'),
  ].join('\n;\n');
  return vm.runInContext(`${src}\n;({ eligibleChartTypes, chartCanRender, countNumericSeries });`, sandbox) as Legacy;
})();

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
        for (let l = 0; l <= 10; l++, n++) expect(eligibleChartTypes(shape, s, l), `${shape} ${s}×${l}`).toEqual(legacy.eligibleChartTypes(shape, s, l));
    expect(n).toBe(SHAPES.length * 8 * 11);
  });

  it('chartCanRender and countNumericSeries: every pooled type on a spread of replies', () => {
    const geos = [undefined, { level: 'us_state', items: [] }, { level: 'hexbin', hex: {} }, { level: 'flow', flow: {} }];
    let n = 0;
    for (const geo of geos)
      for (const [s, l] of [[0, 0], [1, 1], [1, 2], [2, 3], [3, 7], [6, 12], [1, 30]] as const) {
        const data = reply(s, l, geo);
        expect(countNumericSeries(data)).toBe(legacy.countNumericSeries(data));
        for (const type of PICKER_POOL) {
          expect(chartCanRender(type, data as never, !!geo), `${type} ${s}×${l} ${JSON.stringify(geo)}`).toBe(legacy.chartCanRender(type, data, !!geo));
          n++;
        }
      }
    expect(n).toBeGreaterThan(1000);
  });

  it('a series of only text and nulls is not a numeric series', () => {
    const data = { labels: ['a'], series: [{ values: ['x', null] }, { values: [1] }] };
    expect(countNumericSeries(data)).toBe(1);
    expect(legacy.countNumericSeries(data)).toBe(1);
  });
});
