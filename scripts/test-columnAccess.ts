// Column access rules, PURE (semantic layer part 4, D12–D16): the rule shape and
// its sanitizer, who a column is hidden from, the columns computed from a hidden
// one (carriers), whether the rules still hold on the record as it is now, and
// the conservative matcher the door gate asks.
//
//   npm run build:ts && node scripts/test-columnAccess.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const ca: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const { stableStringify } = require('../src/engine/queryCache') as typeof import('../src/engine/queryCache');
const { carriersOf, accessState, buildColumnAccess, columnAccessFromRecord, hiddenFor, everyRuled, mentionsHidden, nullHidden, withoutColumns } = ca;
type Step = import('../src/data/transforms').TransformStep;

const HR = '11111111-1111-4111-8111-111111111111';
const U_HR = '22222222-2222-4222-8222-222222222222';
const U_NEW = '33333333-3333-4333-8333-333333333333';
const SRC = ['dept', 'salary', 'ssn', 'employee_id'];
const SRC_NO_SALARY = SRC.filter((c) => c !== 'salary');
const FINAL = [...SRC, 'bonus_pct'];
const S = [{ type: 'calculated_field', name: 'bonus', expression: '[salary] * 0.1' }, { type: 'rename_column', from: 'bonus', to: 'bonus_pct' }] as Step[];
const UNPIVOT = { type: 'unpivot', columns: ['salary'], attribute: 'attribute', value: 'value' } as unknown as Step;
// The source calls it `sal`; Prepare renames it onto the hidden name. A column computed from `sal` before the rename carries it.
const SRC2 = ['dept', 'sal'];
const CALC_FROM_SAL_BEFORE = { type: 'calculated_field', name: 'calc', expression: '[sal] * 2' } as Step;
const FINAL2 = ['dept', 'salary', 'calc'];
const CALC_SALARY2 = { type: 'calculated_field', name: 'salary2', expression: '[salary] * 2' } as Step;
const CALC_DEPT = { type: 'calculated_field', name: 'dept2', expression: 'upper([dept])' } as Step;
const cols = (names: string[]) => names.map((name) => ({ name, type: (name === 'salary' || name === 'bonus' ? 'number' : 'text') as 'number' | 'text' }));
const RAW: Record<string, unknown> = { columns: cols([...SRC, 'bonus']), source: { columns: cols(SRC) }, steps: [S[0]] };
const withStep = (raw: Record<string, unknown>, step: Step) => ({ ...raw, steps: [...(raw.steps as Step[]), step], columns: [...(raw.columns as object[]), { name: (step as { name: string }).name, type: 'number' }] });
const withColumns = (raw: Record<string, unknown>, names: string[]) => ({ ...raw, columns: cols(names), source: { columns: cols(names) } });
const NO_SALARY = ['dept', 'pay', 'ssn', 'employee_id', 'bonus'];
const A = buildColumnAccess(RAW, [{ column: 'salary', visibleTo: [{ teamId: HR }] }], 'boss@acme.test', '2026-11-05T00:00:00.000Z');
const H = new Set(['salary', 'ssn']);

