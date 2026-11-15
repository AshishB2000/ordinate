// The Assistant's search of the Data model (step 3): the index (0027_assistant_search.sql,
// src/server/assistantSearchIndex.ts, kept current by every write in recordFs) gives the SAME answer as reading every
// store (src/ipc/assistantSearch.ts referenceModel), field by field and in order, with Object.is.
//
// Always (no database: the reference is the answer): the word rules (fold, stop words), the ranking (exact names
// first, certified first at an equal score, retired left out), access (a viewer gets no source table and no hidden
// column, no metric or term on one, a page of hidden columns reads the next; NEGATIVE CONTROL: the admin gets them), the
// counts (no columns; nothing the caller may not see).
// With DATABASE_URL (a scratch database it may CREATE DATABASE on):
//   1. THE DIFFERENTIAL: questions × kinds × limits × datasets × {admin, editor, viewer}, index === reference.
//   2. Once built, a query reads no record and rebuilds nothing; NEGATIVE CONTROL: the reference reads them.
//   3. ON WRITE, no rebuild: a renamed dataset, a new metric, a trashed term, a changed column doc (only its dataset's
//      catalog rows rewritten), a retired metric and a new source table are followed by the very next query.
//      NEGATIVE CONTROL: a row changed behind the index makes the differential FAIL.
//   4. An older pod's write (no `ordinate.assistant_search`) drops that source's marker; the next query rebuilds it.
//   5. A save never fails for the index: a describer that throws, or none, drops the marker; the next query finds it.
//   6. Access on the index path (source tables, hidden columns, metrics and terms on them, the counts), and no row
//      value, example, value label, filter value or host in the index.
//   7. Scale: 2,000 datasets × 20 columns, 5,000 metrics, 2,000 terms, 10,000 column docs: build, query, write times.
//   8. A failing index query: the reference answers. A deleted project leaves no rows and no markers.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-assistantSearch.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-assistantsearch-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const columnAccess: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const sourceTables: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const mw: typeof import('../src/ai/modelWords') = require('../src/ai/modelWords');
const index: typeof import('../src/server/assistantSearchIndex') = require('../src/server/assistantSearchIndex');
const search: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
import { scaleLeg } from './assistantSearchScale';

type Identity = import('../src/server/context').Identity;
type ModelHit = import('../src/ipc/assistantSearch').ModelHit;
type SearchOptions = import('../src/ipc/assistantSearch').SearchOptions;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const WHO: Array<[string, Identity]> = [['admin', ADMIN], ['editor', EDITOR], ['viewer', VIEWER]];
/** Values the index must never hold: a row's, a column's example and value label, a term's filter value, a connection's host. */
const CANARY = { row: 'ROW_CANARY_41', example: 'EXAMPLE_CANARY_41', value: 'VALUE_CANARY_41', label: 'LABEL_CANARY_41', filter: 'FILTER_CANARY_41', host: 'canary-host-41.example.com' };
/** Staff's columns hidden from the viewer (every rule names someone else): 24 of them, so one page of results is all hidden. */
const HIDDEN = ['salary', 'ssn', ...Array.from({ length: 22 }, (_, i) => `pay_${String(i + 1).padStart(2, '0')}`)];

let req = 0;
const as = <T>(who: Identity, P: string | null, fn: () => Promise<T>): Promise<T> =>
  context.runInContext(who, `r${++req}`, async () => {
    if (P && who !== ADMIN) caller.seedRank(P, who === EDITOR ? 2 : 1); // what the RPC route seeds from `authorize`
    return fn();
  });

interface World { P: string; orders: string; staff: string; customers: string; revenue: string; gross: string; net: string; term: string; conn: string }

