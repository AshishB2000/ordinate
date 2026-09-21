// Self-check for the CONNECTION ORIGIN ROUND TRIP: what a dataset imported from
// a connection records about where it came from, and therefore what a refresh
// re-runs.
//
// WHY THIS IS ITS OWN SUITE. Before the workbench a connection had exactly one
// saved selection, so `origin: {connId}` was enough — a refresh re-ran the
// connection. The workbench lets one connection feed many datasets, and the
// moment that is true, "what this dataset was built from" has to live on the
// DATASET. Get it wrong and the failure is silent and expensive: importing a
// second table re-points the first dataset's refresh at it, and the next
// scheduled run quietly replaces one table's rows with another's.
//
// Three properties, each of which has a way to break that a type check cannot
// see:
//
//   1. A TABLE import and a QUERY import both round-trip through
//      sanitizeOrigin, including after a write and a re-read from disk.
//   2. RENAMING a saved query does not disturb the dataset's origin, and
//      neither does DELETING it — the origin carries the SQL, not a pointer to
//      a mutable record, so `queryId` can only ever be a label.
//   3. The selection a refresh derives from an origin prefers the dataset's own
//      SQL over the connection's saved selection. That function is what makes
//      (1) and (2) mean anything at runtime.
//
// Like test-dataset-origin.ts, the 'electron' module is stubbed (via
// Module._load) to point userData at a fresh temp dir, then the REAL modules run
// against real disk. No framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-connorigin-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData },
      // connections.ts only needs `app`; the IPC module it shares a folder with
      // registers handlers at import time, so ipcMain is stubbed to a no-op.
      ipcMain: { handle: () => {}, on: () => {} },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');

const SQL = 'select region, sum(revenue) as revenue from orders group by 1';

function json(v: unknown): string {
  return JSON.stringify(v);
}

