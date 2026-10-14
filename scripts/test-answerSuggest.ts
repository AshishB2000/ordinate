// Self-check for "Did you mean" on a refused answer — PURE: no model, and the
// only fs is the thread store's own module load.
//
//   1. THE TYPED MISS (src/ai/answerSpec.ts): a spec refused over an unknown
//      NAME says which part missed and what was said — beside the reason, which
//      is the sentence it always was. A cap, a bad aggregation, a bad value and
//      every other refusal report none (negative controls).
//   2. SUGGESTIONS (src/ai/answerSuggest.ts `suggestFixes`): ranked by nearness
//      of the name, then type fit, ties in column order; taught names count;
//      at most three. DIFFERENTIAL: every option is, leaf by leaf (Object.is),
//      the spec the validator gives for the same question with the right name
//      written by hand — so an option is exactly a valid answer, never a
//      hand-written expectation. Nothing near → nothing offered.
//   3. A REFUSED FOLLOW-UP: suggesting against the MERGED spec keeps the
//      filters it carried (negative control: against the patch alone it cannot).
//   4. STORAGE: a suggestion round-trips through its sanitiser and through the
//      thread store's load; oversized or malformed input is cut or dropped.
//
//   npm run build:ts && node scripts/test-answerSuggest.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const path: typeof import('path') = require('path');
const os: typeof import('os') = require('os');
// The thread store (section 4) reads app paths when it loads.
process.env.ORDINATE_LOCAL_DIR = path.join(os.tmpdir(), 'ordinate-answersuggest');

const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const S: typeof import('../src/ai/answerSuggest') = require('../src/ai/answerSuggest');
const R: typeof import('../src/ai/answerRefine') = require('../src/ai/answerRefine');
const names: typeof import('../src/app/columnNames') = require('../src/app/columnNames');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type SpecDataset = import('../src/ai/answerSpec').SpecDataset;
type SpecMetric = import('../src/ai/answerSpec').SpecMetric;
type AnswerChip = import('../src/ai/answerSpec').AnswerChip;

