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
//   § dataset   a metric's pin holds its dataset's (and a via's far dataset's): a Prepare edit turns a certified
//               metric and its dataset to needs_review; a refresh and a docs, key, value-label or row-rule edit keep
//               both certified; so does one on a dataset the figure reaches by the nearest owner (no via).
//               NEGATIVE CONTROLS: a metric on another dataset, and one after an unrelated dataset's Prepare edit, stay certified.
//   § kinds     part 5's funnel and period definitions, a snapshot's `per` and a target, and part 7's external
//               definition and importedFrom, each written as the later release writes it: an edit of a definition
//               turns a certified metric to needs_review; a target or importedFrom edit keeps it certified (neither
//               changes the value); a period metric's base is a dep; a Live dataset that gains a `semantic` block
//               (b0) reads needs_review.
//               NEGATIVE CONTROLS: a description edit keeps each certified; after a kept target or importedFrom edit,
//               a definition edit still moves it; editing the period metric does not move its base.
//   § channels  over the route: review hands back the pin certify takes and the newest version key; a stale base is
//               409 record_changed with the current pin; a refusal is { ok:false, error, field }. A restore never
//               certifies, and one to other content reads needs_review (control: back to what was certified reads
//               certified); a duplicate carries no status; a bundle round trip keeps `by` and reads needs_review
//               (ids remapped, so the pin moved). The four channels are admin and project-scoped.
//
//   npm run build:ts && node scripts/test-governanceStatus.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-govstatus-'));

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const { contracts } = require('../src/api/index') as typeof import('../src/api/index');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const tableDocs: typeof import('../src/app/tableDocs') = require('../src/app/tableDocs');
const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
const datasetRecord: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
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
type Reply = { status: number; text: string; body: any }; // any: each channel's own reply
let call: (channel: string, payload: unknown) => Promise<Reply> = async () => { throw new Error('no app'); };

const SEMANTIC = { backend: 'fake', model: 'orders_view', metrics: [{ name: 'revenue', additive: true }], grains: [{ column: 'day', grains: ['day', 'month'] }], syncedAt: '2026-11-01T00:00:00.000Z' };

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
      target: set('target', { source: { value: 900 } }), importedFrom: set('importedFrom', { kind: 'dbt', name: 'emea_revenue' }),
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
      semanticUnreadable: set('semantic', { backend: 'dbt' }), // a top-level `semantic` key b2 cannot read, read as this flag
      semantic: set('semantic', SEMANTIC), // part 7 b2: a layer's block (its backend and model; the sync's refresh is below)
    }, liveMeta, ['profile']);
    const linked = await rewritten(file(P, 'datasets', LIVE), (r) => { r.origin.readsTables = ['public.orders']; }, () => pinOf(P, `dataset:${LIVE}`), meta(LIVE));
    const before = fs.readFileSync(file(P, 'datasets', LIVE), 'utf8');
    writeRaw(file(P, 'datasets', LIVE), { ...JSON.parse(before), semantic: SEMANTIC });
    const synced = await rewritten(file(P, 'datasets', LIVE), (r) => { r.semantic = { ...SEMANTIC, metrics: [], grains: [{ column: 'day', grains: ['month'] }], syncedAt: '2026-11-03T00:00:00.000Z' }; }, () => pinOf(P, `dataset:${LIVE}`), meta(LIVE));
    ok('a semantic sync that only refreshes metrics, grains and syncedAt does not move it', synced.took && !synced.moved, JSON.stringify(synced));
    const remodelled = await rewritten(file(P, 'datasets', LIVE), (r) => { r.semantic = { ...SEMANTIC, model: 'other_view' }; }, () => pinOf(P, `dataset:${LIVE}`), meta(LIVE));
    ok('NEGATIVE CONTROL: pointing it at another model moves it (needs_review)', remodelled.took && remodelled.moved, JSON.stringify(remodelled));
    const rebacked = await rewritten(file(P, 'datasets', LIVE), (r) => { r.semantic = { ...SEMANTIC, backend: 'cube' }; }, () => pinOf(P, `dataset:${LIVE}`), meta(LIVE));
    ok('…and so does another backend', rebacked.took && rebacked.moved, JSON.stringify(rebacked));
    fs.writeFileSync(file(P, 'datasets', LIVE), before);
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
  const SEGMENT = { type: 'filter', column: 'segment', op: '=', value: 'ent' } as never;
  ok('a Prepare edit on a dataset a metric reads through its via moves it', await movesAfter(`metric:${VIA}`, () => datasets.updateSteps(P, CUST, [SEGMENT])));
  ok('NEGATIVE CONTROL: it does not move a metric on another dataset', !(await movesAfter(`metric:${REV}`, () => datasets.updateSteps(P, CUST, []))));
  ok('a refresh (rows, updatedAt, lastRefreshedAt) does not move a dataset',
    !(await movesAfter(`dataset:${ORD}`, () => datasets.updateDatasetData(P, ORD, { columns: ORDER_COLUMNS, rows: [...ORDER_ROWS, ['AF', 1, 4, '2026-01-04', 'c2']] }))));
  ok('NEGATIVE CONTROL: a Prepare edit moves it', await movesAfter(`dataset:${ORD}`, () => datasets.updateSteps(P, ORD, [])));
  const loop = await pin(`metric:${LOOP_A}`);
  ok('a formula naming itself through another stops (cycle), stable', loop !== null && loop === (await pin(`metric:${LOOP_A}`)));
  ok('a deleted metric has no pin', (await pin(`metric:${GONE}`)) === null);
  ok('a ref of no status kind has no pin', (await pin(`visual:${ORD}`)) === null);
  return { ORD, CUST, EMEA, LIVE };
}