async function world(label: string): Promise<World> {
  return as(ADMIN, null, async () => {
    await projects.init();
    const P = (await projects.createProject(label)).id;
    const save = async (name: string, cols: Array<[string, 'text' | 'number']>, row: Array<string | number>) =>
      (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: cols.map(([n, type]) => ({ name: n, type })), rows: [row] }))!.id;
    const orderCols: Array<[string, 'text' | 'number']> = [['region', 'text'], ['sales_amount', 'number'], ['order_date', 'text'], ['customer', 'text'], ['quantity', 'number']];
    const orders = await save('Online orders', orderCols, ['West', 1, '2026-01-01', CANARY.row, 2]);
    const staffCols: Array<[string, 'text' | 'number']> = [['dept', 'text'], ...HIDDEN.map((c): [string, 'number'] => [c, 'number']), ['pay_grade', 'text']];
    const staff = await save('Staff', staffCols, staffCols.map(([, t]) => (t === 'number' ? 1 : 'x')));
    const customers = await save('Customers', [['city', 'text'], ['segment', 'text']], ['Paris', 'SMB']);
    await record.serialized(record.datasetFilePath(P, staff), (raw) => {
      raw.columnAccess = columnAccess.buildColumnAccess(raw, HIDDEN.map((column) => ({ column, visibleTo: [{ userId: crypto.randomUUID() }] })), 'ana@acme.test', new Date().toISOString());
      return true;
    });
    await catalog.setDoc(P, `dataset:${orders}`, { description: 'Every order placed online, one row per order' });
    await catalog.setColumn(P, orders, 'region', { aliases: ['territory'], displayName: 'Sales region', description: 'Where the order shipped', example: CANARY.example, values: [{ value: CANARY.value, label: CANARY.label }] }, orderCols.map(([n]) => n));
    await catalog.setColumn(P, staff, 'salary', { aliases: ['wage'], description: 'Annual pay before tax' });
    const metric = async (name: string, datasetId: string, column: string, description?: string) =>
      (await metrics.saveMetric(P, { name, datasetId, definition: { column, aggregation: 'sum' }, ...(description ? { description } : {}) }))!.id;
    const revenue = await metric('Revenue', orders, 'sales_amount', 'Total sales revenue');
    const old = await metric('Revenue (old)', orders, 'sales_amount', 'Sales revenue before returns');
    const gross = await metric('Gross margin', orders, 'sales_amount');
    const net = await metric('Net margin', orders, 'sales_amount');
    await metric('Payroll', staff, 'salary', 'Annual pay of every employee');
    // A term on a column hidden from the viewer: left out for them, as Payroll (a metric on salary) is.
    await terms.saveTerm(P, { name: 'High earners', aliases: [], datasetId: staff, filters: [{ type: 'filter', column: 'salary', op: '>', value: 1 }] });
    const term = (await terms.saveTerm(P, { name: 'West coast', aliases: ['Pacific'], description: 'Orders shipped to the west', datasetId: orders, filters: [{ type: 'filter', column: 'region', op: '=', value: CANARY.filter }] }))!.id;
    // Gross margin is the OLDER of the two margins: certified, it still ranks first.
    await catalog.updateStatus(P, (s) => {
      s[`metric:${gross}`] = { status: 'certified', by: 'ana@acme.test', at: '', note: '' };
      s[`metric:${old}`] = { status: 'retired', by: 'ana@acme.test', at: '', note: '' };
    });
    const conn = (await connections.saveConnection(P, { name: 'Warehouse', connectorId: 'postgres', values: { host: CANARY.host, port: 5432, database: 'app', user: 'reader' } } as never))!.id;
    for (const t of ['ANALYTICS.SALES_ORDERS', 'ANALYTICS.CUSTOMERS']) await sourceTables.createSourceDoc(P, conn, t, { guide: 'Use order_date' });
    return { P, orders, staff, customers, revenue, gross, net, term, conn };
  });
}

function same(a: readonly ModelHit[] | null, b: readonly ModelHit[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i] as unknown as Record<string, unknown>;
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => Object.is((x as unknown as Record<string, unknown>)[k], y[k]));
  });
}
const names = (hs: readonly ModelHit[] | null): string[] => (hs ?? []).map((h) => `${h.kind}:${h.name}`);
const ref = (who: Identity, P: string, q: string, o: SearchOptions) => as(who, P, () => search.referenceModel(P, q, o));
const idx = (who: Identity, P: string, q: string, o: SearchOptions) => as(who, P, () => search.indexedModel(P, q, o));

