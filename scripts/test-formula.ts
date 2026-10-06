// Self-check for src/formula.ts — the SAFE expression evaluator. No fs
// stub needed (the module is pure). Mirrors test-datasetStats.ts style: ok()
// counter, no framework, process.exit(1) on failure.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled sibling of ../src/formula.ts.
const formula: typeof import('../src/formula/formula') = require('../src/formula/formula');
const { compile } = formula;
import type { FValue } from '../src/formula/formula';

function approx(a: unknown, b: number): boolean {
  return typeof a === 'number' && Math.abs(a - b) < 1e-9;
}

// Compile-and-eval helper (fails the test on unexpected compile error).
function ev(expr: string, row: Record<string, FValue> = {}): FValue {
  const r = compile(expr);
  if (!r.ok) {
    ok('compile `' + expr + '`', false, r.error);
    return null;
  }
  return r.fn.evaluate(row);
}

// ── Arithmetic + precedence ──────────────────────────────────────────────────
ok('add', ev('1 + 2') === 3);
ok('precedence: * before +', ev('2 + 3 * 4') === 14);
ok('parens override precedence', ev('(2 + 3) * 4') === 20);
ok('subtraction left-assoc', ev('10 - 3 - 2') === 5);
ok('division', approx(ev('7 / 2'), 3.5));
ok('modulo', ev('10 % 3') === 1);
ok('unary minus', ev('-5 + 2') === -3);
ok('unary minus with parens', ev('-(3 * 2)') === -6);
ok('nested parens', ev('((1 + 2) * (3 + 4))') === 21);
ok('decimal literal preserved', approx(ev('1.50 + 0.5'), 2));
ok('exponent literal', ev('2e3') === 2000);

// ── Division / modulo by zero → null (never Infinity/NaN) ────────────────────
ok('div by zero → null', ev('5 / 0') === null);
ok('mod by zero → null', ev('5 % 0') === null);

// ── Column references (bare + bracketed) ─────────────────────────────────────
ok('bare column ref', ev('price * qty', { price: 3, qty: 4 }) === 12);
ok('bracketed column ref with space', ev('[Unit Price] * 2', { 'Unit Price': 10 }) === 20);
ok('unknown column → null (not throw)', ev('missing + 1', {}) === null);
ok('compile exposes refs', (() => {
  const r = compile('a + [b c] + round(d)');
  return r.ok && r.fn.refs.includes('a') && r.fn.refs.includes('b c') && r.fn.refs.includes('d');
})());

// ── Null / non-numeric propagation ───────────────────────────────────────────
ok('null operand → null', ev('x + 1', { x: null }) === null);
ok('non-numeric string operand → null', ev('x + 1', { x: 'abc' }) === null);
ok('numeric string is NOT auto-coerced → null', ev('x * 2', { x: '5' }) === null);

// ── Functions ────────────────────────────────────────────────────────────────
ok('round default', ev('round(3.14159)') === 3);
ok('round to 2', approx(ev('round(3.14159, 2)'), 3.14));
// A huge digit count overflows 10^d to Infinity → x*f/f is NaN, which would poison
// the calculated-field column. Guard falls back to integer rounding, never NaN.
ok('round with huge digits → integer, not NaN', ev('round(5.4, 400)') === 5);
ok('round(0, huge) → 0, not NaN', ev('round(0, 400)') === 0);
ok('abs', ev('abs(-7)') === 7);
ok('floor', ev('floor(3.9)') === 3);
ok('ceil', ev('ceil(3.1)') === 4);
ok('min', ev('min(3, 1, 2)') === 1);
ok('max', ev('max(3, 1, 2)') === 3);
ok('min ignores non-numeric', ev('min(x, 5)', { x: null }) === 5);
ok('lower', ev("lower('HeLLo')") === 'hello');
ok('upper', ev("upper('HeLLo')") === 'HELLO');
ok('trim', ev("trim('  hi  ')") === 'hi');
ok('len', ev("len('hello')") === 5);
ok('concat', ev("concat('a', 'b', 'c')") === 'abc');
ok('concat stringifies + nulls→empty', ev("concat('id-', x)", { x: null }) === 'id-');
ok('concat numbers', ev("concat(a, '-', b)", { a: 1, b: 2 }) === '1-2');
ok('coalesce first non-null', ev('coalesce(x, y, 9)', { x: null, y: null }) === 9);
ok('coalesce returns first present', ev('coalesce(x, 9)', { x: 5 }) === 5);
ok('if true branch', ev("if(1 > 0, 'yes', 'no')") === 'yes');
ok('if false branch', ev("if(1 < 0, 'yes', 'no')") === 'no');
ok('nested functions', ev('round(abs(-3.7))') === 4);

