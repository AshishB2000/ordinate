// Knowledge documents: which passages answer a question (docs/knowledge-docs/00-design.md, "Passages and matching").
//   § 1 the pure ranking (src/knowledge/rank.ts): the scores, the cut-off, the tie order, the budget
//   § 2 Postgres-narrowed = pure: with DATABASE_URL, the passages `words && $1` returns, ranked, equal the pure ranking
//       over every passage (Object.is)  [added with the store, phase 2]
// NEGATIVE CONTROLS: a score of 0 is never shown; without the cut-off weak passages come along; a wrong tie order is caught.
//
//   npm run build:ts && node scripts/test-knowledgeRank.js

export {};
import { ok, finish } from './selfcheck';
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
const odd = R.rankPassages('alpha beta gamma', [passage({ docId: 'x', title: 'alpha', text: 'beta gamma delta' }), passage({ docId: 'y', text: 'alpha epsilon' })]);
ok('half is rounded up (top 4 keeps 2, drops 1)', odd.length === 1 || odd.every((r) => r.score >= Math.ceil(odd[0].score / 2)));

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
finish();
