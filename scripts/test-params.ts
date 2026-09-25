'use strict';

// Self-check for src/analysis/params.ts — dashboard parameters, the one
// resolver. Every host a parameter reaches is exercised through the code that
// evaluates it, not only through the substitution: a filter step is RUN by
// applyPipeline, a calculated field is COMPILED and evaluated, a metric
// formula is compiled by compileMetricFormula — so a substitution that
// produced well-formed text with the wrong type fails here.
//
//   npm run build:ts && node scripts/test-params.js

export {};
import { ok, finish } from './selfcheck';

const Module: any = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: () => require('os').tmpdir() }, ipcMain: { handle: () => {} } };
  return origLoad.apply(this, [request, ...rest]);
};

const P: typeof import('../src/analysis/params') = require('../src/analysis/params');
const { applyPipeline, sanitizeSteps }: typeof import('../src/data/transforms') = require('../src/data/transforms');
const { compile }: typeof import('../src/formula/formula') = require('../src/formula/formula');
const { compileMetricFormula, evaluateMetricFormula }: typeof import('../src/analysis/metricFormula') = require('../src/analysis/metricFormula');
const dd: typeof import('../src/analysis/dashboardDelta') = require('../src/analysis/dashboardDelta');
const { sanitizeCard }: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');

type FilterStep = import('../src/data/transforms').FilterStep;

let n = 0;
const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

// ── 1. Sanitising a dashboard's parameters ──────────────────────────────────
{
  const list = P.sanitizeParameters([
    { name: 'threshold', kind: 'number', value: 50000, min: 10000, max: 0, step: 500 },
    { name: 'Threshold', kind: 'text', value: 'dup' },          // same name, other case
    { name: '2fast', kind: 'number', value: 1 },                 // not an identifier
    { name: 'region', kind: 'list', value: ['West', 'East', 'West', 7, { x: 1 }], list: ['West', 'East', 'South'] },
    { name: 'asof', kind: 'date', value: '2024-02-30' },         // not a real date
    { name: 'note', kind: 'text', value: 'a\u0000b' },
    { name: 'weird', kind: 'colour', value: 'red' },
    { name: 'growth', kind: 'number', value: '1.5', step: 0 },
  ], newId);
  const names = list.map((p) => p.name);
  ok('valid parameters survive; a bad name, a duplicate name and an unknown kind do not',
    JSON.stringify(names) === '["threshold","region","asof","note","growth"]', JSON.stringify(names));
  const t = list[0];
  ok('a reversed min/max is swapped, not dropped', t.min === 0 && t.max === 10000, JSON.stringify(t));
  ok('a slider keeps its step', t.step === 500);
  ok('a default outside the bounds is clamped into them', t.value === 10000, String(t.value));
  ok('every parameter gets a UUID id', list.every((p) => /^[0-9a-f-]{36}$/.test(p.id)));
  ok('a list value is de-duplicated scalars only', JSON.stringify(list[1].value) === '["West","East","7"]', JSON.stringify(list[1].value));
  ok('…and keeps its options', JSON.stringify(list[1].list) === '["West","East","South"]');
  ok('a date that is not a date has no value', list[2].value === null);
  ok('control characters are stripped from text', list[3].value === 'a b');
  ok('a numeric string is a number, and a zero step is dropped', list[4].value === 1.5 && list[4].step === undefined, JSON.stringify(list[4]));
  const clampedPayload = P.paramValues([{ name: 'threshold', kind: 'number', value: 999999, min: 0, max: 10000 }]);
  ok('a slider value from the renderer is clamped to its bounds', clampedPayload.get('threshold')!.value === 10000);
  ok('payload entries that are not parameters are dropped', P.paramValues([{ name: 'x y', kind: 'number', value: 1 }, null, 5]).size === 0);
}

const values = P.paramValues([
  { name: 'threshold', kind: 'number', value: 2000 },
  { name: 'region', kind: 'text', value: 'West' },
  { name: 'regions', kind: 'list', value: ['West', 'East'] },
  { name: 'asof', kind: 'date', value: '2024-06-30' },
  { name: 'unset', kind: 'number', value: null },
  { name: 'growth', kind: 'number', value: -0.25 },
  { name: 'label', kind: 'text', value: 'say "hi" \\ bye' },
]);

