// Status (semantic layer part 4, D1–D6, D11): the pin, the store and the four admin channels — real modules, and
// the real RPC route in server mode (dev sign-in) over a temp DATA_DIR. The 403s for an editor and a viewer are in
// scripts/test-governanceStatus-db.ts (real people in a scratch Postgres).
//
//   § pin       table-driven per kind: each `pin` field moves the pin, each `out` field does not (over the stored
//               record, so a sanitizer cannot fake it); a term edit and an edit of a metric a formula names move the
//               dependent metric; a relationship edit moves a metric read through it, its label does not; a refresh
//               does not move a dataset; a loop is stable; a deleted item has no pin.
//               NEGATIVE CONTROL: a planted unclassified field is reported.
//
//   npm run build:ts && node scripts/test-governanceStatus.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-govstatus-'));

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const { stableStringify } = require('../src/engine/queryCache') as typeof import('../src/engine/queryCache');
const pinMod: typeof import('../src/analysis/statusPin') = require('../src/analysis/statusPin');
const { pinOf, unclassified, METRIC_PIN, TERM_PIN, DATASET_PIN, LIVE_PIN, RELATIONSHIP_PIN } = pinMod;

type Identity = import('../src/server/context').Identity;
type Raw = Record<string, any>; // any: a stored record as JSON
const EMAIL = 'ana@acme.test';
const ADMIN: Identity = { user: { email: EMAIL, role: 'admin' }, org: { id: 'acme' } };
const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, 'gov-status', fn);
const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const ORDER_COLUMNS = [
  { name: 'region', type: 'text' as const }, { name: 'sales', type: 'number' as const }, { name: 'qty', type: 'number' as const },
  { name: 'day', type: 'date' as const }, { name: 'customer', type: 'text' as const },
];
const ORDER_ROWS = [['EU', 10, 1, '2026-01-01', 'c1'], ['ME', 20, 2, '2026-01-02', 'c2'], ['US', 5, 3, '2026-01-03', 'c1']];
const EMEA_F = { type: 'filter', column: 'region', op: 'in', values: ['EU', 'ME', 'AF'] };
const F0 = { type: 'filter', column: 'qty', op: '>', value: 1 };

const file = (P: string, dir: string, id: string): string => path.join(appPaths.userData(), 'projects', P, dir, id + '.json');
const writeRaw = (f: string, r: Raw): void => fs.writeFileSync(f, JSON.stringify(r));

/** Rewrite one stored record, read `pin` and `seen` (what the store hands back) before and after, then put it back. */
async function rewritten(f: string, edit: (r: Raw) => void, pin: () => Promise<string | null>, seen: () => Promise<unknown>) {
  const original = fs.readFileSync(f, 'utf8');
  const [p0, s0] = [await pin(), stableStringify(await seen())];
  const r = JSON.parse(original) as Raw;
  edit(r);
  writeRaw(f, r);
  const [p1, s1] = [await pin(), stableStringify(await seen())];
  fs.writeFileSync(f, original);
  return { moved: p0 !== p1, took: s0 !== s1 };
}

/** One table's loop: every `pin` field moves the pin, every `out` field leaves it; `took` proves the edit reached the store. */
async function tableLoop(label: string, table: Record<string, string>, f: string, ref: string, edits: Record<string, ((r: Raw) => void) | 'elsewhere'>,
  seen: () => Promise<Raw | null | undefined>, cannotTake: readonly string[]): Promise<void> {
  for (const [field, kind] of Object.entries(table)) {
    const edit = edits[field];
    if (!edit) { ok(`${label}.${field} has an edit in this test`, false); continue; }
    if (edit === 'elsewhere') continue; // a nested table's own loop covers it
    const r = await rewritten(f, edit, () => pinOf(PROJECT, ref), async () => (await seen())?.[field]);
    ok(`${label}.${field} is ${kind}: the pin ${kind === 'pin' ? 'moves' : 'stays'}`, r.moved === (kind === 'pin') && (r.took || cannotTake.includes(field)), JSON.stringify(r));
  }
}

let PROJECT = '';

