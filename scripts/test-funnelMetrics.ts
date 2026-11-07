// Funnel metrics (semantic layer part 5, step 08: D5, D6, D7) — "Visit → buy" as a metric: its conversion rate, the
// converted or the entered count, from the funnel grid's own matching. The scope (a tile's filters, controls, terms)
// picks WHO ENTERS; the metric's own filters and the row lock pick which events count.
//
//   kpi    the figure through the chart door: the grid's counts with no scope, the JS reference (Object.is) with one,
//          a period as an entry period ("may still convert"), Live refused typed and never hydrated, the save's
//          refusals, the words, additivity; the scope's combinations (an LOD field, a context filter, a related table);
//          metrics and grids with nothing new reply byte for byte as before (a pinned hash)
//   chart  by entry date, one resolution per bucket (each point its tile); by a category, the engine's breakdown
//          (bars add up; a bar is its tile for one-country entities, the documented edge pinned); alone; Live; alerts
//
// Every guard has its NEGATIVE CONTROL beside it.
//
//   npm run build:ts && node scripts/test-funnelMetrics.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrates, post } from './liveRouteHarness';
import type { FilterStep } from '../src/data/transforms';
import type { FunnelEncoding } from '../src/analysis/funnelEvents';
import { between, eq, G_BUYERS, MARCH_TS, SHOP_COLS, SHOP_FUNNEL, shopRows } from './funnelShop';

const fe: typeof import('../src/analysis/funnelEvents') = require('../src/analysis/funnelEvents');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const metricFormat: typeof import('../src/analysis/metricFormat') = require('../src/analysis/metricFormat');
const additivity: typeof import('../src/analysis/additivity') = require('../src/analysis/additivity');
const timeScope: typeof import('../src/analysis/metricTimeScope') = require('../src/analysis/metricTimeScope');
const { createHash }: typeof import('crypto') = require('crypto');

process.env.ORDINATE_TODAY = '2024-04-05'; // after the harness pinned its own: a week after the fixture's last event
const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);

const F = { ...SHOP_FUNNEL, steps: SHOP_FUNNEL.steps.slice(), window: { ...SHOP_FUNNEL.window } };
const GERMANY = eq('country', 'Germany'), FRANCE = eq('country', 'France'), MARS = eq('country', 'Mars');
const RECENT = between('2024-03-25', '2024-03-31'), FEB = between('2024-02-01', '2024-02-29');

