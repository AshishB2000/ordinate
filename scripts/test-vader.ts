// The VADER port (src/analysis/text/vader.ts) against the REFERENCE
// implementation's published examples — every figure asserted with Object.is.
//
// Three fixtures:
//   1. README — the example sentences and scores printed in vaderSentiment's
//      README.rst, copied verbatim (the emoji example is skipped: the port does
//      not translate emoji, see vader.ts). ONE row differs from the README by
//      design: "At least it isn't a horrible book." prints pos 0.363 / neu 0.637
//      there, a figure from a release before 3.3, which dropped one-character
//      tokens ("a") before scoring. 3.3.x keeps them, so the neutral count is one
//      higher; the compound (0.431) is the same in both and is asserted against
//      the README, the proportions against the 3.3 code (below).
//   2. The reference's own demo list — the "tricky sentences" and the paragraph
//      and tag examples in vaderSentiment.py's __main__.
//   3. Review-style sentences that exercise every rule the port carries (but,
//      least, never so, idioms, kind of, ALL CAPS, ! and ?).
// Fixtures 2 and 3 were produced by running the reference Python module
// (vaderSentiment.py on master, the 3.3 line, with the bundled lexicon) over
// these exact strings; rounding is the reference's own round(x, 4) / round(x, 3).
//
//   npm run build:ts && node scripts/test-vader.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { polarityScores, compoundScore, vaderVersion } from '../src/analysis/text/vader';

type Row = [string, number, number, number, number]; // text, compound, pos, neu, neg

// ── 1. The README (vaderSentiment/README.rst, "Demo, including example of non-English text") ──
const README: Row[] = [
  ['VADER is smart, handsome, and funny.', 0.8316, 0.746, 0.254, 0.0],
  ['VADER is smart, handsome, and funny!', 0.8439, 0.752, 0.248, 0.0],
  ['VADER is very smart, handsome, and funny.', 0.8545, 0.701, 0.299, 0.0],
  ['VADER is VERY SMART, handsome, and FUNNY.', 0.9227, 0.754, 0.246, 0.0],
  ['VADER is VERY SMART, handsome, and FUNNY!!!', 0.9342, 0.767, 0.233, 0.0],
  ['VADER is VERY SMART, uber handsome, and FRIGGIN FUNNY!!!', 0.9469, 0.706, 0.294, 0.0],
  ['VADER is not smart, handsome, nor funny.', -0.7424, 0.0, 0.354, 0.646],
  ['The book was good.', 0.4404, 0.492, 0.508, 0.0],
  ['The book was only kind of good.', 0.3832, 0.303, 0.697, 0.0],
  ['The plot was good, but the characters are uncompelling and the dialog is not great.', -0.7042, 0.094, 0.579, 0.327],
  ['Today SUX!', -0.5461, 0.0, 0.221, 0.779],
  ["Today only kinda sux! But I'll get by, lol", 0.5249, 0.317, 0.556, 0.127],
  ['Make sure you :) or :D today!', 0.8633, 0.706, 0.294, 0.0],
  ['Not bad at all', 0.431, 0.487, 0.513, 0.0],
];

