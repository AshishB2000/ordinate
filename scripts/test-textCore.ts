// The text core and the three text steps: tokenisation (punctuation, Unicode,
// contractions, French elisions, numbers), stop words and the language guess,
// n-gram counts, TF-IDF on a hand-computable fixture, keyword-rule precedence
// and match modes, the steps in the real transforms fold, their whitelist, the
// SQL paths falling back to the fold, and the warm runner a job leaves behind.
//
//   npm run build:ts && node scripts/test-textCore.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { tokenize, tokenizeSegments, charLength } from '../src/analysis/text/tokenize';
import { stopwords, detectLanguage } from '../src/analysis/text/stopwords';
import { documentTerms, addCounts, ngrams, topTerms } from '../src/analysis/text/ngrams';
import { documentFrequency, tfidfScores } from '../src/analysis/text/tfidf';
import { compileRules, categorize } from '../src/analysis/text/keywordRules';
import type { KeywordRule } from '../src/analysis/text/keywordRules';
import { applyPipeline, sanitizeSteps } from '../src/data/transforms';
import type { Cell, TableData, TransformStep } from '../src/data/transforms';
import { checkTextStep } from '../src/data/textStepTypes';
import { generateSql } from '../src/engine/sqlGen';
import { runOnDuckDb, runResidentPipeline } from '../src/engine/pipelineDuck';

// ponytail: the compiled siblings, patched in place to count calls (the fold reads them at call time).
const vaderMod = require('../src/analysis/text/vader');
const stepsText = require('../src/data/stepsText');

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── Tokenisation ─────────────────────────────────────────────────────────────
{
  const t = tokenize("Hello, world! It's 3.5 stars — don't miss it.");
  ok('punctuation separates, contractions stay whole, numbers drop', same(t, ['hello', 'world', "it's", 'stars', "don't", 'miss', 'it']), JSON.stringify(t));
  const k = tokenize("It's 3.5 stars", { keepNumbers: true });
  ok('keepNumbers keeps digit runs ("3.5" is two numbers)', same(k, ["it's", '3', '5', 'stars']), JSON.stringify(k));
  ok('curly apostrophes are straightened: don’t = don\'t', same(tokenize('Don’t STOP'), ["don't", 'stop']));
  ok('NFC: a decomposed é is the precomposed one', same(tokenize('Café naïve'), ['café', 'naïve']), JSON.stringify(tokenize('Café')));
  ok('Unicode letters and lower-casing: Straße ÜBER Ελλάδα', same(tokenize('Straße ÜBER Ελλάδα'), ['straße', 'über', 'ελλάδα']));
  ok('emoji and symbols separate and vanish', same(tokenize('great👍value #1 $$ 100%'), ['great', 'value']));
  ok('hyphens separate: state-of-the-art is four', same(tokenize('state-of-the-art'), ['state', 'of', 'the', 'art']));
  ok('mixed tokens are words: mp3, 2nd', same(tokenize('mp3 player, 2nd try'), ['mp3', 'player', '2nd', 'try']));
  ok('French elisions split under lang fr', same(tokenize("L'homme qu'il aime", { lang: 'fr' }), ['l', 'homme', 'qu', 'il', 'aime']));
  ok('…and stay whole elsewhere', same(tokenize("L'homme qu'il aime"), ["l'homme", "qu'il", 'aime']));
  ok('a leading or trailing apostrophe is not part of the word', same(tokenize("'tis the students' best"), ['tis', 'the', 'students', 'best']));
  ok('segments cut at sentence punctuation', same(tokenizeSegments('Great food. Service slow!\nOk'), [['great', 'food'], ['service', 'slow'], ['ok']]));
  ok('empty and non-text input give nothing', tokenize('').length === 0 && tokenize('  ...  ').length === 0);
  ok('charLength counts characters, not UTF-16 units', charLength('a😀b') === 3 && charLength('') === 0);
}