const show = (v: unknown): string => JSON.stringify(v);
function sameLeaves(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  const ka = Object.keys(a);
  return Array.isArray(a) === Array.isArray(b) && ka.length === Object.keys(b).length
    && ka.every((k) => k in b && sameLeaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const COLS: ParsedColumn[] = [
  { name: 'order_date', type: 'date' }, { name: 'region_code', type: 'number' }, { name: 'region_name', type: 'text' },
  { name: 'channel', type: 'text' }, { name: 'segment', type: 'text' }, { name: 'sales_rep', type: 'text' },
  { name: 'net_sales', type: 'number' }, { name: 'sales_tax', type: 'number' }, { name: 'net_amount', type: 'number' },
  { name: 'profit', type: 'number' }, { name: 'update_note', type: 'text' },
];
// The names people taught, as ipc/answers `specDatasets` fills them from the catalog.
const DOCS: Record<string, { displayName?: string; aliases?: string[] }> = { net_amount: { displayName: 'Net Amount', aliases: ['Takings'] }, segment: { displayName: 'Customer Segment' }, profit: { aliases: ['margin dollars'] } };
const DS: SpecDataset = { id: D1, name: 'Orders', columns: COLS, names: names.taughtNames(COLS, DOCS), shown: names.shownNames(COLS, DOCS) };
const OTHER: SpecDataset = { id: D2, name: 'Budget', columns: [{ name: 'region_name', type: 'text' }, { name: 'plan', type: 'number' }] };
const ALL = [DS, OTHER];
const TITLE = { title: 'the question as it was asked' };
const BASE = { dataset: 'Orders', category: 'region_name', measures: ['profit'] };

// ── 1. The typed miss ───────────────────────────────────────────────────────

const refuse = (raw: unknown, among = ALL) => {
  const r = A.validateAnswerSpec(raw, among, TITLE);
  if (r.ok) throw new Error('fixture validates: ' + show(raw));
  return r;
};
const MISSES: [string, unknown, string, import('../src/ai/answerSpec').SpecMiss][] = [
  ['dataset', { ...BASE, dataset: 'Ordrs' }, 'Unknown dataset "Ordrs".', { part: 'dataset', said: 'Ordrs' }],
  ['category', { ...BASE, category: 'regoin' }, 'Unknown category column "regoin".', { part: 'category', said: 'regoin', datasetId: D1 }],
  ['measure, written as a call', { ...BASE, measures: ['profit', 'sum(sales)'] }, 'Unknown measure column "sales".', { part: 'measure', said: 'sales', datasetId: D1, index: 1 }],
  ['measure, written as an object', { ...BASE, measures: [{ metric: 'Margin', agg: 'avg' }] }, 'Unknown measure column "Margin".', { part: 'measure', said: 'Margin', datasetId: D1, index: 0 }],
  ['series', { ...BASE, series: 'chanel' }, 'Unknown split column "chanel".', { part: 'series', said: 'chanel', datasetId: D1 }],
  ['filter', { ...BASE, filters: [{ column: 'segment', op: '=', value: 'x' }, { column: 'segmnt', op: '=', value: 'x' }] }, 'Unknown filter column "segmnt".', { part: 'filter', said: 'segmnt', datasetId: D1, index: 1 }],
];
for (const [what, raw, reason, miss] of MISSES) {
  const r = refuse(raw);
  ok(`miss: an unknown ${what} reports the part and what was said, beside the reason it always gave`, r.reason === reason && sameLeaves(r.miss, miss), show(r));
}
const NO_MISS: [string, unknown, string][] = [
  ['the measure cap', { ...BASE, measures: ['profit', 'profit', 'profit', 'profit', 'profit'] }, 'At most 4 measures.'],
  ['the filter cap', { ...BASE, filters: Array.from({ length: 9 }, () => ({ column: 'segment', op: '=', value: 'x' })) }, 'At most 8 filters.'],
  ['a bad aggregation', { ...BASE, measures: ['median(profit)'] }, 'Unknown aggregation "median".'],
  ['a sum over text', { ...BASE, measures: ['sum(region_name)'] }, '"region_name" is text, so it cannot be summed.'],
  ['a bad value', { ...BASE, filters: [{ column: 'profit', op: '>', value: 'abc' }] }, 'The "profit" filter value does not fit a number column.'],
  ['a bad period', { ...BASE, filters: [{ column: 'order_date', period: 'next_week' }] }, 'Unknown period "next_week".'],
  ['a bad operator', { ...BASE, filters: [{ column: 'segment', op: '~', value: 'x' }] }, 'Unknown filter operator "~".'],
  ['a split that is the category', { ...BASE, series: 'region_name' }, 'The split cannot be the category.'],
  ['no measure', { dataset: 'Orders', category: 'region_name' }, 'The answer names no measure.'],
  ['no spec', null, 'The answer has no spec.'],
  ['no dataset named, among two', { category: 'region_name', measures: ['plan'] }, 'Unknown dataset "".'],
  ['no category named', { dataset: 'Orders', measures: ['profit'] }, 'Unknown category column "undefined".'],
  ['a measure that is not a name', { ...BASE, measures: [5] }, 'A measure must name a column.'],
];
for (const [what, raw, reason] of NO_MISS) {
  const r = refuse(raw);
  ok(`miss: ${what} reports none (negative control)`, r.reason === reason && !('miss' in r), show(r));
}
const fine = A.validateAnswerSpec(BASE, ALL, TITLE);
ok('miss: a spec that validates is what it always was', fine.ok && !('miss' in fine));

// ── 2. Suggestions ──────────────────────────────────────────────────────────

/** The options for a refused spec — and, with them, what the validator said was missing. */
const suggest = (raw: unknown, among = ALL, metrics: SpecMetric[] = []): AnswerChip[] => {
  const r = A.validateAnswerSpec(raw, among, { ...TITLE, metrics });
  if (r.ok || !r.miss) throw new Error('fixture is not a miss: ' + show(r));
  return S.suggestFixes(raw, r.miss, among, metrics, TITLE);
};
const labels = (raw: unknown, among = ALL): string => suggest(raw, among).map((o) => o.label).join();
/** DIFFERENTIAL: each option against the validator's own answer for the question with the right name written by hand. */
const sameAsWritten = (options: AnswerChip[], written: unknown[], among = ALL, metrics: SpecMetric[] = []): boolean =>
  options.length === written.length && options.every((o, i) => {
    const v = A.validateAnswerSpec(written[i], among, { ...TITLE, metrics });
    return v.ok && sameLeaves(o.spec, v.spec);
  });

const sales = suggest({ ...BASE, measures: ['sales'] });
ok('rank: containment, then type fit (a measure prefers a number), ties in column order', sales.map((o) => o.label).join() === 'net_sales,sales_tax,sales_rep', show(sales.map((o) => o.label)));
ok('rank: …each option is the spec the right name gives (differential)',
  sameAsWritten(sales, ['net_sales', 'sales_tax', 'sales_rep'].map((m) => ({ ...BASE, measures: [m] }))), show(sales));
const summed = suggest({ ...BASE, measures: ['sum(sales)'] });
ok('type fit: a sum needs a number column — the text one is not offered', summed.map((o) => o.label).join() === 'net_sales,sales_tax', show(summed.map((o) => o.label)));
ok('type fit: …and the aggregation that was said is kept (differential)', sameAsWritten(summed, ['sum(net_sales)', 'sum(sales_tax)'].map((m) => ({ ...BASE, measures: [m] }))));
const second = suggest({ ...BASE, measures: ['profit', 'avg(sale)'] });
ok('measure: only the measure that missed is replaced, where it stood (differential)',
  sameAsWritten(second, [['profit', 'avg(net_sales)'], ['profit', 'avg(sales_tax)']].map((measures) => ({ ...BASE, measures }))), show(second));

ok('type fit: a category prefers text or a date over a number, whatever the column order',
  labels({ ...BASE, category: 'region' }) === 'region_name,region_code');
const UNITS: SpecDataset = { id: D2, name: 'Units', columns: [{ name: 'unit_price', type: 'number' }, { name: 'units', type: 'number' }, { name: 'unis', type: 'text' }, { name: 'other', type: 'text' }] };
ok('rank: containment comes before one edit, even where the one-edit column fits the type better',
  labels({ dataset: 'Units', category: 'unit', measures: ['count(other)'] }, [UNITS]) === 'unit_price,units,unis');
ok('rank: one edit alone is enough', labels({ ...BASE, series: 'chanel' }) === 'channel');

const taught = suggest({ ...BASE, measures: ['total takings'] });
ok('taught names count, and the label is the display name', taught.length === 1 && taught[0].label === 'Net Amount' && taught[0].spec.measures[0].column === 'net_amount', show(taught));
const untaught = [{ ...DS, names: undefined, shown: undefined }, OTHER];
ok('taught names: …untaught, the same words are near nothing (negative control)', suggest({ ...BASE, measures: ['total takings'] }, untaught).length === 0);
ok('label: a column with only "Also called" names is labelled by its own name', labels({ ...BASE, measures: ['margin'] }) === 'profit');
const filtered = suggest({ ...BASE, filters: [{ column: 'region_name', op: '=', value: 'West' }, { column: 'segmnt', op: 'in', values: ['Enterprise', 'SMB'] }] });
ok('filter: the column is replaced, its comparison and the other filters kept (differential) — labelled by the display name',
  filtered.length === 1 && filtered[0].label === 'Customer Segment'
  && sameAsWritten(filtered, [{ ...BASE, filters: [{ column: 'region_name', op: '=', value: 'West' }, { column: 'segment', op: 'in', values: ['Enterprise', 'SMB'] }] }]), show(filtered));
ok('validity: a period filter is never offered a column that is not a date',
  labels({ ...BASE, filters: [{ column: 'date', period: 'last_quarter' }] }) === 'order_date');
ok('validity: …where a plain comparison on the same name is offered both (negative control)',
  labels({ ...BASE, filters: [{ column: 'date', op: '=', value: 'x' }] }) === 'order_date,update_note');

const ds1 = suggest({ ...BASE, dataset: 'Ordrs' });
ok('dataset: the near dataset, by id', ds1.length === 1 && ds1[0].label === 'Orders' && ds1[0].spec.datasetId === D1, show(ds1));
ok('dataset: a near dataset the rest of the spec does not fit is not offered', suggest({ ...BASE, dataset: 'Budgets 2024' }).length === 0);
ok('dataset: …and is, once it fits (negative control)', labels({ dataset: 'Budgets 2024', category: 'region_name', measures: ['plan'] }) === 'Budget');

ok('none: nothing near → no options', suggest({ ...BASE, category: 'zzzz' }).length === 0 && suggest({ ...BASE, category: 'regoin' }).length === 0);
ok('none: a name under 3 letters is near too much to say (negative control: "net" is not)', suggest({ ...BASE, measures: ['ne'] }).length === 0 && labels({ ...BASE, measures: ['net'] }) === 'net_sales,Net Amount');
const MANY: SpecDataset = { id: D1, name: 'Many', columns: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ name: `amt_${x}`, type: 'number' as const })).concat([{ name: 'k', type: 'number' }]) };
ok('cap: at most three options (negative control: five columns are near)', labels({ dataset: 'Many', category: 'k', measures: ['amt'] }, [MANY]) === 'amt_a,amt_b,amt_c');
const TWINS: SpecDataset = { id: D1, name: 'Twins', columns: [{ name: 'Order Date', type: 'date' }, { name: 'order_date', type: 'date' }, { name: 'v', type: 'number' }] };
ok('ambiguity: two columns a name could not tell apart are both offered', labels({ dataset: 'Twins', category: 'orderdate', measures: ['v'] }, [TWINS]) === 'Order Date,order_date');

