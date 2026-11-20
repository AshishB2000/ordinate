// Deep research: the action-line parser takes each of its four kinds and refuses everything else.
//   npm run build:ts && node scripts/test-researchActions.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const { parseActionLine: parse }: typeof import('../src/ai/researchActions') = require('../src/ai/researchActions');

const spec = { dataset: 'Sales', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }] };
const j = (o: unknown) => JSON.stringify(o);

const a = parse(j({ kind: 'answer', intent: 'revenue by region', spec }));
ok('answer: parsed with its spec', a.ok && a.action.kind === 'answer' && (a.action as unknown as { spec: { category: string } }).spec.category === 'region', j(a));
const s = parse(j({ kind: 'sql', intent: 'never ordered', datasets: ['Sales'] }));
ok('sql: parsed with its dataset names', s.ok && s.action.kind === 'sql' && (s.action as unknown as { datasets: string[] }).datasets[0] === 'Sales', j(s));
const d = parse(j({ kind: 'drivers', request: { dataset: 'Sales', metric: { column: 'revenue', aggregation: 'sum' } } }));
ok('drivers: parsed with its request', d.ok && d.action.kind === 'drivers', j(d));
ok('done: parsed', JSON.stringify(parse('{"kind":"done"}')) === '{"ok":true,"action":{"kind":"done"}}');
ok('marker and a code fence around the one line are taken off', parse('@@ACTION {"kind":"done"}').ok && parse('```json\n{"kind":"done"}\n```').ok);

const code = (raw: string) => { const r = parse(raw); return r.ok ? 'ok' : r.code; };
ok('refused: nothing', code('') === 'empty' && code('   ') === 'empty' && code(undefined as unknown as string) === 'empty');
ok('refused: prose, before or after the line', code('I will look at revenue next.') === 'prose' && code('Next: {"kind":"done"}') === 'prose' && code('{"kind":"done"}\nthat is all') === 'prose');
ok('refused: two actions, on two lines or one', code('{"kind":"done"}\n{"kind":"done"}') === 'many' && code('{"kind":"done"}{"kind":"done"}') === 'many');
ok('refused: broken JSON', code('{"kind":"done"') === 'prose' && code('{"kind":done}') === 'json');
ok('refused: a kind not listed (a dashboard, a plan, a style)', code('{"kind":"dashboard","intent":"x"}') === 'kind' && code('{"kind":"plan","steps":[]}') === 'kind' && code('{"intent":"x"}') === 'kind');
ok('refused: an answer with no spec, an sql with no datasets, drivers with no request', code(j({ kind: 'answer', intent: 'x' })) === 'shape' && code(j({ kind: 'sql', intent: 'x', datasets: [] })) === 'shape' && code(j({ kind: 'drivers' })) === 'shape');
ok('refused: a figure where a name goes (a dataset, a column, a dimension)',
  code(j({ kind: 'answer', intent: 'x', spec: { ...spec, dataset: 42 } })) === 'figure_name'
  && code(j({ kind: 'answer', intent: 'x', spec: { ...spec, category: '1,200' } })) === 'figure_name'
  && code(j({ kind: 'answer', intent: 'x', spec: { ...spec, measures: [{ column: 7, aggregation: 'sum' }] } })) === 'figure_name'
  && code(j({ kind: 'sql', intent: 'x', datasets: ['12.5'] })) === 'figure_name'
  && code(j({ kind: 'drivers', request: { dataset: 'Sales', dimension: 3 } })) === 'figure_name');
ok('negative control: a filter VALUE that is a figure is not a name', code(j({ kind: 'answer', intent: 'x', spec: { ...spec, filters: [{ column: 'region', op: '>', value: 900 }] } })) === 'ok');
ok('a column really named "2024" is a name, not a figure; 40%, 12.5 and 1,200 still are', code(j({ kind: 'answer', intent: 'x', spec: { ...spec, category: '2024' } })) === 'ok' && code(j({ kind: 'answer', intent: 'x', spec: { ...spec, category: '40%' } })) === 'figure_name' && code(j({ kind: 'answer', intent: 'x', spec: { ...spec, category: '12.5' } })) === 'figure_name' && code(j({ kind: 'sql', intent: 'x', datasets: ['2024'] })) === 'ok');
ok('refused: a request past the size cap', code(j({ kind: 'drivers', request: { note: 'x'.repeat(5000) } })) === 'shape');
finish();