const QUESTIONS = ['revenue', 'Revenue by territory', 'what were the sales by region last month', 'margin', 'online orders', 'pay', 'salary', 'payroll earners', 'pacific',
  'analytics sales', 'customers', 'clients', 'churn', 'bookings', 'buyer', 'zzz', '', '???'];
const KINDS: Array<SearchOptions['kinds']> = [undefined, ['column'], ['metric', 'term'], ['dataset', 'table']];

/** Every question × kinds × limit × datasets × caller: the index's answer is the reference's. */
async function differential(w: World, label: string): Promise<boolean> {
  const unequal: string[] = [];
  for (const [who, id] of WHO) for (const q of QUESTIONS) for (const kinds of KINDS) for (const limit of [1, 12]) for (const datasetIds of [undefined, [w.orders]]) {
    const o: SearchOptions = { limit, ...(kinds ? { kinds } : {}), ...(datasetIds ? { datasetIds } : {}) };
    const [r, i] = [await ref(id, w.P, q, o), await idx(id, w.P, q, o)];
    if (!same(r, i)) unequal.push(`${label} ${who} "${q}" ${JSON.stringify(o)}: ${JSON.stringify(r)} vs ${JSON.stringify(i)}`);
  }
  for (const [who, id] of WHO) {
    const [r, i] = [await as(id, w.P, () => search.referenceCount(w.P)), await as(id, w.P, () => search.indexedCount(w.P))];
    if (!i || !Object.keys(r).every((k) => Object.is(r[k as keyof typeof r], i[k as keyof typeof i]))) unequal.push(`${label} ${who} counts: ${JSON.stringify(r)} vs ${JSON.stringify(i)}`);
  }
  if (unequal.length) console.log(unequal.slice(0, 5).join('\n'));
  return unequal.length === 0;
}

function pureRules(): void {
  const folds: Array<[string, string]> = [['sales', 'sale'], ['categories', 'category'], ['addresses', 'address'], ['boxes', 'box'], ['branches', 'branch'], ['status', 'status'], ['analysis', 'analysis'], ['gross', 'gross'], ['ids', 'ids'], ['region', 'region']];
  ok('fold: plurals fold, ss/us/is endings and short words stay', folds.every(([a, b]) => mw.fold(a) === b), folds.map(([a]) => mw.fold(a)));
  ok('words: split, squashed, stop words gone, folded, deduplicated', mw.searchWords('What were the Sales by Territory? sales_amount, SALES').join() === 'sale,territory,amount', mw.searchWords('What were the Sales by Territory? sales_amount, SALES'));
  ok('words: a word is cut to 64 code points', mw.searchWords('x'.repeat(100))[0].length === 64);
}