const METRICS: SpecMetric[] = [{ id: '33333333-3333-4333-8333-333333333333', name: 'Margin', datasetId: D1, column: 'profit', aggregation: 'avg' }];
const byMetric = suggest({ ...BASE, category: 'region', measures: [{ metric: 'Margin' }] }, ALL, METRICS);
ok('metrics: a measure named by its metric still resolves in every option',
  byMetric.length === 2 && byMetric.every((o) => show(o.spec.measures) === show([{ column: 'profit', aggregation: 'avg', metricId: METRICS[0].id }])), show(byMetric));
ok('every option passes the stored-spec whitelist as it is', [...sales, ...summed, ...filtered, ...ds1, ...byMetric].every((o) => sameLeaves(A.sanitizeStoredSpec(o.spec), o.spec)));
ok('a spec that is not an object offers nothing', S.suggestFixes('sales by region', { part: 'measure', said: 'sales', datasetId: D1 }, ALL).length === 0);

// ── 3. A refused follow-up ──────────────────────────────────────────────────

const prevR = A.validateAnswerSpec({ ...BASE, top: 5, filters: [{ column: 'order_date', period: 'last_quarter' }, { column: 'segment', op: '=', value: 'Enterprise' }] }, ALL, TITLE);
if (!prevR.ok) throw new Error('fixture does not validate');
const prev = prevR.spec;
const merged = R.refineSpec(prev, { refine: true, series: 'chanel' }, DS);
const follow = suggest(merged);
ok('follow-up: against the MERGED spec the option keeps the carried filters and the cut',
  follow.length === 1 && follow[0].label === 'channel' && follow[0].spec.series === 'channel' && sameLeaves(follow[0].spec.filters, prev.filters) && follow[0].spec.top === 5, show(follow));
