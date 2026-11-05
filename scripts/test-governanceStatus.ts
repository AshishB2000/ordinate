// Status (semantic layer part 4, D1–D6, D11): the pin, the store and the four admin channels — real modules, and
// the real RPC route in server mode (dev sign-in) over a temp DATA_DIR. The 403s for an editor and a viewer are in
// scripts/test-governanceStatus-db.ts (real people in a scratch Postgres).
//
//   § pin       table-driven per kind: each `pin` field moves the pin, each `out` field does not (over the stored
//               record, so a sanitizer cannot fake it); a term edit and an edit of a metric a formula names move the
//               dependent metric; a relationship edit moves a metric read through it, its label does not; a refresh
//               does not move a dataset; a loop is stable; a deleted item has no pin.
//               NEGATIVE CONTROL: a planted unclassified field is reported.
//   § store     certify stamps the server's by and a version event; an edit reads needs_review; a stale base is
//               refused 409-shaped with the current pin; a metric, term, extract and Live dataset certify; retire
//               refuses another kind, itself, a gone or retired replacement and a chain; a replacement is named as it
//               is called now and left out once gone; clear removes the entry with an event.
//               NEGATIVE CONTROL: an item never certified reads no status.
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
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const { sanitizeStatus } = require('../src/app/statusDocs') as typeof import('../src/app/statusDocs');
const store: typeof import('../src/analysis/statusStore') = require('../src/analysis/statusStore');
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

const caught = async (f: () => Promise<unknown>): Promise<unknown> => f().then(() => null, (e: unknown) => e);
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

interface Fixtures { ORD: string; CUST: string; EMEA: string; LIVE: string }

async function partPin(): Promise<Fixtures> {
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
  return { ORD, CUST, EMEA, LIVE };
}

