// A chart measure that IS a formula metric — calculated AFTER totals, per cell.
//
// `Margin % = sum(profit) / sum(revenue)` by region must be each region's
// profit over each region's revenue. Every way this can be wrong draws a
// plausible chart, so each figure here is pinned three ways, over the real RPC
// route (the Live route harness: the parity fixture as an extract AND as a
// Live dataset behind the fake warehouse):
//
//   reference   the arithmetic done independently from the fixture rows
//   two paths   the chart door's grouped answer against the KPI resolver's
//               (`metric:values` under a filter on the same label) — two
//               implementations, `Object.is` where the totals are integers
//   live        the Live dataset's chart against the extract's, dated by the
//               warehouse, with `datasets.getDataset` never asked
//
// NEGATIVE CONTROLS: the mean of per-row ratios is NOT the measure (the bug the
// "after totals" rule exists for); one region's cell is not another's KPI; the
// hydration spy does record a hydrate; a formula over a non-sensitive column is
// not hidden by the share policy; a plain chart is untouched by the planner.
//
//   npm run build:ts && node scripts/test-metricMeasures.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, hydrates, post } from './liveRouteHarness';

const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const measures: typeof import('../src/analysis/metricMeasures') = require('../src/analysis/metricMeasures');

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
  // `metric:values` is the contract; `metric:value` (one metric under a scope) answers each id of it.
  const kpi = async (id: string, filters: unknown[]): Promise<number | null | undefined> =>
    ((await post('metric:values', { projectId: P, ids: [id], filters })).value as unknown as Reply[])[0]?.value as number | null | undefined;
  const eq = (column: string, value: unknown) => ({ type: 'filter', column, op: '=', value });
  const M = (name: string, metricId: string) => ({ column: name, aggregation: 'sum', metricId });

  // ── The independent arithmetic, from the fixture rows ──────────────────────
  const nums = (rs: (string | number | null)[][], c: number): number[] => rs.map((r) => r[c]).filter((v): v is number => typeof v === 'number');
  const sum = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);
  const inRegion = (label: string | number) => rows.filter((r) => (r[COL.region] ?? '') === label);
  const perRow = (label: string) => nums(inRegion(label).filter((r) => typeof r[COL.qty] === 'number' && r[COL.qty] !== 0).map((r) => [typeof r[COL.amt] === 'number' ? (r[COL.amt] as number) / (r[COL.qty] as number) : null]), 0);

  // ── 1. Integer totals: reference, and the two paths, with Object.is ────────
  const share = await save('Qty per row', X, { formula: 'sum(qty) / count(many)' });
  const enc = { category: 'region', values: [M('Qty per row', share)] };
  const c1 = await chart(X, enc);
  ok('a formula measure answers, one series named for the metric', c1.ok === true && c1.data.series.length === 1 && c1.data.series[0].name === 'Qty per row', show(c1));
  const labels: (string | number)[] = c1.ok ? c1.data.labels : [];
  ok('the axis is the category\'s own (4 regions and the empty one)', labels.length === 5 && labels.includes('West') && labels.includes(''), show(labels));
  for (const [i, label] of labels.entries()) {
    const got = c1.data.series[0].values[i] as number | null;
    const rs = inRegion(label);
    const want = (sum(nums(rs, COL.qty)) as number) / rs.length;
    ok(`"${label}": the cell is that region's total over that region's count (reference, Object.is)`, Object.is(got, want), show([got, want]));
    if (label === '') continue;
    const viaKpi = await kpi(share, [eq('region', label)]);
    ok(`"${label}": the chart door and the KPI resolver agree (Object.is)`, Object.is(got, viaKpi), show([got, viaKpi]));
  }
  {
    const west = c1.data.series[0].values[labels.indexOf('West')];
    const eastKpi = await kpi(share, [eq('region', 'East')]);
    ok('NEGATIVE CONTROL: one region\'s cell is not another region\'s KPI', !Object.is(west, eastKpi), show([west, eastKpi]));
  }

  // ── 2. The rule itself: a ratio of totals, never a mean of row ratios ──────
  const ratio = await save('Amt per qty', X, { formula: 'sum(amt) / sum(qty)' });
  const c2 = await chart(X, { category: 'region', values: [M('Amt per qty', ratio)] });
  for (const label of ['North', 'South', 'East', 'West']) {
    const got = c2.data.series[0].values[c2.data.labels.indexOf(label)] as number;
    const rs = inRegion(label);
    const want = (sum(nums(rs, COL.amt)) as number) / (sum(nums(rs, COL.qty)) as number);
    ok(`"${label}": sum(amt) / sum(qty) is the ratio of the region's totals`, cmp.sameNumber(got, want, true), show([got, want]));
    const rowRatios = perRow(label);
    const mean = (sum(rowRatios) as number) / rowRatios.length;
    ok(`"${label}": NEGATIVE CONTROL — the mean of per-row ratios is a different number`, !cmp.sameNumber(got, mean, true) && Math.abs(got - mean) > 1e-6, show([got, mean]));
  }

  // ── 3. Beside plain measures: order kept, plain figures untouched ──────────
  const plainEnc = { category: 'region', values: [{ column: 'amt', aggregation: 'sum' }, { column: 'many', aggregation: 'count' }] };
  const plain = await chart(X, plainEnc);
  const mixed = await chart(X, { category: 'region', values: [plainEnc.values[0], M('Qty per row', share), plainEnc.values[1]] });
  ok('three measures, three series, in the order asked', mixed.ok === true && mixed.data.series.map((x: Reply) => x.name).join('|') === 'sum of amt|Qty per row|many', show(mixed.data?.series?.map((x: Reply) => x.name)));
  ok('the plain measures beside it are the plain chart\'s figures (Object.is)', mixed.ok === true
    && mixed.data.series[0].values.every((v: number | null, i: number) => Object.is(v, plain.data.series[0].values[i]))
    && mixed.data.series[2].values.every((v: number | null, i: number) => Object.is(v, plain.data.series[1].values[i])), show([mixed.data?.series, plain.data?.series]));
  ok('the calculated series is the single-measure chart\'s (Object.is)', mixed.data.series[1].values.every((v: number | null, i: number) => Object.is(v, c1.data.series[0].values[i])));
  ok('NEGATIVE CONTROL: a chart with no metric measure is never planned', measures.hasMetricMeasure(plainEnc as never) === false
    && (await H.as(ORG_A, () => measures.planMetricMeasures(P, X, plainEnc as never))) === null);

  // ── 4. A referenced metric with its OWN filters: asked separately, lined up ─
  await save('Tier 3 qty', X, { column: 'qty', aggregation: 'sum' }, [eq('tier', 3)]);
  const mix = await save('Tier 3 share', X, { formula: '[Tier 3 qty] / sum(qty)' });
  const c4 = await chart(X, { category: 'region', values: [M('Tier 3 share', mix)] });
  for (const label of ['North', 'South', 'East', 'West']) {
    const got = c4.data.series[0].values[c4.data.labels.indexOf(label)] as number;
    const rs = inRegion(label);
    const want = (sum(nums(rs.filter((r) => r[COL.tier] === 3), COL.qty)) as number) / (sum(nums(rs, COL.qty)) as number);
    ok(`"${label}": a filtered operand over an unfiltered one (reference, Object.is)`, Object.is(got, want), show([got, want]));
    ok(`"${label}": … and the KPI resolver agrees (Object.is)`, Object.is(got, await kpi(mix, [eq('region', label)])));
  }

  // ── 5. Under a split: one grid per total, lined up by series name ──────────
  const c5 = await chart(X, { category: 'region', series: 'tier', values: [M('Qty per row', share)] });
  ok('a split draws one series per split value', c5.ok === true && c5.data.series.length >= 3, show(c5.data?.series?.map((x: Reply) => x.name)));
  for (const [label, tier] of [['North', 1], ['West', 3], ['East', 2]] as const) {
    const ser = c5.data.series.find((x: Reply) => x.name === String(tier));
    const got = ser ? ser.values[c5.data.labels.indexOf(label)] : undefined;
    const rs = inRegion(label).filter((r) => r[COL.tier] === tier);
    ok(`"${label}" × tier ${tier}: the cell's own totals (reference, Object.is)`, Object.is(got, (sum(nums(rs, COL.qty)) as number) / rs.length), show(got));
    ok(`"${label}" × tier ${tier}: the KPI resolver under both filters agrees`, Object.is(got, await kpi(share, [eq('region', label), eq('tier', tier)])));
  }

  // ── 6. What has no value has none — and what cannot be drawn says why ──────
  const a = await save('Loop A', X, { formula: '[Loop B] + 1' });
  await save('Loop B', X, { formula: '[Loop A] + 1' });
  const loop = await chart(X, { category: 'region', values: [M('Loop A', a)] });
  ok('a circular measure terminates, every cell null (never zero)', loop.ok === true && loop.data.labels.length === 5 && loop.data.series[0].values.every((v: unknown) => v === null), show(loop));
  const typo = await save('Typo', X, { formula: '[No such metric] * 2' });
  const none = await chart(X, { category: 'region', values: [M('Typo', typo)] });
  ok('an unknown operand is null per cell, the axis still drawn', none.ok === true && none.data.labels.length === 5 && none.data.series[0].values.every((v: unknown) => v === null), show(none));
  const gone = await chart(X, { category: 'region', values: [{ column: 'amt', aggregation: 'sum', metricId: '3f0c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b' }] });
  ok('a measure whose metric is gone plots its stored column, as before', gone.ok === true && gone.data.series[0].values.every((v: number | null, i: number) => Object.is(v, plain.data.series[0].values[i])));
  const simple = await save('Sales', X, { column: 'amt', aggregation: 'sum' });
  const asStored = await chart(X, { category: 'region', values: [{ column: 'amt', aggregation: 'sum', metricId: simple }] });
  ok('a SIMPLE metric measure plots its stored column, as before', asStored.ok === true && asStored.data.series[0].name === 'sum of amt' && asStored.data.series[0].values.every((v: number | null, i: number) => Object.is(v, plain.data.series[0].values[i])));
  const onLive = await save('Live ratio', L, { formula: 'sum(amt) / sum(qty)' });
  const foreign = await chart(X, { category: 'region', values: [M('Live ratio', onLive)] });
  ok('a metric measured on another dataset is refused with a sentence, not drawn', foreign.ok === false && /another dataset/.test(String(foreign.error)), show(foreign));
  const facets = await chart(X, { category: 'region', values: [M('Qty per row', share)], facet: { rows: 'tier' } });
  ok('small multiples are refused with a sentence', facets.ok === false && /small multiples/.test(String(facets.error)), show(facets));
  const broken = await save('Broken', X, { formula: 'sum(amt) /' });
  const bad = await chart(X, { category: 'region', values: [M('Broken', broken)] });
  ok('a saved formula that does not compile says so, by name', bad.ok === false && /“Broken” cannot be calculated/.test(String(bad.error)), show(bad));

  // ── 7. Live: the warehouse totals, the same figures, never hydrated ────────
  const liveChart = await hydrates(L, () => chart(L, { category: 'region', values: [M('Live ratio', onLive)] }));
  const l = liveChart.value;
  ok('Live: the calculated measure answers, dated by the warehouse', l.ok === true && l.asOf?.mode === 'live' && l.data.series[0].name === 'Live ratio', show(l));
  ok('Live: the dataset is never hydrated', liveChart.hydrated === false);
  {
    const problems = l.ok ? cmp.compareCharts({ labels: c2.data.labels, series: [{ name: 'x', values: c2.data.series[0].values }] }, { labels: l.data.labels, series: [{ name: 'x', values: l.data.series[0].values }] }, () => true, false) : ['no reply'];
    ok('Live: every cell equals the extract\'s (within the documented 1e-13)', problems.length === 0, problems.join(' | '));
  }
  const liveCheck = await hydrates(L, async () => (await post('metric:check', { projectId: P, datasetId: L, expression: 'sum(amt) / sum(qty)', name: 'Unsaved', chart: true })).value);
  const extractCheck = (await post('metric:check', { projectId: P, datasetId: X, expression: 'sum(amt) / sum(qty)', name: 'Unsaved' })).value;
  ok('Live: the editor\'s preview is the warehouse\'s figure, dated live, equal to the extract\'s', liveCheck.value.ok === true && liveCheck.value.preview?.ok === true
    && liveCheck.value.preview.asOf?.mode === 'live' && cmp.sameNumber(liveCheck.value.preview.value, extractCheck.preview?.value, true) && typeof liveCheck.value.preview.value === 'number', show([liveCheck.value, extractCheck]));
  ok('Live: the editor\'s check never hydrates', liveCheck.hydrated === false);
  {
    const from = hydrated.length;
    await H.as(ORG_A, () => H.datasets.getDataset(P, X));
    ok('NEGATIVE CONTROL: the hydration spy records a hydrate', hydrated.slice(from).includes(X));
  }

  // ── 8. The share policy is shown the columns a formula totals ──────────────
  await H.as(ORG_A, async () => {
    await catalog.setColumn(P, X, 'amt', { sensitivity: 'financial' });
    await privacy.setPolicy(P, { export: 'drop' });
  });
  const hidden = await chart(X, { category: 'region', values: [M('Amt per qty', ratio)] }, { share: 'export' });
  ok('export/drop: a formula over a sensitive column is hidden by the policy', hidden.ok === false && hidden.hiddenByPolicy === true, show(hidden));
  const shown = await chart(X, { category: 'region', values: [M('Qty per row', share)] }, { share: 'export' });
  ok('NEGATIVE CONTROL: a formula over other columns still exports', shown.ok === true && shown.data.series[0].values.length === 5, show(shown));

  // ── 9. A duplicate name is refused beside the Name field ───────────────────
  const dup = (await post('metric:save', { projectId: P, input: { name: 'qty PER row', datasetId: X, definition: { formula: 'sum(qty)' } } })).value;
  ok('a duplicate name is refused with the sentence and its field', dup.ok === false && dup.field === 'name' && /already exists/.test(String(dup.error)), show(dup));

  await close();
  finish();
})().catch((err) => {
  ok('test-metricMeasures ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