const alone = suggest({ ...BASE, series: 'chanel' });
ok('follow-up: …against the patch alone it could not (negative control)', alone.length === 1 && alone[0].spec.filters.length === 0 && alone[0].spec.top === undefined);

// ── 4. Storage ──────────────────────────────────────────────────────────────

const good = { part: 'measure', said: 'sales', options: sales };
const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
ok('store: a suggestion round-trips', sameLeaves(S.sanitizeSuggest(wire(good)), good), show(S.sanitizeSuggest(wire(good))));
const big = S.sanitizeSuggest(wire({ part: 'filter', said: `  ${'s'.repeat(200)}\n\n tail `, extra: 1, options: [
  ...sales, ...summed,
].map((o, i) => ({ ...o, label: i === 0 ? `Net\n   sales ${'x'.repeat(200)}` : o.label, more: true })) }));
ok('store: at most three options, `said` and a label one line of 80 characters, unknown keys gone (negative control: five options, 200 characters)',
  !!big && big.options.length === 3 && big.said === 's'.repeat(80) && big.options[0].label === `Net sales ${'x'.repeat(70)}`
  && show(Object.keys(big)) === '["part","said","options"]' && big.options.every((o) => show(Object.keys(o)) === '["label","spec"]'), show(big));
const mixed = S.sanitizeSuggest(wire({ part: 'category', said: 'x', options: [
  null, 'net_sales', { label: 'no spec' }, { label: 'bad spec', spec: { category: 'region_name' } }, { label: 7, spec: sales[0].spec },
  { label: '   ', spec: sales[0].spec }, { label: 'kept', spec: { ...sales[0].spec, junk: true } },
] }));
ok('store: a malformed option is dropped, a good one beside it kept and whitelisted',
  !!mixed && mixed.options.length === 1 && mixed.options[0].label === 'kept' && sameLeaves(mixed.options[0].spec, sales[0].spec), show(mixed));
