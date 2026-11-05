// The model files' export (semantic layer part 7, a1; docs/semantic-layer/07-portability.md D2, D3, D7, Tests
// "Round trip" and "Leaks"), over ./modelFixture.ts (every kind filled in, secrets planted).
//
// 1. Leaks: no planted secret, source table, SQL, rule value, salt or connection id in any exported byte.
//    NEGATIVE CONTROL: the guide's canary is found by the same grep.
// 2. Shapes: a Live dataset's base filters and no origin key; no derived or stamp key; the guide as its own
//    .md; fields sorted by name; references by id; part 5's kinds verbatim; a bare dataset is { base, id, name }.
// 3. What the files do not carry is listed, by kind.
// 4. Metadata only: getDataset never ran.
// 5. A Live base filter list this release cannot read refuses the export. NEGATIVE CONTROL: the readable one exports.
// 6. The zip: byte-identical when unchanged, read back through MODEL_POLICY; the golden (scripts/fixtures/golden/
//    modelFiles, ids and bases normalized: ./modelFixture.ts goldenOf); one edited description changes one file.
// 7. model:export: a viewer gets 403; a restricted caller reaching the handler gets modelRestricted().
//    NEGATIVE CONTROL: an editor gets a token, the counts and what is not carried, and no path.
//
//   npm run build:ts && node scripts/test-modelExport.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Identity } from '../src/server/context';
import { H, close, hydrated, post, type Reply } from './liveRouteHarness';
import { buildModelFixture, goldenOf, readGolden, BASE, GUIDE, GUIDE_CANARY, TARGET } from './modelFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { modelZip }: typeof import('../src/ipc/modelFiles') = require('../src/ipc/modelFiles');
const { MODEL_POLICY }: typeof import('../src/app/modelFormat') = require('../src/app/modelFormat');
const { openZip }: typeof import('../src/app/zipReader') = require('../src/app/zipReader');
const api: typeof import('../src/api/index') = require('../src/api/index');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };

const { exportModel }: typeof import('../src/app/modelExport') = require('../src/app/modelExport');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const msg: typeof import('../src/app/modelFileMessages') = require('../src/app/modelFileMessages');

