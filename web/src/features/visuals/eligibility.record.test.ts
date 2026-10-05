// ONE-OFF RECORDER (T8.1) for eligibility.test.ts: the desktop's chip rules
// (renderResult.js + mapKinds.js) over that test's inputs, written to
// __golden__/eligibility.json. Runs only with GOLDEN_RECORD=1; deleted with
// the desktop tree in the next commit.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'vitest';
import { encode } from '../../../../src/server/wire.ts';
import { PICKER_POOL } from './eligibility';

const HUB = path.join(path.resolve(process.cwd(), '..'), 'renderer', 'hub');

function slice(file: string, from: string, to: string): string {
  const src = readFileSync(path.join(HUB, file), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`${file}: markers not found — has it changed shape?`);
  return src.slice(a, b);
}

describe.runIf(process.env.GOLDEN_RECORD)('record eligibility', () => {
  it('writes __golden__/eligibility.json', () => {
    const sandbox: Record<string, unknown> = { console, t: (k: string) => k };
    vm.createContext(sandbox);
    const src = [readFileSync(path.join(HUB, 'mapKinds.js'), 'utf8'), slice('renderResult.js', 'const SHAPE_CHARTS', '// Shared chart-type picker')].join('\n;\n');
    // any: the legacy classic scripts are untyped
    const legacy = vm.runInContext(`${src}\n;({ eligibleChartTypes, chartCanRender, countNumericSeries });`, sandbox) as any;
    const SHAPES = ['time_series', 'part_to_whole', 'categorical', 'single_metric', 'matrix', 'unstructured', 'nonsense'];
    const eligible: Record<string, string[]> = {};
    for (const shape of SHAPES) for (let s = 0; s <= 7; s++) for (let l = 0; l <= 10; l++) eligible[`${shape} ${s}×${l}`] = Array.from(legacy.eligibleChartTypes(shape, s, l));
    const reply = (series: number, labels: number, geo?: unknown) => ({
      labels: Array.from({ length: labels }, (_, i) => `L${i}`),
      series: Array.from({ length: series }, (_, j) => ({ name: `S${j}`, values: Array.from({ length: labels }, (_, i) => (i + j) % 3 === 0 ? null : i * 2 + j) })),
      ...(geo ? { geo } : {}),
    });
    const geos = [undefined, { level: 'us_state', items: [] }, { level: 'hexbin', hex: {} }, { level: 'flow', flow: {} }];
    const canRender: Record<string, boolean> = {};
    const numeric: Record<string, number> = {};
    for (const geo of geos)
      for (const [s, l] of [[0, 0], [1, 1], [1, 2], [2, 3], [3, 7], [6, 12], [1, 30]] as const) {
        const data = reply(s, l, geo);
        numeric[`${s}×${l} ${JSON.stringify(geo)}`] = legacy.countNumericSeries(data);
        for (const type of PICKER_POOL) canRender[`${type} ${s}×${l} ${JSON.stringify(geo)}`] = legacy.chartCanRender(type, data, !!geo);
      }
    const textOnly = legacy.countNumericSeries({ labels: ['a'], series: [{ values: ['x', null] }, { values: [1] }] });
    const out = path.join(process.cwd(), 'src/features/visuals/__golden__');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'eligibility.json'), encode({ eligible, canRender, numeric, textOnly }) + '\n');
  });
});