async function partKinds(fx: Fixtures): Promise<void> {
  const P = PROJECT;
  const FUNNEL = { funnel: { entity: 'customer', event: 'region', time: 'day', steps: ['EU', 'US'], window: { n: 7, unit: 'days' } }, show: 'rate' };
  const BASE = await as(async () => (await metrics.saveMetric(P, { name: 'Base sales', datasetId: fx.ORD, definition: { column: 'sales', aggregation: 'sum' } }))!.id);
  const cases: [string, Raw, (r: Raw) => void][] = [
    ['a funnel definition', FUNNEL, (r) => { r.definition = { ...r.definition, show: 'converted' }; }],
    ['a period definition', { base: BASE, window: { to_date: 'year' } }, (r) => { r.definition = { ...r.definition, window: { last: 7, unit: 'day' } }; }],
    ["a snapshot's per", { column: 'sales', aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: 'customer' } }, (r) => { r.definition.snapshot.per = 'region'; }],
    ['a target', { column: 'sales', aggregation: 'sum' }, (r) => { r.target = { source: { value: 120 }, per: 'month' }; }],
    ['an external definition', { external: 'revenue', layer: 'dbt' }, (r) => { r.definition = { external: 'net_revenue', layer: 'dbt' }; }],
    ['importedFrom', { column: 'sales', aggregation: 'sum' }, (r) => { r.importedFrom = { kind: 'dbt', name: 'net_sales' }; }],
  ];
  for (const [label, definition, edit] of cases) {
    const id = uuid(200 + cases.findIndex((c) => c[0] === label));
    const f = await as(async () => file(P, 'metrics', id));
    const now = '2026-01-01T00:00:00.000Z';
    writeRaw(f, { id, projectId: P, name: `Kind ${label}`, datasetId: fx.ORD, definition, filters: [], createdAt: now, updatedAt: now, schemaVersion: 1,
      ...(label === 'a target' ? { target: { source: { value: 100 } } } : label === 'importedFrom' ? { importedFrom: { kind: 'dbt', name: 'sales' } } : {}) });
    const ref = `metric:${id}`;
    const stored = await as(() => metrics.getMetric(P, id));
    ok(`${label}: the stored record reads back as written`, stableStringify(stored?.definition) === stableStringify(definition), JSON.stringify(stored?.definition));
    await as(async () => store.certify(P, ref, (await pinOf(P, ref))!, ''));
    const state = async (): Promise<string | undefined> => (await as(() => store.statusFor(P)(ref)))?.state;
    const kept = await rewritten(f, (r) => { r.description = 'reworded'; }, async () => (await state()) ?? null, () => as(() => metrics.getMetric(P, id)));
    ok(`NEGATIVE CONTROL: ${label}: a description edit keeps it certified`, !kept.moved && kept.took && (await state()) === 'certified');
    const r = JSON.parse(fs.readFileSync(f, 'utf8')) as Raw;
    edit(r);
    writeRaw(f, r);
    if (label !== 'a target' && label !== 'importedFrom') {
      ok(`${label}: an edit turns the certified metric to needs_review`, (await state()) === 'needs_review');
      continue;
    }
    const took = stableStringify((await as(() => metrics.getMetric(P, id)))?.[label === 'a target' ? 'target' : 'importedFrom']);
    ok(`${label}: an edit keeps the certified metric certified (it changes no value)`, (await state()) === 'certified' && took.includes(label === 'a target' ? '120' : 'net_sales'), took);
    r.definition = { column: 'qty', aggregation: 'sum' };
    writeRaw(f, r);
    ok(`NEGATIVE CONTROL: ${label}: a definition edit after it still turns it to needs_review`, (await state()) === 'needs_review');
  }
  const ytd = uuid(201); // the period case: certified again on its current pin, then its base is edited
  await as(async () => store.certify(P, `metric:${ytd}`, (await pinOf(P, `metric:${ytd}`))!, ''));
  const basePin = await as(() => pinOf(P, `metric:${BASE}`));
  await as(() => metrics.updateMetric(P, ytd, { format: { kind: 'number', decimals: 1, compact: false } }));
  ok('NEGATIVE CONTROL: editing the period metric does not move its base', basePin !== null && basePin === (await as(() => pinOf(P, `metric:${BASE}`))));
  await as(async () => store.certify(P, `metric:${ytd}`, (await pinOf(P, `metric:${ytd}`))!, ''));
  await as(() => metrics.updateMetric(P, BASE, { filters: [F0] }));
  ok("editing a period metric's base turns it to needs_review", (await as(() => store.statusFor(P)(`metric:${ytd}`)))?.state === 'needs_review');
  const LIVE = `dataset:${fx.LIVE}`;
  // Part 8 (p8-04): a calc edited through its store (what live:setCalculated writes) moves a certified Live dataset and a
  // metric on it; a docs edit moves neither (NEGATIVE CONTROL).
  const LIVE_M = `metric:${await as(async () => (await metrics.saveMetric(P, { name: 'Live sales', datasetId: fx.LIVE, definition: { column: 'sales', aggregation: 'sum' } }))!.id)}`;
  const MARGIN_CALC = { name: 'Margin', expression: '[sales] - [qty]', type: 'number' as const };
  const certifyLive = () => as(async () => { for (const ref of [LIVE, LIVE_M]) await store.certify(P, ref, (await pinOf(P, ref))!, ''); });
  const liveStates = async (): Promise<string> => (await as(async () => [await store.statusFor(P)(LIVE), await store.statusFor(P)(LIVE_M)])).map((x) => x?.state ?? 'none').join();
  await as(() => liveDataset.setLiveCalcs(P, fx.LIVE, [MARGIN_CALC]));
  await certifyLive();
  await as(() => tableDocs.setTableDoc(P, fx.LIVE, { guide: 'Live orders, one row per line.' }));
  ok('NEGATIVE CONTROL: a docs edit keeps a Live dataset with a calc, and a metric on it, certified', (await liveStates()) === 'certified,certified', await liveStates());
  await as(() => liveDataset.setLiveCalcs(P, fx.LIVE, [{ ...MARGIN_CALC, expression: '[sales] + [qty]' }]));
  ok("a calc's formula edited turns the Live dataset and its metric to needs_review", (await liveStates()) === 'needs_review,needs_review', await liveStates());
  await certifyLive();
  await as(() => liveDataset.setLiveCalcs(P, fx.LIVE, [{ ...MARGIN_CALC, name: 'Spread', expression: '[sales] + [qty]' }]));
  ok('…and so does a calc renamed', (await liveStates()) === 'needs_review,needs_review', await liveStates());
  await as(async () => { await store.clearStatus(P, LIVE_M); await liveDataset.setLiveCalcs(P, fx.LIVE, []); });
  await as(async () => store.certify(P, LIVE, (await pinOf(P, LIVE))!, ''));
  const layered = await rewritten(await as(async () => file(P, 'datasets', fx.LIVE)), (r) => { r.semantic = { backend: 'dbt' }; },
    async () => (await as(() => store.statusFor(P)(LIVE)))?.state ?? null, async () => (await as(() => datasets.getDatasetMeta(P, fx.LIVE)))?.live);
  ok('a Live dataset that starts asking another tool\'s layer (b0) turns from certified to needs_review', layered.moved && layered.took, JSON.stringify(layered));
  await as(() => store.clearStatus(P, LIVE));
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

