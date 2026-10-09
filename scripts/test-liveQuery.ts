// The live executor (docs/live-data/00-plan.md L2.3), end to end in server
// mode: a Live dataset's record → its connection and secrets → compile →
// cache → budget → the fake warehouse's `runBound` (DuckDB, the L2.2 bench)
// → the shape the resident layer returns, dated.
//
//   parity     charts, KPIs and answers through the executor equal L2.2's
//              direct live path EXACTLY and the extract within its documented
//              float tolerance (the parity suite's own comparators)
//   cache      a hit inside the age (no warehouse call — the fake's spy), a
//              miss at it (fake clock); an epoch bump misses with NO
//              invalidation (another pod only sees the record); age 0 always
//              asks, yet 5 identical concurrent asks make ONE call; the
//              period resolver's MAX() is shared by two answers
//   failure    a warehouse error serves the cached answer labelled stale; with
//              nothing cached a typed error — NEGATIVE CONTROL: never a chart
//   R-L6       SQL, host, table and secret planted in a warehouse error (and in
//              a thrown one) reach no reply; the secret reaches no log line
//   R-L5       two orgs holding the SAME project, dataset and connection ids
//              (the import case) never share a cached result
//   /metrics   the live:duckdb outcomes, as the trace counted them
//   measured   a cache hit vs a warehouse call on the fake
//
//   npm run build:ts && node scripts/test-liveQuery.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { VizEncoding, VizMeasure } from '../src/analysis/visuals';
import type { FilterStep } from '../src/data/transforms';
import type { AnswerSpec } from '../src/ai/answerSpec';
import * as H from './liveQueryHarness';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const ev: typeof import('../src/engine/live/evaluate') = require('../src/engine/live/evaluate');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const metrics: typeof import('../src/server/metrics') = require('../src/server/metrics');

