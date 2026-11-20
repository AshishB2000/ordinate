// Knowledge documents: which passages answer a question (docs/knowledge-docs/00-design.md, "Passages and matching").
//   § 1 the pure ranking (src/knowledge/rank.ts): the scores, the cut-off, the tie order, the budget
//   § 2 Postgres-narrowed = pure: with DATABASE_URL, the passages `words && $1` returns, ranked, equal the pure ranking
//       over EVERY passage (Object.is, field by field), for the project's documents and an agent's
// NEGATIVE CONTROLS: a score of 0 is never shown; without the cut-off weak passages come along; a wrong tie order is caught;
// the narrowing really does drop passages (so the equality is not vacuous); a narrowing that dropped a scoring one would differ.
//
//   npm run build:ts && node scripts/test-knowledgeRank.js

export {};
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { BOSS, withServer } from './notifyHarness';
const R = require('../src/knowledge/rank') as typeof import('../src/knowledge/rank');
type P = import('../src/knowledge/rank').RankPassage;

function passage(o: Partial<P> & { text: string }): P {
  const title = o.title ?? 'Doc';
  const heading = o.heading ?? '';
  const w = R.passageWords(title, heading, o.text);
  return { docId: 'd1', ord: 0, own: false, updatedAt: '2026-01-01T00:00:00.000Z', title, heading, titleWords: w.titleWords, headingWords: w.headingWords, textWords: w.textWords, ...o };
}

// Weights: 2 title, 2 heading, 1 text, per distinct question word.
const p1 = passage({ title: 'Revenue policy', heading: 'Refunds', text: 'A refund reduces revenue when paid.' });
// question words: refund, counted, revenue ("how", "are", "in" dropped or short). title has revenue, heading has refund, text has refund + revenue.
const score = R.scorePassage(['refund', 'revenue'], p1);
ok('refund: heading 2 + text 1; revenue: title 2 + text 1 = 6', score === 6, String(score));
ok('a repeated question word counts once', R.scorePassage(['refund', 'refund'], p1) === 3);
ok('a word nowhere scores 0', R.scorePassage(['zebra'], p1) === 0);
ok('a score of 0 is never shown', R.rankPassages('zebra giraffe', [p1]).length === 0);

// The cut-off: at least half the top score, rounded up.
const top = passage({ docId: 'a', title: 'Refund revenue', heading: 'Refund revenue', text: 'refund revenue counted' }); // 2+2+1 per word
const weak = passage({ docId: 'b', text: 'counted only' }); // 1
const mid = passage({ docId: 'c', heading: 'Revenue', text: 'something else' }); // 2
const ranked = R.rankPassages('refund revenue counted', [weak, mid, top]);
ok('the top passage is kept', ranked[0].docId === 'a');
ok('the cut-off drops passages under half the top score', !ranked.some((r) => r.docId === 'b'), JSON.stringify(ranked.map((r) => [r.docId, r.score])));
ok('NEGATIVE CONTROL: with a floor of 0, a weak passage would come along', R.scorePassage(['refund', 'revenue', 'counted'], weak) > 0);
// An ODD top score (5): half is 2.5, rounded UP to 3. A passage scoring 3 stays, one scoring 2 goes (a floor of 2 would keep it).
const oddQ = 'alpha beta gamma delta epsilon';
const oddTop = passage({ docId: 'x', title: 'alpha', text: 'beta gamma delta' }); // 2 + 1 + 1 + 1
const oddThree = passage({ docId: 'y', text: 'beta gamma delta' }); // 3
const oddTwo = passage({ docId: 'z', text: 'beta gamma' }); // 2
ok('(setup) the scores are 5, 3 and 2', [oddTop, oddThree, oddTwo].map((p) => R.scorePassage(R.passageWords('', '', oddQ).textWords, p)).join() === '5,3,2');
const odd = R.rankPassages(oddQ, [oddTop, oddThree, oddTwo]);
ok('half is rounded UP: top 5 keeps 3 and drops 2', odd.map((r) => r.docId).join() === 'x,y', odd.map((r) => `${r.docId}:${r.score}`).join());
ok('NEGATIVE CONTROL: a floor of 2 (rounded down) would have kept the 2', Math.floor(5 / 2) === 2 && R.scorePassage(R.passageWords('', '', oddQ).textWords, oddTwo) >= Math.floor(5 / 2));

// Tie order: own, newer, doc id, ord; strings by code unit.
const base = { text: 'revenue' };
const ties = R.rankPassages('revenue', [
  passage({ ...base, docId: 'b', ord: 1 }), passage({ ...base, docId: 'b', ord: 0 }), passage({ ...base, docId: 'a', ord: 0 }),
  passage({ ...base, docId: 'n', updatedAt: '2026-06-01T00:00:00.000Z' }), passage({ ...base, docId: 'z', own: true }),
]);
ok('ties: own first, then newer, then doc id, then ord', ties.map((r) => `${r.docId}${r.ord}`).join(',') === 'z0,n0,a0,b0,b1', ties.map((r) => `${r.docId}${r.ord}`).join(','));
ok('code unit order: "B" sorts before "a"', R.rankPassages('revenue', [passage({ ...base, docId: 'a' }), passage({ ...base, docId: 'B' })]).map((r) => r.docId).join('') === 'Ba');
const rev = R.rankPassages('revenue', [passage({ ...base, docId: 'a', own: true }), passage({ ...base, docId: 'b' })]);
ok('NEGATIVE CONTROL: the project\'s passage is not first when the agent\'s ties', rev[0].docId === 'a' && rev[1].docId === 'b');

