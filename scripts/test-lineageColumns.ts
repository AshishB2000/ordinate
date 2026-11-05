// Self-check for column-level lineage (semantic layer part 8, D16-D20): the flow through Prepare, what each
// consumer reads on its own dataset, column and term nodes, and the lineage:column / lineage:fields channels.
//
//   npm run build:ts && node scripts/test-lineageColumns.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const { columnFlow, FLOW_RULES }: typeof import('../src/analysis/lineageFlow') = require('../src/analysis/lineageFlow');
const { STEP_TYPES }: typeof import('../src/data/transforms') = require('../src/data/transforms');
import type { TransformStep } from '../src/data/transforms';
import type { FlowColumn } from '../src/analysis/lineageFlow';

const show = (v: unknown): string => JSON.stringify(v);
const step = (s: object): TransformStep => s as TransformStep;
const R = (from: string, to: string) => step({ type: 'rename_column', from, to });
const CALC = (name: string, expression: string) => step({ type: 'calculated_field', name, expression });
const DROP = (column: string) => step({ type: 'drop_column', column });
const at = (f: FlowColumn[], key: string): FlowColumn => f.find((c) => c.key === key) as FlowColumn;

// ── § flow ───────────────────────────────────────────────────────────────────
ok('FLOW_RULES names every STEP_TYPES member, and nothing else', show(Object.keys(FLOW_RULES).sort()) === show([...STEP_TYPES].sort()));

const f = columnFlow(['amt', 'cost', 'region'], [R('amt', 'amount'), CALC('Margin', '[amount] - [cost]'), CALC('Margin %', '[Margin] / [amount]'), R('amount', 'revenue'), DROP('cost')]);
ok('a rename chain is one column', show(at(f, 'revenue')) === show({ key: 'revenue', was: ['amt', 'amount'], from: [], how: 'source' }), show(at(f, 'revenue')));
ok('calc over calc', show(at(f, 'Margin %').from) === show(['Margin', 'revenue']), show(at(f, 'Margin %')));
ok('a dropped input still feeds the calc that read it', at(f, 'cost').dropped === true && at(f, 'Margin').from.includes('cost'));
ok('first-seen order', show(f.map((c) => c.key)) === show(['revenue', 'cost', 'region', 'Margin', 'Margin %']), show(f.map((c) => c.key)));
ok('an LOD dimension is an input', at(columnFlow(['region', 'amount'], [CALC('Share', '{FIXED [region] : sum([amount])}')]), 'Share').from.join() === 'region,amount');

const ga = columnFlow(['region', 'amount', 'cost'], [step({ type: 'group_aggregate', groupBy: ['region'], aggregations: [{ column: 'amount', fn: 'sum', as: 'total' }, { column: 'cost', fn: 'avg', as: 'avg_cost' }] })]);
ok('group_aggregate: each output from its column, group-by passes through', show(at(ga, 'total').from) === show(['amount']) && show(at(ga, 'avg_cost').from) === show(['cost']) && at(ga, 'region').how === 'source' && !at(ga, 'region').dropped && at(ga, 'amount').dropped === true, show(ga));

const TIERS = '11111111-1111-4111-8111-111111111111';
const lk = columnFlow(['id', 'amount'], [step({ type: 'lookup_join', datasetId: TIERS, leftKey: 'id', rightKey: 'id', columns: ['tier'] })]);
ok('lookup_join: an added column names the other dataset', at(lk, 'tier').lookup?.datasetId === TIERS && at(lk, 'tier').lookup?.column === 'tier' && at(lk, 'tier').how === 'lookup');
ok('a lookup that would clash adds nothing (the fold skips it too)', columnFlow(['id', 'tier'], [step({ type: 'lookup_join', datasetId: TIERS, leftKey: 'id', rightKey: 'id', columns: ['tier'] })]).length === 2);

const pv = columnFlow(['region', 'month', 'amount'], [step({ type: 'pivot', key: 'region', value: 'amount', fn: 'sum', groupBy: ['month'] })], ['month', 'East', 'West']);
ok('a pivot is approximate: every output from every input', at(pv, 'East').how === 'approximate' && at(pv, 'East').from.length === 3, show(pv));
const un = columnFlow(['a'], [step({ type: 'mystery_step_from_a_newer_pod' })], ['a', 'z']);
ok('an unknown step type reads approximate', at(un, 'z').how === 'approximate');
ok('an approximate step does not claim a name a later step makes', at(columnFlow(['a'], [step({ type: 'window', fn: 'row_number', as: 'n' }), CALC('n2', '[a]')], ['a', 'n', 'n2']), 'n2').how === 'calc');

const ip = columnFlow(['a', 'b', 'c'], [step({ type: 'trim', column: 'a' }), step({ type: 'mask_hash', column: 'b' }), step({ type: 'mask_hash', column: 'c' }), step({ type: 'trim', column: 'c' })]);
ok('in place and masked say so, and masked sticks', at(ip, 'a').how === 'in_place' && at(ip, 'b').how === 'masked' && at(ip, 'c').how === 'masked');
ok('NEGATIVE CONTROL: a filter step adds no edge', show(columnFlow(['a'], [step({ type: 'filter', column: 'a', op: '=', value: 1 })])) === show(columnFlow(['a'], [])));
ok('NEGATIVE CONTROL: a step with no rule is not a no-op', columnFlow(['a'], [step({ type: 'unpivot', columns: ['a'] })], ['a', 'attribute']).length === 2);

// ── § consumers ─────────────────────────────────────────────────────────────

finish();
