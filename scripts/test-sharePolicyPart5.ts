// Part 5's figures under the Share policy (release B's fix, src/publish/kpiPolicy.ts): every one that leaves the org is
// judged on the columns it is totalled from, as a chart over them is — on /p/, an embed, the HTML export, a report, a
// story export, a send, an alert post and MCP's metric_value (scripts/sharePolicyPart5Harness.ts reads each).
//
//   countd   a distinct count over a marked column (p5-04)
//   period   a year-to-date metric over a base totalled from it, and an alert watched through it (p5-05);
//            its chart by month (p5-06)
//   snapshot-per  each team's latest salary, summed: its KPI, its chart by team and an alert on it (p5-07)
//   funnel   a funnel metric keyed by a marked user column: its KPI, its chart and an alert watched through it (p5-08)
//   target   a metric's target from a plan totalled from a marked column: the tile keeps its own figure and says the
//            house wording for its target; the scorecard row is withheld, as a row with a target metric is (p5-09);
//            a report's chart draws no target line from it, and an alert on a share of it posts no figure (p5-10)
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
    (on) => H.mark(env, P, S, 'salary', on), '765261e43c35dbd70db570955894221e7b3207a3d4c8c1dd8c2d7d68cf240aa2');
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

/** A target as a surface carries it: 'hidden' (the house wording, no figure), 'shown' (a figure), or 'absent'. */
function targetOn(o: H.Out, where: 'dashboard' | 'embed' | 'exported' | 'mcp', name: string): string {
  const of = (t: any): string => !t ? 'absent' : t.none === H.HIDDEN && t.value === null && t.attainment === null ? 'hidden' : typeof t.value === 'number' ? 'shown' : 'absent'; // any: a TargetResult
  if (where === 'mcp') return of((o.mcp[name] as { target?: unknown } | undefined)?.target);
  const ps = H.tile(o[where], name)?.payloads ?? [];
  const each = ps.map((p: any) => of(p.target)); // any: a payload
  return each.length && each.every((x: string) => x === each[0]) ? each[0] : 'absent';
}

async function target(env: H.Env): Promise<void> {
  const { P, S } = await H.project(env, 'Part 5 target');
  const avgPay = await H.saveMetric(env, P, S, 'Avg pay', { column: 'salary', aggregation: 'avg' }, { timeColumn: 'day' });
  const budget = await H.saveMetric(env, P, S, 'Hours budget', { column: 'hours', aggregation: 'max' }, { timeColumn: 'day' });
  // Averages, so the plan holds over any range and metric_value (no scope) has a target too (ipc/targetResolve).
  const vsPay = await H.saveMetric(env, P, S, 'Avg hours', { column: 'hours', aggregation: 'avg' }, { timeColumn: 'day', target: { source: { metricId: avgPay.id } } });
  const vsBudget = await H.saveMetric(env, P, S, 'Avg hours vs budget', { column: 'hours', aggregation: 'avg' }, { timeColumn: 'day', target: { source: { metricId: budget.id } } });
  const kpi = (m: { id: string }) => ({ datasetId: S, column: 'hours', aggregation: 'avg', metricId: m.id });
  const fx = await H.publishable(env, P, [{ title: 'Avg hours KPI', metric: kpi(vsPay) }, { title: 'Avg hours vs budget KPI', metric: kpi(vsBudget) }], [vsPay.id, vsBudget.id], [], ['Avg hours', 'Avg hours vs budget']);
  const handler = (require('../src/server/rpc') as typeof import('../src/server/rpc')).handlers.get('metric:value')!;
  const value = (id: string, share?: string): Promise<any> => env.inApp(async () => handler({}, { projectId: P, id, ...(share ? { share } : {}) })); // any: metric:value's reply, as a report's tiles ask it
  const say = (o: H.Out) => ({
    tiles: (['dashboard', 'embed', 'exported'] as const).flatMap((w) => [[w, targetOn(o, w, 'Avg hours KPI'), H.figureOn(o, w, 'Avg hours KPI')], [w, targetOn(o, w, 'Avg hours vs budget KPI')]]),
    mcp: [targetOn(o, 'mcp', 'Avg hours'), targetOn(o, 'mcp', 'Avg hours vs budget')],
    rows: [H.figureOn(o, 'scoreRow', 'Avg hours'), H.figureOn(o, 'scoreRow', 'Avg hours vs budget')],
  });
  const before = await H.leave(env, fx, 'drop');
  ok('target PIN: with nothing marked, every surface is the one this branch published', H.pin(before) === '5d2b82eaa225320cfc3e7c997651a5cbe3a2269b13075ef806b36a7e79877df7', `target: ${H.pin(before)}`);
  ok('target fixture: with nothing marked, both targets are on every tile, metric_value and scorecard row', H.show(say(before)) === H.show({ tiles: ['dashboard', 'embed', 'exported'].flatMap((w) => [[w, 'shown', 'shown'], [w, 'shown']]), mcp: ['shown', 'shown'], rows: ['shown', 'shown'] }), H.show(say(before)));
  ok('target fixture: a report\'s metric:value carries both targets', typeof (await value(vsPay.id, 'report')).target?.value === 'number' && typeof (await value(vsBudget.id, 'report')).target?.value === 'number');

  await H.mark(env, P, S, 'salary', true);
  const drop = await H.leave(env, fx, 'drop');
  const d = say(drop);
  ok('target, drop: the tile over hours keeps its figure and says the house wording for its target from Avg pay, on /p/, the embed and the export',
    d.tiles.filter((t) => t.length === 3).every((t) => t[1] === 'hidden' && t[2] === 'shown'), H.show(d.tiles));
  ok('target, drop: metric_value answers Avg hours with its target withheld, and the scorecard row is withheld whole', d.mcp[0] === 'hidden' && d.rows[0] === 'hidden', H.show([d.mcp, d.rows]));
  const asked = await value(vsPay.id, 'report');
  ok('target, drop: a report\'s metric:value withholds the target, never its figure', asked.target?.none === H.HIDDEN && asked.target.value === null && typeof asked.value === 'number', H.show(asked));
  ok('NEGATIVE CONTROL (target, drop): the target from the hours budget is shown on every tile, metric_value and its row',
    d.tiles.filter((t) => t.length === 2).every((t) => t[1] === 'shown') && d.mcp[1] === 'shown' && d.rows[1] === 'shown' && typeof (await value(vsBudget.id, 'report')).target?.value === 'number', H.show(d));
  ok('NEGATIVE CONTROL (target, drop): in the app metric:value still carries the target from Avg pay', typeof (await value(vsPay.id)).target?.value === 'number');
  ok('target, mask: every surface publishes every target, as before', H.pin(noSub(await H.leave(env, fx, 'mask'))) === H.pin(noSub(before)));
  await H.mark(env, P, S, 'salary', false);
  ok('NEGATIVE CONTROL (target): with salary unmarked again, drop publishes every surface byte for byte as before', H.pin(await H.leave(env, fx, 'drop')) === H.pin(before));
}

