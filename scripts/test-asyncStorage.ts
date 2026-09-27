// The job-side storage path: `parquetStore.writeTableAsync` / `readTableAsync`
// (the async DuckDB bridge, chunked NDJSON with progress and cancel), the
// per-dataset write lock in `datasets.persist`, a dataset write reporting to
// the job it runs inside, and the import staging area.
//
//   npm run build:ts && node scripts/test-asyncStorage.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: Node's internal loader hook

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-async-storage-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') return { app: { getPath: () => tmpUserData, getVersion: () => '0.0.0' } };
  return origLoad.call(this, request, ...rest);
};

const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const stage: typeof import('../src/data/importStage') = require('../src/data/importStage');

type Cell = string | number | null;
const cols = [
  { name: 'zip', type: 'text' as const },
  { name: 'amount', type: 'number' as const },
  { name: 'note', type: 'text' as const },
];
function rowsOf(n: number): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) out.push([String(i % 1000).padStart(3, '0'), i % 3 === 0 ? null : i * 1.5, i % 5 === 0 ? '' : i % 7 === 0 ? '  ' : 'n' + i]);
  return out;
}

void (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-parquet-'));

  // ── writeTableAsync is writeTable, off the event loop ──────────────────────
  const rows = rowsOf(50_000);
  const syncFile = path.join(dir, 'sync.parquet');
  const asyncFile = path.join(dir, 'async.parquet');
  parquetStore.writeTable(syncFile, cols, rows);
  const seen: number[] = [];
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  await parquetStore.writeTableAsync(asyncFile, cols, rows, { onProgress: (f) => seen.push(f) });
  clearInterval(timer);
  const a = parquetStore.readTable(syncFile, cols);
  const b = parquetStore.readTable(asyncFile, cols);
  ok('writeTableAsync round-trips exactly what writeTable does (007, "", "  ", null)',
    !!a && !!b && a.rows.length === b.rows.length && a.rows.every((r, i) => r.every((c, j) => Object.is(c, b.rows[i][j]))));
  ok('progress is reported and reaches 1', seen.length > 2 && seen[seen.length - 1] === 1);
  ok('progress never goes backwards', seen.every((v, i) => i === 0 || v >= seen[i - 1]));
  ok('the event loop turned during the write', ticks > 0, ticks);
  const back = await parquetStore.readTableAsync(asyncFile, cols);
  ok('readTableAsync reads exactly what readTable reads',
    !!back && !!b && JSON.stringify(back.rows) === JSON.stringify(b.rows));
  ok('readTableAsync: a missing file is null, never a throw', (await parquetStore.readTableAsync(path.join(dir, 'nope.parquet'), cols)) === null);
  const emptyFile = path.join(dir, 'empty.parquet');
  await parquetStore.writeTableAsync(emptyFile, cols, []);
  const empty = parquetStore.readTable(emptyFile, cols);
  ok('a 0-row table writes and reads back with its width', !!empty && empty.rows.length === 0 && empty.columns.length === 3);
  const noColsFile = path.join(dir, 'nocols.parquet');
  await parquetStore.writeTableAsync(noColsFile, [], [[], [], []]);
  ok('a 0-column table keeps its row count', (parquetStore.readTable(noColsFile)?.rows.length ?? -1) === 3);

  // ── Cancel leaves nothing behind ──────────────────────────────────────────
  const cancelFile = path.join(dir, 'cancel.parquet');
  let calls = 0;
  let threw = false;
  try {
    await parquetStore.writeTableAsync(cancelFile, cols, rowsOf(100_000), {
      checkCancelled: () => { if (++calls > 2) { const e = new Error('Cancelled'); e.name = 'JobCancelled'; throw e; } },
    });
  } catch (e: any) { threw = e && e.name === 'JobCancelled'; }
  ok('a cancel between chunks rejects the write', threw);
  ok('…and leaves no .parquet and no temp file', fs.readdirSync(dir).every((f: string) => !f.startsWith('cancel.parquet')));

  // ── persist: one write at a time per dataset ─────────────────────────────
  await projects.init();
  const proj = await projects.createProject('Async');
  const ds = await datasets.saveDataset(proj.id, { name: 'Sales', sourceKind: 'csv', columns: cols, rows: rowsOf(20) });
  ok('saveDataset writes a v3 record', !!ds && (await datasets.getDatasetMeta(proj.id, ds!.id))!.resident === true);
  // Three overlapping updates of different sizes. Without the lock, one write's
  // Parquet could be published beside another's JSON.
  const sizes = [30_000, 10, 5_000];
  await Promise.all(sizes.map((n) => datasets.updateDatasetData(proj.id, ds!.id, { columns: cols, rows: rowsOf(n) })));
  const meta = await datasets.getDatasetMeta(proj.id, ds!.id);
  const full = await datasets.getDataset(proj.id, ds!.id);
  ok('concurrent writes: the JSON rowCount describes the Parquet beside it',
    !!meta && !!full && meta.rowCount === full.rows.length, `${meta && meta.rowCount} vs ${full && full.rows.length}`);
  ok('concurrent writes: the LAST write won (issue order)', !!full && full.rows.length === 5_000);

  // ── A write inside a job reports to it ───────────────────────────────────
  jobs.reset();
  const progress: number[] = [];
  jobs.onChange((snap) => { for (const j of snap.active) progress.push(j.progress); });
  const job = jobs.submit({
    kind: 'refresh', label: 'write inside a job', datasetId: ds!.id,
    run: async () => datasets.updateDatasetData(proj.id, ds!.id, { columns: cols, rows: rowsOf(80_000) }),
  });
  await job.done;
  ok('a dataset write reports its progress to the job it runs inside',
    progress.some((p) => p > 0.2 && p < 1), progress.slice(0, 8).join(','));
  let cancelledWrite = false;
  const doomed = jobs.submit({
    kind: 'refresh', label: 'cancelled write', datasetId: ds!.id,
    run: async (ctx) => {
      setTimeout(() => jobs.cancel(ctx.signal.aborted ? '' : doomed.id), 0);
      await new Promise((r) => setTimeout(r, 5));
      return datasets.updateDatasetData(proj.id, ds!.id, { columns: cols, rows: rowsOf(200_000) });
    },
  });
  try { await doomed.done; } catch (e: any) { cancelledWrite = e && e.name === 'JobCancelled'; }
  const afterCancel = await datasets.getDataset(proj.id, ds!.id);
  ok('Cancel stops a dataset write inside a job', cancelledWrite);
  ok('…and the stored dataset is the previous one, intact', !!afterCancel && afterCancel.rows.length === 80_000);

  // ── The import staging area ───────────────────────────────────────────────
  let clock = 1_000;
  stage.resetForTest(() => clock);
  const big = { columns: cols, rows: rowsOf(10_000), rowCount: 10_000, warnings: [] as string[] };
  const id1 = stage.put(big);
  const pv = stage.previewOf(big, id1);
  ok('stage: the renderer gets a slice and a handle, not the table',
    pv.rows.length === stage.PREVIEW_ROWS && pv.rowCount === 10_000 && pv.stagedId === id1);
  ok('stage: main still holds every row', stage.get(id1)!.rows.length === 10_000);
  const id2 = stage.put(big);
  const id3 = stage.put(big);
  ok('stage: bounded — the oldest table goes first', stage.get(id1) === null && !!stage.get(id2) && !!stage.get(id3));
  stage.drop(id2);
  ok('stage: a save drops its table', stage.get(id2) === null);
  clock += stage.TTL_MS + 1;
  ok('stage: an abandoned import expires', stage.get(id3) === null && stage.sizeForTest() === 0);
  ok('stage: a forged or missing id resolves to nothing', stage.get('../../config.json') === null && stage.get(42) === null);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmpUserData, { recursive: true, force: true });
  finish();
})().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
