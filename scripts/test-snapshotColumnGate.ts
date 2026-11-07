// Part 1's snapshot KPI and a refused metric's tile behind part 4's column gate (release C's p5-07 `9494f451`,
// backported), over the real RPC route, as real users in a scratch Postgres. The world is
// scripts/columnAccessHarness.ts (Staff hides salary and ssn from `east`) plus *Pay log* (`day` and `hired` dates,
// `dept`), whose `hired` is hidden from east too (`hr` and the editor `ed` see it).
//
// 1. SNAPSHOT DATE: a count of dept on the latest `hired` gives east no figure, typed hidden (metric:values,
//    analysis:tiles, visual:data), never a silent blank; NEGATIVE CONTROLS: the editor's and hr's figure, and the same count on the
//    latest `day` answering east Object.is-equal to the editor's.
// 2. A REFUSED METRIC'S TILE keeps the metric's typed refusal, never its stored column's plain figure nor
//    "deleted"; NEGATIVE CONTROL: the editor's tile is the metric's figure.
// 3. OLD CONTENT: the replies the fix does not touch, sha256-pinned at c27f5211 (release B's top).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-snapshotColumnGate.js

export {}; // module scope — sibling test scripts share top-level names
import * as crypto from 'crypto';
import { ok, finish } from './selfcheck';
import * as C from './columnAccessHarness';
import * as H from './rowPolicyHarness';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');

