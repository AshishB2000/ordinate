// Rebuild-from-a-screenshot on a LIVE dataset (docs/rebuild-from-screenshot/,
// docs/live-data/): `rebuild:match` previews through the doors a built tile
// takes, so on a Live dataset every figure on the check screen comes from the
// warehouse — never from zero hydrated rows — over the real RPC route.
//
//   1. It answers on Live, and each KPI figure equals `dashboard:metric` on the
//      same Live dataset (Object.is: the same door) and the extract's (the
//      parity tolerance of test-liveRoute.ts).
//   2. The chart preview equals `visual:data` on the Live dataset.
//   3. The Live dataset is never hydrated. Negative control: the spy does see
//      `getDataset` asked for an id (a hydrate it is pointed at directly).
//
//   npm run build:ts && node scripts/test-rebuildLive.js

export {};
import { ok, finish } from './selfcheck';
import { H, close, hydrates, post } from './liveRouteHarness';

const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');

const READING = {
  title: 'Sales',
  tool: 'metabase',
  tiles: [
    { kind: 'kpi', title: 'Amount', box: { x: 0, y: 0, w: 30, h: 10 }, measures: [{ field: 'amt', aggregation: 'sum' }] },
    { kind: 'kpi', title: 'Quantity', box: { x: 32, y: 0, w: 30, h: 10 }, measures: [{ field: 'qty', aggregation: 'avg' }] },
    { kind: 'chart', chart: 'bar', title: 'amt by region', box: { x: 0, y: 12, w: 100, h: 40 }, dimension: 'region', measures: [{ field: 'amt', aggregation: 'sum' }] },
  ],
};
const close13 = (a: unknown, b: unknown): boolean => Object.is(a, b) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-13 * Math.max(1, Math.abs(b)));

(async () => {
  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;

  const live = await hydrates(s.liveId, () => post('rebuild:match', { projectId: P, datasetId: s.liveId, reading: READING }));
  const r = live.value.value;
  ok('Live: rebuild:match answers', live.value.status === 200 && r.ok === true, live.value.body.slice(0, 300));
  ok('Live: the dataset is never hydrated', !live.hydrated);
  const ext = (await post('rebuild:match', { projectId: P, datasetId: s.extractId, reading: READING })).value;

  const tile = (rep: any, id: number) => rep.tiles.find((t: any) => t.id === id);
  for (const [id, column, aggregation] of [[1, 'amt', 'sum'], [2, 'qty', 'avg']] as const) {
    const door = (await post('dashboard:metric', { projectId: P, datasetId: s.liveId, column, aggregation })).value;
    ok(`Live KPI ${aggregation}(${column}) is the KPI door's figure`, typeof door.value === 'number' && Object.is(tile(r, id).figure.value, door.value), `${tile(r, id).figure?.value} vs ${door.value}`);
    ok(`Live KPI ${aggregation}(${column}) equals the extract's`, close13(tile(r, id).figure.value, tile(ext, id).figure.value), `${tile(r, id).figure.value} vs ${tile(ext, id).figure.value}`);
  }
  const chart = (await post('visual:data', { projectId: P, datasetId: s.liveId, encoding: { category: 'region', values: [{ column: 'amt', aggregation: 'sum' }] } })).value;
  const pv = tile(r, 3).preview?.data;
  const problems = pv && chart.data ? cmp.compareCharts({ labels: pv.labels, series: pv.series }, { labels: chart.data.labels, series: chart.data.series }, () => true, false) : ['no preview'];
  ok('Live chart preview equals visual:data on the Live dataset', problems.length === 0, problems.join(' | '));

  const control = await hydrates(s.extractId, () => H.as(H.ORG_A, () => H.datasets.getDataset(P, s.extractId)));
  ok('NEGATIVE CONTROL: the spy sees a hydrate it is pointed at', control.hydrated);

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
