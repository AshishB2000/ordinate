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
import type { FilterStep } from '../src/data/transforms';
import type { VizEncoding, VizMeasure } from '../src/analysis/visuals';
import type { AnswerSpec } from '../src/ai/answerSpec';
import type { LiveIR, LiveMeasure } from '../src/engine/live/liveSpec';
import type { LiveOutcome } from '../src/engine/live/evaluate';
import type { SemanticAnswer, SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';
import type { SemanticRunner, SemanticStep } from '../src/engine/live/semantic/evaluateSemantic';
import type { ChartLike } from './liveParityCompare';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-semparity-'));
process.env.ORDINATE_LOCAL_DIR = tmp;
process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, as test-liveParity pins it

const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const fake: typeof import('./semanticFake') = require('./semanticFake');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');

const show = (v: unknown): string => JSON.stringify(v);
const { M, F } = mx;
const TABLE = 'semantic_fixture';

/** The extract's twin of each layer metric: the same aggregation, as a chart measure. */
const AS_COLUMN: Record<string, VizMeasure> = { revenue: M('amt', 'sum'), orders: M('many', 'count'), avg_amount: M('amt', 'avg'), max_amount: M('amt', 'max') };
const TOLERANT = new Set(['revenue', 'avg_amount']);

/**
 * The named divergences (never a looser comparison):
 *   splitOtherLast  in a SPLIT chart "Other" ranks after the kept categories; the SQL path ranks it by its
 *                   total, which is a fifth question (evaluateSemantic's header). Values are unaffected.
 */
const PINS = { splitOtherLast: true, relTol: cmp.REL_TOL };

type Case = { name: string; metrics: string[]; enc: Partial<VizEncoding>; filters?: FilterStep[] };
type Log = { q: SemanticQuery; step: SemanticStep; rows: number }[];

interface Bench {
  x: import('./liveParityMatrix').Extract;
  env: SemanticEnv;
  typed: import('../src/engine/live/compile').CompileEnv;
  kit: ReturnType<typeof mx.parityKit>;
}

/** The fake as a runner, every question logged; `tamper` may change a question or its answer. */
function runner(b: Bench, log: Log, tamper: { q?: (q: SemanticQuery, step: SemanticStep) => SemanticQuery; a?: (a: SemanticAnswer) => SemanticAnswer } = {}): SemanticRunner {
  return async (q, step) => {
    const asked = tamper.q ? tamper.q(q, step) : q;
    const a = await fake.runFake(TABLE, b.env.columns, asked);
    log.push({ q: asked, step, rows: a.rows.length });
    return tamper.a ? tamper.a(a) : a;
  };
}

const layerIr = (ir: LiveIR, metrics: string[]): LiveIR => ({ ...ir, measures: metrics.map((metric): LiveMeasure => ({ metric })) });

/** Cell by cell, label by label: Object.is, sum/avg metrics within the pinned tolerance. Series named by the extract (b2 relabels). */
function cellsAgree(ext: ChartLike, sem: ChartLike, metrics: string[], split: boolean): string[] {
  const renamed = split ? sem : { ...sem, series: sem.series.map((s, i) => ({ ...s, name: ext.series[i]?.name ?? s.name })) };
  return cmp.compareCharts(ext, renamed, (k) => TOLERANT.has(split ? metrics[0] : metrics[k]), split);
}

/** The SQL path's order, with the pinned split difference applied. */
function sqlOrder(live: string[], split: boolean, folded: boolean): string[] {
  if (!(split && folded && PINS.splitOtherLast)) return live;
  return [...live.filter((l) => l !== ck.OTHER_LABEL), ck.OTHER_LABEL];
}

async function chartCase(b: Bench, c: Case, run?: SemanticRunner): Promise<{ problems: string[]; sem: LiveOutcome; log: Log }> {
  const log: Log = [];
  const enc = { ...c.enc, values: c.metrics.map((m) => AS_COLUMN[m]) } as VizEncoding;
  const filters = c.filters ?? [];
  const ext = await visualsIpc.vizDataFor(b.x.pid, b.x.did, enc, filters);
  const a = spec.fromVizEncoding(enc, filters, b.env.columns, {});
  if (!a.ok) return { problems: [`adapter refused: ${a.code}`], sem: a, log };
  const sem = await es.evaluateSemantic(layerIr(a.ir, c.metrics), b.env, run ?? runner(b, log));
  if (!ext.ok) return { problems: [`extract failed: ${ext.error}`], sem, log };
  if (!sem.ok || sem.kind !== 'chart') return { problems: [`semantic: ${show(sem)}`], sem, log };
  const problems: string[] = [];
  const split = !!c.enc.series;
  problems.push(...cellsAgree(ext.data, sem.chart.data, c.metrics, split));
  if (show(ext.category) !== show(sem.chart.category)) problems.push(`category ${show(ext.category)} vs ${show(sem.chart.category)}`);
  if (show(ext.warnings) !== show(a.warnings.concat(sem.warnings))) problems.push(`warnings ${show(ext.warnings)} vs ${show(sem.warnings)}`);
  const live = await b.kit.live(a.ir, b.typed);
  if (!live.ok || live.kind !== 'chart') return { problems: problems.concat(`sql path: ${show(live)}`), sem, log };
  const want = sqlOrder(live.chart.data.labels, split, !!sem.chart.category.note);
  if (show(want) !== show(sem.chart.data.labels)) problems.push(`labels ${show(sem.chart.data.labels.slice(0, 6))}… are not the SQL path's ${show(want.slice(0, 6))}…`);
  return { problems, sem, log };
}

async function metricCase(b: Bench, metric: string, filters: FilterStep[]): Promise<string[]> {
  const col = AS_COLUMN[metric];
  const ext = await dashIpc.computeCardMetric(b.x.pid, b.x.did, { column: col.column, aggregation: col.aggregation as 'sum' }, filters);
  const a = spec.fromMetric({ column: col.column, aggregation: col.aggregation }, filters, b.env.columns, {});
  if (!a.ok) return [`adapter refused: ${a.code}`];
  const sem = await es.evaluateSemantic(layerIr(a.ir, [metric]), b.env, runner(b, []));
  if (!sem.ok || sem.kind !== 'metric') return [`semantic: ${show(sem)}`];
  return cmp.sameNumber(ext.value, sem.value, TOLERANT.has(metric)) ? [] : [`${show(ext.value)} vs ${show(sem.value)}`];
}

async function answerCase(b: Bench, s: Omit<AnswerSpec, 'datasetId' | 'chartType' | 'title' | 'measures'> & { metrics: string[] }): Promise<string[]> {
  const asked: AnswerSpec = { ...s, datasetId: b.x.did, chartType: 'column', title: 'q', measures: s.metrics.map((m) => AS_COLUMN[m]) };
  delete (asked as { metrics?: unknown }).metrics;
  const built = await answers.computeCard(b.x.pid, asked);
  if ('ok' in built) return [`extract failed: ${built.reason}`];
  const a = spec.fromAnswerSpec(asked, b.env.columns, {});
  if (!a.ok) return [`adapter refused: ${a.code}`];
  const sem = await es.evaluateSemantic(layerIr(a.ir, s.metrics), b.env, runner(b, []));
  if (!sem.ok || sem.kind !== 'chart') return [`semantic: ${show(sem)}`];
  // A top N: every row is the extract's own figure for that category, from its whole ranking (a split ranks by the
  // category total here, by the first series there: liveParityPins), and unsplit the N values are the extract's N.
  let ext: ChartLike = built.card.data;
  if (s.top !== undefined) {
    const whole = await answers.computeCard(b.x.pid, { ...asked, top: undefined });
    if ('ok' in whole) return ['no whole ranking'];
    const at = sem.chart.data.labels.map((l) => whole.card.data.labels.indexOf(l));
    ext = { labels: at.map((i) => whole.card.data.labels[i]), series: whole.card.data.series.map((v) => ({ name: v.name, values: at.map((i) => v.values[i]) })) };
  }
  const problems = cellsAgree(ext, sem.chart.data, s.metrics, !!s.series);
  if (s.top !== undefined && !s.series) {
    const sorted = (xs: (number | null)[]): (number | null)[] => xs.slice().sort((p, q) => (p ?? -Infinity) - (q ?? -Infinity));
    const [e, v] = [sorted(built.card.data.series[0].values), sorted(sem.chart.data.series[0].values)];
    if (e.length !== v.length || e.some((n, i) => !cmp.sameNumber(n, v[i], TOLERANT.has(s.metrics[0])))) problems.push(`top-N values ${show(e)} vs ${show(v)}`);
  }
  const notes = a.warnings.concat(sem.warnings, sem.chart.category.note ? [sem.chart.category.note] : []);
  if (show(built.card.notes) !== show(notes)) problems.push(`notes ${show(built.card.notes)} vs ${show(notes)}`);
  const live = await b.kit.live(a.ir, b.typed);
  if (!live.ok || live.kind !== 'chart') return problems.concat(`sql path: ${show(live)}`);
  if (show(live.periodRanges ?? null) !== show(sem.periodRanges ?? null)) problems.push(`periods ${show(live.periodRanges)} vs ${show(sem.periodRanges)}`);
  if (!s.series && show(live.chart.data.labels) !== show(sem.chart.data.labels)) problems.push(`labels ${show(sem.chart.data.labels)} vs the SQL path's ${show(live.chart.data.labels)}`);
  return problems;
}

const ALL = ['revenue', 'orders', 'avg_amount', 'max_amount'];
const TEXT60: Case = { name: 'text, 60 categories × avg_amount', metrics: ['avg_amount'], enc: { category: 'many' } };
const MATRIX: Case[] = [
  ...ALL.map((m) => ({ name: `text, 60 categories × ${m}`, metrics: [m], enc: { category: 'many' } })),
  { name: 'text, 60 categories × all four', metrics: ALL, enc: { category: 'many' } },
  { name: 'text with blanks, a BOM, 007 and 7 × revenue', metrics: ['revenue', 'orders'], enc: { category: 'cat' } },
  { name: 'text ids past 15 digits × orders', metrics: ['orders'], enc: { category: 'bigid' } },
  ...(['day', 'week', 'month', 'quarter', 'year'] as const).flatMap((g) => ['revenue', 'avg_amount'].map((m) => ({ name: `date by ${g} × ${m}`, metrics: [m], enc: { category: 'd', grain: g } }))),
  { name: 'split: 60 categories × region (avg_amount, folded)', metrics: ['avg_amount'], enc: { category: 'many', series: 'region' } },
  { name: 'split: 60 categories × region (revenue, folded)', metrics: ['revenue'], enc: { category: 'many', series: 'region' } },
  { name: 'split: cat × tier, a number split', metrics: ['max_amount'], enc: { category: 'cat', series: 'tier' } },
  { name: 'split: date by quarter × region', metrics: ['avg_amount'], enc: { category: 'd', grain: 'quarter', series: 'region' } },
];
const FILTERS: FilterStep[][] = [
  [F('region', '=', 'North')], [F('region', '!=', 'North')], [F('cat', 'in', undefined, { values: ['Alpha', '007', null] })],
  [F('cat', 'not in', undefined, { values: ['Alpha', ''] })], [F('d', 'period', undefined, { period: { preset: 'custom', from: '2024-03-31', to: '2024-12-31' } })],
  [F('cat', 'is_empty')], [F('cat', 'not_empty')], [F('cat', 'contains', 'a')], [F('amt', '>', 0)], [F('d', '>', '2024-06-30')],
];

async function matrix(b: Bench): Promise<void> {
  for (const c of MATRIX) {
    const r = await chartCase(b, c);
    ok(`${c.name}: labels, every cell (Object.is; sum/avg within ${PINS.relTol}), the Other note and the SQL path's order agree`, r.problems.length === 0, r.problems.join(' | '));
  }
  let bad = 0;
  for (const f of FILTERS) {
    const p = [
      ...(await chartCase(b, { name: 'f', metrics: ['revenue'], enc: { category: 'many' }, filters: f })).problems,
      ...(await chartCase(b, { name: 'f', metrics: ['avg_amount'], enc: { category: 'region' }, filters: f })).problems,
      ...(await metricCase(b, 'revenue', f)), ...(await metricCase(b, 'avg_amount', f)),
    ];
    if (p.length && ++bad <= 6) ok(`filter ${show(f)}`, false, p.join(' | '));
  }
  ok(`every filter (${FILTERS.length}: =, !=, in, not in, a range, empty, not empty, contains, >) agrees on two charts and two KPIs`, bad === 0);
  const kpis = (await Promise.all(ALL.map((m) => metricCase(b, m, [])))).flat();
  ok('a KPI of each metric agrees with computeCardMetric', kpis.length === 0, kpis.join(' | '));
  const ANSWERS = [
    { metrics: ['revenue'], category: 'many', filters: [], top: 5 },
    { metrics: ['avg_amount'], category: 'cat', filters: [], top: 5 },
    { metrics: ['orders', 'revenue'], category: 'region', filters: [{ column: 'region', op: '!=', value: 'West' }] },
    { metrics: ['revenue'], category: 'many', series: 'region', filters: [], top: 5 },
    { metrics: ['avg_amount'], category: 'd', grain: 'month' as const, filters: [{ column: 'd', period: 'last_quarter' }] },
    { metrics: ['revenue'], category: 'region', filters: [{ column: 'd', period: 'last_year', yearsBack: 1 }] },
  ] as Parameters<typeof answerCase>[1][];
  for (const s of ANSWERS) {
    const p = await answerCase(b, s);
    ok(`answer ${show({ ...s, filters: s.filters.length })}: agrees with computeCard (ranked, cut, its notes and periods)`, p.length === 0, p.join(' | '));
  }
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
  const b: Bench = { x, env, typed: fx.env(source, columns), kit: mx.parityKit(x, fx.runDuck) };
  await matrix(b);
  await otherIsAsked(b);
  await refusals(b);
}

main()
  .catch((e) => ok('semantic parity suite threw', false, e && (e as Error).stack))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
