// Self-check for src/transforms.ts — the PURE reversible transform pipeline. No
// Electron/fs stub needed (the module imports only src/parse + src/formula, both
// pure). Mirrors test-datasetStats.ts style: ok() counter, no framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled sibling of ../src/transforms.ts.
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const combine: typeof import('../src/data/combine') = require('../src/data/combine');
const { applyPipeline, sanitizeSteps } = transforms;
const { combineTables } = combine;
import type { TableData, TransformStep, Cell } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';

function approx(a: unknown, b: number): boolean {
  return typeof a === 'number' && Math.abs(a - b) < 1e-9;
}
function colType(cols: ParsedColumn[], name: string): string | undefined {
  return cols.find((c) => c.name === name)?.type;
}
function colValues(res: { columns: ParsedColumn[]; rows: Cell[][] }, name: string): Cell[] {
  const i = res.columns.findIndex((c) => c.name === name);
  return res.rows.map((r) => r[i]);
}

// A small fixture: sales by city with a leading-zero SKU id column.
function fixture(): TableData {
  return {
    columns: [
      { name: 'city', type: 'text' },
      { name: 'sku', type: 'text' }, // "007"-style — must never become a number
      { name: 'units', type: 'number' },
      { name: 'price', type: 'number' },
    ],
    rows: [
      ['Paris', '007', 3, 10],
      ['Berlin', '012', 5, 20],
      ['Paris', '007', 2, 10],
      ['Berlin', '020', 0, 5],
    ],
  };
}

// ── calculated_field: arithmetic + strict-number typing ──────────────────────
{
  const res = applyPipeline(fixture(), [
    { type: 'calculated_field', name: 'total', expression: 'units * price' },
  ]);
  ok('calc: appends column', res.columns.some((c) => c.name === 'total'));
  ok('calc: computed values', JSON.stringify(colValues(res, 'total')) === JSON.stringify([30, 100, 20, 0]));
  ok('calc: computed column typed number', colType(res.columns, 'total') === 'number');
  ok('calc: no warnings', res.warnings.length === 0);
}

// ── calculated_field: leading-zero output STAYS text (strict number rule) ─────
{
  const res = applyPipeline(fixture(), [
    { type: 'calculated_field', name: 'tag', expression: "concat('0', sku)" },
  ]);
  // Every value is a leading-zero identifier-shaped string → column must be text.
  ok('calc: leading-zero output stays text', colType(res.columns, 'tag') === 'text');
  ok('calc: leading-zero values intact', colValues(res, 'tag')[0] === '0007');
  // And the untouched sku column is still text with "007" intact.
  ok('calc: sku column untouched (still "007")', colValues(res, 'sku')[0] === '007');
}

// ── calculated_field: a high-precision quotient is a NUMBER, not text ─────────
// The regression that made an AI-built dashboard render an empty tile with no
// error anywhere. `revenue / units` is 54.142857142857146 — seventeen significant
// digits — and detectColumnType rejects >15 as unable to round-trip through a
// double, a guard meant for 20-digit ids in imported text. The column typed as
// `text`, `avg` over text is refused on purpose, and the chart drew nothing.
{
  const cols = [
    { name: 'revenue', type: 'number' as const },
    { name: 'units', type: 'number' as const },
  ];
  const rows = [[1137, 21], [1274, 22], [1411, 23]];
  const res = applyPipeline({ columns: cols, rows }, [
    { type: 'calculated_field', name: 'rpu', expression: 'revenue / units' },
  ]);
  ok('calc: a high-precision quotient types as NUMBER, not text',
    colType(res.columns, 'rpu') === 'number', colType(res.columns, 'rpu'));
  // The point of the type: an aggregate over it is possible at all.
  const vals = colValues(res, 'rpu');
  ok('calc: …and its values are numbers the app can aggregate',
    vals.every((v) => typeof v === 'number'), JSON.stringify(vals));
  ok('calc: …with full precision kept, not rounded to fit a guard',
    vals[0] === 1137 / 21, String(vals[0]));
}

