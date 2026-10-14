// Self-check for the value matcher — src/analysis/valueMatch.ts, and what an
// answer does with it, src/ai/answerValues.ts. Pure: no fs, no model.
//
//   1. KEYS AND LEVELS — what "the same value" means, and that exact, prefix,
//      one-edit and contains are four DISJOINT levels, nearest first.
//   2. ONE NEAR VALUE — a unique prefix, a unique one-edit, exact still wins;
//      two candidates → nothing (negative control), under 3 characters →
//      nothing, `contains` never decides.
//   3. DIFFERENTIAL with the filter bar (src/analysis/filterParse.ts), which
//      reads a typed word through the same matcher: for every word both accept,
//      the level and the value the bar's chip took are the ones `nearValues`
//      ranks first.
//   4. AN ANSWER'S FILTERS — `=`, `!=`, `in`, `not in` on a text column: the
//      spec is rewritten to the stored value and remembers what was said; a
//      value stored in another case is left to the step's case fix; a number
//      column, a `contains` and a period are never touched.
//   5. THE STORED `matched` LIST is re-read against the spec's own filters.
//   6. AN EMPTY ANSWER — the nearest stored values as complete specs; none for
//      a marked column, none for a value nothing is near.
//
//   npm run build:ts && node scripts/test-valueMatch.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const M: typeof import('../src/analysis/valueMatch') = require('../src/analysis/valueMatch');
const V: typeof import('../src/ai/answerValues') = require('../src/ai/answerValues');
const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const P: typeof import('../src/analysis/filterParse') = require('../src/analysis/filterParse');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type Cell = import('../src/data/transforms').Cell;
type FilterStep = import('../src/data/transforms').FilterStep;
type AnswerSpec = import('../src/ai/answerSpec').AnswerSpec;
type AnswerFilter = import('../src/ai/answerSpec').AnswerFilter;

const show = (v: unknown): string => JSON.stringify(v);

// ── 1. Keys and levels ──────────────────────────────────────────────────────

ok('key: case, accents and edge punctuation are not part of a value', M.normText('Québec,') === 'quebec' && M.normPhrase('  Office   Supplies. ') === 'office supplies');
ok('one edit: an insertion, a deletion, a substitution', M.withinOne('tecnology', 'technology') && M.withinOne('technology', 'tecnology') && M.withinOne('west', 'wast'));
ok('one edit: two edits are not one — a swap of two letters included (negative control)', !M.withinOne('regoin', 'region') && !M.withinOne('west', 'east coast') && !M.withinOne('abcd', 'abxy'));
const LEVELS = ['exact', 'prefix', 'fuzzy', 'contains'] as const;
const PAIRS: [string, string][] = [['tech', 'tech'], ['tech', 'technology'], ['tecnology', 'technology'], ['nology', 'technology'], ['tech', 'furniture']];
ok('levels: exact, prefix and one-edit are disjoint — a pair matches at most one of them',
  PAIRS.every(([p, k]) => LEVELS.slice(0, 3).filter((l) => M.keyMatches(l, p, k)).length <= 1), show(PAIRS.map(([p, k]) => LEVELS.filter((l) => M.keyMatches(l, p, k)))));
ok('levels: each pair lands where it should', show(PAIRS.map(([p, k]) => LEVELS.find((l) => M.keyMatches(l, p, k)) ?? null)) === '["exact","prefix","fuzzy","contains",null]');

