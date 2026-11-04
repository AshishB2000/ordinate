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
const { followedMeasureTexts }: typeof import('../src/ipc/copilotMeasures') = require('../src/ipc/copilotMeasures');
const visualStore: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const planPreview: typeof import('../src/analysis/planPreview') = require('../src/analysis/planPreview');
const { buildDashboard }: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const { buildStory }: typeof import('../src/publish/storyData') = require('../src/publish/storyData');
const { randomUUID }: typeof import('crypto') = require('crypto');

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

  // ── 5a. The rows behind a bar carry the metric's filters (the drill's "Show the rows") ─
  // enc3's metric now filters tier = 2 (section 5), so the rows behind West's bar are West's tier-2 rows.
  const drill = (enc: unknown): Promise<Reply> => post('visual:rows', { projectId: P, datasetId: X, encoding: enc, filters: [], mark: { category: 'West' } }).then((r) => r.value);
  const rows2 = await drill(enc3);
  ok('drill: the metric\'s filter is in the row scope', rows2.ok && rows2.filters.some((f: Reply) => f.column === 'tier' && f.value === 2), show(rows2.filters));
  ok('drill: the count is the rows behind the bar', rows2.total === inRegion('West').filter((r) => r[COL.tier] === 2).length, show([rows2.total, inRegion('West').length]));
  const plainRows = await drill({ category: 'region', values: [{ column: 'qty', aggregation: 'sum' }] });
  ok('NEGATIVE CONTROL: a plain chart\'s drill has no tier filter', plainRows.ok && !plainRows.filters.some((f: Reply) => f.column === 'tier'), show(plainRows.filters));
  ok('NEGATIVE CONTROL: and lists all of West\'s rows', plainRows.total === inRegion('West').length, show(plainRows.total));
  const perMeasureRows = await drill(threeEnc);
  ok('a per-measure chart keeps today\'s rows: no one set of rows adds up to two filter lists', perMeasureRows.ok && !perMeasureRows.filters.some((f: Reply) => f.column === 'tier') && perMeasureRows.total === inRegion('West').length, show(perMeasureRows.filters));

  // A dated axis asks the chart for its grain (the tile's cached answer): the month's rows still carry the metric's filter.
  const dated = { category: 'd', grain: 'month', values: [enc3.values[0]] };
  const month = await chart(X, dated);
  const monthRows = await post('visual:rows', { projectId: P, datasetId: X, encoding: dated, filters: [], mark: { category: month.ok ? month.data.labels[0] : '' } }).then((r) => r.value);
  ok('drill on a month: the metric\'s filter and the month\'s range are both in the row scope', month.ok && monthRows.available === true && monthRows.filters.some((f: Reply) => f.column === 'tier' && f.value === 2) && monthRows.filters.some((f: Reply) => f.column === 'd'), show(monthRows.reason ?? monthRows.filters));

  // ── 6. Small multiples ─────────────────────────────────────────────────────
  const f1 = await chart(X, { ...enc3, facet: { rows: 'cat' } });
  const f0 = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum' }], facet: { rows: 'cat' } }, { filters: [eq('tier', 2)] });
  ok('a faceted chart with one filtered metric draws, equal to the hand-filtered chart', f1.ok === true && f0.ok === true && JSON.stringify(f1.data) === JSON.stringify(f0.data), show([f1, f0]));
  const f2 = await chart(X, { ...threeEnc, facet: { rows: 'cat' } });
  ok('measures with different metric filters on small multiples are refused with the sentence', f2.ok === false && /small multiples/.test(String(f2.error)), show(f2));

  // ── 6a. The accepted refusal: parts that need separate questions cannot share a folded or binned axis ─
  // A filtered metric beside a plain measure asks two questions (section 4); "Other" keeps the top 50 BY THE FIRST
  // MEASURE and bins span the filtered range, so the two answers would not line up (vizMetricMeasures' ponytail).
  const folded = (values: unknown[], category: string) => chart(X, { category, values });
  const plainAmtMeasure = { column: 'amt', aggregation: 'sum' };
  for (const [what, category, shows] of [['a text axis folded into "Other"', 'many', 'note'], ['a binned numeric axis', 'qty', 'binned']] as const) {
    const both = await folded([enc3.values[0], plainAmtMeasure], category);
    ok(`${what}: a filtered metric beside a plain measure is refused with the sentence`, both.ok === false && both.error === msg.measureNeedsOneAxis('sum of qty'), show(both));
    const alone = await folded([enc3.values[0]], category);
    ok(`NEGATIVE CONTROL (${what}): the same chart with only the filtered metric draws`, alone.ok === true && alone.data.labels.length > 0, show(alone));
    ok(`NEGATIVE CONTROL (${what}): … and its axis really is ${shows === 'note' ? 'folded' : 'binned'}`, alone.ok === true && !!alone.category?.[shows], show(alone.category));
  }

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

  // ── 11. Every other surface judges the calc on the measure it draws ────────
  // A sum metric with a running total, edited to avg: every surface draws the avg (the door follows), so each refuses.
  const edits = await save('Qty total', X, { column: 'qty', aggregation: 'sum' });
  const rtVisual = async (name: string, metricId: string) => (await H.as(ORG_A, () => visualStore.saveVisual(P, { datasetId: X, name, chartType: 'column',
    encoding: { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId, calc: RT }] } } as never)))!;
  const editedV = await rtVisual('Edited to avg', edits);
  const keptV = await rtVisual('Still summed', sales);
  const toAvg = (await post('metric:update', { projectId: P, id: edits, patch: { definition: { column: 'qty', aggregation: 'avg' } } })).value;
  ok('the metric is edited to an average', toAvg.ok === true, show(toAvg));
  const refusal = msg.calcNotAdditive('Qty total', 'a running total');
  {
    const dash = (await H.as(ORG_A, () => analysisStore.saveAnalysis(P, { name: 'Follows', sheets: [{ id: randomUUID(), name: 'Main',
      cards: [editedV, keptV].map((v, i) => ({ id: randomUUID(), type: 'visual', visualId: v.id, layout: { x: 6 * i, y: 0, w: 6, h: 4 } })) }] } as never)))!;
    const built = await H.as(ORG_A, () => buildDashboard(P, dash.id, 1));
    const [ec, kc] = built?.sheets[0].cards ?? [];
    const payload = (c: Reply | undefined) => (c ? c.payloads[c.variants[0]] : undefined) as Reply | undefined;
    ok('/p/: the edited tile is built as the refusal', show(payload(ec)) === show({ error: refusal }), show(payload(ec)));
    ok('NEGATIVE CONTROL: /p/ builds the tile over a metric still summed', kc?.kind === 'chart' && payload(kc)?.error === undefined && Array.isArray(payload(kc)?.series), show(payload(kc)));
  }
  {
    const story = (await H.as(ORG_A, () => stories.saveStory(P, { name: 'Follows', blocks: [editedV, keptV].map((v) => ({ id: randomUUID(), kind: 'visual', visualId: v.id, filters: [] })) })))!;
    const told = await H.as(ORG_A, () => buildStory(P, story.id));
    ok('a story: the edited block is broken with the refusal', told?.blocks[0].kind === 'broken' && told.blocks[0].reason === refusal, show(told?.blocks[0]));
    ok('NEGATIVE CONTROL: a story keeps the block over a metric still summed', told?.blocks[1].kind === 'chart', show(told?.blocks[1]));
  }
  {
    const previewOf = (v: { encoding: unknown }) => post('visual:preview', { projectId: P, datasetId: X, encoding: v.encoding }).then((r) => r.value);
    const ep = await previewOf(editedV);
    ok('the builder preview refuses the edited chart', ep.ok === false && ep.code === 'calc_not_additive' && ep.error === refusal, show(ep));
    const kp = await previewOf(keptV);
    ok('NEGATIVE CONTROL: the builder preview draws the chart over a metric still summed', kp.ok === true && kp.data.series[0].values.length === 5, show(kp));
  }
  {
    const factsOf = (id: string) => H.as(ORG_A, () => ipcCopilot.buildFacts(P, { kind: 'visual', id }));
    const calcRead = (f: { text: string; ledger: Array<{ label: string }> }) => f.text.includes('before that calculation') || f.ledger.some((e) => e.label.includes('before the calculation'));
    const ef = await factsOf(editedV.id);
    ok('the Assistant never reads the refused calculation', !calcRead(ef), ef.text.slice(0, 400));
    ok('… and is told the measure as drawn, not the stored copy', ef.text.includes('Measures: avg(qty)'), ef.text.slice(0, 400));
    const kf = await factsOf(keptV.id);
    ok('NEGATIVE CONTROL: the Assistant reads the calculation over a metric still summed', calcRead(kf), kf.text.slice(0, 400));
  }
  {
    const planOf = (name: string) => H.as(ORG_A, () => planPreview.previewPlan(P, { name: 'Plan', sheets: [{ name: 'S', visuals: [{ visual: name }] }] }));
    const ev = (await planOf('Edited to avg')).sheets[0]?.visuals[0];
    ok('the plan preview refuses the edited chart', ev?.kind === 'existing' && ev.data === null && ev.note === refusal, show(ev));
    const kv = (await planOf('Still summed')).sheets[0]?.visuals[0];
    ok('NEGATIVE CONTROL: the plan preview draws the chart over a metric still summed', kv?.kind === 'existing' && kv.data !== null && kv.data.series[0].values.length === 5, show(kv));
  }

  // ── 11a. The Assistant is told a followed metric by its name and its filters ─
  // `sum(qty)` alone would let the model narrate tier-2 figures as the total.
  {
    const west = await save('West qty', X, { column: 'qty', aggregation: 'sum' }, [eq('region', 'West')]);
    const mk = (name: string, values: unknown[]) => H.as(ORG_A, () => visualStore.saveVisual(P, { datasetId: X, name, chartType: 'column', encoding: { category: 'tier', values } } as never)).then((v) => v!);
    const measuresOf = async (id: string): Promise<string> => /Measures: ([^\n]*)\./.exec((await H.as(ORG_A, () => ipcCopilot.buildFacts(P, { kind: 'visual', id }))).text)?.[1] ?? '';
    const filtered = await mk('Facts filtered', [{ column: 'qty', aggregation: 'sum', metricId: t3 }]);
    ok('facts: a followed simple metric is its name, its definition and its filters', (await measuresOf(filtered.id)) === '"Tier 3 qty" = sum(qty) where tier = 2', await measuresOf(filtered.id));
    const quotedV = await mk('Facts quoted', [{ column: 'qty', aggregation: 'sum', metricId: west }]);
    ok('facts: a text cell value is quoted, as the other facts quote data', (await measuresOf(quotedV.id)) === '"West qty" = sum(qty) where region = "West"', await measuresOf(quotedV.id));
    const mixed = await mk('Facts mixed', [{ column: 'qty', aggregation: 'sum', metricId: t3 }, { column: 'amt', aggregation: 'avg' }]);
    ok('facts: a measure with no metric keeps its line byte for byte', (await measuresOf(mixed.id)) === '"Tier 3 qty" = sum(qty) where tier = 2, avg(amt)', await measuresOf(mixed.id));
    const plainV = await mk('Facts plain', [{ column: 'qty', aggregation: 'sum' }]);
    ok('NEGATIVE CONTROL: a plain measure is the bare line', (await measuresOf(plainV.id)) === 'sum(qty)', await measuresOf(plainV.id));
    const bareV = await mk('Facts unfiltered metric', [{ column: 'amt', aggregation: 'sum', metricId: sales }]);
    ok('NEGATIVE CONTROL: a followed metric with no filters is the bare line of what it draws', (await measuresOf(bareV.id)) === 'sum(qty)', await measuresOf(bareV.id));
    const marked = await H.as(ORG_A, () => followedMeasureTexts(P, X, filtered.encoding, { tier: { sensitivity: 'personal' } }));
    ok('facts: a filter on a withheld column names the column and not the value', marked[0] === '"Tier 3 qty" = sum(qty) where tier (withheld)', show(marked));
  }

  // ── 12. A snapshot metric is refused until step 07 ─────────────────────────
  const stock = (await H.as(ORG_A, () => metricsMod.saveMetric(P, { name: 'Stock', datasetId: X, definition: { column: 'qty', aggregation: 'sum', snapshot: { column: 'd', take: 'last' } } })))!;
  const snapEnc = { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: stock.id }] };
  ok('a snapshot metric is refused until step 07', (await chart(X, snapEnc)).ok === false);
  const snapPlan = await H.as(ORG_A, () => measures.planMetricMeasures(P, X, snapEnc as never));
  ok('… and the planner refuses it with the sentence (no copy is followed)', !!snapPlan && snapPlan.ok === false && snapPlan.error === msg.measureSnapshotPending('Stock'), show(snapPlan));

  // ── 13. The share policy follows the edit ──────────────────────────────────
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