// ── Stop words and the language guess ───────────────────────────────────────
{
  ok('the four bundled lists load', ['en', 'es', 'fr', 'de'].every((l) => stopwords(l as any).size > 100),
    ['en', 'es', 'fr', 'de'].map((l) => stopwords(l as any).size).join(','));
  ok('English list carries contractions (don\'t) and "the"', stopwords('en').has("don't") && stopwords('en').has('the'));
  ok('French list carries the bare elided forms (l, qu)', stopwords('fr').has('l') && stopwords('fr').has('qu'));
  const g = (s: string) => detectLanguage([s]).lang;
  ok('detects English', g('The service was great and the staff were very friendly to us') === 'en');
  ok('detects Spanish', g('El servicio fue excelente y la comida estaba muy buena para todos') === 'es');
  ok('detects French', g('Le service était excellent et la nourriture était très bonne pour nous') === 'fr');
  ok('detects German', g('Der Service war ausgezeichnet und das Essen war sehr gut für uns') === 'de');
  ok('no stop words at all → English (the tie rule)', g('zzq xxv') === 'en');
}

// ── N-grams ──────────────────────────────────────────────────────────────────
{
  ok('ngrams of a token list', same(ngrams(['a', 'b', 'c'], 2), ['a b', 'b c']) && ngrams(['a'], 2).length === 0);
  const terms = documentTerms('The service was slow but the food was great', { lang: 'en', minN: 1, maxN: 2 });
  ok('n-grams are built after stop words are removed (the gap closes)',
    same(terms, ['service', 'slow', 'food', 'great', 'service slow', 'slow food', 'food great']), JSON.stringify(terms));
  const counts = new Map<string, number>();
  addCounts(counts, documentTerms('Great food. Great food! great FOOD', { lang: 'en', minN: 2, maxN: 2 }));
  ok('a bigram never spans a segment, and occurrences are counted', same([...counts], [['great food', 3]]), JSON.stringify([...counts]));
  const tri = documentTerms('slow cold late delivery', { lang: 'en', minN: 3, maxN: 3 });
  ok('trigrams', same(tri, ['slow cold late', 'cold late delivery']));
  const m = new Map<string, number>([['b', 2], ['a', 2], ['c', 5]]);
  ok('top terms: count descending, ties by the term', same(topTerms(m, 2), [['c', 5], ['a', 2]]));
}

// ── TF-IDF, by hand ──────────────────────────────────────────────────────────
// West: parking ×2, lot, great (total 4) · East: great, staff (2) · North: great, staff ×2, friendly (4).
// N = 3 groups; df: parking 1, lot 1, great 3, staff 2, friendly 1.
{
  const g = (pairs: Array<[string, number]>) => ({ counts: new Map(pairs), total: pairs.reduce((a, p) => a + p[1], 0) });
  const west = g([['parking', 2], ['lot', 1], ['great', 1]]);
  const east = g([['great', 1], ['staff', 1]]);
  const north = g([['great', 1], ['staff', 2], ['friendly', 1]]);
  const df = documentFrequency([west, east, north]);
  ok('document frequency counts groups, not occurrences', df.get('great') === 3 && df.get('staff') === 2 && df.get('parking') === 1);
  const w = tfidfScores(west, df, 3);
  ok('tfidf(parking, West) = 2/4 · ln 3', Object.is(w.get('parking'), (2 / 4) * Math.log(3)), String(w.get('parking')));
  ok('tfidf(lot, West) = 1/4 · ln 3', Object.is(w.get('lot'), (1 / 4) * Math.log(3)));
  ok('a term every group uses scores exactly 0', Object.is(w.get('great'), 0));
  const n = tfidfScores(north, df, 3);
  ok('tfidf(staff, North) = 2/4 · ln 1.5', Object.is(n.get('staff'), (2 / 4) * Math.log(3 / 2)));
}

