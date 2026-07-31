// Self-check for src/metricValue.ts — the PURE metric helper. No Electron, no fs:
// computeMetric operates on plain columns/rows, so this runs under plain `node`.
// No framework — the shared ok(label, cond) harness the sibling test scripts use.

export {}; // module scope — sibling test scripts share top-level names

const { computeMetric } = require('../src/metricValue') as typeof import('../src/metricValue');

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

type Col = { name: string; type: 'text' | 'number' | 'date' };
type Cell = string | number | null;

// A mixed table: a numeric column with a hole + a non-numeric text cell excluded
// by coercion is impossible (coercion nulls it), so we model the realistic stored
// shape — numeric column holds numbers | null; text column holds strings | null.
const columns: Col[] = [
  { name: 'city', type: 'text' },
  { name: 'pop', type: 'number' },
];
const rows: Cell[][] = [
  ['Paris', 100],
  ['Berlin', 200],
  ['Rome', null], // empty numeric cell — ignored by sum/avg/min/max, NOT by count
  ['Madrid', 50],
];

// ── sum / avg / min / max over finite numeric cells ─────────────────────────
ok('sum ignores empty cells', computeMetric(columns, rows, { column: 'pop', aggregation: 'sum' }) === 350);
ok('avg divides by numeric-cell count only', computeMetric(columns, rows, { column: 'pop', aggregation: 'avg' }) === 350 / 3);
ok('min over numeric cells', computeMetric(columns, rows, { column: 'pop', aggregation: 'min' }) === 50);
ok('max over numeric cells', computeMetric(columns, rows, { column: 'pop', aggregation: 'max' }) === 200);

// ── count = non-empty cell count (text included, empties excluded) ───────────
ok('count on a text column counts non-empty', computeMetric(columns, rows, { column: 'city', aggregation: 'count' }) === 4);
ok('count on a numeric column excludes the empty', computeMetric(columns, rows, { column: 'pop', aggregation: 'count' }) === 3);

// count including a text column with a blank/whitespace cell (empty) + a real one
{
  const cols: Col[] = [{ name: 'tag', type: 'text' }];
  const r: Cell[][] = [['a'], [''], ['   '], [null], ['b']];
  ok('count treats blank/whitespace/null as empty', computeMetric(cols, r, { column: 'tag', aggregation: 'count' }) === 2);
}

// ── zero is a real value (not empty) ─────────────────────────────────────────
{
  const cols: Col[] = [{ name: 'n', type: 'number' }];
  const r: Cell[][] = [[0], [0], [10]];
  ok('sum treats 0 as a real value', computeMetric(cols, r, { column: 'n', aggregation: 'sum' }) === 10);
  ok('count counts 0 cells', computeMetric(cols, r, { column: 'n', aggregation: 'count' }) === 3);
  ok('min sees 0', computeMetric(cols, r, { column: 'n', aggregation: 'min' }) === 0);
}

// ── all-empty numeric column → null (never NaN) ──────────────────────────────
{
  const cols: Col[] = [{ name: 'n', type: 'number' }];
  const empty: Cell[][] = [[null], [null], ['']];
  const s = computeMetric(cols, empty, { column: 'n', aggregation: 'sum' });
  ok('sum of all-empty → null (not 0, not NaN)', s === null);
  ok('avg of all-empty → null (not NaN)', computeMetric(cols, empty, { column: 'n', aggregation: 'avg' }) === null);
  ok('min of all-empty → null', computeMetric(cols, empty, { column: 'n', aggregation: 'min' }) === null);
  ok('max of all-empty → null', computeMetric(cols, empty, { column: 'n', aggregation: 'max' }) === null);
  ok('count of all-empty → 0', computeMetric(cols, empty, { column: 'n', aggregation: 'count' }) === 0);
}

// ── non-numeric cells ignored by sum/avg/min/max ─────────────────────────────
// A stored text column would hold strings; sum/avg/min/max see no JS numbers → null.
{
  const cols: Col[] = [{ name: 'label', type: 'text' }];
  const r: Cell[][] = [['x'], ['y'], ['z']];
  ok('sum of a text column → null (no numeric cells)', computeMetric(cols, r, { column: 'label', aggregation: 'sum' }) === null);
  ok('avg of a text column → null', computeMetric(cols, r, { column: 'label', aggregation: 'avg' }) === null);
}

// mixed number/text in one array (defensive — a corrupt/hand-authored dataset)
{
  const cols: Col[] = [{ name: 'v', type: 'number' }];
  const r: Cell[][] = [[10], ['oops'], [20], [NaN], [Infinity]];
  ok('sum ignores strings, NaN and Infinity', computeMetric(cols, r, { column: 'v', aggregation: 'sum' }) === 30);
  ok('count includes the string cell (non-empty)', computeMetric(cols, r, { column: 'v', aggregation: 'count' }) === 5);
}

// ── unknown column / unknown agg / no rows → null ────────────────────────────
ok('unknown column → null', computeMetric(columns, rows, { column: 'nope', aggregation: 'sum' }) === null);
ok('unknown aggregation → null', computeMetric(columns, rows, { column: 'pop', aggregation: 'median' as any }) === null);
ok('no rows → null (sum)', computeMetric(columns, [], { column: 'pop', aggregation: 'sum' }) === null);
ok('no rows → 0 (count)', computeMetric(columns, [], { column: 'pop', aggregation: 'count' }) === 0);

// ── leading-zero identifier column stays safe ────────────────────────────────
// parse.ts classifies "007"/zip/SKU as TEXT, so a stored id column holds STRINGS.
// sum/avg/min/max must NOT coerce "007" → 7; they see no JS numbers → null.
{
  const cols: Col[] = [{ name: 'zip', type: 'text' }];
  const r: Cell[][] = [['007'], ['012'], ['90210']];
  ok('sum of a leading-zero text column → null (no coercion to 7/12)', computeMetric(cols, r, { column: 'zip', aggregation: 'sum' }) === null);
  ok('count of the id column counts all non-empty', computeMetric(cols, r, { column: 'zip', aggregation: 'count' }) === 3);
  ok('min of the id text column → null', computeMetric(cols, r, { column: 'zip', aggregation: 'min' }) === null);
}

if (failures) { console.error('\n' + failures + ' metricValue check(s) FAILED'); process.exit(1); }
console.log('\nAll metricValue checks passed.');
