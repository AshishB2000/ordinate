// Evaluation suites, the pure checks (docs/eval-suites/00-design.md): what a case may expect, the same question, the same figure
// (`Object.is`, leaf by leaf), the verdict and the comparison with the last run. Each guard has a negative control: a wrong
// dataset, a wrong filter, a made-up figure and a prose-only "refusal" each FAIL, and the right answer passes.
//
//   npm run build:ts && node scripts/test-evalChecks.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const c: typeof import('../src/ai/evalChecks') = require('../src/ai/evalChecks');
const fb: typeof import('../src/ai/feedback') = require('../src/ai/feedback');
type Spec = import('../src/ai/answerSpec').AnswerSpec;

const DS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const spec = (over: Partial<Spec> = {}): Spec => ({ datasetId: DS, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Sales by region', ...over });
const DATA = { labels: ['East', 'West'], series: [{ name: 'sum of sales', values: [1664, 1784] }] };
const chart = (s: Spec): import('../src/ai/evalChecks').Answered => ({ computed: { kind: 'chart', spec: s }, refused: false, auditOk: true });
const failing = (checks: ReadonlyArray<{ id: string; ok: boolean }>): string => checks.filter((x) => !x.ok).map((x) => x.id).join(',');

// ── what a case may expect ───────────────────────────────────────────────────────────────────────────────────────────────
ok('expect: a spec alone, a refusal alone and words alone are cases', !!c.sanitizeExpect({ compute: spec() }) && !!c.sanitizeExpect({ refuse: true }) && !!c.sanitizeExpect({ say: 'net of refunds' }));
ok('expect: nothing, a refusal with a figure, a bad spec and a non-object are not', c.sanitizeExpect({}) === null && c.sanitizeExpect({ compute: spec(), refuse: true }) === null && c.sanitizeExpect({ compute: { nope: 1 } }) === null && c.sanitizeExpect('x') === null && c.sanitizeExpect(null) === null);
ok('expect: words ride along with a spec, one line, cut to the cap', c.sanitizeExpect({ compute: spec(), say: ' a\n  b ' })?.say === 'a b' && (c.sanitizeExpect({ say: 'x'.repeat(900) })?.say?.length ?? 0) === c.MAX_SAY);
ok('expect: sanitizing twice is sanitizing once', JSON.stringify(c.sanitizeExpect(c.sanitizeExpect({ compute: spec(), say: 'hi' }))) === JSON.stringify(c.sanitizeExpect({ compute: spec(), say: 'hi' })));

// ── the same question ────────────────────────────────────────────────────────────────────────────────────────────────────
ok('question: how it is drawn (chart type, title) is not part of it', c.sameQuestion(spec(), spec({ chartType: 'bar', title: 'Another title' })));
ok('question: a wrong dataset is another question', !c.sameQuestion(spec(), spec({ datasetId: OTHER })));
ok('question: a wrong filter is another question', !c.sameQuestion(spec(), spec({ filters: [{ column: 'region', op: '=', value: 'West' }] })));
ok('question: filters in another order are the same question', c.sameQuestion(spec({ filters: [{ column: 'region', op: '=', value: 'West' }, { column: 'plan', op: '=', value: 'Pro' }] }), spec({ filters: [{ column: 'plan', op: '=', value: 'Pro' }, { column: 'region', op: '=', value: 'West' }] })));
ok('question: another measure, another period and a top-N are other questions', !c.sameQuestion(spec(), spec({ measures: [{ column: 'sales', aggregation: 'avg' }] })) && !c.sameQuestion(spec(), spec({ filters: [{ column: 'day', period: 'last_30_days' } as never] })) && !c.sameQuestion(spec(), spec({ top: 3 })));

// ── the same figure, by Object.is ────────────────────────────────────────────────────────────────────────────────────────
ok('figure: equal data agree', c.sameFigures(DATA, JSON.parse(JSON.stringify(DATA))));
ok('figure: one digit off disagrees', !c.sameFigures(DATA, { ...DATA, series: [{ name: 'sum of sales', values: [1664, 1785] }] }));
ok('figure: NaN equals NaN and -0 is not 0 (Object.is)', c.sameFigures([NaN], [NaN]) && !c.sameFigures([0], [-0]));
ok('figure: a number is not its text, a longer list is not the shorter one, a missing key is not a present one', !c.sameFigures([1], ['1']) && !c.sameFigures([1, 2], [1]) && !c.sameFigures({ a: 1 }, { a: 1, b: 2 }) && c.sameFigures({ a: 1, b: undefined }, { a: 1 }));

// ── the exact checks ─────────────────────────────────────────────────────────────────────────────────────────────────────
const want = c.sanitizeExpect({ compute: spec() })!;
const sameSides = { expected: DATA, answer: DATA };
const right = c.exactChecks(want, chart(spec()), sameSides);
ok('compute: the right answer passes every check, and the verdict is pass', failing(right) === '' && right.map((x) => x.id).join() === 'answered,question,figure,audit' && c.verdict(right, { state: 'none' }) === 'pass', JSON.stringify(right));
const wrongData = c.exactChecks(want, chart(spec({ datasetId: OTHER })), { expected: DATA, answer: { labels: ['East'], series: [{ name: 'x', values: [1] }] } });
ok('NEGATIVE CONTROL: a wrong dataset fails the question and the figure', failing(wrongData) === 'question,figure' && c.verdict(wrongData, { state: 'none' }) === 'fail', failing(wrongData));
const wrongFilter = c.exactChecks(want, chart(spec({ filters: [{ column: 'region', op: '=', value: 'West' }] })), { expected: DATA, answer: { labels: ['West'], series: [{ name: 'sum of sales', values: [1784] }] } });
ok('NEGATIVE CONTROL: a wrong filter fails the question and the figure', failing(wrongFilter) === 'question,figure', failing(wrongFilter));
const sameQ = c.exactChecks(want, chart(spec({ chartType: 'bar' })), { expected: DATA, answer: { labels: ['East', 'West'], series: [{ name: 'sum of sales', values: [1664, 1784.0000001] }] } });
ok('NEGATIVE CONTROL: the same question with a figure that differs fails the figure alone', failing(sameQ) === 'figure' && sameQ.find((x) => x.id === 'figure')?.code === 'different', JSON.stringify(sameQ));
const made = c.exactChecks(want, { ...chart(spec()), auditOk: false }, sameSides);
ok('NEGATIVE CONTROL: a made-up figure (the number audit) fails the audit alone', failing(made) === 'audit' && c.verdict(made, { state: 'none' }) === 'fail');
ok('compute: no answer at all fails `answered`', failing(c.exactChecks(want, { computed: null, refused: true, auditOk: true }, null)) === 'answered');
ok('compute: an SQL answer cannot be compared to a spec: question and figure fail with the `sql` code', c.exactChecks(want, { computed: { kind: 'sql' }, refused: false, auditOk: true }, null).filter((x) => x.code === 'sql').length === 2);
ok('compute: an expected spec that no longer computes fails the figure (never a pass)', c.exactChecks(want, chart(spec()), { expected: null, answer: DATA }).find((x) => x.id === 'figure')?.code === 'expected_failed' && c.exactChecks(want, chart(spec()), { expected: DATA, answer: null }).find((x) => x.id === 'figure')?.code === 'answer_failed');

const refuse = c.sanitizeExpect({ refuse: true })!;
ok('refuse: the app refusing passes', failing(c.exactChecks(refuse, { computed: null, refused: true, auditOk: true }, null)) === '');
ok('NEGATIVE CONTROL: an answer where a refusal was expected fails', c.exactChecks(refuse, chart(spec()), null)[0].code === 'answered');
ok('NEGATIVE CONTROL: a prose-only reply is not a refusal', c.exactChecks(refuse, { computed: null, refused: false, auditOk: true }, null)[0].code === 'prose');
ok('words only: the exact checks are the audit alone', c.exactChecks(c.sanitizeExpect({ say: 'x' })!, { computed: null, refused: false, auditOk: true }, null).map((x) => x.id).join() === 'audit');

// ── the verdict ──────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('verdict: with words, a score of 4 or 5 passes and 1 to 3 fails', c.verdict(right, { state: 'scored', score: 4 }) === 'pass' && c.verdict(right, { state: 'scored', score: 5 }) === 'pass' && c.verdict(right, { state: 'scored', score: 3 }) === 'fail' && c.verdict(right, { state: 'scored', score: 1 }) === 'fail');
ok('NEGATIVE CONTROL: an unscored judge is not a pass', c.verdict(right, { state: 'not_scored' }) === 'not_scored');
ok('NEGATIVE CONTROL: a failed exact check is a fail whatever the judge says', c.verdict(wrongData, { state: 'scored', score: 5 }) === 'fail' && c.verdict(wrongData, { state: 'not_scored' }) === 'fail');

// ── the comparison with the last run ─────────────────────────────────────────────────────────────────────────────────────
const L = (caseId: string, outcome: import('../src/ai/evalChecks').Outcome, score: number | null = null) => ({ caseId, outcome, score });
const cmp = c.compareRuns([L('a', 'fail'), L('b', 'pass'), L('c', 'pass', 3), L('d', 'not_scored'), L('e', 'pass')], [L('a', 'pass'), L('b', 'fail'), L('c', 'pass', 5), L('d', 'not_scored'), L('e', 'pass'), L('f', 'pass')]);
ok('compare: better, worse, same and new', JSON.stringify([cmp.better, cmp.worse, cmp.same, cmp.new]) === '[2,1,2,1]' && cmp.moves.get('a') === 'better' && cmp.moves.get('b') === 'worse' && cmp.moves.get('c') === 'better' && cmp.moves.get('f') === 'new', JSON.stringify([...cmp.moves]));
ok('compare: a lower judge score on a pass is worse; an error ranks with a fail', c.compareRuns([L('a', 'pass', 5)], [L('a', 'pass', 4)]).worse === 1 && c.compareRuns([L('a', 'fail')], [L('a', 'error')]).same === 1);

// ── thumbs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('feedback: a value, a reason only on a thumbs-down, nothing else', JSON.stringify(fb.sanitizeFeedback({ value: 'down', reason: 'wrong_number', text: 'secret' })) === '{"value":"down","reason":"wrong_number"}' && JSON.stringify(fb.sanitizeFeedback({ value: 'up', reason: 'wrong_number' })) === '{"value":"up"}');
ok('feedback: an unknown value or reason is dropped', fb.sanitizeFeedback({ value: 'meh' }) === undefined && fb.sanitizeFeedback(null) === undefined && JSON.stringify(fb.sanitizeFeedback({ value: 'down', reason: 'because' })) === '{"value":"down"}');

finish();
