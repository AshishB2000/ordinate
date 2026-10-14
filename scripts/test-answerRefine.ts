// Self-check for a FOLLOW-UP that refines the answer on screen — PURE: no fs, no model.
//
//   1. THE MERGE (src/ai/answerRefine.ts), DIFFERENTIAL: for every kind of change
//      a follow-up makes, validating the previous answer with the patch laid over
//      it gives — leaf by leaf, Object.is — the spec the validator gives for the
//      whole question written out in full. Two spellings of one question, one
//      answer; nothing is compared with a hand-written RESULT.
//   2. NEGATIVE CONTROLS: a `refine` with nothing before it is a plain spec; a
//      merge past the filter cap is refused with the cap's reason; a full spec
//      keeps nothing of the previous answer; an unknown column is refused by the
//      name that was said.
//   3. THE BLOCK the model reads (src/ai/previousAnswer.ts): names only, a
//      withheld filter value never in it (canary), and how its own digits meet
//      the number audit — a reply repeating a setting is not accused, a made-up
//      figure still is.
//
//   npm run build:ts && node scripts/test-answerRefine.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const R: typeof import('../src/ai/answerRefine') = require('../src/ai/answerRefine');
const B: typeof import('../src/ai/previousAnswer') = require('../src/ai/previousAnswer');
const audit: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');
const notes: typeof import('../src/ai/columnNotes') = require('../src/ai/columnNotes');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type AnswerSpec = import('../src/ai/answerSpec').AnswerSpec;

const COLS: ParsedColumn[] = [
  { name: 'order_date', type: 'date' },
  { name: 'region', type: 'text' },
  { name: 'channel', type: 'text' },
  { name: 'segment', type: 'text' },
  { name: 'email', type: 'text' },
  { name: 'revenue', type: 'number' },
  { name: 'profit', type: 'number' },
];
const DS = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Orders', columns: COLS,
  names: { segment: ['Customer Segment', 'tier'], revenue: ['Net Amount', 'sales'], order_date: ['Booked on'] },
};
const OTHER = { id: '22222222-2222-4222-8222-222222222222', name: 'Budget', columns: [{ name: 'region', type: 'text' as const }, { name: 'plan', type: 'number' as const }] };
const ALL = [DS, OTHER];
const TITLE = { title: 'the question as it now stands' };

function sameLeaves(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  const ka = Object.keys(a);
  return Array.isArray(a) === Array.isArray(b) && ka.length === Object.keys(b).length
    && ka.every((k) => k in b && sameLeaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
const full = (raw: unknown): import('../src/ai/answerSpec').SpecResult => A.validateAnswerSpec(raw, ALL, TITLE);
const must = (raw: unknown): AnswerSpec => {
  const r = full(raw);
  if (!r.ok) throw new Error('fixture does not validate: ' + r.reason);
  return r.spec;
};
/** The follow-up: `patch` over `previous`, through the one validator. */
const refined = (previous: AnswerSpec, patch: unknown, metrics: import('../src/ai/answerSpec').SpecMetric[] = []) =>
  A.validateAnswerSpec(R.refineSpec(previous, patch, DS, metrics), ALL, { ...TITLE, metrics });

// ── The previous answer: "revenue by region last quarter, enterprise only" ───
const P_RAW = {
  dataset: 'Orders', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }],
  filters: [{ column: 'order_date', period: 'last_quarter' }, { column: 'segment', op: '=', value: 'Enterprise' }],
};
const P = must(P_RAW);
const PERIOD = { column: 'order_date', period: 'last_quarter' };
const SEGMENT = { column: 'segment', op: '=', value: 'Enterprise' };

ok('sameLeaves tells two specs apart (the comparison is not vacuous)',
  !sameLeaves(P, { ...P, category: 'channel' }) && !sameLeaves(P, { ...P, filters: P.filters.slice(0, 1) }) && sameLeaves(P, must(P_RAW)));

