// Column access rules at every door, over the real RPC route, as real users with real grants, in a
// scratch Postgres (semantic layer part 4, D12–D17, D20). The world is scripts/columnAccessHarness.ts:
// *Staff* hides `salary`, `ssn` and the carrier `bonus` from `east` (a viewer); `hr` (a viewer in HR)
// and `ed` (an editor) see them.
//
// 0. COVERAGE (no database needed): every `read` contract has a COLUMN_TREATMENT (scripts/columnAccessReaders.ts),
//    and the table names no channel that is gone. NEGATIVE CONTROL: a planted contract is reported.
// 1. THE NET: Staff is closed to east for a whole-table reader, open inside a gated door, open to hr;
//    `policyClosed` stays rows-only (NEGATIVE CONTROL).
// 2. EVERY DOOR refuses east a question that names a hidden column (or the carrier bonus), typed `hidden`:
//    every encoding role, a filter, an LOD, a formula metric's re-entry, a term, a KPI, a metric value, an
//    answer card, a join to Staff's column, the grid's sort and search, distinct, profile. hr gets each one
//    (NEGATIVE CONTROL). A question naming none is Object.is-equal to the editor's; a join THROUGH a hidden
//    key runs, grouping by it is refused (D20).
// 3. ROW READERS: the grid, the rows behind a mark and their CSV carry no hidden value, the cells null IN
//    PLACE and the columns named; the editor's carry the canary (NEGATIVE CONTROL).
// 4. FAIL CLOSED: a later step reading salary, a corrupt rule, a SQL dataset over Staff, an as-of read
//    each refuse east `columns` (controls: a later step not reading salary; hr on the SQL dataset).
// 5. LIVE: a question naming a hidden column is refused before any statement; one not naming it compiles.
// 6. CACHE ORDER: the editor's cached sum(salary) is refused to east; with the gate turned off (the test
//    seam, as if it ran after the cache) east gets it (NEGATIVE CONTROL). A planted getDataset reader is
//    refused by the net; a planted reader of the Parquet by path is caught by the canary check.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-columnDoors.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as C from './columnAccessHarness';
import { COLUMN_TREATMENT } from './columnAccessReaders';

import * as H from './rowPolicyHarness';

const access: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const doors: typeof import('../src/ipc/columnDoors') = require('../src/ipc/columnDoors');
const api: typeof import('../src/api/index') = require('../src/api/index');
const contractMod: typeof import('../src/api/contract') = require('../src/api/contract');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const parquet: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const { z } = require('zod') as typeof import('zod');

/** Read contracts with no column class — the ratchet, as a function so its negative control can run it. */
const unclassified = (contracts: Record<string, { access: string }>): string[] =>
  Object.entries(contracts).filter(([, c]) => c.access === 'read').map(([ch]) => ch).filter((ch) => !Object.prototype.hasOwnProperty.call(COLUMN_TREATMENT, ch));