async function partDatasetDep(): Promise<void> {
  const P = PROJECT;
  const rows = [['EU', 10, 1, '2026-01-01', 'c1'], ['US', 5, 3, '2026-01-03', 'c1']];
  const { LEDGER, OTHER_DS, L, OTHER } = await as(async () => {
    const ledger = (await datasets.saveDataset(P, { name: 'Ledger', sourceKind: 'csv', columns: ORDER_COLUMNS, rows }))!.id;
    await datasets.updateSteps(P, ledger, [{ type: 'filter', column: 'qty', op: '>', value: 0 } as never]);
    const otherDs = (await datasets.saveDataset(P, { name: 'Elsewhere', sourceKind: 'csv', columns: ORDER_COLUMNS, rows }))!.id;
    const save = async (name: string, datasetId: string) => (await metrics.saveMetric(P, { name, datasetId, definition: { column: 'sales', aggregation: 'sum' } }))!.id;
    return { LEDGER: ledger, OTHER_DS: otherDs, L: await save('Ledger total', ledger), OTHER: await save('Elsewhere total', otherDs) };
  });
  const refs = [`metric:${L}`, `dataset:${LEDGER}`, `metric:${OTHER}`];
  for (const ref of refs) await as(async () => store.certify(P, ref, (await pinOf(P, ref))!, ''));
  const states = async (): Promise<string> => (await Promise.all(refs.map((r) => as(() => store.statusFor(P)(r))))).map((v) => v?.state).join(',');
  ok('fixture: a metric on Ledger, Ledger, and a metric on another dataset are certified', (await states()) === 'certified,certified,certified');
  await as(() => datasets.updateDatasetData(P, LEDGER, { columns: ORDER_COLUMNS, rows: [...rows, ['ME', 20, 2, '2026-01-02', 'c2']] }));
  ok('a data refresh (same steps) keeps the metric and its dataset certified', (await states()) === 'certified,certified,certified');
  await as(async () => {
    await catalog.setDoc(P, `dataset:${LEDGER}`, { description: 'the ledger', tags: ['finance'] });
    await catalog.setColumn(P, LEDGER, 'region', { description: 'where', displayName: 'Region', values: [{ value: 'EU', label: 'Europe' }] });
    await tableDocs.setTableDoc(P, LEDGER, { role: 'fact', key: 'customer', grain: 'one row per order', guide: 'g' });
    await datasetRecord.serialized(datasetRecord.datasetFilePath(P, LEDGER), (raw) => {
      raw.rowPolicy = { column: 'region', rules: [{ userId: uuid(12), values: ['EU'] }], stepsHash: 'h' };
      return true;
    });
  });
  ok('a docs, key, value-label or row-rule edit keeps both certified', (await states()) === 'certified,certified,certified');
  await as(() => datasets.updateSteps(P, LEDGER, [{ type: 'filter', column: 'qty', op: '>', value: 1 } as never]));
  ok('a Prepare edit turns the dataset and the metric on it to needs_review', (await states()) === 'needs_review,needs_review,certified');
  ok('NEGATIVE CONTROL: the metric on another dataset stays certified', (await as(() => store.statusFor(P)(`metric:${OTHER}`)))?.state === 'certified'
    && (await as(() => store.statusFor(P)(`dataset:${OTHER_DS}`))) === null);

  // Reached by the nearest-owner rule only: `tier` is no column of Sales, so the figure reads it from Accounts (no via).
  const { ACCOUNTS, UNRELATED, GOLD } = await as(async () => {
    const cols = [{ name: 'region', type: 'text' as const }, { name: 'sales', type: 'number' as const }, { name: 'account', type: 'text' as const }];
    const salesDs = (await datasets.saveDataset(P, { name: 'Sales', sourceKind: 'csv', columns: cols, rows: [['EU', 10, 'a1'], ['US', 5, 'a2']] }))!.id;
    const accounts = (await datasets.saveDataset(P, { name: 'Accounts', sourceKind: 'csv', columns: [{ name: 'id', type: 'text' }, { name: 'tier', type: 'text' }], rows: [['a1', 'gold'], ['a2', 'tin']] }))!.id;
    const unrelated = (await datasets.saveDataset(P, { name: 'Unrelated', sourceKind: 'csv', columns: cols, rows: [['EU', 1, 'a1']] }))!.id;
    await rels.saveRelationship(P, { from: { datasetId: salesDs, column: 'account' }, to: { datasetId: accounts, column: 'id' }, cardinality: 'many_to_one' });
    const gold = (await metrics.saveMetric(P, { name: 'Gold sales', datasetId: salesDs, definition: { column: 'sales', aggregation: 'sum' },
      filters: [{ type: 'filter', column: 'tier', op: '=', value: 'gold' }] }))!.id;
    await store.certify(P, `metric:${gold}`, (await pinOf(P, `metric:${gold}`))!, '');
    return { ACCOUNTS: accounts, UNRELATED: unrelated, GOLD: gold };
  });
  const gold = () => as(async () => (await store.statusFor(P)(`metric:${GOLD}`))?.state);
  await as(() => datasets.updateSteps(P, UNRELATED, [{ type: 'filter', column: 'sales', op: '>', value: 0 } as never]));
  ok('NEGATIVE CONTROL: an unrelated dataset\'s Prepare edit keeps a metric certified', (await gold()) === 'certified');
  await as(() => datasets.updateSteps(P, ACCOUNTS, [{ type: 'filter', column: 'tier', op: '=', value: 'gold' } as never]));
  ok('a Prepare edit on a dataset reached only by the nearest owner turns the metric to needs_review', (await gold()) === 'needs_review');
}

