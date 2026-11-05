// The formula's SQL back end (semantic layer part 8, step 03): the Live function
// table, the dialect members a formula needs, then the builder's types, refusals
// and per-dialect shapes. The row-by-row agreement with evaluate() is
// test-formulaSqlDiff.
//
//   npm run build:ts && node scripts/test-formulaSql.js

import { ok, finish } from './selfcheck';
import { FUNCTIONS } from '../src/formula/formulaEval';
import { DIALECT_IDS, dialectFor } from '../src/engine/live/dialects';
import { likeAffix, likePattern } from '../src/engine/live/dialect';
import { ParamSink } from '../src/engine/live/sqlParams';
import { LIVE_FUNCTIONS, SPELL, V1_FUNCTIONS, liveFn } from '../src/engine/live/formulaSqlFunctions';
import { CalcError, SqlFormulaBuilder, checkCalc, compileCalcSql, MAX_CALC_SQL } from '../src/engine/live/formulaSql';
import type { CalcRefusalCode } from '../src/engine/live/formulaSql';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { CompileDialectId } from '../src/engine/live/dialect';
import type { LiveCalc } from '../src/data/liveCalcs';

const show = (v: unknown): string => JSON.stringify(v);
const sink = new ParamSink();

// § table
ok('the table names every FUNCTIONS key, and nothing else', show(Object.keys(LIVE_FUNCTIONS).sort()) === show(Object.keys(FUNCTIONS).sort()));
ok('26 in v1, 57 refused, each with a reason (lower and upper are refused: F6)',
  V1_FUNCTIONS.length === 26 && Object.values(LIVE_FUNCTIONS).filter((f) => !f.v1 && typeof f.reason === 'string').length === 57);
ok('lower and upper are refused for their casing', show([liveFn('lower'), liveFn('upper')]) === show([{ v1: false, reason: 'casing' }, { v1: false, reason: 'casing' }]));
ok('the table is read by its own names only', ['constructor', '__proto__', 'toString', 'hasOwnProperty'].every((n) => liveFn(n) === undefined) && liveFn('abs')?.v1 === true);
ok('every v1 arity is a range from at least 1', V1_FUNCTIONS.every((n) => { const f = liveFn(n); return !!f && f.v1 && f.arity[0] >= 1 && f.arity[1] >= f.arity[0]; }));

// § members
for (const id of DIALECT_IDS) {
  const d = dialectFor(id);
  ok(`${id}: every new member spells`, [d.lower('x'), d.upper('x'), d.floor('x'), d.ceil('x'), d.trimJs('x', sink)].every((s) => typeof s === 'string' && /x/.test(s))
    && (['year', 'month', 'day', 'quarter'] as const).every((p) => /x/.test(d.datePart('x', p))));
}
ok('databricks floor and ceil keep a double past 2^52', dialectFor('databricks').floor('x').includes('4503599627370496') && dialectFor('databricks').ceil('x').includes('4503599627370496'));
ok('clickhouse changes case with the UTF-8 functions and reads parts with its own', dialectFor('clickhouse').lower('x') === 'lowerUTF8(x)' && dialectFor('clickhouse').upper('x') === 'upperUTF8(x)'
  && dialectFor('clickhouse').datePart('x', 'day') === 'toDayOfMonth(x)');