// ── calculated_field: the strict-number rule still governs STRING results ─────
// The fix above must not become "computed columns are always numeric": a result
// that is identifier-shaped text is exactly what detectColumnType is for.
{
  const res = applyPipeline(fixture(), [
    { type: 'calculated_field', name: 'z', expression: "concat('00', sku)" },
  ]);
  ok('calc: an identifier-shaped string result is still text', colType(res.columns, 'z') === 'text');
}

// ── calculated_field: blank/dup name + compile error → warn + skip ───────────
{
  const blank = applyPipeline(fixture(), [{ type: 'calculated_field', name: '  ', expression: '1' }]);
  ok('calc: blank name skipped', blank.columns.length === 4 && blank.warnings.length === 1);
  const dup = applyPipeline(fixture(), [{ type: 'calculated_field', name: 'city', expression: '1' }]);
  ok('calc: dup name skipped', dup.columns.length === 4 && dup.warnings.some((w) => w.includes('already exists')));
  const bad = applyPipeline(fixture(), [{ type: 'calculated_field', name: 'x', expression: '1 +' }]);
  ok('calc: compile error skipped', bad.columns.length === 4 && bad.warnings.length === 1);
}

// ── filter: numeric + string + emptiness ─────────────────────────────────────
{
  const gt = applyPipeline(fixture(), [{ type: 'filter', column: 'units', op: '>', value: 2 }]);
  ok('filter: numeric >', gt.rowCount === 2 && colValues(gt, 'units').every((v) => typeof v === 'number' && v > 2));
  const eq = applyPipeline(fixture(), [{ type: 'filter', column: 'city', op: '=', value: 'Paris' }]);
  ok('filter: string =', eq.rowCount === 2 && colValues(eq, 'city').every((v) => v === 'Paris'));
  const has = applyPipeline(fixture(), [{ type: 'filter', column: 'sku', op: 'contains', value: '01' }]);
  ok('filter: contains', has.rowCount === 1 && colValues(has, 'sku')[0] === '012');
}
{
  const withEmpty: TableData = {
    columns: [{ name: 'a', type: 'text' }],
    rows: [['x'], [''], [null], ['y']],
  };
  const nonEmpty = applyPipeline(withEmpty, [{ type: 'filter', column: 'a', op: 'not_empty' }]);
  ok('filter: not_empty', nonEmpty.rowCount === 2);
  const empty = applyPipeline(withEmpty, [{ type: 'filter', column: 'a', op: 'is_empty' }]);
  ok('filter: is_empty', empty.rowCount === 2);
}

// ── filter: in / not in — the multi-value operator ───────────────────────────
//
// The property that matters most is that `in` is EXACTLY a disjunction of `=`.
// So rather than only asserting row counts, several of these run the equivalent
// `=` steps and compare, which is the same differential idea the resident suites
// use — a hand-written expectation can agree with a bug, an equivalence can't.
{
  const inTwo = applyPipeline(fixture(), [
    { type: 'filter', column: 'city', op: 'in', values: ['Paris', 'Berlin'] },
  ]);
  ok('filter in: matches any listed value', inTwo.rowCount === 4);
  ok('filter in: no warnings', inTwo.warnings.length === 0);

  // in ['Paris'] must be row-identical to = 'Paris'.
  const inOne = applyPipeline(fixture(), [{ type: 'filter', column: 'city', op: 'in', values: ['Paris'] }]);
  const eqOne = applyPipeline(fixture(), [{ type: 'filter', column: 'city', op: '=', value: 'Paris' }]);
  ok(
    'filter in: a one-entry list is byte-identical to `=`',
    JSON.stringify(inOne.rows) === JSON.stringify(eqOne.rows),
  );

  // A value not present changes nothing; duplicates do not duplicate rows.
  const withMiss = applyPipeline(fixture(), [
    { type: 'filter', column: 'city', op: 'in', values: ['Paris', 'Nowhere', 'Paris'] },
  ]);
  ok(
    'filter in: absent and duplicate entries neither add nor drop rows',
    JSON.stringify(withMiss.rows) === JSON.stringify(inOne.rows),
  );

  const notIn = applyPipeline(fixture(), [{ type: 'filter', column: 'city', op: 'not in', values: ['Paris'] }]);
  ok('filter not in: keeps everything else', notIn.rowCount === 2 && colValues(notIn, 'city').every((v) => v === 'Berlin'));
  ok('filter not in: partitions the table with `in`', notIn.rowCount + inOne.rowCount === fixture().rows.length);
}