// ── 1. The merge, against the whole question written out ────────────────────
// [what changes, the patch a follow-up carries, the same question in full]
const CASES: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['add a filter',
    { refine: true, filters: [{ column: 'channel', op: '=', value: 'Online' }] },
    { ...P_RAW, filters: [PERIOD, SEGMENT, { column: 'channel', op: '=', value: 'Online' }] }],
  ['replace the filter on the same column',
    { refine: true, filters: [{ column: 'segment', op: '=', value: 'SMB' }] },
    { ...P_RAW, filters: [PERIOD, { column: 'segment', op: '=', value: 'SMB' }] }],
  ['replace it when the patch says the column by its display name',
    { refine: true, filters: [{ column: 'Customer Segment', op: 'in', values: ['SMB', 'Mid-market'] }] },
    { ...P_RAW, filters: [PERIOD, { column: 'segment', op: 'in', values: ['SMB', 'Mid-market'] }] }],
  ['replace it when the patch says the column by an alias, in another case',
    { refine: true, filters: [{ column: 'TIER', op: '!=', value: 'Enterprise' }] },
    { ...P_RAW, filters: [PERIOD, { column: 'segment', op: '!=', value: 'Enterprise' }] }],
  ['drop a filter',
    { refine: true, dropFilters: ['segment'] },
    { ...P_RAW, filters: [PERIOD] }],
  ['drop a filter named by an alias, and add one in the same breath',
    { refine: true, dropFilters: ['tier'], filters: [{ column: 'region', op: 'in', values: ['West', 'East'] }] },
    { ...P_RAW, filters: [PERIOD, { column: 'region', op: 'in', values: ['West', 'East'] }] }],
  ['add a split',
    { refine: true, series: 'channel' },
    { ...P_RAW, series: 'channel' }],
  ['change the measure',
    { refine: true, measures: [{ column: 'profit', aggregation: 'avg' }] },
    { ...P_RAW, measures: [{ column: 'profit', aggregation: 'avg' }] }],
  ['change the measure, written as one `measure`',
    { refine: true, measure: 'profit' },
    { ...P_RAW, measures: ['profit'] }],
  ['change the chart type',
    { refine: true, chartType: 'pie' },
    { ...P_RAW, chartType: 'pie' }],
  ['change the period',
    { refine: true, filters: [{ column: 'Booked on', period: 'last_year' }] },
    { ...P_RAW, filters: [SEGMENT, { column: 'order_date', period: 'last_year' }] }],
  ['change the top-N',
    { refine: true, top: 3 },
    { ...P_RAW, top: 3 }],
  ['change the category (the chart type nobody chose follows the new shape)',
    { refine: true, category: 'order_date' },
    { ...P_RAW, category: 'order_date' }],
  ['nothing at all: an empty patch is the previous answer',
    { refine: true },
    P_RAW],
];
for (const [label, patch, whole] of CASES) {
  const got = refined(P, patch);
  const want = full(whole);
  ok(`merge: ${label}`, got.ok && want.ok && sameLeaves(got.spec, want.spec), JSON.stringify(got));
}
ok('merge: …and those cases are not all one spec (each change changed something)',
  new Set(CASES.map(([, patch]) => JSON.stringify(refined(P, patch)))).size === CASES.length);

// A previous answer that already has a split, a chosen chart type and a top-N.
const Q_RAW = { ...P_RAW, series: 'channel', chartType: 'stacked_bar', top: 5 };
const Q = must(Q_RAW);
const CASES_Q: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['remove the split (a chosen chart type is kept)', { refine: true, series: null }, { ...P_RAW, chartType: 'stacked_bar', top: 5 }],
  ['change the split', { refine: true, series: 'segment' }, { ...Q_RAW, series: 'segment' }],
  ['remove the top-N', { refine: true, top: null }, { ...P_RAW, series: 'channel', chartType: 'stacked_bar' }],
  ['a filter is added and the split, the chart type and the top-N all stay',
    { refine: true, filters: [{ column: 'revenue', op: '>', value: 100 }] },
    { ...Q_RAW, filters: [PERIOD, SEGMENT, { column: 'revenue', op: '>', value: 100 }] }],
  ['a range — two filters on one column in the SAME patch — keeps both',
    { refine: true, filters: [{ column: 'revenue', op: '>=', value: 100 }, { column: 'revenue', op: '<=', value: 500 }] },
    { ...Q_RAW, filters: [PERIOD, SEGMENT, { column: 'revenue', op: '>=', value: 100 }, { column: 'revenue', op: '<=', value: 500 }] }],
];
for (const [label, patch, whole] of CASES_Q) {
  const got = refined(Q, patch);
  const want = full(whole);
  ok(`merge: ${label}`, got.ok && want.ok && sameLeaves(got.spec, want.spec), JSON.stringify(got));
}
ok('merge: the dataset is always the previous one, whatever the patch names',
  (() => { const r = refined(P, { refine: true, dataset: 'Budget', top: 2 }); return r.ok && r.spec.datasetId === DS.id; })());
ok('merge: the previous spec is not touched', sameLeaves(P, must(P_RAW)) && sameLeaves(Q, must(Q_RAW)));

// A date axis's roll-up (an explained tile carries one) stays while the axis does.
const byMonth = A.sanitizeStoredSpec({ ...must({ ...P_RAW, category: 'order_date', filters: [SEGMENT] }), grain: 'month' })!;
const stillMonthly = refined(byMonth, { refine: true, filters: [{ column: 'region', op: '=', value: 'West' }] });
ok('merge: a monthly chart is still monthly after a filter is added', stillMonthly.ok && stillMonthly.spec.grain === 'month', JSON.stringify(stillMonthly));
const newAxis = refined(byMonth, { refine: true, category: 'region' });
ok('merge: …and the roll-up goes when the axis does (negative control)', newAxis.ok && newAxis.spec.grain === undefined, JSON.stringify(newAxis));
ok('merge: the validator takes a roll-up only for a date axis, and only one it knows',
  must({ ...P_RAW, category: 'order_date', grain: 'quarter' }).grain === 'quarter'
  && must({ ...P_RAW, grain: 'month' }).grain === undefined && must({ ...P_RAW, category: 'order_date', grain: 'fortnight' }).grain === undefined);

