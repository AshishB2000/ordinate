// Column access rules on the REDACT and MARK readers (semantic layer part 4, D18, D19), over the real RPC route,
// as real users in a scratch Postgres. The world is scripts/columnAccessHarness.ts: *Staff* hides `salary`, `ssn`
// and the carrier `bonus` from `east`; `hr` (a viewer in HR) sees them.
//
// - catalog:columns: a hidden column's example and value labels are left out for east; hr reads them (CONTROL).
// - format:colors:get: no colours of a hidden column's values; a visible column's stay (CONTROL), and hr's map holds both.
// - visual:get: a visual on dept keeps its custom order for east; one filtered on ssn values loses the values and its labels.
// - dataset:columns, sql:schema, describe_dataset: a hidden column is marked `hidden: true` for east, never for hr.
// - metric:list and term:list: Payroll, Payroll per head and High earners read a hidden column, so `hidden: true` for
//   east; Headcount is not (CONTROL); nothing is for hr (CONTROL). Part 5's kinds likewise: a distinct count of salary,
//   a period metric over Payroll (through its base) and a funnel by ssn; a period over Headcount is not (CONTROL).
// - verified:list (part 3) leaves out, for east, a verified question whose spec names a hidden column, with no value
//   filter; People by dept stays (CONTROL); hr lists both (CONTROL).
// - verified:checkResult (p3-10): east reads a Staff question's outcome without its reason; hr reads it (CONTROL).
// - quality:list and dataset:liveSchema redact Staff for east (closedToCaller): no run, no args, no sample values.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-columnRedact.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as C from './columnAccessHarness';
import * as H from './rowPolicyHarness';

const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const recordKinds: typeof import('../src/app/recordKinds') = require('../src/app/recordKinds');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const EXAMPLE = 'EXAMPLE_PAY_52000';