// ── Comparisons: numeric vs string ───────────────────────────────────────────
ok('numeric compare >', ev('5 > 3') === true);
ok('numeric compare <=', ev('3 <= 3') === true);
ok('equality =', ev('2 = 2') === true);
ok('equality == alias', ev('2 == 2') === true);
ok('inequality !=', ev('2 != 3') === true);
ok('string equality', ev("x = 'paris'", { x: 'paris' }) === true);
ok('string compare (lexical)', ev("'apple' < 'banana'") === true);
ok('column string compare', ev("city != 'berlin'", { city: 'paris' }) === true);

// ── Boolean and / or / not ───────────────────────────────────────────────────
ok('and', ev('1 > 0 and 2 > 1') === true);
ok('and short: one false', ev('1 > 0 and 2 < 1') === false);
ok('or', ev('1 < 0 or 2 > 1') === true);
ok('not', ev('not (1 < 0)') === true);
ok('booleans + comparisons combine', ev("age >= 18 and country = 'US'", { age: 21, country: 'US' }) === true);

// ── Literals ─────────────────────────────────────────────────────────────────
ok('true literal', ev('true') === true);
ok('false literal', ev('false') === false);
ok('null literal', ev('null') === null);

// ── Errors → structured, never throw ─────────────────────────────────────────
function isErr(expr: string): boolean {
  const r = compile(expr);
  return !r.ok && typeof r.error === 'string' && r.error.length > 0;
}
ok('empty expression → error', isErr('   '));
ok('dangling operator → error', isErr('1 +'));
ok('unbalanced paren → error', isErr('(1 + 2'));
ok('unknown function → error', isErr('frobnicate(1)'));
ok('unterminated string → error', isErr("'oops"));
// Injection attempts must be parse errors, never executed.
ok('injection: statement separator → error', isErr('1; process.exit(1)'));
ok('injection: member access "." → error', isErr('process.exit(1)'));
ok('injection: template/backtick char → error', isErr('`${1}`'));
ok('injection: trailing garbage → error', isErr('1 2 3'));

// ── Number functions (Tableau parity) ───────────────────────────────────────
ok('sqrt', ev('sqrt(9)') === 3);
ok('sqrt of negative → null (not NaN)', ev('sqrt(-1)') === null);
ok('square', ev('square(4)') === 16);
ok('power', ev('power(2, 10)') === 1024);
ok('exp/ln round-trip', approx(ev('ln(exp(1))'), 1));
ok('ln(0) → null (not -Infinity)', ev('ln(0)') === null);
ok('log default base 10', approx(ev('log(1000)'), 3));
ok('log with base', approx(ev('log(8, 2)'), 3));
ok('sign negative', ev('sign(-42)') === -1);
ok('abs via wrapper', ev('abs(-3)') === 3);
ok('ceiling alias', ev('ceiling(2.1)') === 3);
ok('pi', approx(ev('pi()'), Math.PI));
ok('div integer part', ev('div(17, 5)') === 3);
ok('div by zero → null', ev('div(1, 0)') === null);
ok('atan2', approx(ev('atan2(1, 1)'), Math.PI / 4));
ok('degrees/radians round-trip', approx(ev('degrees(radians(180))'), 180));
ok('sin', approx(ev('sin(0)'), 0));
ok('zn null → 0', ev('zn(x)', { x: null }) === 0);
ok('zn non-numeric text → 0', ev('zn(x)', { x: 'abc' }) === 0);
ok('zn passes number through', ev('zn(x)', { x: 7 }) === 7);
ok('min lexical on strings', ev("min('banana', 'apple')") === 'apple');
ok('max lexical on strings', ev("max('a', 'z', 'm')") === 'z');

