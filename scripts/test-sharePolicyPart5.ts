// Part 5's figures under the Share policy (release B's fix, src/publish/kpiPolicy.ts): every one that leaves the org is
// judged on the columns it is totalled from, as a chart over them is — on /p/, an embed, the HTML export, a report, a
// story export, a send, an alert post and MCP's metric_value (scripts/sharePolicyPart5Harness.ts reads each).
//
//   countd   a distinct count over a marked column (p5-04)
//   period   a year-to-date metric over a base totalled from it, and an alert watched through it (p5-05);
//            its chart by month (p5-06)
//   snapshot-per  each team's latest salary, summed: its KPI, its chart by team and an alert on it (p5-07)
//   funnel   a funnel metric keyed by a marked user column: its KPI, its chart and an alert watched through it (p5-08)
//
// Under drop each such figure says the house wording, never its figure; under mask it passes, as every aggregate does.
// Negative controls in each part: a figure over a column nobody marked is shown beside it on every surface; with nothing
// marked, and with the column unmarked again, every surface is byte for byte what this branch published (sha256 pins).
//
//   npm run build:ts && node scripts/test-sharePolicyPart5.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './sharePolicyPart5Harness';

/** What each surface calls a part's figures: tile titles (dashboard, embed, export, report, send), metric names (story, its export, scorecard, MCP), rule names. */
interface Names { tiles: string[]; metrics: string[]; rules: string[]; mcp: string[]; charts?: string[] }
const TILE_SURFACES = ['dashboard', 'embed', 'exported', 'reportKpi', 'sendKpi'] as const;
const CHART_SURFACES = ['dashboard', 'embed', 'exported', 'reportTile', 'sendChart'] as const;
const METRIC_SURFACES = ['storyMetric', 'exportKpi', 'scoreRow'] as const;

/** Each surface's figure for every name: [surface, name, what it shows]. */
function shown(o: H.Out, n: Names): Array<[string, string, string]> {
  return [
    ...TILE_SURFACES.flatMap((s) => n.tiles.map((t): [string, string, string] => [s, t, H.figureOn(o, s, t)])),
    ...METRIC_SURFACES.flatMap((s) => n.metrics.map((m): [string, string, string] => [s, m, H.figureOn(o, s, m)])),
    ...n.rules.map((r): [string, string, string] => ['posts', r, H.figureOn(o, 'posts', r)]),
    ...n.mcp.map((m): [string, string, string] => ['mcp', m, H.figureOn(o, 'mcp', m)]),
    ...CHART_SURFACES.flatMap((s) => (n.charts ?? []).map((c): [string, string, string] => [s, c, H.figureOn(o, s, c)])),
  ];
}
// A KPI's subtitle never names a marked column, masked or not (publish/kpiSubtitle): mask is compared without it.
const noSub = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (key, x) => (key === 'subtitle' ? undefined : x)));

/** The part's checks: pinned unmarked, every marked figure withheld under drop beside its shown control, mask and unmarked as before. */
async function judged(env: H.Env, part: string, fx: H.Fx, marked: Names, open: Names, setMark: (on: boolean) => Promise<unknown>, pinned: string): Promise<void> {
  const before = await H.leave(env, fx, 'drop');
  ok(`${part} PIN: with nothing marked, every surface is the one this branch published`, H.pin(before) === pinned, `${part}: ${H.pin(before)}`);
  const gaps = shown(before, { tiles: [...marked.tiles, ...open.tiles], metrics: [...marked.metrics, ...open.metrics], rules: [...marked.rules, ...open.rules], mcp: [...marked.mcp, ...open.mcp], charts: [...marked.charts ?? [], ...open.charts ?? []] }).filter(([, , s]) => s !== 'shown');
  ok(`${part} fixture: with nothing marked, every figure is shown on every surface`, gaps.length === 0, H.show(gaps));

  await setMark(true);
  const drop = await H.leave(env, fx, 'drop');
  const leaked = shown(drop, marked).filter(([, , s]) => s !== 'hidden');
  ok(`${part}, drop: every figure totalled from the marked column says the house wording, on every surface`, leaked.length === 0, H.show(leaked));
  const lost = shown(drop, open).filter(([, , s]) => s !== 'shown');
  ok(`NEGATIVE CONTROL (${part}, drop): every figure over an unmarked column is shown beside them`, lost.length === 0, H.show(lost));

  const mask = await H.leave(env, fx, 'mask');
  ok(`${part}, mask: every surface publishes every figure, as before`, H.pin(noSub(mask)) === H.pin(noSub(before)), H.show(shown(mask, marked)));
  await setMark(false);
  ok(`NEGATIVE CONTROL (${part}): with the column unmarked again, drop publishes every surface byte for byte as before`, H.pin(await H.leave(env, fx, 'drop')) === H.pin(before));
}