// ── Keyword rules ────────────────────────────────────────────────────────────
{
  const rules: KeywordRule[] = [
    { pattern: 'refund', category: 'Billing', match: 'contains' },
    { pattern: 'late', category: 'Delivery', match: 'word' },
    { pattern: 'damag(ed|e)', category: 'Damage', match: 'regex' },
  ];
  const c = compileRules(rules);
  const tag = (s: string, cc = c) => categorize(s, cc, 'Other');
  ok('precedence: the FIRST matching rule wins', tag('I want a refund, it arrived late') === 'Billing');
  ok('…and order is the whole rule: reversed, Delivery wins', tag('I want a refund, it arrived late', compileRules([rules[1], rules[0]])) === 'Delivery');
  ok('contains matches inside words ("refunded")', tag('Refunded twice') === 'Billing');
  ok('word needs whole words: "chocolate" is not "late"', tag('chocolate was great') === 'Other');
  ok('…but contains would take it', categorize('chocolate', compileRules([{ pattern: 'late', category: 'X', match: 'contains' }]), null) === 'X');
  ok('word matches at punctuation and ends', tag('Arrived LATE.') === 'Delivery' && tag('late') === 'Delivery');
  ok('regex, case-insensitive by default', tag('Box DAMAGED in transit') === 'Damage');
  ok('caseSensitive holds', categorize('Box DAMAGED', compileRules([{ pattern: 'damaged', category: 'D', match: 'word', caseSensitive: true }]), 'no') === 'no');
  ok('curly and straight apostrophes match each other', categorize('I don’t like it', compileRules([{ pattern: "don't", category: 'Neg', match: 'word' }]), null) === 'Neg');
  ok('a multi-word pattern matches the phrase across any spacing',
    categorize('the late   delivery', compileRules([{ pattern: 'late delivery', category: 'D', match: 'word' }]), null) === 'D');
  ok('no match → the default', tag('all good') === 'Other');
  ok('a regex outside the safe subset is refused with a reason',
    typeof checkTextStep({ type: 'keyword_rules', column: 'r', rules: [{ pattern: '(?=x)', category: 'X', match: 'regex' }] }) === 'string');
  ok('a regex special character in a word rule is literal', categorize('price (usd)', compileRules([{ pattern: '(usd)', category: 'Cur', match: 'contains' }]), null) === 'Cur');
}