async function pureLeg(): Promise<void> {
  pureRules();
  const w = await world('Assistant search, files');
  const { P } = w;
  ok('no database: the index path answers null (the reference runs)', (await idx(ADMIN, P, 'revenue', { limit: 5 })) === null);
  const rev = await ref(ADMIN, P, 'revenue', { limit: 10 });
  ok('rank: the metric named Revenue first, 4 for its name + 1 for its description; the retired one left out',
    rev[0]?.kind === 'metric' && rev[0].name === 'Revenue' && rev[0].score === 5 && !names(rev).includes('metric:Revenue (old)'), rev);
  const margin = await ref(ADMIN, P, 'margin', { limit: 5, kinds: ['metric'] });
  ok('rank: at an equal score the certified metric first, though it is the older', names(margin).join() === 'metric:Gross margin,metric:Net margin', margin);
  ok('words: an exact name finds itself first', (await ref(ADMIN, P, 'Online orders', { limit: 1 }))[0]?.name === 'Online orders');
  const terr = await ref(ADMIN, P, 'Revenue by territory', { limit: 5, kinds: ['column'] });
  ok('an "also called" name finds its column (2 a word)', terr[0]?.id === 'region' && terr[0].datasetId === w.orders && terr[0].score === 2, terr);
  ok('a term by its other name', (await ref(ADMIN, P, 'pacific', { limit: 5 }))[0]?.name === 'West coast');
  ok('nothing to search: no words, only stop words, or no match', (await ref(ADMIN, P, '', { limit: 5 })).length === 0 && (await ref(ADMIN, P, 'what were the', { limit: 5 })).length === 0 && (await ref(ADMIN, P, 'zzz', { limit: 5 })).length === 0);
  ok('datasetIds: only what is on those datasets (a source table is on none)', (await ref(ADMIN, P, 'sales', { limit: 50, datasetIds: [w.staff] })).every((h) => h.datasetId === w.staff));
  // Access, on the reference path
  const tables = async (who: Identity) => (await ref(who, P, 'analytics sales', { limit: 10 })).filter((h) => h.kind === 'table');
  ok('a viewer never gets a source table; an editor does (NEGATIVE CONTROL)', (await tables(VIEWER)).length === 0 && (await tables(EDITOR)).length === 2);
  const salary = async (who: Identity) => (await ref(who, P, 'salary wage', { limit: 10, kinds: ['column'] })).map((h) => h.id);
  ok('a hidden column is never returned to the viewer; the admin gets it (NEGATIVE CONTROL)', !(await salary(VIEWER)).includes('salary') && (await salary(ADMIN)).includes('salary'));
  const pay = await ref(VIEWER, P, 'pay', { limit: 1, kinds: ['column'] });
  const payAdmin = await ref(ADMIN, P, 'pay', { limit: 30, kinds: ['column'] });
  ok('a first page that is all hidden columns: the viewer gets the next visible one', names(pay).join() === 'column:pay_grade' && payAdmin.length === 24 && payAdmin[22]?.id === 'pay_grade', { pay, payAdmin: payAdmin.length });
  const hiddenUse = async (who: Identity) => names(await ref(who, P, 'payroll earners', { limit: 10 })).filter((n) => n === 'metric:Payroll' || n === 'term:High earners');
  ok('a metric or term on a hidden column is never returned to the viewer; the admin gets both (NEGATIVE CONTROL)', (await hiddenUse(VIEWER)).length === 0 && (await hiddenUse(ADMIN)).length === 2);
  const counts = await as(VIEWER, P, () => search.referenceCount(P));
  const editorCounts = await as(EDITOR, P, () => search.referenceCount(P));
  ok('counts: retired left out, no columns; the viewer counts no source table and nothing on a hidden column; the editor all of it (NEGATIVE CONTROL)',
    JSON.stringify(counts) === JSON.stringify({ dataset: 3, metric: 3, term: 1, table: 0 }) && JSON.stringify(editorCounts) === JSON.stringify({ dataset: 3, metric: 4, term: 2, table: 2 }), { counts, editorCounts });
  ok('searchModel without a database is the reference', same(await as(VIEWER, P, () => search.searchModel(P, 'pay salary', { limit: 3 })), await ref(VIEWER, P, 'pay salary', { limit: 3 })));
}

// ── with a database ─────────────────────────────────────────────────────────

const markers = async (pool: Pool, P: string): Promise<Record<string, string>> =>
  Object.fromEntries((await pool.query('SELECT source, built_at::text AS t FROM assistant_search_built WHERE project_id = $1 ORDER BY source', [P])).rows.map((r: { source: string; t: string }) => [r.source, r.t]));

/** Record reads and rebuild pages while `fn` runs. */
async function reads<T>(fn: () => Promise<T>): Promise<{ out: T; n: number }> {
  const orig = { readFile: recordFs.readFile, readMany: recordFs.readMany, readdir: recordFs.readdir, rowsUnder: recordFs.rowsUnder, listRecords: recordFs.listRecords };
  let n = 0;
  const m = recordFs as unknown as Record<string, unknown>;
  for (const [k, f] of Object.entries(orig)) m[k] = (...a: unknown[]) => { n++; return (f as (...x: unknown[]) => unknown)(...a); };
  try {
    return { out: await fn(), n };
  } finally {
    Object.assign(m, orig);
  }
}