const { lq, fake, queryCache, ORG_A, ORG_B } = H;
const M = (column: string, aggregation: VizMeasure['aggregation']): VizMeasure => ({ column, aggregation });
const F = (column: string, op: FilterStep['op'], value?: unknown, extra: Partial<FilterStep> = {}): FilterStep =>
  ({ type: 'filter', column, op, ...(value === undefined ? {} : { value }), ...extra } as FilterStep);
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x));
const TOLERANT = new Set(['sum', 'avg', 'none']);
const ENV = H.fx.env({ kind: 'table', parts: ['live_typed'] });
let clock = Date.UTC(2025, 2, 15, 10, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

async function parity(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const CHARTS: [VizEncoding, FilterStep[]][] = [
    [{ category: 'cat', values: [M('amt', 'sum')] }, []],
    [{ category: 'many', values: [M('cat', 'count'), M('amt', 'avg')] }, []],
    [{ category: 'd', grain: 'month', values: [M('amt', 'avg')] }, [F('region', 'in', undefined, { values: ['North', 'South'] })]],
    [{ category: 'qty', bins: 20, values: [M('qty', 'max')] }, [F('cat', 'not_empty')]],
    [{ category: 'region', series: 'tier', values: [M('amt', 'sum')] }, []],
    [{ category: 'd', values: [M('amt', 'sum')] }, [F('d', 'period', undefined, { period: { preset: 'last_n_months', n: 6 } }), F('nope', '=', 'x')]],
  ];
  for (const [enc, filters] of CHARTS) {
    const label = `chart ${show(enc)} ${show(filters)}`;
    const ext = await visualsIpc.vizDataFor(P, s.extractId, enc, filters);
    const live = await lq.liveVizData(P, s.liveId, enc, filters);
    const a = spec.fromVizEncoding(enc, filters, H.fx.COLUMNS, {});
    const direct = a.ok ? await ev.evaluateLive(a.ir, ENV, H.fx.runDuck) : null;
    if (!ext.ok || !live.ok || !direct || !direct.ok || direct.kind !== 'chart') {
      ok(`${label}: all three paths answer`, false, show({ ext, live, direct }).slice(0, 300));
      continue;
    }
    ok(`${label}: equals L2.2's direct live path exactly`, show(live.data) === show(direct.chart.data) && show(live.category) === show(direct.chart.category));
    const aggs = enc.values.map((v) => v.aggregation);
    const problems = cmp.compareCharts(ext.data, live.data, (k) => TOLERANT.has(enc.series ? aggs[0] : aggs[k]), !!enc.series);
    ok(`${label}: equals the extract (labels, values; sum/avg within ${cmp.REL_TOL})`, problems.length === 0, problems.join(' | '));
    ok(`${label}: same warnings, category, shape`, show(ext.warnings) === show(live.warnings) && ext.category?.kind === live.category.kind
      && ext.category?.grain === live.category.grain && ext.category?.note === live.category.note && ext.recommendedShape === live.recommendedShape,
    show([ext.warnings, live.warnings, ext.category, live.category]));
    ok(`${label}: dated live`, live.asOf.mode === 'live' && Number.isFinite(Date.parse(live.asOf.at)));
  }
  const KPIS: [{ column: string; aggregation: import('../src/analysis/metricValue').MetricAggregation }, FilterStep[]][] = [
    [{ column: 'amt', aggregation: 'sum' }, []],
    [{ column: 'cat', aggregation: 'count' }, [F('cat', 'contains', 'a')]],
    [{ column: 'qty', aggregation: 'avg' }, [F('d', '>=', '2024-06-30')]],
  ];
  for (const [m, filters] of KPIS) {
    const ext = await dashIpc.computeCardMetric(P, s.extractId, m, filters);
    const live = await lq.liveMetric(P, s.liveId, m, filters);
    ok(`KPI ${m.aggregation}(${m.column}) ${show(filters)}: equals the extract`, live.ok && cmp.sameNumber(ext.value, live.value, TOLERANT.has(m.aggregation)), show([ext, live]));
  }
  const ANSWERS: AnswerSpec[] = [
    { datasetId: s.liveId, category: 'region', measures: [M('amt', 'sum')], filters: [], chartType: 'bar', title: 'q', top: 3 },
    { datasetId: s.liveId, category: 'd', measures: [M('cat', 'count')], filters: [{ column: 'd', period: 'last_quarter' }], chartType: 'line', title: 'q' },
    { datasetId: s.liveId, category: 'many', measures: [M('amt', 'avg')], filters: [{ column: 'region', op: '=', value: 'North' }], chartType: 'bar', title: 'q' },
    { datasetId: s.liveId, category: 'cat', measures: [M('qty', 'sum')], filters: [{ column: 'tier', op: '>=', value: 2 }, { column: 'd', period: 'last_year' }], chartType: 'bar', title: 'q', top: 5 },
  ];
  for (const a of ANSWERS) {
    const built = await answers.computeCard(P, { ...a, datasetId: s.extractId });
    const live = await lq.liveAnswer(P, a);
    if ('ok' in built || !live.ok) {
      ok(`answer ${show(a)}: both paths answer`, false, show({ built, live }).slice(0, 300));
      continue;
    }
    const problems = cmp.compareCharts(built.card.data, live.data, () => TOLERANT.has(a.measures[0].aggregation), false);
    ok(`answer ${a.category} ${show(a.filters)}: equals computeCard's chart, notes and period labels`,
      problems.length === 0 && show(built.card.notes) === show(live.notes) && show(built.card.filterLabels) === show(live.filterLabels),
      problems.concat(show([built.card.notes, live.notes, built.card.filterLabels, live.filterLabels])).join(' | '));
  }
}

async function cache(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const D = s.liveId;
  const kpi = { column: 'amt', aggregation: 'sum' } as const;
  queryCache.clear();
  H.fakeMod.resetFake();
  const t0 = clock;
  const r1 = await lq.liveMetric(P, D, kpi, []);
  const r2 = await lq.liveMetric(P, D, kpi, []);
  ok('cache: the first ask goes to the warehouse, dated now, not cached', r1.ok && fake.calls.length === 1 && r1.asOf.at === iso(t0) && !r1.asOf.cached, show(r1));
  ok('cache: the second is a HIT — no warehouse call, the same figure and time, `cached`', r2.ok && r1.ok && fake.calls.length === 1 && r2.value === r1.value
    && r2.asOf.at === iso(t0) && r2.asOf.cached === true);
  clock += 299_999;
  const r3 = await lq.liveMetric(P, D, kpi, []);
  ok('cache: still a hit 1 ms before the age (300 s)', r3.ok && fake.calls.length === 1);
  clock += 1;
  const r4 = await lq.liveMetric(P, D, kpi, []);
  ok('cache: a MISS at the age — asked again, dated anew', r4.ok && fake.calls.length === 2 && r4.asOf.at === iso(clock) && !r4.asOf.cached);

  // The epoch moves the KEY. No invalidation here: a pod that only re-reads the record must miss too.
  const entries = queryCache.stats().entries;
  await H.as(ORG_A, () => H.liveDataset.bumpEpoch(P, D));
  ok('epoch: bumping it dropped no cache entry (the key, not an invalidation, does the work)', queryCache.stats().entries === entries);
  const r5 = await lq.liveMetric(P, D, kpi, []);
  ok('epoch: …and the next ask is a miss inside the age', r5.ok && fake.calls.length === 3);

  // maxCacheAgeSec 0: always asked — but asked ONCE however many ask together.
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 0));
  await lq.liveMetric(P, D, kpi, []);
  const r6 = await lq.liveMetric(P, D, kpi, []);
  ok('age 0: two asks in a row are two warehouse calls, never `cached`', fake.calls.length === 5 && r6.ok && !r6.asOf.cached);
  const before = H.liveCounts();
  fake.hook = async () => { await new Promise((r) => setTimeout(r, 40)); return undefined; };
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => H.as(ORG_A, () => lq.liveMetric(P, D, kpi, []))));
  fake.hook = null;
  const after = H.liveCounts();
  ok('age 0: five identical concurrent asks share ONE warehouse call', fake.calls.length === 6 && five.every((r) => r.ok && r1.ok && r.value === r1.value), String(fake.calls.length));
  ok('age 0: …counted as 1 warehouse + 4 hits', after.warehouse - before.warehouse === 1 && after.hit - before.hit === 4);
  ok('flights: none left in the air', lq.flightsInAir() === 0);
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 300));

  // The period resolver's MAX() is cached under its own statement: two answers, one MAX().
  H.fakeMod.resetFake();
  const quarter = [{ column: 'd', period: 'last_quarter' as const }];
  await lq.liveAnswer(P, { datasetId: D, category: 'region', measures: [M('amt', 'sum')], filters: quarter, chartType: 'bar', title: 'a' });
  await lq.liveAnswer(P, { datasetId: D, category: 'cat', measures: [M('qty', 'max')], filters: quarter, chartType: 'bar', title: 'b' });
  const maxes = fake.calls.filter((c) => /AS o_l0/.test(c.sql)).length;
  ok('latest: two answers over one period column ask MAX() once (cached the same way)', maxes === 1 && fake.calls.length === 3, `${maxes} of ${fake.calls.length}`);
}