// ── The steps in the real fold ───────────────────────────────────────────────
const T = (name: string) => ({ name, type: 'text' as const });
const table = (): TableData => ({
  columns: [T('region'), T('review'), { name: 'n', type: 'number' }],
  rows: [
    ['West', 'Parking lot', 1], ['West', 'Parking great', 2], ['East', 'Great staff', 3],
    ['North', 'Great staff', 4], ['North', 'Staff friendly!', 5], ['East', '   ', 6], ['West', null, 7],
  ],
});
{
  const src = table();
  const before = JSON.stringify(src);
  const out = applyPipeline(src, sanitizeSteps([{ type: 'text_sentiment', column: 'review' }]));
  ok('sentiment: a number column named <col>_sentiment is appended',
    same(out.columns.map((c) => [c.name, c.type]), [['region', 'text'], ['review', 'text'], ['n', 'number'], ['review_sentiment', 'number']]));
  const col = out.rows.map((r) => r[3]);
  const want = src.rows.map((r) => (typeof r[1] === 'string' && r[1].trim() ? vaderMod.compoundScore(r[1]) : null));
  ok('sentiment: each value IS vader.compoundScore of its row (Object.is)', col.every((v, i) => Object.is(v, want[i])), JSON.stringify(col));
  ok('sentiment: empty text (whitespace, null) stays empty, not 0', col[5] === null && col[6] === null);
  ok('the source is never mutated', JSON.stringify(src) === before);
  const kept = sanitizeSteps([{ type: 'text_sentiment', column: 'review' }])[0] as any;
  ok('sanitize records the lexicon version on the step', kept.lexiconVersion === 'vaderSentiment 3.3.2', JSON.stringify(kept));
  const twice = applyPipeline(src, sanitizeSteps([{ type: 'text_sentiment', column: 'review' }, { type: 'text_sentiment', column: 'review' }]));
  ok('a second step writing the same column skips with a warning', twice.columns.length === 4 && twice.warnings.some((w) => /already exists/.test(w)), JSON.stringify(twice.warnings));
  const old = applyPipeline(src, sanitizeSteps([{ type: 'text_sentiment', column: 'review', lexiconVersion: 'vaderSentiment 3.0' }]));
  ok('a step made with another lexicon version says so', old.warnings.some((w) => /3\.0/.test(w)), JSON.stringify(old.warnings));
}
{
  const out = applyPipeline(table(), sanitizeSteps([{
    type: 'keyword_rules', column: 'review', as: 'topic', otherwise: 'Other',
    rules: [{ pattern: 'parking', category: 'Parking', match: 'word' }, { pattern: 'staff', category: 'People', match: 'word' }],
  }]));
  ok('keyword rules: a text column of categories, empty text takes the default',
    same(out.rows.map((r) => r[3]), ['Parking', 'Parking', 'People', 'People', 'People', 'Other', 'Other']) && out.columns[3].type === 'text',
    JSON.stringify(out.rows.map((r) => r[3])));
}
{
  const out = applyPipeline(table(), sanitizeSteps([{ type: 'text_terms', column: 'review', lang: 'en', minN: 1, maxN: 1, top: 3 }]));
  ok('terms: the table becomes term / words / count', same(out.columns.map((c) => c.name), ['term', 'words', 'count']));
  ok('terms: top 3 by count, ties by term', same(out.rows, [['great', 1, 3], ['staff', 1, 3], ['parking', 1, 2]]), JSON.stringify(out.rows));
  const by = applyPipeline(table(), sanitizeSteps([{ type: 'text_terms', column: 'review', lang: 'en', minN: 1, maxN: 1, top: 10, by: 'region', rank: 'tfidf' }]));
  ok('terms by region: region / term / words / count / tfidf', same(by.columns.map((c) => c.name), ['region', 'term', 'words', 'count', 'tfidf']));
  const west = by.rows.filter((r) => r[0] === 'West');
  ok('terms by region: the TF-IDF fixture — West ranks parking, lot, great',
    same(west.map((r) => r[1]), ['parking', 'lot', 'great'])
    && Object.is(west[0][4], (2 / 4) * Math.log(3)) && Object.is(west[2][4], 0), JSON.stringify(west));
  ok('terms by region: groups in first-seen order; an all-empty row adds no group',
    same([...new Set(by.rows.map((r) => r[0]))], ['West', 'East', 'North']));
  const senti = applyPipeline(table(), sanitizeSteps([{ type: 'text_terms', column: 'review', lang: 'en', minN: 1, maxN: 1, top: 1, sentiment: true }]));
  const mean = (vaderMod.compoundScore('Parking great') + vaderMod.compoundScore('Great staff') + vaderMod.compoundScore('Great staff')) / 3;
  ok('terms sentiment: a term\'s mean compound over the rows it occurs in',
    senti.rows[0][0] === 'great' && Object.is(senti.rows[0][3], mean), JSON.stringify(senti.rows));
  const rankNoBy = checkTextStep({ type: 'text_terms', column: 'review', rank: 'tfidf' }) as any;
  ok('tfidf without a dimension is made a count ranking', rankNoBy.rank === 'count');
}
{
  const t = table();
  const miss = applyPipeline(t, sanitizeSteps([{ type: 'text_sentiment', column: 'nope' }]));
  ok('an unknown column SKIPS with a warning, table unchanged', miss.columns.length === 3 && /unknown column/.test(miss.warnings[0] || ''));
  ok('sanitize drops malformed text steps', sanitizeSteps([
    { type: 'text_terms', column: 'r', lang: 'xx' }, { type: 'keyword_rules', column: 'r', rules: [] }, { type: 'text_sentiment' },
  ]).length === 0);
  const clean = checkTextStep({ type: 'text_terms', column: 'r', minN: 3, maxN: 1, top: 99999, evil: 'x' }) as any;
  ok('sanitize clamps ranges and drops unknown fields', clean.minN === 3 && clean.maxN === 3 && clean.top === 1000 && !('evil' in clean), JSON.stringify(clean));
}

