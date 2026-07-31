// Self-check for src/datasetStats.ts — the PURE per-column summaries + quality
// issue detection. No Electron stub needed (the module imports nothing from
// electron/fs/DOM). Mirrors test-datasets.ts style: ok() helper, no framework.

export {}; // module scope — sibling test scripts share top-level names

// ponytail: compiled sibling of ../src/datasetStats.ts.
const stats: typeof import('../src/datasetStats') = require('../src/datasetStats');
const { computeColumnSummary, findQualityIssues } = stats;

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

// ── computeColumnSummary: number column ──────────────────────────────────────
const numSummary = computeColumnSummary(
  { name: 'pop', type: 'number' },
  [10, 20, 30, null, 40],
);
ok('number: count over finite cells', numSummary.count === 4);
ok('number: min', numSummary.min === 10);
ok('number: max', numSummary.max === 40);
ok('number: mean', approx(numSummary.mean as number, 25));
ok('number: nonEmpty ignores null', numSummary.nonEmpty === 4);
ok('number: no distinct/mostCommon set', numSummary.distinct === undefined && numSummary.mostCommon === undefined);

// number column, all-empty → count 0, no min/max/mean
const emptyNum = computeColumnSummary({ name: 'x', type: 'number' }, [null, null]);
ok('number all-empty: count 0', emptyNum.count === 0);
ok('number all-empty: no min/max/mean', emptyNum.min === undefined && emptyNum.max === undefined && emptyNum.mean === undefined);
ok('number all-empty: nonEmpty 0', emptyNum.nonEmpty === 0);

// number with a real zero (0 is a value, not empty)
const zeroNum = computeColumnSummary({ name: 'z', type: 'number' }, [0, 0, 5]);
ok('number: zero counts as non-empty', zeroNum.nonEmpty === 3 && zeroNum.count === 3);
ok('number: min respects zero', zeroNum.min === 0);

// ── computeColumnSummary: text column ────────────────────────────────────────
const textSummary = computeColumnSummary(
  { name: 'city', type: 'text' },
  ['Paris', 'Berlin', 'Paris', '', null, 'Paris'],
);
ok('text: distinct excludes empties', textSummary.distinct === 2);
ok('text: mostCommon value', textSummary.mostCommon?.value === 'Paris');
ok('text: mostCommon count', textSummary.mostCommon?.count === 3);
ok('text: nonEmpty excludes ""/null', textSummary.nonEmpty === 4);
ok('text: no numeric stats', textSummary.min === undefined && textSummary.count === undefined);

// text column, all-empty → distinct 0, mostCommon null
const emptyText = computeColumnSummary({ name: 't', type: 'text' }, ['', null, '  ']);
ok('text all-empty: distinct 0', emptyText.distinct === 0);
ok('text all-empty: mostCommon null', emptyText.mostCommon === null);
ok('text all-empty: whitespace counts as empty', emptyText.nonEmpty === 0);

// date column behaves like text (distinct + mode)
const dateSummary = computeColumnSummary(
  { name: 'day', type: 'date' },
  ['2024-01-01', '2024-01-02', '2024-01-01'],
);
ok('date: distinct', dateSummary.distinct === 2);
ok('date: mostCommon', dateSummary.mostCommon?.value === '2024-01-01' && dateSummary.mostCommon?.count === 2);

// empty input array
const noneSummary = computeColumnSummary({ name: 'e', type: 'number' }, []);
ok('empty input: nonEmpty 0', noneSummary.nonEmpty === 0);
ok('empty input: count 0', noneSummary.count === 0);

// ── findQualityIssues: empty_heavy at the 0.5 boundary ───────────────────────
const cols = [
  { name: 'a', type: 'text' as const },
  { name: 'b', type: 'text' as const },
];
// col 'a': 2 of 4 empty → exactly 0.5 → flagged. col 'b': all filled, all same.
const boundaryRows: (string | number | null)[][] = [
  ['x', 'same'],
  ['', 'same'],
  ['y', 'same'],
  [null, 'same'],
];
const boundaryIssues = findQualityIssues(cols, boundaryRows);
ok('empty_heavy: fires at exactly 0.5 ratio',
  boundaryIssues.some((i) => i.kind === 'empty_heavy' && i.column === 'a'));

// just below the boundary → NOT flagged (1 of 4 empty = 0.25)
const belowRows: (string | number | null)[][] = [['x', 'p'], ['', 'q'], ['y', 'r'], ['z', 's']];
const belowIssues = findQualityIssues(cols, belowRows);
ok('empty_heavy: does NOT fire below 0.5',
  !belowIssues.some((i) => i.kind === 'empty_heavy'));

// ── findQualityIssues: constant_column ───────────────────────────────────────
ok('constant_column: single-value column flagged',
  boundaryIssues.some((i) => i.kind === 'constant_column' && i.column === 'b'));
ok('constant_column: varied column NOT flagged',
  !boundaryIssues.some((i) => i.kind === 'constant_column' && i.column === 'a'));

// a column that is entirely empty is NOT "constant" (no non-empty value)
const allEmptyCol = findQualityIssues(
  [{ name: 'c', type: 'text' }],
  [[''], [null], ['']],
);
ok('constant_column: all-empty column not flagged constant',
  !allEmptyCol.some((i) => i.kind === 'constant_column'));

// ── findQualityIssues: duplicate_rows ────────────────────────────────────────
const dupRows: (string | number | null)[][] = [
  ['Paris', 1],
  ['Berlin', 2],
  ['Paris', 1], // exact dup of row 0
  ['Paris', 3], // NOT a dup (different number)
];
const dupCols = [
  { name: 'city', type: 'text' as const },
  { name: 'n', type: 'number' as const },
];
const dupIssues = findQualityIssues(dupCols, dupRows);
ok('duplicate_rows: detects one fully-identical row',
  dupIssues.some((i) => i.kind === 'duplicate_rows' && i.detail.includes('1')));

const noDup = findQualityIssues(dupCols, [['a', 1], ['b', 2]]);
ok('duplicate_rows: none reported when all rows unique',
  !noDup.some((i) => i.kind === 'duplicate_rows'));

// ── empty table input ────────────────────────────────────────────────────────
const emptyIssues = findQualityIssues(cols, []);
ok('empty table: no issues', emptyIssues.length === 0);

if (failures) {
  console.error('\n' + failures + ' datasetStats check(s) FAILED');
  process.exit(1);
}
console.log('\nAll datasetStats checks passed.');
