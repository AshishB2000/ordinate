// Part 5's metric kinds behind part 4's column gate (semantic layer part 5 × part 4, D15–D19), over the real RPC
// route, as real users in a scratch Postgres. The world is scripts/columnAccessHarness.ts plus *Pay log*: Staff's
// columns and a `day`, whose salary and ssn are hidden from `east` too (`hr` and the editor `ed` see them).
//
// PERIOD (p5-05): a period metric whose base totals salary gives east no figure (metric:values, analysis:tiles,
// metric:preview) and is listed `hidden: true`; NEGATIVE CONTROLS: the editor and hr get its figure, and a period
// metric over a base on dept answers east Object.is-equal to the editor.
// PERIOD CHARTS (p5-06): its chart by month (each point a resolution of the base) and by dept give east no figure;
// NEGATIVE CONTROLS: the editor's has every point, and the dept one draws east's Object.is-equal to the editor's.
// SNAPSHOT PER (p5-07): a count of dept on each employee's latest day gives east no figure (KPI, tile, chart) when
// the entity is ssn or the snapshot's date is a hidden one, and is listed hidden; NEGATIVE CONTROLS: the editor's
// figures, and the same count per employee_id answering east Object.is-equal to the editor.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-columnAccessPart5.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as C from './columnAccessHarness';
import * as H from './rowPolicyHarness';

process.env.ORDINATE_TODAY = '2024-06-30'; // the log runs January to June 2024: a year to date covers all of it

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rowMessages: typeof import('../src/data/rowAccessMessages') = require('../src/data/rowAccessMessages');

