// Incremental refresh, end to end, on a REAL CSV-folder connection: real files
// on disk, the real csv-folder connector (DuckDB reading them, with the cursor
// predicate pushed into its SQL), the real merge, the real dataset store.
// Nothing is mocked except 'electron', which points userData at a temp dir.
//
//   1. watermark persistence — the first run is full and sets the mark from the
//      data; it is on disk, and the next run asks only for rows past it
//   2. upsert by key against the JS reference, through a Prepare step (the
//      merge runs on the immutable source copy, and the step is re-applied)
//   3. a folder file nobody touched is not re-read
//   4. append with a lookback: the overlap is deduped, hand-written counts
//   5. the 7th run is full, and "Full refresh now" is honoured once
//   6. recovery after an interrupted run — a throw mid-merge leaves the table,
//      the source copy and the mark exactly as they were, and a leftover temp
//      file is cleaned up by the next run

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-incr-ud-'));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-incr-src-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => tmpUserData }, ipcMain: {}, dialog: {} };
  return origLoad.apply(this, [request, ...rest]);
};

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const refresh: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');
const inc: typeof import('../src/data/incremental') = require('../src/data/incremental');
const duck: any = require('../src/engine/duckdb');
type Cell = import('../src/data/incremental').Cell;

const csv = (name: string, text: string): void => {
  fs.writeFileSync(path.join(folder, name), text, 'utf8');
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25)); // mtime moves past lastRunAt
const same = (a: Cell[][], b: Cell[][]): boolean =>
  a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((v, j) => Object.is(v, b[i][j])));

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Incremental');
  const pid = proj.id;
  const conn = await connections.saveConnection(pid, { name: 'Folder', connectorId: 'csv-folder', values: { path: folder } });
  ok('a csv-folder connection is saved', !!conn);
  if (!conn) return;

  // A dataset the way the workbench imports one: this connection, this table.
  async function importTable(table: string, text: string): Promise<string> {
    csv(`${table}.csv`, text);
    const p = parse.parseCsv(text);
    const ds = await datasets.saveDataset(pid, {
      name: table, sourceKind: 'csv', columns: p.columns, rows: p.rows,
      origin: { kind: 'connection', connId: conn!.id, table },
    } as any);
    return ds!.id;
  }
  const settings = (id: string) => datasets.getDatasetMeta(pid, id).then((m) => m!.incremental!);
  const run = async (id: string): Promise<import('../src/data/incremental').IncrementalLogEntry> => {
    const res = await refresh.refreshDataset(pid, id);
    ok(`refresh ok`, res.ok, res.ok ? '' : res.error);
    return (await settings(id)).log[0];
  };

  // ── 1. Watermark persistence ──────────────────────────────────────────────
  const orders = await importTable('orders', 'id,updated,amount\n1,100,10\n2,101,20\n3,102,30\n');
  // A Prepare step, so the source copy and the derived table are two files.
  await datasets.updateSteps(pid, orders, [{ type: 'filter', column: 'amount', op: '>', value: '15' } as any]);
  await datasets.writeIncremental(pid, orders, () => ({
    enabled: true, cursorColumn: 'updated', keyColumn: 'id', lookback: 0, highWater: null, runsSinceFull: 0, log: [],
  }));
  let e = await run(orders);
  ok('1. the first run is full and says why', e.mode === 'full' && /first run/i.test(e.note || ''), JSON.stringify(e));
  ok('1. …and sets the mark from the data (102)', e.highWater === 102 && (await settings(orders)).highWater === 102);
  const onDisk = JSON.parse(fs.readFileSync(record.datasetFilePath(pid, orders), 'utf8')).incremental;
  ok('1. the mark, the run count and the log are on disk', onDisk.highWater === 102 && onDisk.runsSinceFull === 0 && onDisk.log.length === 1);

  // ── 2. Upsert, differential against the JS reference ─────────────────────
  const before = (await datasets.getDataset(pid, orders))!;
  const srcInode = fs.statSync(record.sourceParquetPath(pid, orders)).ino;
  await tick();
  const next = 'id,updated,amount\n1,100,10\n2,103,25\n3,102,30\n4,104,40\n';
  csv('orders.csv', next);
  e = await run(orders);
  ok('2. the second run is incremental, filtered at the read', e.mode === 'incremental' && e.how === 'files' && !e.note, JSON.stringify(e));
  ok('2. fetched = rows with cursor >= 102 (3), inserted 1, updated 1 (an identical re-read is not)',
    e.fetched === 3 && e.inserted === 1 && e.updated === 1, JSON.stringify(e));
  ok('2. the mark advanced to 104 and persisted', e.highWater === 104 && (await settings(orders)).highWater === 104);
  const after = (await datasets.getDataset(pid, orders))!;
  const p = parse.parseCsv(next);
  const typed = inc.toBaseRows(p.columns.map((c) => c.name), next.trim().split('\n').slice(1).map((l) => l.split(',')), before.source!.columns);
  const batch = inc.filterBatch(typed.ok ? typed.rows : [], 1, 'number', 102);
  const want = inc.mergeJs(before.source!.rows, batch.rows, batch.keys, 0, 3);
  ok('2. the stored SOURCE equals the JS reference merge (Object.is)', same(after.source!.rows, want.rows), JSON.stringify(after.source!.rows));
  ok('2. hand-written: id 2 replaced in place, id 4 appended',
    JSON.stringify(after.source!.rows) === JSON.stringify([[1, 100, 10], [2, 103, 25], [3, 102, 30], [4, 104, 40]]));
  ok('2. the Prepare step was re-applied to the merged source (amount > 15)',
    JSON.stringify(after.rows) === JSON.stringify([[2, 103, 25], [3, 102, 30], [4, 104, 40]]));
  ok('2. the source copy was published as a new file (atomic rename), not edited in place',
    fs.statSync(record.sourceParquetPath(pid, orders)).ino !== srcInode);

  // ── 3. Nothing touched → nothing read ────────────────────────────────────
  e = await run(orders);
  ok('3. an untouched folder file is not re-read', e.how === 'unchanged' && e.fetched === 0 && e.highWater === 104, JSON.stringify(e));
  // A file delivered with an OLD mtime (a sync client, rsync -t, unzip) is
  // still new data: rewritten (same bytes here, so nothing else moves) and
  // back-dated to 2001, it is read again.
  const ordersFile = path.join(folder, 'orders.csv');
  fs.writeFileSync(ordersFile, fs.readFileSync(ordersFile));
  fs.utimesSync(ordersFile, new Date('2001-01-01'), new Date('2001-01-01'));
  e = await run(orders);
  ok('3. a rewritten file with an old mtime IS re-read', e.how !== 'unchanged' && e.fetched > 0 && e.inserted === 0 && e.updated === 0, JSON.stringify(e));
  e = await run(orders);
  ok('3. …and is "unchanged" again on the run after', e.how === 'unchanged', JSON.stringify(e));

  // ── 4. Append with a lookback ────────────────────────────────────────────
  const events = await importTable('events', 'at,kind\n2024-01-01,a\n2024-01-02,b\n2024-01-03,c\n');
  await datasets.writeIncremental(pid, events, () => ({
    enabled: true, cursorColumn: 'at', lookback: 2 * 86_400, highWater: null, runsSinceFull: 0, log: [],
  }));
  await run(events);
  await tick();
  csv('events.csv', 'at,kind\n2024-01-01,a\n2024-01-02,b\n2024-01-03,c\n2024-01-02,late\n2024-01-04,d\n');
  e = await run(events);
  ok('4. lookback 2 days re-reads 01-01 onward: 5 rows fetched', e.fetched === 5, JSON.stringify(e));
  ok('4. the overlap already stored is NOT re-appended; the late row and the new one are', e.inserted === 2 && e.updated === 0, JSON.stringify(e));
  const ev = (await datasets.getDataset(pid, events))!;
  ok('4. hand-written result, stored order then fetch order',
    JSON.stringify(ev.rows) === JSON.stringify([['2024-01-01', 'a'], ['2024-01-02', 'b'], ['2024-01-03', 'c'], ['2024-01-02', 'late'], ['2024-01-04', 'd']]));

  // ── 5. The 7th run, and "Full refresh now" ───────────────────────────────
  // orders: full, then 4 incremental runs so far (2 in §2–3, 2 more in §3's
  // back-dated file check). Two more incremental runs…
  ok('5. four incremental runs since the full one', (await settings(orders)).runsSinceFull === 4, (await settings(orders)).runsSinceFull);
  for (let i = 0; i < 2; i++) e = await run(orders);
  ok('5. runs 2–7 are incremental (6 in a row)', e.mode === 'incremental' && (await settings(orders)).runsSinceFull === 6);
  e = await run(orders);
  ok('5. the 7th run after a full one is full again', e.mode === 'full' && /7th/.test(e.note || ''), JSON.stringify(e));
  ok('5. …and resets the count', (await settings(orders)).runsSinceFull === 0);
  await datasets.writeIncremental(pid, orders, (cur) => cur && { ...cur, fullNext: true });
  e = await run(orders);
  ok('5. "Full refresh now" makes the next run full', e.mode === 'full' && /requested/i.test(e.note || ''));
  ok('5. …once', !(await settings(orders)).fullNext && (await run(orders)).mode === 'incremental');

  // ── 6. Recovery after an interrupted run ─────────────────────────────────
  const pq = record.parquetPath(pid, orders);
  const src = record.sourceParquetPath(pid, orders);
  const bytes = [fs.readFileSync(pq), fs.readFileSync(src)];
  const mark = await settings(orders);
  await tick();
  csv('orders.csv', next + '5,105,50\n');
  const realExec = duck.execAsync;
  duck.execAsync = async (sql: string) => {
    if (sql.includes('.merged.parquet')) throw new Error('simulated crash mid-merge');
    return realExec(sql);
  };
  const crashed = await refresh.refreshDataset(pid, orders);
  duck.execAsync = realExec;
  ok('6. the interrupted run fails cleanly', !crashed.ok && /simulated crash/.test(crashed.ok ? '' : crashed.error));
  ok('6. the stored table and the source copy are byte-identical', fs.readFileSync(pq).equals(bytes[0]) && fs.readFileSync(src).equals(bytes[1]));
  const markAfter = await settings(orders);
  ok('6. the mark, the run count and the log did not move',
    markAfter.highWater === mark.highWater && markAfter.runsSinceFull === mark.runsSinceFull && markAfter.log.length === mark.log.length);
  const dsDir = record.datasetsDir(pid);
  ok('6. the run left no temp file', fs.readdirSync(dsDir).every((n) => !n.includes('.incr-')));
  fs.writeFileSync(path.join(dsDir, `${orders}.incr-dead.merged.parquet`), 'half a file');
  e = await run(orders);
  ok('6. the next run succeeds and picks up the row', e.inserted === 1 && e.highWater === 105, JSON.stringify(e));
  ok('6. …and removed the leftover from the crashed run', !fs.existsSync(path.join(dsDir, `${orders}.incr-dead.merged.parquet`)));

  // ── 7. Two refreshes at once (a manual ↻ during a scheduled run) ───────────
  // They run one after the other: the second merges against what the first
  // wrote, so a full refresh is never undone by an incremental one over a stale base.
  await datasets.writeIncremental(pid, orders, (s) => ({ ...s!, fullNext: true }));
  const logLen = (await settings(orders)).log.length;
  const both = await Promise.all([refresh.refreshDataset(pid, orders), refresh.refreshDataset(pid, orders)]);
  ok('7. both concurrent refreshes succeed', both.every((r) => r.ok));
  const s7 = await settings(orders);
  ok('7. they ran in turn: the requested full run first, then an incremental one over its result',
    s7.log.length === logLen + 2 && s7.log[1].mode === 'full' && s7.log[0].mode === 'incremental', JSON.stringify(s7.log.slice(0, 2)));
  ok('7. …so the run count is 1 after the full reset, not bumped twice', s7.runsSinceFull === 1, s7.runsSinceFull);
}

main()
  .catch((err) => ok('threw', false, err && err.stack))
  .finally(() => {
    for (const d of [tmpUserData, folder]) fs.rmSync(d, { recursive: true, force: true });
    Module._load = origLoad;
    finish();
  });
