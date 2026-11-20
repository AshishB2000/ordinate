// Knowledge documents: text into passages (docs/knowledge-docs/00-design.md, "Passages and matching").
//   headings carried onto every passage under them; the 800 cap; sentence cuts, a hard cut only without a sentence end;
//   merging small paragraphs; determinism; nothing lost.
// NEGATIVE CONTROL: a split without the cap would leave an over-long paragraph whole.
//
//   npm run build:ts && node scripts/test-knowledgeSplit.js

export {};
import { ok, finish } from './selfcheck';
const { splitText } = require('../src/knowledge/split') as typeof import('../src/knowledge/split');
const { MAX_PASSAGE_CHARS } = require('../src/knowledge/limits') as typeof import('../src/knowledge/limits');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

// Headings carry down; a sibling replaces; a shallower heading drops the deeper ones.
const doc = ['Intro line.', '', '# Revenue', 'Net of discounts.', '', '## Refunds', 'Paid out later.', '', '## Chargebacks', 'Bank takes it.', '', '# Fiscal', 'Starts in February.'].join('\n');
const p = splitText(doc);
ok('passages and their heading paths', JSON.stringify(p.map((x) => [x.heading, x.text])) === JSON.stringify([
  ['', 'Intro line.'], ['Revenue', 'Net of discounts.'], ['Revenue › Refunds', 'Paid out later.'], ['Revenue › Chargebacks', 'Bank takes it.'], ['Fiscal', 'Starts in February.'],
]), JSON.stringify(p));
ok('ord counts up from 0', p.every((x, i) => x.ord === i));
ok('a heading with no body makes no passage', splitText('# A\n# B\ntext').length === 1 && splitText('# A\n# B\ntext')[0].heading === 'B');
ok('a skipped level leaves no invented title', splitText('### Deep\ntext')[0].heading === 'Deep');

// Merging small paragraphs up to the cap, never across a heading.
const small = Array.from({ length: 30 }, (_, i) => `Paragraph number ${i} says something short.`).join('\n\n');
const merged = splitText(small);
ok('small paragraphs merge', merged.length > 1 && merged.length < 30 && merged.every((x) => x.text.length <= MAX_PASSAGE_CHARS), String(merged.length));
ok('a passage is one line', merged.every((x) => !/\s{2}|\n/.test(x.text)));
ok('nothing is lost in merging', merged.map((x) => x.text).join(' ') === Array.from({ length: 30 }, (_, i) => `Paragraph number ${i} says something short.`).join(' '));

// An oversized paragraph is cut at a sentence end.
const sentence = 'This sentence has some words in it. ';
const big = sentence.repeat(60).trim();
const cut = splitText(big);
ok('an oversized paragraph is cut', cut.length >= 3 && cut.every((x) => x.text.length <= MAX_PASSAGE_CHARS));
ok('every cut ends at a sentence end', cut.every((x) => x.text.endsWith('in it.')), JSON.stringify(cut.map((x) => x.text.slice(-12))));
ok('and starts at a sentence start', cut.every((x) => x.text.startsWith('This sentence')));
// No sentence end: a hard cut, never inside a surrogate pair.
const blob = '😀'.repeat(900);
const hard = splitText(blob);
ok('a hard cut when there is no sentence end', hard.length >= 2 && hard.every((x) => x.text.length <= MAX_PASSAGE_CHARS) && hard.map((x) => x.text).join('') === blob);
ok('the hard cut never splits a surrogate pair', hard.every((x) => !/[\ud800-\udbff]$/.test(x.text) && !/^[\udc00-\udfff]/.test(x.text)));

// Deterministic, on a real document too.
const policy = fs.readFileSync(path.join(__dirname, 'fixtures', 'knowledge', 'metrics-policy.md'), 'utf8');
ok('the same text always gives the same passages', JSON.stringify(splitText(policy)) === JSON.stringify(splitText(policy)));
const real = splitText(policy);
ok('the policy fixture splits under the cap, with headings', real.length >= 20 && real.every((x) => x.text.length <= MAX_PASSAGE_CHARS) && real.some((x) => x.heading === 'Metrics policy › Revenue › Gross and net revenue'), String(real.length));
ok('CRLF reads as LF', JSON.stringify(splitText(doc.replace(/\n/g, '\r\n'))) === JSON.stringify(p));
ok('empty text has no passages', splitText('  \n\n ').length === 0);

// NEGATIVE CONTROL: with a cap as large as the text, the big paragraph stays whole, so the cap is what cut it above.
ok('NEGATIVE CONTROL: without the cap one passage holds it all', splitText(big, 100_000).length === 1);
finish();