const STORED = ['Furniture', 'Technology', 'Office Supplies', 'Technical', 'technology ', 'Tech'];
const near = (said: string, stored = STORED) => M.nearValues(said, stored).map((n) => `${n.level}:${n.value}`);
ok('near: nearest level first, the stored order inside a level', show(near('tech')) === '["exact:Tech","prefix:Technology","prefix:Technical"]', show(near('tech')));
ok('near: the same text in another case or with outer space is ONE value — the first met', near('technology').join() === 'exact:Technology,contains:Tech', show(near('technology')));
ok('near: …but two texts behind one key are two values, both offered', near('tech', ['Technology', 'Technology.', 'technology']).join() === 'prefix:Technology,prefix:Technology.', show(near('tech', ['Technology', 'Technology.', 'technology'])));
ok('near: a value is offered at one level only', near('office').join() === 'prefix:Office Supplies' && near('supplies').join() === 'contains:Office Supplies');
ok('near: under 3 characters only an exact value matches', show(near('te')) === '[]' && near('te', ['TE', 'Tea']).join() === 'exact:TE');
ok('near: a stored value under 3 characters is never a loose match', show(near('nsw', ['NS', 'N'])) === '[]');
ok('near: nothing said, nothing near', show(near('')) === '[]' && show(near('   ')) === '[]');

// ── 2. One near value ───────────────────────────────────────────────────────

const CATS = ['Furniture', 'Technology', 'Office Supplies'];
const one = (said: string, stored = CATS): string | null => M.oneNearValue(said, stored)?.value ?? null;
ok('one: a unique prefix', one('tech') === 'Technology' && M.oneNearValue('tech', CATS)?.level === 'prefix');
ok('one: a unique one-edit', one('Tecnology') === 'Technology' && M.oneNearValue('Tecnology', CATS)?.level === 'fuzzy');
ok('one: a word of a longer value is its prefix', one('office') === 'Office Supplies');
ok('one: exact still wins over a longer value that starts the same', one('tech', ['Technology', 'Tech']) === 'Tech' && one('Québec', ['Quebec City', 'quebec']) === 'quebec');
ok('one: two candidates → nothing (negative control)', one('tech', ['Technology', 'Technical']) === null && one('wast', ['West', 'East']) === null);
ok('one: …and a looser level is not tried past an ambiguous nearer one', one('tech', ['Technology', 'Technical', 'Teck']) === null);
ok('one: under 3 characters → nothing', one('te') === null && one('fu') === null);
ok('one: two texts behind one key are two candidates → nothing (negative control)',
  one('tech', ['Technology', 'Technology.']) === null && one('Tecnology', ['Technology', 'Technology.']) === null && one('smith', ['Smith, John', 'Smith John']) === null);
ok('one: …either of them alone is taken', one('tech', ['Technology.']) === 'Technology.' && one('smith', ['Smith, John']) === 'Smith, John');
ok('one: under 3 characters a key that lost its punctuation is no match — "A" is neither "A+" nor "A-"',
  one('A', ['A+', 'A-']) === null && one('A', ['A+']) === null && one('C', ['C++', 'C#']) === null);
ok('one: …the said text itself, in any case, still is (negative control)', one('a', ['A+', 'A', 'A-']) === 'A' && one('o+', ['O+', 'O-']) === 'O+');
ok('one: the said text itself wins over another text behind its key', one('smith john', ['Smith, John', 'Smith John']) === 'Smith John' && one('québec', ['Quebec', 'Québec']) === 'Québec');
ok('one: containment alone never decides', one('nology') === null && one('supplies') === null);
ok('one: nothing near → nothing', one('hardware') === null);

// ── 3. Differential with the filter bar ─────────────────────────────────────
// The bar accepts a prefix from 2 characters and one edit from 4; an answer needs 3 for both. Where both
// accept a word — 4 characters or more — they must read it at the same level, as the same value.

const catalog: import('../src/analysis/filterParse').FilterCatalog = { dimensions: [{ column: 'category', type: 'text', values: CATS }], measures: [], dates: [] };
const WORDS = ['technology', 'TECHNOLOGY', 'tech', 'techn', 'tecnology', 'technologyy', 'furn', 'furnitur', 'furnitura', 'office', 'hardware', 'supplies'];
let compared = 0;
for (const word of WORDS) {
  const chip = P.parseFilterText(word, catalog, { today: '2026-01-01' }).chips[0];
  const first = M.nearValues(word, CATS).find((n) => n.level !== 'contains');
  const bar = chip ? `${chip.match}:${String(chip.steps[0].value)}` : 'none';
  const ours = first ? `${first.level}:${first.value}` : 'none';
  if (chip) compared++;
  ok(`differential: "${word}" — the filter bar and the answer matcher agree (${ours})`, Object.is(bar, ours), `${bar} vs ${ours}`);
}
ok('differential: the comparison is not vacuous — the bar matched most of the words', compared >= 9, String(compared));

