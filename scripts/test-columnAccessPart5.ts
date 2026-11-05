// Part 5's metric kinds behind part 4's column gate (semantic layer part 5 × part 4, D15–D19), over the real RPC
// route, as real users in a scratch Postgres. The world is scripts/columnAccessHarness.ts plus *Pay log*: Staff's
// columns and a `day`, whose salary and ssn are hidden from `east` too (`hr` and the editor `ed` see them).
//
// PERIOD (p5-05): a period metric whose base totals salary gives east no figure (metric:values, analysis:tiles,
// metric:preview) and is listed `hidden: true`; NEGATIVE CONTROLS: the editor and hr get its figure, and a period
// metric over a base on dept answers east Object.is-equal to the editor.
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
    ok('period: east\'s KPI tile on it has no figure (analysis:tiles)', eastTile.body?.[0]?.ok === false && !('value' in eastTile.body[0]) && !C.leaksHidden(eastTile.text), show(eastTile));
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
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