// ── filter in: numbers cast on the DECLARED type, never on inference ─────────
{
  const nums = applyPipeline(fixture(), [{ type: 'filter', column: 'units', op: 'in', values: [3, 5] }]);
  ok('filter in: numeric column matches numeric entries', nums.rowCount === 2);

  // A number column accepts a stringified entry (coerceValue is the same gate
  // `=` uses), so '3' finds the row 3 does.
  const asStr = applyPipeline(fixture(), [{ type: 'filter', column: 'units', op: 'in', values: ['3'] }]);
  ok("filter in: '3' matches the number 3, exactly as `=` does", asStr.rowCount === 1);

  // …but a TEXT column is never cast, so '007' and 7 stay different values.
  const sku = applyPipeline(fixture(), [{ type: 'filter', column: 'sku', op: 'in', values: ['007'] }]);
  ok("filter in: text column matches '007' verbatim", sku.rowCount === 2);
  const skuNum = applyPipeline(fixture(), [{ type: 'filter', column: 'sku', op: 'in', values: [7] }]);
  ok("filter in: 7 does NOT match the text '007'", skuNum.rowCount === 0);

  // An entry that cannot be a finite number can never equal a numeric cell —
  // the same rule that makes `units = 'abc'` keep zero rows.
  const junk = applyPipeline(fixture(), [{ type: 'filter', column: 'units', op: 'in', values: ['abc'] }]);
  ok('filter in: an uncoercible numeric entry matches nothing', junk.rowCount === 0);
  const junkNot = applyPipeline(fixture(), [{ type: 'filter', column: 'units', op: 'not in', values: ['abc'] }]);
  ok('filter not in: …and its negation keeps every row', junkNot.rowCount === fixture().rows.length);
}

// ── filter in: the empty list SKIPS, it does not match zero rows ─────────────
{
  const src = fixture();
  const none = applyPipeline(src, [{ type: 'filter', column: 'city', op: 'in', values: [] }]);
  ok('filter in: an empty list keeps every row (skipped, not zero-matched)', none.rowCount === src.rows.length);
  ok('filter in: …and says so with a warning', none.warnings.length === 1 && none.warnings[0].includes('no values'));

  const missing = applyPipeline(src, [{ type: 'filter', column: 'city', op: 'in' }]);
  ok('filter in: an omitted `values` behaves like an empty one', missing.rowCount === src.rows.length && missing.warnings.length === 1);

  const notNone = applyPipeline(src, [{ type: 'filter', column: 'city', op: 'not in', values: [] }]);
  ok('filter not in: an empty list also skips rather than dropping everything', notNone.rowCount === src.rows.length);
}