// ── The SQL paths decline, and the fold answers ──────────────────────────────
{
  const schema = [{ physical: 'c0', name: 'region', type: 'text' as const }, { physical: 'c1', name: 'review', type: 'text' as const }];
  for (const step of sanitizeSteps([
    { type: 'text_sentiment', column: 'review' },
    { type: 'keyword_rules', column: 'review', rules: [{ pattern: 'x', category: 'X' }] },
    { type: 'text_terms', column: 'review' },
  ])) {
    const g = generateSql('t', schema, [{ type: 'filter', column: 'region', op: '=', value: 'West' }, step] as TransformStep[]);
    ok(`sqlGen BAILS on ${step.type} (never warns-and-continues without its column)`, g.sql === null && /text steps/.test(g.unsupported || ''), g.unsupported);
  }
}

// ── The warm runner a job leaves behind ──────────────────────────────────────
void (async () => {
  // The SQL paths are async (T4.2), so their declines are checked in here.
  const steps = sanitizeSteps([{ type: 'text_sentiment', column: 'review' }]);
  ok('runOnDuckDb (forced) declines a text pipeline', (await runOnDuckDb(table(), steps, { force: true })) === null);
  ok('runResidentPipeline declines a text pipeline before any query',
    (await runResidentPipeline('/nonexistent/x.parquet', table().columns, steps)) === null);

  const N = stepsText.WARM_MIN_ROWS as number;
  const words = ['great', 'slow', 'friendly', 'late', 'broken', 'love', 'terrible', 'ok'];
  const rows: Cell[][] = [];
  for (let i = 0; i < N; i += 1) rows.push(['r' + (i % 3), words[i % 8] + ' ' + words[(i * 7) % 8] + (i % 5 ? '!' : '.')]);
  const big: TableData = { columns: [T('region'), T('review')], rows };
  const step = sanitizeSteps([{ type: 'text_sentiment', column: 'review' }])[0] as any;
  const cold = applyPipeline(big, [step]);

  const real = vaderMod.compoundScore;
  let calls = 0;
  vaderMod.compoundScore = (s: string) => { calls += 1; return real(s); };
  try {
    let ticks = 0;
    const key = await stepsText.warmTextStep(big, step, () => { ticks += 1; }, () => false);
    ok('warm: the job does the per-row work in chunks, reporting progress', typeof key === 'string' && ticks >= 4 && calls === N, `ticks=${ticks} calls=${calls}`);
    calls = 0;
    const copy: TableData = { columns: big.columns.map((c) => ({ ...c })), rows: big.rows.map((r) => r.slice()) };
    const warm = applyPipeline(copy, [step]);
    ok('warm: the fold over the SAME cells takes the warm runner — no row re-scored', calls === 0, `calls=${calls}`);
    ok('warm: …and its output is the cold output, cell for cell',
      warm.rows.length === cold.rows.length && warm.rows.every((r, i) => r.every((v, k) => Object.is(v, cold.rows[i][k]))));
    calls = 0;
    applyPipeline(copy, [step]);
    ok('warm: taken once — a second fold computes again', calls === N, `calls=${calls}`);

    calls = 0;
    await stepsText.warmTextStep(big, step, () => { /* progress */ }, () => false);
    const changed: TableData = { columns: big.columns, rows: big.rows.map((r, i) => (i === 7 ? [r[0], 'changed text'] : r.slice())) };
    calls = 0;
    const fresh = applyPipeline(changed, [step]);
    ok('warm: ONE changed cell changes the key — nothing stale is served', calls === N && fresh.rows[7][2] === real('changed text'), `calls=${calls}`);
    stepsText.dropWarm(await stepsText.warmTextStep(big, step, () => { /* progress */ }, () => true));
    calls = 0;
    applyPipeline(copy, [step]);
    ok('warm: a cancelled warm-up leaves nothing warm', calls === N);
  } finally {
    vaderMod.compoundScore = real;
  }
  finish();
})();
