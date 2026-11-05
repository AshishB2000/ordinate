'use strict';

// Self-check for the semantic-layer side of the Live engine (semantic layer part 7, b1): the IR's
// `{ metric }` measure, the layer refusals, and the PLAN that turns an IR into the questions a
// layer can answer (docs/semantic-layer/07-portability.md D12, D16, D17). Pure: no layer, no DuckDB.
//
//   npm run build:ts && node scripts/test-semanticPlan.js

import { ok, finish } from './selfcheck';
import type { LiveIR, LiveRefusal } from '../src/engine/live/liveSpec';

const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const comp: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const shape: typeof import('../src/engine/live/shape') = require('../src/engine/live/shape');
const msg: typeof import('../src/engine/liveRefusals') = require('../src/engine/liveRefusals');
const sr: typeof import('../src/engine/live/semantic/semanticRefusals') = require('../src/engine/live/semantic/semanticRefusals');
const i18n: typeof import('../src/app/i18n') = require('../src/app/i18n');

const show = (v: unknown): string => JSON.stringify(v);
const ENV = { dialect: 'duckdb' as const, source: { kind: 'table' as const, parts: ['orders'] }, columns: [{ name: 'amount', type: 'number' as const }] };

/** The refusal renders its own catalog key with its own parameters. */
const rendered = (r: LiveRefusal): boolean => i18n.t(r.key, r.params) === r.message && !r.message.includes('{');

function ir1(): void {
  const ir = { kind: 'metric', measures: [{ metric: 'revenue' }], filters: [], order: 'natural', weekCal: null } as LiveIR;
  const r = comp.compileMetric(ir, ENV);
  ok('the relational compiler refuses a metric measure', !r.ok && r.code === 'metricOnTable', show(r));
  ok('…in a sentence naming the metric', !r.ok && r.message.includes('revenue') && rendered(r), show(r));
  const chart = comp.compileChart({ kind: 'chart', category: { column: 'amount', kind: 'text' }, measures: [{ column: 'amount', aggregation: 'sum' }, { metric: 'revenue' }], filters: [], order: 'natural', weekCal: null }, { kind: 'text' }, ENV);
  ok('…and on a chart, whichever measure it is', !chart.ok && chart.code === 'metricOnTable');
  ok('isMetricMeasure tells the two measures apart', spec.isMetricMeasure({ metric: 'revenue' }) && !spec.isMetricMeasure({ column: 'amount', aggregation: 'sum' }));
  ok('a metric measure reads its one part', shape.measureValue({ metric: 'revenue' }, { s: null, c: null, n: null, x: null, d: null, v: 12 }) === 12);
  ok('…which is its own', show(comp.partsOf({ metric: 'revenue' })) === '["v"]' && show(comp.partsOf({ column: 'amount', aggregation: 'avg' })) === '["s","c"]');
  ok('a metric measure is named by the metric', shape.measureName({ metric: 'Gross margin' }) === 'Gross margin' && shape.measureName({ column: 'amount', aggregation: 'sum' }) === 'sum of amount');

  const r2 = sr.refuseLayer('pivot', { dataset: 'Sales', layer: 'Snowflake' });
  ok('a row-needing refusal keeps its code and names the layer', r2.code === 'pivot' && r2.message === 'A pivot table can\'t be drawn from Sales: Snowflake computes its metrics and returns totals, not rows.', show(r2));
  ok('metricMissing names the metric and the layer', sr.refuseLayer('metricMissing', { dataset: 'Sales', layer: 'dbt', metric: 'Revenue' }).message === 'Revenue is no longer defined in dbt.');
  ok('NEGATIVE CONTROL: plain refusals are byte-identical', spec.refuse('pivot').message === msg.livePivotRefused() && spec.refuse('pivot').key === 'liveRefusals.a_pivot_table_cannot_be_drawn');
  const every = sr.LAYER_CODES.map((code) => sr.refuseLayer(code, { dataset: 'Sales', layer: 'Cube', metric: 'Revenue', column: 'region' }));
  ok(`every layer refusal (${every.length}) renders its catalog key with its parameters`, every.length === 19 && every.every(rendered), show(every.filter((r) => !rendered(r))));
  ok('…each names the layer or the metric it is about', every.every((r) => r.message.includes('Cube') || r.message.includes('Revenue')), show(every.map((r) => r.message)));
  ok('a layer is named by its backend; an unknown one is "another tool"', sr.layerLabel('snowflake') === 'Snowflake' && sr.layerLabel('cube') === 'Cube' && sr.layerLabel('dbt') === 'dbt' && sr.layerLabel('acme') === 'another tool');
  sr.registerLayerLabel('fake', 'Fake layer (tests)');
  ok('…and a test adapter by the label it registers', sr.layerLabel('fake') === 'Fake layer (tests)');
}

ir1();
finish();
