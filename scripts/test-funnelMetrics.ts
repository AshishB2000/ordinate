// Funnel metrics (semantic layer part 5, step 08: D5, D6, D7) — "Visit → buy" as a metric: its conversion rate, the
// converted or the entered count, from the funnel grid's own matching. The scope (a tile's filters, controls, terms)
// picks WHO ENTERS; the metric's own filters and the row lock pick which events count.
//
//   kpi    the figure through the chart door: the grid's counts with no scope, the JS reference (Object.is) with one,
//          a period as an entry period ("may still convert"), Live refused typed and never hydrated, the save's
//          refusals, the words, additivity; the scope's combinations (an LOD field, a context filter, a related table);
//          metrics and grids with nothing new reply byte for byte as before (a pinned hash)
//   chart  (Task 3) by entry date, one resolution per bucket; by a category, the engine's breakdown; alerts
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

  await close();
  finish();
})().catch((err) => {
  ok('test-funnelMetrics ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
