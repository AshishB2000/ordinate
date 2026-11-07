// A semantic dataset (semantic layer part 7, b2; docs/semantic-layer/07-portability.md D11, D13, D14): a Live dataset
// whose top-level `semantic` block names a layer's model, over the real RPC route (scripts/liveRouteHarness.ts) and the
// fake layer as a connector (scripts/semanticFake.ts).
//
//   § record    the block is stored at the record's top level, read into `live.semantic`, kept by every Live writer;
//               an unreadable one refuses every door; the target carries the layer's env, or is unavailable
//   § sync      the dimensions and the layer's metrics, read with describeModel (no row sample, markings by hand); one
//               mirror metric per layer metric, holding a name and never math, idempotent, name clashes, Trash, drops
//   § add       connection:semanticModels lists the layer's models; connection:addSemanticDataset saves a Live record
//               (no table, no SQL) and queues the sync that writes its mirrors; editors only; no origin in a reply
//   § saves     a mirror's definition and filters are its layer's, its format and name ours; no column metric on a layer;
//               "Defined in {layer}"; no copy of a semantic dataset; model files carry no mirror
//
//   npm run build:ts && node scripts/test-semanticDatasets.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const { isDeepStrictEqual }: typeof import('util') = require('util');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const sd: typeof import('../src/data/semanticDataset') = require('../src/data/semanticDataset');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const lt: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const fake: typeof import('./semanticFake') = require('./semanticFake');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const ext: typeof import('../src/analysis/externalMetric') = require('../src/analysis/externalMetric');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const mirrorsMod: typeof import('../src/engine/live/semantic/mirrors') = require('../src/engine/live/semantic/mirrors');
const api: typeof import('../src/api/index') = require('../src/api/index');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
const smsg: typeof import('../src/engine/semanticMessages') = require('../src/engine/semanticMessages');
const catalogMod: typeof import('../src/connectors/index') = require('../src/connectors/index');
const modelExport: typeof import('../src/app/modelExport') = require('../src/app/modelExport');

const { ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
fake.registerSemanticFake();

const SYNCED = '2026-11-01T00:00:00.000Z';
const BLOCK = {
  backend: 'fake',
  model: 'live_typed',
  metrics: Object.keys(fake.FAKE_METRICS).map((name) => ({ name, additive: fake.FAKE_ADDITIVE.has(name) })),
  grains: [{ column: 'd', grains: [...ck.DATE_GRAINS] }],
  syncedAt: SYNCED,
};

void (async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(ORG_A, fn);
  const raw = (d: string): Promise<Reply> => as(async () => JSON.parse(await fs.promises.readFile(rec.datasetFilePath(P, d), 'utf8')));
  const meta = (d: string): Promise<Reply> => as(() => H.datasets.getDatasetMeta(P, d)) as Promise<Reply>;
  const conn = async (connectorId: string, name = 'Layer prod'): Promise<string> => as(async () => (await H.connections.saveConnection(P, { name, connectorId, values: {} }))!.id);
  const CONN = await conn(fake.SEMANTIC_FAKE_ID);
  const add = (connId: string, semantic: unknown = BLOCK): Promise<Reply | null> =>
    as(() => liveRecord.saveSemanticRecord(P, { name: 'Orders layer', connId, semantic: semantic as never, columns: H.fx.COLUMNS })) as Promise<Reply | null>;

  // ── § record ──
  ok('sanitize twice == once', isDeepStrictEqual(sd.sanitizeSemantic(sd.sanitizeSemantic(BLOCK)), sd.sanitizeSemantic(BLOCK)) && isDeepStrictEqual(sd.sanitizeSemantic(BLOCK), BLOCK));
  const bad: Array<[string, unknown]> = [
    ['no model', { ...BLOCK, model: '' }], ['a bad backend id', { ...BLOCK, backend: 'Cube!' }], ['a metric past 512 characters', { ...BLOCK, metrics: [{ name: 'x'.repeat(513), additive: true }] }],
    ['2,001 metrics', { ...BLOCK, metrics: Array.from({ length: 2001 }, (_x, i) => ({ name: `m${i}`, additive: false })) }], ['an unknown grain', { ...BLOCK, grains: [{ column: 'd', grains: ['decade'] }] }],
    ['no syncedAt', { ...BLOCK, syncedAt: 'yesterday' }], ['a metric that is no object', { ...BLOCK, metrics: [7] }], ['null', null], ['b0\'s test value', { backend: 'cube', model: 'orders' }],
  ];
  for (const [what, v] of bad) ok(`unreadable: ${what}`, sd.sanitizeSemantic(v) === null);
  ok('NEGATIVE CONTROL: 2,000 metrics and a 512-character name read', sd.sanitizeSemantic({ ...BLOCK, metrics: Array.from({ length: 2000 }, (_x, i) => ({ name: i ? `m${i}` : 'y'.repeat(512), additive: false })) }) !== null);

  const ds = await add(CONN);
  const SEM = ds?.id as string;
  ok('a semantic record is saved', !!ds && ds.mode === 'live', show(ds));
  const r0 = await raw(SEM);
  ok('stored at the top level, its origin a connection with no table or SQL', isDeepStrictEqual(r0.semantic, BLOCK) && isDeepStrictEqual(r0.origin, { kind: 'connection', connId: CONN }) && !('semantic' in r0.live), show(r0));
  ok('read back into live.semantic as saved', isDeepStrictEqual((await meta(SEM)).live.semantic, BLOCK) && !(await meta(SEM)).live.semanticUnreadable);
  ok('its columns are the dimensions, as declared', isDeepStrictEqual((await meta(SEM)).columns, H.fx.COLUMNS.map((c) => ({ name: c.name, type: c.type }))));
  await as(() => H.liveDataset.bumpEpoch(P, SEM));
  await as(() => H.liveDataset.setMaxCacheAge(P, SEM, 60));
  ok('bumpEpoch and setMaxCacheAge keep the block', isDeepStrictEqual((await raw(SEM)).semantic, BLOCK) && (await meta(SEM)).live.epoch === 1 && (await meta(SEM)).live.maxCacheAgeSec === 60);
  await post('dataset:refresh', { projectId: P, id: SEM });
  ok('a Refresh keeps it', isDeepStrictEqual((await raw(SEM)).semantic, BLOCK));

  const t = await as(() => lt.liveTarget(P, SEM));
  const env = t.ok ? t.target.semantic?.env : undefined;
  ok('the target is semantic: backend, model and the layer\'s env', t.ok && t.target.semantic?.backend === 'fake' && t.target.semantic.model === 'live_typed' && !!env, show(t));
  ok('…the env holds the synced metrics, additive as the layer said', !!env && env.metrics.size === 4 && env.metrics.get('revenue')?.additive === true && env.metrics.get('avg_amount')?.additive === false);
  ok('…the grains, the dimensions, the names for the sentences and the connection\'s caps', !!env && isDeepStrictEqual(env.grains.get('d'), ck.DATE_GRAINS) && env.columns.length === H.fx.COLUMNS.length
    && env.dataset === 'Orders layer' && env.layer === 'Fake layer' && isDeepStrictEqual(env.caps, { lookups: true, binaryCompare: false }));
  ok('…and its source is inert: no table, never compiled', t.ok && isDeepStrictEqual(t.target.source, { kind: 'table', parts: [] }));

  const onWarehouse = await add(s.connId); // the live fake: a warehouse, no semantic capability
  const other = await add(CONN, { ...BLOCK, backend: 'cube' }); // a block for another backend than its connector's
  for (const [what, d] of [['a connection with no semantic capability', onWarehouse], ['a block naming another backend', other]] as const) {
    const u = await as(() => lt.liveTarget(P, d!.id as string));
    ok(`${what}: unavailable`, !u.ok && u.kind === 'unavailable', show(u));
  }

  const SPEC = (d: string) => ({ datasetId: d, category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }], filters: [], chartType: 'bar', title: 'Sales by region' });
  const DOORS: Array<[string, (d: string) => Promise<Reply>]> = [
    ['visual:data', async (d) => (await post('visual:data', { projectId: P, datasetId: d, encoding: { category: 'region', values: [{ column: 'amt', aggregation: 'sum' }] } })).value],
    ['dashboard:metric', async (d) => (await post('dashboard:metric', { projectId: P, datasetId: d, column: 'amt', aggregation: 'sum' })).value],
    ['answer:card', async (d) => (await post('answer:card', { projectId: P, spec: SPEC(d) })).value],
  ];
  const broken = await add(CONN);
  await as(() => rec.serialized(rec.datasetFilePath(P, broken!.id as string), (r) => { r.semantic = { ...BLOCK, metrics: [...BLOCK.metrics, 'junk'] }; }));
  ok('an unreadable block reads as semanticUnreadable, in memory only', (await meta(broken!.id as string)).live.semanticUnreadable === true && !('semantic' in (await meta(broken!.id as string)).live)
    && !('semanticUnreadable' in (await raw(broken!.id as string)).live));
  fake.resetLayerFake();
  for (const [ch, call] of DOORS) {
    const r = await call(broken!.id as string);
    ok(`${ch}: an unreadable block refuses, typed, with no layer call`, r.ok === false && r.code === 'live_refused' && fake.layerFake.calls.length === 0, show(r));
  }
  ok('…and its block is kept as stored', (await raw(broken!.id as string)).semantic.metrics.length === 5);

  // ── § sync ──
  fake.resetLayerFake();
  const bare = (pid: string, connId: string, name = 'Orders layer'): Promise<string> => as(async () => (await liveRecord.saveSemanticRecord(pid, {
    name, connId, columns: [], semantic: { backend: 'fake', model: 'live_typed', metrics: [], grains: [], syncedAt: SYNCED },
  }))!.id);
  const sync = async (d: string, pid = P): Promise<Reply> => (await post('dataset:syncLiveSchema', { projectId: pid, datasetId: d })).value;
  const mirrorsOf = async (d: string, pid = P): Promise<Reply[]> => (await as(() => metrics.listMetrics(pid))).filter((m) => m.datasetId === d) as unknown as Reply[];
  const named = (ms: Reply[], n: string): Reply | undefined => ms.find((m) => m.name === n);
  const warehouseCalls = H.fake.calls.length;
  const D = await bare(P, CONN);
  const first = await sync(D);
  ok('the sync answers in the usual shape: no sample (semantic), markings by hand', first.ok === true && first.status === 'synced' && first.sample?.ok === false && first.sample?.reason === 'semantic'
    && first.sensitivity === 'manual' && first.columns === H.fx.COLUMNS.length, show(first));
  ok('…its dimensions are the columns, typed as the layer reports, its grains and metrics in the block', isDeepStrictEqual((await meta(D)).columns, H.fx.COLUMNS.map((c) => ({ name: c.name, type: c.type })))
    && isDeepStrictEqual((await meta(D)).live.semantic.grains, [{ column: 'd', grains: [...ck.DATE_GRAINS] }]) && (await meta(D)).live.semantic.metrics.length === 4);
  ok('…described once by model, through the layer\'s catalog, never a question or a row sample', isDeepStrictEqual(fake.layerFake.described, ['live_typed']) && fake.layerFake.calls.length === 0 && H.fake.calls.length === warehouseCalls);
  let ms = await mirrorsOf(D);
  ok('one mirror per layer metric, holding a name, not math', ms.length === 4 && ms.every((m) => ext.isExternalDefinition(m.definition) && !('column' in m.definition) && m.definition.layer === 'fake'
    && isDeepStrictEqual(m.filters ?? [], [])), show(ms));
  ok('additive comes from the layer', named(ms, 'revenue')?.definition.additive === true && named(ms, 'avg_amount')?.definition.additive === undefined);
  const block = (await meta(D)).live.semantic;
  const again = await as(() => mirrorsMod.syncMirrors(P, D, block, 'Layer prod', 'Orders layer'));
  const v0 = await as(() => versions.list(P, 'metric', named(ms, 'revenue')!.id as string));
  ok('a second sync writes nothing new', again.created.length === 0 && again.updated.length === 0 && (await sync(D)).ok === true && (await mirrorsOf(D)).length === 4 && v0.length === 1, show({ again, v: v0.length }));

  const P2 = await as(async () => (await H.projects.createProject('Clash')).id);
  const C2 = await as(async () => (await H.connections.saveConnection(P2, { name: 'Layer prod', connectorId: fake.SEMANTIC_FAKE_ID, values: {} }))!.id);
  const X2 = await as(async () => (await H.datasets.saveDataset(P2, { name: 'Copy', sourceKind: 'csv', columns: [{ name: 'amt', type: 'number' }], rows: [[1]] }))!.id);
  await as(() => metrics.saveMetric(P2, { name: 'Orders', datasetId: X2, definition: { column: 'amt', aggregation: 'count' } }));
  const D2 = await bare(P2, C2);
  await sync(D2, P2);
  const names2 = (await as(() => metrics.listMetrics(P2))).map((m) => m.name);
  ok('a name clash (case-blind) takes the connection\'s name', names2.includes('orders · Layer prod') && names2.includes('Orders') && !names2.includes('orders'), show(names2));
  // A third and a fourth dataset on the same layer: the connection's name is taken too, so the dataset's, then a number.
  const D3 = await bare(P2, C2, 'Returns');
  const r3 = await sync(D3, P2);
  const D4 = await bare(P2, C2, 'Returns');
  await sync(D4, P2);
  const of = async (d: string): Promise<string[]> => (await mirrorsOf(d, P2)).map((m) => String(m.name)).sort();
  ok('a third dataset sharing the names takes the dataset\'s name, a fourth of the same name a number: every layer metric mirrored',
    show(await of(D3)) === show(['avg_amount · Layer prod', 'max_amount · Layer prod', 'orders · Returns', 'revenue · Layer prod'])
      && show(await of(D4)) === show(['avg_amount · Returns', 'max_amount · Returns', 'orders · Returns 2', 'revenue · Returns']) && r3.ok === true && !('unmirrored' in r3), show([await of(D3), await of(D4), r3]));
  const lost = await as(() => mirrorsMod.syncMirrors(P2, '00000000-0000-4000-8000-000000000000', block, 'Layer prod', 'Gone'));
  ok('…a mirror that could not be written is named (unmirrored), never dropped in silence', show(lost.unmirrored) === show(block.metrics.map((m: { name: string }) => m.name)), show(lost));

  ok('trash a mirror', (await post('metric:delete', { projectId: P, id: named(ms, 'revenue')!.id })).value.ok === true);
  await sync(D);
  ok('a trashed mirror is not recreated', !(await mirrorsOf(D)).some((m) => m.name === 'revenue'), show((await mirrorsOf(D)).map((m) => m.name)));

  fake.layerFake.describe = async () => {
    const m = fake.fixtureModel();
    return { ...m, dimensions: [...m.dimensions, { name: 'geo', type: 'geography' as never }], metrics: m.metrics.filter((x) => x.name !== 'max_amount').map((x) => (x.name === 'avg_amount' ? { ...x, additive: true, description: 'Now a sum' } : x)) };
  };
  const dropped = await sync(D);
  ms = await mirrorsOf(D);
  ok('a dropped layer metric keeps its mirror (missing, never deleted or remapped)', !!named(ms, 'max_amount') && ext.isExternalDefinition(named(ms, 'max_amount')!.definition) && !(await meta(D)).live.semantic.metrics.some((m: Reply) => m.name === 'max_amount'));
  ok('a layer that now says plain sum updates its mirror\'s definition; the description stays Ordinate\'s', named(ms, 'avg_amount')?.definition.additive === true && named(ms, 'avg_amount')?.description === undefined, show(named(ms, 'avg_amount')));
  ok('a dimension of a type we cannot map is left out and named in the report', dropped.ok === true && isDeepStrictEqual(dropped.unmapped, ['geo']) && !(await meta(D)).columns.some((c: Reply) => c.name === 'geo'), show(dropped));
  fake.resetLayerFake();
  const kept = (await post('metric:update', { projectId: P, id: named(ms, 'orders')!.id, patch: { format: { kind: 'currency' } } })).value;
  ok('b0 still keeps every mirror through a format save', ext.isExternalDefinition(kept.metric?.definition ?? kept.definition) && (kept.metric?.format ?? kept.format)?.kind === 'currency', show(kept));
  fake.layerFake.describe = async () => ({ ok: false, error: 'layer exploded at tok-canary-1' });
  const failed = await sync(D);
  ok('a describe failure changes nothing and says so in a sentence', failed.ok === false && !/exploded|canary/.test(JSON.stringify(failed)) && (await mirrorsOf(D)).length === ms.length, show(failed));
  fake.resetLayerFake();

  // ── § add ──
  const MODEL = 'mdl_planted_7f3';
  const ENV_ID = 'env-planted-4412';
  const TOKEN = 'tok-canary-9e1d';
  const LC = await as(async () => (await H.connections.saveConnection(P, { name: 'Layer staging', connectorId: fake.SEMANTIC_FAKE_ID, values: { environment: ENV_ID } }))!.id);
  await as(() => secretsIpc.storeSecrets(LC, { token: TOKEN }));
  fake.layerFake.list = async () => ({ ok: true, models: [{ name: MODEL, label: 'Sales', description: 'Orders by day' }] });
  const listed = (await post('connection:semanticModels', { projectId: P, connId: LC })).value;
  ok('the listing returns the layer\'s models', listed.ok === true && isDeepStrictEqual(listed.models, [{ name: MODEL, label: 'Sales', description: 'Orders by day' }]), show(listed));
  const noLayer = (await post('connection:semanticModels', { projectId: P, connId: s.connId })).value;
  ok('a connection without the semantic capability: a sentence', noLayer.ok === false && noLayer.error === (await as(async () => smsg.noLayer())), show(noLayer));
  const noLayerAdd = (await post('connection:addSemanticDataset', { projectId: P, connId: s.connId, model: MODEL })).value;
  ok('…and nothing is added from it', noLayerAdd.ok === false && noLayerAdd.error === (await as(async () => smsg.noLayer())), show(noLayerAdd));
  ok('the catalog says which connectors have a layer (Snowflake\'s semantic views, c1; Cube, e1)', catalogMod.connectorCatalog().every((e) => typeof e.semantic === 'boolean')
    && show(catalogMod.connectorCatalog().filter((e) => e.semantic).map((e) => e.id)) === '["snowflake","cube","dbt-semantic-layer"]');

  const before = (await as(() => H.datasets.listDatasets(P))).length;
  const added = await post('connection:addSemanticDataset', { projectId: P, connId: LC, model: MODEL, name: 'Sales' });
  const A = added.value.dataset?.id as string;
  ok('adding saves a Live dataset', added.value.ok === true && added.value.dataset.mode === 'live' && added.value.dataset.name === 'Sales' && (await as(() => H.datasets.listDatasets(P))).length === before + 1, added.body.slice(0, 300));
  const ra = await raw(A);
  ok('…with no table or SQL, and the layer\'s block', isDeepStrictEqual(ra.origin, { kind: 'connection', connId: LC }) && ra.semantic.model === MODEL && ra.semantic.backend === 'fake' && ra.semantic.metrics.length === 4, show(ra));
  let landed = false;
  for (let i = 0; i < 300 && !landed; i += 1) {
    landed = (await mirrorsOf(A)).length === 4;
    if (!landed) await new Promise((r) => setTimeout(r, 10));
  }
  ok('…its mirrors land after the queued sync', landed);
  const contract = api.contracts['connection:addSemanticDataset'];
  const input = { projectId: P, connId: LC, model: MODEL };
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const VIEWER = { user: { email: 'vic@acme.test', role: 'viewer' as const }, org: { id: 'acme' } };
  const EDITOR = { user: { email: 'eve@acme.test', role: 'editor' as const }, org: { id: 'acme' } };
  for (const ch of ['connection:semanticModels', 'connection:addSemanticDataset'] as const) {
    const c = api.contracts[ch];
    ok(`${ch}: write, project-scoped, strict`, c.access === 'write' && 'project' in c && c.project(input) === P && c.input.safeParse(ch === 'connection:semanticModels' ? { projectId: P, connId: LC } : input).success && !c.input.safeParse({ ...input, table: 'x' }).success);
    ok(`${ch}: a viewer is refused (403 before the handler)`, !(await H.as(VIEWER, () => authz.authorize(c, input, VIEWER, grants(1)))).ok);
    ok(`NEGATIVE CONTROL: ${ch}: an editor may`, (await H.as(EDITOR, () => authz.authorize(c, input, EDITOR, grants(2)))).ok);
  }
  ok('the contract caps the model name', !contract.input.safeParse({ ...input, model: 'm'.repeat(513) }).success && !contract.input.safeParse({ ...input, model: '' }).success);

  // Leaks: the model name, the connection's environment id and a layer error carrying the token.
  fake.layerFake.describe = async () => ({ ok: false, error: `denied: ${TOKEN} in ${ENV_ID} for ${MODEL}` });
  const logged = await H.capturingWarn(async () => ({
    add: await post('connection:addSemanticDataset', { projectId: P, connId: LC, model: MODEL }),
    sync: await post('dataset:syncLiveSchema', { projectId: P, datasetId: A }),
  }));
  fake.layerFake.describe = null;
  const replies = [added.body, logged.value.add.body, logged.value.sync.body, (await post('dataset:list', { projectId: P })).body, (await post('dataset:columns', { projectId: P, id: A })).body,
    (await post('dataset:liveSchema', { projectId: P, datasetId: A })).body, (await post('dataset:source', { projectId: P, id: A })).body];
  const all = replies.join('\n');
  ok('a failed add or sync answers a sentence', logged.value.add.value.ok === false && logged.value.sync.value.ok === false, show([logged.value.add.value, logged.value.sync.value]));
  ok('no model name, environment id or layer text in any dataset reply', !all.includes(MODEL) && !all.includes(ENV_ID) && !all.includes('denied:'), all.slice(0, 600));
  ok('…the token in none', !all.includes(TOKEN));
  const log = logged.lines.join('\n');
  ok('the layer\'s words go to the log, the token redacted', log.includes('denied:') && log.includes(ENV_ID) && !log.includes(TOKEN), log.slice(0, 400));
  ok('CANARY: the grep finds the dataset\'s own name', all.includes('Sales'));

  // ── § replies (b3): what the browser needs, and only that ──
  const GRAINS = [{ column: 'd', grains: [...ck.DATE_GRAINS] }];
  const listed2 = (await post('dataset:list', { projectId: P })).value as unknown as Reply[];
  const entry = (d: string): Reply | undefined => listed2.find((x) => x.id === d);
  ok('dataset:list: a semantic dataset says its layer by id and by name, nothing more', isDeepStrictEqual(entry(A)?.semantic, { layer: 'fake', label: 'Fake layer' }), show(entry(A)));
  const cols = (d: string): Promise<Reply> => post('dataset:columns', { projectId: P, id: d }).then((r) => r.value);
  ok('dataset:columns: the header adds the layer\'s grains', isDeepStrictEqual((await cols(A)).semantic, { layer: 'fake', label: 'Fake layer', grains: GRAINS }), show(await cols(A)));
  ok('dataset:liveSchema: the grains per date dimension', isDeepStrictEqual((await post('dataset:liveSchema', { projectId: P, datasetId: A })).value.grains, GRAINS));
  const plainSchema = (await post('dataset:liveSchema', { projectId: P, datasetId: s.liveId })).value;
  ok('NEGATIVE CONTROL: an extract and a plain Live dataset carry no semantic key and no grains', !('semantic' in entry(s.extractId)!) && !('semantic' in entry(s.liveId)!)
    && !('semantic' in (await cols(s.extractId))) && !('semantic' in (await cols(s.liveId))) && plainSchema.ok === true && !('grains' in plainSchema), show([entry(s.liveId), plainSchema.grains]));
  const conns = (await post('connections:list', { projectId: P })).value as unknown as Reply[];
  ok('connections:list: a layer\'s connection says so, so its page lists models', conns.find((c) => c.id === LC)?.semantic === true, show(conns.map((c) => [c.connectorId, c.semantic])));
  ok('NEGATIVE CONTROL: a warehouse connection carries no semantic key', !('semantic' in conns.find((c) => c.id === s.connId)!));
  const replies2 = [JSON.stringify(entry(A)), JSON.stringify(await cols(A)), (await post('dataset:liveSchema', { projectId: P, datasetId: A })).body].join('\n');
  ok('…and no model name or environment id in them', !replies2.includes(MODEL) && !replies2.includes(ENV_ID), replies2.slice(0, 300));

  // ── § saves ──
  const said = (fn: () => string): Promise<string> => as(async () => fn());
  const ORD = named(await mirrorsOf(D), 'orders')!.id as string;
  const F = { type: 'filter', column: 'region', op: '=', value: 'West' };
  const filtered = (await post('metric:update', { projectId: P, id: ORD, patch: { filters: [F] } })).value;
  ok('metric:update of a mirror\'s filters: "Defined in Fake layer: edit it there."', filtered.ok === false && filtered.error === (await said(() => smsg.externalReadOnly('Fake layer'))) && filtered.field === 'filters', show(filtered));
  const redefined = (await post('metric:update', { projectId: P, id: ORD, patch: { definition: { column: 'amt', aggregation: 'sum' } } })).value;
  ok('…and of its definition (an editor that knows no mirror sends one)', redefined.ok === false && redefined.field === 'definition' && /Fake layer/.test(String(redefined.error)), show(redefined));
  ok('…nothing written', isDeepStrictEqual((await as(() => metrics.getMetric(P, ORD)))!.filters, []) && ext.isExternalDefinition((await as(() => metrics.getMetric(P, ORD)))!.definition));
  const formatted = (await post('metric:update', { projectId: P, id: ORD, patch: { name: 'Order count', format: { kind: 'number', decimals: 0 }, description: 'Ours', direction: 'up_good', filters: [] } })).value;
  ok('NEGATIVE CONTROL: its name, format, description and direction save (no filter is no filter)', formatted.ok === true && formatted.metric.name === 'Order count' && formatted.metric.description === 'Ours' && ext.isExternalDefinition(formatted.metric.definition), show(formatted));
  const column = (await post('metric:save', { projectId: P, input: { name: 'Amount', datasetId: D, definition: { column: 'amt', aggregation: 'sum' } } })).value;
  ok('metric:save of a column metric on a semantic dataset: columnOnLayer, nothing saved', column.ok === false && column.field === 'definition' && /amt is a field of Orders layer, not a metric: Fake layer/.test(String(column.error))
    && !(await as(() => metrics.listMetrics(P))).some((m) => m.name === 'Amount'), show(column));
  const onExtract = (await post('metric:save', { projectId: P, input: { name: 'Amount', datasetId: s.extractId, definition: { column: 'amt', aggregation: 'sum' } } })).value;
  ok('NEGATIVE CONTROL: the same metric on the extract saves', onExtract.ok === true, show(onExtract));
  const row = ((await post('metric:list', { projectId: P })).value.metrics as Reply[]).find((m) => m.id === ORD);
  ok('metric:list words a mirror "Defined in Fake layer"', row?.definitionText === (await said(() => smsg.definedIn('Fake layer'))), show(row));
  const datasetsBefore = (await as(() => H.datasets.listDatasets(P))).length;
  const noCopy = await said(() => smsg.semanticNoCopy('Orders layer', 'Fake layer'));
  for (const [ch, body] of [['dataset:copyLive', { projectId: P, datasetId: D }], ['dataset:setMode', { projectId: P, datasetId: D, mode: 'extract' }]] as const) {
    const r = (await post(ch, body)).value;
    ok(`${ch}: "A copy can't be made from Orders layer: Fake layer returns totals, not rows."`, r.ok === false && r.code === 'live_refused' && r.reason === 'semanticNoCopy' && r.error === noCopy, show(r));
  }
  ok('…nothing saved, and the dataset is still Live with its block', (await as(() => H.datasets.listDatasets(P))).length === datasetsBefore && (await meta(D)).mode === 'live' && !!(await raw(D)).semantic);
  const files = await as(() => modelExport.exportModel(P));
  const text = [...files.files].map(([path, body]) => `${path}\n${body}`).join('\n');
  ok('model files carry no mirror, and say so', !text.includes(ORD) && !text.includes('Order count') && files.notCarried.includes('externalMetrics'), show(files.notCarried));
  ok('NEGATIVE CONTROL: they carry the extract\'s metric', text.includes('Amount'), text.slice(0, 300));

  await close();
  finish();
})();