// ── 4. An answer's filters ──────────────────────────────────────────────────

const COLS: ParsedColumn[] = [{ name: 'order_date', type: 'date' }, { name: 'category', type: 'text' }, { name: 'region', type: 'text' }, { name: 'units', type: 'number' }];
const ROWS: Cell[][] = [
  ['2024-10-02', 'Technology', 'West', 100], ['2024-11-15', 'Furniture', 'East', 200], ['2024-12-20', 'Office Supplies', 'west', 300],
  ['2024-12-21', 'Technology', 'North', 1000], ['2024-12-22', null, 'South', 10],
];
const spec = (filters: AnswerFilter[]): AnswerSpec => ({
  datasetId: '11111111-1111-4111-8111-111111111111', category: 'region', measures: [{ column: 'units', aggregation: 'sum' }], filters, chartType: 'column', title: 'T',
});
const matchedSpec = (filters: AnswerFilter[]): AnswerSpec => { const s = spec(filters); return V.matchValues(s, V.heldValues(s.filters, COLS, ROWS)); };

for (const op of ['=', '!='] as const) {
  const m = matchedSpec([{ column: 'category', op, value: 'tech' }]);
  ok(`match: "${op}" — the spec holds the stored value and remembers what was said`,
    show(m.filters) === show([{ column: 'category', op, value: 'Technology' }]) && show(m.matched) === show([{ column: 'category', said: 'tech', value: 'Technology' }]), show(m));
}
for (const op of ['in', 'not in'] as const) {
  const m = matchedSpec([{ column: 'category', op, values: ['Tecnology', 'Furniture', 'offic'] }]);
  ok(`match: "${op}" — each value of the list on its own, a stored one left alone`,
    show(m.filters) === show([{ column: 'category', op, values: ['Technology', 'Furniture', 'Office Supplies'] }])
    && show(m.matched) === show([{ column: 'category', said: 'Tecnology', value: 'Technology' }, { column: 'category', said: 'offic', value: 'Office Supplies' }]), show(m));
}
const cased = spec([{ column: 'region', op: '=', value: ' WEST ' }]);
ok('match: a value stored in another case is NOT a loose match — the very spec comes back', V.matchValues(cased, V.heldValues(cased.filters, COLS, ROWS)) === cased);
const steps: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: ' WEST ' }, { type: 'filter', column: 'region', op: 'in', values: ['east', 'Nowhere'] }];
V.canonicaliseTextFilters(steps, V.heldValues(cased.filters, COLS, ROWS));
ok('match: …the STEP is fixed to the first spelling stored, a value nothing holds left as asked', show(steps.map((s) => s.value ?? s.values)) === '["West",["East","Nowhere"]]', show(steps));
const ambiguous = spec([{ column: 'region', op: '=', value: 'sout' }, { column: 'region', op: '=', value: 'wast' }]);
ok('match: a unique prefix beside a value one edit from TWO stored ones — only the first is taken (negative control)',
  show(matchedSpec(ambiguous.filters).filters) === show([{ column: 'region', op: '=', value: 'South' }, { column: 'region', op: '=', value: 'wast' }])
  && matchedSpec(ambiguous.filters).matched?.length === 1, show(matchedSpec(ambiguous.filters)));
const untouched = spec([
  { column: 'units', op: '=', value: 10 }, { column: 'category', op: 'contains', value: 'tech' }, { column: 'order_date', period: 'last_quarter' },
  { column: 'category', op: 'is_empty' }, { column: 'gone', op: '=', value: 'tech' }, { column: 'category', op: '=', value: 'te' }, { column: 'category', op: '=', value: null },
]);
ok('match: a number column, `contains`, a period, a valueless filter, an unknown column, 2 characters, an empty value — none is touched (negative control)',
  V.matchValues(untouched, V.heldValues(untouched.filters, COLS, ROWS)) === untouched);