const show = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 240)}`;

void (async () => {
  const W = await C.columnWorld("part 5's kinds behind the column gate");
  if (!W) return finish();
  try {
    const { P } = W;
    const must = (what: string, r: H.Reply): H.Reply => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`${what}: ${r.text.slice(0, 240)}`); return r; };
    const LOG_COLUMNS = [{ name: 'day', type: 'date' as const }, ...C.STAFF_COLUMNS];
    const LOG_ROWS = C.STAFF_ROWS.map((r, i) => [`2024-${String(1 + (i % 6)).padStart(2, '0')}-15`, ...r]);
    const log = await W.as('boss', async () => (await datasets.saveDataset(P, { name: 'Pay log', sourceKind: 'csv', columns: LOG_COLUMNS, rows: LOG_ROWS }))!.id);
    await W.plant(log);
    const save = async (name: string, definition: unknown, timeColumn?: string): Promise<string> =>
      String(must(name, await W.call('boss', 'metric:save', { projectId: P, input: { name, datasetId: log, definition, ...(timeColumn ? { timeColumn } : {}) } })).body.metric.id);
    /** A figure as `who` reads it, or 'refused' when the reply carries none (a refusal of any wire form). */
    const noFigure = (r: H.Reply): boolean => r.status === 409 || r.text.includes('row_policy') || r.text.includes(rowMessages.rowHiddenMessage());

    // ── Period (p5-05) ───────────────────────────────────────────────────────
    const PAY = await save('Logged pay', { column: 'salary', aggregation: 'sum' }, 'day');
    const ROWS = await save('Logged rows', { column: 'dept', aggregation: 'count' }, 'day');
    const PAY_YTD = await save('Pay YTD', { base: PAY, window: { to_date: 'year' } });
    const ROWS_YTD = await save('Rows YTD', { base: ROWS, window: { to_date: 'year' } });
    const values = (who: string, id: string) => W.call(who, 'metric:values', { projectId: P, ids: [id] });
    const valueOf = (r: H.Reply): unknown => (r.status === 200 && r.body?.[0]?.ok === true ? r.body[0].value : 'refused');
    const eastPay = await values('east', PAY_YTD);
    ok('period: east gets no figure for a year to date of salary (metric:values)', valueOf(eastPay) === 'refused' && !('value' in (eastPay.body?.[0] ?? {})) && !C.leaksHidden(eastPay.text), show(eastPay));
    const [edPay, hrPay] = [await values('ed', PAY_YTD), await values('hr', PAY_YTD)];
    ok('NEGATIVE CONTROL: period: the editor and hr get its figure, the base\'s total', typeof valueOf(edPay) === 'number' && Object.is(valueOf(edPay), valueOf(hrPay)), `${show(edPay)} | ${show(hrPay)}`);
    const [eastRows, edRows] = [await values('east', ROWS_YTD), await values('ed', ROWS_YTD)];
    ok('NEGATIVE CONTROL: period: a year to date of dept answers east, Object.is-equal to the editor\'s', typeof valueOf(eastRows) === 'number' && Object.is(valueOf(eastRows), valueOf(edRows)), `${show(eastRows)} | ${show(edRows)}`);
    const tile = (who: string, id: string) => W.call(who, 'analysis:tiles', { projectId: P, items: [{ kind: 'metric', datasetId: log, column: '', aggregation: 'sum', metricId: id }] });
    const eastTile = await tile('east', PAY_YTD);
    ok('period: east\'s KPI tile on it has no figure and says why, never "deleted" (analysis:tiles)', C.refusedAs({ ...eastTile, body: eastTile.body?.[0] }, 'hidden') && !('value' in eastTile.body[0]) && !C.leaksHidden(eastTile.text), show(eastTile));
    const edTile = await tile('ed', PAY_YTD);
    ok('NEGATIVE CONTROL: period: the editor\'s tile has the figure', edTile.body?.[0]?.ok === true && Object.is(edTile.body[0].value, valueOf(edPay)), show(edTile));
    const preview = (who: string, base: string) => W.call(who, 'metric:preview', { projectId: P, datasetId: log, definition: { base, window: { to_date: 'year' } } });
    const eastPreview = await preview('east', PAY);
    ok('period: east\'s preview of one over salary has no figure (metric:preview)', (noFigure(eastPreview) || eastPreview.body?.value === null) && !C.leaksHidden(eastPreview.text), show(eastPreview));
    ok('NEGATIVE CONTROL: period: the editor\'s preview has it', Object.is((await preview('ed', PAY)).body?.value, valueOf(edPay)));
    const listed = async (who: string): Promise<Record<string, boolean>> => Object.fromEntries((((await W.call(who, 'metric:list', { projectId: P })).body?.metrics ?? []) as { id: string; hidden?: boolean }[]).map((m) => [m.id, m.hidden === true]));
    const [eastList, hrList] = [await listed('east'), await listed('hr')];
    ok('period: east\'s metric list marks the salary one hidden (its base reads salary), not the dept one', eastList[PAY_YTD] === true && eastList[ROWS_YTD] === false, JSON.stringify(eastList));
    ok('NEGATIVE CONTROL: period: hr\'s marks neither', hrList[PAY_YTD] === false && hrList[ROWS_YTD] === false, JSON.stringify(hrList));

    // ── Period charts (p5-06) ────────────────────────────────────────────────
    const chart = (who: string, id: string, by: object) => W.call(who, 'visual:data', { projectId: P, datasetId: log, encoding: { ...by, values: [{ column: 'Pay YTD', aggregation: 'count', metricId: id }] } });
    const pointsOf = (r: H.Reply): unknown => (r.status === 200 && r.body?.ok === true ? r.body.data?.series?.[0]?.values : 'refused');
    for (const [label, by] of [['by month', { category: 'day', grain: 'month' }], ['by dept', { category: 'dept' }]] as const) {
      const [east, ed] = [await chart('east', PAY_YTD, by), await chart('ed', PAY_YTD, by)];
      ok(`period chart ${label}: east gets no figure for the year to date of salary`, pointsOf(east) === 'refused' && !C.leaksHidden(east.text), show(east));
      const pts = pointsOf(ed);
      ok(`NEGATIVE CONTROL: period chart ${label}: the editor's has every point`, Array.isArray(pts) && pts.length > 0 && pts.every((v) => typeof v === 'number'), show(ed));
      const [eastRowsChart, edRowsChart] = [await chart('east', ROWS_YTD, by), await chart('ed', ROWS_YTD, by)];
      const d = H.diff(pointsOf(eastRowsChart), pointsOf(edRowsChart), {});
      ok(`NEGATIVE CONTROL: period chart ${label}: the year to date of dept draws east's Object.is-equal to the editor's`, Array.isArray(pointsOf(eastRowsChart)) && d === '', `${d} | ${show(eastRowsChart)}`);
    }

    // ── Snapshot per entity (p5-07) ──────────────────────────────────────────
    // `hired` copies `day` and is hidden from east too: a snapshot's own date in a hidden column.
    must('hired', await W.call('boss', 'dataset:addStep', { projectId: P, datasetId: log, step: { type: 'calculated_field', name: 'hired', expression: '[day]' } }));
    await W.plant(log, [...W.rules, { column: 'hired', visibleTo: [{ teamId: W.hrTeam }] }]);
    const perOf = (per: string, column = 'day') => ({ column: 'dept', aggregation: 'count', snapshot: { column, take: 'last', per } });
    const [PER_SSN, PER_HIRED, PER_ID] = [await save('Latest per ssn', perOf('ssn')), await save('Latest per hire date', perOf('employee_id', 'hired')), await save('Latest per employee', perOf('employee_id'))];
    const perChart = (who: string, id: string) => W.call(who, 'visual:data', { projectId: P, datasetId: log, encoding: { category: 'dept', values: [{ column: 'dept', aggregation: 'count', metricId: id }] } });
    const perTile = (who: string, id: string) => W.call(who, 'analysis:tiles', { projectId: P, items: [{ kind: 'metric', datasetId: log, column: 'dept', aggregation: 'count', metricId: id }] });
    const tileOf = (r: H.Reply): unknown => (r.body?.[0]?.ok === true ? r.body[0].value : 'refused');
    for (const [label, id] of [['per ssn', PER_SSN], ['on a hidden date', PER_HIRED]] as const) {
      const [kpi, tl, ch] = [await values('east', id), await perTile('east', id), await perChart('east', id)];
      ok(`snapshot ${label}: east gets no figure, the tile never its stored column's (metric:values, analysis:tiles, visual:data)`, valueOf(kpi) === 'refused' && C.refusedAs({ ...tl, body: tl.body?.[0] }, 'hidden') && C.refusedAs(ch, 'hidden')
        && ![kpi, tl, ch].some((r) => C.leaksHidden(r.text)), `${show(kpi)} | ${show(tl)} | ${show(ch)}`);
      const [edKpi, edTile, edChart] = [await values('ed', id), await perTile('ed', id), await perChart('ed', id)];
      ok(`NEGATIVE CONTROL: snapshot ${label}: the editor gets each figure`, typeof valueOf(edKpi) === 'number' && Object.is(tileOf(edTile), valueOf(edKpi)) && Array.isArray(pointsOf(edChart)), `${show(edKpi)} | ${show(edChart)}`);
    }
    const [eastId, edId] = [await values('east', PER_ID), await values('ed', PER_ID)];
    const PLAIN_HIRED = await save('Latest on a hire date', { column: 'dept', aggregation: 'count', snapshot: { column: 'hired', take: 'last' } });
    const plainHired = await values('east', PLAIN_HIRED);
    ok('snapshot (part 1\'s) on a hidden date: east\'s KPI has no figure either', valueOf(plainHired) === 'refused', show(plainHired));
    ok('NEGATIVE CONTROL: …the editor\'s has', typeof valueOf(await values('ed', PLAIN_HIRED)) === 'number');
    ok('NEGATIVE CONTROL: snapshot per employee_id answers east, Object.is-equal to the editor\'s', typeof valueOf(eastId) === 'number' && Object.is(valueOf(eastId), valueOf(edId)), `${show(eastId)} | ${show(edId)}`);
    const dIdChart = H.diff(pointsOf(await perChart('east', PER_ID)), pointsOf(await perChart('ed', PER_ID)), {});
    ok('NEGATIVE CONTROL: …and so does its chart', dIdChart === '', dIdChart);
    const eastSnapList = await listed('east');
    ok('snapshot: east\'s metric list marks the ssn and hidden-date ones hidden, not the employee_id one', eastSnapList[PER_SSN] && eastSnapList[PER_HIRED] && !eastSnapList[PER_ID], JSON.stringify(eastSnapList));
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