async function countd(env: H.Env): Promise<void> {
  const { P, S } = await H.project(env, 'Part 5 countd');
  const pay = await H.saveMetric(env, P, S, 'Distinct pay', { column: 'salary', aggregation: 'countd' });
  const teams = await H.saveMetric(env, P, S, 'Teams', { column: 'team', aggregation: 'countd' });
  const fx = await H.publishable(env, P, [
    { title: 'Pay levels KPI', metric: { datasetId: S, column: 'salary', aggregation: 'countd' } },
    { title: 'Distinct pay KPI', metric: { datasetId: S, column: 'salary', aggregation: 'countd', metricId: pay.id } },
    { title: 'Teams KPI', metric: { datasetId: S, column: 'team', aggregation: 'countd', metricId: teams.id } },
  ], [pay.id, teams.id], [
    { name: 'Pay levels above 3', datasetId: S, metric: { column: 'salary', aggregation: 'countd', label: 'Pay levels' }, compare: 'threshold', threshold: { op: '>', value: 3 } },
    { name: 'Teams above 1', datasetId: S, metric: { column: 'team', aggregation: 'countd', label: 'Teams' }, compare: 'threshold', threshold: { op: '>', value: 1 } },
  ], ['Distinct pay', 'Teams']);
  await judged(env, 'countd', fx,
    { tiles: ['Pay levels KPI', 'Distinct pay KPI'], metrics: ['Distinct pay'], rules: ['Pay levels above 3'], mcp: ['Distinct pay'] },
    { tiles: ['Teams KPI'], metrics: ['Teams'], rules: ['Teams above 1'], mcp: ['Teams'] },
    (on) => H.mark(env, P, S, 'salary', on), 'd2604e31e39603c141539f7e03a69a88b5e35cc0009051fd091cff5e9cf51dab');
}

const TO_JUNE = [{ type: 'filter', column: 'day', op: '<=', value: '2025-06-30' }]; // the window's end, so the year to date is the fixture's half year on any day

async function period(env: H.Env): Promise<void> {
  const { P, S } = await H.project(env, 'Part 5 period');
  const pay = await H.saveMetric(env, P, S, 'Payroll', { column: 'salary', aggregation: 'sum' }, { timeColumn: 'day' });
  const hrs = await H.saveMetric(env, P, S, 'Hours', { column: 'hours', aggregation: 'sum' }, { timeColumn: 'day' });
  const ytdPay = await H.saveMetric(env, P, S, 'Payroll YTD', { base: pay.id, window: { to_date: 'year' } }, { filters: TO_JUNE });
  const ytdHrs = await H.saveMetric(env, P, S, 'Hours YTD', { base: hrs.id, window: { to_date: 'year' } }, { filters: TO_JUNE });
  const fx = await H.publishable(env, P, [
    { title: 'Payroll YTD KPI', metric: { datasetId: S, column: '', aggregation: 'sum', metricId: ytdPay.id } },
    { title: 'Hours YTD KPI', metric: { datasetId: S, column: '', aggregation: 'sum', metricId: ytdHrs.id } },
  ], [ytdPay.id, ytdHrs.id], [ // a period metric's rule has no column of its own: it is watched through the metric (alertMetric)
    { name: 'Payroll YTD above 1000', datasetId: S, metric: { column: '', aggregation: 'sum', metricId: ytdPay.id, label: 'Payroll YTD' }, compare: 'threshold', threshold: { op: '>', value: 1000 } },
    { name: 'Hours YTD above 10', datasetId: S, metric: { column: '', aggregation: 'sum', metricId: ytdHrs.id, label: 'Hours YTD' }, compare: 'threshold', threshold: { op: '>', value: 10 } },
  ], ['Payroll YTD', 'Hours YTD']);
  await judged(env, 'period', fx,
    { tiles: ['Payroll YTD KPI'], metrics: ['Payroll YTD'], rules: ['Payroll YTD above 1000'], mcp: ['Payroll YTD'] },
    { tiles: ['Hours YTD KPI'], metrics: ['Hours YTD'], rules: ['Hours YTD above 10'], mcp: ['Hours YTD'] },
    (on) => H.mark(env, P, S, 'salary', on), '15c00e0e7e5dd5dfe1ed507db5e820f621e402fbc6ca97b7f16c3d4574b3af52');
}

