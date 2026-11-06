'use strict';

// THE semantic-layer parity test (semantic layer part 7, b1; docs/semantic-layer/07-portability.md Tests,
// "Layer parity"). A semantic dataset has no rows and no JS fallback, so "the plan and the shaping give the
// figure the app would have" rests on this suite. The live-parity fixture (scripts/liveParityFixture.ts) is
// loaded as an EXTRACT and as the table of a FAKE LAYER (scripts/semanticFake.ts) whose metrics are the
// extract's own aggregations:
//
//   revenue = SUM(amt) · orders = COUNT(*) · avg_amount = AVG(amt) · max_amount = MAX(amt)
//
// Each case is asked of the extract door (`vizDataFor`, `computeCardMetric`, `computeCard`) and of
// `evaluateSemantic` over the fake. Labels, values and the "Other" note agree with the extract under
// `Object.is` (sum/avg within the documented 1e-13 only); the order is the SQL path's own (`evaluateLive`
// over the same table), byte for byte. Divergences are pinned by name in PINS, never by a looser comparison.
//
//   npm run build:ts && node scripts/test-semanticParity.js

import { ok, finish } from './selfcheck';
import type { VizEncoding } from '../src/analysis/visuals';
import type { SemanticAnswer, SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';
import type { SemanticRunner, SemanticStep } from '../src/engine/live/semantic/evaluateSemantic';
import type { Bench, Log } from './semanticParityMatrix';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-semparity-'));
process.env.ORDINATE_LOCAL_DIR = tmp;
process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, as test-liveParity pins it

const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
const fake: typeof import('./semanticFake') = require('./semanticFake');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const pm: typeof import('./semanticParityMatrix') = require('./semanticParityMatrix');
const { AS_COLUMN, TEXT60, MATRIX, ALL, layerIr, cellsAgree, sqlOrder, chartCase } = pm;

const show = (v: unknown): string => JSON.stringify(v);
const { F } = mx;
const TABLE = 'semantic_fixture';

/** The fake as a runner, every question logged; `tamper` may change a question or its answer. */
function runner(b: Bench, log: Log, tamper: { q?: (q: SemanticQuery, step: SemanticStep) => SemanticQuery; a?: (a: SemanticAnswer) => SemanticAnswer } = {}): SemanticRunner {
  return async (q, step) => {
    const asked = tamper.q ? tamper.q(q, step) : q;
    const a = await fake.runFake(TABLE, b.env.columns, asked);
    log.push({ q: asked, step, rows: a.rows.length });
    return tamper.a ? tamper.a(a) : a;
  };
}


async function otherIsAsked(b: Bench): Promise<void> {
  const r = await chartCase(b, TEXT60);
  const other = r.log.find((l) => l.step === 'other');
  ok('"Other" was asked, not summed: a question with no dimension that excludes the 50 kept',
    !!other && other.q.dimensions.length === 0 && other.q.exclude?.values.length === 50 && show(other.q.metrics) === '["avg_amount"]' && other.rows === 1, show(other));
  ok('counted: a chart with "Other" is two questions', show(r.log.map((l) => l.step)) === '["chart","other"]', show(r.log.map((l) => l.step)));
  const sem = r.sem;
  const otherValue = sem.ok && sem.kind === 'chart' ? sem.chart.data.series[0].values[sem.chart.data.labels.indexOf(ck.OTHER_LABEL)] : null;
  // The ten folded categories' own averages, asked of the layer one by one: neither their sum nor their mean is "Other".
  const all = await fake.runFake(TABLE, b.env.columns, { dimensions: [{ name: 'many' }], metrics: ['avg_amount'], where: [], order: [{ by: 'avg_amount', desc: true }, { by: 'many', desc: false }] });
  const folded = all.rows.slice(50).map((row) => Number(row[1]));
  const sumOfAverages = folded.reduce((s, v) => s + v, 0);
  ok('NEGATIVE CONTROL: summing (or averaging) the folded categories\' averages gives a different "Other"',
    folded.length === 10 && typeof otherValue === 'number' && sumOfAverages !== otherValue && sumOfAverages / 10 !== otherValue, show({ otherValue, sumOfAverages }));
  const broken = await chartCase(b, TEXT60, runner(b, [], { q: (q, step) => (step === 'other' ? { ...q, exclude: { dimension: q.exclude!.dimension, values: q.exclude!.values.slice(0, 49) } } : q) }));
  ok('NEGATIVE CONTROL: a broken exclude (keep 49) fails the Other cell', broken.problems.some((p) => p.includes('Other')), broken.problems.join(' | '));

  const reversed = await chartCase(b, TEXT60, runner(b, [], { a: (a) => ({ ...a, rows: a.rows.slice().reverse() }) }));
  ok('order comes from ranks, not arrival: reversed rows shape the same', show(reversed.sem) === show(r.sem) && reversed.problems.length === 0);
  const permuted = await chartCase(b, { ...TEXT60, metrics: ALL }, runner(b, [], { a: (a) => ({ columns: a.columns.slice().reverse(), rows: a.rows.map((row) => row.slice().reverse()) }) }));
  ok('…and a reply naming its columns in another order is read by name', permuted.problems.length === 0, permuted.problems.join(' | '));
  const missing = await chartCase(b, TEXT60, runner(b, [], { a: (a) => ({ columns: a.columns.slice(0, 1), rows: a.rows.map((row) => row.slice(0, 1)) }) }));
  ok('a reply without a metric it was asked for is refused (rowShape), never guessed at', !missing.sem.ok && missing.sem.code === 'rowShape');
  const midMonth = await chartCase(b, { name: 'm', metrics: ['revenue'], enc: { category: 'd', grain: 'month' } }, runner(b, [], { a: (a) => ({ ...a, rows: a.rows.map((row) => [typeof row[0] === 'string' ? row[0].replace(/-01$/, '-15') : row[0], row[1]]) }) }));
  ok('a date that is not its grain\'s first day is refused (rowShape), never relabelled', !midMonth.sem.ok && midMonth.sem.code === 'rowShape');

  const split = await chartCase(b, MATRIX.find((c) => c.name.startsWith('split: 60 categories × region (avg'))!);
  ok('counted: a split with "Other" is four questions', show(split.log.map((l) => l.step).sort()) === show(['chart', 'chart', 'other', 'seriesRanks']), show(split.log.map((l) => l.step)));
  ok('…the split\'s "Other" is the layer\'s, by series: one question excluding the 50', split.log.some((l) => l.step === 'other' && l.q.exclude?.values.length === 50 && show(l.q.dimensions) === '[{"name":"region"}]'));
  const bySum = await chartCase(b, MATRIX.find((c) => c.name.startsWith('split: 60 categories × region (revenue'))!);
  const sumIr = spec.fromVizEncoding({ category: 'many', series: 'region', values: [AS_COLUMN.revenue] }, [], b.env.columns, {});
  const splitLive = sumIr.ok ? await b.kit.live(sumIr.ir, b.typed) : sumIr;
  ok('PIN splitOtherLast, NEGATIVE CONTROL: unpinned, the split\'s order is not the SQL path\'s (there "Other" ranks by its total)',
    splitLive.ok && splitLive.kind === 'chart' && bySum.sem.ok && bySum.sem.kind === 'chart' && show(splitLive.chart.data.labels) !== show(bySum.sem.chart.data.labels)
      && show(sqlOrder(splitLive.chart.data.labels, true, true)) === show(bySum.sem.chart.data.labels));
  const date = await chartCase(b, { name: 'd', metrics: ['revenue'], enc: { category: 'd', grain: 'month' } });
  const kpiLog: Log = [];
  const k = spec.fromMetric({ column: 'amt', aggregation: 'avg' }, [], b.env.columns, {});
  if (k.ok) await es.evaluateSemantic(layerIr(k.ir, ['avg_amount']), b.env, runner(b, kpiLog));
  ok('counted: a date axis is one question; a KPI one', date.log.length === 1 && show(kpiLog.map((l) => l.step)) === '["metric"]');
}

async function refusals(b: Bench): Promise<void> {
  const binned = await chartCase(b, { name: 'bins', metrics: ['revenue'], enc: { category: 'amt' } });
  ok('number bins are refused, typed, with no question asked', !binned.sem.ok && binned.sem.code === 'bins' && binned.log.length === 0);
  const auto = await chartCase(b, { name: 'auto', metrics: ['revenue'], enc: { category: 'd' } });
  ok('an automatic grain is refused, typed, with no question asked', !auto.sem.ok && auto.sem.code === 'autoGrain' && auto.log.length === 0);
  const log: Log = [];
  const a = spec.fromAnswerSpec({ datasetId: b.x.did, category: 'region', measures: [AS_COLUMN.revenue], filters: [{ column: 'd', period: 'last_quarter' }], chartType: 'column', title: 'q' }, b.env.columns, {});
  const noLookups = a.ok ? await es.evaluateSemantic(layerIr(a.ir, ['revenue']), { ...b.env, caps: { lookups: false, binaryCompare: false } }, runner(b, log)) : a;
  ok('"last quarter" on a layer without lookups is refused (layerLookup), with no question asked', !noLookups.ok && noLookups.code === 'layerLookup' && log.length === 0);

  const binsLog: Log = [];
  const qb = spec.fromAnswerSpec({ datasetId: b.x.did, category: 'qty', measures: [AS_COLUMN.revenue], filters: [{ column: 'd', period: 'last_quarter' }], chartType: 'column', title: 'q' }, b.env.columns, {});
  const binsLatest = qb.ok ? await es.evaluateSemantic(layerIr(qb.ir, ['revenue']), b.env, runner(b, binsLog)) : qb;
  ok('a refusal costs no question: bins with "last quarter" asks not even the latest day', !binsLatest.ok && binsLatest.code === 'bins' && binsLog.length === 0, show(binsLog.map((l) => l.step)));

  // The dataset's base filter (cross-part check 14) is in every question: the same figures as the copy filtered.
  const north = F('region', '=', 'North');
  const based: Bench = { ...b, env: { ...b.env, base: [{ kind: 'compare', column: 'region', op: '=', value: 'North' }] } };
  const enc = { category: 'many', values: [AS_COLUMN.avg_amount] } as VizEncoding;
  const ext = await visualsIpc.vizDataFor(b.x.pid, b.x.did, enc, [north]);
  const ad = spec.fromVizEncoding(enc, [], b.env.columns, {});
  const baseLog: Log = [];
  const sem = ad.ok ? await es.evaluateSemantic(layerIr(ad.ir, ['avg_amount']), based.env, runner(based, baseLog)) : ad;
  const p = ext.ok && sem.ok && sem.kind === 'chart' ? cellsAgree(ext.data, sem.chart.data, ['avg_amount'], false) : ['no answer'];
  ok('a base filter reaches every question, "Other" too: the figures of the copy filtered', p.length === 0 && baseLog.length === 2 && baseLog.every((l) => show(l.q.where[0]) === show(based.env.base![0])), p.join(' | '));
  const unbased = ad.ok ? await es.evaluateSemantic(layerIr(ad.ir, ['avg_amount']), b.env, runner(b, [])) : ad;
  ok('NEGATIVE CONTROL: without it the layer answers wider', ext.ok && unbased.ok && unbased.kind === 'chart' && cellsAgree(ext.data, unbased.chart.data, ['avg_amount'], false).length > 0);
}

async function main(): Promise<void> {
  const x = await mx.setupExtract(ok);
  if (!x) return;
  const layout = fx.layout(fx.COLUMNS);
  const source = await fx.duckEngine.load(TABLE, layout, fx.warehouseCells(fx.COLUMNS, x.rows));
  const columns = mx.declared(fx.duckEngine, layout);
  const env: SemanticEnv = {
    dataset: 'Fixture', layer: 'Fake layer', columns,
    metrics: new Map(Object.keys(fake.FAKE_METRICS).map((m) => [m, { additive: fake.FAKE_ADDITIVE.has(m) }])),
    grains: new Map([['d', ck.DATE_GRAINS]]),
    caps: { lookups: true, binaryCompare: false },
  };
  const b: Bench = { x, env, typed: fx.env(source, columns), kit: mx.parityKit(x, fx.runDuck), ask: (log) => runner(b, log) };
  await pm.matrix(b, ok);
  await otherIsAsked(b);
  await refusals(b);
}

main()
  .catch((e) => ok('semantic parity suite threw', false, e && (e as Error).stack))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
