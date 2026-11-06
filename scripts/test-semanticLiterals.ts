// Self-check for the closed literal encoder that writes every value into dbt's filter text (semantic layer part 7, d1;
// src/engine/live/semantic/literals.ts, docs/live-data/dbt-semantic-layer.md "Filters"). Pure: no dbt, no network.
//
//   § literals  text in the class encoded exactly (a quote doubled); braces, backslash, double quote, NUL, controls,
//               line breaks, format characters, quote look-alikes, the empty string and 201 characters refused;
//               numbers only as plain decimals; dates only as real ISO days; names only from the synced list
//   § filters   each Ordinate filter as the one `where` entry the doc's table names (NULL and '' as an extract reads them)
//   § fuzz      20,000 seeded strings over printable ASCII, the refused set, Unicode punctuation and SQL/Jinja fragments:
//               each is refused, or the text written for `col = s` (and `col IN (s, t)`) reads back as exactly one
//               predicate holding exactly s. NEGATIVE CONTROL: a raw inliner breaks out of the template.
//
//   npm run build:ts && node scripts/test-semanticLiterals.js

export {}; // module scope \u2014 sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { SemanticFilter } from '../src/engine/live/semantic/semanticQuery';

const lit: typeof import('../src/engine/live/semantic/literals') = require('../src/engine/live/semantic/literals');
const fake: typeof import('./semanticFakeDbt') = require('./semanticFakeDbt');

const show = (v: unknown): string => JSON.stringify(v);
const COLS: LiveColumn[] = [{ name: 'customer__region', type: 'text' }, { name: 'metric_time', type: 'date' }, { name: 'amt', type: 'number' }];
const NAMES = { dataset: 'Orders', layer: 'dbt' };
const textOf = (r: ReturnType<typeof lit.literal>): string => (r.ok ? r.text : '');
const unquote = (s: string): string => (/^'.*'$/s.test(s) ? s.slice(1, -1).replace(/''/g, "'") : `<not quoted: ${s}>`);
const where = (f: SemanticFilter): string => {
  const r = lit.whereText(f, COLS, NAMES);
  return 'text' in r ? r.text : `refused ${r.code}`;
};

// ── § literals ──
for (const v of ["O'Brien", 'Z\u00fcrich', 'S\u00e3o Paulo', 'Sa\u0303o Paulo', '50% off', 'a/b (c)', '\u6771\u4eac', 'a-b_c.d,e:f;g&h#i@j+k', 'x'.repeat(200)]) {
  ok(`encoded exactly: ${v.slice(0, 40)}`, unquote(textOf(lit.literal(v, 'text'))) === v, textOf(lit.literal(v, 'text')));
}
ok("a quote is doubled, never escaped: O'Brien \u2192 'O''Brien'", textOf(lit.literal("O'Brien", 'text')) === "'O''Brien'");
for (const v of ['{{ x }}', '{% if %}', '{# note #}', 'a}b', 'back\\slash', 'nul\u0000', 'line\nbreak', 'cr\rhere', 'tab\t', 'ls\u2028', 'zw\u200bsp', 'bom\ufeff', 'nb\u00a0sp',
  '\u2018quote', '\u2019quote', 'modifier\u02bc', 'prime\u02b9', '\uff07', 'say "hi"', '`tick`', 'x'.repeat(201), '']) {
  ok(`refused: ${show(v).slice(0, 40)}`, !lit.literal(v, 'text').ok);
}
for (const n of [0, -0, 12, -3.5, 1e21, NaN, Infinity, -Infinity, 1e-7, 0.1]) ok(`number ${n}: written exactly when String(n) is a plain decimal`, lit.literal(n, 'number').ok === /^-?\d+(\.\d+)?$/.test(String(n)) && (!lit.literal(n, 'number').ok || textOf(lit.literal(n, 'number')) === String(n)));
ok('a number given as text is no number literal', !lit.literal('12', 'number').ok && !lit.literal(null, 'number').ok);
ok('a date is a quoted ISO day; a non-date is refused', textOf(lit.literal('2024-03-01', 'date')) === "'2024-03-01'" && !lit.literal('2024-3-1', 'date').ok
  && !lit.literal('2024-02-30', 'date').ok && !lit.literal("2024-03-01' OR '1", 'date').ok && !lit.literal('2024-03-01T00:00:00Z', 'date').ok);