// The ceiling: a column of more distinct values than LOOSE_MAX_DISTINCT is id-like, and every said value would read all of them.
const sized = (n: number): import('../src/ai/answerValues').Held =>
  new Map([['category', new Map([...Array.from({ length: n - 1 }, (_, i) => `Item ${i}`), 'Technology'].map((v): [string, string] => [v.toLowerCase(), v]))]]);
const techSpec = spec([{ column: 'category', op: '=', value: 'tech' }]);
ok('ceiling: over LOOSE_MAX_DISTINCT distinct values a column is neither matched loosely nor offered from',
  V.matchValues(techSpec, sized(V.LOOSE_MAX_DISTINCT + 1)) === techSpec && V.nearestValueFixes(techSpec, sized(V.LOOSE_MAX_DISTINCT + 1), new Set()) === null);
ok('ceiling: …at it, the same value is both (negative control)',
  show(V.matchValues(techSpec, sized(V.LOOSE_MAX_DISTINCT)).filters) === show([{ column: 'category', op: '=', value: 'Technology' }]) && V.nearestValueFixes(techSpec, sized(V.LOOSE_MAX_DISTINCT), new Set())?.options[0].label === 'Technology');
// The column is read into keys once per filter, however many of its values need a look — not once per value.
const realKeys = M.valueKeys;
let indexed = 0;
(M as { valueKeys: typeof realKeys }).valueKeys = (stored) => { indexed++; return realKeys(stored); };
const listed = spec([{ column: 'category', op: 'in', values: ['tech', 'furn', 'offic', 'hardware', 'Tecnology'] }]);
V.matchValues(listed, V.heldValues(listed.filters, COLS, ROWS));
const onceForFive = indexed;
indexed = 0;
const allHeld = spec([{ column: 'category', op: 'in', values: ['technology', 'Furniture'] }]);
V.matchValues(allHeld, V.heldValues(allHeld.filters, COLS, ROWS));
(M as { valueKeys: typeof realKeys }).valueKeys = realKeys;
ok('cost: five values to look up read the column into keys ONCE; values all held, never (negative control)', onceForFive === 1 && indexed === 0, `${onceForFive} ${indexed}`);

const twice = matchedSpec([{ column: 'category', op: '=', value: 'tech' }]);
ok('match: a matched spec matched again is itself — a reload changes nothing', V.matchValues(twice, V.heldValues(twice.filters, COLS, ROWS)) === twice);
const long = matchedSpec([{ column: 'category', op: '=', value: 'tech' + ' '.repeat(200) + '!' }]);
ok('match: what was said is kept to 80 characters', long.matched?.[0].said.length === 80 && long.matched[0].value === 'Technology', show(long.matched));

// ── 5. The stored `matched` list ────────────────────────────────────────────

const stored = A.sanitizeStoredSpec({ ...twice, matched: [
  { column: 'category', said: 'tech', value: 'Technology' },              // borne out by the filter
  { column: 'category', said: 'tech', value: 'Furniture' },               // a value the filter does not hold
  { column: 'region', said: 'wst', value: 'West' },                        // no filter on that column
  { column: 'category', said: 7, value: 'Technology' }, null, 'x',          // malformed
  { column: 'category', said: 'x'.repeat(500), value: 'Technology', extra: true },
] });
ok('stored: only entries a filter of the spec bears out survive, whitelisted and cut',
  show(stored?.matched) === show([{ column: 'category', said: 'tech', value: 'Technology' }, { column: 'category', said: 'x'.repeat(80), value: 'Technology' }]), show(stored?.matched));