(async () => {
  // ── 0. Coverage ──────────────────────────────────────────────────────────
  const contracts = api.contracts as unknown as Record<string, { access: string }>;
  const missing = unclassified(contracts);
  ok('coverage: every read contract has a COLUMN_TREATMENT (scripts/columnAccessReaders.ts)', missing.length === 0, missing.join(', '));
  const stale = Object.keys(COLUMN_TREATMENT).filter((ch) => !(ch in contracts) || contracts[ch].access !== 'read');
  ok('coverage: the table names no channel that is gone or no longer read', stale.length === 0, stale.join(', '));
  ok('NEGATIVE CONTROL: a planted read contract is reported', JSON.stringify(unclassified({ ...contracts, 'columns:planted': { access: 'read' } })) === '["columns:planted"]');

  const W = await C.columnWorld('column doors');
  if (!W) return finish();
  try {
    const { P, staff } = W;
    // ── 1. The net ───────────────────────────────────────────────────────────
    ok('net: Staff is closed to east for a whole-table reader', await W.as('east', () => access.closedToCaller(P, staff)));
    ok('NEGATIVE CONTROL: …open to hr, whom the rules name', !(await W.as('hr', () => access.closedToCaller(P, staff))));
    ok('NEGATIVE CONTROL: …open to the editor', !(await W.as('ed', () => access.closedToCaller(P, staff))));
    ok('net: inside a door that checked Staff, it is open to east', !(await W.as('east', () => access.withColumnsChecked(new Set([staff]), () => access.closedToCaller(P, staff)))));
    ok('net: …a door that checked another dataset does not open it', await W.as('east', () => access.withColumnsChecked(new Set([W.plain]), () => access.closedToCaller(P, staff))));
    ok('NEGATIVE CONTROL: policyClosed is rows only (Staff has no row rules)', !(await W.as('boss', () => access.policyClosed(P, staff))));
    ok('governed: Staff has column rules, for the replies sent alike to every reader', await W.as('boss', () => access.governed(P, staff)));
    ok('NEGATIVE CONTROL: governed: Plain has none', !(await W.as('boss', () => access.governed(P, W.plain))));
    ok('hiddenColumnsFor: east is hidden salary, ssn and the carrier bonus; hr nothing', [...(await W.as('east', () => access.hiddenColumnsFor(P, staff)))].sort().join() === 'bonus,salary,ssn' && (await W.as('hr', () => access.hiddenColumnsFor(P, staff))).size === 0);

    // ── Fixtures: metrics, a term, the requests ──────────────────────────────
    const saveMetric = async (name: string, definition: object): Promise<string> => {
      const r = await W.call('boss', 'metric:save', { projectId: P, input: { name, datasetId: staff, definition } });
      if (!r.body?.metric?.id) throw new Error(`metric:save ${name}: ${r.text.slice(0, 200)}`);
      return r.body.metric.id;
    };
    const PAYROLL = await saveMetric('Payroll', { column: 'salary', aggregation: 'sum' });
    const PAYROLL_PER_HEAD = await saveMetric('Payroll per head', { formula: 'sum(salary) / count(employee_id)' });
    const HEADCOUNT = await saveMetric('Headcount', { column: 'employee_id', aggregation: 'count' });
    const term = await W.call('boss', 'term:save', { projectId: P, input: { name: 'High earners', aliases: [], description: '', datasetId: staff, filters: [{ type: 'filter', column: 'salary', op: '>', value: 1200 }] } });
    const HIGH_EARNERS: string = term.body?.term?.id;
    ok('setup: three metrics and a term on Staff', !!HIGH_EARNERS, term.text.slice(0, 200));
    const COUNT = { column: 'employee_id', aggregation: 'count' };
    const BY_DEPT = { category: 'dept', values: [COUNT] };
    const viz = (encoding: object, filters: object[] = []) => ({ projectId: P, datasetId: staff, encoding, filters });
    const vizOn = (d: string, encoding: object) => ({ projectId: P, datasetId: d, encoding });
    const kpi = (column: string, aggregation: string) => ({ projectId: P, datasetId: staff, column, aggregation });
    const spec = (extra: object = {}) => ({ datasetId: staff, category: 'dept', measures: [COUNT], filters: [], ...extra });
    const page = (extra: object = {}, d = staff) => ({ projectId: P, datasetId: d, offset: 0, limit: 200, ...extra });
    /** A figure, or a refusal in any wire form (metric:values answers a bare `{id, ok:false}` for every row-policy refusal). */
    const refusedHidden = (ch: string, r: H.Reply): boolean => (ch === 'metric:values'
      ? r.status === 200 && Array.isArray(r.body) && r.body.length === 1 && r.body[0].ok === false && !('value' in r.body[0])
      : C.refusedAs(r, 'hidden'));
    const answered = (r: H.Reply): boolean => r.status === 200 && !H.refused(r) && !/row_policy/.test(r.text) && (Array.isArray(r.body) ? r.body.every((x: { ok?: unknown }) => x.ok !== false) : r.body?.ok !== false);

    // ── 2. Every door ────────────────────────────────────────────────────────
    const REFUSE: Array<[string, string, object]> = [
      ['category salary', 'visual:data', viz({ category: 'salary', values: [COUNT] })],
      ['sum(salary)', 'visual:data', viz({ category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] })],
      ['the carrier bonus', 'visual:data', viz({ category: 'dept', values: [{ column: 'bonus', aggregation: 'avg' }] })],
      ['a split by ssn', 'visual:data', viz({ category: 'dept', series: 'ssn', values: [COUNT] })],
      ['a filter on ssn', 'visual:data', viz(BY_DEPT, [{ type: 'filter', column: 'ssn', op: 'not_empty' }])],
      ['an LOD over salary', 'visual:data', viz({ category: 'dept', values: [{ column: '{FIXED dept: sum(salary)}', aggregation: 'sum' }] })],
      ['a formula metric over salary (re-entry)', 'visual:data', viz({ category: 'dept', values: [{ metricId: PAYROLL_PER_HEAD, column: 'x', aggregation: 'sum' }] })],
      ['a term on salary', 'visual:data', viz(BY_DEPT, [{ type: 'term', term: HIGH_EARNERS }])],
      ['KPI', 'dashboard:metric', kpi('salary', 'sum')],
      ['metric values', 'metric:values', { projectId: P, ids: [PAYROLL] }],
      ['answer card', 'answer:card', { projectId: P, spec: spec({ measures: [{ column: 'salary', aggregation: 'sum' }] }) }],
      ['joined: Plain by Staff.salary', 'visual:data', vizOn(W.plain, { category: 'salary', categoryDatasetId: staff, values: [{ column: 'sales', aggregation: 'sum' }] })],
      ['grid sort', 'dataset:page', page({ sortColumn: 'salary' })],
      ['grid search', 'dataset:page', page({ search: 'x' })],
      ['grid filter on ssn', 'dataset:page', page({ filters: [{ type: 'filter', column: 'ssn', op: 'not_empty' }] })],
      ['distinct', 'dataset:distinct', { projectId: P, datasetId: staff, column: 'ssn' }],
      ['distinct narrowed by salary', 'dataset:distinct', { projectId: P, datasetId: staff, column: 'dept', filters: [{ type: 'filter', column: 'salary', op: '>', value: 0 }] }],
      ['profile', 'dataset:profile', { projectId: P, datasetId: staff, column: 'salary' }],
      ['rows behind a mark on ssn', 'visual:rows', { projectId: P, datasetId: staff, encoding: { category: 'ssn', values: [COUNT] }, mark: { category: `${C.SSN_CANARY}_1` } }],
    ];
    for (const [what, ch, body] of REFUSE) {
      const mine = await W.call('east', ch, body);
      ok(`east: ${what} (${ch}) is refused, typed hidden`, refusedHidden(ch, mine) && !mine.text.includes(C.SSN_CANARY), `${mine.status} ${mine.text.slice(0, 200)}`);
      const theirs = await W.call('hr', ch, body);
      ok(`NEGATIVE CONTROL: hr gets ${what}`, answered(theirs), `${theirs.status} ${theirs.text.slice(0, 200)}`);
    }
    const sameFigure = (a: H.Reply, b: H.Reply): string => (a.status !== 200 || b.status !== 200 || a.body?.ok === false ? `not answered: ${a.text.slice(0, 120)}` : H.diff(a.body, b.body, {}));
    for (const [what, ch, body] of [
      ['headcount by dept', 'visual:data', viz(BY_DEPT)],
      ['headcount by dept, filtered on dept', 'visual:data', viz(BY_DEPT, [{ type: 'filter', column: 'dept', op: '=', value: 'Ops' }])],
      ['the headcount KPI', 'dashboard:metric', kpi('employee_id', 'count')],
      ['the Headcount metric', 'metric:values', { projectId: P, ids: [HEADCOUNT] }],
      ['the distinct depts', 'dataset:distinct', { projectId: P, datasetId: staff, column: 'dept' }],
    ] as const) {
      const d = sameFigure(await W.call('east', ch, body), await W.call('ed', ch, body));
      ok(`no figure moves: ${what} for east is Object.is-equal to the editor's`, d === '', d);
    }
    // An answer card: the same figures; its "Split by" chips offer no hidden column (the editor's do).
    const [eastCard, edCard] = [await W.call('east', 'answer:card', { projectId: P, spec: spec() }), await W.call('ed', 'answer:card', { projectId: P, spec: spec() })];
    const splits = (r: H.Reply): string => JSON.stringify((r.body?.chips ?? []).map((c: { label?: string }) => c.label));
    ok('no figure moves: an answer card by dept for east is Object.is-equal to the editor\'s', eastCard.body?.ok === true && H.diff(eastCard.body.data, edCard.body?.data, {}) === '', eastCard.text.slice(0, 200));
    ok('…its chips offer no hidden column', !/salary|ssn|bonus/.test(splits(eastCard)), splits(eastCard));
    ok('NEGATIVE CONTROL: …the editor\'s chips do', /salary|ssn|bonus/.test(splits(edCard)), splits(edCard));
    ok('NEGATIVE CONTROL: the comparison tells figures apart', sameFigure(await W.call('ed', 'visual:data', viz(BY_DEPT)), await W.call('ed', 'visual:data', viz({ category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] }))) !== '');
    const joined = await W.call('east', 'visual:data', vizOn(W.plain, { category: 'dept', categoryDatasetId: staff, values: [{ column: 'sales', aggregation: 'sum' }] }));
    ok('a join runs: Plain by Staff.dept, for east', joined.body?.ok === true && sameFigure(joined, await W.call('ed', 'visual:data', vizOn(W.plain, { category: 'dept', categoryDatasetId: staff, values: [{ column: 'sales', aggregation: 'sum' }] }))) === '', joined.text.slice(0, 200));
    // D20: with the KEY itself hidden, the join through it still runs; grouping by it is refused.
    await W.plant(staff, [...W.rules, { column: 'employee_id', visibleTo: [{ teamId: W.hrTeam }] }]);
    const throughKey = await W.call('east', 'visual:data', vizOn(W.plain, { category: 'dept', categoryDatasetId: staff, values: [{ column: 'sales', aggregation: 'sum' }] }));
    ok('a join THROUGH a hidden key runs (no key value reaches the reply)', throughKey.body?.ok === true && sameFigure(throughKey, joined) === '', throughKey.text.slice(0, 200));
    ok('…grouping by the hidden key is refused, typed hidden', C.refusedAs(await W.call('east', 'visual:data', vizOn(W.plain, { category: 'employee_id', categoryDatasetId: staff, values: [{ column: 'sales', aggregation: 'sum' }] })), 'hidden'));
    await W.plant(staff);

    // ── 3. Row readers ───────────────────────────────────────────────────────
    const COLS = ['dept', 'salary', 'ssn', 'employee_id', 'bonus'];
    const g = await W.call('east', 'dataset:page', page());
    const at = (n: string) => COLS.indexOf(n);
    ok('the grid: hidden cells are null in place, and named', g.status === 200 && Array.isArray(g.body?.hidden) && g.body.hidden.join() === 'salary,ssn,bonus' && !g.text.includes(C.SSN_CANARY)
      && g.body.rows.length === 12 && g.body.rows.every((r: unknown[]) => r.length === COLS.length && r[at('salary')] === null && r[at('ssn')] === null && r[at('bonus')] === null && typeof r[at('dept')] === 'string'), g.text.slice(0, 300));
    const edGrid = await W.call('ed', 'dataset:page', page());
    ok('NEGATIVE CONTROL: the editor\'s grid carries the canary, and no `hidden`', edGrid.text.includes(C.SSN_CANARY) && !('hidden' in edGrid.body), edGrid.text.slice(0, 160));
    ok('…and hr\'s grid too', (await W.call('hr', 'dataset:page', page())).text.includes(C.SSN_CANARY));
    ok('the grid of a dataset without rules carries no `hidden`, as before', !('hidden' in (await W.call('east', 'dataset:page', page({}, W.plain))).body));
    const mark = { projectId: P, datasetId: staff, encoding: BY_DEPT, mark: { category: 'Ops' }, page: { offset: 0, limit: 50 } };
    const rows = await W.call('east', 'visual:rows', mark);
    ok('rows behind a mark: the hidden cells are null in place, and named', rows.body?.ok === true && rows.body.hidden?.join() === 'salary,ssn,bonus' && rows.body.rows.length === 4 && !rows.text.includes(C.SSN_CANARY)
      && rows.body.rows.every((r: unknown[]) => r.length === rows.body.columns.length && r[at('salary')] === null), rows.text.slice(0, 300));
    ok('NEGATIVE CONTROL: …the editor\'s rows carry the canary', (await W.call('ed', 'visual:rows', mark)).text.includes(C.SSN_CANARY));
    const csv = async (who: string): Promise<string> => {
      const { page: _p, ...drill } = mark;
      const dl = await W.call(who, 'visual:rowsDownload', { ...drill, name: 'Ops' });
      if (!dl.body?.downloadToken) return `no file: ${dl.text.slice(0, 200)}`;
      const f = await W.app.inject({ method: 'GET', url: `/api/files/${dl.body.downloadToken}`, headers: { 'x-forwarded-email': `${who}@acme.test` }, remoteAddress: '127.0.0.1' });
      return f.body;
    };
    const eastCsv = await csv('east');
    ok('the rows\' CSV: no hidden column at all, header or cells', eastCsv.split(/\r?\n/)[0] === 'dept,employee_id' && !eastCsv.includes(C.SSN_CANARY) && eastCsv.split(/\r?\n/).filter(Boolean).length === 5, eastCsv.slice(0, 200));
    ok('NEGATIVE CONTROL: …the editor\'s CSV carries them', (await csv('ed')).includes(C.SSN_CANARY));

    // ── 4. Fail closed ───────────────────────────────────────────────────────
    ok('the net: dataset:stats refuses east, typed columns', C.refusedAs(await W.call('east', 'dataset:stats', { projectId: P, datasetId: staff }), 'columns'));
    ok('NEGATIVE CONTROL: …hr reads them', answered(await W.call('hr', 'dataset:stats', { projectId: P, datasetId: staff })));
    const afterStep = async (step: object, check: () => Promise<boolean>): Promise<boolean> => {
      const added = await W.call('boss', 'dataset:addStep', { projectId: P, datasetId: staff, step });
      if (added.body?.ok !== true) throw new Error(`addStep: ${added.text.slice(0, 200)}`);
      const undo = async (): Promise<void> => {
        const steps = (await W.rawOf(staff)).steps as unknown[];
        const set = await W.call('boss', 'dataset:setSteps', { projectId: P, datasetId: staff, steps: steps.slice(0, -1) });
        if (set.body?.ok !== true) throw new Error(`setSteps: ${set.text.slice(0, 200)}`);
      };
      try { return await check(); } finally { await undo(); }
    };
    ok('fail closed: a later step reading salary closes Staff to east', await afterStep({ type: 'calculated_field', name: 'salary2', expression: '[salary] * 2' }, async () => C.refusedAs(await W.call('east', 'visual:data', viz(BY_DEPT)), 'columns')));
    ok('NEGATIVE CONTROL: a later step not reading salary keeps it open', await afterStep({ type: 'calculated_field', name: 'dept2', expression: '[dept]' }, async () => answered(await W.call('east', 'visual:data', viz(BY_DEPT)))));
    ok('NEGATIVE CONTROL: …and the rules hold again once it is gone', answered(await W.call('east', 'visual:data', viz(BY_DEPT))));
    const withCorrupt = async (check: () => Promise<boolean>): Promise<boolean> => {
      const stored = (await W.rawOf(staff)).columnAccess;
      await W.setRaw(staff, { columns: 'not a list' });
      try { return await check(); } finally { await W.setRaw(staff, stored); }
    };
    ok('fail closed: a corrupt rule closes it to east', await withCorrupt(async () => C.refusedAs(await W.call('east', 'visual:data', viz(BY_DEPT)), 'columns')));
    ok('fail closed: …and to hr (every restricted caller)', await withCorrupt(async () => C.refusedAs(await W.call('hr', 'visual:data', viz(BY_DEPT)), 'columns')));
    ok('NEGATIVE CONTROL: …the editor reads it', await withCorrupt(async () => answered(await W.call('ed', 'visual:data', viz(BY_DEPT)))));
    const SQL_OVER_STAFF = await W.as('boss', async () => (await datasets.saveDataset(P, { name: 'Over staff', sourceKind: 'sql', columns: C.STAFF_COLUMNS, rows: C.STAFF_ROWS, origin: { kind: 'sql', sql: 'SELECT * FROM "Staff"', deps: [staff] } } as never))!.id);
    ok('fail closed: a SQL dataset over Staff is closed to east, open to hr', C.refusedAs(await W.call('east', 'dataset:page', page({}, SQL_OVER_STAFF)), 'columns') && answered(await W.call('hr', 'dataset:page', page({}, SQL_OVER_STAFF))));
    ok('setup: the editor\'s chart by dept on it is cached', (await W.call('ed', 'visual:data', vizOn(SQL_OVER_STAFF, BY_DEPT))).body?.ok === true);
    ok('…its chart by dept too, cached or not (its rows carry the hidden values)', C.refusedAs(await W.call('east', 'visual:data', vizOn(SQL_OVER_STAFF, BY_DEPT)), 'columns'));
    const asOf = new Date().toISOString();
    ok('fail closed: an as-of read refuses east, typed columns (a snapshot\'s rules are not the record\'s)', C.refusedAs(await W.call('east', 'visual:data', { ...viz(BY_DEPT), asOf }), 'columns'));
    ok('NEGATIVE CONTROL: …hr\'s as-of read is not refused for columns', !C.refusedAs(await W.call('hr', 'visual:data', { ...viz(BY_DEPT), asOf }), 'columns'));

    // ── 5. Live ──────────────────────────────────────────────────────────────
    fakeMod.registerLiveFake();
    const liveStaff = await W.as('boss', async () => {
      await fakeMod.loadWarehouseTable('cg_staff', C.STAFF_COLUMNS, C.STAFF_ROWS);
      const conn = await connections.saveConnection(P, { name: 'Fake', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
      return (await liveRecord.saveLiveRecord(P, { name: 'Staff (live)', columns: C.STAFF_COLUMNS, origin: { kind: 'connection', connId: conn!.id, table: 'cg_staff' } }))!.id;
    });
    await W.plant(liveStaff);
    fakeMod.resetFake();
    const liveRefused = await W.call('east', 'visual:data', vizOn(liveStaff, { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] }));
    ok('Live: a question naming salary is refused before any statement', C.refusedAs(liveRefused, 'hidden') && fakeMod.fake.calls.length === 0, `${fakeMod.fake.calls.length} ${liveRefused.text.slice(0, 200)}`);
    const liveAnswered = await W.call('east', 'visual:data', vizOn(liveStaff, BY_DEPT));
    ok('Live: one not naming it compiles and runs once', liveAnswered.body?.ok === true && fakeMod.fake.calls.length === 1, `${fakeMod.fake.calls.length} ${liveAnswered.text.slice(0, 200)}`);
    const liveKpi = await W.call('east', 'dashboard:metric', { projectId: P, datasetId: liveStaff, column: 'ssn', aggregation: 'count' });
    ok('Live: a KPI on ssn is refused before any statement', C.refusedAs(liveKpi, 'hidden') && fakeMod.fake.calls.length === 1, liveKpi.text.slice(0, 200));
    ok('NEGATIVE CONTROL: Live: hr\'s sum(salary) runs', (await W.call('hr', 'visual:data', vizOn(liveStaff, { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] }))).body?.ok === true && fakeMod.fake.calls.length === 2);
    // A profiled Live dataset answers a column's profile from its sample, before any chart door: only the outer gate stands in front.
    const synced = await W.call('boss', 'dataset:syncLiveSchema', { projectId: P, datasetId: liveStaff });
    const prof = (who: string) => W.call(who, 'dataset:profile', { projectId: P, datasetId: liveStaff, column: 'salary' });
    const hrProf = await prof('hr');
    ok('setup: the Live dataset is profiled from a sample (hr reads salary\'s)', synced.body?.ok === true && hrProf.body?.ok === true && !!hrProf.body.profile?.sample, `${synced.text.slice(0, 120)} | ${hrProf.text.slice(0, 160)}`);
    ok('Live: salary\'s sampled profile is refused east, typed hidden', C.refusedAs(await prof('east'), 'hidden'));

    // ── 6. Cache order, and planted readers ──────────────────────────────────
    const SUM_SALARY_BY_DEPT = { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }], grain: undefined };
    const edSum = await W.call('ed', 'visual:data', viz(SUM_SALARY_BY_DEPT)); // the editor's answer is now cached
    ok('setup: the editor\'s sum(salary) by dept is answered (and cached)', edSum.body?.ok === true);
    ok('cache order: east is refused the cached sum(salary)', C.refusedAs(await W.call('east', 'visual:data', viz(SUM_SALARY_BY_DEPT)), 'hidden'));
    doors.setColumnGateForTest(false);
    try {
      const leaked = await W.call('east', 'visual:data', viz(SUM_SALARY_BY_DEPT));
      ok('NEGATIVE CONTROL: with the gate off, east would get the editor\'s cached answer', sameFigure(leaked, edSum) === '', leaked.text.slice(0, 200));
    } finally {
      doors.setColumnGateForTest(true);
    }
    ok('…and with it back on, refused again', C.refusedAs(await W.call('east', 'visual:data', viz(SUM_SALARY_BY_DEPT)), 'hidden'));
    (api.contracts as Record<string, unknown>)['columns:plantedPath'] = contractMod.rpc({ access: 'read', input: z.strictObject({ projectId: z.string(), datasetId: z.string() }), project: (i: { projectId: string }) => i.projectId });
    (api.contracts as Record<string, unknown>)['columns:plantedNet'] = contractMod.rpc({ access: 'read', input: z.strictObject({ projectId: z.string(), datasetId: z.string() }), project: (i: { projectId: string }) => i.projectId });
    rpc.registry.handle('columns:plantedPath', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => {
      const meta = await datasets.getDatasetMeta(projectId, datasetId);
      const t = await parquet.readTableAsync(rec.tablePath(projectId, datasetId, meta?.storageVersion), meta!.columns);
      return { rows: t ? t.rows : [] };
    });
    rpc.registry.handle('columns:plantedNet', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => ({ rows: (await datasets.getDataset(projectId, datasetId))?.rows ?? [] }));
    ok('a planted getDataset reader is refused by the net, typed columns', C.refusedAs(await W.call('east', 'columns:plantedNet', { projectId: P, datasetId: staff }), 'columns'));
    ok('NEGATIVE CONTROL: …hr reads it whole', (await W.call('hr', 'columns:plantedNet', { projectId: P, datasetId: staff })).text.includes(C.SSN_CANARY));
    ok('NEGATIVE CONTROL: a planted reader of the Parquet by path IS caught by the canary check (the REDACT/SKIP rows of step 06 exist for it)', (await W.call('east', 'columns:plantedPath', { projectId: P, datasetId: staff })).text.includes(C.SSN_CANARY));
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
