// Self-check for "Explain this change" from a point on a chart
// (src/analysis/driverPoint.ts, src/ipc/driversPoint.ts) — the request the
// SERVER builds from a tile and a clicked bucket.
//
//   1. PURE (pointPlan): for every grain the clicked bucket is compared with
//      the bucket before it IN TIME — whatever order the labels arrived in and
//      across a gap; the latest bucket is the default; the baselines are the
//      earlier buckets of the same chart, "same period last year" named when
//      the chart reaches it; a split chart's series becomes a drill step, a
//      multi-measure chart's series picks the measure; the chart's filters ride
//      through untouched; every refusal has its code and its catalog sentence.
//   2. REAL HTTP (drivers:explainPoint): THE DIFFERENTIAL — the two figures the
//      panel's header shows are the two points on the chart, `Object.is`, where
//      the chart's come from `visual:data` and the panel's from the drivers
//      engine: for every grain, under a sheet filter, for one series of a split
//      chart, against a chosen baseline, on a 1,200-row table (the resident
//      path) and a 12-row one (the JS reference).
//   3. The header sentence is the server's, with the figures in it.
//   4. Every refusal over the route: its code, its sentence, never a figure.
//      A Live dataset is refused typed, and `getDataset` is never called.
//   5. NEGATIVE CONTROLS: the differential fails against another bucket's
//      figure; the filter changes the answer; a refusal recogniser does not take
//      a good reply; a bad payload is a 400 and another org a 403.
//
//   npm run build:ts && node scripts/test-driversPoint.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const point: typeof import('../src/analysis/driverPoint') = require('../src/analysis/driverPoint');
const scope: typeof import('../src/analysis/driverScope') = require('../src/analysis/driverScope');
const msg: typeof import('../src/analysis/driverPointMessages') = require('../src/analysis/driverPointMessages');
const liveRefusals: typeof import('../src/engine/liveRefusals') = require('../src/engine/liveRefusals');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const { DATE_GRAINS }: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');

type Identity = import('../src/server/context').Identity;
type VizEncoding = import('../src/analysis/visuals').VizEncoding;
type DateGrain = import('../src/analysis/categoryKey').DateGrain;
type FilterStep = import('../src/data/transforms').FilterStep;
type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type PointPlan = import('../src/analysis/driverPoint').PointPlan;
type Reply = { status: number; body: any }; // any: each reply is narrowed by the assertion that reads it

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-drvpoint-'));
const who = (org: string): Identity => ({ user: { email: `u@${org}`, role: 'admin' }, org: { id: org } });
const DS = '11111111-1111-4111-8111-111111111111';

// ── 1. Pure ──────────────────────────────────────────────────────────────────

const enc = (extra: Partial<VizEncoding> = {}): VizEncoding => ({ category: 'day', values: [{ column: 'revenue', aggregation: 'sum' }], ...extra });
const chartOf = (grain: DateGrain, labels: string[], series: string[] = ['sum of revenue']) =>
  ({ category: { kind: 'date' as const, grain }, labels, series: series.map((name) => ({ name })) });
const good = (p: PointPlan): Extract<PointPlan, { ok: true }> => {
  if (!p.ok) throw new Error(`refused: ${p.code} ${p.error}`);
  return p;
};
const refused = (p: PointPlan, code: string, sentence: string): boolean => !p.ok && p.code === code && p.error === sentence && sentence.length > 20;

