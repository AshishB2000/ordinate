// Incremental refresh, end to end, on a REAL URL connection: the real url
// connector (JSON over https; only the network is faked — a fetch that answers
// from the documents below), the real merge, the real dataset store, userData
// in a temp dir. A URL source cannot push the cursor predicate down, so the
// rows past the mark are picked out after the fetch.
//
// (Until T8.1 this ran on the desktop's CSV-folder connector, with the
// predicate pushed into its SQL, plus a check that an untouched folder file is
// not re-read; the local-file connectors and their file stamps went with the
// desktop app.)
//
//   1. watermark persistence — the first run is full and sets the mark from the
//      data; it is on disk, and the next run keeps only rows past it
//   2. upsert by key against the JS reference, through a Prepare step (the
//      merge runs on the immutable source copy, and the step is re-applied)
//   4. append with a lookback: the overlap is deduped, hand-written counts
//   5. the 7th run is full, and "Full refresh now" is honoured once
//   6. recovery after an interrupted run — a throw mid-merge leaves the table,
//      the source copy and the mark exactly as they were, and a leftover temp
//      file is cleaned up by the next run
//   8. BigQuery (L1.4): the predicate pushed to the warehouse, end to end over
//      the real connector and a fake transport

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-incr-ud-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// The source documents, by URL, and the fetch the url connector reaches them
// through (outside server mode it calls the platform fetch, src/connectors/url.ts).
const docs = new Map<string, string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const body = docs.get(String(input));
  return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const urlFor = (table: string): string => `https://source.test/${table}.json`;

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const refresh: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');
const inc: typeof import('../src/data/incremental') = require('../src/data/incremental');
const duck: any = require('../src/engine/duckdb');
type Cell = import('../src/data/incremental').Cell;