(async () => {
  const W = await C.columnWorld('column redact');
  if (!W) return finish();
  try {
    const { P, staff } = W;
    const must = (what: string, r: H.Reply): void => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`${what}: ${r.text.slice(0, 200)}`); };
    // ── catalog:columns ──────────────────────────────────────────────────────
    must('example', await W.call('boss', 'catalog:setColumn', { projectId: P, datasetId: staff, column: 'salary', patch: { example: EXAMPLE } }));
    must('labels', await W.call('boss', 'catalog:setColumn', { projectId: P, datasetId: staff, column: 'ssn', patch: { values: [{ value: `${C.SSN_CANARY}_1`, label: 'Person one' }] } }));
    const cols = { projectId: P, datasetId: staff };
    const colsEast = await W.call('east', 'catalog:columns', cols);
    ok('catalog:columns: no example for salary and no value labels for ssn, to east', ((c) => c?.salary?.example === '' && !('values' in c.ssn))(colsEast.body?.columns) && !colsEast.text.includes(C.SSN_CANARY) && !colsEast.text.includes(EXAMPLE), colsEast.text.slice(0, 300));
    const colsHr = await W.call('hr', 'catalog:columns', cols);
    ok('NEGATIVE CONTROL: hr reads the example and the labels', colsHr.body?.columns?.salary?.example === EXAMPLE && colsHr.body.columns.ssn?.values?.length === 1, colsHr.text.slice(0, 300));

    // ── format:colors:get (with Orders' row rules lifted: they empty the whole map for a viewer) ──
    const rowRules = [[W.orders, H.RULES(W.team, W.uid.west)], [W.east, [{ teamId: W.team, values: ['East'] }]], [W.west, [{ userId: W.uid.west, values: ['West'] }]]] as const;
    const setRows = async (on: boolean): Promise<void> => {
      for (const [d, rules] of rowRules) must('row rules', await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: d, policy: on ? { column: 'region', rules } : null }));
    };
    must('colours ssn', await W.call('boss', 'format:colors:assign', { projectId: P, column: 'ssn', values: [`${C.SSN_CANARY}_1`] }));
    must('colours dept', await W.call('boss', 'format:colors:assign', { projectId: P, column: 'dept', values: ['Ops'] }));
    await setRows(false);
    try {
      const mapEast = await W.call('east', 'format:colors:get', { projectId: P });
      ok('format:colors:get: no colours of ssn values for east', mapEast.status === 200 && !('ssn' in mapEast.body) && !mapEast.text.includes(C.SSN_CANARY), mapEast.text.slice(0, 200));
      ok('NEGATIVE CONTROL: …a visible column\'s colours stay', 'dept' in (mapEast.body ?? {}), mapEast.text.slice(0, 200));
      ok('NEGATIVE CONTROL: hr\'s map holds the ssn colours', (await W.call('hr', 'format:colors:get', { projectId: P })).text.includes(C.SSN_CANARY));
    } finally {
      await setRows(true);
    }
    ok('control: with row rules back, east\'s map is empty again (row access, unchanged)', JSON.stringify((await W.call('east', 'format:colors:get', { projectId: P })).body) === '{}');

    // ── visual:get ───────────────────────────────────────────────────────────
    const COUNT = { column: 'employee_id', aggregation: 'count' };
    const saveVisual = async (filters: object[], overrides: object): Promise<string> => {
      const r = await W.call('boss', 'visual:save', { projectId: P, datasetId: staff, name: 'People', chartType: 'bar', encoding: { category: 'dept', values: [COUNT] }, filters, overrides });
      const id = String(r.body?.visual?.id ?? r.body?.id ?? '');
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`visual:save: ${r.text.slice(0, 200)}`);
      return id;
    };
    const ORDER = { sort: 'custom', sortOrder: ['Sales', 'Ops', 'Eng'] };
    const BY_DEPT_V = await saveVisual([], ORDER);
    const SSN_FILTERED_V = await saveVisual([{ type: 'filter', column: 'ssn', op: 'in', values: [`${C.SSN_CANARY}_1`, `${C.SSN_CANARY}_2`] }], ORDER);
    const visualGet = (who: string, id: string) => W.call(who, 'visual:get', { projectId: P, id });
    const keepsOrder = (r: H.Reply): boolean => JSON.stringify(r.body?.overrides?.sortOrder) === JSON.stringify(ORDER.sortOrder);
    ok('a visual on dept keeps its custom order for east', keepsOrder(await visualGet('east', BY_DEPT_V)));
    const filtered = await visualGet('east', SSN_FILTERED_V);
    ok('…one filtered on ssn values loses the values and its custom order', filtered.status === 200 && !filtered.text.includes(C.SSN_CANARY) && !keepsOrder(filtered) && filtered.body?.filters?.[0]?.column === 'ssn', filtered.text.slice(0, 300));
    const filteredHr = await visualGet('hr', SSN_FILTERED_V);
    ok('NEGATIVE CONTROL: hr gets the filter values and the order', filteredHr.text.includes(C.SSN_CANARY) && keepsOrder(filteredHr));

    // ── MARK: dataset:columns, sql:schema, describe_dataset ──────────────────
    const marked = (cs: Array<{ name: string; hidden?: unknown }> | undefined): string => (cs ?? []).filter((c) => c.hidden === true).map((c) => c.name).sort().join();
    const mcpCtx = { projectId: P, transport: 'http' as const, cwd: '/', headless: false, progress: () => undefined };
    const marks = async (who: string): Promise<string[]> => [
      marked((await W.call(who, 'dataset:columns', { projectId: P, id: staff })).body?.columns),
      marked((await W.call(who, 'sql:schema', { projectId: P })).body?.datasets?.find((d: { id: string }) => d.id === staff)?.columns),
      marked(((await W.as(who, () => automation.datasetsDescribe(mcpCtx, staff))) as { columns: Array<{ name: string; hidden?: unknown }> }).columns),
    ];
    const eastMarks = await marks('east');
    ok('dataset:columns, sql:schema, describe_dataset mark salary, ssn and bonus hidden: true for east', eastMarks.every((m) => m === 'bonus,salary,ssn'), JSON.stringify(eastMarks));
    const hrMarks = await marks('hr');
    ok('NEGATIVE CONTROL: …nothing for hr', hrMarks.every((m) => m === ''), JSON.stringify(hrMarks));
    ok('control: a dataset without rules marks nothing for east', marked((await W.call('east', 'dataset:columns', { projectId: P, id: W.plain })).body?.columns) === '');
    // Rules that do not hold, or a dataset built from Staff: which columns carry the hidden values is unknown, so every one is hidden.
    const EVERY = 'bonus,dept,employee_id,salary,ssn';
    const stored = (await W.rawOf(staff)).columnAccess;
    await W.setRaw(staff, { columns: 'not a list' });
    try {
      ok('fail closed: a corrupt rule marks every column hidden for east, and blanks every example', marked((await W.call('east', 'dataset:columns', { projectId: P, id: staff })).body?.columns) === EVERY
        && !(await W.call('east', 'catalog:columns', cols)).text.includes(EXAMPLE));
    } finally {
      await W.setRaw(staff, stored);
    }
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const overStaff = await W.as('boss', async () => (await datasets.saveDataset(P, { name: 'Over staff', sourceKind: 'sql', columns: C.STAFF_COLUMNS, rows: C.STAFF_ROWS, origin: { kind: 'sql', sql: 'SELECT * FROM "Staff"', deps: [staff] } } as never))!.id);
    ok('fail closed: a SQL dataset over Staff marks every column hidden for east', marked((await W.call('east', 'dataset:columns', { projectId: P, id: overStaff })).body?.columns) === 'dept,employee_id,salary,ssn');
    ok('NEGATIVE CONTROL: …none for hr', marked((await W.call('hr', 'dataset:columns', { projectId: P, id: overStaff })).body?.columns) === '');
    await W.as('boss', () => datasets.deleteDataset(P, overStaff));

    // ── metric:list and term:list ────────────────────────────────────────────
    const saveMetric = async (name: string, definition: object): Promise<void> => {
      must(`metric ${name}`, await W.call('boss', 'metric:save', { projectId: P, input: { name, datasetId: staff, definition } }));
    };
    await saveMetric('Payroll', { column: 'salary', aggregation: 'sum' });
    await saveMetric('Headcount', { column: 'employee_id', aggregation: 'count' });
    await saveMetric('Payroll per head', { formula: '[Payroll] / [Headcount]' }); // hidden through the metric it names
    must('term', await W.call('boss', 'term:save', { projectId: P, input: { name: 'High earners', aliases: [], description: '', datasetId: staff, filters: [{ type: 'filter', column: 'salary', op: '>', value: 1200 }] } }));
    must('term', await W.call('boss', 'term:save', { projectId: P, input: { name: 'Ops people', aliases: [], description: '', datasetId: staff, filters: [{ type: 'filter', column: 'dept', op: '=', value: 'Ops' }] } }));
    const flags = async (who: string, ch: 'metric:list' | 'term:list'): Promise<Record<string, unknown>> => {
      const r = await W.call(who, ch, { projectId: P });
      return Object.fromEntries(((ch === 'metric:list' ? r.body?.metrics : r.body?.terms) ?? []).map((x: { name: string; hidden?: unknown }) => [x.name, x.hidden]));
    };
    const mEast = await flags('east', 'metric:list');
    ok('metric:list: Payroll and Payroll per head are hidden: true for east; Headcount is not', mEast.Payroll === true && mEast['Payroll per head'] === true && 'Headcount' in mEast && mEast.Headcount === undefined, JSON.stringify(mEast));
    const mHr = await flags('hr', 'metric:list');
    ok('NEGATIVE CONTROL: no metric is hidden for hr', Object.keys(mHr).length === 3 && Object.values(mHr).every((v) => v === undefined), JSON.stringify(mHr));
    const tEast = await flags('east', 'term:list');
    ok('term:list: High earners is hidden: true for east; Ops people is not', tEast['High earners'] === true && 'Ops people' in tEast && tEast['Ops people'] === undefined, JSON.stringify(tEast));
    ok('NEGATIVE CONTROL: no term is hidden for hr', Object.values(await flags('hr', 'term:list')).every((v) => v === undefined));
    // Part 5's kinds (stored as the release that offers them stores them; metric:save takes none before p5-04): a
    // distinct count and a funnel name their columns, a period metric reads through its base (by id).
    const store = async (name: string, definition: object): Promise<string> =>
      (await W.as('boss', () => metricsMod.saveMetric(P, { name, datasetId: staff, definition } as never)))!.id;
    const PAYROLL_ID = await W.as('boss', async () => (await metricsMod.metricsByName(P)).get('payroll')!.id);
    const HEADCOUNT_ID = await W.as('boss', async () => (await metricsMod.metricsByName(P)).get('headcount')!.id);
    await store('Distinct salaries', { column: 'salary', aggregation: 'countd' });
    await store('Payroll YTD', { base: PAYROLL_ID, window: { to_date: 'year' } });
    await store('Headcount YTD', { base: HEADCOUNT_ID, window: { to_date: 'year' } });
    await store('By ssn funnel', { funnel: { entity: 'ssn', event: 'dept', time: 'employee_id', steps: ['Ops', 'Eng'], window: { n: 7, unit: 'days' } }, show: 'rate' });
    const kEast = await flags('east', 'metric:list');
    ok("part 5's kinds: a distinct count of salary, a period over Payroll and a funnel by ssn are hidden: true for east",
      kEast['Distinct salaries'] === true && kEast['Payroll YTD'] === true && kEast['By ssn funnel'] === true, JSON.stringify(kEast));
    ok('NEGATIVE CONTROL: a period over Headcount is not hidden for east', 'Headcount YTD' in kEast && kEast['Headcount YTD'] === undefined, JSON.stringify(kEast));
    ok("NEGATIVE CONTROL: none of part 5's kinds is hidden for hr", Object.values(await flags('hr', 'metric:list')).every((v) => v === undefined));

    // ── verified:list (part 3): a question whose spec names a hidden column is left out, value filter or none ──
    const QUESTION = 'VERIFIED_PAY_CANARY by dept';
    const verify = async (question: string, measures: object[]): Promise<void> => must(`verified ${question}`, await W.call('boss', 'verified:save', { projectId: P,
      input: { question, spec: { datasetId: staff, category: 'dept', measures, filters: [], chartType: 'column', title: question } } }));
    await verify(QUESTION, [{ column: 'salary', aggregation: 'sum' }]);
    await verify('People by dept', [{ column: 'employee_id', aggregation: 'count' }]);
    const vEast = await W.call('east', 'verified:list', { projectId: P });
    ok('verified:list: a question over salary (no value filter) reaches no east; People by dept does', vEast.body?.ok === true && !vEast.text.includes('VERIFIED_PAY_CANARY') && !/salary/i.test(vEast.text)
      && vEast.body.questions.some((q: { question: string }) => q.question === 'People by dept'), vEast.text.slice(0, 300));
    ok('NEGATIVE CONTROL: hr lists both', ((t) => t.includes('VERIFIED_PAY_CANARY') && t.includes('People by dept'))((await W.call('hr', 'verified:list', { projectId: P })).text));
    // ── verified:checkResult (p3-10): the outcomes for everyone; a reason (it can quote the model) for no one Staff hides a column from ──
    const PEOPLE_ID: string = vEast.body.questions.find((q: { question: string }) => q.question === 'People by dept')?.id ?? '';
    const now = new Date().toISOString();
    const run = { runId: '7f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e', state: 'done', startedBy: 'boss@acme.test', startedAt: now, heartbeatAt: now, finishedAt: now,
      total: 1, asked: 1, matched: 0, skipped: 0, results: [{ id: PEOPLE_ID, outcome: 'refused', reason: `"${C.SSN_CANARY}_4" is not a column of Staff.` }] };
    await W.as('boss', async () => {
      const file = path.join(recordKinds.projectDir(P), 'assistant-check.json');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await recordFs.writeFile(file, JSON.stringify(run), 'utf8');
    });
    const crEast = await W.call('east', 'verified:checkResult', { projectId: P });
    ok('verified:checkResult: east reads the outcome of a Staff question, without its reason', crEast.body?.run?.results?.[0]?.outcome === 'refused' && !('reason' in crEast.body.run.results[0])
      && !crEast.text.includes(C.SSN_CANARY), crEast.text.slice(0, 300));
    ok('NEGATIVE CONTROL: hr reads the reason', (await W.call('hr', 'verified:checkResult', { projectId: P })).body?.run?.results?.[0]?.reason?.includes(C.SSN_CANARY) === true);

    // ── quality:list and dataset:liveSchema: the whole dataset (closedToCaller) ──
    must('quality', await W.call('boss', 'quality:save', { projectId: P, datasetId: staff, rule: { kind: 'in_set', column: 'ssn', args: { values: [`${C.SSN_CANARY}_0`] }, severity: 'warn' } }));
    const qEast = await W.call('east', 'quality:list', { projectId: P, datasetId: staff });
    ok('quality:list redacts Staff for east: the rules without args, no run', qEast.body?.ok === true && qEast.body.latest === null && qEast.body.rules.length === 1 && !qEast.text.includes(C.SSN_CANARY), qEast.text.slice(0, 200));
    ok('NEGATIVE CONTROL: hr reads the args and the run', (await W.call('hr', 'quality:list', { projectId: P, datasetId: staff })).text.includes(C.SSN_CANARY));
    fakeMod.registerLiveFake();
    const liveStaff = await W.as('boss', async () => {
      await fakeMod.loadWarehouseTable('cr_staff', C.STAFF_COLUMNS, C.STAFF_ROWS);
      const conn = await connections.saveConnection(P, { name: 'Fake', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
      return (await liveRecord.saveLiveRecord(P, { name: 'Staff (live)', columns: C.STAFF_COLUMNS, origin: { kind: 'connection', connId: conn!.id, table: 'cr_staff' } }))!.id;
    });
    await W.plant(liveStaff);
    must('sync', await W.call('boss', 'dataset:syncLiveSchema', { projectId: P, datasetId: liveStaff }));
    const schema = (who: string) => W.call(who, 'dataset:liveSchema', { projectId: P, datasetId: liveStaff });
    const sEast = await schema('east');
    ok('dataset:liveSchema redacts the Live Staff for east: no sample values', sEast.body?.ok === true && sEast.body.columns.every((c: { values: unknown[] }) => c.values.length === 0) && !sEast.text.includes(C.SSN_CANARY), sEast.text.slice(0, 200));
    ok('NEGATIVE CONTROL: hr reads its sample values', (await schema('hr')).text.includes(C.SSN_CANARY));
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