// ── String functions ────────────────────────────────────────────────────────
ok('left', ev("left('hello', 3)") === 'hel');
ok('right', ev("right('hello', 2)") === 'lo');
ok('right(0) → empty', ev("right('hello', 0)") === '');
ok('mid start only (1-based)', ev("mid('hello', 2)") === 'ello');
ok('mid start+len', ev("mid('hello', 2, 3)") === 'ell');
ok('ltrim', ev("ltrim('  hi  ')") === 'hi  ');
ok('rtrim', ev("rtrim('  hi  ')") === '  hi');
ok('proper', ev("proper('the QUICK brown')") === 'The Quick Brown');
ok('contains true', ev("contains('screenchart', 'chart')") === true);
ok('startswith', ev("startswith('screenchart', 'screen')") === true);
ok('endswith', ev("endswith('screenchart', 'chart')") === true);
ok('find (1-based)', ev("find('abcabc', 'c')") === 3);
ok('find not present → 0', ev("find('abc', 'z')") === 0);
ok('find with start', ev("find('abcabc', 'a', 2)") === 4);
ok('findnth 2nd occurrence', ev("findnth('a.b.c.d', '.', 2)") === 4);
ok('findnth beyond count → 0', ev("findnth('a.b', '.', 5)") === 0);
ok('replace all occurrences', ev("replace('a-b-c', '-', '_')") === 'a_b_c');
ok('replace empty needle → unchanged', ev("replace('abc', '', 'x')") === 'abc');
ok('split token 1', ev("split('a,b,c', ',', 1)") === 'a');
ok('split token 2', ev("split('a,b,c', ',', 2)") === 'b');
ok('split negative index from end', ev("split('a,b,c', ',', -1)") === 'c');
ok('split out of range → null', ev("split('a,b', ',', 9)") === null);
ok('ascii', ev("ascii('A')") === 65);
ok('char', ev('char(65)') === 'A');
ok('space', ev('len(space(5))') === 5);
ok('regexp_match', ev("regexp_match('abc123', '[0-9]+')") === true);
ok('regexp_match no match', ev("regexp_match('abc', '[0-9]+')") === false);
ok('regexp_extract first group', ev("regexp_extract('order-42', '-([0-9]+)')") === '42');
ok('regexp_extract_nth group', ev("regexp_extract_nth('2024-07', '([0-9]+)-([0-9]+)', 2)") === '07');
ok('regexp_replace global', ev("regexp_replace('a1b2c3', '[0-9]', '#')") === 'a#b#c#');
ok('invalid regex → null (no throw)', ev("regexp_match('x', '([')") === null);

// ── Type conversion ──────────────────────────────────────────────────────────
ok('int truncates', ev('int(3.9)') === 3);
ok('int of numeric string', ev("int('42')") === 42);
ok('int of non-numeric → null', ev("int('abc')") === null);
ok('float of string', approx(ev("float('3.14')"), 3.14));
ok('str of number', ev('str(42)') === '42');
ok('str of null → null', ev('str(x)', { x: null }) === null);

// ── Date functions (dates are text cells; parse → int / ISO string) ──────────
ok('year', ev("year('2024-07-28')") === 2024);
ok('month', ev("month('2024-07-28')") === 7);
ok('day', ev("day('2024-07-28')") === 28);
ok('quarter', ev("quarter('2024-07-28')") === 3);
ok('datepart year', ev("datepart('year', '2024-07-28')") === 2024);
ok('datepart weekday (Sun=1)', ev("datepart('weekday', '2024-07-28')") === 1); // 2024-07-28 is a Sunday
ok('datename month', ev("datename('month', '2024-07-28')") === 'July');
ok('datename weekday', ev("datename('weekday', '2024-07-28')") === 'Sunday');
ok('datediff year counts boundary', ev("datediff('year', '2020-12-31', '2021-01-01')") === 1);
ok('datediff month', ev("datediff('month', '2024-01-15', '2024-04-10')") === 3);
ok('datediff day', ev("datediff('day', '2024-01-01', '2024-01-11')") === 10);
ok('dateadd month', ev("dateadd('month', 2, '2024-01-15')") === '2024-03-15');
ok('dateadd day crosses month', ev("dateadd('day', 20, '2024-01-15')") === '2024-02-04');
ok('datetrunc month', ev("datetrunc('month', '2024-07-28')") === '2024-07-01');
ok('datetrunc year', ev("datetrunc('year', '2024-07-28')") === '2024-01-01');
ok('makedate', ev('makedate(2024, 7, 28)') === '2024-07-28');
ok('isdate true', ev("isdate('2024-07-28')") === true);
ok('isdate false', ev("isdate('not a date')") === false);
ok('date normalizes slashes', ev("date('2024/07/28')") === '2024-07-28');
ok('unparseable date → null', ev("year('banana')") === null);
ok('isoweekday Monday=1', ev("isoweekday('2024-07-29')") === 1); // 2024-07-29 is a Monday