ok('NULL is never a literal', !lit.literal(null, 'text').ok && !lit.literal(null, 'date').ok);
ok('a dimension outside the synced list is refused', lit.dimensionRef('orders__region', new Set(['orders__status'])) === null);
ok('\u2026and one in it that is no dbt name too', ['Region', 'a b', "x') }}{{ y", 'x-y', '_'.repeat(1) + 'ok'].map((n) => lit.dimensionRef(n, new Set([n]))).join() === ',,,,{{ Dimension(\'_ok\') }}');
ok('a synced name is written as Dimension, a date one at the day grain', lit.dimensionRef('customer__region', new Set(['customer__region'])) === "{{ Dimension('customer__region') }}"
  && lit.dimensionRef('metric_time', new Set(['metric_time']), true) === "{{ TimeDimension('metric_time', 'day') }}");

// ── § filters ──
const R = "{{ Dimension('customer__region') }}";
const T = "{{ TimeDimension('metric_time', 'day') }}";
const TABLE: Array<[string, SemanticFilter, string]> = [
  ['text =', { kind: 'compare', column: 'customer__region', op: '=', value: 'West' }, `${R} = 'West'`],
  ['text = blank', { kind: 'compare', column: 'customer__region', op: '=', value: '' }, `(${R} = '' OR ${R} IS NULL)`],
  ['text !=', { kind: 'compare', column: 'customer__region', op: '!=', value: 'West' }, `(${R} <> 'West' OR ${R} IS NULL)`],
  ['text != blank', { kind: 'compare', column: 'customer__region', op: '!=', value: null }, `${R} <> ''`],
  ['text <', { kind: 'compare', column: 'customer__region', op: '<', value: 'M' }, 'refused layerFilter'],
  ['text in', { kind: 'in', column: 'customer__region', values: ['East', 'West', 'East'], negate: false }, `${R} IN ('East', 'West')`],
  ['text in with a blank', { kind: 'in', column: 'customer__region', values: ['East', null], negate: false }, `(${R} IN ('East') OR ${R} = '' OR ${R} IS NULL)`],
  ['text not in', { kind: 'in', column: 'customer__region', values: ['East'], negate: true }, `(${R} NOT IN ('East') OR ${R} IS NULL)`],
  ['text not in with a blank', { kind: 'in', column: 'customer__region', values: ['East', ''], negate: true }, `(${R} NOT IN ('East') AND ${R} <> '')`],
  ['text not in, a blank only', { kind: 'in', column: 'customer__region', values: [''], negate: true }, `${R} <> ''`],
  ['text in, nothing', { kind: 'in', column: 'customer__region', values: [], negate: false }, 'refused layerFilter'],
  ['contains', { kind: 'contains', column: 'customer__region', value: 'est' }, `${R} LIKE '%est%'`],
  ['contains a wildcard', { kind: 'contains', column: 'customer__region', value: '50%' }, 'refused layerFilter'],
  ['contains an underscore', { kind: 'contains', column: 'customer__region', value: 'a_b' }, 'refused layerFilter'],
  ['text empty', { kind: 'empty', column: 'customer__region', negate: false }, 'refused layerFilter'],
  ['a value no class holds', { kind: 'compare', column: 'customer__region', op: '=', value: 'it\u2019s' }, 'refused layerFilter'],
  ['date =', { kind: 'compare', column: 'metric_time', op: '=', value: '2024-02-29' }, `${T} = '2024-02-29'`],
  ['date >', { kind: 'compare', column: 'metric_time', op: '>', value: '2024-06-30' }, `${T} > '2024-06-30'`],
  ['date <=', { kind: 'compare', column: 'metric_time', op: '<=', value: '2024-06-30' }, `(${T} <= '2024-06-30' OR ${T} IS NULL)`],
  ['date != ', { kind: 'compare', column: 'metric_time', op: '!=', value: '2024-06-30' }, `(${T} <> '2024-06-30' OR ${T} IS NULL)`],
  ['date not a day', { kind: 'compare', column: 'metric_time', op: '>', value: 'soon' }, 'refused layerFilter'],
  ['date in with a blank', { kind: 'in', column: 'metric_time', values: ['2024-01-01', null], negate: false }, `(${T} IN ('2024-01-01') OR ${T} IS NULL)`],
  ['date not in with a blank', { kind: 'in', column: 'metric_time', values: ['2024-01-01', ''], negate: true }, `${T} NOT IN ('2024-01-01')`],
  ['date empty', { kind: 'empty', column: 'metric_time', negate: false }, `${T} IS NULL`],
  ['date not empty', { kind: 'empty', column: 'metric_time', negate: true }, `${T} IS NOT NULL`],
  ['a period', { kind: 'range', column: 'metric_time', from: '2024-03-31', to: '2024-12-31' }, `(${T} >= '2024-03-31' AND ${T} <= '2024-12-31')`],
  ['a period, from only', { kind: 'range', column: 'metric_time', from: '2023-02-14' }, `${T} >= '2023-02-14'`],
  ['a period on text', { kind: 'range', column: 'customer__region', from: '2024-01-01' }, 'refused periodNotDate'],
  ['a number dimension (dbt types none)', { kind: 'compare', column: 'amt', op: '>', value: 1 }, 'refused layerFilter'],
  ['an unknown dimension', { kind: 'compare', column: 'nope', op: '=', value: 'x' }, 'refused unknownColumn'],
  ['a row lock', { kind: 'in', column: 'customer__region', values: ['East'], negate: false, binary: true }, 'refused layerRowPolicy'],
];
for (const [name, f, want] of TABLE) ok(`filter ${name}: ${want}`, where(f) === want, where(f));
const refused = lit.whereText({ kind: 'compare', column: 'customer__region', op: '=', value: 'a"b' }, COLS, NAMES);
ok('a refusal is layerFilter naming dbt and the field', 'code' in refused && refused.code === 'layerFilter' && /dbt/.test(refused.message) && refused.params?.column === 'customer__region', show(refused));

