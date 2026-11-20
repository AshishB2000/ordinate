// Knowledge documents: does it find the right passage? (docs/knowledge-docs/00-design.md, "Tests".)
// A realistic fixture: a metrics policy of about 8,000 characters with headings (scripts/fixtures/knowledge/metrics-policy.md)
// and one unrelated document (office-handbook.md). Each question is in plain words and names the heading it needs; that
// passage must be in the kept set, and the unrelated document must never appear.
// NEGATIVE CONTROL: a question about something no document covers keeps nothing.
//
//   npm run build:ts && node scripts/test-knowledgeRetrieval.js

export {};
import { ok, finish } from './selfcheck';
const { splitText } = require('../src/knowledge/split') as typeof import('../src/knowledge/split');
const R = require('../src/knowledge/rank') as typeof import('../src/knowledge/rank');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const read = (f: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', 'knowledge', f), 'utf8');
function load(docId: string, title: string, file: string): import('../src/knowledge/rank').RankPassage[] {
  return splitText(read(file)).map((p) => ({ docId, ord: p.ord, own: false, updatedAt: '2026-01-01T00:00:00.000Z', title, heading: p.heading, text: p.text, ...pick(R.passageWords(title, p.heading, p.text)) }));
}
const pick = (w: ReturnType<typeof R.passageWords>) => ({ titleWords: w.titleWords, headingWords: w.headingWords, textWords: w.textWords });
const all = [...load('policy', 'Metrics policy', 'metrics-policy.md'), ...load('handbook', 'Office handbook', 'office-handbook.md')];
ok('the policy is about 8,000 characters', Math.abs(read('metrics-policy.md').length - 8000) < 600, String(read('metrics-policy.md').length));

// [question, the heading (end of its path) whose passage it needs]
const CASES: [string, string][] = [
  ['How do we count refunds?', 'How a refund is counted'],
  ['Who counts as an active customer?', 'The definition'],
  ['When does the fiscal year start?', 'Fiscal year and quarters'],
  ['Which region does an order belong to, shipping or billing country?', 'How regions are assigned'],
  ['What is customer churn?', 'Customer churn'],
  ['Which exchange rate do we use to convert currency?', 'Currency'],
  ['How is the discount rate calculated?', 'Discount rate'],
  ['When is subscription revenue recognised?', 'What counts as revenue'],
  ['What day does a week start on?', 'Weeks'],
  ['How fresh is the data, when does the nightly load run?', 'Data freshness'],
  ['How is average order value computed?', 'Orders and units'],
  ['What is our return rate?', 'Returns and exchanges'],
];
let found = 0;
for (const [question, heading] of CASES) {
  const kept = R.rankPassages(question, all);
  const hit = kept.findIndex((p) => p.docId === 'policy' && p.heading.split(' › ').pop() === heading);
  if (hit >= 0) found++;
  ok(`"${question}" finds "${heading}"`, hit >= 0, JSON.stringify(kept.map((p) => [p.docId, p.heading, p.score])));
  ok(`"${question}" never shows the unrelated document`, !kept.some((p) => p.docId === 'handbook'), JSON.stringify(kept.map((p) => [p.docId, p.heading, p.score])));
}
console.log(`retrieval: ${found}/${CASES.length} questions found their passage`);
ok('NEGATIVE CONTROL: a question no document covers keeps nothing', R.rankPassages('What is the airspeed velocity of a swallow?', all).length === 0);
ok('the handbook IS found by its own questions (the filter is not just empty)', R.rankPassages('Where do visitors park?', all).some((p) => p.docId === 'handbook'));
finish();