/** Publish a table at its URL — written as CSV here for legibility, served as JSON rows (numbers as numbers). */
const csv = (name: string, text: string): void => {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));
  docs.set(urlFor(name.replace(/\.csv$/, '')), JSON.stringify(rows));
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25)); // lastRunAt moves on
const same = (a: Cell[][], b: Cell[][]): boolean =>
  a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((v, j) => Object.is(v, b[i][j])));

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Incremental');
  const pid = proj.id;
  // A dataset the way the workbench imports one: a connection to the table's URL.
  async function importTable(table: string, text: string): Promise<string> {
    csv(`${table}.csv`, text);
    const conn = await connections.saveConnection(pid, { name: table, connectorId: 'url', values: { url: urlFor(table) } });
    ok(`a url connection is saved (${table})`, !!conn);
    const p = parse.parseCsv(text);
    const ds = await datasets.saveDataset(pid, {
      name: table, sourceKind: 'csv', columns: p.columns, rows: p.rows,
      origin: { kind: 'connection', connId: conn!.id },
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
  ok('2. the second run is incremental, filtered after the fetch', e.mode === 'incremental' && e.how === 'after' && !e.note, JSON.stringify(e));
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
  // orders: full, then one incremental run so far (§2). Five more…
  ok('5. one incremental run since the full one', (await settings(orders)).runsSinceFull === 1, (await settings(orders)).runsSinceFull);
  for (let i = 0; i < 5; i++) e = await run(orders);
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

  // ── 8. BigQuery: the cursor predicate is pushed to the warehouse (L1.4) ────
  // The real bigquery connector over a recorded-shape fake transport: the
  // full run reads the table through its one-backtick path, the incremental
  // run sends the pushed predicate (dry-run gated, inside the cap wrapper), and
  // the exact cut is still made in JS on the stored column type.
  {
    const bq: typeof import('../src/connectors/bigquery') = require('../src/connectors/bigquery');
    const fake: typeof import('./bigqueryFake') = require('./bigqueryFake');
    const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
    const day = (d: number): string => String(Date.UTC(2024, 0, d) / 1000); // TIMESTAMP as BigQuery sends it: epoch seconds
    let warehouse: string[][] = [['1', day(1), '10'], ['2', day(2), '20']];
    const f = fake.fakeTransport((c) => {
      if (fake.isToken(c)) return { json: { access_token: 'ya29.incremental', expires_in: 3599 } };
      if (fake.isDry(c)) return { json: { statementType: 'SELECT', totalBytesProcessed: '2048' } };
      if (fake.isQuery(c)) {
        return { json: {
          schema: { fields: [{ name: 'id', type: 'INTEGER' }, { name: 'updated_at', type: 'TIMESTAMP' }, { name: 'amount', type: 'NUMERIC' }] },
          jobReference: { projectId: fake.PROJECT, jobId: 'job_incremental', location: 'US' },
          jobComplete: true,
          rows: warehouse.map((r) => ({ f: r.map((v) => ({ v })) })),
        } };
      }
      return { status: 404, json: { error: { code: 404, message: 'unexpected' } } };
    });
    bq.setTransport(f.transport);
    try {
      const conn = (await connections.saveConnection(pid, { name: 'warehouse', connectorId: 'bigquery', values: { project: fake.PROJECT } }))!;
      await secretsIpc.storeSecrets(conn.id, { token: fake.makeKey().json });
      const ds = (await datasets.saveDataset(pid, {
        name: 'bq orders', sourceKind: 'postgres',
        columns: [{ name: 'id', type: 'number' }, { name: 'updated_at', type: 'date' }, { name: 'amount', type: 'number' }],
        rows: [[1, '2024-01-01T00:00:00.000Z', 10], [2, '2024-01-02T00:00:00.000Z', 20]],
        origin: { kind: 'connection', connId: conn.id, table: 'shop.orders' },
      } as any))!; // any: saveDataset's input, as the importers build it
      await datasets.writeIncremental(pid, ds.id, () => ({
        enabled: true, cursorColumn: 'updated_at', keyColumn: 'id', lookback: 0, highWater: null, runsSinceFull: 0, log: [],
      }));
      let b = await run(ds.id);
      const full = f.calls.filter(fake.isQuery).pop();
      ok('8. bigquery: the first run is full, through the table\'s backtick path in the cap wrapper',
        b.mode === 'full' && full?.json.query === 'select * from (\nselect * from `shop.orders` limit 1000000\n) limit 1000001', full?.json.query);
      ok('8. …and the mark is the TIMESTAMP, converted to ISO', b.highWater === '2024-01-02T00:00:00.000Z', JSON.stringify(b));
      warehouse = [['1', day(1), '10'], ['2', day(3), '25'], ['3', day(4), '40']];
      await tick();
      b = await run(ds.id);
      const pushed = f.calls.filter(fake.isQuery).pop();
      ok('8. bigquery: the incremental run pushes the predicate to the warehouse',
        b.mode === 'incremental' && b.how === 'server' && pushed?.json.query === "select * from (\nselect * from `shop.orders` where `updated_at` >= '2024-01-01'\n) limit 1000001", `${JSON.stringify(b)} ${pushed?.json.query}`);
      ok('8. …dry-run first, like every statement run sends', f.calls.filter(fake.isDry).some((c) => c.json.query === pushed?.json.query));
      ok('8. …and JS makes the exact cut: id 2 updated, id 3 inserted', b.fetched === 2 && b.updated === 1 && b.inserted === 1 && b.highWater === '2024-01-04T00:00:00.000Z', JSON.stringify(b));
      const stored = (await datasets.getDataset(pid, ds.id))!;
      ok('8. hand-written result', JSON.stringify(stored.rows) === JSON.stringify([[1, '2024-01-01T00:00:00.000Z', 10], [2, '2024-01-03T00:00:00.000Z', 25], [3, '2024-01-04T00:00:00.000Z', 40]]), JSON.stringify(stored.rows));
    } finally {
      bq.setTransport(null);
    }
  }
}

main()
  .catch((err) => ok('threw', false, err && err.stack))
  .finally(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    globalThis.fetch = realFetch;
    finish();
  });