// The budget: 6 passages, 4,000 characters, in rank order.
const many = Array.from({ length: 10 }, (_, i) => passage({ docId: `d${i}`, text: 'revenue' }));
ok('at most 6 passages', R.rankPassages('revenue', many).length === 6);
const long = Array.from({ length: 10 }, (_, i) => passage({ docId: `d${i}`, text: 'revenue ' + 'x'.repeat(790) }));
const fit = R.rankPassages('revenue', long);
ok('at most 4,000 characters together', fit.length === 5 && fit.reduce((n, r) => n + r.text.length, 0) <= 4000, String(fit.length));
ok('NEGATIVE CONTROL: without the budget all ten would show', R.rankPassages('revenue', long, 100, 1e9).length === 10);

// Same input, same output; the input is untouched.
const input = [weak, mid, top];
const a = JSON.stringify(R.rankPassages('refund revenue counted', input));
ok('deterministic, input untouched', a === JSON.stringify(R.rankPassages('refund revenue counted', [...input].reverse())) && input[0] === weak);

// § 2 Postgres-narrowed = pure.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const store: typeof import('../src/knowledge/store') = require('../src/knowledge/store');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');

const same = (a: readonly import('../src/knowledge/rank').Ranked[], b: readonly import('../src/knowledge/rank').Ranked[]): boolean =>
  a.length === b.length && a.every((x, i) => (Object.keys(x) as (keyof typeof x)[]).every((k) => (Array.isArray(x[k]) ? JSON.stringify(x[k]) === JSON.stringify(b[i][k]) : Object.is(x[k], b[i][k]))) && Object.keys(x).length === Object.keys(b[i]).length);
const QUESTIONS = [
  'How do we count refunds?', 'Who counts as an active customer?', 'When does the fiscal year start?', 'revenue', 'policy', 'the', 'What is customer churn and how is it measured by region?',
  'Where do visitors park?', 'What is the airspeed velocity of a swallow?', 'discount rate currency exchange rate revenue refunds churn', 'subscription revenue recognised monthly',
];

withServer('knowledge-rank', {}, async (b) => {
  const fx = (f: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', 'knowledge', f), 'utf8');
  const P: string = await b.run(BOSS, async () => (await projects.createProject('Rank')).id);
  const agent = randomUUID();
  const mk = (title: string, text: string, a: string | null) => b.run(BOSS, () => store.createDoc(P, a, { title, text }, randomUUID(), 'boss@acme.test'));
  await mk('Metrics policy', fx('metrics-policy.md'), null);
  await mk('Office handbook', fx('office-handbook.md'), null);
  await mk('Metrics policy (finance copy)', fx('metrics-policy.md'), agent); // the same passages under the agent: ties go to its own
  let dropped = 0;
  let totalKept = 0;
  for (const question of QUESTIONS) {
    const narrowed = await b.run(BOSS, () => store.candidates(P, agent, question));
    const everything = await b.run(BOSS, () => store.allPassages(P, agent));
    dropped += everything.length - narrowed.length;
    const viaPg = R.rankPassages(question, narrowed);
    const pure = R.rankPassages(question, everything);
    totalKept += pure.length;
    ok(`"${question}": the Postgres-narrowed ranking equals the pure ranking over every passage (Object.is)`, same(viaPg, pure), JSON.stringify([viaPg.map((r) => [r.docId, r.ord, r.score]), pure.map((r) => [r.docId, r.ord, r.score])]));
  }
  ok('the narrowing really drops passages (the equality is not vacuous)', dropped > 0 && totalKept > 0, `${dropped} dropped, ${totalKept} kept`);
  const own = R.rankPassages('How do we count refunds?', await b.run(BOSS, () => store.allPassages(P, agent)));
  ok('the agent\'s copy of a passage comes before the project\'s identical one', own.length > 1 && own[0].own === true && own.some((r) => !r.own && r.text === own[0].text && own.indexOf(r) > 0) && own.every((r, i) => !r.own || own.slice(0, i).every((q) => q.score > r.score || q.own || q.score === r.score)));
  const others = R.rankPassages('How do we count refunds?', await b.run(BOSS, () => store.allPassages(P, randomUUID())));
  ok('another agent never sees that agent\'s passages', others.length > 0 && others.every((r) => !r.own));
  // NEGATIVE CONTROL: a narrowing that dropped a scoring passage would differ from the pure ranking.
  const everything = await b.run(BOSS, () => store.allPassages(P, agent));
  const crippled = everything.filter((p) => !(p.heading.endsWith('How a refund is counted') && p.own));
  ok('NEGATIVE CONTROL: a narrowing that lost a scoring passage is caught by the comparison', !same(R.rankPassages('How do we count refunds?', crippled), R.rankPassages('How do we count refunds?', everything)));
}).catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