async function dbLeg(pool: Pool): Promise<void> {
  const w = await world('Assistant search, Postgres');
  const { P } = w;

  // ── 1. the differential ─────────────────────────────────────────────────
  ok('no marker before the first query', Object.keys(await markers(pool, P)).length === 0);
  ok('THE DIFFERENTIAL: every question × kinds × limit × datasets × caller, and the counts, index === reference', await differential(w, 'first'));
  const built = await markers(pool, P);
  ok('the first query built all five sources', Object.keys(built).join() === 'catalog,datasets,metrics,tables,terms', JSON.stringify(built));

  // ── 2. a built index reads no record ────────────────────────────────────
  const q = await reads(() => idx(ADMIN, P, 'revenue by territory', { limit: 12 }));
  ok('built: a query reads no record (readFile, readMany, readdir, rowsUnder, listRecords) and rebuilds nothing', q.n === 0 && !!q.out?.length && JSON.stringify(await markers(pool, P)) === JSON.stringify(built), q);
  const c = await reads(() => as(EDITOR, P, () => search.indexedCount(P)));
  ok('…nor do the counts', c.n === 0 && c.out?.table === 2, c);
  const r = await reads(() => ref(ADMIN, P, 'revenue by territory', { limit: 12 }));
  ok('NEGATIVE CONTROL: the reference reads the stores', r.n > 0 && same(r.out, q.out), r.n); // a store's list is one paged query (#502), so a few calls

  // ── 3. on write, no rebuild ─────────────────────────────────────────────
  const catalogRows = async () => Object.fromEntries((await pool.query(
    `SELECT grp, string_agg(xmin::text, ',' ORDER BY ord) AS x FROM assistant_search WHERE project_id = $1 AND source = 'catalog' GROUP BY grp`, [P])).rows.map((x: { grp: string; x: string }) => [x.grp, x.x]));
  const before = await catalogRows();
  await as(ADMIN, null, async () => {
    await record.serialized(record.datasetFilePath(P, w.customers), (raw) => { raw.name = 'Clients'; return true; });
    await metrics.saveMetric(P, { name: 'Churn rate', datasetId: w.customers, definition: { column: 'city', aggregation: 'count' } });
    await trash.trashRecord(P, 'term', w.term);
    await catalog.setColumn(P, w.orders, 'customer', { aliases: ['buyer'] });
  });
  const after = await catalogRows();
  ok('a column doc saved: only its dataset\'s catalog rows were rewritten', before[`d:${w.orders}`] !== after[`d:${w.orders}`] && before[`d:${w.staff}`] === after[`d:${w.staff}`] && before.s === after.s, { before, after });
  const first = async (who: Identity, question: string, o: SearchOptions) => (await idx(who, P, question, o))?.[0];
  ok('a renamed dataset is found by its new name, not its old one', (await first(ADMIN, 'clients', { limit: 1, kinds: ['dataset'] }))?.id === w.customers && !(await first(ADMIN, 'customers', { limit: 1, kinds: ['dataset'] })));
  ok('a new metric is found', (await first(ADMIN, 'churn', { limit: 1 }))?.name === 'Churn rate');
  ok('a trashed term is not', !(await first(ADMIN, 'pacific', { limit: 5 })));
  ok('a changed column doc is found by its new "also called" name', (await first(ADMIN, 'buyer', { limit: 1 }))?.id === 'customer');
  await as(ADMIN, null, async () => {
    await catalog.updateStatus(P, (s) => { s[`metric:${w.net}`] = { status: 'retired', by: 'ana@acme.test', at: '', note: '' }; });
    await sourceTables.createSourceDoc(P, w.conn, 'ANALYTICS.BOOKINGS', {});
  });
  ok('a retired metric is left out', names(await idx(ADMIN, P, 'margin', { limit: 5 })).join() === 'metric:Gross margin');
  ok('a new source table is found by an editor', (await first(EDITOR, 'bookings', { limit: 1 }))?.name === 'ANALYTICS.BOOKINGS');
  ok('none of that rebuilt anything', JSON.stringify(await markers(pool, P)) === JSON.stringify(built));
  ok('THE DIFFERENTIAL after the writes', await differential(w, 'written'));
  await pool.query(`UPDATE assistant_search SET name_words = '{zzz}', all_words = '{zzz}' WHERE project_id = $1 AND item = $2`, [P, `metric:${w.revenue}`]);
  ok('NEGATIVE CONTROL: a row changed behind the index makes the differential FAIL', !(await differential(w, 'tampered (expected)')));
  await pool.query(`DELETE FROM assistant_search_built WHERE project_id = $1 AND source = 'metrics'`, [P]);
  ok('…dropping its marker rebuilds it right', await differential(w, 'repaired'));

  // ── 4. an older pod's write drops the marker ────────────────────────────
  const held = await markers(pool, P);
  const body = JSON.parse((await pool.query('SELECT body FROM records WHERE path = $1', [`projects/${P}/metrics/${w.revenue}.json`])).rows[0].body);
  const oldId = crypto.randomUUID();
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN; SELECT set_config('ordinate.org', 'acme', true), set_config('ordinate.verified_index', 'on', true)"); // a pod of 0026's release
    await cl.query('INSERT INTO records (org_id, path, body) VALUES ($1, $2, $3)', ['acme', `projects/${P}/metrics/${oldId}.json`, JSON.stringify({ ...body, id: oldId, name: 'Legacy bookings total' })]);
    await cl.query('COMMIT');
  } finally {
    cl.release();
  }
  const dropped = await markers(pool, P);
  ok('an older pod\'s write drops that source\'s marker, and only it', !dropped.metrics && Object.keys(dropped).length === 4 && dropped.datasets === held.datasets, dropped);
  const legacy = await idx(ADMIN, P, 'legacy', { limit: 1 });
  const rebuilt = await markers(pool, P);
  ok('…the next query rebuilds that source once and finds what it wrote', legacy?.[0]?.id === oldId && !!rebuilt.metrics && rebuilt.datasets === held.datasets, { legacy, rebuilt });
  const cl2 = await pool.connect();
  try {
    await cl2.query("BEGIN; SELECT set_config('ordinate.org', 'acme', true)");
    await cl2.query('UPDATE records SET updated_at = now() WHERE org_id = $1 AND path = ANY($2::text[])', ['acme', [`projects/${P}/catalog.json`, `projects/${P}/connections/${w.conn}.tables.json`]]);
    await cl2.query('COMMIT');
  } finally {
    cl2.release();
  }
  const touched = await markers(pool, P);
  ok('…one to catalog.json and a connection\'s table docs drops those two', !touched.catalog && !touched.tables && Object.keys(touched).length === 3, touched);

  // ── 5. a save never fails for the index ─────────────────────────────────
  index.useModelDescriber(() => { throw Object.assign(new Error('describer broke'), { code: 'TEST' }); });
  const broken = await as(ADMIN, null, () => metrics.saveMetric(P, { name: 'Bookings forecast', datasetId: w.orders, definition: { column: 'quantity', aggregation: 'sum' } }));
  ok('a describer that throws: the save goes through, and the metrics marker is dropped', !!broken && !(await markers(pool, P)).metrics);
  index.useModelDescriber(null);
  const scripted = await as(ADMIN, null, () => terms.saveTerm(P, { name: 'Bookings season', aliases: [], datasetId: w.orders, filters: [{ type: 'filter', column: 'quantity', op: '>', value: 1 }] }));
  ok('no describer (a script without the stores): the save goes through, the terms marker is dropped', !!scripted && !(await markers(pool, P)).terms);
  search.register();
  const found = names(await idx(ADMIN, P, 'bookings', { limit: 10, kinds: ['metric', 'term'] }));
  ok('…the next query rebuilds and finds both', found.includes('metric:Bookings forecast') && found.includes('term:Bookings season'), found);

  // ── 6. access on the index path; no value in the index ──────────────────
  const tables = async (who: Identity) => ((await idx(who, P, 'analytics', { limit: 10 })) ?? []).filter((h) => h.kind === 'table').length;
  ok('index: a viewer never gets a source table; an editor does (NEGATIVE CONTROL)', (await tables(VIEWER)) === 0 && (await tables(EDITOR)) === 3);
  const sal = async (who: Identity) => ((await idx(who, P, 'salary', { limit: 10 })) ?? []).map((h) => `${h.kind}:${h.id}`);
  ok('index: the hidden column is never returned to the viewer; the admin gets it (NEGATIVE CONTROL)', !(await sal(VIEWER)).includes('column:salary') && (await sal(ADMIN)).includes('column:salary'));
  const onHidden = async (who: Identity) => names(await idx(who, P, 'payroll earners', { limit: 10 })).filter((n) => n === 'metric:Payroll' || n === 'term:High earners').length;
  ok('index: a metric or term on a hidden column is never returned to the viewer; the admin gets both (NEGATIVE CONTROL)', (await onHidden(VIEWER)) === 0 && (await onHidden(ADMIN)) === 2);
  const [vc, ec] = [await as(VIEWER, P, () => search.indexedCount(P)), await as(EDITOR, P, () => search.indexedCount(P))];
  ok('index: the viewer\'s counts leave out source tables and the metric and term on a hidden column; the editor\'s do not (NEGATIVE CONTROL)',
    !!vc && !!ec && vc.table === 0 && ec.table === 3 && ec.metric - vc.metric === 1 && ec.term - vc.term === 1 && !('column' in vc), { vc, ec });
  ok('index: a page of hidden columns reads the next', names(await idx(VIEWER, P, 'pay', { limit: 1, kinds: ['column'] })).join() === 'column:pay_grade');
  const dump = (await pool.query('SELECT string_agg(t::text, E\'\\n\') AS d FROM assistant_search t WHERE project_id = $1', [P])).rows[0].d as string;
  const stored = (await pool.query(`SELECT string_agg(body, E'\\n') AS d FROM records WHERE path LIKE $1`, [`projects/${P}/%`])).rows[0].d as string;
  const leaked = Object.values(CANARY).filter((v) => dump.toLowerCase().includes(v.toLowerCase()));
  ok('the index holds no row value, example, value label, filter value or host', leaked.length === 0, leaked);
  ok('NEGATIVE CONTROL: the records hold the example, the label, the filter value and the host', [CANARY.example, CANARY.label, CANARY.filter, CANARY.host].every((v) => stored.includes(v)));

  // ── 8. a failing index; a deleted project ───────────────────────────────
  const real = index.rankedPage;
  (index as { rankedPage: unknown }).rankedPage = async () => { throw Object.assign(new Error('index down'), { code: '57P01' }); };
  try {
    ok('a failing index query: the reference answers', same(await as(ADMIN, P, () => search.searchModel(P, 'revenue', { limit: 5 })), await ref(ADMIN, P, 'revenue', { limit: 5 })));
  } finally {
    (index as { rankedPage: unknown }).rankedPage = real;
  }
  const left = async (): Promise<number> => Number((await pool.query(
    'SELECT (SELECT count(*) FROM assistant_search WHERE project_id = $1) + (SELECT count(*) FROM assistant_search_built WHERE project_id = $1) AS n', [P])).rows[0].n);
  ok('the project has index rows', (await left()) > 0);
  await as(ADMIN, null, () => projects.deleteProject(P));
  ok('a deleted project: no index rows and no markers left', (await left()) === 0);

  await scaleLeg(pool, (P, fn) => as(ADMIN, P, fn), (P, fn) => as(VIEWER, P, fn), same);
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  search.register();
  await pureLeg();

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_assistantsearch_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined);
  try {
    await mig.migrate(pool);
    recordFs.useRecordDb(pool);
    inOrg.useOrgDb(pool);
    await dbLeg(pool);
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('assistant search suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
