// `visual:drillDown` on a Live dataset (part 6 D4, D11), over the real RPC route against the fake warehouse.
// test-drillDown's § live, in its own file: the Live bench is a server-mode process, test-drillDown a local one.
//
//   cost       a tile drawn by month is one statement; drilling one of its months costs ZERO more (the grain lookup
//              is the tile's own cached question); the drilled chart costs one. NEGATIVE CONTROL: a drill on a chart
//              that was never drawn pays its one lookup, so the zero above is a cache hit, not a counter that stays still
//   rows       `datasets.getDataset` is never asked for the Live dataset, throughout
//   parity     the Live drill's steps and encoding are the extract's, and its drilled chart's labels and figures are
//              the extract's (Object.is: whole-number sums and counts)
//
//   npm run build:ts && node scripts/test-drillDownLive.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, hydrates, post } from './liveRouteHarness';

const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');

const { fake, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x)).slice(0, 400);
const BY_MONTH = { category: 'd', grain: 'month', values: [{ column: 'qty', aggregation: 'sum' }, { column: 'qty', aggregation: 'count' }] };

(async () => {
  const s = await H.setupOrg(ORG_A);
  const { projectId: P, liveId: L, extractId: X } = s;
  const viz = (d: string, encoding: unknown, filters: unknown[] = []) => post('visual:data', { projectId: P, datasetId: d, encoding, filters });
  const drill = (d: string, encoding: unknown, category: unknown) => post('visual:drillDown', { projectId: P, datasetId: d, encoding, mark: { category } });
  let touched = false;
  const spied = async <T>(fn: () => Promise<T>): Promise<T> => {
    const r = await hydrates(L, fn);
    touched ||= r.hydrated;
    return r.value;
  };

  // ── cost ─────────────────────────────────────────────────────────────────
  const at0 = fake.calls.length;
  const tile = await spied(() => viz(L, BY_MONTH));
  ok('the Live tile by month draws, in one statement', tile.status === 200 && tile.value.ok === true && tile.value.data.labels.includes('2024-03') && fake.calls.length === at0 + 1, show([tile.value, fake.calls.length - at0]));
  const at1 = fake.calls.length;
  const dr = await spied(() => drill(L, BY_MONTH, '2024-03'));
  ok('drilling a month of it costs no statement: the grain lookup is the tile\'s cached answer', dr.status === 200 && dr.value.available === true && dr.value.encoding.grain === 'day' && fake.calls.length === at1, show([dr.value, fake.calls.length - at1]));
  const drawn = await spied(() => viz(L, dr.value.encoding, dr.value.steps));
  ok('the drilled chart costs one statement', drawn.value.ok === true && drawn.value.asOf?.mode === 'live' && fake.calls.length === at1 + 1, show([drawn.value, fake.calls.length - at1]));
  const at2 = fake.calls.length;
  const cold = await spied(() => drill(L, { ...BY_MONTH, values: [{ column: 'tier', aggregation: 'sum' }] }, '2024-03'));
  ok('NEGATIVE CONTROL: a drill on a chart never drawn pays its one grain lookup', cold.value.available === true && fake.calls.length === at2 + 1, show([cold.value, fake.calls.length - at2]));
  ok('rows: getDataset was never asked for the Live dataset', !touched);

  // ── parity ───────────────────────────────────────────────────────────────
  const xd = await drill(X, BY_MONTH, '2024-03');
  ok('parity: the Live drill\'s steps, encoding and crumb are the extract\'s', JSON.stringify([xd.value.steps, xd.value.encoding, xd.value.crumb]) === JSON.stringify([dr.value.steps, dr.value.encoding, dr.value.crumb]), show([xd.value, dr.value]));
  const xc = await viz(X, xd.value.encoding, xd.value.steps);
  const chartOf = (r: { data: { labels: unknown[]; series: { name: string; values: unknown[] }[] } }) => ({ labels: r.data.labels, series: r.data.series.map((se) => ({ name: se.name, values: se.values })) }) as import('./liveParityCompare').ChartLike;
  const problems = xc.value.ok === true && drawn.value.ok === true ? cmp.compareCharts(chartOf(xc.value as never), chartOf(drawn.value as never), () => false, false) : ['a side did not draw'];
  ok('parity: the drilled chart\'s labels and figures are the extract\'s, row for row (Object.is)', problems.length === 0 && drawn.value.data.labels.length > 1, problems.join(' | '));

  await close();
})()
  .catch((e) => ok('no exception', false, e && e.stack))
  .finally(() => finish());