async function partChannels(fx: Fixtures): Promise<void> {
  const P = PROJECT;
  const saved = async (name: string): Promise<string> => (await call('metric:save', { projectId: P, input: { name, datasetId: fx.ORD, definition: { column: 'sales', aggregation: 'sum' } } })).body.metric.id;
  const R = await saved('Reviewed');
  const U = await saved('Untouched');
  const REF = `metric:${R}`;
  const keysOf = async (id: string): Promise<string[]> => (await as(() => versions.list(P, 'metric', id))).map((v) => v.key);
  const restore = (id: string, key: string) => call('versions:restore', { projectId: P, type: 'metric', id, key });
  const statusOf = (ref: string, project = P) => as(() => store.statusFor(project)(ref));

  await call('metric:update', { projectId: P, id: U, patch: { filters: [F0] } });
  const [, uOld] = await keysOf(U);
  ok('restore never certifies: an uncertified metric restored has no status', (await restore(U, uOld)).body?.ok === true && (await statusOf(`metric:${U}`)) === null);

  await call('metric:update', { projectId: P, id: R, patch: { filters: [F0] } });
  const [rEdited, rFirst] = await keysOf(R);
  const review = await call('model:review', { projectId: P, ref: REF });
  ok('review returns the pin certify takes, no status yet, and the newest version key',
    review.body?.ok === true && review.body.pin === (await as(() => pinOf(P, REF))) && review.body.status === null && review.body.newestKey === rEdited);
  const certified = await call('model:certify', { projectId: P, ref: REF, base: review.body.pin, note: 'checked' });
  ok('certify over the route', certified.body?.ok === true && certified.body.status.state === 'certified' && certified.body.status.by === EMAIL);
  ok('…and review then carries it', (await call('model:review', { projectId: P, ref: REF })).body?.status?.state === 'certified');
  ok('restore of a certified metric to other content reads needs_review', (await restore(R, rFirst)).body?.ok === true && (await statusOf(REF))?.state === 'needs_review');
  const stale = await call('model:certify', { projectId: P, ref: REF, base: review.body.pin });
  const current = await as(() => pinOf(P, REF));
  ok('a stale base is 409 record_changed with the current pin', stale.status === 409 && stale.body?.code === 'record_changed' && stale.body.tag === current && current !== review.body.pin, stale.text);
  ok('NEGATIVE CONTROL: restored to what was certified, it reads certified again', (await restore(R, rEdited)).body?.ok === true && (await statusOf(REF))?.state === 'certified');
  const copy = (await call('metric:duplicate', { projectId: P, id: R })).body?.metric?.id;
  ok('a duplicate carries no status', !!copy && (await statusOf(`metric:${copy}`)) === null);

  const imported = await as(async () => {
    const out = (await bundle.exportProject(P))!;
    const res = await bundle.importBundle(out.bytes);
    if (!res.ok) throw new Error('import failed');
    const NP = res.project!.id;
    const id = (await metrics.listMetrics(NP)).find((m) => m.name === 'Reviewed')!.id;
    return { NP, id, remapped: id !== R };
  });
  const back = await statusOf(`metric:${imported.id}`, imported.NP);
  ok('a bundle round trip keeps by but reads needs_review (ids remapped, the pin moved)', imported.remapped && back?.state === 'needs_review' && back.by === EMAIL);

  const refused = await call('model:retire', { projectId: P, ref: REF, replacedBy: `term:${fx.EMEA}` });
  ok('a refusal is { ok:false, error, field }', refused.body?.ok === false && refused.body.field === 'replacedBy' && typeof refused.body.error === 'string');
  ok('retire over the route', (await call('model:retire', { projectId: P, ref: REF, replacedBy: `metric:${U}`, note: 'use Untouched' })).body?.status?.replacedBy?.name === 'Untouched');
  const cleared = await call('model:clearStatus', { projectId: P, ref: REF });
  ok('clear over the route', cleared.body?.ok === true && cleared.body.status === null && (await statusOf(REF)) === null);
  ok('review of an item that is gone says so', (await call('model:review', { projectId: P, ref: `metric:${uuid(404)}` })).body?.ok === false);
  ok('an input that is no status ref is refused at the contract', (await call('model:review', { projectId: P, ref: `visual:${R}` })).status === 400);
  ok('the four channels are admin and project-scoped', ['model:review', 'model:certify', 'model:retire', 'model:clearStatus']
    .every((c) => { const k = contracts[c as keyof typeof contracts] as { access: string; project?: unknown }; return k.access === 'admin' && typeof k.project === 'function'; }));
}

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  call = async (channel, payload) => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    let body: unknown = null;
    try { body = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body); } catch { body = null; }
    return { status: r.statusCode, text: r.body, body };
  };
  PROJECT = await as(async () => { await projects.init(); return (await projects.createProject('Governance')).id; });
  const fx = await partPin();
  await partKinds(fx);
  await partStore(fx);
  await partDatasetDep();
  await partChannels(fx);
})().catch((err) => {
  console.error('FAIL harness', err);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
});