const BAD: unknown[] = [
  null, 'did you mean', [], { part: 'value', said: 'x', options: sales }, { part: 'measure', said: 7, options: sales },
  { part: 'measure', said: 'x', options: [] }, { part: 'measure', said: 'x', options: [{ label: 'y', spec: {} }] }, { part: 'measure', said: 'x' },
];
ok('store: anything else is no suggestion at all', BAD.every((b) => S.sanitizeSuggest(b) === undefined), show(BAD.map((b) => S.sanitizeSuggest(b))));

// Through the thread store's own load (src/ai/copilot.ts `normalize`): a stored file is untrusted.
const at = '2026-01-01T00:00:00.000Z';
const turns = copilot.normalize(wire({ projectId: D1, schemaVersion: 2, threads: [{ id: 't', title: 'T', createdAt: at, updatedAt: at, turns: [
  { id: 'a', role: 'assistant', text: 'refused', createdAt: at, suggest: good },
  { id: 'b', role: 'assistant', text: '', createdAt: at, answer: sales[0].spec, suggest: good },
  { id: 'c', role: 'user', text: 'sales by region', createdAt: at, suggest: good },
  { id: 'd', role: 'assistant', text: 'refused', createdAt: at, suggest: { part: 'measure', said: 'x', options: [{ label: 'y', spec: {} }] } },
] }] }))[0].turns;
ok('turn: a refused turn keeps its suggestion across a load', sameLeaves(turns[0].suggest, good), show(turns[0]));
ok('turn: never beside an answer, never on a user turn, never malformed (negative controls)',
  !!turns[1].answer && !('suggest' in turns[1]) && !('suggest' in turns[2]) && !('suggest' in turns[3]), show(turns.slice(1)));

finish();