void (async () => {
  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;
  const ROWS = shopRows();
  const D = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Shop', sourceKind: 'csv', columns: SHOP_COLS, rows: ROWS } as never)))!.id;
  const stored = (await H.as(H.ORG_A, () => H.datasets.getDataset(P, D)))!;
  await H.as(H.ORG_A, () => H.fx.loadWarehouse('shop', SHOP_COLS, ROWS));
  const L = (await H.as(H.ORG_A, () => H.liveOver(P, { table: 'shop' }, SHOP_COLS))).liveId;

  const chart = async (encoding: Record<string, unknown>, filters: FilterStep[] = [], datasetId = D): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId, encoding, filters })).value;
  const post1 = async (input: Record<string, unknown>, datasetId = D): Promise<Reply> => (await post('metric:save', { projectId: P, input: { datasetId, ...input } })).value;
  type M = { id: string; name: string };
  const saved = async (input: Record<string, unknown>, datasetId = D): Promise<M> => {
    const r = await post1(input, datasetId);
    if (r.ok !== true) throw new Error(`could not save ${String(input.name)}: ${show(r)}`);
    return { id: r.metric.id, name: r.metric.name };
  };
  const resolved = async (m: M | string, filters: FilterStep[]): Promise<Reply> => (await H.as(H.ORG_A, () => ipcMetrics.resolveMetric(P, typeof m === 'string' ? m : m.id, { filters }))) as Reply;
  const kpi = async (m: M | string, filters: FilterStep[]): Promise<number | null> => (await resolved(m, filters))?.value ?? null;
  /** The JS reference over the stored rows: the scope as entry filters, `own` on every event. */
  const ref = (entry: FilterStep[], own: FilterStep[] = [], rows = stored.rows) => fe.buildEventFunnel(stored.columns, rows, { ...F, entry } as FunnelEncoding, own).funnel;

  // Old content first: metrics and funnel grids with nothing new reply as they did before this step (hash taken on f0f1f77c).
  const plain = [await saved({ name: 'Events', definition: { column: 'user', aggregation: 'count' }, timeColumn: 'ts' }),
    await saved({ name: 'Users', definition: { column: 'user', aggregation: 'countd' } }),
    await saved({ name: 'Web events', definition: { column: 'event', aggregation: 'count' }, filters: [eq('channel', 'web')] })];
  const before: unknown[] = [];
  for (const m of plain) for (const scope of [[], [GERMANY], [MARCH_TS, FRANCE], [{ ...MARCH_TS, fromControl: true } as FilterStep]]) {
    const { id: _id, ...rest } = await resolved(m, scope);
    before.push(rest);
  }
  const grids: [object, FilterStep[]][] = [[F, []], [{ ...F, breakdown: 'country' }, [MARCH_TS]], [{ ...F, steps: ['visit', 'buy'], window: { n: 2, unit: 'hours' } }, [GERMANY]]];
  for (const [enc, f] of grids) {
    const { asOf: _a, ...rest } = await chart({ category: '', values: [], eventFunnel: enc }, f);
    before.push(rest);
  }
  const pin = createHash('sha256').update(JSON.stringify(before)).digest('hex');
  ok('old content: plain metrics and funnel grids reply byte for byte as before', pin === '3030309076bccfa7ad2c5cedd4e7d247f88643a50069e75c24bccb77aef0bd8e', pin);

  // ── kpi ─────────────────────────────────────────────────────────────────────
  const save = (name: string, definition: unknown, more: Record<string, unknown> = {}): Promise<M> => saved({ name, definition, ...more });
  const rate = await save('Visit → buy', { funnel: F, show: 'rate' }, { format: { kind: 'percent', decimals: 1 } });
  const conv = await save('Buyers', { funnel: F, show: 'converted' });
  const ent = await save('Visitors', { funnel: F, show: 'entered' });
  const grid = (await chart({ category: '', values: [], eventFunnel: F })).data.eventFunnel;
  ok('no scope: entered and converted are the grid\'s first and last counts', Object.is(await kpi(ent, []), grid.counts[0]) && Object.is(await kpi(conv, []), grid.counts[2]), show([await kpi(ent, []), await kpi(conv, []), grid.counts]));
  ok('rate is converted ÷ entered, the grid\'s last "% of first" as a fraction', Object.is(await kpi(rate, []), grid.counts[2] / grid.counts[0]) && Math.abs((await kpi(rate, []))! * 100 - grid.pctOfFirst[2]) < 1e-9);
  ok('the tile shows a percent', (await resolved(rate, [])).display === `${(Math.round((grid.counts[2] / grid.counts[0]) * 1000) / 10).toFixed(1)}%`, (await resolved(rate, [])).display);
  const ran = (): number => H.trace.snapshot().vizEventFunnel?.resident ?? 0;
  const scopes: [string, FilterStep[]][] = [['Germany', [GERMANY]], ['March', [MARCH_TS]], ['France in March', [FRANCE, MARCH_TS]], ['Mars', [MARS]]];
  for (const [label, scope] of scopes) {
    const was = ran();
    const got = [await kpi(rate, scope), await kpi(conv, scope), await kpi(ent, scope)];
    const r = ref(scope);
    const want = [r.counts[0] ? r.counts[2] / r.counts[0] : null, r.counts[2], r.counts[0]];
    ok(`${label}: resident = the JS reference, Object.is`, ran() > was && got.every((v, i) => Object.is(v, want[i])), show([got, want, ran() - was]));
  }
  ok('a tile filtered to Germany admits German entries only, and keeps their French purchases', Object.is(await kpi(conv, [GERMANY]), G_BUYERS), show([await kpi(conv, [GERMANY]), G_BUYERS]));
  ok('NEGATIVE CONTROL: the grid filtered to Germany (every event) loses those purchases', (await chart({ category: '', values: [], eventFunnel: F }, [GERMANY])).data.eventFunnel.counts[2] < G_BUYERS);
  const own = await save('Web buyers', { funnel: F, show: 'converted' }, { filters: [eq('channel', 'web')] });
  ok('the metric\'s own filters filter every event', Object.is(await kpi(own, [GERMANY]), ref([GERMANY], [eq('channel', 'web')]).counts[2]) && (await kpi(own, [GERMANY]))! < G_BUYERS, show(await kpi(own, [GERMANY])));
  ok('a period on time is an entry period, and says recent entries may still convert', (await resolved(conv, [RECENT])).notes?.includes(msg.funnelMayStillConvert()), show(await resolved(conv, [RECENT])));
  ok('NEGATIVE CONTROL: an old period has no such note', !(await resolved(conv, [FEB])).notes?.includes(msg.funnelMayStillConvert()), show(await resolved(conv, [FEB])));
  ok('NEGATIVE CONTROL: … nor has no period', !(await resolved(conv, [GERMANY])).notes?.includes(msg.funnelMayStillConvert()));
  ok('the rows left out are said', (await resolved(conv, [])).notes?.includes(msg.funnelExcluded('2')), show((await resolved(conv, [])).notes));
  ok('nobody entered: rate is null, entered is 0', (await kpi(rate, [MARS])) === null && (await kpi(ent, [MARS])) === 0);
  const CONTROL = { ...between('2024-03-01', '2024-03-31', 'day'), fromControl: true } as FilterStep; // the dashboard's date, moved onto the funnel's
  ok('a date control lands on the funnel\'s time (part 1 D9)', Object.is(await kpi(conv, [CONTROL]), await kpi(conv, [MARCH_TS])) && (await resolved(conv, [CONTROL])).periodOn === 'ts', show(await resolved(conv, [CONTROL])));
  ok('the editor\'s preview is the tile', Object.is((await post('metric:preview', { projectId: P, datasetId: D, definition: { funnel: F, show: 'rate' } })).value.value, await kpi(rate, [])));
  const twice = await save('Twice buyers', { formula: '[Buyers] * 2' });
  ok('a formula over it: its operand under the same scope', Object.is(await kpi(twice, [GERMANY]), G_BUYERS * 2));
  const dateOf = async (id: string): Promise<string> => H.as(H.ORG_A, async () => timeScope.metricDate(P, (await metricsMod.getMetric(P, id))!));
  ok('it counts by funnel.time, a date column, and stores no date of its own', (await dateOf(conv.id)) === 'ts' && (await H.as(H.ORG_A, () => metricsMod.getMetric(P, conv.id)))?.timeColumn === undefined);
  const DT = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Shop text', sourceKind: 'csv', columns: SHOP_COLS.map((c) => (c.name === 'ts' ? { ...c, type: 'text' as const } : c)), rows: ROWS } as never)))!.id;
  const convT = await saved({ name: 'Buyers (text time)', definition: { funnel: F, show: 'converted' } }, DT);
  ok('NEGATIVE CONTROL: over a text time it counts by no date', (await dateOf(convT.id)) === '');

  // The scope's combinations: a related table, an LOD field, a context filter.
  ok('a filter through a relationship can\'t pick who enters: no figure, and why', (await kpi(conv, [{ ...GERMANY, via: 'r1' }])) === null && (await resolved(conv, [{ ...GERMANY, via: 'r1' }])).notes?.includes(msg.funnelEntryNotOwn('country')), show(await resolved(conv, [{ ...GERMANY, via: 'r1' }])));
  ok('… nor a column the dataset lacks', (await kpi(conv, [eq('segment', 'B2B')])) === null && (await resolved(conv, [eq('segment', 'B2B')])).notes?.includes(msg.funnelEntryNotOwn('segment')));
  const DL = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Shop lod', sourceKind: 'csv', columns: SHOP_COLS, rows: ROWS } as never)))!.id;
  await H.as(H.ORG_A, () => H.datasets.updateSteps(P, DL, [{ type: 'calculated_field', name: 'user_events', expression: '{FIXED [user] : COUNT([event])}' } as never]));
  const lod = (await H.as(H.ORG_A, () => H.datasets.getDataset(P, DL)))!;
  const convL = await saved({ name: 'Buyers (lod)', definition: { funnel: F, show: 'converted' } }, DL);
  const BUSY = { type: 'filter', column: 'user_events', op: '>=', value: 4 } as FilterStep;
  const lodRef = fe.buildEventFunnel(lod.columns, lod.rows, { ...F, entry: [BUSY] } as FunnelEncoding).funnel.counts[2];
  ok('an entry filter on a stored FIXED field is its stored value: the reference', lod.columns.some((c) => c.name === 'user_events') && Object.is(await kpi(convL, [BUSY]), lodRef) && lodRef > 0, show([await kpi(convL, [BUSY]), lodRef]));
  const ctx = { ...GERMANY, context: true } as FilterStep;
  ok('a context filter can\'t pick who enters over LOD fields: no figure, and why', (await kpi(convL, [ctx])) === null && (await resolved(convL, [ctx])).notes?.includes(msg.funnelEntryLod()), show(await resolved(convL, [ctx])));
  ok('NEGATIVE CONTROL: the same context filter where there is no LOD field picks who enters', Object.is(await kpi(conv, [ctx]), G_BUYERS));

  // Live: the chart door's typed funnel refusal, on the tile too, never hydrated.
  const rateL = (await post('metric:save', { projectId: P, input: { name: 'Live visit → buy', datasetId: L, definition: { funnel: F, show: 'rate' } } })).value.metric?.id as string;
  const lv = await hydrates(L, () => resolved(rateL, [GERMANY]).then(() => null, (err) => err.failure));
  ok('Live: the typed funnel refusal, thrown as the KPI door throws, never hydrated', lv.value?.code === 'live_refused' && lv.value?.reason === 'funnel' && !lv.hydrated, show(lv));
  const lvs = (await post('metric:values', { projectId: P, ids: [rateL], filters: [] })).value;
  ok('Live: … typed in the picker\'s batch too', lvs[0]?.ok === false && lvs[0]?.code === 'live_refused', show(lvs));
  const tile = (await post('analysis:tiles', { projectId: P, items: [{ kind: 'metric', datasetId: L, column: '', aggregation: 'sum', metricId: rateL }] })).value;
  ok('Live: a tile says it, typed, never "deleted"', tile[0]?.ok === false && tile[0]?.code === 'live_refused' && tile[0]?.reason === 'funnel', show(tile));
  const tileX = (await post('analysis:tiles', { projectId: P, items: [{ kind: 'metric', datasetId: D, column: '', aggregation: 'sum', metricId: conv.id, filters: [GERMANY] }] })).value;
  ok('NEGATIVE CONTROL: an extract tile has its figure', tileX[0]?.ok === true && Object.is(tileX[0]?.value, G_BUYERS), show(tileX));

  // The save's refusals.
  ok('a one-step funnel is refused at save', (await post('metric:save', { projectId: P, input: { name: 'One step', datasetId: D, definition: { funnel: { ...F, steps: ['visit'] }, show: 'rate' } } })).status === 400);
  ok('a grid\'s fractional window (1.5 hours) saves, as the grid draws it', (await post1({ name: 'Quick buyers', definition: { funnel: { ...F, window: { n: 1.5, unit: 'hours' } }, show: 'converted' } })).ok === true);
  ok('… and an empty step', (await post('metric:save', { projectId: P, input: { name: 'Blank step', datasetId: D, definition: { funnel: { ...F, steps: ['visit', ''] }, show: 'rate' } } })).status === 400);
  const gone = await post1({ name: 'Probe', definition: { funnel: { ...F, entity: 'customer' }, show: 'rate' } });
  ok('a funnel on a column the dataset lacks is refused beside its definition', gone.ok === false && gone.field === 'definition' && gone.error === msg.snapshotPerNotColumn('customer'), show(gone));
  const upd = await post('metric:update', { projectId: P, id: conv.id, patch: { definition: { funnel: { ...F, time: 'when' }, show: 'converted' } } });
  ok('… on update too', upd.value.ok === false && upd.value.error === msg.snapshotPerNotColumn('when'), show(upd.value));
  ok('NEGATIVE CONTROL: nothing was saved by the refusals', !(await post('metric:list', { projectId: P })).value.metrics.some((m: Reply) => m.name === 'Probe') && (await dateOf(conv.id)) === 'ts');
  ok('NEGATIVE CONTROL: a rename of a funnel metric saves', (await post('metric:update', { projectId: P, id: ent.id, patch: { name: 'Visitors (all)' } })).value.ok === true);

  // Words and additivity.
  const rec = async (m: M) => (await H.as(H.ORG_A, () => metricsMod.getMetric(P, m.id)))!;
  ok('words', metricFormat.describeDefinition(await rec(rate)) === 'visit → cart → buy within 7 days, conversion rate' && metricFormat.describeDefinition(await rec(conv)) === 'visit → cart → buy within 7 days, converted', metricFormat.describeDefinition(await rec(rate)));
  ok('… in the list too', (await post('metric:list', { projectId: P })).value.metrics.find((m: Reply) => m.id === rate.id)?.definitionText === 'visit → cart → buy within 7 days, conversion rate');
  const same = (a: { categories: boolean; time: boolean }, c: boolean, t: boolean): boolean => a.categories === c && a.time === t;
  const byName = await H.as(H.ORG_A, () => metricsMod.metricsByName(P));
  ok('additivity: converted and entered add across categories, not time; rate neither', same(additivity.additivityOf(await rec(conv), SHOP_COLS, byName), true, false) && same(additivity.additivityOf(await rec(ent), SHOP_COLS, byName), true, false) && same(additivity.additivityOf(await rec(rate), SHOP_COLS, byName), false, false));

  // ── chart ───────────────────────────────────────────────────────────────────
  const M = (m: M) => ({ column: 'user', aggregation: 'countd', metricId: m.id }); // the stored shape a chart measure keeps
  const at = (r: Reply, label: string): number | null | undefined => r.data?.series?.[0]?.values?.[r.data.labels.indexOf(label)];
  const sum = (xs: (number | null)[]): number => xs.reduce<number>((a, v) => a + (v ?? 0), 0);
  const TWO = { type: 'filter', column: 'user', op: 'not in', values: ['x1', 't1'] } as FilterStep; // the two entities whose visits carry two countries
  const byCountry = await chart({ category: 'country', values: [M(conv)] });
  ok('a chart by country draws, named after the metric', byCountry.ok === true && byCountry.data.series[0].name === 'Buyers' && byCountry.data.labels.length === 4, show(byCountry));
  const one = await chart({ category: 'country', values: [M(conv)] }, [TWO]);
  for (const c of ['Germany', 'France', 'Spain', 'Italy']) {
    ok(`${c}'s bar equals the ${c} tile (one-country entities)`, Object.is(at(one, c), await kpi(conv, [TWO, eq('country', c)])), show([at(one, c), await kpi(conv, [TWO, eq('country', c)])]));
  }
  ok('the bars add up to the tile (one entry per entity)', Object.is(sum(byCountry.data.series[0].values), await kpi(conv, [])) && Object.is(sum((await chart({ category: 'country', values: [M(ent)] })).data?.series?.[0]?.values ?? []), await kpi(ent, [])));
  const x1 = await chart({ category: 'country', values: [M(ent)] }, [eq('user', 'x1')]);
  ok('the documented edge: x1 counts under France in the chart (its first visit), and in both filtered tiles', JSON.stringify(x1.data?.labels) === '["France"]' && (await kpi(ent, [GERMANY, eq('user', 'x1')])) === 1 && (await kpi(ent, [FRANCE, eq('user', 'x1')])) === 1, show(x1));
  ok('… so the Germany bar is the Germany tile less x1', Object.is(at(byCountry, 'Germany'), (await kpi(conv, [GERMANY]))! - 1));
  const rates = await chart({ category: 'country', values: [M(rate)] });
  const ents = await chart({ category: 'country', values: [M(ent)] });
  ok('a rate by country: each group\'s converted ÷ entered', rates.ok === true && rates.data.labels.every((l: string, k: number) => Object.is(rates.data.series[0].values[k], at(byCountry, l)! / at(ents, l)!)), show(rates));
  const byWeek = await chart({ category: 'ts', grain: 'week', values: [M(rate)] }, [MARCH_TS]);
  const pb: typeof import('../src/analysis/periodBuckets') = require('../src/analysis/periodBuckets');
  const tileUnder = async (m: M, label: string): Promise<number | null> => {
    const b = pb.bucketRange(label, 'week')!;
    return kpi(m, [between(b.from < '2024-03-01' ? '2024-03-01' : b.from, b.to > '2024-03-31' ? '2024-03-31' : b.to)]);
  };
  const weekly = [];
  for (const l of byWeek.data?.labels ?? []) weekly.push(Object.is(byWeek.data.series[0].values[byWeek.data.labels.indexOf(l)], await tileUnder(rate, l)));
  ok('by entry week: each point is its week\'s tile', byWeek.ok === true && weekly.length >= 4 && weekly.every(Boolean), show([byWeek, weekly]));
  ok('… on a date axis, with its grain', byWeek.category?.kind === 'date' && byWeek.category?.grain === 'week');
  const byDay = await chart({ category: 'ts', grain: 'day', values: [M(conv)] }, [MARCH_TS]);
  ok('more than 24 days: refused with the funnel\'s sentence', byDay.ok === false && byDay.error === msg.funnelTooManyBuckets('Buyers', 'day', 29), show(byDay));
  const byCity = await chart({ category: 'city', values: [M(conv)] });
  ok('more than 12 cities: the top 12, and the truncated note', byCity.ok === true && byCity.data.labels.length === 12 && byCity.warnings?.includes(msg.funnelTopGroups(12, 'city')), show(byCity));
  ok('NEGATIVE CONTROL: four countries carry no such note', !(byCountry.warnings ?? []).includes(msg.funnelTopGroups(12, 'country')));
  ok('a funnel measure with a second measure is refused', (await chart({ category: 'country', values: [M(conv), M(ent)] })).error === msg.measureChartsAlone('Buyers'));
  ok('… and under a split', (await chart({ category: 'country', series: 'channel', values: [M(conv)] })).error === msg.measureChartsAlone('Buyers'));
  ok('a formula over it is not charted yet', (await chart({ category: 'country', values: [M(twice)] })).error === msg.periodInChartFormula('Buyers'));
  ok('a chart scope it can\'t use to pick who enters is refused, never drawn over everyone', (await chart({ category: 'country', values: [M(conv)] }, [eq('segment', 'B2B')])).error === msg.funnelEntryNotOwn('segment'));
  const liveChart = await hydrates(L, async () => chart({ category: 'country', values: [M({ id: rateL, name: '' })] }, [], L));
  ok('Live: a chart by country is the typed funnel refusal, never hydrated', liveChart.value.ok === false && liveChart.value.code === 'live_refused' && liveChart.value.reason === 'funnel' && !liveChart.hydrated, show(liveChart));
  const liveWeek = await hydrates(L, async () => chart({ category: 'ts', grain: 'week', values: [M({ id: rateL, name: '' })] }, [], L));
  ok('Live: … by date too', liveWeek.value.ok === false && liveWeek.value.code === 'live_refused' && liveWeek.value.reason === 'funnel' && !liveWeek.hydrated, show(liveWeek));
  const mm: typeof import('../src/analysis/metricMeasures') = require('../src/analysis/metricMeasures');
  const leaves = await H.as(H.ORG_A, () => mm.withLeafMeasures(P, D, { category: 'country', values: [M(conv)] } as never));
  ok('the share policy is shown the funnel\'s columns, as a formula\'s leaves', JSON.stringify(leaves.values.map((v) => v.column)) === '["user","event","ts"]', show(leaves.values));
  const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
  const alerts: typeof import('../src/analysis/alerts') = require('../src/analysis/alerts');
  const { randomUUID }: typeof import('crypto') = require('crypto');
  const rule = { id: randomUUID(), name: 'r', datasetId: D, enabled: true, compare: 'threshold', threshold: { op: '<', value: 0.9 }, metric: { column: '', aggregation: 'sum', metricId: rate.id, filters: [GERMANY] } };
  const watched = await H.as(H.ORG_A, () => alertStore.metricFor(P, rule as never));
  ok('an alert on a funnel metric watches its figure', typeof watched.value === 'number' && Object.is(watched.value, await kpi(rate, [GERMANY])), show(watched));
  const tested = await H.as(H.ORG_A, () => alertStore.testRule(P, rule as never));
  ok('the Test button: the funnel figure', tested.ok && tested.fire === true && Object.is(tested.value, await kpi(rate, [GERMANY])), show(tested));
  const shown = (await resolved(rate, [GERMANY])).display as string;
  ok('… and its sentence says the figure as the tile does (a percent)', shown.endsWith('%') && tested.message.includes(shown), show([tested.message, shown]));
  const onColumn = await H.as(H.ORG_A, () => alertStore.testRule(P, { ...rule, threshold: { op: '>', value: 0 }, metric: { column: 'ts', aggregation: 'count' } } as never));
  ok('NEGATIVE CONTROL: a rule on a column keeps the compact figure', onColumn.message.includes(alerts.fmtMetric(onColumn.value)), show(onColumn.message));

  await close();
  finish();
})().catch((err) => {
  ok('test-funnelMetrics ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