// ── § fuzz ──
function xorshift(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}
const ASCII = Array.from({ length: 95 }, (_v, i) => String.fromCharCode(32 + i));
const REFUSED = ['{', '}', '\\', '"', '\u0000', '\n', '\r', '\t', '\u2028', '\u200b', '\ufeff', '\u00a0', '\u2018', '\u2019', '\u02bc', '\uff07', '\u0007'];
const UNICODE = ['\u00e9', '\u00df', '\u6771', '\u30a2', '\u0301', '\u00f1', '\u00ab', '\u00bb', '\u2014', '\u2026', '\u3001', '\u3002', '\u00bf', '\u203d', '\u2032', '\u2033', '\u2010', '\u066b', '\u0661', '\u03a9'];
const CLASS = ['abcXYZ019 _.,:;/&()#@+%-'.split(''), '\u00e9', '\u6771', '\u0301', '\u0661'].flat();
const CLASS_FRAGMENTS = ["'", "''", "' OR '", "') OR (", '--', ' AND ', "IS NULL'", "'; ", '%', '(', ')'];
const FRAGMENTS = ["'", "''", "' OR ", ' OR 1=1 --', '--', '/*', '*/', '{{', '}}', '{%', "') }}", ';', ' AND ', 'NULL', ' IS NULL', ')', '('];
function fuzz(n: number): Array<{ s: string; refused: boolean; roundTrips: boolean }> {
  const rand = xorshift(20261105);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const out: Array<{ s: string; refused: boolean; roundTrips: boolean }> = [];
  for (let i = 0; i < n; i += 1) {
    const len = rand() < 0.02 ? 195 + Math.floor(rand() * 10) : 1 + Math.floor(rand() * 24);
    // Half adversarial (anything), half inside the class, where a breakout would have to hide (quotes, OR, comments).
    const inClass = i % 2 === 1;
    let s = '';
    while (Array.from(s).length < len) {
      const r = rand();
      s += inClass ? (r < 0.5 ? pick(CLASS) : pick(CLASS_FRAGMENTS)) : r < 0.62 ? pick(ASCII) : r < 0.82 ? pick(UNICODE) : r < 0.97 ? pick(FRAGMENTS) : pick(REFUSED);
    }
    const eq = lit.whereText({ kind: 'compare', column: 'customer__region', op: '=', value: s }, COLS, NAMES);
    if (!('text' in eq)) { out.push({ s, refused: true, roundTrips: false }); continue; }
    const p = fake.parseTemplate(eq.text);
    const one = p.predicates.length === 1 && show(p.predicates[0]) === show({ ref: { name: 'customer__region', day: false }, op: '=', value: s });
    const t = 'x';
    const list = lit.whereText({ kind: 'in', column: 'customer__region', values: [s, t], negate: false }, COLS, NAMES);
    const pl = 'text' in list ? fake.parseTemplate(list.text) : null;
    const listed = !!pl && pl.predicates.length === 1 && show(pl.predicates[0]) === show({ ref: { name: 'customer__region', day: false }, in: s === t ? [s] : [s, t], not: false });
    out.push({ s, refused: false, roundTrips: one && listed });
  }
  return out;
}
const runs = fuzz(20_000);
const bad = runs.filter((r) => !r.refused && !r.roundTrips);
ok('fuzz: every string is encoded exactly or refused', bad.length === 0, show(bad.slice(0, 3).map((r) => r.s)));
const kept = runs.filter((r) => !r.refused);
ok(`\u2026and the fuzz means something: ${kept.length} of 20,000 encoded, ${kept.filter((r) => r.s.includes("'")).length} of them holding a quote`,
  kept.length > 9_000 && kept.filter((r) => r.s.includes("'")).length > 5_000 && runs.some((r) => r.refused));