// ── filter in: empties, and why `not in` is not `!=` ────────────────────────
{
  const withEmpty: TableData = {
    columns: [{ name: 'a', type: 'text' }],
    rows: [['x'], [''], [null], ['y']],
  };
  // A null cell stringifies to '' — the same rule `= ''` follows today.
  const blank = applyPipeline(withEmpty, [{ type: 'filter', column: 'a', op: 'in', values: [''] }]);
  const blankEq = applyPipeline(withEmpty, [{ type: 'filter', column: 'a', op: '=', value: '' }]);
  ok('filter in: null and "" both match an empty entry, as `=` does', blank.rowCount === 2);
  ok('filter in: …byte-identically to `=`', JSON.stringify(blank.rows) === JSON.stringify(blankEq.rows));

  // `not in` is the EXACT complement of `in`. `!=` is not the complement of `=`
  // on a number column (a null cell fails BOTH), so this is a real difference
  // and it is pinned here on purpose.
  const nums: TableData = {
    columns: [{ name: 'n', type: 'number' }],
    rows: [[1], [2], [null]],
  };
  const inN = applyPipeline(nums, [{ type: 'filter', column: 'n', op: 'in', values: [1] }]);
  const notInN = applyPipeline(nums, [{ type: 'filter', column: 'n', op: 'not in', values: [1] }]);
  const neN = applyPipeline(nums, [{ type: 'filter', column: 'n', op: '!=', value: 1 }]);
  ok('filter in: a null numeric cell is in no list', inN.rowCount === 1);
  ok('filter not in: …so it SURVIVES the negation', notInN.rowCount === 2);
  ok('filter not in: `!=` drops that null instead — the two differ by design', neN.rowCount === 1);
  ok('filter not in: in + not in still covers every row', inN.rowCount + notInN.rowCount === nums.rows.length);
}

// ── group_aggregate: sum / avg / count / min / max ───────────────────────────
{
  const res = applyPipeline(fixture(), [
    {
      type: 'group_aggregate',
      groupBy: ['city'],
      aggregations: [
        { column: 'units', fn: 'sum', as: 'total_units' },
        { column: 'price', fn: 'avg', as: 'avg_price' },
        { column: 'sku', fn: 'count', as: 'n' },
        { column: 'units', fn: 'min', as: 'min_units' },
        { column: 'units', fn: 'max', as: 'max_units' },
      ],
    },
  ]);
  ok('group: collapses to one row per group', res.rowCount === 2);
  ok('group: groupBy column kept', res.columns[0].name === 'city');
  const paris = res.rows.find((r) => r[0] === 'Paris') as Cell[];
  const berlin = res.rows.find((r) => r[0] === 'Berlin') as Cell[];
  // Paris: units 3+2=5, price avg (10+10)/2=10, count 2, min 2, max 3
  ok('group: sum correct', paris[1] === 5);
  ok('group: avg correct', approx(paris[2], 10));
  ok('group: count correct', paris[3] === 2);
  ok('group: min correct', paris[4] === 2);
  ok('group: max correct', paris[5] === 3);
  // Berlin: units 5+0=5, price (20+5)/2=12.5
  ok('group: avg with zero', approx(berlin[2], 12.5));
  ok('group: aggregation columns typed number', colType(res.columns, 'total_units') === 'number' && colType(res.columns, 'avg_price') === 'number');
  ok('group: no warnings', res.warnings.length === 0);
}

// ── dedupe ───────────────────────────────────────────────────────────────────
{
  const all = applyPipeline(fixture(), [{ type: 'dedupe' }]);
  ok('dedupe: all-columns keeps distinct rows', all.rowCount === 4); // no fully-identical rows
  const byCity = applyPipeline(fixture(), [{ type: 'dedupe', columns: ['city'] }]);
  ok('dedupe: by chosen column keeps first per key', byCity.rowCount === 2);
  ok('dedupe: keeps first occurrence', colValues(byCity, 'units')[0] === 3);
}

// ── fill_empty ───────────────────────────────────────────────────────────────
{
  const gapped: TableData = {
    columns: [{ name: 'region', type: 'text' }],
    rows: [['N'], [''], [null], ['S']],
  };
  const filled = applyPipeline(gapped, [{ type: 'fill_empty', column: 'region', value: 'Unknown' }]);
  ok('fill_empty: fills blanks', colValues(filled, 'region').every((v) => v != null && v !== ''));
  ok('fill_empty: keeps existing', colValues(filled, 'region')[0] === 'N');
}