async function partPin(): Promise<void> {
  const P = PROJECT;
  const { ORD, CUST, EMEA, FULL, REV, MARGIN, LOOP_A, GONE, VIA, REL, LIVE } = await as(async () => {
    const ord = (await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: ORDER_COLUMNS, rows: ORDER_ROWS,
      origin: { kind: 'connection', connId: uuid(90), table: 'orders' } }))!.id;
    await datasets.updateSteps(P, ord, [{ type: 'filter', column: 'qty', op: '>', value: 0 } as never]);
    const cust = (await datasets.saveDataset(P, { name: 'Customers', sourceKind: 'csv', columns: [{ name: 'id', type: 'text' }, { name: 'segment', type: 'text' }], rows: [['c1', 'ent'], ['c2', 'smb']] }))!.id;
    const emea = (await terms.saveTerm(P, { name: 'EMEA', aliases: ['Europe and Africa'], description: 'd', datasetId: ord, filters: [EMEA_F] }))!.id;
    const save = async (name: string, definition: unknown, extra: Record<string, unknown> = {}) => (await metrics.saveMetric(P, { name, datasetId: ord, definition, ...extra }))!.id;
    const full = await save('EMEA revenue', { column: 'sales', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } }, {
      filters: [F0, { type: 'term', term: emea }], format: { kind: 'currency', decimals: 0, compact: false }, description: 'd',
      direction: 'up_good', tree: { metricId: uuid(1), split: 'region' }, timeColumn: 'day',
    });
    const rev = await save('Net sales', { column: 'sales', aggregation: 'sum' });
    const margin = await save('Margin', { formula: '[Net sales] / sum(qty)' });
    const loopA = await save('Loop A', { formula: '[Loop B] + 1' });
    await save('Loop B', { formula: '[Loop A] + 1' });
    const gone = await save('Gone', { column: 'qty', aggregation: 'sum' });
    await metrics.deleteMetric(P, gone);
    const rel = (await rels.saveRelationship(P, { from: { datasetId: ord, column: 'customer' }, to: { datasetId: cust, column: 'id' }, cardinality: 'many_to_one' }))!;
    const via = await save('Enterprise sales', { column: 'sales', aggregation: 'sum' }, { filters: [{ type: 'filter', column: 'segment', op: '=', value: 'ent', via: rel.id }] });
    const live = uuid(77);
    fs.mkdirSync(path.dirname(file(P, 'datasets', live)), { recursive: true });
    writeRaw(file(P, 'datasets', live), {
      id: live, name: 'Live orders', sourceKind: 'postgres', columns: ORDER_COLUMNS, rowCount: 0, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 3, mode: 'live', origin: { kind: 'connection', connId: uuid(91), table: 'orders' },
      live: { maxCacheAgeSec: 300, epoch: 0, schemaSyncedAt: '2026-01-01T00:00:00.000Z' },
      baseFilters: [{ type: 'filter', column: 'region', op: '=', value: 'EU' }], calculated: [{ name: 'net', expression: 'sales - qty', type: 'number' }],
    });
    return { ORD: ord, CUST: cust, EMEA: emea, FULL: full, REV: rev, MARGIN: margin, LOOP_A: loopA, GONE: gone, VIA: via, REL: rel, LIVE: live };
  });
  const pin = (ref: string) => as(() => pinOf(P, ref));
  const movesAfter = async (ref: string, change: () => Promise<unknown>): Promise<boolean> => {
    const before = await pin(ref);
    await as(change);
    return before !== null && before !== (await pin(ref));
  };
  ok('a pin is 43-char base64url', /^[A-Za-z0-9_-]{43}$/.test(String(await pin(`metric:${FULL}`))));

  await as(async () => {
    const at = (r: Raw, k: string, v: unknown) => { r[k] = v; };
    const set = (k: string, v: unknown) => (r: Raw) => at(r, k, v);
    const day = '2020-01-01T00:00:00.000Z';
    await tableLoop('metric', METRIC_PIN, file(P, 'metrics', FULL), `metric:${FULL}`, {
      id: set('id', uuid(5)), projectId: set('projectId', uuid(6)), name: set('name', 'Gross'), datasetId: set('datasetId', CUST),
      definition: set('definition', { column: 'qty', aggregation: 'sum' }), filters: set('filters', [EMEA_F]),
      format: set('format', { kind: 'number', decimals: 2, compact: true }), description: set('description', 'other'),
      direction: set('direction', 'down_good'), tree: set('tree', { metricId: FULL, split: 'qty' }), timeColumn: set('timeColumn', 'shipped'),
      createdAt: set('createdAt', day), updatedAt: set('updatedAt', day), schemaVersion: set('schemaVersion', 2),
    }, () => metrics.getMetric(P, FULL) as Promise<Raw | null>, ['projectId', 'schemaVersion']);
    await tableLoop('term', TERM_PIN, file(P, 'terms', EMEA), `term:${EMEA}`, {
      id: set('id', uuid(5)), projectId: set('projectId', uuid(6)), name: set('name', 'Europe'), aliases: set('aliases', ['Old world']),
      description: set('description', 'other'), datasetId: set('datasetId', CUST), filters: set('filters', [F0]),
      createdAt: set('createdAt', day), updatedAt: set('updatedAt', day), schemaVersion: set('schemaVersion', 2),
    }, () => terms.getTerm(P, EMEA) as Promise<Raw | null>, ['projectId', 'schemaVersion']);
    const meta = (id: string) => () => datasets.getDatasetMeta(P, id) as Promise<Raw | null>;
    await tableLoop('dataset', DATASET_PIN, file(P, 'datasets', ORD), `dataset:${ORD}`, {
      id: set('id', uuid(5)), projectId: set('projectId', uuid(6)), name: set('name', 'Renamed'), sourceKind: set('sourceKind', 'xlsx'),
      columns: (r) => { r.columns = r.columns.map((c: Raw) => (c.name === 'qty' ? { ...c, type: 'text' } : c)); },
      steps: set('steps', [{ type: 'filter', column: 'qty', op: '>', value: 2 }]), origin: set('origin', { kind: 'url', url: 'https://example.com/o.csv' }),
      mode: set('mode', 'live'), live: 'elsewhere', // LIVE_PIN's loop, over a Live record
      rowCount: set('rowCount', 999), createdAt: set('createdAt', day), updatedAt: set('updatedAt', day), schemaVersion: set('schemaVersion', 2),
      capture: set('capture', { entryId: null, cropPath: '/crop.png' }), stepCounts: set('stepCounts', [{ before: 9, after: 9 }]),
      lastRefreshedAt: set('lastRefreshedAt', day), lastRefreshStatus: set('lastRefreshStatus', 'error'), lastRefreshError: set('lastRefreshError', 'boom'),
      autoRefresh: set('autoRefresh', { every: 'daily' }), quality: set('quality', { rules: [] }), input: set('input', {}), incremental: set('incremental', {}),
      freshOnAsk: set('freshOnAsk', {}), sourceColumns: set('sourceColumns', []), resident: set('resident', false), storageVersion: set('storageVersion', uuid(7)),
    }, meta(ORD), ['projectId', 'schemaVersion', 'quality', 'input', 'incremental', 'freshOnAsk', 'sourceColumns', 'resident', 'storageVersion']);
    const liveMeta = async () => (await datasets.getDatasetMeta(P, LIVE))?.live as Raw | undefined;
    const inLive = (k: string, v: unknown) => (r: Raw) => { r.live[k] = v; };
    await tableLoop('live', LIVE_PIN, file(P, 'datasets', LIVE), `dataset:${LIVE}`, {
      baseFilters: set('baseFilters', [{ type: 'filter', column: 'region', op: '=', value: 'ME' }]),
      baseFiltersUnreadable: (r) => { r.baseFilters = [...r.baseFilters, 7]; },
      calculated: (r) => { r.calculated = [{ ...r.calculated[0], expression: 'sales + qty' }]; },
      calculatedUnreadable: (r) => { r.calculated = [...r.calculated, 'junk']; },
      maxCacheAgeSec: inLive('maxCacheAgeSec', 60), epoch: inLive('epoch', 5), schemaSyncedAt: inLive('schemaSyncedAt', '2026-02-01T00:00:00.000Z'),
      profile: inLive('profile', {}), missingColumns: inLive('missingColumns', ['gone']), syncAttemptAt: inLive('syncAttemptAt', '2026-02-01T00:00:00.000Z'),
    }, liveMeta, ['profile']);
    const linked = await rewritten(file(P, 'datasets', LIVE), (r) => { r.origin.readsTables = ['public.orders']; }, () => pinOf(P, `dataset:${LIVE}`), meta(LIVE));
    ok('linking source tables (origin.readsTables) does not move a Live dataset', linked.took && !linked.moved);

    const full = (await metrics.getMetric(P, FULL))!;
    ok('every key a stored metric carries is classified', unclassified(METRIC_PIN, Object.keys(full)).length === 0 && !!full.tree && !!full.timeColumn && !!full.direction);
    ok('every key a stored term carries is classified', unclassified(TERM_PIN, Object.keys((await terms.getTerm(P, EMEA))!)).length === 0);
    ok('every key an extract and a Live record carry is classified',
      unclassified(DATASET_PIN, Object.keys((await datasets.getDatasetMeta(P, ORD))!)).length === 0
      && unclassified(DATASET_PIN, Object.keys((await datasets.getDatasetMeta(P, LIVE))!)).length === 0
      && unclassified(LIVE_PIN, Object.keys((await datasets.getDatasetMeta(P, LIVE))!.live!)).length === 0);
    ok('every key a relationship carries is classified', unclassified(RELATIONSHIP_PIN, Object.keys(REL)).length === 0);
  });
  ok('NEGATIVE CONTROL: a planted unclassified field is reported', JSON.stringify(unclassified(METRIC_PIN, [...Object.keys(METRIC_PIN), 'planted'])) === '["planted"]');

  ok('editing the EMEA term moves "EMEA revenue"', await movesAfter(`metric:${FULL}`, () => terms.updateTerm(P, EMEA, { filters: [{ ...EMEA_F, values: ['EU'] }] })));
  ok('editing [Net sales] moves the formula metric that names it', await movesAfter(`metric:${MARGIN}`, () => metrics.updateMetric(P, REV, { filters: [F0] })));
  ok('renaming [Net sales] moves the formula that named it (it no longer resolves)', await movesAfter(`metric:${MARGIN}`, () => metrics.updateMetric(P, REV, { name: 'Sales' })));
  ok('NEGATIVE CONTROL: editing the formula does not move the metric it names', !(await movesAfter(`metric:${REV}`, () => metrics.updateMetric(P, MARGIN, { filters: [F0] }))));
  ok('a relationship edit moves a metric read through it', await movesAfter(`metric:${VIA}`, () => rels.saveRelationship(P, { ...REL, cardinality: 'one_to_one' })));
  ok('a relationship label does not move it', !(await movesAfter(`metric:${VIA}`, () => rels.saveRelationship(P, { ...REL, cardinality: 'one_to_one', label: 'Buyer' }))));
  ok('NEGATIVE CONTROL: an own-table metric is not moved by a relationship edit', !(await movesAfter(`metric:${REV}`, () => rels.saveRelationship(P, { ...REL, cardinality: 'many_to_one' }))));
  ok('a refresh (rows, updatedAt, lastRefreshedAt) does not move a dataset',
    !(await movesAfter(`dataset:${ORD}`, () => datasets.updateDatasetData(P, ORD, { columns: ORDER_COLUMNS, rows: [...ORDER_ROWS, ['AF', 1, 4, '2026-01-04', 'c2']] }))));
  ok('NEGATIVE CONTROL: a Prepare edit moves it', await movesAfter(`dataset:${ORD}`, () => datasets.updateSteps(P, ORD, [])));
  const loop = await pin(`metric:${LOOP_A}`);
  ok('a formula naming itself through another stops (cycle), stable', loop !== null && loop === (await pin(`metric:${LOOP_A}`)));
  ok('a deleted metric has no pin', (await pin(`metric:${GONE}`)) === null);
  ok('a ref of no status kind has no pin', (await pin(`visual:${ORD}`)) === null);
}

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  PROJECT = await as(async () => { await projects.init(); return (await projects.createProject('Governance')).id; });
  await partPin();
})().catch((err) => {
  console.error('FAIL harness', err);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
});