ok('\u2026every string holding a refused character, or longer than 200, was refused', runs.filter((r) => REFUSED.some((c) => r.s.includes(c)) || Array.from(r.s).length > 200).every((r) => r.refused));

const rawWhere = (s: string): string => `{{ Dimension('customer__region') }} = '${s}'`;
ok('NEGATIVE CONTROL: a raw inliner breaks out of the template', fake.parseTemplate(rawWhere("x' OR 1=1 --")).predicates.length > 1, show(fake.parseTemplate(rawWhere("x' OR 1=1 --"))));
const naive = kept.filter((r) => r.s.includes("'")).filter((r) => {
  const p = fake.parseTemplate(rawWhere(r.s)).predicates;
  return !(p.length === 1 && show(p[0]) === show({ ref: { name: 'customer__region', day: false }, op: '=', value: r.s }));
});
ok(`NEGATIVE CONTROL: the fuzz's own check fails an encoder that does not double quotes (${naive.length} of its strings)`, naive.length > 1_000);
ok('NEGATIVE CONTROL: \u2026and the encoder writes the same value as one predicate', fake.parseTemplate(where({ kind: 'compare', column: 'customer__region', op: '=', value: "x' OR 1=1 --" })).predicates.length === 1);
ok('NEGATIVE CONTROL: a raw inliner of a Jinja tag puts it in the text', rawWhere('{{ env_var("DBT_TOKEN") }}').includes('{{ env_var') && !lit.literal('{{ env_var("DBT_TOKEN") }}', 'text').ok);

finish();
