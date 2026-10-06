// Self-check pinning the AI dock's central safety claim (Task 3,
// docs/superpowers/plans/2026-08-09-ai-dock.md): a proposal is appended as
// ONE step (`addDatasetStep`), never a whole-pipeline replace
// (`setDatasetSteps`), and removing that one step is a perfect undo.
//
// The guarantee actually lives in src/transforms.ts's applyPipeline, which
// folds an ordered `steps` array over a FRESH clone of the immutable `source`
// on every call (src/datasets.ts's updateSteps does exactly this — recompute
// from `existing.source`, never mutate it). So the dock's "append one step,
// remove it to undo" story reduces to a pure property of applyPipeline that
// needs no fs stub to test. Mirrors test-transforms.ts's style: ok()
// counter, no framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled sibling of ../src/transforms.ts.
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const { applyPipeline } = transforms;
import type { TableData, TransformStep, Cell } from '../src/data/transforms';

// A fixed, immutable source — exactly what the app stores once a dataset has
// steps (src/datasets.ts's `existing.source`, frozen the first time steps
// exist, never mutated again).
const source: TableData = {
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

// A three-step pipeline the user has already built by hand — a filter, a
// calculated field, and a rename. Order matters (rename must come after the
// filter reads 'city', and the calc field reads columns the filter kept).
const threeSteps: TransformStep[] = [
  { type: 'filter', column: 'units', op: '>', value: 0 } as TransformStep,
  { type: 'calculated_field', name: 'total', expression: 'units * price' } as TransformStep,
  { type: 'rename_column', from: 'city', to: 'region' } as TransformStep,
];

// A dock proposal: drop the 'sku' column. Its EFFECT (one column fewer, 'sku'
// gone) is what proves the append landed, not just that the array grew.
const proposedStep: TransformStep = { type: 'drop_column', column: 'sku' } as TransformStep;

// Deep, Object.is-based comparison — not JSON.stringify. CLAUDE.md documents
// float summation and quantile interpolation as sources of genuine divergence
// between two runs of "the same" computation; Object.is is what a byte-for-
// byte reversibility claim actually has to survive, and it also treats NaN
// and -0 correctly where JSON.stringify silently would not.
function sameTable(
  a: { columns: { name: string; type: string }[]; rows: Cell[][]; rowCount: number },
  b: { columns: { name: string; type: string }[]; rows: Cell[][]; rowCount: number },
): boolean {
  if (!Object.is(a.rowCount, b.rowCount)) return false;
  if (a.columns.length !== b.columns.length) return false;
  for (let c = 0; c < a.columns.length; c++) {
    if (a.columns[c].name !== b.columns[c].name) return false;
    if (a.columns[c].type !== b.columns[c].type) return false;
  }
  if (a.rows.length !== b.rows.length) return false;
  for (let r = 0; r < a.rows.length; r++) {
    if (a.rows[r].length !== b.rows[r].length) return false;
    for (let c = 0; c < a.rows[r].length; c++) {
      if (!Object.is(a.rows[r][c], b.rows[r][c])) return false;
    }
  }
  return true;
}

// ── Before: the user's own three-step pipeline ────────────────────────────
const preApply = applyPipeline(source, threeSteps);
ok('pre-apply: three steps produce the expected columns', preApply.columns.map((c) => c.name).join(',') === 'region,sku,units,price,total');
ok('pre-apply: the zero-unit row was filtered out', preApply.rowCount === 3);

// ── Apply: addDatasetStep appends ONE step — never setDatasetSteps ────────
// (This is the array-level move addDatasetStep makes in the real IPC handler:
// steps.concat([proposedStep]), never a new array built some other way.)
const fourSteps = threeSteps.concat([proposedStep]);
ok('apply: appended step lands fourth, in order', fourSteps.length === 4 && fourSteps[3] === proposedStep);

const afterApply = applyPipeline(source, fourSteps);
ok('apply: four-step pipeline drops sku', afterApply.columns.every((c) => c.name !== 'sku'));
ok('apply: four-step pipeline still has the other columns', afterApply.columns.map((c) => c.name).sort().join(',') === 'price,region,total,units');
ok('apply: row count unaffected by a column drop', afterApply.rowCount === preApply.rowCount);

// ── Undo: removeDatasetStep(3) recomputes from source with the step gone ──
// (removeDatasetStep is index-addressed; removing the last index is exactly
// slicing it off. The real IPC handler builds this the same way — filter out
// one index, recompute from `existing.source`, never touch what's left.)
const undoneSteps = fourSteps.filter((_, i) => i !== 3);
const postRemove = applyPipeline(source, undoneSteps);

ok('undo: step count is back to three', undoneSteps.length === 3);
ok(
  'undo: result is Object.is-identical to the pre-apply output — no residue',
  sameTable(preApply, postRemove),
);

if (failureCount()) {
  console.error('\n' + failureCount() + ' dock reversibility check(s) FAILED');
  process.exit(1);
}
console.log('\nAll dock reversibility checks passed.');
