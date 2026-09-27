'use strict';

// Self-check for TYPED FILTERS — src/analysis/filterParse.ts (the parser),
// filterDates.ts (its date grammar) and filterCatalog.ts (what it parses
// against).
//
//   §1 a table of phrases → the chips each must produce, written out by hand
//   §2 ambiguity: a value in two columns is offered for BOTH; `pick` switches
//   §3 unknown words stay unknown, with their spans — never guessed
//   §4 dates on a FIXED today and a non-default calendar
//   §5 the catalog: resident-first equals the JS reference on the bundled
//      sample, Object.is on every value; and a parse over that real catalog
//
// Every expectation is written out, never derived with the code under test.
//
//   npm run build:ts && node scripts/test-filterParse.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFilterText, candId } from '../src/analysis/filterParse';
import type { FilterCatalog, FilterChip, ParseResult } from '../src/analysis/filterParse';
import { catalogResident, catalogJs, mergeCatalogs } from '../src/analysis/filterCatalog';
import { resolvePeriod } from '../src/analysis/dateIntel';
import type { CalendarPrefs } from '../src/analysis/dateIntel';
import { parseCsv } from '../src/data/parse';
import * as pq from '../src/engine/parquetStore';

import { ok, finish } from './selfcheck';

const TODAY = '2024-10-15'; // a Tuesday
const CAT: FilterCatalog = {
  dimensions: [
    { column: 'region', type: 'text', values: ['Central', 'East', 'Northeast', 'South', 'West'] },
    { column: 'state', type: 'text', values: ['California', 'Colorado', 'Connecticut', 'New York', 'New Jersey', 'Texas', 'Tennessee', 'Washington'] },
    { column: 'category', type: 'text', values: ['Furniture', 'Office Supplies', 'Technology'] },
    { column: 'sub_category', type: 'text', values: ['Chairs', 'Phones', 'Storage', 'Tables', 'Copiers'] },
    { column: 'customer_segment', type: 'text', values: ['Consumer', 'Corporate', 'Home Office'] },
    { column: 'zone', type: 'text', values: ['Central', 'Pacific'] },
    { column: 'state_code', type: 'text', values: ['IN', 'OR', 'ME'] },
    { column: 'city', type: 'text', values: ['São Paulo', 'Zürich', 'Oslo'] },
  ],
  measures: [
    { column: 'units', type: 'number', max: 14 },
    { column: 'unit_price', type: 'number', max: 999 },
    { column: 'discount', type: 'number', max: 0.3 },
    { column: 'revenue', type: 'number', max: 20000 },
    { column: 'profit', type: 'number', max: 5000 },
    { column: 'score', type: 'number', max: 100 },
  ],
  dates: ['order_date'],
};

function parse(text: string, cal?: CalendarPrefs, pick?: Record<string, string>, cat: FilterCatalog = CAT): ParseResult {
  return parseFilterText(text, cat, { today: TODAY, calendar: cal, pick });
}

/** A chip as one line, from its STEPS — what downstream actually evaluates. */
function show(c: FilterChip): string {
  return c.steps.map((s) => {
    if (s.op === 'period') {
      const p = s.period || { preset: 'custom' };
      if (p.preset !== 'custom') return `${s.column} period ${p.preset}${p.n ? ':' + p.n : ''}`;
      return `${s.column} period ${p.from || ''}..${p.to || ''}`;
    }
    const v = Array.isArray(s.values) ? s.values.join('|') : String(s.value);
    return `${s.column} ${s.op} ${v}`;
  }).join(' & ');
}