function pure(): void {
  // Labels in time order per grain, with a GAP before the last (the bucket "before" is the one on the axis, not the calendar's).
  const AXIS: Record<DateGrain, string[]> = {
    day: ['2025-02-27', '2025-02-28', '2025-03-01', '2025-03-04'],
    week: ['2025-02-17', '2025-02-24', '2025-03-03', '2025-03-17'],
    month: ['2024-11', '2024-12', '2025-01', '2025-03'],
    quarter: ['2024-Q2', '2024-Q3', '2024-Q4', '2025-Q2'],
    year: ['2021', '2022', '2023', '2025'],
  };
  for (const grain of DATE_GRAINS) {
    const axis = AXIS[grain];
    // Arrives shuffled: order is never assumed.
    const shuffled = [axis[2], axis[0], axis[3], axis[1]];
    const latest = good(point.pointPlan(DS, enc(), chartOf(grain, shuffled), [], {}));
    ok(`${grain}: no bucket named → the chart's LATEST period against the one before it in time`,
      latest.bucket === axis[3] && latest.baseline === axis[2] && latest.spec.compare.mode === 'bucket'
      && latest.spec.compare.label === axis[3] && latest.spec.compare.prev === axis[2] && latest.spec.compare.grain === grain, JSON.stringify(latest.spec.compare));
    const mid = good(point.pointPlan(DS, enc(), chartOf(grain, shuffled), [], { bucket: axis[1] }));
    ok(`${grain}: a clicked bucket is compared with the bucket before it`, mid.spec.compare.mode === 'bucket' && mid.spec.compare.label === axis[1] && mid.spec.compare.prev === axis[0]);
    ok(`${grain}: the periods come back in time order, each with its words`,
      JSON.stringify(latest.periods.map((p) => p.label)) === JSON.stringify(axis) && latest.periods.every((p) => p.text === scope.rangeLabel(scope.bucketRange(p.label, grain))),
      JSON.stringify(latest.periods));
    ok(`${grain}: the baselines are every EARLIER bucket, nearest first, the first marked previous`,
      JSON.stringify(latest.baselines.map((b) => b.label)) === JSON.stringify([axis[2], axis[1], axis[0]]) && latest.baselines[0].kind === 'previous'
      && latest.baselines[0].text === msg.baselinePrevious(latest.periods[2].text), JSON.stringify(latest.baselines));
    ok(`${grain}: the question survives the drivers sanitizer unchanged (DriversView re-asks with it)`,
      JSON.stringify(scope.sanitizeDriversSpec(latest.spec, latest.spec.filters)) === JSON.stringify(latest.spec));
    const first = point.pointPlan(DS, enc(), chartOf(grain, shuffled), [], { bucket: axis[0] });
    ok(`${grain}: the first bucket is refused with its period named, and the periods still sent`,
      refused(first, 'first_bucket', msg.pointFirstBucket(latest.periods[0].text)) && !first.ok && first.periods?.length === 4 && first.bucket === axis[0], JSON.stringify(first));
    const later = point.pointPlan(DS, enc(), chartOf(grain, shuffled), [], { bucket: axis[1], baseline: axis[3] });
    ok(`${grain}: a LATER bucket is not a baseline`, refused(later, 'unknown_baseline', msg.pointUnknownBaseline()));
  }

  // "Same period last year" exists only when the chart reaches it.
  const months = ['2024-03', '2024-04', '2025-01', '2025-02', '2025-03'];
  const yr = good(point.pointPlan(DS, enc(), chartOf('month', months), [], { bucket: '2025-03' }));
  ok('month: Mar 2024 is offered as "same period last year" for Mar 2025',
    yr.baselines.find((b) => b.kind === 'year')?.label === '2024-03' && yr.baselines.find((b) => b.kind === 'year')?.text === msg.baselineLastYear('Mar 2024'), JSON.stringify(yr.baselines));
  ok('…and choosing it compares those two', good(point.pointPlan(DS, enc(), chartOf('month', months), [], { bucket: '2025-03', baseline: '2024-03' })).spec.compare.mode === 'bucket'
    && (good(point.pointPlan(DS, enc(), chartOf('month', months), [], { bucket: '2025-03', baseline: '2024-03' })).spec.compare as { prev: string }).prev === '2024-03');
  ok('NEGATIVE CONTROL: no bucket a year back → no "last year" baseline', !good(point.pointPlan(DS, enc(), chartOf('month', months), [], { bucket: '2025-02' })).baselines.some((b) => b.kind === 'year'));
  ok('day: Feb 29 looks back to Feb 28', good(point.pointPlan(DS, enc(), chartOf('day', ['2023-02-28', '2024-02-28', '2024-02-29']), [], {})).baselines.some((b) => b.kind === 'year' && b.label === '2023-02-28'));

  // Series: a split chart's series is a drill step; a multi-measure chart's series is the measure.
  const split = good(point.pointPlan(DS, enc({ series: 'region' }), chartOf('month', months, ['West', 'East']), [], { bucket: '2025-03', series: 'West' }));
  ok('split chart: the clicked series narrows both periods (a drill step), the measure is the chart\'s one',
    JSON.stringify(split.spec.path) === JSON.stringify([{ column: 'region', value: 'West' }]) && split.spec.metric.column === 'revenue', JSON.stringify(split.spec));
  ok('split chart, no series (the tile menu): every series together', good(point.pointPlan(DS, enc({ series: 'region' }), chartOf('month', months, ['West', 'East']), [], {})).spec.path.length === 0);
  const two = enc({ values: [{ column: 'revenue', aggregation: 'sum' }, { column: 'cost', aggregation: 'avg' }] });
  const second = good(point.pointPlan(DS, two, chartOf('month', months, ['sum of revenue', 'avg of cost']), [], { series: 'avg of cost' }));
  ok('two measures: the clicked series picks ITS measure, and no drill step',
    second.spec.metric.column === 'cost' && second.spec.metric.aggregation === 'avg' && second.spec.metric.label === msg.measureAvg('cost') && second.spec.path.length === 0, JSON.stringify(second.spec.metric));
  ok('two measures: a series that is not one of them (an overlay) is refused',
    refused(point.pointPlan(DS, two, chartOf('month', months, ['sum of revenue', 'avg of cost']), [], { series: 'Previous year' }), 'unknown_series', msg.pointUnknownSeries()));
  ok('a `none` measure on a grouped chart is explained as the sum the chart draws',
    good(point.pointPlan(DS, enc({ values: [{ column: 'revenue', aggregation: 'none' }] }), chartOf('month', months), [], {})).spec.metric.aggregation === 'sum');
  ok('a count is named as one', good(point.pointPlan(DS, enc({ values: [{ column: 'day', aggregation: 'count' }] }), chartOf('month', months), [], {})).spec.metric.label === msg.measureCount('day'));

  // Filters: the chart's own, the same array contents, in order.
  const filters: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'West' } as FilterStep, { type: 'filter', column: 'units', op: '>', value: 2 } as FilterStep];
  ok('the chart\'s filters ride through untouched', JSON.stringify(good(point.pointPlan(DS, enc(), chartOf('month', months), filters, {})).spec.filters) === JSON.stringify(filters));

  // Refusals, each with its code and catalog sentence.
  const m = chartOf('month', months);
  ok('refused: a text axis', refused(point.pointPlan(DS, enc(), { category: { kind: 'text' }, labels: ['a', 'b'], series: [] }, [], {}), 'not_time_series', msg.pointNotTimeSeries()));
  ok('refused: no axis info at all', refused(point.pointPlan(DS, enc(), { labels: months, series: [] }, [], {}), 'not_time_series', msg.pointNotTimeSeries()));
  ok('refused: a map', refused(point.pointPlan(DS, enc({ geo: { level: 'us_state' } }), m, [], {}), 'unsupported', msg.pointUnsupported()));
  ok('refused: a measure from a related dataset', refused(point.pointPlan(DS, enc({ values: [{ column: 'revenue', aggregation: 'sum', datasetId: DS }] }), m, [], {}), 'unsupported', msg.pointUnsupported()));
  ok('refused: no readable period', refused(point.pointPlan(DS, enc(), chartOf('month', ['', 'Other']), [], {}), 'no_periods', msg.pointNoPeriods()));
  ok('refused: a point that is not a bucket of this chart (a forecast)', refused(point.pointPlan(DS, enc(), m, [], { bucket: '2031-01' }), 'unknown_bucket', msg.pointUnknownBucket()));
  for (const aggregation of ['min', 'max'] as const) {
    ok(`refused: a ${aggregation} (one row's value)`, refused(point.pointPlan(DS, enc({ values: [{ column: 'revenue', aggregation }] }), m, [], {}), 'not_additive', msg.pointNotAdditive()));
  }
  ok('refused: a table calculation', refused(point.pointPlan(DS, enc({ values: [{ column: 'revenue', aggregation: 'sum', calc: { kind: 'running_total', along: 'across' } }] }), m, [], {}), 'table_calc', msg.pointTableCalc()));
  ok('NEGATIVE CONTROL: the refusal recogniser takes neither a plan nor another refusal\'s sentence',
    !refused(point.pointPlan(DS, enc(), m, [], {}), 'not_additive', msg.pointNotAdditive())
    && !refused(point.pointPlan(DS, enc({ values: [{ column: 'revenue', aggregation: 'min' }] }), m, [], {}), 'not_additive', msg.pointTableCalc()));

  // The header: figures in, words out.
  const base = { metric: 'Revenue', changeText: '$180', period: 'Mar 2025', baseline: 'Feb 2025', from: '$1K', to: '$820' };
  ok('sentence: a fall', point.changeSentence({ ...base, delta: -180, pct: -18, day: false }) === 'Revenue fell 18% in Mar 2025 vs Feb 2025 (from $1K to $820)');
  ok('sentence: a rise under 10% keeps one decimal', point.changeSentence({ ...base, delta: 45, pct: 4.52, day: false }) === 'Revenue rose 4.5% in Mar 2025 vs Feb 2025 (from $1K to $820)');
  ok('sentence: a day reads "on"', point.changeSentence({ ...base, delta: -180, pct: -18, day: true }) === 'Revenue fell 18% on Mar 2025 vs Feb 2025 (from $1K to $820)');
  ok('sentence: no percentage to give → the change itself', point.changeSentence({ ...base, delta: -180, pct: null, day: false }) === 'Revenue fell $180 in Mar 2025 vs Feb 2025 (from $1K to $820)');
  ok('sentence: no change', point.changeSentence({ ...base, delta: 0, pct: 0, day: false }) === 'Revenue did not change in Mar 2025 vs Feb 2025 ($820 in both)');
}