/** A period metric charted by month: every point a resolution of its base, so the chart is judged by the base's columns. */
async function periodChart(env: H.Env): Promise<void> {
  const { P, S } = await H.project(env, 'Part 5 period chart');
  const pay = await H.saveMetric(env, P, S, 'Payroll', { column: 'salary', aggregation: 'sum' }, { timeColumn: 'day' });
  const hrs = await H.saveMetric(env, P, S, 'Hours', { column: 'hours', aggregation: 'sum' }, { timeColumn: 'day' });
  const ytdPay = await H.saveMetric(env, P, S, 'Payroll YTD', { base: pay.id, window: { to_date: 'year' } });
  const ytdHrs = await H.saveMetric(env, P, S, 'Hours YTD', { base: hrs.id, window: { to_date: 'year' } });
  const byMonth = (m: { id: string; name: string }) => ({ datasetId: S, chartType: 'line', encoding: { category: 'day', grain: 'month', values: [{ column: m.name, aggregation: 'sum', metricId: m.id }] } });
  const fx = await H.publishable(env, P, [{ title: 'Payroll YTD by month', visual: byMonth(ytdPay) }, { title: 'Hours YTD by month', visual: byMonth(ytdHrs) }], [], [], []);
  await judged(env, 'period chart', fx,
    { tiles: [], metrics: [], rules: [], mcp: [], charts: ['Payroll YTD by month'] },
    { tiles: [], metrics: [], rules: [], mcp: [], charts: ['Hours YTD by month'] },
    (on) => H.mark(env, P, S, 'salary', on), 'ff21cfbb539a01853d22c817e7e6aeaa636ac59c35d9f2bc140e65aefd550d09');
}

async function snapshotPer(env: H.Env): Promise<void> {
  const { P, S } = await H.project(env, 'Part 5 snapshot per');
  const latest = (column: string) => ({ column, aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: 'team' } });
  const pay = await H.saveMetric(env, P, S, 'Current payroll', latest('salary'));
  const hrs = await H.saveMetric(env, P, S, 'Current hours', latest('hours'));
  const kpi = (m: { id: string }, column: string) => ({ datasetId: S, column, aggregation: 'sum', metricId: m.id });
  const byTeam = (m: { id: string }, column: string) => ({ datasetId: S, encoding: { category: 'team', values: [{ column, aggregation: 'sum', metricId: m.id }] } });
  const fx = await H.publishable(env, P, [
    { title: 'Current payroll KPI', metric: kpi(pay, 'salary') }, { title: 'Current hours KPI', metric: kpi(hrs, 'hours') },
    { title: 'Current payroll by team', visual: byTeam(pay, 'salary') }, { title: 'Current hours by team', visual: byTeam(hrs, 'hours') },
  ], [pay.id, hrs.id], [ // a rule made from a snapshot KPI stores its column and reads the metric's snapshot (alertStore.metricFor)
    { name: 'Current payroll above 1000', datasetId: S, metric: { ...kpi(pay, 'salary'), label: 'Current payroll' }, compare: 'threshold', threshold: { op: '>', value: 1000 } },
    { name: 'Current hours above 10', datasetId: S, metric: { ...kpi(hrs, 'hours'), label: 'Current hours' }, compare: 'threshold', threshold: { op: '>', value: 10 } },
  ], ['Current payroll', 'Current hours']);
  await judged(env, 'snapshot-per', fx,
    { tiles: ['Current payroll KPI'], metrics: ['Current payroll'], rules: ['Current payroll above 1000'], mcp: ['Current payroll'], charts: ['Current payroll by team'] },
    { tiles: ['Current hours KPI'], metrics: ['Current hours'], rules: ['Current hours above 10'], mcp: ['Current hours'], charts: ['Current hours by team'] },
    (on) => H.mark(env, P, S, 'salary', on), '96585e47b2e787f70404b49d5c5cbb5dc450a109a7d3da0d171c232453eec04c');
}