function chipsOf(text: string, cal?: CalendarPrefs): string[] {
  return parse(text, cal).chips.map(show);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── §1 the phrase table ─────────────────────────────────────────────────────

const TABLE: Array<[string, string[]]> = [
  ['west', ['region = West']],
  ['West', ['region = West']],
  ['west technology', ['region = West', 'category = Technology']],
  ['west technology last quarter', ['region = West', 'category = Technology', 'order_date period last_quarter']],
  ['office supplies', ['category = Office Supplies']],
  ['new york', ['state = New York']],
  ['furniture technology', ['category in Furniture|Technology']],
  ['furniture, technology', ['category in Furniture|Technology']],
  ['west or east', ['region in West|East']],
  ['not furniture', ['category != Furniture']],
  ['excluding West', ['region != West']],
  ['excluding west and east', ['region not in West|East']],
  ['without chairs', ['sub_category != Chairs']],
  ['no technology', ['category != Technology']],
  ['except home office', ['customer_segment != Home Office']],
  ['tech', ['category = Technology']],
  ['furnture', ['category = Furniture']],
  ['sao paulo', ['city = São Paulo']],
  ['ZURICH', ['city = Zürich']],
  ['revenue > 10k', ['revenue > 10000']],
  ['revenue over $10,000', ['revenue > 10000']],
  ['profit at least 500', ['profit >= 500']],
  ['units less than 5', ['units < 5']],
  ['unit price below 1.5k', ['unit_price < 1500']],
  ['discount under 20%', ['discount < 0.2']],
  ['score under 20%', ['score < 20']],
  ['revenue between 1k and 5k', ['revenue >= 1000 & revenue <= 5000']],
  ['revenue >= 2.5m', ['revenue >= 2500000']],
  ['last month', ['order_date period last_month']],
  ['this year', ['order_date period this_year']],
  ['ytd', ['order_date period ytd']],
  ['mtd', ['order_date period 2024-10-01..2024-10-15']],
  ['last 30 days', ['order_date period last_n_days:30']],
  ['last 6 weeks', ['order_date period last_n_weeks:6']],
  ['yesterday', ['order_date period yesterday']],
  ['since March', ['order_date period 2024-03-01..2024-10-15']],
  ['since 2024-03-15', ['order_date period 2024-03-15..2024-10-15']],
  ['2023', ['order_date period 2023-01-01..2023-12-31']],
  ['Q3', ['order_date period 2024-07-01..2024-09-30']],
  ['Q4', ['order_date period 2024-10-01..2024-12-31']],
  ['Q3 2023', ['order_date period 2023-07-01..2023-09-30']],
  ['March 2024', ['order_date period 2024-03-01..2024-03-31']],
  ['November', ['order_date period 2023-11-01..2023-11-30']],
  ['before 2024', ['order_date period ..2023-12-31']],
  ['after June', ['order_date period 2024-07-01..']],
  ['in 2024 show me west', ['order_date period 2024-01-01..2024-12-31', 'region = West']],
  ['region = west', ['region = West']],
  ['zone central', ['zone = Central']],
  ['IN', ['state_code = IN']],
  ['in west', ['region = West']],
  ['west technology last quarter excluding chairs revenue > 10k',
    ['region = West', 'category = Technology', 'order_date period last_quarter', 'sub_category != Chairs', 'revenue > 10000']],
];

ok(`§1 the table has at least 40 phrases (${TABLE.length})`, TABLE.length >= 40);
for (const [text, want] of TABLE) {
  const got = chipsOf(text);
  ok(`§1 "${text}" → ${want.join(' · ')}`, same(got, want), JSON.stringify(got));
}

// Match kinds are reported, so the popover can tag them.
ok('§1 exact/prefix/fuzzy are told apart',
  parse('west').chips[0].match === 'exact' && parse('tech').chips[0].match === 'prefix' && parse('furnture').chips[0].match === 'fuzzy');
ok('§1 labels read as sentences', same(parse('not furniture revenue > 10k').chips.map((c) => c.label), ['category ≠ Furniture', 'revenue > 10,000']));
ok('§1 a two-value chip is ONE `in` step with a values list',
  same(parse('west east').chips[0].steps, [{ type: 'filter', column: 'region', op: 'in', values: ['West', 'East'] }]));
ok('§1 the same value typed twice is one value', same(chipsOf('west West'), ['region = West']));
ok('§1 a positive and a negative on one column are two chips', same(chipsOf('west not east'), ['region = West', 'region != East']));

// ── §2 ambiguity ────────────────────────────────────────────────────────────

{
  const r = parse('central');
  const cols = r.groups.map((g) => g.column);
  ok('§2 a value in two columns is offered for BOTH, in dimension order', same(cols, ['region', 'zone']), JSON.stringify(cols));
  const reg = r.groups[0].items[0];
  const zone = r.groups[1].items[0];
  ok('§2 the first by dimension order is the one Enter applies', reg.chosen && !zone.chosen && same(chipsOf('central'), ['region = Central']));
  ok('§2 both readings carry the typed phrase and the same key', reg.key === 'central' && zone.key === 'central' && zone.phrase === 'central');
  const picked = parse('central', undefined, { [zone.key]: zone.id });
  ok('§2 pick switches the chip to the other column', same(picked.chips.map(show), ['zone = Central']));
  ok('§2 …and the popover still offers the first', picked.groups[0].column === 'region' && !picked.groups[0].items[0].chosen && picked.groups[1].items[0].chosen);
  ok('§2 a pick naming a reading that is not offered is ignored', same(parse('central', undefined, { central: candId('city', 'Oslo') }).chips.map(show), ['region = Central']));

  const co = parse('co');
  const offered = co.groups.flatMap((g) => g.items.map((i) => `${g.column}:${i.label}`));
  ok('§2 an ambiguous prefix offers every value it could be',
    same(offered, ['state:Colorado', 'state:Connecticut', 'sub_category:Copiers', 'customer_segment:Consumer', 'customer_segment:Corporate']), JSON.stringify(offered));
  ok('§2 …and applies the first', same(co.chips.map(show), ['state = Colorado']));
  ok('§2 a column name narrows an ambiguous value to that column', same(chipsOf('zone central'), ['zone = Central']));
  ok('§2 two date columns: the date is offered on both', same(parse('last month', undefined, undefined, { ...CAT, dates: ['order_date', 'ship_date'] }).groups.map((g) => g.column), ['order_date', 'ship_date']));
  ok('§2 …and "ship date last month" names the second', same(parse('ship date last month', undefined, undefined, { ...CAT, dates: ['order_date', 'ship_date'] }).chips.map(show), ['ship_date period last_month']));
}

// ── §3 unknown words ────────────────────────────────────────────────────────

{
  const r = parse('west blorp technology');
  ok('§3 an unknown word does not stop the rest', same(r.chips.map(show), ['region = West', 'category = Technology']));
  ok('§3 …it is listed as unknown', same(r.unknown, ['blorp']));
  const t = r.tokens.find((x) => x.text === 'blorp');
  ok('§3 …with its span in the text, for the input to highlight', !!t && t.kind === 'unknown' && t.start === 5 && t.end === 10, JSON.stringify(t));
  ok('§3 recognised words are marked as such', r.tokens[0].kind === 'value' && r.tokens[2].kind === 'value');
  ok('§3 stop-words are consumed silently', parse('show me the west').unknown.length === 0 && same(chipsOf('show me the west'), ['region = West']));
  ok('§3 "in" is a stop-word, "IN" is the value', same(chipsOf('in'), []) && parse('in').unknown.length === 0 && same(chipsOf('IN'), ['state_code = IN']));
  ok('§3 a grammar word alone is unknown, not a near miss ("last" is not "East")', same(chipsOf('last'), []) && same(parse('last').unknown, ['last']));
  ok('§3 a measure name alone is unknown', same(parse('revenue').unknown, ['revenue']) && parse('revenue').chips.length === 0);
  ok('§3 a bare number is unknown, never a guessed value', same(parse('42').unknown, ['42']));
  ok('§3 a negation of nothing is unknown', same(parse('not').unknown, ['not']));
  const neg = parse('not last quarter');
  ok('§3 a negated date is left unknown, not inverted', neg.chips.length === 0 && same(neg.unknown, ['not', 'last', 'quarter']));
  ok('§3 a negated comparison is left unknown too', parse('not revenue > 10k').chips.length === 0 && same(parse('not revenue > 10k').unknown, ['not', 'revenue', '>', '10k']));
  ok('§3 a two-letter word is not a near miss', same(chipsOf('xy'), []) && same(parse('xy').unknown, ['xy']));
  ok('§3 no dates on the dashboard: a date phrase is unknown', same(parse('last quarter', undefined, undefined, { ...CAT, dates: [] }).unknown, ['last', 'quarter']));
  ok('§3 the parse is deterministic', same(parse('west technology last quarter'), parse('west technology last quarter')));
  ok('§3 empty text is an empty parse', same(parse('   '), { tokens: [], chips: [], groups: [], unknown: [] }));
}

// ── §4 dates: a fixed today, and a non-default calendar ─────────────────────

{
  const FISCAL: CalendarPrefs = { weekStart: 0, fiscalYearStart: 2 }; // weeks from Sunday, years from February
  const lq = parse('last quarter', FISCAL).chips[0];
  ok('§4 "last quarter" stays a relative preset', same(show(lq), 'order_date period last_quarter'));
  ok('§4 …named for the fiscal calendar', lq.label === 'Last fiscal quarter', lq.label);
  const period = lq.steps[0].period!;
  ok('§4 …and resolves to the previous FISCAL quarter (May–Jul)', same(resolvePeriod(period, TODAY, FISCAL), { from: '2024-05-01', to: '2024-07-31' }));
  ok('§4 "Q3" is the most recent fiscal Q3 that has started (Aug–Oct 2024)', same(chipsOf('Q3', FISCAL), ['order_date period 2024-08-01..2024-10-31']));
  ok('§4 "Q4" has not started this year, so it is last year\'s (Nov 2023–Jan 2024)', same(chipsOf('Q4', FISCAL), ['order_date period 2023-11-01..2024-01-31']));
  ok('§4 "Q1 2024" is the fiscal Q1 that starts in 2024', same(chipsOf('Q1 2024', FISCAL), ['order_date period 2024-02-01..2024-04-30']));
  const tw = parse('this week', FISCAL).chips[0].steps[0].period!;
  ok('§4 "this week" starts on the workspace\'s first day (Sunday)', same(resolvePeriod(tw, TODAY, FISCAL), { from: '2024-10-13', to: '2024-10-19' }));
  ok('§4 "this year" is the fiscal year', parse('this year', FISCAL).chips[0].label === 'This fiscal year');
  ok('§4 "since March" in January reaches back to last March',
    same(parseFilterText('since March', CAT, { today: '2025-01-10' }).chips.map(show), ['order_date period 2024-03-01..2025-01-10']));
  ok('§4 "March" in March is this March', same(parseFilterText('March', CAT, { today: '2024-03-05' }).chips.map(show), ['order_date period 2024-03-01..2024-03-31']));
  ok('§4 "from June" reads as "since June"', same(chipsOf('from June'), ['order_date period 2024-06-01..2024-10-15']));
  ok('§4 "before 2024-03-15" ends the day before', same(chipsOf('before 2024-03-15'), ['order_date period ..2024-03-14']));
  ok('§4 "after 2023" starts the next year', same(chipsOf('after 2023'), ['order_date period 2024-01-01..']));
  ok('§4 "last quar" (half typed) already reads', same(chipsOf('last quar'), ['order_date period last_quarter']));
  ok('§4 "last 1 month" is the n-preset', same(chipsOf('last 1 month'), ['order_date period last_n_months:1']));
  ok('§4 "year to date" is ytd', same(chipsOf('year to date'), ['order_date period ytd']));
  ok('§4 a lone abbreviation is not a month ("mar" alone is unknown)', same(parse('mar').unknown, ['mar']));
  ok('§4 …but "since mar" is', same(chipsOf('since mar'), ['order_date period 2024-03-01..2024-10-15']));
  ok('§4 the label of a custom range names its dates', parse('Q3 2023').chips[0].label === 'Q3 2023 · Jul 1, 2023 – Sep 30, 2023', parse('Q3 2023').chips[0].label);
}

// ── §5 the catalog: resident-first equals the JS reference ──────────────────

{
  const merged = mergeCatalogs([
    { dimensions: [{ column: 'region', type: 'text', values: ['West', 'East'] }], measures: [{ column: 'revenue', type: 'number', max: 10 }], dates: ['d'] },
    { dimensions: [{ column: 'region', type: 'text', values: ['East', 'North'] }, { column: 'tier', type: 'text', values: ['Gold'] }], measures: [{ column: 'revenue', type: 'number', max: 30 }], dates: ['d', 'e'] },
  ]);
  ok('§5 merge: a shared column is one dimension with the union of its values',
    same(merged.dimensions.map((d) => [d.column, d.values]), [['region', ['West', 'East', 'North']], ['tier', ['Gold']]]));
  ok('§5 merge: a shared measure keeps the larger max; dates are unioned', merged.measures[0].max === 30 && same(merged.dates, ['d', 'e']));

  const csv = fs.readFileSync(path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv'), 'utf8');
  const parsed = parseCsv(csv);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-filterparse-'));
  try {
    const file = path.join(dir, 'sample.parquet');
    pq.writeTable(file, parsed.columns, parsed.rows);
    const back = pq.readTable(file, parsed.columns);
    if (!back) throw new Error('fixture read-back failed');
    const js = catalogJs(back.columns, back.rows, 'sample');
    const fast = catalogResident({ parquetPath: file, columns: parsed.columns }, 'sample');
    ok('§5 the sample has the dimensions, measures and date the smoke types against',
      same(js.dimensions.map((d) => d.column), ['region', 'state', 'category', 'sub_category', 'customer_segment'])
      && same(js.measures.map((m) => m.column), ['units', 'unit_price', 'discount', 'revenue', 'profit', 'ship_days'])
      && same(js.dates, ['order_date']), JSON.stringify({ d: js.dimensions.map((d) => d.column), m: js.measures.map((m) => m.column), t: js.dates }));
    if (fast === null) {
      ok('§5 resident catalog (bridge down — JS reference only)', true);
    } else {
      let cells = 0;
      let equal = fast.dimensions.length === js.dimensions.length && fast.measures.length === js.measures.length && same(fast.dates, js.dates);
      fast.dimensions.forEach((d, i) => {
        const r = js.dimensions[i];
        equal = equal && d.column === r.column && d.type === r.type && d.datasetId === r.datasetId && d.values.length === r.values.length;
        d.values.forEach((v, k) => { cells++; equal = equal && Object.is(v, r.values[k]); });
      });
      fast.measures.forEach((m, i) => { cells++; equal = equal && m.column === js.measures[i].column && Object.is(m.max, js.measures[i].max); });
      ok(`§5 resident catalog equals the JS build, Object.is on all ${cells} values and maxes`, equal && cells > 40);
    }
    ok('§5 the sample\'s discount column is a fraction column (max ≤ 1)', typeof js.measures[2].max === 'number' && js.measures[2].max <= 1, String(js.measures[2].max));
    const onSample = parseFilterText('west technology last quarter discount under 20%', js, { today: '2024-12-31' });
    ok('§5 on the real sample: "west technology last quarter discount under 20%"',
      same(onSample.chips.map(show), ['region = West', 'category = Technology', 'order_date period last_quarter', 'discount < 0.2']), JSON.stringify(onSample.chips.map(show)));
    ok('§5 on the real sample: "filter this to furniture" words → one chip, nothing unknown',
      same(parseFilterText('furniture', js, { today: '2024-12-31' }).chips.map(show), ['category = Furniture']));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

finish();