// ── trim ─────────────────────────────────────────────────────────────────────
{
  const padded: TableData = {
    columns: [{ name: 'name', type: 'text' }, { name: 'note', type: 'text' }],
    rows: [['  Alice  ', ' hi ']],
  };
  const oneCol = applyPipeline(padded, [{ type: 'trim', column: 'name' }]);
  ok('trim: single column', colValues(oneCol, 'name')[0] === 'Alice' && colValues(oneCol, 'note')[0] === ' hi ');
  const allText = applyPipeline(padded, [{ type: 'trim' }]);
  ok('trim: all text columns', colValues(allText, 'name')[0] === 'Alice' && colValues(allText, 'note')[0] === 'hi');
}

// ── drop_column / rename_column ──────────────────────────────────────────────
{
  const dropped = applyPipeline(fixture(), [{ type: 'drop_column', column: 'price' }]);
  ok('drop_column: removes column', !dropped.columns.some((c) => c.name === 'price') && dropped.columns.length === 3);
  ok('drop_column: removes the cell too', dropped.rows[0].length === 3);
  const renamed = applyPipeline(fixture(), [{ type: 'rename_column', from: 'units', to: 'quantity' }]);
  ok('rename_column: renames', renamed.columns.some((c) => c.name === 'quantity') && !renamed.columns.some((c) => c.name === 'units'));
  ok('rename_column: values preserved', colValues(renamed, 'quantity')[0] === 3);
}

// ── Missing column → warning, never throws ───────────────────────────────────
{
  const res = applyPipeline(fixture(), [{ type: 'filter', column: 'nope', op: '=', value: 1 }]);
  ok('missing column: warns', res.warnings.length === 1 && res.warnings[0].includes('nope'));
  ok('missing column: passes data through unchanged', res.rowCount === 4);
  const unknown = applyPipeline(fixture(), [{ type: 'frobnicate' } as unknown as TransformStep]);
  ok('unknown step type: warns + skips', unknown.rowCount === 4 && unknown.warnings.length === 1);
}

// ── Multi-step pipeline (2-3 steps) ──────────────────────────────────────────
{
  const steps: TransformStep[] = [
    { type: 'calculated_field', name: 'total', expression: 'units * price' },
    { type: 'filter', column: 'total', op: '>', value: 0 },
    { type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'total', fn: 'sum', as: 'revenue' }] },
  ];
  const res = applyPipeline(fixture(), steps);
  // Rows with total>0: Paris 30, Paris 20 (=50), Berlin 100 (Berlin 0 filtered out).
  const paris = res.rows.find((r) => r[0] === 'Paris') as Cell[];
  const berlin = res.rows.find((r) => r[0] === 'Berlin') as Cell[];
  ok('pipeline: 3 steps produce grouped revenue', res.rowCount === 2);
  ok('pipeline: Paris revenue', paris[1] === 50);
  ok('pipeline: Berlin revenue', berlin[1] === 100);
}

// ── Reversibility: removing a step recomputes from source ────────────────────
{
  const src = fixture();
  const A: TransformStep = { type: 'calculated_field', name: 'total', expression: 'units * price' };
  const B: TransformStep = { type: 'filter', column: 'total', op: '>', value: 10 };
  const C: TransformStep = { type: 'drop_column', column: 'sku' };

  const withB = applyPipeline(src, [A, B, C]);
  const withoutB = applyPipeline(src, [A, C]); // remove B
  const readdB = applyPipeline(src, [A, B, C]); // re-add → identical to withB

  ok('reversibility: remove B differs from with B', withB.rowCount !== withoutB.rowCount);
  ok('reversibility: re-add B == original with B', JSON.stringify(readdB) === JSON.stringify(withB));
  // Removing B must equal a pipeline that never had B (recomputed purely from source).
  const neverB = applyPipeline(fixture(), [A, C]);
  ok('reversibility: remove-B == never-had-B', JSON.stringify(withoutB) === JSON.stringify(neverB));
}