async function funnel(env: H.Env): Promise<void> {
  const { P } = await H.project(env, 'Part 5 funnel');
  // Six users visit in March 2025, four add to the cart, two buy: the same events twice, one table's user column marked.
  const rows = [1, 2, 3, 4, 5, 6].flatMap((u) => ['visit', 'cart', 'buy'].slice(0, u <= 2 ? 3 : u <= 4 ? 2 : 1).map((e, i) => [`u${u}`, e, `2025-03-${String(u * 3 + i).padStart(2, '0')}`]));
  const table = (name: string) => env.inApp(async () => (await H.datasets.saveDataset(P, { name, sourceKind: 'csv', columns: [{ name: 'user', type: 'text' }, { name: 'event', type: 'text' }, { name: 'ts', type: 'date' }], rows }))!.id);
  const E = await table('Signups');
  const V = await table('Visits');
  const def = { funnel: { entity: 'user', event: 'event', time: 'ts', steps: ['visit', 'cart', 'buy'], window: { n: 7, unit: 'days' } }, show: 'converted' };
  const signed = await H.saveMetric(env, P, E, 'Signed up', def);
  const visited = await H.saveMetric(env, P, V, 'Bought', def);
  const kpi = (ds: string, m: { id: string }) => ({ datasetId: ds, column: '', aggregation: 'sum', metricId: m.id });
  const byMonth = (ds: string, m: { id: string; name: string }) => ({ datasetId: ds, encoding: { category: 'ts', grain: 'month', values: [{ column: m.name, aggregation: 'sum', metricId: m.id }] } });
  const fx = await H.publishable(env, P, [
    { title: 'Signed up KPI', metric: kpi(E, signed) }, { title: 'Bought KPI', metric: kpi(V, visited) },
    { title: 'Signed up by month', visual: byMonth(E, signed) }, { title: 'Bought by month', visual: byMonth(V, visited) },
  ], [signed.id, visited.id], [ // a funnel metric's rule has no column of its own: it is watched through the metric (alertMetric)
    { name: 'Signed up above 1', datasetId: E, metric: { ...kpi(E, signed), label: 'Signed up' }, compare: 'threshold', threshold: { op: '>', value: 1 } },
    { name: 'Bought above 1', datasetId: V, metric: { ...kpi(V, visited), label: 'Bought' }, compare: 'threshold', threshold: { op: '>', value: 1 } },
  ], ['Signed up', 'Bought']);
  await judged(env, 'funnel', fx,
    { tiles: ['Signed up KPI'], metrics: ['Signed up'], rules: ['Signed up above 1'], mcp: ['Signed up'], charts: ['Signed up by month'] },
    { tiles: ['Bought KPI'], metrics: ['Bought'], rules: ['Bought above 1'], mcp: ['Bought'], charts: ['Bought by month'] },
    (on) => H.mark(env, P, E, 'user', on), 'b0612ea0f93e6e4fc4b717edc47a72674e02d65b8205cbd13570db7382bb5a61');
}

(async () => {
  const env = await H.start();
  try {
    await countd(env);
    await period(env);
    await periodChart(env);
    await snapshotPer(env);
    await funnel(env);
  } finally {
    await env.close();
  }
})().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
