// A metric defined in another tool's semantic layer (semantic layer part 7, b0) — the READER release.
//
// A LATER release writes `definition: { external, additive?, layer? }` (b2's layer sync) and `importedFrom` (f1's dbt
// import), and a top-level `semantic` key on a Live dataset (b2). A pod of THIS release that reads such a record must
// (1) keep it verbatim through every read and re-save, and (2) refuse, typed and with a sentence, every figure that
// would need it: the record holds a NAME, not math, and only the layer can answer it. Pinned over the real RPC route
// (the Live route harness: the parity fixture as an extract AND as a Live dataset over the fake warehouse).
//
//   § keep      every re-save keeps the definition and importedFrom; NEGATIVE CONTROL: a plain metric sanitizes as today
//   § refuse    every figure entry refuses with the sentence; NEGATIVE CONTROL: the same entries over a plain metric answer
//
//   npm run build:ts && node scripts/test-externalReader.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');
const { randomUUID }: typeof import('crypto') = require('crypto');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const ext: typeof import('../src/analysis/externalMetric') = require('../src/analysis/externalMetric');
const msg: typeof import('../src/analysis/externalMetricMessages') = require('../src/analysis/externalMetricMessages');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const versions: typeof import('../src/ipc/versions') = require('../src/ipc/versions');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const bundleImport: typeof import('../src/app/bundleImport') = require('../src/app/bundleImport');
const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const { buildDashboard }: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');

const { ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
const NAME = 'Revenue · dbt';
const EXT = { external: 'Revenue', additive: true, layer: 'dbt' };
const FROM = { kind: 'dbt', name: 'revenue' };

void (async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const X = s.extractId;
  const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(ORG_A, fn);
  const file = (pid: string, id: string): Promise<string> => as(async () => path.join(appPaths.userData(), 'projects', pid, 'metrics', id + '.json'));
  const raw = async (pid: string, id: string): Promise<Reply> => JSON.parse(await as(async () => recordFs.readFile(await file(pid, id), 'utf8')));
  /** A record as b2's sync (or f1's import) writes one: straight to the store, no sanitizer of this release in between. */
  const plant = async (name: string, definition: unknown, extra: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID();
    const now = new Date().toISOString();
    const rec = { id, projectId: P, name, datasetId: X, definition, filters: [], format: { kind: 'number', decimals: 0, compact: false }, createdAt: now, updatedAt: now, schemaVersion: 1, ...extra };
    await as(async () => {
      await fs.promises.mkdir(path.dirname(await file(P, id)), { recursive: true });
      await recordFs.writeFile(await file(P, id), JSON.stringify(rec, null, 2), 'utf8');
    });
    return id;
  };
  const save = async (name: string, definition: unknown): Promise<string> => {
    const r = (await post('metric:save', { projectId: P, input: { name, datasetId: X, definition } })).value;
    if (!r.ok) throw new Error(`metric "${name}" not saved: ${show(r)}`);
    return r.metric.id as string;
  };

  // ── § keep: the definition kind, its sanitizer and every re-save ───────────
  ok('sanitize keeps an external definition verbatim', isDeepStrictEqual(metrics.sanitizeDefinition(EXT), EXT));
  ok('sanitize is idempotent', isDeepStrictEqual(metrics.sanitizeDefinition(metrics.sanitizeDefinition(EXT)), metrics.sanitizeDefinition(EXT)));
  ok('an external definition wins over any key beside it', isDeepStrictEqual(metrics.sanitizeDefinition({ ...EXT, column: 'amt', aggregation: 'avg', formula: '[A]' }), EXT));
  ok('`additive` is kept only when exactly true, `layer` only as a backend id', isDeepStrictEqual(metrics.sanitizeDefinition({ external: 'R', additive: 'yes', layer: 'Snowflake prod' }), { external: 'R' })
    && isDeepStrictEqual(metrics.sanitizeDefinition({ external: 'R', layer: 'snowflake-2' }), { external: 'R', layer: 'snowflake-2' }));
  ok('NEGATIVE CONTROL: a simple definition sanitizes as before', isDeepStrictEqual(metrics.sanitizeDefinition({ column: 'a', aggregation: 'avg', external: 7 }), { column: 'a', aggregation: 'avg' }));
  ok('NEGATIVE CONTROL: no external key, byte-identical to today', JSON.stringify(metrics.sanitizeDefinition({ column: 'amt', aggregation: 'sum' })) === '{"column":"amt","aggregation":"sum"}'
    && JSON.stringify(metrics.sanitizeDefinition({ formula: '[A] * 2' })) === '{"formula":"[A] * 2"}');
  for (const bad of ['\u0000x', '', 'x'.repeat(513), 7, null]) {
    ok(`a bad external ${JSON.stringify(bad).slice(0, 12)} is not kept`, !Object.prototype.hasOwnProperty.call(metrics.sanitizeDefinition({ external: bad }), 'external'));
  }
  ok('importedFrom: kept when well formed, dropped otherwise', isDeepStrictEqual(ext.sanitizeImportedFrom(FROM), FROM) && ext.sanitizeImportedFrom({ kind: 'lookml', name: 'x' }) === undefined && ext.sanitizeImportedFrom({ kind: 'dbt', name: '' }) === undefined);

  const id = await plant(NAME, EXT, { importedFrom: FROM });
  const read = (await as(() => metrics.getMetric(P, id)))!;
  ok('a read keeps the definition and importedFrom', isDeepStrictEqual(read.definition, EXT) && isDeepStrictEqual(read.importedFrom, FROM), show(read));
  const listed = (await post('metric:list', { projectId: P })).value;
  const row = (listed.metrics as Reply[]).find((m) => m.id === id);
  ok('metric:list lists it, its definition verbatim, worded "Defined in another tool"', !!row && isDeepStrictEqual(row.definition, EXT) && row.definitionText === msg.definedElsewhere(), show(row));

  // The editor of this release sends every field on every save, its definition as {column, aggregation} (MetricEditor.tsx).
  const upd = (await post('metric:update', { projectId: P, id, patch: { name: NAME, format: { kind: 'currency', decimals: 0 }, definition: { column: '', aggregation: 'sum' }, filters: [], description: 'From dbt', direction: 'up_good' } })).value;
  ok('metric:update saves', upd.ok === true, show(upd));
  const after = await raw(P, id);
  ok('an editor\'s full-definition save keeps the external one', isDeepStrictEqual(after.definition, EXT) && after.format.kind === 'currency' && after.description === 'From dbt' && after.direction === 'up_good', show(after));
  ok('importedFrom survives the update', isDeepStrictEqual(after.importedFrom, FROM));
  const dup = (await post('metric:duplicate', { projectId: P, id })).value;
  ok('duplicate is refused with the sentence', dup.ok === false && dup.error === msg.externalNoDuplicate(NAME), show(dup));

  // Trash and restore move the record as stored.
  ok('trash it', (await post('metric:delete', { projectId: P, id })).value.ok === true);
  const back = await as(() => trash.restore(P, 'metric', id));
  ok('trash + restore keeps it', back.ok && isDeepStrictEqual((await raw(P, id)).definition, EXT) && isDeepStrictEqual((await raw(P, id)).importedFrom, FROM));
  // A version restore writes the version back through updateMetric.
  await as(() => versions.writeBack(P, 'metric', id, { name: NAME, definition: { column: 'amt', aggregation: 'sum' }, filters: [], format: { kind: 'number', decimals: 0 } }));
  ok('a version restore keeps it', isDeepStrictEqual((await raw(P, id)).definition, EXT) && isDeepStrictEqual((await raw(P, id)).importedFrom, FROM));
  const treed = (await post('metricTree:save', { projectId: P, id, tree: { split: 'region' } })).value;
  ok('a tree save keeps it', treed.ok !== false && isDeepStrictEqual((await raw(P, id)).definition, EXT) && isDeepStrictEqual((await raw(P, id)).importedFrom, FROM), show(treed));
  await post('metricTree:save', { projectId: P, id, tree: null });
  const zipped = await as(() => bundle.exportProject(P));
  const imported = zipped ? await as(() => bundleImport.importBundle(zipped.bytes)) : null;
  const copyPid = imported && imported.ok && imported.project ? imported.project.id : '';
  const copies = copyPid ? await as(() => metrics.listMetrics(copyPid)) : [];
  const copy = copies.find((m) => m.name === NAME);
  ok('a project bundle round trip keeps it', !!copy && isDeepStrictEqual((await raw(copyPid, copy.id)).definition, EXT) && isDeepStrictEqual((await raw(copyPid, copy.id)).importedFrom, FROM), show(imported));
  // A plain metric's duplicate drops nothing it has, and carries no import tag (a re-import must not match the copy too).
  const tagged = await plant('Units · dbt', { column: 'qty', aggregation: 'sum' }, { importedFrom: { kind: 'dbt', name: 'units' } });
  const tdup = (await post('metric:duplicate', { projectId: P, id: tagged })).value;
  ok('NEGATIVE CONTROL: an imported plain metric duplicates, its copy untagged', tdup.ok === true && isDeepStrictEqual(tdup.metric.definition, { column: 'qty', aggregation: 'sum' }) && !('importedFrom' in tdup.metric), show(tdup));
  await post('metric:delete', { projectId: P, id: tdup.metric?.id });

  // ── § refuse: every figure that would need it ──────────────────────────────
  const plain = await save('Plain amount', { column: 'amt', aggregation: 'sum' });
  const overIt = await save('Twice the layer', { formula: `[${NAME}] * 2` });
  const overPlain = await save('Twice the plain', { formula: '[Plain amount] * 2' });
  const pending = msg.externalPending(NAME);
  /** Typed, with the sentence (or one naming the formula's operand), and no number anywhere a figure would sit. */
  const refusedExternal = (r: Reply | undefined): boolean => !!r && r.ok === false && r.code === ext.EXTERNAL_CODE && (r.error === pending || r.reason === pending || r.message === pending);
  const scenario = async (metricId: string): Promise<string> => (await post('scenario:create', { projectId: P, input: { name: `S ${metricId.slice(0, 4)}`, baseMetricIds: [metricId], drivers: [] } })).value.scenario.id as string;
  const scorecard = async (metricId: string): Promise<string> => (await post('scorecard:create', { projectId: P, name: `C ${metricId.slice(0, 4)}`, period: 'month', rows: [{ metricId }] })).value.scorecard.id as string;
  const tree = async (metricId: string): Promise<void> => { await post('metricTree:save', { projectId: P, id: metricId, tree: { relation: 'sum', children: [{ metricId }] } }); };

  type Entry = [string, (m: string) => Promise<Reply>];
  const tile = { kind: 'metric', datasetId: X, column: 'amt', aggregation: 'sum' };
  const measure = (metricId: string) => ({ column: 'amt', aggregation: 'sum', metricId });
  const ENTRIES: Entry[] = [
    ['metric:values', async (m) => ((await post('metric:values', { projectId: P, ids: [m] })).value as unknown as Reply[])[0]],
    ['analysis:tiles (a KPI)', async (m) => ((await post('analysis:tiles', { projectId: P, items: [{ ...tile, metricId: m }] })).value as unknown as Reply[])[0]],
    ['visual:data (a chart measure)', async (m) => (await post('visual:data', { projectId: P, datasetId: X, encoding: { category: 'region', values: [measure(m)] } })).value],
    ['visual:data (a pivot value)', async (m) => (await post('visual:data', { projectId: P, datasetId: X, encoding: { category: 'region', values: [], pivot: { rows: [{ column: 'region' }], columns: [], values: [measure(m)] } } })).value],
    ['alerts:test', async (m) => (await post('alerts:test', { projectId: P, rule: { name: 'r', datasetId: X, metric: measure(m), compare: 'threshold', threshold: { op: '>', value: 0 }, enabled: true } })).value],
    ['scorecard:compute', async (m) => {
      const r = (await post('scorecard:compute', { projectId: P, id: await scorecard(m), offset: 0 })).value;
      return r.ok && r.rows?.[0]?.value === null && r.rows[0].unavailable ? { ok: false, ...r.rows[0].unavailable } : r;
    }],
    ['metricTree:compute', async (m) => { await tree(m); return (await post('metricTree:compute', { projectId: P, id: m })).value; }],
    ['scenario:compute', async (m) => (await post('scenario:compute', { projectId: P, id: await scenario(m), draft: { baseMetricIds: [m], drivers: [] } })).value],
    ['story:figures', async (m) => ((await post('story:figures', { projectId: P, blocks: [{ id: 'b', kind: 'metric', metricId: m }] })).value.blocks ?? {}).b],
    ['answer:card', async (m) => (await post('answer:card', { projectId: P, spec: { datasetId: X, category: 'region', measures: [measure(m)], filters: [], chartType: 'column', title: 'T' } })).value],
    ['drivers:explain', async (m) => (await post('drivers:explain', { projectId: P, request: { datasetId: X, metric: measure(m), compare: { mode: 'latest', column: 'd' } } })).value],
  ];
  for (const [ch, call] of ENTRIES) {
    const r = await call(id);
    ok(`${ch}: refused, typed, with the sentence; no figure`, refusedExternal(r) && !('value' in r && typeof r.value === 'number'), show(r));
  }
  const formula = ((await post('metric:values', { projectId: P, ids: [overIt] })).value as unknown as Reply[])[0];
  ok('metric:values of a formula naming it: refused, typed, naming it', refusedExternal(formula), show(formula));
  const fchart = (await post('visual:data', { projectId: P, datasetId: X, encoding: { category: 'region', values: [measure(overIt)] } })).value;
  ok('a chart of a formula naming it: refused, typed, naming it', refusedExternal(fchart), show(fchart));
  const kpiTile = ((await post('analysis:tiles', { projectId: P, items: [{ ...tile, metricId: id }] })).value as unknown as Reply[])[0];
  ok('a KPI tile whose metric:value refused never says "deleted" nor draws its stored column', !/deleted/.test(String(kpiTile?.error)) && !('value' in kpiTile), show(kpiTile));
  const mcp = await as(() => automation.metricValue({ projectId: P } as never, NAME).then(() => null, (e: Error) => e));
  ok('MCP metric_value refuses too, with the sentence', !!mcp && mcp.message === pending && ext.isExternalMetricError(mcp), show(mcp && mcp.message));
  const dash = await as(() => analysisStore.saveAnalysis(P, { name: 'D', sheets: [{ name: 'S', cards: [{ type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: X, column: 'amt', aggregation: 'sum', metricId: id } }] }] } as never));
  const built = dash ? await as(() => buildDashboard(P, dash.id, 1)) : null;
  ok('a published dashboard\'s KPI tile says the sentence, never a figure', !!built && show(built).includes(pending.slice(0, 40)) && !/Source removed/.test(JSON.stringify(built)), show(built).slice(0, 300));

  for (const [ch, call] of ENTRIES) {
    const r = await call(plain);
    ok(`NEGATIVE CONTROL: ${ch} over a plain metric answers`, !!r && r.ok !== false && r.code === undefined, show(r));
  }
  const fplain = ((await post('metric:values', { projectId: P, ids: [overPlain] })).value as unknown as Reply[])[0];
  ok('NEGATIVE CONTROL: a formula over a plain metric has its figure', fplain.ok === true && typeof fplain.value === 'number', show(fplain));

  await close();
  finish();
})();