// ── Source immutability: source object unchanged after apply ─────────────────
{
  const src = fixture();
  const snapshot = JSON.stringify(src);
  applyPipeline(src, [
    { type: 'calculated_field', name: 'total', expression: 'units * price' },
    { type: 'drop_column', column: 'city' },
    { type: 'trim' },
  ]);
  ok('source immutability: input untouched after apply', JSON.stringify(src) === snapshot);
}

// ── sanitizeSteps: drops unknown types/fields ────────────────────────────────
{
  const raw = [
    { type: 'filter', column: 'a', op: '>', value: 1 },
    { type: 'evil', column: 'a' }, // unknown type → dropped
    { type: 'filter', column: 'a', op: 'bogus_op' }, // bad op → dropped
    { type: 'calculated_field', name: 'x', expression: 'a + 1', extra: 'ignored' }, // extra field stripped
    'not an object', // dropped
    { type: 'drop_column' }, // missing required column → dropped
  ];
  const clean = sanitizeSteps(raw);
  ok('sanitize: keeps only valid steps', clean.length === 2);
  ok('sanitize: strips unknown fields', !('extra' in (clean[1] as unknown as Record<string, unknown>)));
  ok('sanitize: non-array → []', sanitizeSteps('nope').length === 0 && sanitizeSteps(null).length === 0);
}

// ── sanitizeSteps: the `values` list is untrusted input ─────────────────────
//
// `values` reaches the SQL builders as an attacker-influenced NUMBER of bound
// parameters, so what survives this whitelist is a security boundary, not a
// convenience.
{
  const vals = (raw: unknown): unknown =>
    (sanitizeSteps([{ type: 'filter', column: 'a', op: 'in', values: raw }])[0] as { values?: unknown }).values;

  ok('sanitize: `in` is a valid operator', sanitizeSteps([{ type: 'filter', column: 'a', op: 'in', values: ['x'] }]).length === 1);
  ok('sanitize: `not in` is a valid operator', sanitizeSteps([{ type: 'filter', column: 'a', op: 'not in', values: ['x'] }]).length === 1);
  ok('sanitize: keeps a list of strings/numbers/nulls', JSON.stringify(vals(['a', 1, null])) === JSON.stringify(['a', 1, null]));
  ok('sanitize: drops non-Cell entries, keeping the rest', JSON.stringify(vals(['a', { evil: 1 }, ['nested'], true, undefined, 2])) === JSON.stringify(['a', 2]));
  ok('sanitize: a non-array `values` is dropped entirely', vals('CA,WA') === undefined);
  ok('sanitize: an empty list survives (the pipeline skips it with a warning)', JSON.stringify(vals([])) === JSON.stringify([]));

  // `value` and `values` are independent — adding one must not disturb the other.
  const both = sanitizeSteps([{ type: 'filter', column: 'a', op: '=', value: 'x', values: ['y'] }])[0] as {
    value?: unknown;
    values?: unknown;
  };
  ok('sanitize: `value` still survives alongside `values`', both.value === 'x' && JSON.stringify(both.values) === JSON.stringify(['y']));
  const scalarOnly = sanitizeSteps([{ type: 'filter', column: 'a', op: '=', value: 'x' }])[0] as unknown as Record<string, unknown>;
  ok('sanitize: a step with no `values` does not grow one', !('values' in scalarOnly));
}

// ── combineTables: append ────────────────────────────────────────────────────
{
  const left: TableData = {
    columns: [{ name: 'city', type: 'text' }, { name: 'units', type: 'number' }],
    rows: [['Paris', 3]],
  };
  const right: TableData = {
    columns: [{ name: 'city', type: 'text' }, { name: 'price', type: 'number' }],
    rows: [['Berlin', 20]],
  };
  const res = combineTables(left, right, 'append');
  ok('append: unions columns by name', res.columns.map((c) => c.name).join(',') === 'city,units,price');
  ok('append: stacks rows', res.rowCount === 2);
  ok('append: missing cell → null', res.rows[0][2] === null && res.rows[1][1] === null);
  ok('append: re-detects types', colType(res.columns, 'units') === 'number' && colType(res.columns, 'price') === 'number');
}