(async () => {
  const F = await buildModelFixture();
  const from = hydrated.length;
  const { files, counts, notCarried } = await H.as(H.ORG_A, () => exportModel(F.P));
  const all = [...files.values()].join('\n');
  const json = (p: string) => JSON.parse(files.get(p) ?? 'null');

  // ── 1. Leaks ──────────────────────────────────────────────────────────────
  for (const [what, needle] of F.planted) ok(`no ${what} in any exported byte`, needle.length > 0 && !all.includes(needle), needle);
  ok('NEGATIVE CONTROL: the guide canary is found', all.includes(GUIDE_CANARY));

  // ── 2. Shapes ─────────────────────────────────────────────────────────────
  ok('the D2 layout', JSON.stringify([...files.keys()].sort()) === JSON.stringify([
    'datasets/customers.json', 'datasets/live.json', 'datasets/orders.json', 'datasets/orders.md', 'metrics/avg-basket.json', 'metrics/orders.json',
    'metrics/revenue-mtd.json', 'metrics/revenue.json', 'metrics/stock-on-hand.json', 'model.json', 'relationships.json', 'terms/emea.json',
  ]), JSON.stringify([...files.keys()].sort()));
  const live = json('datasets/live.json');
  ok('Live: base filters travel, no origin key', stableStringify(live.baseFilters) === stableStringify(BASE) && !('origin' in live) && !/connId|table|sql/i.test(Object.keys(live).join()), JSON.stringify(live));
  ok('no derived or stamp keys anywhere', !/"(keyCheck|verified|warning|updatedAt|updatedBy|createdAt|tree|rowPolicy|columnAccess|projectId|schemaVersion)"/.test(all));
  ok('guide is its own .md file, verbatim', files.get('datasets/orders.md') === GUIDE);
  const orders = json('datasets/orders.json');
  ok('the table doc and description travel', orders.role === 'fact' && orders.key === 'order_id' && orders.grain === 'One row per order line' && orders.description === 'Every order line' && !('guide' in orders), JSON.stringify(orders));
  ok('fields are an array sorted by name', orders.fields.map((f: { name: string }) => f.name).join() === 'amount,region', JSON.stringify(orders.fields));
  ok('a field keeps its docs, sensitivity only when marked', stableStringify(orders.fields[0]) === stableStringify({ aliases: ['net'], description: 'Net amount', displayName: 'Amount', name: 'amount', sensitivity: 'financial' }), JSON.stringify(orders.fields[0]));
  ok('value labels as stored', stableStringify(orders.fields[1].values) === stableStringify([{ value: 'EU', label: 'Europe' }, { value: 'ME', label: 'Middle East' }]) && !('sensitivity' in orders.fields[1]));
  const stock = json('metrics/stock-on-hand.json');
  ok('a metric references its dataset by id and keeps its snapshot', stock.dataset === F.orders && stock.definition.snapshot.take === 'last' && stock.definition.snapshot.per === 'region', JSON.stringify(stock));
  const revenue = json('metrics/revenue.json');
  ok('a metric keeps its filters (a term step by id), format, direction, time column and target', revenue.filters[0].term === F.emea && revenue.format.kind === 'currency' && revenue.direction === 'up_good' && revenue.timeColumn === 'day' && stableStringify(revenue.target) === stableStringify(TARGET), JSON.stringify(revenue));
  ok('a period metric names its base metric by id', json('metrics/revenue-mtd.json').definition.base === F.revenue);
  ok('a distinct count and a formula verbatim', json('metrics/orders.json').definition.aggregation === 'countd' && json('metrics/avg-basket.json').definition.formula === '[Revenue] / [Orders]');
  ok('a metric with no filters writes none', !('filters' in stock));
  const term = json('terms/emea.json');
  ok('a term: dataset by id, aliases, description, filters', term.dataset === F.orders && term.aliases[0] === 'Europe and ME' && term.filters[0].values.join() === 'EU,ME', JSON.stringify(term));
  const rel = json('relationships.json').relationships;
  ok('relationships: ends by dataset id, label, cardinality', rel.length === 1 && rel[0].from.dataset === F.orders && rel[0].to.dataset === F.customers && rel[0].label === 'Customer' && rel[0].cardinality === 'many_to_one', JSON.stringify(rel));
  ok('an unfilled dataset is exactly { base, id, name }', Object.keys(json('datasets/customers.json')).join() === 'base,id,name');
  ok('every object carries its base', [...files.keys()].filter((p) => /^(datasets|metrics|terms)\/.*\.json$/.test(p)).every((p) => /^[A-Za-z0-9_-]{43}$/.test(json(p).base)) && rel.every((r: { base: string }) => r.base.length === 43));
  const manifest = json('model.json');
  ok('model.json: format, version, project name, the calendar', manifest.format === 'ordinate-model' && manifest.formatVersion === 1 && manifest.project.name === 'Retail model' && typeof manifest.calendar.weekStart === 'number' && typeof manifest.appVersion === 'string', JSON.stringify(manifest));
  ok('counts', stableStringify(counts) === stableStringify({ datasets: 3, metrics: 5, terms: 1, relationships: 1 }), JSON.stringify(counts));

  // ── 3. Not carried ────────────────────────────────────────────────────────
  ok('a metric tree is listed as not carried, by kind', notCarried.join() === 'metricTrees', notCarried.join());
  await H.as(H.ORG_A, () => catalog.mutateCatalog(F.P, (file) => { file.instructions = [{ id: '7a000000-0000-4000-8000-000000000007', text: 'Revenue means net', updatedBy: 'x', updatedAt: 'y' }]; }));
  const again = await H.as(H.ORG_A, () => exportModel(F.P));
  ok('a kind a later release writes is listed, and its text is not exported', again.notCarried.join() === 'metricTrees,instructions' && ![...again.files.values()].join().includes('Revenue means net'), again.notCarried.join());

  // ── 4. Metadata only ──────────────────────────────────────────────────────
  ok('getDataset never ran', hydrated.length === from, hydrated.slice(from).join());

  // ── 5. Part of a base filter list never travels as all of it ─────────────
  const liveFile = await H.as(H.ORG_A, async () => record.datasetFilePath(F.P, F.live));
  const setStored = (steps: unknown[]) => H.as(H.ORG_A, () => record.serialized(liveFile, (raw) => { raw.baseFilters = steps; }));
  await setStored([...BASE, { type: 'filter', column: 'region', op: 'some_future_op', value: 'x' }]);
  const refused = await H.as(H.ORG_A, () => exportModel(F.P)).then(() => '', (err: Error) => err.message);
  ok('a base filter this release cannot read refuses the export, with the sentence', refused === (await H.as(H.ORG_A, async () => msg.modelFiltersUnreadable('Live'))), refused);
  await setStored(BASE);
  ok('NEGATIVE CONTROL: the readable list exports again', (await H.as(H.ORG_A, () => exportModel(F.P))).files.has('datasets/live.json'));

  // ── 6. The zip: byte-stable, readable by the model whitelist, the golden ──
  const a = await H.as(H.ORG_A, () => modelZip(F.P));
  const b = await H.as(H.ORG_A, () => modelZip(F.P));
  ok('unchanged project: the zip is byte-identical', a.bytes.equals(b.bytes) && a.bytes.length > 0);
  const zipFile = path.join(os.tmpdir(), `model-${process.pid}.zip`);
  fs.writeFileSync(zipFile, a.bytes);
  const z = await openZip({ file: zipFile }, MODEL_POLICY);
  const back = new Map<string, string>();
  for (const e of z.entries) back.set(e.name, (await z.read(e)).toString('utf8'));
  await z.close();
  fs.rmSync(zipFile, { force: true });
  const now = (await H.as(H.ORG_A, () => exportModel(F.P))).files;
  ok('the zip holds the files, in path order, and the whitelist reads every one', JSON.stringify([...back.keys()]) === JSON.stringify([...now.keys()].sort()) && [...now].every(([p, t]) => back.get(p) === t), [...back.keys()].join());
  const golden = readGolden();
  const mine = goldenOf(files);
  ok('the fixture export equals the golden, byte for byte', golden.size === mine.size && [...mine].every(([p, t]) => golden.get(p) === t), [...mine.keys()].filter((p) => golden.get(p) !== mine.get(p)).join());
  await post('catalog:setColumn', { projectId: F.P, datasetId: F.orders, column: 'region', patch: { description: 'Sales region' } });
  const edited = (await H.as(H.ORG_A, () => exportModel(F.P))).files;
  const changed = [...new Set([...now.keys(), ...edited.keys()])].filter((p) => now.get(p) !== edited.get(p));
  ok('one edit changes exactly one file', changed.join() === 'datasets/orders.json', changed.join());

  // ── 7. model:export: who, and what the reply holds ───────────────────────
  const contract = api.contracts['model:export'];
  const input = { projectId: F.P };
  ok('contract: write, project-scoped, a strict input', contract.access === 'write' && 'project' in contract && contract.project(input) === F.P && !contract.input.safeParse({ ...input, path: '/x' }).success && contract.input.safeParse(input).success);
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: Identity, rank: number) => H.as(who, () => authz.authorize(contract, input, who, grants(rank)));
  ok('a viewer is refused (403 before the handler)', !(await decide(VIEWER, 1)).ok);
  ok('NEGATIVE CONTROL: a project editor may export', (await decide(EDITOR, 2)).ok);
  const handler = rpc.handlers.get('model:export');
  const asViewer = (await H.as(VIEWER, async () => handler?.(undefined, input))) as Reply;
  ok('a restricted caller reaching the handler is refused, with the sentence', asViewer?.ok === false && asViewer.error === (await H.as(VIEWER, async () => msg.modelRestricted())) && !('downloadToken' in asViewer), JSON.stringify(asViewer));
  const r = (await post('model:export', input)).value;
  ok('NEGATIVE CONTROL: an unrestricted editor gets a token, the counts and what is not carried', r.ok === true && typeof r.downloadToken === 'string' && r.counts?.metrics === 5 && JSON.stringify(r.notCarried) === '["metricTrees","instructions"]', JSON.stringify(r));
  ok('the reply names no file path', !JSON.stringify(r).includes(os.tmpdir()) && !/\.zip|temp/.test(JSON.stringify(r)), JSON.stringify(r));

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
