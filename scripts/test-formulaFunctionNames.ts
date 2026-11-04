// A formula calls a function by its OWN name only. `FUNCTIONS` is an object
// literal, so a plain `FUNCTIONS[name]` also finds what it inherits from
// Object.prototype: `constructor([n])` compiled and returned an ARRAY as a row
// value. Each inherited name must be the error any unknown name is, in a Prepare
// formula and in a metric formula (which parse through their own entry points).
//
//   npm run build:ts && node scripts/test-formulaFunctionNames.js

import { ok, finish } from './selfcheck';
import { compile } from '../src/formula/formula';
import { FormulaError } from '../src/formula/formulaTokens';
import { jsBuilder } from '../src/formula/formulaJs';
import { applyPipeline } from '../src/data/transforms';
import { compileMetricFormula } from '../src/analysis/metricFormula';

const INHERITED = ['constructor', 'Constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupSetter__'];
const UNKNOWN = 'nosuchfn'; // the error every unknown name gets is the bar

type Res = { ok: true } | { ok: false; error: string; at?: { start: number; end: number } };
const unknownError = (name: string, r: Res): boolean =>
  !r.ok && r.error === 'Unknown function: ' + name && r.at?.start === 0 && r.at?.end === name.length;

const table = { columns: [{ name: 'n', type: 'number' as const }], rows: [[1], [2]] };
const prepare = (name: string): boolean => {
  const out = applyPipeline(table, [{ type: 'calculated_field', name: 'c', expression: `${name}([n])` }]);
  return out.columns.length === 1 && out.warnings.includes(`Calculated field "c" skipped: Unknown function: ${name}`);
};

for (const name of [UNKNOWN, ...INHERITED]) {
  ok(`${name}([n]) is an unknown function in a formula`, unknownError(name, compile(`${name}([n])`)));
  ok(`${name}([n]) is an unknown function in a Prepare formula`, prepare(name));
  ok(`${name}([n]) is an unknown function in a metric formula`, unknownError(name, compileMetricFormula(`${name}([n])`, ['n'])));
}
ok('a real function still compiles everywhere', compile('round([n])').ok && compileMetricFormula('round(sum([n]))', ['n']).ok &&
  applyPipeline(table, [{ type: 'calculated_field', name: 'c', expression: 'round([n])' }]).columns.length === 2);

// The JS builder guards itself too: a name the parser never let through is a positioned error, not Object().
const thrown = (name: string): unknown => {
  try {
    jsBuilder().call(name, [], 7);
    return null;
  } catch (e) {
    return e;
  }
};
const e = thrown('constructor');
ok('jsBuilder().call refuses an inherited name with the token it is about',
  e instanceof FormulaError && e.message === 'Unknown function: constructor' && e.tokenIndex === 7);
ok('jsBuilder().call still builds a real function', thrown('round') === null);

finish();