// ── 2–5. Over the route ──────────────────────────────────────────────────────

function client(base: string, headers: Record<string, string>) {
  return async (channel: string, payload?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json', ...headers }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
  };
}

const COLUMNS: ParsedColumn[] = [
  { name: 'day', type: 'date' },
  { name: 'region', type: 'text' },
  { name: 'product', type: 'text' },
  { name: 'revenue', type: 'number' },
  { name: 'cost', type: 'number' },
];
const iso = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** 15 months × 4 regions × 5 products × 4 days = 1,200 rows of whole numbers (so sums are exact in any order). */
function bigRows(): Cell[][] {
  const rows: Cell[][] = [];
  const regions = ['West', 'East', 'North', 'South'];
  const products = ['Chairs', 'Desks', 'Lamps', 'Rugs', 'Shelves'];
  for (let k = 0; k < 15; k += 1) {
    const y = 2024 + Math.floor(k / 12);
    const mo = 1 + (k % 12);
    for (const [ri, region] of regions.entries()) {
      for (const [pi, product] of products.entries()) {
        for (const d of [3, 9, 17, 24]) {
          // West × Lamps collapses in the last month: a change with a driver.
          const dip = k === 14 && ri === 0 && pi === 2 ? 0.25 : 1;
          const revenue = Math.round((200 + 37 * ri + 53 * pi + 11 * k + d) * dip);
          rows.push([iso(y, mo, d), region, product, revenue, Math.round(revenue * 0.6)]);
        }
      }
    }
  }
  return rows;
}