// ── 2. {{name}} in titles and text cards ────────────────────────────────────
{
  const two = (2000).toLocaleString(undefined, { maximumFractionDigits: 6 });
  ok('a title reads the value', P.substituteText('Orders over {{threshold}}', values) === 'Orders over ' + two);
  ok('names are case-insensitive, spaces inside the braces allowed', P.substituteText('{{ Region }} only', values) === 'West only');
  ok('a list reads as a list', P.substituteText('In {{regions}}', values) === 'In West, East');
  ok('an unset parameter reads as a dash, not "null"', P.substituteText('({{unset}})', values) === '(—)');
  ok('an unknown name is LEFT AS TYPED, so the broken reference shows', P.substituteText('Hi {{nobody}}', values) === 'Hi {{nobody}}');
  ok('text without braces is untouched', P.substituteText('Plain', values) === 'Plain');
}

// ── 3. [[name]] in filter step values — typed, then RUN ─────────────────────
{
  const table = {
    columns: [
      { name: 'region', type: 'text' as const },
      { name: 'revenue', type: 'number' as const },
      { name: 'day', type: 'date' as const },
    ],
    rows: [
      ['West', 2500, '2024-06-01'],
      ['East', 1500, '2024-07-01'],
      ['West', 900, '2024-05-01'],
      ['South', 4000, '2024-06-15'],
    ],
  };
  const run = (steps: FilterStep[]): string => {
    const r = P.resolveFilterParams(sanitizeSteps(steps) as FilterStep[], values);
    return JSON.stringify(applyPipeline(table, r.steps).rows.map((x) => x[1]));
  };
  const gt = P.resolveFilterParams([{ type: 'filter', column: 'revenue', op: '>', value: '[[threshold]]' }], values);
  ok('a number parameter becomes a NUMBER, not the string "2000"', gt.steps[0].value === 2000 && gt.errors.length === 0);
  ok('revenue > [[threshold]] keeps the rows above 2000', run([{ type: 'filter', column: 'revenue', op: '>', value: '[[threshold]]' }]) === '[2500,4000]');
  ok('region = [[region]] keeps West', run([{ type: 'filter', column: 'region', op: '=', value: '[[region]]' }]) === '[2500,900]');
  ok('day <= [[asof]] compares the date', run([{ type: 'filter', column: 'day', op: '<=', value: '[[asof]]' }]) === '[2500,900,4000]');
  ok('region in [[regions]] expands the list', run([{ type: 'filter', column: 'region', op: 'in', values: ['[[regions]]'] }]) === '[2500,1500,900]');
  ok('a list parameter mixed with literal values', run([{ type: 'filter', column: 'region', op: 'in', values: ['[[region]]', 'South'] }]) === '[2500,900,4000]');
  const eqList = P.resolveFilterParams([{ type: 'filter', column: 'region', op: '=', value: '[[regions]]' }], values);
  ok('`=` against a list becomes "is any of" rather than picking one value', eqList.steps[0].op === 'in' && JSON.stringify(eqList.steps[0].values) === '["West","East"]');
  const gtList = P.resolveFilterParams([{ type: 'filter', column: 'revenue', op: '>', value: '[[regions]]' }], values);
  ok('a list in `>` is a VALIDATION message and the step is dropped', gtList.steps.length === 0 && /is a list/.test(gtList.errors[0] || ''), JSON.stringify(gtList));
  const typo = P.resolveFilterParams([{ type: 'filter', column: 'revenue', op: '>', value: '[[treshold]]' }], values);
  ok('an unknown name is a validation message naming it', typo.steps.length === 0 && /no parameter named "treshold"/.test(typo.errors[0] || ''), JSON.stringify(typo));
  const unset = P.resolveFilterParams([{ type: 'filter', column: 'revenue', op: '>', value: '[[unset]]' }], values);
  ok('a parameter with no value yet filters nothing — silently, like an unset control', unset.steps.length === 0 && unset.errors.length === 0);
  const embedded = P.resolveFilterParams([{ type: 'filter', column: 'region', op: 'contains', value: 'We[[unset]]st-[[region]]' }], values);
  ok('a reference inside longer text is substituted as text', embedded.steps[0].value === 'West-West', JSON.stringify(embedded));
  const plain: FilterStep = { type: 'filter', column: 'revenue', op: '>', value: 5 };
  ok('a step without a reference is passed through as the same object', P.resolveFilterParams([plain], values).steps[0] === plain);
}

