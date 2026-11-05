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
//   8. THE CHANNELS FAIL HONESTLY. A typed refusal reaches the route; a count that throws after the key was saved still
//      replies ok with the saved doc; "the key changed" is the store's locked answer; the key column is found BY NAME in
//      the columns each source returns, never at an index read earlier; the two catch-all sentences are the catalog's.
//   9. THE ROWS CHANGING RE-CHECKS (afterTableData, riding runQualityChecks). A relationship into a dataset carries a
//      stored warning (`repeats` / `not_key`) that follows its target's rows and declared key; a refresh that drops
//      the key column clears the count; a Live dataset sends the warehouse nothing until "Check now".
//
//   npm run build:ts && node scripts/test-tableDocs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';
import { captureLogs } from './logCapture';

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
const rel: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
const qualityRun: typeof import('../src/analysis/qualityRun') = require('../src/analysis/qualityRun');
const tableIpc: typeof import('../src/ipc/tableDocs') = require('../src/ipc/tableDocs');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveIpc: typeof import('../src/ipc/liveDatasets') = require('../src/ipc/liveDatasets');
tableIpc.register();
require('../src/ipc/relationships').register();
fakeMod.registerLiveFake();

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

  // A doc's drill hierarchies (written by a later release; this one only keeps them) survive a notes save.
  const GEO = { id: '00000000-0000-4000-8000-000000000081', name: 'Geography', levels: ['line_id', 'qty'] };
  await catalog.mutateCatalog(P, (file) => { file.tables![D] = store.sanitizeTableDoc({ ...file.tables![D], hierarchies: [GEO] }); });
  const kept = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { grain: 'One row per line' } });
  ok('a notes save keeps the doc\'s hierarchies', kept.ok === true && JSON.stringify((await store.getTableDoc(P, D)).hierarchies) === JSON.stringify([GEO]), JSON.stringify(await store.getTableDoc(P, D)));
  ok('…and the reply carries them', JSON.stringify(kept.table.hierarchies) === JSON.stringify([GEO]));

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
    && (api.contracts as any)['catalog:setTable'].access === 'write' && !(api.contracts as any)['catalog:checkKey'].input.safeParse({ projectId: P, datasetId: D, key: 'x' }).success
    && !(api.contracts as any)['catalog:getTable'].input.safeParse({ projectId: P, datasetId: D, key: 'x' }).success
    && (api.contracts as any)['catalog:getTable'].input.safeParse({ projectId: P, datasetId: D }).success);

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

  // ── 8. The channels fail honestly ──────────────────────────────────────────
  await call('catalog:setTable', { projectId: P, datasetId: D, patch: { guide: '', grain: '' } }); // the caps test left 8,000 characters here
  const realResident = datasets.residentSource;
  const realMeta = datasets.getDatasetMeta;
  const realSetDoc = store.setTableDoc;
  const realReadable = store.readableTableDoc;
  const rejection = async (ch: string, payload: unknown): Promise<unknown> => { try { await call(ch, payload); return null; } catch (err) { return err; } };

  (datasets as any).residentSource = async (): Promise<never> => { throw new liveDataset.LiveDatasetError(D); };
  const lde = await rejection('catalog:checkKey', { projectId: P, datasetId: D });
  ok('a LiveDatasetError from the count reaches the route, typed (not "could not be counted")', liveDataset.isLiveDatasetError(lde), String(lde));

  // A count that throws AFTER the save: the key is stored, the reply is ok with that doc, and Check now retries.
  (datasets as any).residentSource = async (): Promise<never> => { throw new Error('boom /srv/secret/path.parquet'); };
  const broke = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'qty' } });
  ok('a count that throws after the save replies ok with the saved doc, not "could not save"', broke.ok === true && broke.table.key === 'qty' && !('keyCheck' in broke.table), JSON.stringify(broke));
  ok('…and the key IS stored', (await call('catalog:getTable', { projectId: P, datasetId: D })).table.key === 'qty');
  const brokeCheck = await call('catalog:checkKey', { projectId: P, datasetId: D });
  ok('…while Check now on that failure says so without the error\'s own words', brokeCheck.ok === false && brokeCheck.error === msg.keyCheckFailed() && !brokeCheck.error.includes('secret'), JSON.stringify(brokeCheck));
  (datasets as any).residentSource = realResident;
  const retried = await call('catalog:checkKey', { projectId: P, datasetId: D });
  ok('…and Check now retries it', retried.ok === true && JSON.stringify(counts(retried.table)) === JSON.stringify({ rows: 4, empty: 0, repeatedKeys: 0 }), JSON.stringify(retried));

  // "The key changed" is the store's locked answer: another request flips the key between this one's reads and its write.
  await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'qty' } });
  (store as any).setTableDoc = async (p: string, d: string, patch: any): Promise<any> => {
    await realSetDoc(p, d, { key: 'line_id' }); // the other request
    return realSetDoc(p, d, patch);
  };
  const raced = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'qty' } });
  (store as any).setTableDoc = realSetDoc;
  ok('a key that changed under the lock is counted: the reply carries qty\'s check', raced.ok === true && raced.table.key === 'qty' && JSON.stringify(counts(raced.table)) === JSON.stringify({ rows: 4, empty: 0, repeatedKeys: 0 }), JSON.stringify(raced));
  const same = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'qty', grain: 'unchanged key' } });
  (store as any).setTableDoc = async (p: string, d: string, patch: any): Promise<any> => realSetDoc(p, d, patch);
  hydrated = 0;
  (datasets as any).residentSource = async (...a: any[]): Promise<any> => { hydrated += 1; return (realResident as any)(...a); };
  const again2 = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'qty', guide: 'same key again' } });
  (datasets as any).residentSource = realResident;
  (store as any).setTableDoc = realSetDoc;
  ok('NEGATIVE CONTROL: saving the same key again counts nothing', same.ok === true && again2.ok === true && hydrated === 0, `${hydrated} count(s)`);
  await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'line_id' } });

  // The key column is found BY NAME in what each source returns: meta (read first) lists the columns in another order.
  const reversed = async (...a: any[]): Promise<any> => { const m = await (realMeta as any)(...a); return m && { ...m, columns: [...m.columns].reverse() }; };
  (datasets as any).getDatasetMeta = reversed;
  const byName = await call('catalog:checkKey', { projectId: P, datasetId: D });
  (datasets as any).residentSource = async (): Promise<null> => null;
  const byNameJs = await call('catalog:checkKey', { projectId: P, datasetId: D });
  (datasets as any).residentSource = realResident;
  (datasets as any).getDatasetMeta = realMeta;
  ok('a column order that differs from the source\'s: the resident count is still line_id\'s', byName.ok === true && JSON.stringify(counts(byName.table)) === JSON.stringify(COUNTS), JSON.stringify(byName));
  ok('…and so is the JS reference\'s', byNameJs.ok === true && JSON.stringify(counts(byNameJs.table)) === JSON.stringify(COUNTS), JSON.stringify(byNameJs));
  // A column gone from the source (meta still lists it): no count is stored, from either engine.
  await store.setTableDoc(P, D, { key: 'ghost' });
  (datasets as any).getDatasetMeta = async (...a: any[]): Promise<any> => { const m = await (realMeta as any)(...a); return m && { ...m, columns: [...m.columns, T('ghost')] }; };
  const goneFast = await call('catalog:checkKey', { projectId: P, datasetId: D });
  (datasets as any).residentSource = async (): Promise<null> => null;
  const goneJs = await call('catalog:checkKey', { projectId: P, datasetId: D });
  (datasets as any).residentSource = realResident;
  (datasets as any).getDatasetMeta = realMeta;
  ok('a key column gone from the source stores no count (resident and JS)', goneFast.ok === false && goneJs.ok === false && !('keyCheck' in (await store.getTableDoc(P, D))), JSON.stringify([goneFast, goneJs]));
  await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'line_id' } });

  // The catch-all sentences are the catalog's.
  (store as any).readableTableDoc = async (): Promise<never> => { throw new Error('/srv/data/x.json'); };
  const noRead = await call('catalog:getTable', { projectId: P, datasetId: D });
  (store as any).readableTableDoc = realReadable;
  ok('getTable that throws says the catalog\'s sentence, not the error\'s', noRead.ok === false && noRead.error === 'Could not read the table notes.' && noRead.error === msg.tableNotesNotRead(), JSON.stringify(noRead));
  (store as any).setTableDoc = async (): Promise<never> => { throw new Error('/srv/data/x.json'); };
  const noSave = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { grain: 'g' } });
  (store as any).setTableDoc = realSetDoc;
  ok('setTable that throws before the save says the catalog\'s sentence', noSave.ok === false && noSave.error === 'Could not save the table notes.' && noSave.error === msg.tableNotesNotSaved(), JSON.stringify(noSave));

  // ── 9. The rows changing re-checks the key and the relationships into it ───
  const CUSTCOLS = [T('customer_id'), T('email')];
  const custRows = (ids: string[]): Cell[][] => ids.map((id, i) => [id, `c${i}@x.test`]);
  const CUST = (await datasets.saveDataset(P, { name: 'Customers', sourceKind: 'csv', columns: CUSTCOLS, rows: custRows(['1', '2', '2', '3']) }))!.id;
  const ORD = (await datasets.saveDataset(P, { name: 'Orders 2', sourceKind: 'csv', columns: [T('customer_id'), N('amount')], rows: [['1', 10], ['2', 20], ['3', 30], ['3', 40]] }))!.id;
  const warningOf = async (id: string): Promise<unknown> => (await call('relationship:list', { projectId: P })).relationships.find((r: any) => r.id === id)?.warning;
  const edge = { from: { datasetId: ORD, column: 'customer_id' }, to: { datasetId: CUST, column: 'customer_id' }, cardinality: 'many_to_one' };
  const saved = await call('relationship:save', { projectId: P, relationship: edge });
  const relId: string = saved.relationship?.id;
  ok('relationship:save stores a repeats warning', JSON.stringify(saved.relationship?.warning) === JSON.stringify({ kind: 'repeats', repeats: 1 }), JSON.stringify(saved));
  ok('…and relationship:list still has it', JSON.stringify(await warningOf(relId)) === JSON.stringify({ kind: 'repeats', repeats: 1 }));
  ok('a client cannot send its own warning (the contract is strict)', !(api.contracts as any)['relationship:save'].input.safeParse({ projectId: P, relationship: { ...edge, warning: { kind: 'repeats', repeats: 0 } } }).success);

  await datasets.updateDatasetData(P, CUST, { columns: CUSTCOLS, rows: custRows(['1', '2', '3', '4']) });
  await qualityRun.runQualityChecks(P, CUST);
  const clean = (await call('relationship:list', { projectId: P })).relationships.find((r: any) => r.id === relId);
  ok('after the target\'s rows are unique, the quality hook clears the warning', clean && !('warning' in clean), JSON.stringify(clean));
  ok('…and verified.matched is recounted over the new rows', clean?.verified.matched === 4 && clean.verified.unmatchedFrom === 0, JSON.stringify(clean?.verified));
  ok('…keeping the entry\'s id', clean?.id === relId);

  await datasets.updateDatasetData(P, CUST, { columns: CUSTCOLS, rows: custRows(['1', '2', '2', '4']) });
  await qualityRun.runQualityChecks(P, CUST);
  const dupAgain = (await call('relationship:list', { projectId: P })).relationships.find((r: any) => r.id === relId);
  ok('a refresh that repeats a key brings the warning back, with the new rows\' counts', JSON.stringify(dupAgain?.warning) === JSON.stringify({ kind: 'repeats', repeats: 1 }) && dupAgain.verified.matched === 2 && dupAgain.verified.unmatchedFrom === 2, JSON.stringify(dupAgain));
  await datasets.updateDatasetData(P, CUST, { columns: CUSTCOLS, rows: custRows(['1', '2', '3', '4']) });
  await qualityRun.runQualityChecks(P, CUST);

  // A refresh that moved nothing writes nothing (and so drops no cached answer).
  const relFile = path.join(tmpUserData, 'projects', P, 'relationships.json');
  const stamp = fs.statSync(relFile).mtimeMs;
  await new Promise((r) => setTimeout(r, 25));
  await qualityRun.runQualityChecks(P, CUST);
  ok('a re-check that finds the same counts leaves relationships.json alone', fs.statSync(relFile).mtimeMs === stamp);

  const notKey = await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: 'email' } });
  ok('setTable { key } counts the key (email is unique)', notKey.ok === true && JSON.stringify(counts(notKey.table)) === JSON.stringify({ rows: 4, empty: 0, repeatedKeys: 0 }), JSON.stringify(notKey));
  ok('…and the relationship into customer_id now warns that email is the key', JSON.stringify(await warningOf(relId)) === JSON.stringify({ kind: 'not_key', key: 'email' }), JSON.stringify(await warningOf(relId)));
  await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: 'customer_id' } });
  ok('declaring the joined column the key clears it (customer_id is unique)', (await warningOf(relId)) === undefined, JSON.stringify(await warningOf(relId)));
  await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: 'email' } });
  await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: '' } });
  ok('clearing the key clears a not_key warning', (await warningOf(relId)) === undefined, JSON.stringify(await warningOf(relId)));
  const refreshed = await call('relationship:save', { projectId: P, relationship: { ...edge, id: relId } });
  ok('a re-save computes a fresh warning (none here) and keeps the id', refreshed.relationship?.id === relId && !('warning' in refreshed.relationship), JSON.stringify(refreshed));
  await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: 'email' } });
  const keyed = await call('relationship:save', { projectId: P, relationship: { ...edge, id: relId } });
  ok('relationship:save against a declared key that is another column stores not_key', JSON.stringify(keyed.relationship?.warning) === JSON.stringify({ kind: 'not_key', key: 'email' }), JSON.stringify(keyed));
  ok('relWarning: nothing for the declared key or a unique column; repeats only when no other key is declared; not_key otherwise',
    rel.relWarning({ matched: 4, unmatchedFrom: 0, fromKeys: 3, fromKeyed: 4, toKeys: 4, toKeyed: 4 }, 'customer_id', 'customer_id') === undefined
    && rel.relWarning({ matched: 4, unmatchedFrom: 0, fromKeys: 3, fromKeyed: 4, toKeys: 3, toKeyed: 4 }, '', 'customer_id')?.kind === 'repeats'
    && rel.relWarning({ matched: 4, unmatchedFrom: 0, fromKeys: 3, fromKeyed: 4, toKeys: 3, toKeyed: 4 }, 'email', 'customer_id')?.kind === 'not_key');
  await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: '' } });

  // Every write to relationships.json takes the lock. The harness makes the overlap certain: a read of the file is held
  // after it has returned until the OTHER writer has read too (or 200 ms pass, which is what the lock makes happen,
  // since the second writer cannot read before the first has written). Without the lock both write from the same base.
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const realRead = recordFs.readFile;
  const before = (await call('relationship:list', { projectId: P })).relationships.length;
  let reads = 0;
  let bothRead!: () => void;
  const barrier = new Promise<void>((r) => { bothRead = r; });
  (recordFs as any).readFile = async (...a: any[]): Promise<any> => {
    const data = await (realRead as any)(...a);
    if (String(a[0]).endsWith('relationships.json')) {
      reads += 1;
      if (reads >= 2) bothRead();
      await Promise.race([barrier, new Promise((r) => setTimeout(r, 200))]);
    }
    return data;
  };
  const [w1, w2] = await Promise.all([
    rel.saveRelationship(P, { from: { datasetId: D, column: 'line_id' }, to: { datasetId: CUST, column: 'customer_id' }, cardinality: 'many_to_one' }),
    rel.saveRelationship(P, { from: { datasetId: NOKEY, column: 'note' }, to: { datasetId: CUST, column: 'email' }, cardinality: 'many_to_one' }),
  ]);
  (recordFs as any).readFile = realRead;
  const after = await rel.listRelationships(P);
  ok('two writers that read the file at once both land: the lock serializes them', !!w1 && !!w2 && after.length === before + 2 && after.some((x) => x.id === w1.id) && after.some((x) => x.id === w2.id), `${before} -> ${after.length}, ${reads} read(s)`);
  ok('…and each did read the file (the harness was in the way)', reads >= 2, `${reads} read(s)`);
  await call('relationship:delete', { projectId: P, id: w1!.id });
  await call('relationship:delete', { projectId: P, id: w2!.id });
  ok('relationship:delete still removes one, and a second delete says no', (await call('relationship:list', { projectId: P })).relationships.length === before && (await call('relationship:delete', { projectId: P, id: w1!.id })).ok === false);

  // A key count that throws does not skip the re-check of the relationships into the dataset.
  await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: 'customer_id' } });
  const realWriteCheck = store.writeKeyCheck;
  (store as any).writeKeyCheck = async (): Promise<never> => { throw new Error('boom'); };
  await datasets.updateDatasetData(P, CUST, { columns: CUSTCOLS, rows: custRows(['1', '2', '2', '4']) });
  await qualityRun.runQualityChecks(P, CUST);
  (store as any).writeKeyCheck = realWriteCheck;
  ok('a key count that throws still lets the hook re-verify the relationships (repeats back)', JSON.stringify(await warningOf(relId)) === JSON.stringify({ kind: 'repeats', repeats: 1 }), JSON.stringify(await warningOf(relId)));
  await datasets.updateDatasetData(P, CUST, { columns: CUSTCOLS, rows: custRows(['1', '2', '3', '4']) });
  await qualityRun.runQualityChecks(P, CUST);
  await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: '' } });

  // A re-check that counted under an older key must not overwrite what the newer key's re-check wrote.
  const realGetDoc = store.getTableDoc;
  let fired = false;
  (store as any).getTableDoc = async (...a: any[]): Promise<any> => {
    const doc = await (realGetDoc as any)(...a); // the key as this re-check sees it: none
    if (!fired) { fired = true; await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: 'email' } }); } // a person declares email meanwhile
    return doc;
  };
  await tableIpc.recheckRelationshipsTo(P, CUST);
  (store as any).getTableDoc = realGetDoc;
  ok('a re-check that counted under the old key leaves the new key\'s not_key warning alone', JSON.stringify(await warningOf(relId)) === JSON.stringify({ kind: 'not_key', key: 'email' }), JSON.stringify(await warningOf(relId)));
  await call('catalog:setTable', { projectId: P, datasetId: CUST, patch: { key: '' } });

  // relationship:save reads each key column BY NAME in the columns its source returns (resident and JS), as the key check does.
  const baseline = await call('relationship:save', { projectId: P, relationship: edge });
  (datasets as any).getDatasetMeta = reversed; // the metadata lists every dataset's columns in another order than its source
  const viaMeta = await call('relationship:save', { projectId: P, relationship: edge });
  (datasets as any).residentSource = async (): Promise<null> => null;
  const viaMetaJs = await call('relationship:save', { projectId: P, relationship: edge });
  (datasets as any).residentSource = realResident;
  (datasets as any).getDatasetMeta = realMeta;
  ok('relationship:save counts the named columns when the metadata order differs (resident)', baseline.ok === true && JSON.stringify(viaMeta.stats) === JSON.stringify(baseline.stats), JSON.stringify([baseline.stats, viaMeta.stats]));
  ok('…and the JS reference does too', JSON.stringify(viaMetaJs.stats) === JSON.stringify(baseline.stats), JSON.stringify(viaMetaJs.stats));
  const listed0 = (await call('relationship:list', { projectId: P })).relationships.length;
  (datasets as any).getDatasetMeta = async (...a: any[]): Promise<any> => { const m = await (realMeta as any)(...a); return m && { ...m, columns: [...m.columns, T('ghost')] }; };
  const ghostEdge = await call('relationship:save', { projectId: P, relationship: { ...edge, from: { datasetId: ORD, column: 'ghost' } } });
  (datasets as any).getDatasetMeta = realMeta;
  ok('a key column gone from its source saves no relationship (never a count of zeros)', ghostEdge.ok === false && (await call('relationship:list', { projectId: P })).relationships.length === listed0, JSON.stringify(ghostEdge));

  // A refresh that drops the key column clears the count (the key stays: it is the person's); one that brings it back counts again.
  await call('catalog:setTable', { projectId: P, datasetId: D, patch: { key: 'line_id' } });
  ok('the key is counted before the refresh', counts(await store.getTableDoc(P, D)) !== undefined);
  await datasets.updateDatasetData(P, D, { columns: [N('qty')], rows: [[1], [2], [3], [4]] });
  await qualityRun.runQualityChecks(P, D);
  const lost = await call('catalog:getTable', { projectId: P, datasetId: D });
  ok('a refresh that drops the key column clears keyCheck', lost.ok === true && lost.table.key === 'line_id' && !('keyCheck' in lost.table), JSON.stringify(lost));
  await datasets.updateDatasetData(P, D, { columns: [N('qty'), T('line_id')], rows: [[1, 'L1'], [2, 'L2'], [3, 'L2'], [4, 'L3']] });
  await qualityRun.runQualityChecks(P, D);
  ok('…and one that brings it back (in another position) counts it again, by name', JSON.stringify(counts((await call('catalog:getTable', { projectId: P, datasetId: D })).table)) === JSON.stringify(COUNTS));

  // A recapture (replace, append) is a data change the quality hook now sees: the key is counted again.
  require('../src/ipc/captureDataset').register();
  const CAP = (await datasets.saveDataset(P, { name: 'Captured', sourceKind: 'capture', columns: [T('code')], rows: [['A'], ['B'], ['B']] }))!.id;
  const capKeyed = await call('catalog:setTable', { projectId: P, datasetId: CAP, patch: { key: 'code' } });
  ok('setup: the captured table\'s key is counted (3 rows, 1 repeated key)', JSON.stringify(counts(capKeyed.table)) === JSON.stringify({ rows: 3, empty: 0, repeatedKeys: 1 }), JSON.stringify(capKeyed));
  const recap = await call('captureDataset:save', { projectId: P, columns: [{ name: 'code', type: 'text' }], rows: [['A'], ['B'], ['C'], ['D']], target: { mode: 'replace', datasetId: CAP } });
  ok('a recapture that replaces the rows recounts the key: 4 rows, none repeated', recap.ok === true && JSON.stringify(counts(await store.getTableDoc(P, CAP))) === JSON.stringify({ rows: 4, empty: 0, repeatedKeys: 0 }), JSON.stringify(recap).slice(0, 200));
  const appended = await call('captureDataset:save', { projectId: P, columns: [{ name: 'code', type: 'text' }], rows: [['D']], target: { mode: 'append', datasetId: CAP } });
  ok('…and one that appends recounts it: 5 rows, D repeated', appended.ok === true && JSON.stringify(counts(await store.getTableDoc(P, CAP))) === JSON.stringify({ rows: 5, empty: 0, repeatedKeys: 1 }), JSON.stringify(appended).slice(0, 200));

  // Nothing documented, nothing related: the hook reads no rows.
  hydrated = 0;
  (datasets as any).getDataset = async (...args: any[]): Promise<any> => { hydrated += 1; return (realGet as any)(...args); };
  (datasets as any).residentSource = async (...a: any[]): Promise<any> => { hydrated += 1; return (realResident as any)(...a); };
  await tableIpc.afterTableData(P, NOKEY);
  (datasets as any).getDataset = realGet;
  (datasets as any).residentSource = realResident;
  ok('afterTableData on a dataset with no key and no relationship into it reads no rows', hydrated === 0, `${hydrated} read(s)`);
  ok('…and never throws, even for a dataset that is gone', (await tableIpc.afterTableData(P, '5d3b6f0e-6c1f-4a8e-9a3e-0e5a1b2c3d4e')) === undefined);

  // Live: a save, the hook and a refresh send the warehouse nothing; only Check now does, once.
  const conn = await connections.saveConnection(P, { name: 'Fake warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: { fixture: 'orders' } });
  const lv2 = conn && await liveRecord.saveLiveRecord(P, { name: 'Live fake orders', columns: fakeMod.ORDERS_COLUMNS, origin: { kind: 'connection', connId: conn.id, table: fakeMod.ORDERS_TABLE } });
  if (lv2) {
    const calls = (): number => fakeMod.fake.calls.length;
    const c0 = calls();
    const lsave = await call('catalog:setTable', { projectId: P, datasetId: lv2.id, patch: { key: 'region' } });
    await tableIpc.afterTableData(P, lv2.id);
    await qualityRun.runQualityChecks(P, lv2.id);
    const lrefresh = await liveIpc.refreshLive(P, lv2.id);
    ok('Live: a key save, the hook and a refresh send the warehouse nothing', lsave.ok === true && !('keyCheck' in lsave.table) && lrefresh?.ok === true && calls() === c0, `${calls() - c0} call(s) ${JSON.stringify(lsave)}`);
    const lcheck = await call('catalog:checkKey', { projectId: P, datasetId: lv2.id });
    ok('…then Check now sends exactly one, and stores its count (240 rows, 4 regions repeated)', calls() === c0 + 1 && lcheck.ok === true && JSON.stringify(counts(lcheck.table)) === JSON.stringify({ rows: 240, empty: 0, repeatedKeys: 4 }), `${calls() - c0} call(s) ${JSON.stringify(lcheck)}`);
    // A relationship FROM a Live dataset has no rows here to re-verify: the re-check skips it before reading, and says nothing.
    const liveEdge = await rel.saveRelationship(P, { from: { datasetId: lv2.id, column: 'region' }, to: { datasetId: CUST, column: 'customer_id' }, cardinality: 'many_to_one' });
    const touched: string[] = [];
    const wasGet = datasets.getDataset;
    const wasRes = datasets.residentSource;
    (datasets as any).getDataset = async (p: string, id: string, ...r: any[]): Promise<any> => { touched.push(id); return (wasGet as any)(p, id, ...r); };
    (datasets as any).residentSource = async (p: string, id: string, ...r: any[]): Promise<any> => { touched.push(id); return (wasRes as any)(p, id, ...r); };
    const cap = captureLogs();
    await tableIpc.recheckRelationshipsTo(P, CUST);
    cap.restore();
    (datasets as any).getDataset = wasGet;
    (datasets as any).residentSource = wasRes;
    ok('a Live FROM side is skipped: its rows are never asked for, and nothing is logged as an error', !!liveEdge && !touched.includes(lv2.id) && touched.includes(ORD) && cap.at('error').length === 0, `${touched.length} read(s) ${JSON.stringify(cap.at('error'))}`);
    if (liveEdge) await rel.deleteRelationship(P, liveEdge.id);
    await tableIpc.afterTableData(P, lv2.id);
    ok('…and the hook still leaves that Live count alone', calls() === c0 + 1 && counts(await store.getTableDoc(P, lv2.id))?.rows === 240);
  } else {
    ok('a Live record over the fake warehouse could be saved to test', false);
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