// ── 2 and 3. The reference's demo lists, and review-style sentences ──
const REFERENCE: Row[] = [
  ['Sentiment analysis has never been good.', -0.3412, 0.0, 0.675, 0.325],
  ['Sentiment analysis has never been this good!', 0.5672, 0.379, 0.621, 0.0],
  ['Most automated sentiment analysis tools are shit.', -0.5574, 0.0, 0.625, 0.375],
  ['With VADER, sentiment analysis is the shit!', 0.6476, 0.417, 0.583, 0.0],
  ['Other sentiment analysis tools can be quite bad.', -0.5849, 0.0, 0.649, 0.351],
  ['On the other hand, VADER is quite bad ass', 0.802, 0.577, 0.423, 0.0],
  ['VADER is such a badass!', 0.4003, 0.402, 0.598, 0.0],
  ['Without a doubt, excellent idea.', 0.7013, 0.659, 0.341, 0.0],
  ['Roger Dodger is one of the most compelling variations on this theme.', 0.2944, 0.166, 0.834, 0.0],
  ['Roger Dodger is at least compelling as a variation on the theme.', 0.2263, 0.147, 0.853, 0.0],
  ['Roger Dodger is one of the least compelling variations on this theme.', -0.1695, 0.0, 0.868, 0.132],
  ['Not such a badass after all.', -0.2584, 0.0, 0.711, 0.289],
  ['Without a doubt, an excellent idea.', 0.7013, 0.592, 0.408, 0.0],
  ["It was one of the worst movies I've seen, despite good reviews.", -0.7584, 0.0, 0.606, 0.394],
  ['Unbelievably bad acting!!', -0.6572, 0.0, 0.314, 0.686],
  ['Poor direction.', -0.4767, 0.0, 0.244, 0.756],
  ['VERY poor production.', -0.6281, 0.0, 0.326, 0.674],
  ['The movie was bad.', -0.5423, 0.0, 0.462, 0.538],
  ['Very bad movie.', -0.5849, 0.0, 0.345, 0.655],
  ['VERY BAD movie!', -0.7616, 0.0, 0.265, 0.735],
  ['balloons', 0.0, 0.0, 1.0, 0.0],
  ['happy birthday', 0.5719, 0.787, 0.213, 0.0],
  ['tear gas', 0.0, 0.0, 1.0, 0.0],
  ['The food was great but the service was terrible and slow.', -0.3818, 0.162, 0.573, 0.264],
  ['Great product, but not great packaging, but still good.', 0.2404, 0.38, 0.356, 0.264],
  ['good good but bad bad', -0.8225, 0.271, 0.069, 0.66],
  ["I don't like it. It isn't good, it's not bad either.", -0.1695, 0.185, 0.521, 0.294],
  ['No problem at all, no worries!!', 0.6339, 0.564, 0.436, 0.0],
  ['There is no love or hope here.', -0.6979, 0.0, 0.464, 0.536],
  ['This is kind of awesome?? Really??? Why????', 0.6972, 0.443, 0.557, 0.0],
  ['The delivery was late and the box was damaged :(', -0.7003, 0.0, 0.58, 0.42],
  ['Absolutely LOVED it!!! Best purchase ever :)', 0.9356, 0.768, 0.232, 0.0],
  ["Meh. It's okay I guess, nothing special.", -0.1675, 0.201, 0.423, 0.376],
  ['The staff were friendly and helpful; would recommend.', 0.8176, 0.63, 0.37, 0.0],
  ['Refund took three weeks, terrible customer support.', -0.1027, 0.25, 0.463, 0.287],
  ['Price is fair, quality is decent, shipping was fast.', 0.3182, 0.223, 0.777, 0.0],
  ['NOT GOOD. NOT GOOD AT ALL.', -0.094, 0.242, 0.474, 0.285],
  ['I never so loved a movie', 0.7899, 0.545, 0.455, 0.0],
  ['it was the bomb', 0.6124, 0.571, 0.429, 0.0],
  ['yeah right, like that will work', 0.5719, 0.54, 0.46, 0.0],
  ['a kiss of death for the project', 0.0772, 0.272, 0.485, 0.243],
  ['cake to die for', -0.5994, 0.0, 0.435, 0.565],
  ['she has a broken heart', -0.8316, 0.0, 0.278, 0.722],
  ['Hardly worth the money, barely works.', 0.1548, 0.243, 0.757, 0.0],
  ['The app crashes constantly and support never replies', 0.4019, 0.278, 0.722, 0.0],
  ['Amazing value!! Highly recommended to everyone.', 0.835, 0.747, 0.253, 0.0],
];

function same(label: string, text: string, want: Row): void {
  const got = polarityScores(text);
  const pass = Object.is(got.compound, want[1]) && Object.is(got.pos, want[2]) && Object.is(got.neu, want[3]) && Object.is(got.neg, want[4]);
  ok(`${label}: ${text}`, pass, `want ${JSON.stringify(want.slice(1))} got ${JSON.stringify([got.compound, got.pos, got.neu, got.neg])}`);
}

ok('the bundled lexicon is vaderSentiment 3.3.2', vaderVersion() === 'vaderSentiment 3.3.2', vaderVersion());
for (const r of README) same('README', r[0], r);

// The one pre-3.3 README row: compound as printed, proportions as 3.3 computes them.
{
  const got = polarityScores("At least it isn't a horrible book.");
  ok('README: "At least it isn\'t a horrible book." compound 0.431 as printed', Object.is(got.compound, 0.431), String(got.compound));
  ok('…pos/neu are the 3.3 figures (0.322/0.678), not the pre-3.3 README ones (0.363/0.637)',
    Object.is(got.pos, 0.322) && Object.is(got.neu, 0.678) && Object.is(got.neg, 0), JSON.stringify(got));
}

for (const r of REFERENCE) same('reference', r[0], r);

// ── Edges the column relies on ──
ok('empty text scores 0 on every axis', JSON.stringify(polarityScores('')) === JSON.stringify({ neg: 0, neu: 0, pos: 0, compound: 0 }));
ok('whitespace only scores 0', compoundScore(' \t\n ') === 0);
ok('a word the lexicon lacks is neutral, not an error', compoundScore('zzqx') === 0);
// "constructor" / "__proto__" must be words, not Object.prototype members.
ok('an Object.prototype name is just a word', compoundScore('constructor __proto__ toString') === 0);
ok('curly vs straight quote: the reference splits on whitespace only, so both parse',
  typeof compoundScore('don’t like it') === 'number');
ok('deterministic: the same text, the same score', compoundScore('Great value, slow delivery!') === compoundScore('Great value, slow delivery!'));

finish();