async function main(): Promise<void> {
  await projects.init();
  const project = await projects.createProject('Origin round trip');
  const projectId = project!.id;

  // A real connection record, through the real store — `duckdb-file` because it
  // is the one connector in the registry that needs no server to EXIST.
  const conn = await connections.saveConnection(projectId, {
    name: 'Warehouse',
    connectorId: 'duckdb-file',
    values: { path: path.join(tmpUserData, 'warehouse.duckdb') },
  });
  ok('a connection saves through the real store', !!conn && !!conn.id, json(conn));
  if (!conn) return;
  ok('a new connection starts with an empty query library',
     Array.isArray(conn.queries) && conn.queries.length === 0, json(conn.queries));

  // ── 1. A table import round-trips ──────────────────────────────────────────
  const tableDs = await datasets.saveDataset(projectId, {
    name: 'Orders',
    sourceKind: 'postgres',
    columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }],
    rows: [['north', 10]],
    origin: { kind: 'connection', connId: conn.id, table: 'main.orders' },
  });
  ok('a table import saves', !!tableDs, json(tableDs && tableDs.id));
  const tableBack = await datasets.getDatasetMeta(projectId, tableDs!.id);
  ok('…and its origin round-trips through disk with the table name',
     json(tableBack!.origin) === json({ kind: 'connection', connId: conn.id, table: 'main.orders' }),
     json(tableBack!.origin));

  // ── 2. A query import round-trips, carrying the SQL and the query id ──────
  const saved = await connections.saveQuery(projectId, conn.id, { name: 'Revenue by region', sql: SQL });
  ok('a saved query is created', Array.isArray(saved) && saved.length === 1, json(saved));
  const queryId = saved![0].id;

  const queryDs = await datasets.saveDataset(projectId, {
    name: 'Revenue by region',
    sourceKind: 'postgres',
    columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }],
    rows: [['north', 10]],
    origin: { kind: 'connection', connId: conn.id, queryId, sql: SQL },
  });
  const queryBack = await datasets.getDatasetMeta(projectId, queryDs!.id);
  ok('a query import round-trips with BOTH the SQL and the query id',
     json(queryBack!.origin) === json({ kind: 'connection', connId: conn.id, queryId, sql: SQL }),
     json(queryBack!.origin));

  // ── 3. A rename does not disturb the dataset's origin ─────────────────────
  const renamed = await connections.saveQuery(projectId, conn.id, { id: queryId, name: 'Regional revenue' });
  ok('a rename keeps the same query id',
     Array.isArray(renamed) && renamed.length === 1 && renamed[0].id === queryId, json(renamed));
  ok('…and does NOT touch the stored SQL — a rename must not be able to change '
     + 'what a dataset was built from',
     renamed![0].sql === SQL, json(renamed![0]));
  ok('…and the query is renamed', renamed![0].name === 'Regional revenue', json(renamed![0]));

  const afterRename = await datasets.getDatasetMeta(projectId, queryDs!.id);
  ok('the dataset origin is byte-identical after the rename',
     json(afterRename!.origin) === json(queryBack!.origin), json(afterRename!.origin));

  // ── 4. …and neither does a DELETE ─────────────────────────────────────────
  const afterDeleteList = await connections.deleteQuery(projectId, conn.id, queryId);
  ok('deleting the saved query empties the library',
     Array.isArray(afterDeleteList) && afterDeleteList.length === 0, json(afterDeleteList));
  const afterDelete = await datasets.getDatasetMeta(projectId, queryDs!.id);
  ok('the dataset still carries the SQL that built it, so it still refreshes',
     (afterDelete!.origin as any).sql === SQL, json(afterDelete!.origin));

  // ── 5. Rejections — sanitizeOrigin degrades a FIELD, never the origin ─────
  const san = datasets.sanitizeOrigin;
  ok('a non-UUID queryId is dropped, and the origin survives',
     json(san({ kind: 'connection', connId: conn.id, queryId: '../etc', sql: SQL }))
       === json({ kind: 'connection', connId: conn.id, sql: SQL }));
  ok('a blank sql is dropped rather than stored as ""',
     json(san({ kind: 'connection', connId: conn.id, table: 't', sql: '   ' }))
       === json({ kind: 'connection', connId: conn.id, table: 't' }));
  ok('a bad connId still drops the WHOLE origin — that is what makes it refreshable',
     san({ kind: 'connection', connId: 'not-a-uuid', sql: SQL }) === undefined);
  ok('an oversized sql is truncated, not rejected',
     ((san({ kind: 'connection', connId: conn.id, sql: 'x'.repeat(40_000) }) as any).sql || '').length === 20_000);

  // ── 6. What a refresh actually re-runs ────────────────────────────────────
  // The rule itself, exercised against the same shapes the records above hold.
  // A copy of the function rather than an import: it is not exported (it is one
  // private helper inside the IPC module, which cannot be required here without
  // registering handlers), so this pins the BEHAVIOUR the IPC layer must have.
  // If the two ever diverge, smoke-connections.ts is what catches it end to end.
  const selectionFor = (origin: any): any => {
    if (!origin || typeof origin !== 'object' || origin.kind !== 'connection') return undefined;
    if (typeof origin.sql === 'string' && origin.sql.trim()) return { query: origin.sql };
    if (typeof origin.table === 'string' && origin.table.trim()) return { table: origin.table };
    return undefined;
  };
  ok('a query origin re-runs its SQL',
     json(selectionFor(afterDelete!.origin)) === json({ query: SQL }));
  ok('a table origin re-runs its table',
     json(selectionFor(tableBack!.origin)) === json({ table: 'main.orders' }));
  ok('a pre-workbench origin (connId alone) falls through to the connection’s own selection',
     selectionFor({ kind: 'connection', connId: conn.id }) === undefined);
  ok('SQL wins over table when a record somehow carries both — the SQL is the '
     + 'thing that actually produced the rows',
     json(selectionFor({ kind: 'connection', connId: conn.id, table: 't', sql: SQL }))
       === json({ query: SQL }));
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    if (failureCount()) {
      console.error(`${failureCount()} connection-origin check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All connection-origin checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
