// Self-check for input tables' HISTORY: one batch is one undo step in the grid
// and one version on disk, and undo/redo round-trip exactly — through the real
// store, the real Parquet and the real version history (userData is a temp
// dir, as in test-snapshots.ts).
//
// The grid's side is played by edits.ts itself (the module the hub loads), so
// what is tested is the actual hand-off: batches made and undone in the grid,
// saved in one call, replayed over the stored table in main.
//
//   npm run build:ts && node scripts/test-inputHistory.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

type Cell = import('../src/data/inputTable/edits').Cell;
type Batch = import('../src/data/inputTable/edits').Batch;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-inputhist-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const store: typeof import('../src/data/inputTable/store') = require('../src/data/inputTable/store');
const E: typeof import('../src/data/inputTable/edits') = require('../src/data/inputTable/edits');
const { writeBack }: typeof import('../src/ipc/versions') = require('../src/ipc/versions');
const { commitSteps }: typeof import('../src/ipc/datasets') = require('../src/ipc/datasets');

const CAP = 10_000;
const J = (v: unknown): string => JSON.stringify(v);
const sameRows = (a: Cell[][], b: Cell[][]): boolean =>
  a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((v, j) => Object.is(v, b[i][j])));

/** The grid, reduced to what it does with batches. */
class Grid {
  rows: Cell[][];
  hist = E.histNew();
  pending: Batch[] = [];
  constructor(rows: Cell[][], private width: number) { this.rows = rows; }
  commit(b: Batch | null): boolean {
    if (!b) return false;
    const res = E.applyBatch(this.rows, b, this.width, CAP);
    if (!res) return false;
    this.rows = res.rows;
    E.histPush(this.hist, { label: b.label, forward: b, inverse: res.inverse });
    this.pending.push(b);
    return true;
  }
  step(dir: 'undo' | 'redo'): boolean {
    const e = dir === 'undo' ? E.histUndo(this.hist) : E.histRedo(this.hist);
    if (!e) return false;
    const b = dir === 'undo' ? e.inverse : e.forward;
    this.rows = E.applyBatch(this.rows, b, this.width, CAP)!.rows;
    this.pending.push(b);
    return true;
  }
  take(): Batch[] { return this.pending.splice(0); }
}