// ── 4. [[name]] in formulas — calculated fields and metric formulas ─────────
{
  const b = P.bindFormulaText('[revenue] * (1 + [[growth]])', values);
  ok('a negative number binds as a parenthesised literal', b.text === '[revenue] * (1 + (-0.25))' && b.errors.length === 0, b.text);
  const s = P.bindFormulaText('concat([[label]], "[[threshold]]")', values);
  ok('a text value is quoted with the tokenizer\'s escapes, and a reference INSIDE a string literal is left alone',
    s.text === 'concat("say \\"hi\\" \\\\ bye", "[[threshold]]")', s.text);
  const compiled = compile(s.text);
  ok('…and the result parses and evaluates to the original text', compiled.ok && compiled.fn.evaluate({}) === 'say "hi" \\ bye[[threshold]]',
    compiled.ok ? String(compiled.fn.evaluate({})) : compiled.error);
  const unknown = P.bindFormulaText('[a] + [[nope]]', values);
  ok('an unknown name binds as null and says so', unknown.text === '[a] + null' && /nope/.test(unknown.errors[0] || ''));
  const list = P.bindFormulaText('[[regions]]', values);
  ok('a list in a formula is null with a message — a formula takes one value', list.text === 'null' && /is a list/.test(list.errors[0] || ''));

  const unbound = compile('[revenue] * [[growth]]');
  ok('an UNBOUND parameter still compiles (the stored dataset has no dashboard) and reads as null',
    unbound.ok && unbound.fn.evaluate({ revenue: 100 }) === null);
  ok('…and is not mistaken for a column reference', unbound.ok && JSON.stringify(unbound.fn.refs) === '["revenue"]');

  const m = compileMetricFormula(P.bindFormulaText('sum(revenue) * [[threshold]]', values).text, ['revenue']);
  ok('a metric formula with a parameter compiles', m.ok);
  if (m.ok) {
    const vals = new Map<string, number | null>([[m.program.aggregates[0].ref, 3]]);
    ok('…and evaluates with the bound value', evaluateMetricFormula(m.program, vals) === 6000);
  }

  const table = { columns: [{ name: 'revenue', type: 'number' as const }], rows: [[100], [200]] };
  const steps = sanitizeSteps([
    { type: 'calculated_field', name: 'grown', expression: '[revenue] * (1 + [[growth]])' },
    { type: 'filter', column: 'grown', op: '>', value: '[[threshold]]' },
  ]);
  ok('stepsUseParams sees both', P.stepsUseParams(steps));
  const stored = applyPipeline(table, steps);
  ok('the STORED pipeline runs with the field null (unbound), never failing it', stored.columns.some((c) => c.name === 'grown')
    && stored.rows.length === 0, JSON.stringify(stored.rows));
  const replay = applyPipeline(table, P.bindStepParams(steps, P.paramValues([
    { name: 'growth', kind: 'number', value: 0.5 }, { name: 'threshold', kind: 'number', value: 200 },
  ])).steps);
  ok('the REPLAYED pipeline binds both: 100→150 is dropped, 200→300 kept', JSON.stringify(replay.rows) === '[[200,300]]', JSON.stringify(replay.rows));
  ok('a pipeline without references does not need a replay', !P.stepsUseParams(sanitizeSteps([{ type: 'filter', column: 'a', op: '=', value: 1 }])));
}

// ── 5. The Parameter control and the Assistant ──────────────────────────────
{
  const pid = '11111111-1111-4111-8111-111111111111';
  const card = sanitizeCard({ type: 'control', control: { kind: 'parameter', label: 'Threshold', paramId: pid } });
  ok('a parameter control needs no dataset or column', !!card && card.control!.kind === 'parameter' && card.control!.paramId === pid);
  ok('…but does need a parameter id', sanitizeCard({ type: 'control', control: { kind: 'parameter', paramId: 'x' } }) === null);

  const ctx = { pages: [{ name: 'Overview', tileCount: 0 }], tiles: [], datasets: [] };
  const good = dd.validateDelta([{ op: 'addControl', kind: 'parameter', name: 'threshold', paramKind: 'number', value: 5000, min: 0, max: 100000, step: 1000 }], ctx);
  const op: any = good.ops[0];
  ok('the Assistant can add a parameter control', !!op && op.kind === 'parameter' && op.param.name === 'threshold'
    && op.param.min === 0 && op.param.max === 100000 && op.param.step === 1000, JSON.stringify(good));
  ok('…with no id — the renderer mints it', !!op && !('id' in op.param));
  const bad = dd.validateDelta([{ op: 'addControl', kind: 'parameter', name: 'no spaces allowed', paramKind: 'number' }], ctx);
  ok('a bad parameter name is dropped with a message', bad.ops.length === 0 && /letters, digits and underscores/.test(bad.dropped[0].message), JSON.stringify(bad));
}

// ── 6. Parameters never reach SQL text ──────────────────────────────────────
{
  const hostile = P.paramValues([{ name: 'x', kind: 'text', value: "'; DROP TABLE t; --" }]);
  const r = P.resolveFilterParams([{ type: 'filter', column: 'region', op: '=', value: '[[x]]' }], hostile);
  ok('a hostile text value is a filter VALUE (bound later), not SQL', r.steps[0].value === "'; DROP TABLE t; --");
}

finish();
