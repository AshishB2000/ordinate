// Part 5's figures under the Share policy (release B's fix, src/publish/kpiPolicy.ts): every one that leaves the org is
// judged on the columns it is totalled from, as a chart over them is — on /p/, an embed, the HTML export, a report, a
// story export, a send, an alert post and MCP's metric_value (scripts/sharePolicyPart5Harness.ts reads each).
//
//   countd   a distinct count over a marked column (p5-04)
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
interface Names { tiles: string[]; metrics: string[]; rules: string[]; mcp: string[] }
const TILE_SURFACES = ['dashboard', 'embed', 'exported', 'reportKpi', 'sendKpi'] as const;
const METRIC_SURFACES = ['storyMetric', 'exportKpi', 'scoreRow'] as const;

/** Each surface's figure for every name: [surface, name, what it shows]. */
function shown(o: H.Out, n: Names): Array<[string, string, string]> {
  return [
    ...TILE_SURFACES.flatMap((s) => n.tiles.map((t): [string, string, string] => [s, t, H.figureOn(o, s, t)])),
    ...METRIC_SURFACES.flatMap((s) => n.metrics.map((m): [string, string, string] => [s, m, H.figureOn(o, s, m)])),
    ...n.rules.map((r): [string, string, string] => ['posts', r, H.figureOn(o, 'posts', r)]),
    ...n.mcp.map((m): [string, string, string] => ['mcp', m, H.figureOn(o, 'mcp', m)]),
  ];
}
// A KPI's subtitle never names a marked column, masked or not (publish/kpiSubtitle): mask is compared without it.
const noSub = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (key, x) => (key === 'subtitle' ? undefined : x)));

/** The part's checks: pinned unmarked, every marked figure withheld under drop beside its shown control, mask and unmarked as before. */
async function judged(env: H.Env, part: string, fx: H.Fx, marked: Names, open: Names, setMark: (on: boolean) => Promise<unknown>, pinned: string): Promise<void> {
  const before = await H.leave(env, fx, 'drop');
  ok(`${part} PIN: with nothing marked, every surface is the one this branch published`, H.pin(before) === pinned, `${part}: ${H.pin(before)}`);
  const gaps = shown(before, { tiles: [...marked.tiles, ...open.tiles], metrics: [...marked.metrics, ...open.metrics], rules: [...marked.rules, ...open.rules], mcp: [...marked.mcp, ...open.mcp] }).filter(([, , s]) => s !== 'shown');
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

(async () => {
  const env = await H.start();
  try {
    await countd(env);
  } finally {
    await env.close();
  }
})().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
