// A chart measure that names a saved metric draws the metric as it is defined NOW (semantic D16): its column, its
// aggregation and its own filters, not the copy the chart stored when the measure was picked. The copy is only the
// fallback for a metric that is gone.
//
// Pinned over the real RPC route (the Live route harness: the parity fixture as an extract AND as a Live dataset):
//
//   reference   the arithmetic done independently from the fixture rows
//   two paths   the chart door's cell against the KPI resolver's (`metric:values` under the label's filter)
//   resident    the same chart with the bridge off (the JS reference), byte for byte
//   live        the Live dataset's chart against the extract's, never hydrated
//
// NEGATIVE CONTROLS: the unfiltered column is a different figure; a metric with nothing to follow draws byte-identically
// and is never planned; a sensitive column the metric no longer totals is not hidden by the share policy.
//
//   npm run build:ts && node scripts/test-chartsFollowMetric.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrates, post } from './liveRouteHarness';

const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const measures: typeof import('../src/analysis/metricMeasures') = require('../src/analysis/metricMeasures');
const vmm: typeof import('../src/ipc/vizMetricMeasures') = require('../src/ipc/vizMetricMeasures');

const { ORG_A, fx } = H;
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x)).slice(0, 500);
const COL = { region: 2, amt: 3, qty: 4, tier: 5 } as const;

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const X = s.extractId;
  const L = s.liveId;
  duck.forbidSyncOnMainThread();
  const rows = fx.importTyped(fx.COLUMNS, fx.fixtureRows()).rows;

  const save = async (name: string, datasetId: string, definition: unknown, filters: unknown[] = []): Promise<string> => {
    const r = (await post('metric:save', { projectId: P, input: { name, datasetId, definition, filters } })).value;
    if (!r.ok) throw new Error(`metric "${name}" not saved: ${show(r)}`);
    return r.metric.id as string;
  };
  const chart = async (datasetId: string, encoding: unknown, extra: Record<string, unknown> = {}): Promise<Reply> =>
    (await post('visual:data', { projectId: P, datasetId, encoding, ...extra })).value;
  const kpi = async (id: string, filters: unknown[]): Promise<number | null | undefined> =>
    ((await post('metric:values', { projectId: P, ids: [id], filters })).value as unknown as Reply[])[0]?.value as number | null | undefined;
  const eq = (column: string, value: unknown) => ({ type: 'filter', column, op: '=', value });

  // ── The independent arithmetic, from the fixture rows ──────────────────────
  const nums = (rs: (string | number | null)[][], c: number): number[] => rs.map((r) => r[c]).filter((v): v is number => typeof v === 'number');
  const sum = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);
  const inRegion = (label: string | number) => rows.filter((r) => (r[COL.region] ?? '') === label);
  const tierQty = (label: string | number, tier: number) => sum(nums(inRegion(label).filter((r) => r[COL.tier] === tier), COL.qty));

  // ── 1. A simple metric with its own filter: the filter applies ─────────────
  const t3 = await save('Tier 3 qty', X, { column: 'qty', aggregation: 'sum' }, [eq('tier', 3)]);
  const enc3 = { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: t3 }] };
  const c = await chart(X, enc3);
  ok('a filtered simple metric draws', c.ok === true && c.data.labels.length > 0, show(c));
  for (const [i, label] of (c.ok ? c.data.labels : []).entries()) {
    const want = tierQty(label, 3);
    ok(`"${label}": the metric's filter applies (reference, Object.is)`, Object.is(c.data.series[0].values[i], want), show([c.data.series[0].values[i], want]));
    if (label !== '') ok(`"${label}": equals the metric's KPI tile (Object.is)`, Object.is(c.data.series[0].values[i], await kpi(t3, [eq('region', label)])));
  }
  ok('the series keeps the plain measure\'s name', c.data?.series?.[0]?.name === 'sum of qty', show(c.data?.series));
  const plainQty = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum' }] });
  ok('NEGATIVE CONTROL: the unfiltered column is a different figure', JSON.stringify(c.data) !== JSON.stringify(plainQty.data));

  // ── 2. Nothing to follow: byte-identical, never planned ────────────────────
  const sales = await save('Sales', X, { column: 'qty', aggregation: 'sum' });
  const same = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: sales }] });
  ok('an unfiltered, unedited metric draws byte-identically', JSON.stringify(same.data) === JSON.stringify(plainQty.data) && JSON.stringify(same.warnings) === JSON.stringify(plainQty.warnings), show([same, plainQty]));
  ok('… and the planner returns null for it', (await H.as(ORG_A, () => measures.planMetricMeasures(P, X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: sales }] } as never))) === null);

  // ── 3. Edited since the chart was made: the stored copy says amt, the metric says qty ─
  const edited = await chart(X, { category: 'region', values: [{ column: 'amt', aggregation: 'sum', metricId: sales }] });
  ok('a chart follows an edit to its metric', JSON.stringify(edited.data) === JSON.stringify(plainQty.data), show([edited.data, plainQty.data]));

  // ── 4. Two measures, two metric filter lists, one plain beside them ────────
  const t1 = await save('Tier 1 qty', X, { column: 'qty', aggregation: 'sum' }, [eq('tier', 1)]);
  const threeEnc = { category: 'region', values: [enc3.values[0], { column: 'qty', aggregation: 'sum', metricId: t1 }, { column: 'amt', aggregation: 'sum' }] };
  const two = await chart(X, threeEnc);
  const plainAmt = await chart(X, { category: 'region', values: [{ column: 'amt', aggregation: 'sum' }] });
  ok('three measures draw', two.ok === true && two.data.series.length === 3, show(two));
  for (const [i, label] of (two.ok ? two.data.labels : []).entries()) {
    ok(`"${label}": series 0 is its tier-3 total (reference, Object.is)`, Object.is(two.data.series[0].values[i], tierQty(label, 3)), show([two.data.series[0].values[i], tierQty(label, 3)]));
    ok(`"${label}": series 1 is its tier-1 total (reference, Object.is)`, Object.is(two.data.series[1].values[i], tierQty(label, 1)), show([two.data.series[1].values[i], tierQty(label, 1)]));
    const at = plainAmt.data.labels.indexOf(label);
    ok(`"${label}": series 2 is the plain amt chart's cell (Object.is)`, at >= 0 && Object.is(two.data.series[2].values[i], plainAmt.data.series[0].values[at]));
  }
  ok('each measure keeps its own name', two.data?.series?.map((x: Reply) => x.name).join('|') === 'sum of qty|sum of qty|sum of amt', show(two.data?.series?.map((x: Reply) => x.name)));

  // ── 5. Editing the metric changes the chart on the next draw ───────────────
  const upd = (await post('metric:update', { projectId: P, id: t3, patch: { filters: [eq('tier', 2)] } })).value;
  ok('the metric is edited', upd.ok === true, show(upd));
  const after = await chart(X, enc3);
  ok('the edited chart draws', after.ok === true && after.data.labels.length > 0, show(after));
  for (const [i, label] of (after.ok ? after.data.labels : []).entries()) {
    ok(`"${label}": after the edit, the tier-2 total (reference, Object.is)`, Object.is(after.data.series[0].values[i], tierQty(label, 2)), show([after.data.series[0].values[i], tierQty(label, 2)]));
  }

  // ── 6. Small multiples ─────────────────────────────────────────────────────
  const f1 = await chart(X, { ...enc3, facet: { rows: 'cat' } });
  const f0 = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum' }], facet: { rows: 'cat' } }, { filters: [eq('tier', 2)] });
  ok('a faceted chart with one filtered metric draws, equal to the hand-filtered chart', f1.ok === true && f0.ok === true && JSON.stringify(f1.data) === JSON.stringify(f0.data), show([f1, f0]));
  const f2 = await chart(X, { ...threeEnc, facet: { rows: 'cat' } });
  ok('measures with different metric filters on small multiples are refused with the sentence', f2.ok === false && /small multiples/.test(String(f2.error)), show(f2));

  // ── 7. Resident ≡ JS, byte for byte ────────────────────────────────────────
  {
    const twice = async (enc: unknown): Promise<{ fast: { value: Reply; hydrated: boolean }; slow: { value: Reply; hydrated: boolean } }> => {
      await H.as(ORG_A, async () => H.queryCache.invalidateDataset(X, P));
      const fast = await hydrates(X, () => chart(X, enc));
      // The chart door's fast path asks `residentSource` (residentQuery.isResident is not on this path): withheld, it hydrates.
      const realResident = H.datasets.residentSource;
      (H.datasets as { residentSource: typeof realResident }).residentSource = async () => null;
      try {
        await H.as(ORG_A, async () => H.queryCache.invalidateDataset(X, P));
        return { fast, slow: await hydrates(X, () => chart(X, enc)) };
      } finally {
        (H.datasets as { residentSource: typeof realResident }).residentSource = realResident;
      }
    };
    for (const [name, enc] of [['one filtered metric', enc3], ['three measures', threeEnc]] as const) {
      const { fast, slow } = await twice(enc);
      ok(`resident ≡ JS (${name}): the fast draw never hydrated, the slow one did`, fast.hydrated === false && slow.hydrated === true, show([fast.hydrated, slow.hydrated]));
      ok(`resident ≡ JS (${name}): the same data, byte for byte`, fast.value.ok === true && JSON.stringify(slow.value.data) === JSON.stringify(fast.value.data), show([fast.value.data, slow.value.data]));
    }
  }

  // ── 8. Live: the same metric on L ──────────────────────────────────────────
  const t3L = await save('Tier 3 qty live', L, { column: 'qty', aggregation: 'sum' }, [eq('tier', 3)]);
  const lv = await hydrates(L, () => chart(L, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: t3L }] }));
  ok('Live: answered by the warehouse, never hydrated', lv.value.ok === true && lv.value.asOf?.mode === 'live' && lv.hydrated === false, show(lv));
  {
    const ext = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum' }] }, { filters: [eq('tier', 3)] });
    const problems = lv.value.ok && ext.ok ? cmp.compareCharts({ labels: ext.data.labels, series: ext.data.series }, { labels: lv.value.data.labels, series: lv.value.data.series }, () => true, false) : ['no reply'];
    ok('Live: every cell equals the extract\'s tier-3 chart', problems.length === 0, problems.join(' | '));
  }
  const bad = await save('Qty contains', L, { column: 'qty', aggregation: 'sum' }, [{ type: 'filter', column: 'qty', op: 'contains', value: '1' }]);
  const refused = await chart(L, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: bad }] });
  ok('Live: a metric filter the compiler refuses is a typed refusal', refused.ok === false && refused.code === 'live_refused', show(refused));

  // ── 9. No loop: the follow path's inner question names no metric ───────────
  {
    const res = await H.as(ORG_A, () => measures.planMetricMeasures(P, X, enc3 as never));
    const asked: { e: import('../src/analysis/visuals').VizEncoding; f: unknown }[] = [];
    const capture = async (e: (typeof asked)[number]['e'], f: unknown) => {
      asked.push({ e, f });
      return { ok: false as const, error: 'captured' };
    };
    if (res && res.ok) await vmm.followMetricMeasures(res, enc3 as never, [], capture);
    ok('the inner question carries the metric\'s filter and the followed measure, without its metricId', show(asked) === show([{ e: { category: 'region', values: [{ column: 'qty', aggregation: 'sum' }] }, f: [eq('tier', 2)] }]), show(asked));
    ok('… so the planner returns null for it', asked.length === 1 && (await H.as(ORG_A, () => measures.planMetricMeasures(P, X, asked[0].e))) === null);
  }

  // ── 10. Table calcs are judged on the metric as it is now (PR 02's additivity) ─
  const RT = { kind: 'running_total', along: 'across' };
  const avgQty = await save('Avg qty', X, { column: 'qty', aggregation: 'avg' });
  const avgRT = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: avgQty, calc: RT }] });
  ok('a running total of a metric edited to an average is refused, whatever its stored copy says', avgRT.ok === false && avgRT.code === 'calc_not_additive', show(avgRT));
  const sumRT = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'avg', metricId: sales, calc: RT }] });
  ok('NEGATIVE CONTROL: a running total of a metric that now sums draws, though its stored copy says avg', sumRT.ok === true && sumRT.data.series[0].values.length === 5, show(sumRT));
  // The year-over-year caption adds the months: an average gets the series and no caption (visualsOverlay).
  const overlay = (metricId: string, aggregation: string) => chart(X, { category: 'd', grain: 'month', overlay: 'previous_year', values: [{ column: 'qty', aggregation, metricId }] });
  const avgOverlay = await overlay(avgQty, 'sum');
  ok('an overlay of a metric edited to an average has no "up n%" caption, whatever its stored copy says', avgOverlay.ok === true && avgOverlay.overlay?.kind === 'previous_year' && avgOverlay.overlay.caption === undefined, show(avgOverlay.overlay));
  const sumOverlay = await overlay(sales, 'avg');
  ok('NEGATIVE CONTROL: an overlay of a metric that now sums has its caption, though its stored copy says avg', sumOverlay.ok === true && typeof sumOverlay.overlay?.caption === 'string', show(sumOverlay.overlay));

  // ── 11. A snapshot metric is refused until step 07 ─────────────────────────
  const stock = (await H.as(ORG_A, () => metricsMod.saveMetric(P, { name: 'Stock', datasetId: X, definition: { column: 'qty', aggregation: 'sum', snapshot: { column: 'd', take: 'last' } } })))!;
  const snapEnc = { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: stock.id }] };
  ok('a snapshot metric is refused until step 07', (await chart(X, snapEnc)).ok === false);
  const snapPlan = await H.as(ORG_A, () => measures.planMetricMeasures(P, X, snapEnc as never));
  ok('… and the planner refuses it with the sentence (no copy is followed)', !!snapPlan && snapPlan.ok === false && snapPlan.error === msg.measureSnapshotPending('Stock'), show(snapPlan));

  // ── 12. The share policy follows the edit ──────────────────────────────────
  await H.as(ORG_A, async () => {
    await catalog.setColumn(P, X, 'amt', { sensitivity: 'financial' });
    await privacy.setPolicy(P, { export: 'drop' });
  });
  const amtTotal = await save('Amt total', X, { column: 'amt', aggregation: 'sum' });
  const hidden = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: amtTotal }] }, { share: 'export' });
  ok('export/drop: a metric now over a sensitive column is hidden, whatever its stored copy says', hidden.ok === false && hidden.hiddenByPolicy === true, show(hidden));
  const shown = await chart(X, { category: 'region', values: [{ column: 'amt', aggregation: 'sum', metricId: sales }] }, { share: 'export' });
  ok('NEGATIVE CONTROL: a metric now over qty still exports, though its stored copy says amt', shown.ok === true && shown.data.series[0].values.length === 5, show(shown));

  await close();
  finish();
})().catch((err) => {
  ok('test-chartsFollowMetric ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