// A measure that IS a defined metric keeps its link through a follow-up.
const TAKE = { id: '55555555-5555-4555-8555-555555555555', name: 'Gross take', datasetId: DS.id, column: 'revenue', aggregation: 'avg' };
const withMetric = A.validateAnswerSpec({ ...P_RAW, measures: ['Gross take'] }, ALL, { ...TITLE, metrics: [TAKE] });
const metricKept = withMetric.ok ? refined(withMetric.spec, { refine: true, top: 3 }, [TAKE]) : withMetric;
const metricWhole = A.validateAnswerSpec({ ...P_RAW, measures: ['Gross take'], top: 3 }, ALL, { ...TITLE, metrics: [TAKE] });
ok('merge: a metric measure is carried as that metric', withMetric.ok && metricKept.ok && metricWhole.ok
  && metricKept.spec.measures[0].metricId === TAKE.id && sameLeaves(metricKept.spec, metricWhole.spec), JSON.stringify(metricKept));
const metricGone = withMetric.ok ? refined(withMetric.spec, { refine: true, top: 3 }) : withMetric;
ok('merge: …and as its column and aggregation when the metric is no longer defined — the same figure, never a refusal',
  metricGone.ok && sameLeaves(metricGone.spec.measures, [{ column: 'revenue', aggregation: 'avg' }]), JSON.stringify(metricGone));

// ── 2. Negative controls ────────────────────────────────────────────────────
const PATCH = { refine: true, filters: [{ column: 'channel', op: '=', value: 'Online' }] };
ok('control: the flag is `"refine": true` exactly', R.isRefine(PATCH) && !R.isRefine({ ...PATCH, refine: 'true' })
  && !R.isRefine({ filters: [] }) && !R.isRefine(null) && !R.isRefine([true]));
const alone = full(PATCH);
ok('control: a refine with no previous answer is a plain spec — refused for what it lacks, as any spec is',
  !alone.ok && sameLeaves(alone, full({ filters: PATCH.filters })), JSON.stringify(alone));

const not = ['West', 'East', 'North', 'South', 'A', 'B', 'C', 'D'].map((v) => ({ column: 'region', op: '!=', value: v }));
const ninth = refined(must({ ...P_RAW, filters: not }), PATCH);
const tooMany = full({ ...P_RAW, filters: Array.from({ length: 9 }, () => SEGMENT) });
ok('control: a merge past the filter cap is refused with the cap\'s own reason',
  !ninth.ok && !tooMany.ok && ninth.reason === tooMany.reason && /At most \d+ filters\./.test(ninth.reason), JSON.stringify(ninth));
const eighth = refined(must({ ...P_RAW, filters: not.slice(1) }), PATCH);
ok('control: …and one filter fewer merges, the old seven and the new one (the cap refused it, not the merge)',
  eighth.ok && eighth.spec.filters.length === 8, JSON.stringify(eighth));

const fresh = { dataset: 'Orders', category: 'segment', measures: ['profit'] };
const freshSpec = must(fresh);
const continued = refined(Q, { ...fresh, refine: true });
ok('control: a full spec without `refine` keeps nothing of the previous answer',
  !R.isRefine(fresh) && freshSpec.filters.length === 0 && freshSpec.series === undefined && freshSpec.top === undefined && freshSpec.chartType === 'column');
ok('control: …where the same words WITH `refine` keep its filters, split, top-N and chart type',
  continued.ok && sameLeaves(continued.spec.filters, Q.filters) && continued.spec.series === Q.series && continued.spec.top === Q.top
  && continued.spec.chartType === Q.chartType && continued.spec.category === 'segment', JSON.stringify(continued));

const unknowns: [string, Record<string, unknown>, RegExp][] = [
  ['filter', { refine: true, filters: [{ column: 'territory', op: '=', value: 'West' }] }, /^Unknown filter column "territory"\.$/],
  ['split', { refine: true, series: 'sales rep' }, /^Unknown split column "sales rep"\.$/],
  ['measure', { refine: true, measures: ['margin'] }, /^Unknown measure column "margin"\.$/],
  ['category', { refine: true, category: 'state' }, /^Unknown category column "state"\.$/],
  ['dropped filter', { refine: true, dropFilters: ['territory'] }, /^Unknown filter column "territory"\.$/],
];
for (const [what, patch, re] of unknowns) {
  const r = refined(P, patch);
  ok(`control: a patch naming an unknown ${what} column is refused, quoting what was said`, !r.ok && re.test(r.reason), JSON.stringify(r));
}
ok('control: dropping a filter that is not there changes nothing', sameLeaves((() => { const r = refined(P, { refine: true, dropFilters: ['channel'] }); return r.ok ? r.spec : null; })(), must(P_RAW)));