/** Twelve rows with figures chosen by hand: Feb 2025 = 1,000, Mar 2025 = 820 (West fell 180), Mar 2024 = 900. */
const SMALL: Cell[][] = [
  ['2024-03-05', 'West', 'Chairs', 500, 300], ['2024-03-06', 'East', 'Desks', 400, 200],
  ['2025-01-07', 'West', 'Chairs', 300, 100], ['2025-01-08', 'East', 'Desks', 300, 100],
  ['2025-02-04', 'West', 'Chairs', 350, 100], ['2025-02-11', 'West', 'Desks', 250, 100], ['2025-02-12', 'East', 'Chairs', 150, 100], ['2025-02-18', 'East', 'Desks', 250, 100],
  ['2025-03-04', 'West', 'Chairs', 300, 100], ['2025-03-11', 'West', 'Desks', 120, 100], ['2025-03-12', 'East', 'Chairs', 150, 100], ['2025-03-18', 'East', 'Desks', 250, 100],
];

type Chart = { labels: string[]; series: { name: string; values: (number | null)[] }[] };
const valueAt = (c: Chart, label: string, series = 0): number | null => c.series[series].values[c.labels.indexOf(label)];

async function route(): Promise<void> {
  const app: FastifyInstance = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) =>
    typeof h['x-test-org'] === 'string' ? who(h['x-test-org']) : null);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
  const call = client(base, { 'x-test-org': 'org-a' });
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  try {
    const seed = await context.runInContext(who('org-a'), 'seed', async () => {
      const projects: typeof import('../src/app/projects') = require('../src/app/projects');
      const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
      await projects.init();
      const pid = (await projects.createProject('Explain a point')).id;
      const big = await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: COLUMNS, rows: bigRows() });
      const small = await datasets.saveDataset(pid, { name: 'Orders small', sourceKind: 'csv', columns: COLUMNS, rows: SMALL });
      const thin = await datasets.saveDataset(pid, { name: 'Two columns', sourceKind: 'csv', columns: [COLUMNS[0], COLUMNS[3]], rows: SMALL.map((r) => [r[0], r[3]]) });
      // Feb 2025 has rows but no revenue in them: a period with no figure.
      const holes = await datasets.saveDataset(pid, { name: 'A hole', sourceKind: 'csv', columns: COLUMNS, rows: SMALL.map((r) => (String(r[0]).startsWith('2025-02') ? [r[0], r[1], r[2], null, r[4]] : r)) });
      const live = await liveRecord.saveLiveRecord(pid, { name: 'Orders live', columns: COLUMNS, origin: { kind: 'connection', connId: '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d', table: 'orders' } });
      if (!big || !small || !thin || !holes || !live) throw new Error('fixture not saved');
      return { pid, big: big.id, small: small.id, thin: thin.id, holes: holes.id, live: live.id };
    });
    const P = seed.pid;
    const E = (extra: object = {}) => ({ category: 'day', values: [{ column: 'revenue', aggregation: 'sum' }], grain: 'month', ...extra });
    const chartOver = async (datasetId: string, encoding: object, filters: object[] = []): Promise<Chart> => (await call('visual:data', { projectId: P, datasetId, encoding, filters })).body.data;
    const explain = (datasetId: string, encoding: object, pt: object = {}, extra: object = {}) => call('drivers:explainPoint', { projectId: P, datasetId, encoding, point: pt, ...extra });

    // The tile's own reply says its axis is a date — what the web gates the context menu on.
    const tile = await call('analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: seed.small, encoding: E() }] });
    ok('a time-series tile\'s reply carries category.kind = date and its grain', tile.status === 200 && tile.body[0].category?.kind === 'date' && tile.body[0].category.grain === 'month', JSON.stringify(tile.body[0]).slice(0, 200));
    const flat = await call('analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: seed.small, encoding: E({ category: 'region' }) }] });
    ok('NEGATIVE CONTROL: a chart by region does not', flat.status === 200 && flat.body[0].ok && flat.body[0].category?.kind !== 'date', JSON.stringify(flat.body[0].category));

    // ── The differential, per grain, on both tables ─────────────────────────
    for (const [name, ds] of [['1,200 rows', seed.big], ['12 rows', seed.small]] as const) {
      for (const grain of DATE_GRAINS) {
        const chart = await chartOver(ds, E({ grain }));
        const r = await explain(ds, E({ grain }));
        const b = r.body;
        const same = r.status === 200 && b.ok && Object.is(b.result.totals.a, valueAt(chart, b.bucket)) && Object.is(b.result.totals.b, valueAt(chart, b.baseline));
        ok(`${name}, ${grain}: the header's two figures ARE the chart's two points (Object.is), and the periods are the chart's own buckets`,
          same && chart.labels.includes(b.bucket) && b.periods.length === chart.labels.length && b.result.totals.delta === b.result.totals.a - b.result.totals.b,
          JSON.stringify({ status: r.status, bucket: b.bucket, baseline: b.baseline, totals: b.result?.totals, error: b.error }).slice(0, 300));
        if (grain === 'day') ok(`${name}, day: the sentence reads "on"`, / on [A-Z][a-z]{2} \d/.test(b.result.sentence), b.result.sentence);
      }
    }
    // Both engines answered: the 1,200-row table in place (resident), the 12-row one from the JS reference.
    const drv = trace.snapshot().drivers;
    ok('both driver paths ran: resident on the big table, the JS reference on the small one, none failed', !!drv && drv.resident > 0 && drv.skipped > 0 && drv.failed === 0, JSON.stringify(drv));
    const months = await chartOver(seed.big, E());
    const last = await explain(seed.big, E());
    ok('NEGATIVE CONTROL: the differential is not vacuous — another bucket\'s figure is a different number',
      !Object.is(last.body.result.totals.a, valueAt(months, last.body.baseline)) && !Object.is(last.body.result.totals.b, valueAt(months, months.labels[0])));
    ok('the dip has a driver: dimensions ranked, a waterfall, West leading', last.body.result.dimensions.length >= 2 && !!last.body.result.selected
      && last.body.result.dimensions.every((d: { column: string }) => d.column !== 'day') && /West|Lamps/.test(last.body.result.caption), last.body.result.caption);

    // ── The sentence, the baseline, the series, the filter (hand figures) ───
    const s1 = await explain(seed.small, E());
    ok('small: Mar 2025 against Feb 2025 by default — 820 against 1,000', s1.body.ok && s1.body.bucket === '2025-03' && s1.body.baseline === '2025-02'
      && Object.is(s1.body.result.totals.a, 820) && Object.is(s1.body.result.totals.b, 1000), JSON.stringify(s1.body.result?.totals));
    const t1 = s1.body.result.totals;
    ok('small: the header is the server\'s sentence, figures included',
      s1.body.result.sentence === `Sum of revenue fell 18% in Mar 2025 vs Feb 2025 (from ${t1.bText} to ${t1.aText})` && t1.aText !== '' && t1.bText !== '', s1.body.result.sentence);
    ok('small: region explains it, West fell 180', s1.body.result.selected?.column === 'region' && s1.body.result.selected.members[0].key === 'West' && Object.is(s1.body.result.selected.members[0].delta, -180),
      JSON.stringify(s1.body.result.selected?.members).slice(0, 200));
    const s2 = await explain(seed.small, E(), { bucket: '2025-03', baseline: '2024-03' });
    ok('small: against the same month last year — 820 against 900, named in the list',
      s2.body.ok && Object.is(s2.body.result.totals.b, 900) && s2.body.baselines.some((x: { kind: string; label: string }) => x.kind === 'year' && x.label === '2024-03')
      && s2.body.result.sentence.startsWith('Sum of revenue fell 8.9% in Mar 2025 vs Mar 2024 '), s2.body.result?.sentence);
    const splitChart = await chartOver(seed.small, E({ series: 'region' }));
    const west = splitChart.series.findIndex((s) => s.name === 'West');
    const s3 = await explain(seed.small, E({ series: 'region' }), { bucket: '2025-03', series: 'West' });
    ok('split chart: the West point is explained as West\'s own figures (the chart\'s West series, Object.is), region no longer a dimension',
      s3.body.ok && Object.is(s3.body.result.totals.a, valueAt(splitChart, '2025-03', west)) && Object.is(s3.body.result.totals.b, valueAt(splitChart, '2025-02', west))
      && Object.is(s3.body.result.totals.a, 420) && s3.body.result.path.length === 1 && s3.body.result.dimensions.every((d: { column: string }) => d.column !== 'region')
      && /^Sum of revenue in West fell 30% /.test(s3.body.result.sentence), JSON.stringify({ t: s3.body.result?.totals, s: s3.body.result?.sentence }));
    const east = [{ type: 'filter', column: 'region', op: '=', value: 'East' }];
    const eastChart = await chartOver(seed.small, E(), east);
    const s4 = await explain(seed.small, E(), {}, { filters: east });
    ok('a sheet filter is respected: under region = East both periods are 400 (the filtered chart\'s points), and it says so',
      s4.body.ok && Object.is(s4.body.result.totals.a, valueAt(eastChart, '2025-03')) && Object.is(s4.body.result.totals.b, valueAt(eastChart, '2025-02')) && Object.is(s4.body.result.totals.a, 400)
      && /did not change in Mar 2025 vs Feb 2025/.test(s4.body.result.sentence), JSON.stringify(s4.body.result?.totals));
    ok('NEGATIVE CONTROL: without the filter the figures differ', !Object.is(s4.body.result.totals.a, s1.body.result.totals.a));
    const twoEnc = E({ values: [{ column: 'revenue', aggregation: 'sum' }, { column: 'cost', aggregation: 'sum' }] });
    const twoChart = await chartOver(seed.small, twoEnc);
    const s5 = await explain(seed.small, twoEnc, { series: twoChart.series[1].name });
    ok('two measures: the cost line is explained as cost', s5.body.ok && Object.is(s5.body.result.totals.a, valueAt(twoChart, '2025-03', 1)) && s5.body.result.metric.name === msg.measureSum('cost'), JSON.stringify(s5.body.result?.totals));
    const avg = await explain(seed.small, E({ values: [{ column: 'revenue', aggregation: 'avg' }] }));
    const avgChart = await chartOver(seed.small, E({ values: [{ column: 'revenue', aggregation: 'avg' }] }));
    ok('an average is a ratio: explained with a rate and a mix, its two figures the chart\'s',
      avg.body.ok && avg.body.result.metric.kind === 'ratio' && Object.is(avg.body.result.totals.a, valueAt(avgChart, '2025-03')) && avg.body.result.selected?.members[0].mixText !== undefined,
      JSON.stringify(avg.body.result?.totals));
    // The echoed question is what DriversView re-asks with: the same answer through drivers:explain.
    const again = await call('drivers:explain', { projectId: P, request: s1.body.result.spec });
    ok('the reply\'s spec, asked again through drivers:explain, gives the same figures and sentence',
      again.status === 200 && Object.is(again.body.totals.a, t1.a) && Object.is(again.body.totals.b, t1.b) && again.body.sentence === s1.body.result.sentence, JSON.stringify(again.body).slice(0, 200));

    // ── Refusals over the route ─────────────────────────────────────────────
    const refusedAs = (r: Reply, code: string, sentence: string): boolean => r.status === 200 && r.body.ok === false && r.body.code === code && r.body.error === sentence && !('result' in r.body);
    ok('route: a chart by region', refusedAs(await explain(seed.small, E({ category: 'region' })), 'not_time_series', msg.pointNotTimeSeries()));
    const firstB = await explain(seed.small, E(), { bucket: '2024-03' });
    ok('route: the first bucket — the sentence names it and the periods still come', refusedAs(firstB, 'first_bucket', msg.pointFirstBucket('Mar 2024')) && firstB.body.periods.length === 4);
    ok('route: a bucket the chart does not have', refusedAs(await explain(seed.small, E(), { bucket: '2031-01' }), 'unknown_bucket', msg.pointUnknownBucket()));
    ok('route: a later baseline', refusedAs(await explain(seed.small, E(), { bucket: '2025-02', baseline: '2025-03' }), 'unknown_baseline', msg.pointUnknownBaseline()));
    ok('route: a minimum', refusedAs(await explain(seed.small, E({ values: [{ column: 'revenue', aggregation: 'min' }] })), 'not_additive', msg.pointNotAdditive()));
    ok('route: a maximum', refusedAs(await explain(seed.small, E({ values: [{ column: 'revenue', aggregation: 'max' }] })), 'not_additive', msg.pointNotAdditive()));
    ok('route: a table calculation', refusedAs(await explain(seed.small, E({ values: [{ column: 'revenue', aggregation: 'sum', calc: { kind: 'running_total', along: 'across' } }] })), 'table_calc', msg.pointTableCalc()));
    ok('route: a map', refusedAs(await explain(seed.small, E({ category: 'region', geo: { level: 'us_state' } })), 'unsupported', msg.pointUnsupported()));
    ok('route: an "As of" view', refusedAs(await explain(seed.small, E(), {}, { asOf: '2025-01-01T00:00:00.000Z' }), 'as_of', msg.pointAsOf()));
    const none = await explain(seed.thin, E());
    ok('route: nothing to split by — the two figures stay, the reason is the catalog\'s', none.body.ok && none.body.result.selected === null && Object.is(none.body.result.totals.a, 820)
      && none.body.result.unavailable === msg.pointNoDimension('2', '200'), JSON.stringify(none.body.result?.unavailable));
    const hole = await explain(seed.holes, E());
    ok('route: a period with no figure — said, never a zero', hole.body.ok && hole.body.result.selected === null && hole.body.result.totals.b === null
      && hole.body.result.unavailable === msg.pointNoFigure() && hole.body.result.sentence === undefined, JSON.stringify(hole.body.result?.totals));

    // A Live dataset: refused, typed, with the catalog's sentence — and no row is ever asked for.
    const real = datasets.getDataset;
    let hydrated = 0;
    (datasets as { getDataset: typeof real }).getDataset = (...args) => { hydrated += 1; return real(...args); };
    const liveR = await explain(seed.live, E());
    (datasets as { getDataset: typeof real }).getDataset = real;
    ok('Live: live_refused with the key-drivers sentence, reason drivers', liveR.status === 200 && liveR.body.ok === false && liveR.body.code === 'live_refused'
      && liveR.body.reason === 'drivers' && liveR.body.error === liveRefusals.liveDriversRefused(), JSON.stringify(liveR.body));
    ok('Live: getDataset was never called (spy)', hydrated === 0, hydrated);
    ok('NEGATIVE CONTROL: the refusal recogniser does not take a good reply', !refusedAs(s1, 'first_bucket', msg.pointFirstBucket('Mar 2024')) && s1.body.ok === true);

    // ── The door ────────────────────────────────────────────────────────────
    ok('a payload without a point → 400', (await call('drivers:explainPoint', { projectId: P, datasetId: seed.small, encoding: E() })).status === 400);
    ok('an unknown field in the point → 400', (await explain(seed.small, E(), { bucket: '2025-03', delta: -180 })).status === 400);
    ok('another org\'s caller → 403', (await client(base, { 'x-test-org': 'org-b' })('drivers:explainPoint', { projectId: P, datasetId: seed.small, encoding: E(), point: {} })).status === 403);
  } finally {
    await app.close();
  }
}

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  try {
    pure();
    await route();
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