async function failures(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const enc: VizEncoding = { category: 'region', values: [M('amt', 'sum')] };
  queryCache.clear();
  H.fakeMod.resetFake();
  const at = clock;
  const good = await lq.liveVizData(P, s.liveId, enc, []);
  clock += 3_600_000; // an hour on: far past the 5-minute age
  fake.hook = async () => ({ ok: false, error: 'warehouse suspended' });
  const before = H.liveCounts();
  const stale = await H.capturingWarn(() => lq.liveVizData(P, s.liveId, enc, []));
  ok('stale: a warehouse error serves the cached answer, labelled stale, dated when it was fetched', stale.value.ok && good.ok
    && show(stale.value.data) === show(good.data) && stale.value.asOf.stale === true && stale.value.asOf.cached === true && stale.value.asOf.at === iso(at), show(stale.value).slice(0, 200));
  ok('stale: the warehouse was asked first (the age had passed), and the reason went to the log', fake.calls.length === 2 && stale.lines.some((l) => l.includes('warehouse suspended')));
  const none = await H.capturingWarn(() => lq.liveVizData(P, s.liveId, { category: 'cat', values: [M('amt', 'min')] }, []));
  const after = H.liveCounts();
  ok('no cache: a typed error, in the catalog\'s sentence', !none.value.ok && none.value.code === 'live_failed' && none.value.error === H.msg.liveWarehouseFailed(), show(none.value));
  ok('NEGATIVE CONTROL: …never an empty chart — no data, no labels, no series', !none.value.ok && !('data' in none.value) && !show(none.value).includes('labels'));
  ok('trace: one stale, one failed (warned once)', after.stale - before.stale === 1 && after.failed - before.failed === 1
    && none.lines.some((l) => l.includes('[live] live:duckdb: the warehouse did not answer')), show(none.lines));
  fake.hook = null;

  // R-L6: SQL text, a host, a table name and the connection's secret planted in the warehouse's words.
  const live = await H.as(ORG_A, () => H.liveOver(P, { sql: 'SELECT * FROM live_typed WHERE \'canary_sql_8c41\' <> \'\'' }, H.fx.COLUMNS));
  const plant = (sql: string, password: string): string =>
    `SQL compilation error at canary-host-31f7.internal.example:443 (password=${password}): Object "CANARY_SCHEMA"."CANARY_TABLE_8C41" does not exist in ${sql}`;
  const replies: string[] = [];
  const logs: string[] = [];
  for (const thrown of [false, true]) {
    fake.hook = async (call, ctx) => {
      const text = plant(call.sql, String(ctx.secrets.password));
      if (thrown) throw new Error(text);
      return { ok: false, error: text };
    };
    const r = await H.capturingWarn(() => lq.liveVizData(P, live.liveId, { category: 'cat', values: [M('qty', 'sum')] }, [F('region', '=', 'North')]));
    replies.push(show(r.value));
    logs.push(...r.lines);
  }
  fake.hook = null;
  const leaked = replies.join('\n');
  ok('R-L6: the planted error really carried the secret, the SQL, the host and the table (the canary is live)', fake.calls.length >= 2 && logs.join('\n').includes('canary-host-31f7'));
  ok('R-L6: no reply carries the SQL, a host, a table name or the secret — returned or thrown',
    !/canary|internal\.example|SELECT|live_typed/i.test(leaked) && !leaked.includes(H.SECRET_CANARY) && replies.every((x) => x.includes('live_failed')), leaked.slice(0, 300));
  ok('R-L6: the secret reaches no log line (safeError)', !logs.join('\n').includes(H.SECRET_CANARY) && logs.join('\n').includes('***'), logs.join('\n'));
  const fine = await lq.liveVizData(P, live.liveId, { category: 'region', values: [M('qty', 'sum')] }, []);
  ok('R-L6: a GOOD reply over a defining query carries none of it either', fine.ok && !/canary|SELECT|live_typed/i.test(show(fine)));

  // Refused and unavailable: typed, no warehouse call.
  H.fakeMod.resetFake();
  const pivot = await lq.liveVizData(P, s.liveId, { category: 'region', values: [M('amt', 'sum')], pivot: { rows: ['region'], columns: [], values: [] } } as unknown as VizEncoding, []);
  ok('refused: a pivot is a typed refusal with the compiler\'s code, no call', !pivot.ok && pivot.code === 'live_refused' && pivot.reason === 'pivot' && fake.calls.length === 0, show(pivot));
  const notLive = await lq.liveVizData(P, s.extractId, enc, []);
  ok('unavailable: an extract dataset is refused, typed', !notLive.ok && notLive.code === 'live_unavailable' && notLive.error === H.msg.liveNotLive());
  const gone = await lq.liveMetric(P, '00000000-0000-4000-8000-000000000000', { column: 'amt', aggregation: 'sum' }, []);
  ok('unavailable: a missing dataset too', !gone.ok && gone.code === 'live_unavailable' && gone.error === H.msg.liveDatasetMissing());
}