(() => {
  // ── carriers ──────────────────────────────────────────────────────────────
  ok('a formula over salary carries it, and a rename walks it on', stableStringify([...carriersOf(S, SRC, FINAL, ['salary']).carriers]) === stableStringify([['bonus', 'salary'], ['bonus_pct', 'salary']]));
  ok('an unpivot after salary hides every column it makes', carriersOf([UNPIVOT], SRC, [...SRC_NO_SALARY, 'attribute', 'value'], ['salary']).carriers.has('value'));
  ok('a filter on salary is a reader, not a carrier', ((r) => r.carriers.size === 0 && r.readers.length === 1)(carriersOf([{ type: 'filter', column: 'salary', op: '>', value: 1 }] as Step[], SRC, FINAL, ['salary'])));
  ok('a rename ONTO the hidden name hides its source too', carriersOf([CALC_FROM_SAL_BEFORE, { type: 'rename_column', from: 'sal', to: 'salary' }] as Step[], SRC2, FINAL2, ['salary']).carriers.has('calc'));
  ok('an unknown step after salary: unknown', carriersOf([{ type: 'future_x' } as never], SRC, FINAL, ['salary']).unknown);
  ok('NEGATIVE CONTROL: a formula over dept carries nothing and reads nothing hidden', ((r) => r.carriers.size === 0 && r.readers.length === 0 && !r.unknown)(carriersOf([CALC_DEPT], SRC, [...SRC, 'dept2'], ['salary'])));
  ok('an LOD over salary in a calculated field carries it', carriersOf([{ type: 'calculated_field', name: 'lod', expression: '{FIXED [dept]: SUM([salary])}' } as Step], SRC, [...SRC, 'lod'], ['salary']).carriers.get('lod') === 'salary');
  ok('a step overwriting a visible column with a formula over salary hides that column', carriersOf([{ type: 'calculated_field', name: 'dept', expression: '[salary] + 1' } as Step], SRC, SRC, ['salary']).carriers.has('dept'));
  ok('a dedupe over every column reads salary (which rows survive depends on it)', carriersOf([{ type: 'dedupe' } as Step], SRC, SRC, ['salary']).readers.length === 1);
  // A carrier of two hidden columns is visible only to those who see both.
  const two = buildColumnAccess({ columns: cols([...SRC, 'mix']), steps: [{ type: 'calculated_field', name: 'mix', expression: '[salary] + [ssn]' }] }, [{ column: 'salary', visibleTo: [{ teamId: HR }, { userId: U_HR }] }, { column: 'ssn', visibleTo: [{ userId: U_HR }] }], 'b', 'a');
  ok('a carrier of two hidden columns is visible to the members both name', stableStringify(two.columns.find((c) => c.column === 'mix')) === stableStringify({ column: 'mix', visibleTo: [{ userId: U_HR }], from: 'salary' }));

  // ── the stored rules, and whether they still hold ─────────────────────────
  ok('the builder adds the carrier, inheriting visibleTo, and pins the readers', stableStringify(A.columns) === stableStringify([{ column: 'salary', visibleTo: [{ teamId: HR }] }, { column: 'bonus', visibleTo: [{ teamId: HR }], from: 'salary' }]) && A.readersHash.length === 16);
  ok('state: the rules hold on the record they were built on', accessState(RAW, A) === 'ok');
  ok('state: a new step reading salary is pipeline; one that does not is ok', accessState(withStep(RAW, CALC_SALARY2), A) === 'pipeline' && accessState(withStep(RAW, CALC_DEPT), A) === 'ok');
  ok('state: a new filter on salary (a reader that makes nothing) is pipeline', accessState({ ...RAW, steps: [S[0], { type: 'filter', column: 'salary', op: '>', value: 5 }] }, A) === 'pipeline');
  ok('state: the source column renamed away is gone', accessState(withColumns(RAW, NO_SALARY), A) === 'gone');
  ok('state: a rule column a Live warehouse dropped is gone', accessState({ ...RAW, mode: 'live', live: { missingColumns: ['salary'] } }, A) === 'gone');
  ok('state: an unknown step is pipeline', accessState({ ...RAW, steps: [S[0], { type: 'future_x' }] }, A) === 'pipeline');
  ok('state: a pivot over salary whose data made a column no rule names is pipeline', ((raw) => accessState({ ...raw, columns: [...(raw.columns as object[]), { name: 'Q9', type: 'number' }] }, buildColumnAccess(raw, [{ column: 'salary', visibleTo: [] }], 'b', 'a')) === 'pipeline')(
    { columns: cols(['dept', 'salary', 'Q1']), steps: [{ type: 'pivot', key: 'dept', value: 'salary', fn: 'sum', groupBy: [] }], source: { columns: cols(['dept', 'salary']) } }));
  ok('corrupt is closed, absent is none', columnAccessFromRecord({ columnAccess: 'x' }) === 'closed' && columnAccessFromRecord({}) === null && columnAccessFromRecord({ columnAccess: null }) === 'closed');
  ok('a member that is not one id is closed (bare ids, both kinds, junk)', ['t', { userId: 'x' }, { userId: U_HR, teamId: HR }].every((m) => columnAccessFromRecord({ columnAccess: { ...A, columns: [{ column: 'salary', visibleTo: [m] }] } }) === 'closed'));
  ok('too many ruled columns is closed', columnAccessFromRecord({ columnAccess: { ...A, columns: Array.from({ length: ca.MAX_RULED_COLUMNS + 1 }, (_, i) => ({ column: `c${i}`, visibleTo: [] })) } }) === 'closed');
  const once = columnAccessFromRecord({ columnAccess: { ...A, columns: [{ column: 'salary', visibleTo: [{ teamId: HR.toUpperCase() }] }] } });
  ok('sanitize twice == once (ids lowercased)', typeof once === 'object' && !!once && stableStringify(columnAccessFromRecord({ columnAccess: once })) === stableStringify(once) && stableStringify(once.columns[0].visibleTo) === stableStringify([{ teamId: HR }]));

  // ── who it is hidden from ─────────────────────────────────────────────────
  ok('allow-list: a team member sees it, someone added later does not', !hiddenFor(A, U_HR, [HR]).has('salary') && hiddenFor(A, U_NEW, []).has('salary'));
  ok('allow-list: a carrier is hidden as its source is', hiddenFor(A, U_NEW, []).has('bonus') && !hiddenFor(A, U_HR, [HR]).has('bonus'));
  ok('the least-entitled audience: every ruled column', [...everyRuled(A)].join() === 'salary,bonus');

  // ── the matcher ───────────────────────────────────────────────────────────
  ok('matcher: inside a formula and an LOD, bounded', mentionsHidden({ v: '{FIXED dept: sum(salary)}' }, H) && mentionsHidden(['[Salary]'], H) && !mentionsHidden(['salary_band'], H));
  ok('matcher: a filter value, a sort column and a nested step', mentionsHidden({ filters: [{ type: 'filter', column: 'dept', op: '=', value: 'x' }], sortColumn: 'SSN' }, H) && mentionsHidden([[{ deep: ['a', { b: 'sum(salary)' }] }]], H));
  ok('NEGATIVE CONTROL: a question naming nothing hidden passes', !mentionsHidden({ category: 'dept', values: [{ column: 'headcount', aggregation: 'count' }] }, H));
  ok('NEGATIVE CONTROL: nothing hidden, nothing matches', !mentionsHidden(['salary'], new Set()));

  // ── row readers ───────────────────────────────────────────────────────────
  const C = cols(['dept', 'salary', 'ssn']);
  const rows = [['Ops', 10, 'S1'], ['Eng', 20, 'S2']];
  ok('nullHidden: hidden cells are null in place, the row length kept', stableStringify(nullHidden(rows, C, H)) === stableStringify([['Ops', null, null], ['Eng', null, null]]));
  ok('NEGATIVE CONTROL: nullHidden with nothing hidden is the same rows', nullHidden(rows, C, new Set()) === rows);
  const t = withoutColumns({ columns: C, rows, name: 'Staff' }, H);
  ok('withoutColumns: the hidden columns and their cells are gone, the rest kept', stableStringify(t) === stableStringify({ columns: [C[0]], rows: [['Ops'], ['Eng']], name: 'Staff' }));
  finish();
})();