// ── 3. The block the model reads ────────────────────────────────────────────
const NONE: ReadonlySet<string> = new Set();
const block = B.previousAnswerBlock(Q, 'Orders', NONE);
ok('block: opens with its name and says the chart by name — dataset, category, measure, split, filters, top, chart',
  block.text === 'PREVIOUS ANSWER (the chart the user is looking at; names only):\n'
    + 'dataset "Orders"; category "region"; measures sum(revenue); split by "channel"; '
    + 'filters: "order_date" in last_quarter, "segment" = "Enterprise"; top 5; chart stacked_bar.', block.text);
const plain = B.previousAnswerBlock(must({ dataset: 'Orders', category: 'region', measures: ['revenue'] }), 'Orders', NONE);
ok('block: an answer with no split, filter or top says none of them', !/split|filters|top/.test(plain.text) && plain.ledger.length === 0, plain.text);
ok('block: every name in it resolves — written back as a spec it is the previous answer',
  sameLeaves(must({ dataset: 'Orders', category: 'region', measures: ['sum(revenue)'], series: 'channel', filters: [PERIOD, SEGMENT], top: 5, chartType: 'stacked_bar' }), Q));

// CANARY: a value filtered on a column marked personal never reaches the block.
const CANARY = 'zq-canary-7731@example.test';
const SECRET_PAY = 918273;
const private_ = must({
  ...P_RAW,
  filters: [{ column: 'email', op: '=', value: CANARY }, { column: 'email', op: 'in', values: [CANARY, 'x-' + CANARY] },
    { column: 'profit', op: '>', value: SECRET_PAY }, { column: 'segment', op: '=', value: 'Enterprise' }],
});
const marked = notes.withheldColumns({ email: { sensitivity: 'personal' }, profit: { sensitivity: 'financial' }, segment: { sensitivity: 'none' } });
const hidden = B.previousAnswerBlock(private_, 'Orders', marked);
ok('canary: a withheld filter value is not in the block, in any spelling of it',
  !hidden.text.includes(CANARY) && !hidden.text.includes('canary') && !hidden.text.includes(String(SECRET_PAY)), hidden.text);
ok('canary: …the column and its operator still are, with the value withheld',
  hidden.text.includes(`"email" = ${notes.WITHHELD}`) && hidden.text.includes(`"email" in ${notes.WITHHELD}`)
  && hidden.text.includes(`"profit" > ${notes.WITHHELD}`) && hidden.text.includes('"segment" = "Enterprise"'), hidden.text);
ok('canary: …and nothing of it reaches the ledger', !hidden.ledger.some((e) => e.value === SECRET_PAY || e.value === 7731), JSON.stringify(hidden.ledger));
const shown = B.previousAnswerBlock(private_, 'Orders', NONE);
ok('canary: unmarked, the same values ARE printed (negative control — the mark is what withholds them)',
  shown.text.includes(CANARY) && shown.text.includes(String(SECRET_PAY)), shown.text);

// The block's numbers and the number audit.
const settings = B.previousAnswerBlock(must({ ...Q_RAW, filters: [{ column: 'revenue', op: '>', value: 100 }, { column: 'order_date', period: 'last_quarter', yearsBack: 2 }] }), 'Orders 365', NONE);
const cited = (text: string, ledger: import('../src/ai/numberAudit').LedgerEntry[]): string[] => audit.auditNumbers(text, ledger).violations.map((v) => v.token);
const REPLY = 'That chart keeps the 5 largest regions of Orders 365 with revenue above 100, 2 years back.';
ok('audit: a reply that repeats the block\'s settings is not accused', cited(REPLY, settings.ledger).length === 0, cited(REPLY, settings.ledger).join());
ok('audit: …without the block\'s ledger the same reply would be (negative control)', cited(REPLY, []).length > 0);
ok('audit: a made-up figure beside those settings is still caught',
  JSON.stringify(cited(REPLY + ' Revenue came to 48,210, up 12.4%.', settings.ledger)) === '["48,210","12.4%"]',
  cited(REPLY + ' Revenue came to 48,210, up 12.4%.', settings.ledger).join());
ok('audit: every ledger entry is a number the block prints — nothing else is let through',
  settings.ledger.every((e) => settings.text.includes(String(e.value))) && settings.ledger.every((e) => e.source === 'previousAnswer'), JSON.stringify(settings.ledger));

finish();