// ── Logical: IIF / IFNULL / ISNULL ───────────────────────────────────────────
ok('iif true', ev("iif(1 > 0, 'a', 'b')") === 'a');
ok('iif false', ev("iif(1 < 0, 'a', 'b')") === 'b');
ok('iif null test → unknown branch', ev("iif(x, 'a', 'b', 'unknown')", { x: null }) === 'unknown');
ok('ifnull passes non-null', ev('ifnull(x, 0)', { x: 5 }) === 5);
ok('ifnull substitutes null', ev('ifnull(x, 0)', { x: null }) === 0);
ok('isnull true', ev('isnull(x)', { x: null }) === true);
ok('isnull false', ev('isnull(x)', { x: 3 }) === false);

// ── IF … THEN … ELSEIF … ELSE … END (keyword form) ──────────────────────────
ok('IF/THEN/ELSE keyword form', ev("IF x > 10 THEN 'big' ELSE 'small' END", { x: 20 }) === 'big');
ok('IF else branch', ev("IF x > 10 THEN 'big' ELSE 'small' END", { x: 2 }) === 'small');
ok('IF ELSEIF chain', ev("IF x > 100 THEN 'h' ELSEIF x > 10 THEN 'm' ELSE 'l' END", { x: 50 }) === 'm');
ok('IF no ELSE, no match → null', ev("IF x > 10 THEN 'big' END", { x: 2 }) === null);
ok('IF with AND in test', ev("IF x > 0 AND x < 10 THEN 'ok' ELSE 'no' END", { x: 5 }) === 'ok');
ok('IF used inside arithmetic', ev("(IF x > 0 THEN 1 ELSE 0 END) + 10", { x: 1 }) === 11);
ok('if() function form still works', ev("if(1 > 0, 'yes', 'no')") === 'yes');

// ── CASE … WHEN … THEN … ELSE … END ─────────────────────────────────────────
ok('CASE match', ev("CASE region WHEN 'US' THEN 1 WHEN 'EU' THEN 2 ELSE 0 END", { region: 'EU' }) === 2);
ok('CASE default', ev("CASE region WHEN 'US' THEN 1 ELSE 9 END", { region: 'ZZ' }) === 9);
ok('CASE numeric subject', ev('CASE n WHEN 1 THEN 10 WHEN 2 THEN 20 END', { n: 2 }) === 20);
ok('CASE no match, no ELSE → null', ev("CASE x WHEN 'a' THEN 1 END", { x: 'z' }) === null);

// ── IN operator ───────────────────────────────────────────────────────────────
ok('IN true', ev("region IN ('US', 'EU', 'APAC')", { region: 'EU' }) === true);
ok('IN false', ev("region IN ('US', 'EU')", { region: 'ZZ' }) === false);
ok('IN numeric', ev('n IN (1, 2, 3)', { n: 2 }) === true);
ok('IN combined with NOT', ev("NOT (region IN ('US'))", { region: 'EU' }) === true);

// ── New keyword constructs still reject malformed input ──────────────────────
ok('IF without END → error', isErr("IF x > 0 THEN 1"));
ok('IF without THEN → error', isErr("IF x > 0 1 END"));
ok('CASE without WHEN → error', isErr('CASE x END'));

// ── No eval / new Function anywhere in the source (static guarantee) ──────────
(() => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'formula', 'formula.ts'), 'utf8');
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('source contains no eval(', !/\beval\s*\(/.test(stripped));
  ok('source contains no new Function', !/new\s+Function\s*\(/.test(stripped));
})();

if (failureCount()) {
  console.error('\n' + failureCount() + ' formula check(s) FAILED');
  process.exit(1);
}
console.log('\nAll formula checks passed.');