async function twoOrgs(a: H.OrgSetup): Promise<void> {
  // The import case: org B holds a copy of org A's records — same project, dataset and connection ids.
  const orgDir = (o: string): string => path.join(H.DATA, 'orgs', o);
  await H.warehouseExec(ORG_A, 'CREATE OR REPLACE TABLE rl5 (amt DOUBLE); INSERT INTO rl5 VALUES (10)');
  await H.warehouseExec(ORG_B, 'CREATE OR REPLACE TABLE rl5 (amt DOUBLE); INSERT INTO rl5 VALUES (20)');
  const ids = await H.as(ORG_A, () => H.liveOver(a.projectId, { table: 'rl5' }, [{ name: 'amt', type: 'number' }]));
  fs.cpSync(orgDir('acme'), orgDir('globex'), { recursive: true, filter: (src: string) => !src.split(path.sep).includes('temp') });
  const metaA = await H.as(ORG_A, () => H.datasets.getDatasetMeta(a.projectId, ids.liveId));
  const metaB = await H.as(ORG_B, () => H.datasets.getDatasetMeta(a.projectId, ids.liveId));
  ok('R-L5 precondition: both orgs hold the SAME project id, dataset id, epoch, schema time and origin', !!metaA && !!metaB
    && show([metaA.live, metaA.origin, metaA.columns]) === show([metaB.live, metaB.origin, metaB.columns]));
  H.fakeMod.resetFake();
  const kpi = { column: 'amt', aggregation: 'sum' } as const;
  const a1 = await H.as(ORG_A, () => lq.liveMetric(a.projectId, ids.liveId, kpi, []));
  const a2 = await H.as(ORG_A, () => lq.liveMetric(a.projectId, ids.liveId, kpi, []));
  const b1 = await H.as(ORG_B, () => lq.liveMetric(a.projectId, ids.liveId, kpi, []));
  const b2 = await H.as(ORG_B, () => lq.liveMetric(a.projectId, ids.liveId, kpi, []));
  ok('R-L5: org A answers from ITS warehouse, and its second ask is a hit', a1.ok && a1.value === 10 && a2.ok && a2.asOf.cached === true);
  ok('R-L5: org B is NOT served A\'s cached 10 — it asks its own warehouse (20)', b1.ok && b1.value === 20 && !b1.asOf.cached && fake.calls.length === 2, show([b1, fake.calls.length]));
  ok('R-L5: …and B\'s own repeat is a hit on B\'s answer', b2.ok && b2.value === 20 && b2.asOf.cached === true);
}

