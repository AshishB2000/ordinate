// The issues board's signals and grouping (docs/issues-board/00-design.md): each signal read off stored turns, what is left out, and the
// grouping by cause, by words and by meaning. PURE: no database.
//
//   npm run build:ts && node scripts/test-issueSignals.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const sig: typeof import('../src/ai/issueSignals') = require('../src/ai/issueSignals');
const grp: typeof import('../src/ai/issueGroups') = require('../src/ai/issueGroups');
const note: typeof import('../src/ai/numberAuditNote') = require('../src/ai/numberAuditNote');
type Turn = import('../src/ai/copilot').CopilotTurn;

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-11-14T10:00:00Z');
let n = 0;
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const user = (text: string, sec: number): Turn => ({ id: `u${++n}`, role: 'user', text, createdAt: at(sec) });
const bot = (sec: number, extra: Partial<Turn> = {}, text = 'An answer.'): Turn => ({ id: `a${++n}`, role: 'assistant', text, createdAt: at(sec), factsFrom: [D1], ...extra });
const kinds = (s: Array<{ kind: string }>) => s.map((x) => x.kind).sort().join(',');

// ── the signals ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const link = { needs: 'link' as const, link: { from: { datasetId: D1, dataset: 'Orders', column: 'cid' }, to: { datasetId: D2, dataset: 'Customers', column: 'id' }, cardinality: 'many_to_one' as const, checks: { names: true, types: true, foundPct: 99, unique: true } } };
let s = sig.signalsOfThread('ann@acme.test', [user('Orders by customer segment?', 0), bot(1, link)]);
ok('a refusal that needs a link: its kind, a key of the two datasets, the asker\'s own question', s.length === 1 && s[0].kind === 'needs_link' && s[0].key === 'link:customers|orders' && s[0].question === 'Orders by customer segment?' && s[0].owner === 'ann@acme.test', JSON.stringify(s));
s = sig.signalsOfThread('ann@acme.test', [user('How many?', 0), bot(1, { needs: 'copy' })]);
ok('a refusal that needs a copy: keyed by the dataset', s.length === 1 && s[0].kind === 'needs_copy' && s[0].key === `copy:${D1}`);
s = sig.signalsOfThread('ann@acme.test', [user('Active customers by region?', 0), bot(1, { define: true, suggest: { part: 'filter', said: 'active customer', options: [] } })]);
ok('an undefined name (#7): keyed by the name said', s.length === 1 && s[0].kind === 'undefined_name' && s[0].key === 'name:active customer' && s[0].label === 'active customer');
s = sig.signalsOfThread('ann@acme.test', [user('Revenue?', 0), bot(1, { define: true })]);
ok('an undefined name with no name said has no key (it groups by words)', s.length === 1 && s[0].key === null);
s = sig.signalsOfThread('ann@acme.test', [user('Sales by Reigon?', 0), bot(1, { suggest: { part: 'category', said: 'Reigon', options: [] } })]);
ok('a refusal with a "Did you mean" and no define is a refusal keyed by the part and the name', s.length === 1 && s[0].kind === 'refused' && s[0].key === 'miss:category:reigon');
s = sig.signalsOfThread('ann@acme.test', [user('Payroll by team?', 0), bot(1, { outside: { dataset: 'Payroll' } })]);
ok('an out-of-scope reply: keyed by the dataset', s.length === 1 && s[0].kind === 'outside' && s[0].key === 'outside:payroll');
s = sig.signalsOfThread('ann@acme.test', [user('Total?', 0), bot(1, {}, `Sales were up.\n\n${note.GUARD_NOTE}987654, 12.5%`)]);
ok('an untraced figure: found by its marker', s.length === 1 && s[0].kind === 'untraced' && s[0].key === null);
ok('NEGATIVE CONTROL: the figures after the marker are in no field of the signal', !JSON.stringify(s).includes('987654') && !JSON.stringify(s).includes('12.5'));
ok('a plain answer carries no signal', sig.signalsOfThread('a@b.c', [user('Hi', 0), bot(1)]).length === 0);
ok('an answer with no question before it carries none', sig.signalsOfThread('a@b.c', [bot(1, { needs: 'copy' })]).length === 0);
ok('a deep-research turn carries none', sig.signalsOfThread('a@b.c', [user('Why churn?', 0), bot(1, { research: { runId: D1 }, needs: 'copy' })]).length === 0);
s = sig.signalsOfThread('a@b.c', [user('x', 0), bot(1, { dashboardsFrom: [D2], suggest: { part: 'measure', said: 'Q3 revenue', options: [] }, define: true })]);
ok('a name with a digit is not kept as a label (it could carry a figure); the dashboards it showed are', s[0].label === null && s[0].key === null && s[0].dashboardIds.join() === D2);
ok('the datasets an answer showed are kept for the folder rule', sig.signalsOfThread('a@b.c', [user('x', 0), bot(1, { needs: 'copy', factsFrom: [D1, D2] })])[0].datasetIds.join() === `${D1},${D2}`);