ok('stored: a spec with none carries no key at all', !('matched' in (A.sanitizeStoredSpec(spec([])) ?? {})) && !('matched' in (A.sanitizeStoredSpec({ ...twice, matched: 'x' }) ?? {})));
ok('stored: at most 16 entries (negative control: 40 were sent)',
  A.sanitizeStoredSpec({ ...twice, matched: Array.from({ length: 40 }, (_, i) => ({ column: 'category', said: `s${i}`, value: 'Technology' })) })?.matched?.length === 16);
ok('stored: a match on a `contains` filter, or on a period, is no match',
  !('matched' in (A.sanitizeStoredSpec({ ...spec([{ column: 'category', op: 'contains', value: 'Technology' }, { column: 'order_date', period: 'last_year' }]), matched: [{ column: 'category', said: 'tech', value: 'Technology' }, { column: 'order_date', said: 'x', value: 'last_year' }] }) ?? {})));

// ── 6. An empty answer ──────────────────────────────────────────────────────

const WIDE: Cell[][] = [...ROWS, ['2024-12-23', 'Technical', 'West', 5], ['2024-12-24', 'Biotechnology', 'West', 5]];
const fixes = (filters: AnswerFilter[], withheld: string[] = []) => {
  const s = spec(filters);
  return V.nearestValueFixes(s, V.heldValues(s.filters, COLS, WIDE), new Set(withheld));
};
const fx = fixes([{ column: 'region', op: '=', value: 'West' }, { column: 'category', op: '=', value: 'tech' }]);
ok('empty: the first filter whose value its column does not hold, and what it may have meant — prefix first, then containment',
  !!fx && fx.column === 'category' && fx.said === 'tech' && fx.options.map((o) => o.label).join() === 'Technology,Technical,Biotechnology', show(fx));
ok('empty: each option is the COMPLETE spec with that value in place — every other filter kept',
  !!fx && fx.options.every((o, i) => show(o.spec) === show({ ...spec([]), filters: [{ column: 'region', op: '=', value: 'West' }, { column: 'category', op: '=', value: ['Technology', 'Technical', 'Biotechnology'][i] }] })), show(fx?.options));
ok('empty: every option passes the stored-spec whitelist unchanged', !!fx && fx.options.every((o) => show(A.sanitizeStoredSpec(o.spec)) === show(o.spec)));
const inList = fixes([{ column: 'category', op: 'in', values: ['Furniture', 'Tecnical'] }]);
ok('empty: in a list, only the value that is not stored is replaced', !!inList && inList.said === 'Tecnical' && inList.op === 'in' && fx?.op === '='
  && show(inList.options.map((o) => o.spec.filters[0])) === show([{ column: 'category', op: 'in', values: ['Furniture', 'Technical'] }]), show(inList));
const four = new Map([['category', new Map(['Value 1', 'Value 2', 'Value 3', 'Value 4'].map((v): [string, string] => [v.toLowerCase(), v]))]]);
ok('empty: at most three options (negative control: four values are near)',
  V.nearestValueFixes(spec([{ column: 'category', op: '=', value: 'val' }]), four, new Set())?.options.map((o) => o.label).join() === 'Value 1,Value 2,Value 3');
ok('empty: none for a column marked personal or financial', fixes([{ column: 'category', op: '=', value: 'tech' }], ['category']) === null);
ok('empty: …and the next unmarked filter is the one offered', fixes([{ column: 'category', op: '=', value: 'tech' }, { column: 'region', op: '=', value: 'wes' }], ['category'])?.column === 'region');
ok('empty: none for a value nothing is near', fixes([{ column: 'category', op: '=', value: 'hardware' }]) === null);
ok('empty: none when every value is stored — the rows are empty for another reason', fixes([{ column: 'category', op: '=', value: 'technology' }, { column: 'region', op: '=', value: 'South' }]) === null);
ok('empty: `!=` and `not in` empty no chart, so they offer nothing', fixes([{ column: 'category', op: '!=', value: 'tech' }, { column: 'category', op: 'not in', values: ['tech'] }]) === null);

finish();