// ── combineTables: join ──────────────────────────────────────────────────────
{
  const left: TableData = {
    columns: [{ name: 'id', type: 'text' }, { name: 'name', type: 'text' }],
    rows: [['1', 'Alice'], ['2', 'Bob'], ['3', 'Carol']],
  };
  const right: TableData = {
    columns: [{ name: 'uid', type: 'text' }, { name: 'score', type: 'number' }],
    rows: [['1', 90], ['2', 80]],
  };
  const res = combineTables(left, right, 'join', { left: 'id', right: 'uid' });
  ok('join: inner join drops unmatched left rows', res.rowCount === 2);
  ok('join: concatenates right non-key columns', res.columns.map((c) => c.name).join(',') === 'id,name,score');
  ok('join: matched values', colValues(res, 'score')[0] === 90 && colValues(res, 'name')[0] === 'Alice');
  ok('join: score column typed number', colType(res.columns, 'score') === 'number');
  const noKey = combineTables(left, right, 'join');
  ok('join: missing on-pair → warning, no throw', noKey.warnings.length === 1);
}

// ── combineTables: join OUTPUT is bounded during the build (no cartesian OOM) ──
{
  // A many-to-many join on a duplicate key: 400 left × 400 right all share key "A"
  // → unbounded output would be 160,000 rows. With a small limit the build must
  // stop at the cap and flag it, never materialize the full product.
  const left: TableData = {
    columns: [{ name: 'k', type: 'text' }, { name: 'l', type: 'number' }],
    rows: Array.from({ length: 400 }, (_, i) => ['A', i] as Cell[]),
  };
  const right: TableData = {
    columns: [{ name: 'k', type: 'text' }, { name: 'r', type: 'number' }],
    rows: Array.from({ length: 400 }, (_, i) => ['A', i] as Cell[]),
  };
  const res = combineTables(left, right, 'join', { left: 'k', right: 'k' }, 1000);
  ok('join: output capped at limit (no full cartesian product)', res.rowCount === 1000);
  ok('join: cap surfaces a warning', res.warnings.some((w) => /row cap/i.test(w)));
  // A small many-to-many well under the cap passes through untouched, no warning.
  const smallL: TableData = { columns: left.columns, rows: left.rows.slice(0, 10) };
  const smallR: TableData = { columns: right.columns, rows: right.rows.slice(0, 10) };
  const small = combineTables(smallL, smallR, 'join', { left: 'k', right: 'k' }, 1000);
  ok('join: under limit → no cap warning', small.warnings.length === 0 && small.rowCount === 100);
}

// ── group_aggregate: min/max over a LARGE group uses reduce, not arg-spread ────
{
  // One group with 200k rows: Math.min(...nums) would throw RangeError (arg-spread
  // limit), applyPipeline would skip the step and return the un-aggregated table.
  // reduce must produce the correct single-row min/max instead.
  const big: TableData = {
    columns: [{ name: 'g', type: 'text' }, { name: 'v', type: 'number' }],
    rows: Array.from({ length: 200_000 }, (_, i) => ['A', i] as Cell[]),
  };
  const res = applyPipeline(big, [
    { type: 'group_aggregate', groupBy: ['g'], aggregations: [
      { column: 'v', fn: 'min', as: 'mn' },
      { column: 'v', fn: 'max', as: 'mx' },
    ] },
  ]);
  ok('group: large-group min/max does not throw / skip', res.rowCount === 1);
  ok('group: large-group min correct', res.rows[0][1] === 0);
  ok('group: large-group max correct', res.rows[0][2] === 199_999);
}

if (failureCount()) {
  console.error('\n' + failureCount() + ' transforms check(s) FAILED');
  process.exit(1);
}
console.log('\nAll transforms checks passed.');
