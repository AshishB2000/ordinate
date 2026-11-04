// Self-check for the TABLE DOCS store and its three channels — src/app/tableDocs.ts and
// src/ipc/tableDocs.ts over the real dataset store (harness of test-qualityRun).
//
// What is pinned here, and why each would break quietly:
//   1. A KEY SAVE CHECKS ITSELF. `catalog:setTable { key }` on an extract replies with the key's
//      counts (rows, empty, repeatedKeys), and `catalog:getTable` returns the same doc.
//   2. A KEY IS A COLUMN. A name the dataset does not have is a sentence, and the stored key stays.
//   3. A CHECK LANDS ONLY UNDER THE KEY IT CHECKED. A slow check for an old key must not stamp the new one.
//   4. STAMPS ARE THE SERVER'S. `updatedBy` is `catalog.osUser()`, never read off a payload.
//   5. THE FAST PATH IS REAL. The resident check never hydrates the table; with the fast path gone or
//      failing, the JS reference answers the same counts, and the trace says which.
//   6. THE CONTRACTS ARE STRICT. An unknown field, a role outside the set or an over-long field is refused.
//   7. LIVE IS NEVER CHECKED BY A SAVE (D2): a Live dataset's key save stores the key and counts nothing.
//
//   npm run build:ts && node scripts/test-tableDocs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-table-docs-'));
// Handlers land in the RPC registry (src/ipc/bus.ts).
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/tableDocs') = require('../src/app/tableDocs');
const msg: typeof import('../src/app/tableDocMessages') = require('../src/app/tableDocMessages');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const api: typeof import('../src/api/index') = require('../src/api/index');
require('../src/ipc/tableDocs').register();