// asked again
const again = (gap: number, second: string, first = 'How many orders shipped last week by warehouse?') => sig.signalsOfThread('a@b.c', [user(first, 0), bot(1), user(second, gap), bot(gap + 1)]);
ok('asked again at 59 s in other words: the first question struggled', kinds(again(59, 'Orders shipped last week per warehouse?')) === 'asked_again');
ok('asked again at 61 s is a new question', again(61, 'Orders shipped last week per warehouse?').length === 0);
ok('the same words again are not "in other words"', again(20, 'how many orders shipped last week by warehouse').length === 0);
ok('a different question is not a rephrase', again(20, 'What is the weather in Paris today?').length === 0);
ok('the signal is on the first answer, with the first question', again(20, 'Orders shipped last week per warehouse?')[0].question.startsWith('How many orders') && again(20, 'Orders shipped last week per warehouse?')[0].turnId.startsWith('a'));
const thumb = sig.fromThumb({ turnId: 't9', owner: 'a@b.c', question: 'q?', reason: 'wrong_number', datasetIds: [D1], dashboardIds: [], at: at(5) });
ok('a thumbs-down row is a signal with its reason', thumb.kind === 'thumbs_down' && thumb.reason === 'wrong_number' && thumb.key === null);

// ── grouping ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
let k = 0;
const mk = (question: string, extra: Partial<import('../src/ai/issueSignals').Signal> = {}) => ({ turnId: `s${++k}`, kind: 'thumbs_down' as const, reason: null, key: null, label: null, question, owner: `u${k % 3}@x.y`, datasetIds: [], dashboardIds: [], at: at(k), ...extra });
const named = (q: string) => mk(q, { kind: 'undefined_name', key: 'name:active customer', label: 'active customer' });
let g = grp.groupSignals([named('a'), named('b'), named('c'), mk('Revenue by region?', { kind: 'outside', key: 'outside:payroll' })]);
ok('signals with one key are one group; another key, another', g.length === 2 && g.find((x) => x.key === 'name:active customer')!.signals.length === 3);
g = grp.groupSignals([named('x'), mk('how many active customers did we add this quarter'), mk('weather in paris')]);
ok('a question that holds a named missing name joins that group', g.find((x) => x.key === 'name:active customer')!.signals.length === 2 && g.length === 2);
g = grp.groupSignals([mk('Orders shipped last week by warehouse?'), mk('Which warehouse shipped most orders last week?'), mk('Orders shipped per warehouse last week'), mk('Employee headcount by department'), mk('Headcount of each department of employees')]);
ok('unkeyed questions cluster by their words: two clusters', g.length === 2 && g.map((x) => x.signals.length).sort().join() === '2,3', JSON.stringify(g.map((x) => [x.key, x.signals.length])));
ok('a words group is keyed by its three commonest words', g.every((x) => /^words:[a-z]+(\+[a-z]+){0,2}$/.test(x.key)) && g.some((x) => x.key.includes('warehouse')));
ok('NEGATIVE CONTROL: questions with nothing in common stay apart', grp.groupSignals([mk('Orders shipped by warehouse'), mk('Headcount by department'), mk('Refund rate for premium plans')]).length === 3);
ok('questions count once per turn: a turn that struggled two ways is one question', grp.questionCount([mk('a', { turnId: 't1' }), mk('a', { turnId: 't1', kind: 'untraced' }), mk('b', { turnId: 't2' })]) === 2);

const [warehouse] = grp.groupSignals([mk('Orders shipped last week by warehouse?'), mk('Which warehouse shipped most orders last week?')]);
ok('a new words group joins the existing issue whose words overlap', grp.matchIssue(warehouse, [{ id: 'i1', key: 'words:last+orders+warehouse', tokens: ['last', 'orders', 'warehouse'] }, { id: 'i2', key: 'name:x', tokens: [] }]) === 'i1' || grp.matchIssue(warehouse, [{ id: 'i1', key: 'words:orders+shipped+warehouse', tokens: ['orders', 'shipped', 'warehouse'] }]) === 'i1', warehouse.key);
ok('the same key joins; a keyed group never joins by words', grp.matchIssue({ key: 'name:x', words: [], signals: [] }, [{ id: 'i3', key: 'name:x', tokens: [] }]) === 'i3' && grp.matchIssue({ key: 'name:y', words: [], signals: [] }, [{ id: 'i3', key: 'name:x', tokens: [] }]) === null);
ok('NEGATIVE CONTROL: words that do not overlap do not join', grp.matchIssue(warehouse, [{ id: 'i4', key: 'words:department+employees+headcount', tokens: ['department', 'employees', 'headcount'] }]) === null);

// meaning: injected unit vectors
const v = new Map<string, number[]>([['Headcount?', [1, 0]], ['People on payroll?', [0.99, 0.141]], ['Cats?', [0, 1]]]);
const meaning = grp.bySimilarMeaning(v, 0.9);
g = grp.groupSignals([mk('Headcount?'), mk('People on payroll?'), mk('Cats?')], meaning);
ok('by meaning: two phrasings with no word in common are one group, the unrelated one is not', g.length === 2 && g.some((x) => x.signals.length === 2));
ok('NEGATIVE CONTROL: the same questions by words alone stay three', grp.groupSignals([mk('Headcount?'), mk('People on payroll?'), mk('Cats?')]).length === 3);

finish();