/** A report tile's target line: 'shown' (a target series), 'off' (the chart, no line), or 'absent'. */
function lineOn(o: H.Out, title: string): string {
  const t = (o.report || []).flatMap((p: any) => p.tiles || []).find((x: any) => x.title === title); // any: a report tile
  return !t?.chart ? 'absent' : t.chart.data.series.some((x: any) => x.target === true) ? 'shown' : 'off'; // any: a series
}

async function targetLine(env: H.Env): Promise<void> {
  const { P, S } = await H.project(env, 'Part 5 target line');
  const avgPay = await H.saveMetric(env, P, S, 'Avg pay', { column: 'salary', aggregation: 'avg' }, { timeColumn: 'day' });
  const budget = await H.saveMetric(env, P, S, 'Hours budget', { column: 'hours', aggregation: 'max' }, { timeColumn: 'day' });
  const vsPay = await H.saveMetric(env, P, S, 'Avg hours', { column: 'hours', aggregation: 'avg' }, { timeColumn: 'day', target: { source: { metricId: avgPay.id } } });
  const vsBudget = await H.saveMetric(env, P, S, 'Avg hours vs budget', { column: 'hours', aggregation: 'avg' }, { timeColumn: 'day', target: { source: { metricId: budget.id } } });
  const byMonth = (m: { id: string }) => ({ datasetId: S, chartType: 'line', encoding: { category: 'day', grain: 'month', values: [{ column: 'hours', aggregation: 'avg', metricId: m.id }] } });
  const rule = (name: string, m: { id: string; name: string }) => ({ name, datasetId: S, metric: { column: 'hours', aggregation: 'avg', metricId: m.id, label: m.name }, compare: 'target', targetPct: { op: 'below', pct: 200 } });
  const fx = await H.publishable(env, P, [{ title: 'Avg hours by month', visual: byMonth(vsPay) }, { title: 'Avg hours vs budget by month', visual: byMonth(vsBudget) }], [],
    [rule('Avg hours under twice its target', vsPay), rule('Avg hours vs budget under twice its target', vsBudget)], []);
  const say = (o: H.Out) => [lineOn(o, 'Avg hours by month'), lineOn(o, 'Avg hours vs budget by month'), H.figureOn(o, 'posts', 'Avg hours under twice its target'), H.figureOn(o, 'posts', 'Avg hours vs budget under twice its target')];
  const before = await H.leave(env, fx, 'drop');
  ok('target line PIN: with nothing marked, every surface is the one this branch published', H.pin(before) === '546aa84118b395c79dd5421eeb0acdcecf92de44f8ddff8a7b0aadfd8700b302', `target line: ${H.pin(before)}`);
  ok('target line fixture: with nothing marked, both report charts draw their target line and both target alerts post their figures', H.show(say(before)) === H.show(['shown', 'shown', 'shown', 'shown']), H.show(say(before)));
  await H.mark(env, P, S, 'salary', true);
  const d = say(await H.leave(env, fx, 'drop'));
  ok('target line, drop: the report draws the hours chart with no line from Avg pay, and its target alert posts the house wording', d[0] === 'off' && d[2] === 'hidden', H.show(d));
  ok('NEGATIVE CONTROL (target line, drop): the line from the hours budget is drawn and its alert posts its figure', d[1] === 'shown' && d[3] === 'shown', H.show(d));
  ok('target line, mask: every surface publishes every line and post, as before', H.pin(noSub(await H.leave(env, fx, 'mask'))) === H.pin(noSub(before)));
  await H.mark(env, P, S, 'salary', false);
  ok('NEGATIVE CONTROL (target line): with salary unmarked again, drop publishes every surface byte for byte as before', H.pin(await H.leave(env, fx, 'drop')) === H.pin(before));
}

(async () => {
  const env = await H.start();
  try {
    await countd(env);
    await period(env);
    await periodChart(env);
    await snapshotPer(env);
    await funnel(env);
    await target(env);
    await targetLine(env);
  } finally {
    await env.close();
  }
})().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