async function main(): Promise<void> {
  await projects.init();
  const pid = (await projects.createProject('Budgets')).id;
  const created = await store.createInputTable(pid, {
    name: 'Targets',
    columns: [
      { name: 'region', type: 'text' }, { name: 'q1', type: 'number' },
      { name: 'q2', type: 'number' }, { name: 'note', type: 'text' },
    ],
  });
  if (!created.ok) throw new Error(created.error);
  const id = created.id;
  const count = async (): Promise<number> => (await versions.list(pid, 'dataset', id)).length;
  const newest = async (): Promise<string> => (await versions.list(pid, 'dataset', id))[0].summary;
  const stored = async (): Promise<Cell[][]> => (await datasets.getDataset(pid, id))!.rows;

  const meta = await datasets.getDatasetMeta(pid, id);
  ok('an input table is an ordinary dataset with sourceKind "input"', meta!.sourceKind === 'input' && meta!.resident);
  ok('creating it is its first version', (await count()) === 1 && (await newest()) === 'Created the table');
  const listed = (await datasets.listDatasets(pid)).find((d) => d.id === id)!;
  ok('it is listed, and never offered a Refresh', listed.sourceKind === 'input' && listed.originKind === undefined);

  const view = await store.loadInputTable(pid, id);
  if (!view.ok) throw new Error(view.error);
  const grid = new Grid(view.rows, 4);

  // ── A 3×4 paste is ONE undo step and ONE version ───────────────────────────
  const plan = E.pasteBatch('east\t10\t11\tok\nwest\t20\t21\t\nnorth\t30\t31\tx', { r0: 0, c0: 0, r1: 0, c1: 0 }, 0, 4, CAP)!;
  grid.commit(plan.batch);
  ok('a 3×4 paste is one undo step', grid.hist.past.length === 1 && grid.hist.past[0].label === 'Paste 12 cells');
  const saved = await store.saveInputBatches(pid, id, grid.take());
  ok('…and one version', saved.ok && saved.versions === 1 && (await count()) === 2, J(saved));
  ok('the version says what the paste did', (await newest()) === 'Added 3 rows');
  const pasted: Cell[][] = [['east', 10, 11, 'ok'], ['west', 20, 21, null], ['north', 30, 31, 'x']];
  ok('the stored table holds typed numbers as numbers', sameRows(await stored(), pasted), J(await stored()));

  // ── Undo / redo round-trip exactly, through the stored table ───────────────
  grid.rows = (saved as any).rows; // the grid adopts main's copy after a save
  const before = grid.rows;
  grid.commit(E.editBatch(grid.rows, 1, 1, '25', 'q1', CAP));
  await store.saveInputBatches(pid, id, grid.take());
  ok('one cell edit is one version, summarised', (await count()) === 3 && (await newest()) === 'Edited 1 cell');
  const edited = await stored();
  grid.step('undo');
  ok('undo in the grid restores the rows exactly', sameRows(grid.rows, before));
  await store.saveInputBatches(pid, id, grid.take());
  ok('…and the stored table exactly', sameRows(await stored(), pasted));
  ok('an undo that lands is a version too (history is append-only)', (await count()) === 4);
  grid.step('redo');
  await store.saveInputBatches(pid, id, grid.take());
  ok('redo lands the edit again, exactly', sameRows(await stored(), edited) && (await count()) === 5);

  // ── Several batches in one save: one version each, in order ────────────────
  grid.commit(E.fillDownBatch(grid.rows, { r0: 0, c0: 2, r1: 2, c1: 2 }));
  grid.commit(E.insertRowsBatch(3, 1, grid.rows.length, CAP));
  grid.commit(E.clearBatch(grid.rows, { r0: 0, c0: 3, r1: 0, c1: 3 }));
  const three = await store.saveInputBatches(pid, id, grid.take());
  const list = await versions.list(pid, 'dataset', id);
  ok('three batches in one save are three versions', three.ok && three.versions === 3 && list.length === 8);
  ok('…each summarised in order', J(list.slice(0, 3).map((v) => v.summary)) === J(['Edited 1 cell', 'Added 1 row', 'Edited 2 cells']), J(list.slice(0, 3).map((v) => v.summary)));
  ok('fill down copied, never extrapolated', J((await stored()).map((r) => r[2])) === J([11, 11, 11, null]));

  // ── A batch that changes nothing is no version ─────────────────────────────
  const n0 = await count();
  await store.saveInputBatches(pid, id, [{ label: 'Edit q1', ops: [{ t: 'set', r: 0, c: 1, cells: [['10']] }] }]);
  ok('"10" over a stored 10 is no version', (await count()) === n0);

  // ── Invalid values: stored as null, kept as typed, flagged ─────────────────
  const bad = await store.saveInputBatches(pid, id, [{ label: 'Edit q2', ops: [{ t: 'set', r: 1, c: 2, cells: [['abc']] }] }]);
  const ds = (await datasets.getDataset(pid, id))!;
  ok('text in a number column is never stored as a value', ds.rows[1][2] === null);
  ok('…the typed text is kept on the record', J(ds.input) === J({ invalid: [[1, 2, 'abc']] }));
  ok('…the grid gets it back, flagged', bad.ok && (bad as any).rows[1][2] === 'abc' && (bad as any).check.failCells === 1);
  const fixed = await store.saveInputBatches(pid, id, [{ label: 'Edit q2', ops: [{ t: 'set', r: 1, c: 2, cells: [['12']] }] }]);
  ok('fixing it clears the overlay', fixed.ok && (await datasets.getDataset(pid, id))!.input === undefined);

  // ── Refused saves change nothing ───────────────────────────────────────────
  const n1 = await count();
  const snapshot = await stored();
  const tooMany = await store.saveInputBatches(pid, id, [{ label: 'x', ops: [{ t: 'ins', at: 0, rows: Array.from({ length: CAP }, () => []) }] }]);
  ok('growing past 10,000 rows is refused', !tooMany.ok);
  const broken = await store.saveInputBatches(pid, id, [
    { label: 'ok', ops: [{ t: 'set', r: 0, c: 0, cells: [['changed']] }] },
    { label: 'bad', ops: [{ t: 'del', at: 99, n: 1 }] },
  ]);
  ok('one bad batch refuses the whole save', !broken.ok && sameRows(await stored(), snapshot) && (await count()) === n1);

  // ── Restore a version: the table comes back ────────────────────────────────
  const first = (await versions.list(pid, 'dataset', id)).find((v) => v.summary === 'Added 3 rows')!;
  const rec = (await versions.get(pid, 'dataset', id, first.key))!.record;
  const back = await writeBack(pid, 'dataset', id, rec);
  ok('restoring the paste version brings its table back exactly', !!back && sameRows(await stored(), pasted), J(await stored()));

  // ── Edit columns: cells move with their column; a retype keeps the text ────
  const cols = await store.setInputColumns(pid, id, [
    { name: 'region', type: 'text' }, { name: 'Q1 target', type: 'number' }, { name: 'note', type: 'number' },
  ], [0, 1, 3]);
  ok('columns renamed, retyped and dropped in one save', cols.ok && J(cols.ok && cols.columns.map((c) => c.name)) === J(['region', 'Q1 target', 'note']));
  ok('text in a column made numeric is kept and flagged, not lost',
    cols.ok && cols.rows[0][2] === 'ok' && (await stored())[0][2] === null && cols.check.issues.some((i) => i.r === 0 && i.c === 2));
  ok('a column change is one version', cols.ok && cols.versions === 1 && /column/.test(await newest()), await newest());

  // ── A prepare pipeline recomputes from the edited base ─────────────────────
  await commitSteps(pid, id, [{ type: 'filter', column: 'Q1 target', op: '>', value: 15 }]);
  ok('a pipeline edit on an input table is a version that still holds the table',
    !!(await versions.get(pid, 'dataset', id, (await versions.list(pid, 'dataset', id))[0].key))!.record.table);
  await store.saveInputBatches(pid, id, [{ label: 'Edit Q1 target', ops: [{ t: 'set', r: 0, c: 1, cells: [['99']] }] }]);
  const piped = (await datasets.getDataset(pid, id))!;
  ok('the edit lands in the SOURCE and the output is re-derived', piped.source!.rows[0][1] === 99
    && J(piped.rows.map((r) => r[0])) === J(['east', 'west', 'north']), J(piped.rows));
  const reload = await store.loadInputTable(pid, id);
  ok('the grid edits the base, not the filtered output', reload.ok && reload.rows.length === 3 && reload.steps === 1);
}

main()
  .catch((err) => ok('threw', false, err && err.stack))
  .finally(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp */ }
    if (failureCount()) { console.error('\n' + failureCount() + ' input-history check(s) FAILED'); process.exit(1); }
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