const show = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 240)}`;

void (async () => {
  const W = await C.columnWorld('a snapshot KPI and a refused tile behind the column gate');
  if (!W) return finish();
  try {
    const { P, staff } = W;
    const must = (what: string, r: H.Reply): H.Reply => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`${what}: ${r.text.slice(0, 240)}`); return r; };
    const LOG_ROWS = Array.from({ length: 12 }, (_, i) => { const d = `2024-${String(1 + (i % 6)).padStart(2, '0')}-15`; return [d, d, ['Ops', 'Eng', 'Sales'][i % 3]]; });
    const log = await W.as('boss', async () => (await datasets.saveDataset(P, { name: 'Pay log', sourceKind: 'csv', columns: [{ name: 'day', type: 'date' }, { name: 'hired', type: 'date' }, { name: 'dept', type: 'text' }], rows: LOG_ROWS }))!.id);
    await W.plant(log, [{ column: 'hired', visibleTo: [{ teamId: W.hrTeam }] }]);
    const save = async (name: string, datasetId: string, definition: unknown): Promise<string> =>
      String(must(name, await W.call('boss', 'metric:save', { projectId: P, input: { name, datasetId, definition } })).body.metric.id);
    const snapOn = (column: string) => ({ column: 'dept', aggregation: 'count', snapshot: { column, take: 'last' } });
    const [ON_DAY, ON_HIRED] = [await save('Latest day', log, snapOn('day')), await save('Latest hire date', log, snapOn('hired'))];
    const [PAYROLL, HEADCOUNT] = [await save('Payroll', staff, { column: 'salary', aggregation: 'sum' }), await save('Headcount', staff, { column: 'employee_id', aggregation: 'count' })];
    const values = (who: string, ids: string[]) => W.call(who, 'metric:values', { projectId: P, ids });
    type Item = { datasetId: string; column: string; aggregation: string; metricId?: string };
    const tiles = (who: string, items: Item[]) => W.call(who, 'analysis:tiles', { projectId: P, items: items.map((it) => ({ kind: 'metric', ...it })) });
    const item = (r: H.Reply, i = 0): H.Reply => ({ ...r, body: r.body?.[i] });
    const figureOf = (r: H.Reply): unknown => (r.status === 200 && r.body?.ok === true ? r.body.value : 'none');
    const kpiOf = (r: H.Reply): unknown => (r.status === 200 && r.body?.[0]?.ok === true ? r.body[0].value : 'none');

    // ── 1. A snapshot on a hidden date ───────────────────────────────────────
    const hiredTile: Item = { datasetId: log, column: 'dept', aggregation: 'count', metricId: ON_HIRED };
    const chart = (who: string, id: string) => W.call(who, 'visual:data', { projectId: P, datasetId: log, encoding: { category: 'dept', values: [{ column: 'dept', aggregation: 'count', metricId: id }] } });
    const [eastKpi, eastTile, eastChart] = [await values('east', [ON_HIRED]), await tiles('east', [hiredTile]), await chart('east', ON_HIRED)];
    ok('snapshot on a hidden date: east\'s KPI has no figure, not even a blank (metric:values)', eastKpi.status === 200 && eastKpi.body?.[0]?.ok === false && !('value' in eastKpi.body[0]), show(eastKpi));
    ok('…its tile has no figure, typed hidden, never the stored column\'s (analysis:tiles)', C.refusedAs(item(eastTile), 'hidden') && !('value' in (eastTile.body?.[0] ?? {})), show(eastTile));
    ok('…its chart is refused, typed hidden (visual:data)', C.refusedAs(eastChart, 'hidden'), show(eastChart));
    const [edKpi, edTile, edChart, hrKpi] = [await values('ed', [ON_HIRED]), await tiles('ed', [hiredTile]), await chart('ed', ON_HIRED), await values('hr', [ON_HIRED])];
    ok('NEGATIVE CONTROL: the editor gets the latest hire date\'s count, as a KPI, a tile and a chart', Object.is(kpiOf(edKpi), 2) && Object.is(figureOf(item(edTile)), 2) && edChart.body?.ok === true, `${show(edKpi)} | ${show(edTile)} | ${show(edChart)}`);
    ok('NEGATIVE CONTROL: …and so does hr, whom the rule names', Object.is(kpiOf(hrKpi), 2), show(hrKpi));
    const dayTile: Item = { datasetId: log, column: 'dept', aggregation: 'count', metricId: ON_DAY };
    const [eastDay, edDay, eastDayTile, edDayTile] = [await values('east', [ON_DAY]), await values('ed', [ON_DAY]), await tiles('east', [dayTile]), await tiles('ed', [dayTile])];
    ok('NEGATIVE CONTROL: a snapshot on the visible day answers east Object.is-equal to the editor (KPI and tile)', Object.is(kpiOf(eastDay), 2) && Object.is(kpiOf(eastDay), kpiOf(edDay))
      && Object.is(figureOf(item(eastDayTile)), figureOf(item(edDayTile))) && H.diff(eastDayTile.body, edDayTile.body, {}) === '', `${show(eastDay)} | ${show(eastDayTile)}`);

    // ── 2. A refused metric's tile ───────────────────────────────────────────
    // The card's own stored column (employee_id, visible) and the metric's (salary, hidden) differ: east must not get the headcount under Payroll.
    const payTile: Item = { datasetId: staff, column: 'employee_id', aggregation: 'count', metricId: PAYROLL };
    const noColumn: Item = { datasetId: staff, column: '', aggregation: 'sum', metricId: PAYROLL };
    const eastPay = await tiles('east', [payTile, noColumn]);
    ok('refused metric: east\'s tile keeps the typed refusal, never its stored column\'s figure', C.refusedAs(item(eastPay, 0), 'hidden') && !('value' in (eastPay.body?.[0] ?? {})), show(eastPay));
    ok('…and a tile with no stored column says why, never "deleted"', C.refusedAs(item(eastPay, 1), 'hidden') && !eastPay.text.includes('deleted'), show(eastPay));
    ok('…and no salary figure reaches east', !C.leaksHidden(eastPay.text), show(eastPay));
    const [edPay, edPayKpi] = [await tiles('ed', [payTile, noColumn]), await values('ed', [PAYROLL])];
    ok('NEGATIVE CONTROL: the editor\'s tiles are the metric\'s figure', typeof kpiOf(edPayKpi) === 'number' && Object.is(figureOf(item(edPay, 0)), kpiOf(edPayKpi)) && Object.is(figureOf(item(edPay, 1)), kpiOf(edPayKpi)), `${show(edPay)} | ${show(edPayKpi)}`);

    // ── 3. Old content: replies the fix does not touch ───────────────────────
    // Hashed at c27f5211 (release B's top) and on this branch, and they agreed; never re-record it. Ids and the datasets' stamps vary per run.
    const plainTile: Item = { datasetId: staff, column: 'employee_id', aggregation: 'count' };
    const headTile: Item = { datasetId: staff, column: 'employee_id', aggregation: 'count', metricId: HEADCOUNT };
    const pinned: string[] = [];
    for (const who of ['ed', 'hr']) {
      pinned.push((await values(who, [ON_DAY, ON_HIRED, PAYROLL, HEADCOUNT])).text, (await tiles(who, [dayTile, hiredTile, payTile, noColumn, headTile, plainTile])).text);
    }
    pinned.push((await values('east', [ON_DAY, PAYROLL, HEADCOUNT])).text, (await tiles('east', [dayTile, headTile, plainTile])).text);
    const text = pinned.join('\n').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID').replace(/"at":"[^"]*"/g, '"at":"T"');
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    ok('old content: the replies the fix does not touch are byte-identical (sha256 pinned at c27f5211)', hash === 'bde7c40bb7b4f2ff6fd4ef2a734073276e34fe82e647ea4375c19ac1ebbcc232', `${hash} ${text.slice(0, 400)}`);
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