const T = (name: string): ParsedColumn => ({ name, type: 'text' });
const N = (name: string): ParsedColumn => ({ name, type: 'number' });
const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);
const COUNTS = { rows: 4, empty: 0, repeatedKeys: 1 };
const counts = (t: { keyCheck?: { rows: number; empty: number; repeatedKeys: number } } | undefined) =>
  t?.keyCheck && { rows: t.keyCheck.rows, empty: t.keyCheck.empty, repeatedKeys: t.keyCheck.repeatedKeys };

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();
  const P = (await projects.createProject('table docs')).id;
  const COLS = [T('line_id'), N('qty')];
  const rows: Cell[][] = [['L1', 1], ['L2', 2], ['L2', 3], ['L3', 4]];
  const D = (await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: COLS, rows }))!.id;
  const NOKEY = (await datasets.saveDataset(P, { name: 'Notes', sourceKind: 'csv', columns: [T('note')], rows: [['a']] }))!.id;

  // ── 1. A key save checks itself ────────────────────────────────────────────
  const empty = await call('catalog:getTable', { projectId: P, datasetId: D });
  ok('getTable on a dataset nobody documented is an empty doc', empty.ok === true && empty.table.key === '' && empty.table.role === '' && !('keyCheck' in empty.table), JSON.stringify(empty));

  let hydrated = 0;
  const realGet = datasets.getDataset;
  (datasets as any).getDataset = async (...args: any[]): Promise<any> => { hydrated += 1; return (realGet as any)(...args); };
  trace.reset();
  const set = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { role: 'fact', key: 'line_id', guide: '# Orders' } });
  (datasets as any).getDataset = realGet;
  ok('setTable stores role, key and guide', set.ok === true && set.table.role === 'fact' && set.table.key === 'line_id' && set.table.guide === '# Orders', JSON.stringify(set));
  ok('a new key on an extract is checked before replying: 4 rows, 0 empty, 1 repeated key', JSON.stringify(counts(set.table)) === JSON.stringify(COUNTS), JSON.stringify(set.table));
  ok('the check is stamped with a time', typeof set.table.keyCheck?.checkedAt === 'string' && !Number.isNaN(Date.parse(set.table.keyCheck.checkedAt)));
  const got = await call('catalog:getTable', { projectId: P, datasetId: D });
  ok('getTable returns the stored doc, check included', JSON.stringify(got.table) === JSON.stringify(set.table), JSON.stringify(got));
  if (duck.isAvailable()) {
    ok('the resident check answered', (trace.snapshot().keyCheck || { resident: 0 }).resident >= 1, JSON.stringify(trace.snapshot()));
    ok('the resident check never hydrated the table', hydrated === 0, `getDataset called ${hydrated}x`);
  }

  // The JS reference answers the same counts when the fast path is not taken, and the trace says which.
  const realSource = datasets.residentSource;
  (datasets as any).residentSource = async (): Promise<null> => null;
  trace.reset();
  const skipped = await call('catalog:checkKey', { projectId: P, datasetId: D });
  ok('no resident source: the JS reference counts the same, traced skipped', skipped.ok === true && JSON.stringify(counts(skipped.table)) === JSON.stringify(COUNTS) && (trace.snapshot().keyCheck?.skipped ?? 0) === 1, JSON.stringify(trace.snapshot()));
  (datasets as any).residentSource = async () => ({ parquetPath: path.join(tmpUserData, 'missing.parquet'), columns: COLS });
  trace.reset();
  const failed = await call('catalog:checkKey', { projectId: P, datasetId: D });
  ok('a resident query that fails falls back to the JS reference, traced failed', failed.ok === true && JSON.stringify(counts(failed.table)) === JSON.stringify(COUNTS) && (trace.snapshot().keyCheck?.failed ?? 0) === 1, JSON.stringify(trace.snapshot()));
  (datasets as any).residentSource = realSource;

  // A number key and an empty cell: the key rule is the join's.
  const NUM = (await datasets.saveDataset(P, { name: 'Numbers', sourceKind: 'csv', columns: [N('n')], rows: [[1], [2], [2], [null]] }))!.id;
  const num = await call('catalog:setTable', { projectId: P, datasetId: NUM, patch: { key: 'n' } });
  ok('a number key counts a null as empty', num.ok === true && JSON.stringify(counts(num.table)) === JSON.stringify({ rows: 4, empty: 1, repeatedKeys: 1 }), JSON.stringify(num));

  // ── 2. A key is a column ───────────────────────────────────────────────────
  const nope = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'nope' } });
  ok('a key the dataset does not have is a sentence', nope.ok === false && nope.error === '“nope” is not a column of this dataset.' && nope.error === msg.keyNotAColumn('nope'), JSON.stringify(nope));
  ok('…and the stored key is untouched, check and all', (await call('catalog:getTable', { projectId: P, datasetId: D })).table.key === 'line_id' && JSON.stringify(counts((await call('catalog:getTable', { projectId: P, datasetId: D })).table)) === JSON.stringify(COUNTS));
  const caseKey = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'LINE_ID' } });
  ok('a key is matched exactly: another case is not the column', caseKey.ok === false, JSON.stringify(caseKey));
  const noDs = await call('catalog:setTable', { projectId: P, datasetId: '5d3b6f0e-6c1f-4a8e-9a3e-0e5a1b2c3d4e', patch: { key: 'line_id' } });
  ok('a dataset that does not exist is refused, nothing stored', noDs.ok === false, JSON.stringify(noDs));

  // ── Check now ──────────────────────────────────────────────────────────────
  const nokey = await call('catalog:checkKey', { projectId: P, datasetId: NOKEY });
  ok('checkKey with no key says to pick one', nokey.ok === false && nokey.error === 'Pick the key column first.' && nokey.error === msg.noKeyToCheck(), JSON.stringify(nokey));
  const again = await call('catalog:checkKey', { projectId: P, datasetId: D });
  ok('checkKey recounts and stores', again.ok === true && JSON.stringify(counts(again.table)) === JSON.stringify(COUNTS) && again.table.key === 'line_id', JSON.stringify(again));
  await datasets.updateDatasetData(P, D, { columns: COLS, rows: [['L1', 1], ['L2', 2], ['L3', 3], ['L4', 4]] });
  const unique = await call('catalog:checkKey', { projectId: P, datasetId: D });
  ok('after the rows change, Check now says unique', unique.ok === true && JSON.stringify(counts(unique.table)) === JSON.stringify({ rows: 4, empty: 0, repeatedKeys: 0 }), JSON.stringify(unique));
  await datasets.updateDatasetData(P, D, { columns: COLS, rows });
  await call('catalog:checkKey', { projectId: P, datasetId: D });

  // ── 3. A check result is stored only under the key it checked ──────────────
  const kc = { rows: 9, empty: 9, repeatedKeys: 9, checkedAt: new Date().toISOString() };
  const stale = await store.writeKeyCheck(P, D, 'old_key', kc);
  ok('a check result is stored only under the key it checked: a stale key writes nothing', stale === null, JSON.stringify(stale));
  ok('…and leaves keyCheck as it was', JSON.stringify(counts(await store.getTableDoc(P, D))) === JSON.stringify(COUNTS));
  const fresh = await store.writeKeyCheck(P, D, 'line_id', kc);
  ok('NEGATIVE CONTROL: the key it checked stores it', fresh?.keyCheck?.rows === 9 && (await store.getTableDoc(P, D)).keyCheck?.rows === 9);
  const cleared = await store.writeKeyCheck(P, D, 'line_id', null);
  ok('a null check clears it', cleared !== null && !('keyCheck' in cleared) && !('keyCheck' in (await store.getTableDoc(P, D))));
  await call('catalog:checkKey', { projectId: P, datasetId: D });

  // A changed key drops the old key's check, at once; role and guide edits keep it.
  const guided = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { guide: 'new guide', role: 'dimension' } });
  ok('a role/guide edit keeps the check and the key', guided.ok === true && guided.table.key === 'line_id' && JSON.stringify(counts(guided.table)) === JSON.stringify(COUNTS) && guided.table.role === 'dimension' && guided.table.guide === 'new guide', JSON.stringify(guided));
  const dropped = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: '' } });
  ok('clearing the key clears its check', dropped.ok === true && dropped.table.key === '' && !('keyCheck' in dropped.table), JSON.stringify(dropped));
  const other = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'qty' } });
  ok('a different key is checked afresh, not carried over', other.ok === true && other.table.key === 'qty' && JSON.stringify(counts(other.table)) === JSON.stringify({ rows: 4, empty: 0, repeatedKeys: 0 }), JSON.stringify(other));
  await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'line_id' } });

  // ── 4. Stamps are the server's ─────────────────────────────────────────────
  const forged = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { grain: 'One row per line', updatedBy: 'mallory', updatedAt: '1999-01-01', keyCheck: { rows: 1, empty: 1, repeatedKeys: 1, checkedAt: 'x' } } });
  ok('updatedBy is the server\'s user, never the payload\'s', forged.ok === true && forged.table.updatedBy === catalog.osUser() && forged.table.updatedBy !== 'mallory', JSON.stringify(forged));
  ok('updatedAt is now, not the payload\'s', forged.table.updatedAt !== '1999-01-01' && Math.abs(Date.now() - Date.parse(forged.table.updatedAt)) < 60_000);
  ok('a payload\'s keyCheck is not stored', JSON.stringify(counts(forged.table)) === JSON.stringify(COUNTS), JSON.stringify(forged.table));

  // ── Caps ───────────────────────────────────────────────────────────────────
  const long = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { grain: 'x'.repeat(300), guide: 'g'.repeat(9000) } });
  ok('a grain over 200 characters stores 200', long.ok === true && long.table.grain === 'x'.repeat(200), String(long.table?.grain?.length));
  ok('a guide over 8,000 characters stores 8,000', long.table.guide === 'g'.repeat(8000), String(long.table?.guide?.length));
  const short = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { grain: 'One row per order line' } });
  ok('NEGATIVE CONTROL: a short grain is stored as typed', short.table.grain === 'One row per order line');

  // ── 6. The contracts are strict ────────────────────────────────────────────
  const setIn = (api.contracts as any)['catalog:setTable'].input;
  const accepts = (patch: unknown): boolean => setIn.safeParse({ projectId: P, datasetId: D, patch }).success;
  ok('contract: a plain patch passes', accepts({ role: 'fact', key: 'line_id', grain: 'g', guide: 'x' }) && accepts({}));
  ok('contract: an unknown field is refused', !accepts({ updatedBy: 'x' }) && !accepts({ keyCheck: {} }));
  ok('contract: a role outside fact/dimension/none is refused', !accepts({ role: 'boss' }));
  ok('contract: an over-long key, grain or guide is refused', !accepts({ key: 'k'.repeat(257) }) && !accepts({ grain: 'g'.repeat(201) }) && !accepts({ guide: 'g'.repeat(8001) }));
  ok('contract: getTable and checkKey take exactly a project and a dataset', (api.contracts as any)['catalog:getTable'].access === 'read' && (api.contracts as any)['catalog:checkKey'].access === 'write'
    && (api.contracts as any)['catalog:setTable'].access === 'write' && !(api.contracts as any)['catalog:checkKey'].input.safeParse({ projectId: P, datasetId: D, key: 'x' }).success);

  // ── 7. A save never counts a Live dataset ──────────────────────────────────
  const live = await liveRecord.saveLiveRecord(P, {
    name: 'Orders live', columns: [T('region'), N('sales')], origin: { kind: 'connection', connId: '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d', table: 'orders' },
  });
  if (live) {
    trace.reset();
    const lv = await call('catalog:setTable', { projectId: P, datasetId: live.id, patch: { key: 'region', role: 'fact' } });
    ok('a Live dataset\'s key save stores the key and counts nothing', lv.ok === true && lv.table.key === 'region' && !('keyCheck' in lv.table), JSON.stringify(lv));
    ok('…and a key it does not have is still refused, from its declared columns', (await call('catalog:setTable', { projectId: P, datasetId: live.id, patch: { key: 'nope' } })).ok === false);
    const snap = trace.snapshot();
    ok('…and sent the warehouse nothing', Object.keys(snap).every((op) => !op.startsWith('live:')), JSON.stringify(snap));
  } else {
    ok('a Live record could be saved to test', false);
  }
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    if (failureCount()) { console.error('\n' + failureCount() + ' table-docs check(s) FAILED'); process.exit(1); }
    console.log('\nAll table-docs checks passed.');
    finish();
  });
