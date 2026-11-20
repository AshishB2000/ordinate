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

  // A question of more than 64 words: both sides use the same first 64 (a long question never loses its passages).
  const filler = Array.from({ length: 80 }, (_, i) => `filler${i}x`).join(' ');
  const longQ = `${filler} refunds`; // the telling word is the 81st
  ok('(setup) the helper cuts at 64 words and "refund" is past them', R.questionWords(longQ).length === 64 && !R.questionWords(longQ).includes('refund'));
  const earlyQ = `refunds ${filler}`; // the telling word is first, so it stays in the 64
  const viaPgLong = R.rankPassages(earlyQ, await b.run(BOSS, () => store.candidates(P, agent, earlyQ)));
  const pureLong = R.rankPassages(earlyQ, await b.run(BOSS, () => store.allPassages(P, agent)));
  ok('a >64-word question: Postgres-narrowed = pure, and the early telling word still finds its passages', same(viaPgLong, pureLong) && viaPgLong.length > 0, JSON.stringify(viaPgLong.map((r) => r.heading)));
  const lateSql = await b.run(BOSS, () => store.candidates(P, agent, longQ));
  ok('a >64-word question whose telling word is past 64: neither side scores it (no passage is lost to a mismatch)', same(R.rankPassages(longQ, lateSql), R.rankPassages(longQ, await b.run(BOSS, () => store.allPassages(P, agent)))));

  // More candidates than the old 5,000-row limit: the best passage is in the document with the LAST doc id.
  const P5: string = await b.run(BOSS, async () => (await projects.createProject('Many')).id);
  await b.pool.query(`INSERT INTO knowledge_docs (org_id, project_id, id, title, source, chars, text, text_hash, created_by, updated_by)
    SELECT 'acme', $1, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Plain ' || g, 'typed', 1, 'x', 'h', 'u', 'u' FROM generate_series(1, 55) g`, [P5]);
  await b.pool.query(`INSERT INTO knowledge_passages (org_id, project_id, doc_id, ord, title_words, heading_words, text_words, heading, text, words)
    SELECT 'acme', $1, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, o, '{plain}', '{}', '{zebra}', '', 'zebra stripes', '{plain,zebra}' FROM generate_series(1, 55) g, generate_series(0, 99) o`, [P5]);
  await b.pool.query(`UPDATE knowledge_passages SET heading_words = '{zebra}', text_words = '{zebra,stripe}', heading = 'Zebra', text = 'the best passage', words = '{plain,zebra,stripe}' WHERE project_id = $1 AND doc_id = '00000000-0000-4000-8000-000000000055' AND ord = 99`, [P5]);
  const many = await b.run(BOSS, () => store.allPassages(P5, null));
  ok('(setup) 5,500 candidate passages, more than the old 5,000 limit', many.length === 5500);
  const manyPg = R.rankPassages('zebra stripes', await b.run(BOSS, () => store.candidates(P5, null, 'zebra stripes')));
  ok('the best passage is found though it sits past the old limit; Postgres = pure', manyPg[0]?.docId.endsWith('000000000055') === true && manyPg[0].ord === 99 && same(manyPg, R.rankPassages('zebra stripes', many)), JSON.stringify(manyPg.map((r) => [r.docId.slice(-2), r.ord, r.score])));
  const t0 = Date.now();
  await b.run(BOSS, () => store.candidates(P5, null, 'zebra stripes'));
  console.log(`candidates over 5,500 passages: ${Date.now() - t0} ms`);

  // Ties that exercise every tie key: own agent, newer document, doc id (by code unit), ord.
  const P6: string = await b.run(BOSS, async () => (await projects.createProject('Ties')).id);
  const ag = randomUUID();
  const ids = ['b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-00000000000a'];
  for (const [i, id] of ids.entries()) {
    await b.pool.query(`INSERT INTO knowledge_docs (org_id, project_id, id, agent_id, title, source, chars, text, text_hash, created_by, updated_by, updated_at)
      VALUES ('acme', $1, $2, $3, 'Tie', 'typed', 1, 'x', 'h', 'u', 'u', $4::timestamptz)`, [P6, id, i === 3 ? ag : null, i < 2 ? '2026-01-01T00:00:00.000001Z' : i === 4 ? '2026-01-01T00:00:00.000002Z' : '2026-01-01T00:00:00Z']);
    for (const ord of [1, 0]) await b.pool.query(`INSERT INTO knowledge_passages (org_id, project_id, doc_id, agent_id, ord, title_words, heading_words, text_words, heading, text, words)
      VALUES ('acme', $1, $2, $3, $4, '{tie}', '{}', '{shared}', '', 'shared text', '{tie,shared}')`, [P6, id, i === 3 ? ag : null, ord]);
  }
  const tiesPg = R.rankPassages('shared', await b.run(BOSS, () => store.candidates(P6, ag, 'shared')));
  const tiesPure = R.rankPassages('shared', await b.run(BOSS, () => store.allPassages(P6, ag)));
  ok('ties on own agent, microsecond updated_at, uuid and ord: Postgres order = pure order', same(tiesPg, tiesPure) && tiesPg.length === 6, tiesPg.map((r) => `${r.docId.slice(0, 2)}${r.ord}${r.own ? '*' : ''}`).join());
  ok('…the agent\'s document first, then the later timestamps, then by code unit', tiesPg.map((r) => `${r.docId[0]}${r.ord}`).join() === 'f0,f1,c0,c1,a0,a1', tiesPg.map((r) => `${r.docId[0]}${r.ord}`).join());
}).catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
