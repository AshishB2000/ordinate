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
import { LIVE_FUNCTIONS, V1_FUNCTIONS, liveFn } from '../src/engine/live/formulaSqlFunctions';

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

finish();