ok('the other dialects read a date part with EXTRACT', DIALECT_IDS.filter((id) => id !== 'clickhouse').every((id) => dialectFor(id).datePart('x', 'quarter') === 'EXTRACT(QUARTER FROM x)'));
ok('trimJs is caseKey without the lower', DIALECT_IDS.every((id) => {
  const d = dialectFor(id);
  return d.caseKey('x', new ParamSink()).replace(/^(lower|LOWER|lowerUTF8)\(/, '').slice(0, -1) === d.trimJs('x', new ParamSink());
}));
ok('likeAffix escapes % _ and the escape, and places %', likeAffix('a%_\\', '\\', 'starts') === 'a\\%\\_\\\\%'
  && likeAffix('a!', '!', 'ends') === '%a!!' && likeAffix('a', '!', 'contains') === '%a%');
ok('likePattern is likeAffix contains', likePattern('5%_!x', '!') === likeAffix('5%_!x', '!', 'contains'));
ok('NEGATIVE CONTROL: a function added to FUNCTIONS alone breaks the key check', show(Object.keys(LIVE_FUNCTIONS).sort()) !== show([...Object.keys(FUNCTIONS), 'zz_new'].sort()));
ok('every v1 function has a spelling, and only those (round is the builder\'s own)',
  show(Object.keys(SPELL).sort()) === show(V1_FUNCTIONS.filter((n) => n !== 'round').sort()));

// ── Task 2: the builder ──────────────────────────────────────────────────────

const COLS: LiveColumn[] = [
  { name: 'amt', type: 'number', sourceType: 'DOUBLE' }, { name: 'qty', type: 'number', sourceType: 'VARCHAR' },
  { name: 'cat', type: 'text', sourceType: 'VARCHAR' }, { name: 'd', type: 'date', sourceType: 'DATE' },
  { name: 'ts', type: 'date', sourceType: 'TIMESTAMP' }, { name: 'dt', type: 'date', sourceType: 'VARCHAR' },
];
const A: LiveCalc = { name: 'A', expression: '[amt] * 2', type: 'number' };
const B: LiveCalc = { name: 'B', expression: "concat([cat], 'x')", type: 'text' };
const check = (expr: string, earlier: LiveCalc[] = [], later: LiveCalc[] = []) => checkCalc(expr, COLS, earlier, later);
const accepts = (expr: string, type: 'number' | 'text', earlier: LiveCalc[] = []): void => {
  const r = check(expr, earlier);
  ok(`accepts ${expr} as ${type}`, r.ok && r.type === type, show(r));
};
const refuses = (expr: string, code: CalcRefusalCode, earlier: LiveCalc[] = [], later: LiveCalc[] = []): void => {
  const r = check(expr, earlier, later);
  ok(`refuses ${expr}: ${code}`, !r.ok && r.code === code && typeof r.error === 'string' && r.error.length > 0, show(r));
};

// § types — a result's type comes from the formula; a boolean and a NULL are stored as text
for (const [expr, type] of [['[amt] + 1', 'number'], ['[cat]', 'text'], ['[amt] > 1', 'text'], ['null', 'text'], ['year([ts])', 'number'],
  ["IF [amt] > 0 THEN 'up' END", 'text'], ['isnull([cat])', 'text'], ['zn(null)', 'number']] as const) accepts(expr, type);
const r0 = check('[amt] + [cat2]');
ok('an unknown column is refused, named and underlined', !r0.ok && r0.code === 'unknownColumn' && r0.error.includes('"cat2"') && show(r0.at) === '{"start":8,"end":14}', show(r0));

// § refusals — one accepted and one refused case per rule
accepts('[cat]', 'text'); refuses('[cat] + 1', 'types');
accepts('year([d])', 'number'); refuses('year([dt])', 'dateColumn');
accepts('[A] + 1', 'number', [A]); refuses('[B] + 1', 'types', [B]);
refuses('[B] + 1', 'laterCalc', [], [B]); refuses('[B] + 1', 'unknownColumn');
accepts('[amt] / [qty] - -[amt]', 'number'); refuses('[amt] % 2', 'mod'); refuses("'a' * 2", 'types'); refuses('-[cat]', 'types');
accepts("[cat] = 'a'", 'text'); accepts('[amt] != null', 'text'); refuses('[cat] = 1', 'types'); refuses('[ts] = [ts]', 'timestampCompare');
refuses('[ts] != null', 'timestampCompare');
accepts('[d] < [d]', 'text'); accepts("[cat] >= 'b'", 'text'); accepts('null < [amt]', 'text'); refuses('[ts] < [d]', 'timestampCompare');
refuses('true < false', 'types'); refuses('[d] < [amt]', 'types');
accepts("[amt] > 1 and not [cat] = 'a' or false", 'text'); refuses('[amt] and true', 'notBoolean'); refuses('not [cat]', 'notBoolean');
accepts("[cat] IN ('a', 'b', null)", 'text'); accepts('[amt] IN (-1, 2.5)', 'text'); refuses('[cat] IN ([cat])', 'notLiteral');
refuses("[amt] IN ('a')", 'types'); refuses('[ts] IN (null)', 'timestampCompare');
accepts("CASE [cat] WHEN 'a' THEN 1 WHEN null THEN 0 ELSE 2 END", 'number'); refuses("CASE [cat] WHEN 'a' THEN 1 ELSE 'x' END", 'types');
refuses('CASE [cat] WHEN [cat] THEN 1 END', 'notLiteral');
accepts("IF [amt] > 0 THEN 'pos' ELSEIF [amt] < 0 THEN 'neg' ELSE null END", 'text'); refuses('IF [amt] THEN 1 END', 'notBoolean');
accepts('if([amt] > 0, [amt], null)', 'number'); refuses("if([amt] > 0, 1, 'a')", 'types');
accepts('iif([amt] > 0, 1, 2, 3)', 'number'); refuses("iif([cat], 1, 2)", 'notBoolean');
accepts('isnull([d])', 'text'); accepts('ifnull([amt], 0)', 'number'); accepts("coalesce([cat], 'x', null)", 'text');
refuses('coalesce([cat], 1)', 'types'); refuses('zn([cat])', 'types'); refuses('ifnull([d], [amt])', 'types');
for (const f of ['abs', 'sign', 'floor', 'ceil', 'ceiling', 'sqrt', 'square']) { accepts(`${f}([amt])`, 'number'); refuses(`${f}([cat])`, 'types'); }
accepts('round([amt]) + round([amt], 2) + round([amt], -2)', 'number'); refuses('round([amt], 16)', 'roundDigits');
refuses('round([amt], [qty])', 'roundDigits'); refuses('round([amt], 1.5)', 'roundDigits'); refuses('round([cat], 1)', 'types');
accepts('min([amt], [qty], 0) + max([amt])', 'number'); refuses('min([cat])', 'types'); refuses("max([amt], 'a')", 'types');
accepts('trim([cat])', 'text'); refuses('trim([amt])', 'types');
accepts("contains([cat], 'a%') or startswith([cat], '') or endswith([cat], null)", 'text'); refuses('contains([cat], [cat])', 'notLiteral');
refuses('contains([cat], 1)', 'notLiteral'); refuses("contains([amt], 'a')", 'types');
accepts("concat([cat], 'x', null)", 'text'); refuses('concat([amt])', 'types');
accepts("datediff('Month', [d], [ts]) + datediff(' day ', [d], [d]) + datediff('QUARTER', [ts], [d]) + datediff('year', [d], [d])", 'number');
refuses("datediff('week', [d], [d])", 'datediffPart'); refuses('datediff([cat], [d], [d])', 'datediffPart'); refuses("datediff('day', [cat], [d])", 'types');
refuses('{FIXED : SUM([amt])}', 'lod'); refuses('[[p]] + 1', 'param');
refuses('[d]', 'dateResult'); refuses('ifnull([d], [ts])', 'dateResult');
refuses('abs([amt], 1)', 'arity'); refuses('if([amt] > 0, 1)', 'arity'); refuses('datediff([d], [d])', 'arity');
refuses('1e999 + 1', 'types');
refuses('lower([cat])', 'function'); refuses('upper([cat])', 'function'); refuses('today()', 'function');

const unknownFn = ((): unknown => {
  try { return new SqlFormulaBuilder({ d: dialectFor('duckdb'), b: new ParamSink(), columns: COLS, earlier: [] }).call('zz_new', [], 0); } catch (e) { return e; }
})();
ok('a function the table does not know is refused, never spelled', unknownFn instanceof CalcError && unknownFn.code === 'function' && unknownFn.tokenIndex === 0, show(unknownFn));
const r1 = checkCalc('len([cat])', COLS, []);
ok('a refused function names the function, says why, and underlines it', !r1.ok && r1.code === 'function'
  && r1.error === "len() can't run on a Live table: warehouses count characters differently." && show(r1.at) === '{"start":0,"end":3}', show(r1));
const r2 = check('[amt] +');
ok('a parser error is a syntax refusal at its token', !r2.ok && r2.code === 'syntax' && show(r2.at) === '{"start":6,"end":7}', show(r2));
const r3 = check("'abc");
ok('a tokenizer error is a syntax refusal at its span (FormulaError.at)', !r3.ok && r3.code === 'syntax' && show(r3.at) === '{"start":0,"end":4}', show(r3));
const r4 = check('constructor([amt])');
ok('an inherited name is an unknown function, never a spelling', !r4.ok && r4.code === 'syntax' && r4.error === 'Unknown function: constructor', show(r4));
const r5 = check('round([amt]) - [cat]');
ok('a refusal underlines its operator', !r5.ok && r5.code === 'types' && show(r5.at) === '{"start":13,"end":14}', show(r5));
const r6 = check('   ');
ok('an empty formula is refused', !r6.ok && r6.code === 'syntax');

// The CASE spellings repeat their operands, so nesting multiplies: a formula past MAX_CALC_SQL stops early, refused.
refuses(`min(${Array(200).fill('[amt]').join(', ')})`, 'tooLong');
refuses('round(round(round(round(round(round(round(round(round([amt], 1), 1), 1), 1), 1), 1), 1), 1), 1)', 'tooLong');
ok('a formula under the cap compiles', check(`min(${Array(10).fill('[amt]').join(', ')})`).ok && MAX_CALC_SQL === 262144);

// § shapes — the fragments each dialect must spell (and must not)
function compiled(id: CompileDialectId, expr: string): string {
  const r = compileCalcSql(expr, { d: dialectFor(id), b: new ParamSink(), columns: COLS, earlier: [A] });
  return r.ok ? r.sql : `REFUSED ${r.code}`;
}
const BANG = ["ESCAPE '!'"];
const SHAPES: Record<CompileDialectId, [string, string[]][]> = {
  duckdb: [['trim([cat])', ['regexp_replace(']], ['floor([amt])', ['floor(']], ['contains([cat], \'a%\')', [' LIKE ', ...BANG]], ['year([d])', ['EXTRACT(YEAR FROM']]],
  snowflake: [['trim([cat])', ['TRIM(']], ['floor([amt])', ['FLOOR(']], ['contains([cat], \'a%\')', [' LIKE ', ...BANG]], ['year([d])', ['EXTRACT(YEAR FROM']]],
  bigquery: [['trim([cat])', ['TRIM(']], ['floor([amt])', ['FLOOR(']], ['contains([cat], \'a%\')', [' LIKE ']], ['year([d])', ['EXTRACT(YEAR FROM']]],
  redshift: [['trim([cat])', ['BTRIM(']], ['floor([amt])', ['FLOOR(']], ['contains([cat], \'a%\')', [' LIKE ', ...BANG]], ['year([d])', ['EXTRACT(YEAR FROM']]],
  databricks: [['trim([cat])', ['btrim(']], ['floor([amt])', ['4503599627370496', 'CAST(floor(']], ['contains([cat], \'a%\')', [' LIKE ', ...BANG]], ['year([d])', ['EXTRACT(YEAR FROM']]],
  clickhouse: [['trim([cat])', ['replaceRegexpAll(']], ['floor([amt])', ['floor(']], ['contains([cat], \'a%\')', [' LIKE ']], ['year([d])', ['toYear(']]],
};
for (const id of DIALECT_IDS) {
  const common: [string, string[]][] = [
    ['[amt] / [qty]', ['/ NULLIF(']],
    ['round([amt], 1)', ['>= 0.5 THEN']],
    ['[d] < [d]', ['IS NULL AND', 'IS NULL THEN FALSE', 'IS NULL THEN TRUE', 'ELSE']],
    ['[cat]', ["NULLIF(", ", '')"]],
    ['[cat] = [cat]', ['IS NULL OR', 'IS NULL AND']],
    ['[amt] > 0', ["WHEN TRUE THEN 'true' WHEN FALSE THEN 'false'"]],
    ['[A] + 1', [id === 'bigquery' || id === 'clickhouse' || id === 'databricks' ? 'lv_src.`A`' : 'lv_src."A"']],
  ];
  for (const [expr, want] of [...common, ...SHAPES[id]]) ok(`${id}: ${expr} has its fragments`, want.every((w) => compiled(id, expr).includes(w)), compiled(id, expr));
  ok(`${id}: never ROUND, LEAST or GREATEST`, !/round\(|least\(|greatest\(/i.test(compiled(id, 'round([amt], 1) + min([amt], [qty]) + max([amt], 2)')));
  ok(`${id}: a literal is bound, never in the text`, !compiled(id, "concat([cat], 'zz_secret') = 'zz_other'").includes('zz_'));
  ok(`${id}: lower is refused like every casing function`, compiled(id, 'lower([cat])') === 'REFUSED function');
  // Step 05: Postgres types a CASE of NULLs as text and BigQuery as INT64, then refuses to mix it with a date or a number.
  ok(`${id}: a term that is always NULL is spelled NULL, never a CASE of NULLs`, compiled(id, 'ifnull([amt], (IF [amt] > 1 THEN null END))').endsWith(', NULL) END')
    && !compiled(id, 'if([amt] > 1, [d], ifnull(null, null)) < [d]').includes('COALESCE(NULL, NULL)'), compiled(id, 'ifnull([amt], (IF [amt] > 1 THEN null END))'));
  ok(`${id}: NEGATIVE CONTROL — a branch with a value keeps its CASE`, compiled(id, 'ifnull([amt], (IF [amt] > 1 THEN 2 END))').includes('THEN '));
}

// Every value is a parameter of the statement it lands in, in text order.
const sinkP = new ParamSink();
const rp = compileCalcSql("IF [cat] = 'a\\'s' THEN round([amt], 2) END", { d: dialectFor('duckdb'), b: sinkP, columns: COLS, earlier: [] });
const qp = rp.ok ? sinkP.finish(rp.sql, dialectFor('duckdb'), ['v']) : null;
ok('the values reach the statement as parameters', !!qp && qp.params.some((p) => p.value === "a's") && qp.params.filter((p) => p.value === 100).length >= 2
  && !qp.sql.includes("a's") && !qp.sql.includes('\u0000'), show(qp));

finish();