async function partStore(fx: Fixtures): Promise<void> {
  const P = PROJECT;
  const { M, PLAIN, A, RETIRED, NET, GROSS, OTHER } = await as(async () => {
    const save = async (name: string) => (await metrics.saveMetric(P, { name, datasetId: fx.ORD, definition: { column: 'sales', aggregation: 'sum' } }))!.id;
    const [m, plain, a, retired, net, gross, other] = await Promise.all(['Certified sales', 'Plain', 'Old A', 'Retired R', 'Net revenue', 'Gross revenue', 'Other'].map(save));
    return { M: m, PLAIN: plain, A: a, RETIRED: retired, NET: net, GROSS: gross, OTHER: other };
  });
  const REF = `metric:${M}`;
  const pin = (await as(() => pinOf(P, REF)))!;
  const v = await as(() => store.certify(P, REF, pin, 'checked'));
  const stored = (await as(() => catalog.load(P))).status![REF];
  ok('certified, stamped by the server', v.state === 'certified' && v.by === EMAIL && v.note === 'checked' && stored.pin === pin && stored.by === EMAIL);
  ok('a written entry reads back verbatim, and sanitizing it twice is once', stableStringify(sanitizeStatus({ [REF]: stored })[REF]) === stableStringify(stored)
    && stableStringify(sanitizeStatus(sanitizeStatus({ [REF]: stored }))) === stableStringify(sanitizeStatus({ [REF]: stored })));
  const listed = await as(() => versions.list(P, 'metric', M));
  ok('the event is a version, even with no content change', listed[0]?.event === 'certified' && listed[0].summary === 'Certified' && v.versionKey === listed[0].key);
  ok('read back as certified while nothing moved', (await as(() => store.statusFor(P)(REF)))?.state === 'certified');
  await as(() => metrics.updateMetric(P, M, { filters: [F0] }));
  const after = await as(() => store.statusFor(P)(REF));
  ok('an edit reads needs_review, with the stored by and versionKey kept', after?.state === 'needs_review' && after.by === EMAIL && after.versionKey === v.versionKey);
  const stale = await caught(() => as(() => store.certify(P, REF, pin, '')));
  const now = await as(() => pinOf(P, REF));
  ok('a stale base is refused with the current pin', !!stale && (stale as Raw).code === 'ERECORDCHANGED' && (stale as Raw).tag === now && now !== pin);
  ok('certifying again on the current pin reads certified', (await as(() => store.certify(P, REF, now!, ''))).state === 'certified' && (await as(() => store.statusFor(P)(REF)))?.state === 'certified');

  const dsPin = (await as(() => pinOf(P, `dataset:${fx.ORD}`)))!;
  ok('a dataset certifies, and its event is a dataset version', (await as(() => store.certify(P, `dataset:${fx.ORD}`, dsPin, ''))).state === 'certified'
    && (await as(() => versions.list(P, 'dataset', fx.ORD)))[0]?.event === 'certified');
  const livePin = (await as(() => pinOf(P, `dataset:${fx.LIVE}`)))!;
  ok('a Live dataset certifies from metadata (getDataset would refuse it)', (await as(() => store.certify(P, `dataset:${fx.LIVE}`, livePin, ''))).state === 'certified');
  const termPin = (await as(() => pinOf(P, `term:${fx.EMEA}`)))!;
  ok('a term certifies, and its event is a term version', (await as(() => store.certify(P, `term:${fx.EMEA}`, termPin, ''))).state === 'certified'
    && (await as(() => versions.list(P, 'term', fx.EMEA)))[0]?.event === 'certified');

  const rejectsStatus = async (f: () => Promise<unknown>, field: string): Promise<boolean> => {
    const e = await caught(() => as(f));
    return e instanceof store.StatusError && e.field === field && e.message.length > 0;
  };
  ok('retire: another kind is refused', await rejectsStatus(() => store.retire(P, `metric:${A}`, `term:${fx.EMEA}`, ''), 'replacedBy'));
  ok('retire: itself is refused', await rejectsStatus(() => store.retire(P, `metric:${A}`, `metric:${A}`, ''), 'replacedBy'));
  ok('retire: a replacement that is gone is refused', await rejectsStatus(() => store.retire(P, `metric:${A}`, `metric:${uuid(404)}`, ''), 'replacedBy'));
  ok('retire: an item that is gone is refused', await rejectsStatus(() => store.retire(P, `metric:${uuid(404)}`, undefined, ''), 'ref'));
  await as(() => store.retire(P, `metric:${RETIRED}`, undefined, ''));
  ok('retire: a retired replacement is refused', await rejectsStatus(() => store.retire(P, `metric:${A}`, `metric:${RETIRED}`, ''), 'replacedBy'));
  const gross = await as(() => store.retire(P, `metric:${GROSS}`, `metric:${NET}`, 'use Net'));
  ok('retire with a replacement: named by its current name, and a version event', gross.state === 'retired' && gross.replacedBy?.name === 'Net revenue'
    && (await as(() => versions.list(P, 'metric', GROSS)))[0]?.event === 'retired');
  ok('retire: retiring a replacement would chain: refused', await rejectsStatus(() => store.retire(P, `metric:${NET}`, `metric:${OTHER}`, ''), 'ref'));
  ok('the chain refusal wrote nothing', !((await as(() => catalog.load(P))).status ?? {})[`metric:${NET}`]);
  await as(() => metrics.updateMetric(P, NET, { name: 'Net sales v2' }));
  ok('a replacement is named as it is called now', (await as(() => store.statusFor(P)(`metric:${GROSS}`)))?.replacedBy?.name === 'Net sales v2');
  await as(() => metrics.deleteMetric(P, NET));
  const orphan = await as(() => store.statusFor(P)(`metric:${GROSS}`));
  ok('a replacement that is gone is left out, the retirement kept', orphan?.state === 'retired' && !('replacedBy' in orphan));

  ok('clear: the entry is gone and the event recorded', (await as(() => store.clearStatus(P, REF))) === null
    && !(REF in ((await as(() => catalog.load(P))).status ?? {})) && (await as(() => versions.list(P, 'metric', M)))[0]?.event === 'cleared');
  ok('NEGATIVE CONTROL: nothing certified, nothing read', (await as(() => store.statusFor(P)(`metric:${PLAIN}`))) === null);
}

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  PROJECT = await as(async () => { await projects.init(); return (await projects.createProject('Governance')).id; });
  await partStore(await partPin());
})().catch((err) => {
  console.error('FAIL harness', err);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
});