async function measure(s: H.OrgSetup): Promise<void> {
  const kpi = { column: 'amt', aggregation: 'avg' } as const;
  const median = (xs: number[]): number => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  queryCache.setClockForTest(null);
  await lq.liveMetric(s.projectId, s.liveId, kpi, []);
  const hits: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    const t = performance.now();
    await lq.liveMetric(s.projectId, s.liveId, kpi, []);
    hits.push(performance.now() - t);
  }
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(s.projectId, s.liveId, 0));
  const calls: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    const t = performance.now();
    await lq.liveMetric(s.projectId, s.liveId, kpi, []);
    calls.push(performance.now() - t);
  }
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(s.projectId, s.liveId, 300));
  console.log(`  measured (fake warehouse, ${H.fx.fixtureRows().length} rows): cache hit median ${median(hits).toFixed(3)} ms (n=200), ` +
    `warehouse call median ${median(calls).toFixed(3)} ms (n=40)`);
  ok('measured: a hit is cheaper than a warehouse call', median(hits) < median(calls));
}

async function main(): Promise<void> {
  queryCache.setClockForTest(() => clock);
  H.trace.reset();
  const a = await H.setupOrg(ORG_A);
  await H.as(ORG_A, () => parity(a));
  await H.as(ORG_A, () => cache(a));
  await H.as(ORG_A, () => failures(a));
  await twoOrgs(a);

  const counts = H.liveCounts();
  const text = metrics.metricsText();
  const line = (o: string): string => `ordinate_resident_calls_total{op="live:duckdb",outcome="${o}"} ${(counts as unknown as Record<string, number>)[o]}`;
  ok('/metrics: every live outcome is exported with the trace\'s count', ['hit', 'warehouse', 'stale', 'refused', 'failed', 'cancelled'].every((o) => text.includes(line(o))),
    text.split('\n').filter((l) => l.includes('live:')).join(' | '));
  ok('/metrics: the outcomes this suite caused are all non-zero but cancelled', counts.hit > 0 && counts.warehouse > 0 && counts.stale > 0 && counts.refused > 0 && counts.failed > 0);
  await H.as(ORG_A, () => measure(a));
}

main()
  .catch((e) => ok('live executor suite threw', false, e && (e as Error).stack))
  .finally(() => {
    queryCache.setClockForTest(null);
    H.cleanup();
    finish();
  });
