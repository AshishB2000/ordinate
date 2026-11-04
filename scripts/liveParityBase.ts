// The live-parity matrix's base-filter case (semantic layer part 1, PR 08, D13) — helper for
// scripts/test-liveParity.ts and scripts/test-liveParityPostgres.ts; not a suite itself.
//
// A Live table with base filters must answer exactly what a copy with the same Prepare filter steps
// answers. The fixture is saved again as an extract, BASE_P becomes its Prepare steps
// (`datasets.updateSteps`), and the matrix's own comparisons (`parityKit`) hold the live side — the
// typed environment with `base` — to that copy: charts of every category kind, KPIs, and an answer
// whose data-relative period ("last quarter") is anchored AFTER the base (the base keeps 2024 only, so
// both anchor on 2024's last date, not the table's 2025). NEGATIVE CONTROL: the same live questions without `base` disagree.

import type { CompileEnv, CompiledQuery } from '../src/engine/live/compile';
import type { LiveStep } from '../src/engine/live/evaluate';
import type { LiveRows } from '../src/engine/live/shape';
import type { Extract, Ok } from './liveParityMatrix';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const liveBase: typeof import('../src/engine/live/liveBase') = require('../src/engine/live/liveBase');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');

const { F, M } = mx;
export const BASE_P = [
  F('region', 'not in', undefined, { values: ['North'] }),
  F('amt', '>=', 10),
  F('d', 'period', undefined, { period: { preset: 'custom', from: '2024-01-01', to: '2024-12-31' } }),
];

export async function baseFilterCase(x: Extract, run: (q: CompiledQuery, step: LiveStep) => Promise<LiveRows>, typed: CompileEnv, ok: Ok): Promise<void> {
  const imported = fx.importTyped(fx.COLUMNS, x.rows);
  const ds = await datasets.saveDataset(x.pid, { name: 'Fixture, base-filtered copy', sourceKind: 'csv', columns: imported.columns, rows: imported.rows });
  const stepped = ds ? await datasets.updateSteps(x.pid, ds.id, BASE_P) : null;
  const back = ds && stepped ? await datasets.getDataset(x.pid, ds.id) : null;
  const b = liveBase.liveBaseOf(BASE_P, typed.columns);
  ok('base parity: the copy is saved with the base as its Prepare steps, and the base adapts', !!back && stepped!.output.warnings.length === 0 && b.ok, JSON.stringify(b));
  if (!back || !b.ok) return;
  ok('base parity: the base keeps some rows and drops some', back.rows.length > 0 && back.rows.length < x.stored.rows.length, `${back.rows.length} of ${x.stored.rows.length}`);
  const env: CompileEnv = { ...typed, base: b.base };
  const kit = mx.parityKit({ ...x, did: back.id, stored: { columns: back.columns, rows: back.rows } }, run);
  const encs = [
    { category: 'cat', values: [M('amt', 'sum'), M('qty', 'count')] },
    { category: 'd', grain: 'month' as const, values: [M('amt', 'avg')] },
    { category: 'amt', values: [M('qty', 'sum')] },
    { category: 'region', values: [M('amt', 'max')], series: 'tier' },
  ];
  for (const enc of encs) {
    const p = await kit.chartProblems(enc, [], env);
    ok(`base parity: ${JSON.stringify(enc)}`, p.length === 0, p.join(' | '));
  }
  const p2 = await kit.chartProblems(encs[0], [F('region', 'in', undefined, { values: ['South', 'East'] })], env);
  ok('base parity: a question filter on top of the base', p2.length === 0, p2.join(' | '));
  for (const m of [{ column: 'amt', aggregation: 'sum' as const }, { column: 'bigid', aggregation: 'count' as const }, { column: 'qty', aggregation: 'avg' as const }]) {
    const p = await kit.metricProblems(m, [], env);
    ok(`base parity KPI ${m.aggregation}(${m.column})`, p.length === 0, p.join(' | '));
  }
  const answer = { datasetId: back.id, category: 'region', measures: [M('amt', 'sum')], filters: [{ column: 'd', period: 'last_quarter' as const }], chartType: 'bar' as const, title: 't' };
  const pa = await kit.answerProblems(answer, env);
  ok('base parity: an answer "last quarter" is anchored after the base, as the copy anchors it', pa.length === 0, pa.join(' | '));
  const pn = await kit.chartProblems(encs[0], [], typed);
  ok('NEGATIVE CONTROL: the same live questions without `base` disagree with the filtered copy', pn.length > 0);
  const pq = await kit.answerProblems(answer, typed);
  ok('NEGATIVE CONTROL: without `base` the answer\'s anchor is the whole table\'s, not the copy\'s', pq.length > 0);
}
