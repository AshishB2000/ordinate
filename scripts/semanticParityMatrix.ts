// The semantic-layer PARITY MATRIX (semantic layer part 7): b1's chart, KPI and answer cases, moved out of
// scripts/test-semanticParity.ts by c1 so the warehouse nightly asks a real Snowflake semantic view
// (scripts/warehouseLiveSnowflakeSemantic.ts) exactly what every `npm test` asks the fake layer. Helper; not a suite.
//
// Each case is asked of the extract door (`vizDataFor`, `computeCardMetric`, `computeCard`) and of `evaluateSemantic`
// over the bench's layer (`Bench.ask`). Labels, values and the "Other" note agree with the extract under `Object.is`
// (sum/avg within the documented 1e-13 only); the order is the SQL path's own (`evaluateLive` over the same rows in
// DuckDB), byte for byte. Divergences are pinned by name in PINS, never by a looser comparison.
//
// Requires its modules lazily-by-caller: the suite sets ORDINATE_LOCAL_DIR (or enters server mode) before requiring it.

import type { FilterStep } from '../src/data/transforms';
import type { VizEncoding, VizMeasure } from '../src/analysis/visuals';
import type { AnswerSpec } from '../src/ai/answerSpec';
import type { LiveIR, LiveMeasure } from '../src/engine/live/liveSpec';
import type { LiveOutcome } from '../src/engine/live/evaluate';
import type { SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';
import type { SemanticRunner, SemanticStep } from '../src/engine/live/semantic/evaluateSemantic';
import type { ChartLike } from './liveParityCompare';

const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');

const show = (v: unknown): string => JSON.stringify(v);
const { M, F } = mx;

/** The extract's twin of each layer metric: the same aggregation, as a chart measure. */
export const AS_COLUMN: Record<string, VizMeasure> = { revenue: M('amt', 'sum'), orders: M('many', 'count'), avg_amount: M('amt', 'avg'), max_amount: M('amt', 'max') };
export const TOLERANT = new Set(['revenue', 'avg_amount']);

/**
 * The named divergences (never a looser comparison):
 *   splitOtherLast  in a SPLIT chart "Other" ranks after the kept categories; the SQL path ranks it by its
 *                   total, which is a fifth question (evaluateSemantic's header). Values are unaffected.
 */
export const PINS = { splitOtherLast: true, relTol: cmp.REL_TOL };

export type Case = { name: string; metrics: string[]; enc: Partial<VizEncoding>; filters?: FilterStep[] };
export type Log = { q: SemanticQuery; step: SemanticStep; rows: number }[];

export interface Bench {
  x: import('./liveParityMatrix').Extract;
  env: SemanticEnv;
  typed: import('../src/engine/live/compile').CompileEnv;
  kit: ReturnType<typeof mx.parityKit>;
  /** The layer under test as a runner, every question logged in `log`. */
  ask: (log: Log) => SemanticRunner;
}

export const layerIr = (ir: LiveIR, metrics: string[]): LiveIR => ({ ...ir, measures: metrics.map((metric): LiveMeasure => ({ metric })) });

/** Cell by cell, label by label: Object.is, sum/avg metrics within the pinned tolerance. Series named by the extract (b2 relabels). */
export function cellsAgree(ext: ChartLike, sem: ChartLike, metrics: string[], split: boolean): string[] {
  const renamed = split ? sem : { ...sem, series: sem.series.map((s, i) => ({ ...s, name: ext.series[i]?.name ?? s.name })) };
  return cmp.compareCharts(ext, renamed, (k) => TOLERANT.has(split ? metrics[0] : metrics[k]), split);
}

/** The SQL path's order, with the pinned split difference applied. */
export function sqlOrder(live: string[], split: boolean, folded: boolean): string[] {
  if (!(split && folded && PINS.splitOtherLast)) return live;
  return [...live.filter((l) => l !== ck.OTHER_LABEL), ck.OTHER_LABEL];
}

export async function chartCase(b: Bench, c: Case, run?: SemanticRunner): Promise<{ problems: string[]; sem: LiveOutcome; log: Log }> {
  const log: Log = [];
  const enc = { ...c.enc, values: c.metrics.map((m) => AS_COLUMN[m]) } as VizEncoding;
  const filters = c.filters ?? [];
  const ext = await visualsIpc.vizDataFor(b.x.pid, b.x.did, enc, filters);
  const a = spec.fromVizEncoding(enc, filters, b.env.columns, {});
  if (!a.ok) return { problems: [`adapter refused: ${a.code}`], sem: a, log };
  const sem = await es.evaluateSemantic(layerIr(a.ir, c.metrics), b.env, run ?? b.ask(log));
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

export async function metricCase(b: Bench, metric: string, filters: FilterStep[]): Promise<string[]> {
  const col = AS_COLUMN[metric];
  const ext = await dashIpc.computeCardMetric(b.x.pid, b.x.did, { column: col.column, aggregation: col.aggregation as 'sum' }, filters);
  const a = spec.fromMetric({ column: col.column, aggregation: col.aggregation }, filters, b.env.columns, {});
  if (!a.ok) return [`adapter refused: ${a.code}`];
  const sem = await es.evaluateSemantic(layerIr(a.ir, [metric]), b.env, b.ask([]));
  if (!sem.ok || sem.kind !== 'metric') return [`semantic: ${show(sem)}`];
  return cmp.sameNumber(ext.value, sem.value, TOLERANT.has(metric)) ? [] : [`${show(ext.value)} vs ${show(sem.value)}`];
}

export async function answerCase(b: Bench, s: Omit<AnswerSpec, 'datasetId' | 'chartType' | 'title' | 'measures'> & { metrics: string[] }): Promise<string[]> {
  const asked: AnswerSpec = { ...s, datasetId: b.x.did, chartType: 'column', title: 'q', measures: s.metrics.map((m) => AS_COLUMN[m]) };
  delete (asked as { metrics?: unknown }).metrics;
  const built = await answers.computeCard(b.x.pid, asked);
  if ('ok' in built) return [`extract failed: ${built.reason}`];
  const a = spec.fromAnswerSpec(asked, b.env.columns, {});
  if (!a.ok) return [`adapter refused: ${a.code}`];
  const sem = await es.evaluateSemantic(layerIr(a.ir, s.metrics), b.env, b.ask([]));
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

export const ALL = ['revenue', 'orders', 'avg_amount', 'max_amount'];
export const TEXT60: Case = { name: 'text, 60 categories × avg_amount', metrics: ['avg_amount'], enc: { category: 'many' } };
export const MATRIX: Case[] = [
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
export const FILTERS: FilterStep[][] = [
  [F('region', '=', 'North')], [F('region', '!=', 'North')], [F('cat', 'in', undefined, { values: ['Alpha', '007', null] })],
  [F('cat', 'not in', undefined, { values: ['Alpha', ''] })], [F('d', 'period', undefined, { period: { preset: 'custom', from: '2024-03-31', to: '2024-12-31' } })],
  [F('cat', 'is_empty')], [F('cat', 'not_empty')], [F('cat', 'contains', 'a')], [F('amt', '>', 0)], [F('d', '>', '2024-06-30')],
];

export async function matrix(b: Bench, ok: (label: string, cond: boolean, extra?: unknown) => void): Promise<void> {
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
