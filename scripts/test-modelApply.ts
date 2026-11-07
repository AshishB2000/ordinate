// Applying a model import (semantic layer part 7, a3; docs/semantic-layer/07-portability.md D4–D7), over
// ./modelFixture.ts. Each case edits a1's export of the fixture as git would, plans it (a2) and applies the plan.
//
// 1. Round trip: zero writes and no "before" file. A stale plan hash: refused, nothing written.
// 2. An update lands through the editor's own save (a version, the tree kept); a before file is offered.
// 3. Conflicts: keep this project's unless the file's is picked; the save re-checks names when it writes.
// 4. Moved between the hash and the write: that item fails, the others land (a metric, a catalog doc).
// 5. Write order: catalog docs, base filters, relationships, terms, metrics.
// 6. Into a clone: fresh ids that references follow; a period over a new base; `verified` from the clone's rows.
// 7. model:importApply through the route: the upload, the before file (importing it is the undo), access.
// 8. Byte for byte: a fresh fixture exported, imported into a clone with the same datasets and exported again gives
//    the same files, ids and bases aside; the golden still matches (never re-recorded).
// 9. Release B's kinds the files never carry are kept by an import that updates their objects (cross-part check
//    item 10): Orders' drill hierarchy, the Live dataset's calculated field, Revenue's certification (a description is
//    out of its pin), a topic and a verified question on them. NEGATIVE CONTROL: a definition the file changes moves
//    the certified metric to needs review, as the editor's save does.
//
//   npm run build:ts && node scripts/test-modelApply.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, download, post, upload } from './liveRouteHarness';
import { buildModelFixture, goldenOf, readGolden } from './modelFixture';
import type { ImportPlan, PlanItem } from '../src/app/modelPlan';
import type { ApplyChoice, ApplyReply } from '../src/app/modelApply';
import type { Identity } from '../src/server/context';

const { exportModel }: typeof import('../src/app/modelExport') = require('../src/app/modelExport');
const { readModelFiles }: typeof import('../src/app/modelRead') = require('../src/app/modelRead');
const { planImport }: typeof import('../src/app/modelPlan') = require('../src/app/modelPlan');
const { applyImport }: typeof import('../src/app/modelApply') = require('../src/app/modelApply');
const { modelJson, MODEL_ZIP_TIME }: typeof import('../src/app/modelFormat') = require('../src/app/modelFormat');
const { beforeImportZip }: typeof import('../src/ipc/modelFiles') = require('../src/ipc/modelFiles');
const { writeZipAsync }: typeof import('../src/app/bundle') = require('../src/app/bundle');
const { nameTakenMessage }: typeof import('../src/ipc/metricSave') = require('../src/ipc/metricSave');
const msg: typeof import('../src/app/modelFileMessages') = require('../src/app/modelFileMessages');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const tableDocs: typeof import('../src/app/tableDocs') = require('../src/app/tableDocs');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const api: typeof import('../src/api/index') = require('../src/api/index');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };

type Files = Map<string, string>;
type Json = Record<string, any>; // any: a model file, edited as git would edit it

// Every record write in the process, counted where all of them go through.
let writeCount = 0;
for (const k of ['writeFile', 'rename'] as const) {
  const real = recordFs[k] as (...a: unknown[]) => Promise<void>;
  (recordFs as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
    writeCount++;
    return real(...a);
  };
}

const jsonAt = (files: Files, p: string): Json => JSON.parse(files.get(p) as string);
const pathOf = (files: Files, dir: 'datasets' | 'metrics' | 'terms', id: string): string => {
  const p = [...files.keys()].find((k) => k.startsWith(`${dir}/`) && k.endsWith('.json') && jsonAt(files, k).id === id);
  if (!p) throw new Error(`no ${dir} file for ${id}`);
  return p;
};
const put = (files: Files, p: string, v: unknown): Files => new Map([...files, [p, typeof v === 'string' ? v : modelJson(v)]]);
const editAt = (files: Files, p: string, change: (o: Json) => void): Files => {
  const o = jsonAt(files, p);
  change(o);
  return put(files, p, o);
};
const edit = (files: Files, dir: 'datasets' | 'metrics' | 'terms', id: string, change: (o: Json) => void): Files => editAt(files, pathOf(files, dir, id), change);
const fid = (n: number): string => `5e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(H.ORG_A, fn);
const exported = async (P: string): Promise<Files> => (await as(() => exportModel(P))).files;
const parsed = async (files: Files) => {
  const read = await readModelFiles(files);
  if ('refused' in read) throw new Error(`refused: ${read.refused}`);
  return read;
};
const plan = (P: string, files: Files): Promise<ImportPlan> => as(async () => planImport(P, await parsed(files)));
const apply = (P: string, files: Files, hash: string, choices: Record<string, ApplyChoice> = {}, onBeforeWrite?: (key: string) => Promise<unknown>): Promise<ApplyReply> =>
  as(async () => applyImport(P, await parsed(files), hash, choices, { before: () => beforeImportZip(P), ...(onBeforeWrite && { onBeforeWrite }) }));
const applyPlanned = async (P: string, files: Files, choices: Record<string, ApplyChoice> = {}, onBeforeWrite?: (key: string) => Promise<unknown>): Promise<ApplyReply> =>
  apply(P, files, (await plan(P, files)).hash, choices, onBeforeWrite);
const itemOf = (p: ImportPlan, key: string): PlanItem => p.items.find((i) => i.key === key) ?? ({ key: 'none', status: 'none' } as unknown as PlanItem);
const done = (r: ApplyReply): { written: string[]; failed: Array<{ key: string; error: string }>; before?: { downloadToken: string } } => (r.ok ? r : { written: [], failed: [] });
const show = (v: unknown): string => (JSON.stringify(v) ?? String(v)).slice(0, 1500);
const metric = (P: string, id: string) => as(() => metrics.getMetric(P, id));
/** The files as text with each id written as its object's path (relationships: their label) and every base blanked: what a clone must reproduce. */
function stripIds(files: Files): string {
  const names = new Map<string, string>();
  for (const [p, text] of files) {
    if (!p.endsWith('.json') || p === 'model.json') continue;
    const o = JSON.parse(text) as Json;
    if (p === 'relationships.json') for (const r of o.relationships as Json[]) names.set(r.id, `relationship:${r.label ?? ''}`);
    else names.set(o.id, p);
  }
  return [...files.keys()].sort().map((p) => `${p}\n${(files.get(p) as string).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => names.get(id) ?? id).replace(/"base": "[A-Za-z0-9_-]*"/g, '"base": ""')}`).join('\n');
}
const zipOf = (files: Files): Promise<Buffer> => writeZipAsync([...files.keys()].sort().map((name) => ({ name, data: Buffer.from(files.get(name) as string, 'utf8') })), MODEL_ZIP_TIME);

(async () => {
  const F = await buildModelFixture();
  const files0 = await exported(F.P);
  const avg = jsonAt(files0, 'metrics/avg-basket.json').id as string;
  const moved = await as(async () => msg.modelObjectMoved());

  // ── 1. Round trip, stale hash ─────────────────────────────────────────────
  const w0 = writeCount;
  const same = await applyPlanned(F.P, files0);
  ok('round trip: ok, zero writes, no before file', same.ok && same.written.length === 0 && same.failed.length === 0 && writeCount === w0 && same.before === undefined, show(same));

  const edited = edit(files0, 'metrics', F.revenue, (m) => { m.description = 'from git'; });
  const p1 = await plan(F.P, edited);
  const other = await post('metric:update', { projectId: F.P, id: avg, patch: { description: 'another pod' } });
  if (other.value.ok !== true) throw new Error(`edit failed: ${other.body}`);
  const w1 = writeCount;
  const stale = await apply(F.P, edited, p1.hash);
  ok('a stale plan hash: plan_changed with its sentence, nothing written', !stale.ok && stale.code === 'plan_changed' && stale.error === (await as(async () => msg.modelPlanChanged())) && writeCount === w1, show(stale));
  ok('… and the edit stays as it was', (await metric(F.P, F.revenue))?.description === 'Net revenue in EMEA');

  // ── 2. An update through the metric save ──────────────────────────────────
  const v0 = (await as(() => versions.list(F.P, 'metric', F.revenue))).length;
  const r = await applyPlanned(F.P, edited);
  const rev = await metric(F.P, F.revenue);
  ok('an update lands through the metric save', r.ok && r.written.join() === `metric:${F.revenue}` && r.failed.length === 0 && rev?.description === 'from git', show(r));
  ok('… with a version, as the editor\'s save makes', (await as(() => versions.list(F.P, 'metric', F.revenue))).length === v0 + 1);
  ok('a metric tree survives an imported update', rev?.tree !== undefined && rev.target !== undefined, show(rev));
  ok('a before file is offered', typeof done(r).before?.downloadToken === 'string', show(r));
  ok('applied again: what landed is now unchanged, and nothing is written', itemOf(await plan(F.P, edited), `metric:${F.revenue}`).status === 'unchanged' && done(await applyPlanned(F.P, edited)).written.length === 0);

  // ── 3. Conflicts ──────────────────────────────────────────────────────────
  let n = 0;
  const conflictCase = async (choice: ApplyChoice | undefined, fileEdit: (m: Json) => void = (m) => { m.description = `file ${n}`; }, hook?: (key: string) => Promise<unknown>) => {
    n++;
    const base = await exported(F.P);
    const here = await post('metric:update', { projectId: F.P, id: F.stock, patch: { description: `here ${n}` } });
    if (here.value.ok !== true) throw new Error(`edit failed: ${here.body}`);
    const f = edit(base, 'metrics', F.stock, fileEdit);
    const p = await plan(F.P, f);
    const res = await apply(F.P, f, p.hash, choice ? { [`metric:${F.stock}`]: choice } : {}, hook);
    return { status: itemOf(p, `metric:${F.stock}`).status, res, after: await metric(F.P, F.stock), n };
  };
  const keep = await conflictCase(undefined);
  ok('a conflict defaults to keep this project\'s: nothing written, no before file', keep.status === 'conflict' && keep.after?.description === `here ${keep.n}` && done(keep.res).written.length === 0 && done(keep.res).before === undefined, show(keep));
  const keepHere = await conflictCase('here');
  ok('… "here" keeps this project\'s too', keepHere.status === 'conflict' && keepHere.after?.description === `here ${keepHere.n}`, show(keepHere));
  const take = await conflictCase('file');
  ok('… and the file\'s is written when it is picked', take.status === 'conflict' && take.after?.description === `file ${take.n}` && done(take.res).written.join() === `metric:${F.stock}`, show(take));
  const named = await conflictCase('file', (m) => { m.name = 'Stock level'; m.description = 'file named'; }, async (key) => {
    if (key === `metric:${F.stock}`) await post('metric:save', { projectId: F.P, input: { datasetId: F.orders, name: 'Stock level', definition: { column: 'units', aggregation: 'sum' } } });
  });
  ok('a name the file\'s side takes is checked against the project when it is written', named.status === 'conflict' && done(named.res).failed.some((f) => f.key === `metric:${F.stock}` && f.error === nameTakenMessage('Stock level')) && named.after?.name === 'Stock on hand', show(named));

  // ── 4. Moved between the hash and the write ───────────────────────────────
  let fm = await exported(F.P);
  fm = edit(fm, 'metrics', F.revenue, (m) => { m.description = 'moved file'; });
  fm = edit(fm, 'terms', F.emea, (t) => { t.description = 'EMEA from the file'; });
  fm = edit(fm, 'datasets', F.orders, (d) => { d.grain = 'One row per line, from the file'; d.fields.find((f: Json) => f.name === 'amount').description = 'Net, from the file'; });
  const mid = await applyPlanned(F.P, fm, {}, async (key) => {
    if (key === `metric:${F.revenue}`) await post('metric:update', { projectId: F.P, id: F.revenue, patch: { description: 'mid' } });
    if (key === `table:${F.orders}`) await post('catalog:setTable', { projectId: F.P, datasetId: F.orders, patch: { grain: 'mid' } });
  });
  const midDone = done(mid);
  ok('a metric edited between the hash and its write: it fails as moved, the edit made meanwhile stands', midDone.failed.some((f) => f.key === `metric:${F.revenue}` && f.error === moved) && (await metric(F.P, F.revenue))?.description === 'mid', show(mid));
  ok('a table doc edited meanwhile: it fails as moved inside the catalog\'s one write, and stands', midDone.failed.some((f) => f.key === `table:${F.orders}` && f.error === moved) && (await as(() => tableDocs.getTableDoc(F.P, F.orders))).grain === 'mid', show(mid));
  ok('… the others land', midDone.written.includes(`term:${F.emea}`) && midDone.written.includes(`field:${F.orders}:amount`) && (await as(() => catalog.getColumns(F.P, F.orders))).amount.description === 'Net, from the file' && (await as(() => terms.getTerm(F.P, F.emea)))?.description === 'EMEA from the file', show(mid));
  ok('… and every item is either written or failed, never both', midDone.written.every((k) => !midDone.failed.some((f) => f.key === k)));

  // ── 5. Write order ────────────────────────────────────────────────────────
  let all = await exported(F.P);
  all = edit(all, 'datasets', F.orders, (d) => { d.description = 'Order lines'; d.fields.find((f: Json) => f.name === 'amount').description = 'Net of tax'; });
  all = edit(all, 'datasets', F.live, (d) => { d.baseFilters = [{ type: 'filter', column: 'region', op: '=', value: 'ME' }]; });
  all = editAt(all, 'relationships.json', (o) => { o.relationships[0].label = 'Buyer'; });
  all = edit(all, 'terms', F.emea, (t) => { t.description = 'EMEA, from git'; });
  all = edit(all, 'metrics', F.stock, (m) => { m.description = 'Stock, from git'; });
  const trace: string[] = [];
  const ordered = await applyPlanned(F.P, all, {}, async (key) => void trace.push(key.split(':')[0]));
  const kinds = trace.map((k) => (k === 'table' || k === 'field' ? 'catalog' : k)).filter((k, i, a) => a[i - 1] !== k).join();
  ok('write order: catalog docs, base filters, relationships, terms, metrics', kinds === 'catalog,baseFilters,relationship,term,metric' && done(ordered).failed.length === 0, `${kinds} ${show(ordered)}`);
  const relNow = (await as(() => rels.listRelationships(F.P)))[0];
  ok('each landed through its store', (await as(() => catalog.getDoc(F.P, `dataset:${F.orders}`)))?.description === 'Order lines'
    && (await as(() => H.datasets.getDatasetMeta(F.P, F.live)))?.live?.baseFilters?.[0]?.value === 'ME'
    && relNow?.label === 'Buyer' && (await metric(F.P, F.stock))?.description === 'Stock, from git', show(relNow));
  ok('a relationship\'s verified is recomputed by its save', relNow?.verified.matched === 3 && relNow.verified.unmatchedFrom === 0, show(relNow));
  ok('round trip after the apply: every item unchanged', (await plan(F.P, await exported(F.P))).items.every((i) => i.status === 'unchanged'));

  // ── 6. Into a clone ───────────────────────────────────────────────────────
  const clone = await as(async () => {
    const C = (await H.projects.createProject('Clone')).id;
    const cols = [{ name: 'order_id', type: 'text' as const }, { name: 'customer_id', type: 'text' as const }, { name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }, { name: 'day', type: 'date' as const }, { name: 'units', type: 'number' as const }];
    const o = await H.datasets.saveDataset(C, { name: 'Orders', sourceKind: 'csv', columns: cols, rows: [['o1', 'c1', 'EU', 10, '2025-03-01', 4], ['o2', 'c9', 'ME', 20, '2025-03-02', 3]] });
    const c = await H.datasets.saveDataset(C, { name: 'Customers', sourceKind: 'csv', columns: [{ name: 'id', type: 'text' }, { name: 'name', type: 'text' }], rows: [['c1', 'Ada']] });
    if (!o || !c) throw new Error('clone datasets not saved');
    return { C, orders: o.id, customers: c.id };
  });
  let cf = await exported(F.P);
  const ordersMetric = jsonAt(cf, 'metrics/orders.json');
  cf = put(cf, 'terms/enterprise.json', { ...jsonAt(cf, 'terms/emea.json'), id: fid(2), name: 'Enterprise', aliases: undefined, filters: [{ type: 'filter', column: 'region', op: '=', value: 'EU' }] });
  cf = put(cf, 'metrics/enterprise-revenue.json', { ...ordersMetric, id: fid(1), name: 'Enterprise orders', filters: [{ type: 'term', term: fid(2) }] });
  cf = put(cf, 'metrics/units.json', { ...ordersMetric, id: fid(3), name: 'Units', definition: { column: 'units', aggregation: 'sum' }, timeColumn: 'day' });
  cf = put(cf, 'metrics/units-mtd.json', { ...jsonAt(cf, 'metrics/revenue-mtd.json'), id: fid(4), name: 'Units MTD', definition: { base: fid(3), window: { to_date: 'month' } } });
  cf = editAt(cf, 'relationships.json', (o) => { o.relationships[0].verified = { matched: 999, unmatchedFrom: 0 }; }); // never read
  const fileIds = new Set([...cf.values()].flatMap((t) => t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []));
  const nr = await applyPlanned(clone.C, cf);
  const cm = await as(async () => Promise.all((await metrics.listMetrics(clone.C)).map((m) => metrics.getMetric(clone.C, m.id))));
  const ct = await as(() => terms.listFullTerms(clone.C));
  const byName = <T extends { name: string }>(list: readonly (T | null)[], name: string): T | undefined => list.find((x): x is T => !!x && x.name === name);
  const ent = byName(ct, 'Enterprise');
  const emea = byName(ct, 'EMEA');
  ok('into a clone: nothing failed', done(nr).failed.length === 0 && done(nr).written.length > 0, show(nr));
  ok('new objects get fresh ids, never the file\'s', [...cm, ...ct].length > 0 && [...cm, ...ct].every((x) => !!x && !fileIds.has(x.id)), show([...cm, ...ct].map((x) => x?.id)));
  ok('a new term and a new metric filtering on it: the reference follows the fresh id', !!ent && (byName(cm, 'Enterprise orders')?.filters?.[0] as { term?: string } | undefined)?.term === ent.id, show(byName(cm, 'Enterprise orders')));
  ok('… and the fixture\'s own term step follows its term', !!emea && (byName(cm, 'Revenue')?.filters?.[0] as { term?: string } | undefined)?.term === emea.id, show(byName(cm, 'Revenue')));
  ok('a period over a new base metric: written after its base, naming its fresh id', (byName(cm, 'Units MTD')?.definition as { base?: string } | undefined)?.base === byName(cm, 'Units')?.id && (byName(cm, 'Revenue MTD')?.definition as { base?: string } | undefined)?.base === byName(cm, 'Revenue')?.id, show(byName(cm, 'Units MTD')));
  const cr = (await as(() => rels.listRelationships(clone.C)))[0];
  ok('a relationship\'s verified is counted from the clone\'s rows, never the file\'s', cr?.label === 'Buyer' && cr.verified.matched === 1 && cr.verified.unmatchedFrom === 1 && !fileIds.has(cr.id), show(cr));
  ok('a table doc and a field doc land on the clone\'s dataset', (await as(() => tableDocs.getTableDoc(clone.C, clone.orders))).key === 'order_id' && (await as(() => catalog.getColumns(clone.C, clone.orders))).region.values?.length === 2);
  const again = await plan(clone.C, cf);
  ok('applied again into the clone: nothing more to write', done(await applyPlanned(clone.C, cf)).written.length === 0, show(again.items.filter((i) => !['unchanged', 'skipped', 'onlyHere'].includes(i.status))));

  // ── 7. model:importApply ──────────────────────────────────────────────────
  const contract = (api.contracts as unknown as Record<string, (typeof api.contracts)['model:importPlan'] | undefined>)['model:importApply']; // looked up by name: its input differs from the plan's
  const tempDir = await as(async () => appPaths.temp());
  const staged = (): string[] => (fs.existsSync(tempDir) ? fs.readdirSync(tempDir).filter((x) => x.startsWith('upload-')) : []);
  const stagedBefore = staged().length;
  const cleared = (): Promise<boolean> => H.until(() => staged().length === stagedBefore, 2000);
  const viaRouteFiles = edit(await exported(F.P), 'metrics', avg, (m) => { m.description = 'through the route'; });
  const zip = await as(() => zipOf(viaRouteFiles));
  const planned = await post('model:importPlan', { projectId: F.P, fileToken: (await upload(zip, 'model.zip')).fileToken });
  const up = await upload(zip, 'model.zip');
  const applied = await post('model:importApply', { projectId: F.P, fileToken: up.fileToken, planHash: planned.value.plan?.hash ?? '' });
  ok('model:importApply: the plan\'s changes land through the route', applied.value.ok === true && applied.value.written?.join() === `metric:${avg}` && (await metric(F.P, avg))?.description === 'through the route', applied.body.slice(0, 400));
  ok('the upload is gone from the staging area once applied', await cleared(), staged().join());
  ok('the reply names no file path or token', !applied.body.includes(os.tmpdir()) && !applied.body.includes(up.fileToken) && !/upload-[0-9a-f]{32}/.test(applied.body));
  const reused = await post('model:importApply', { projectId: F.P, fileToken: up.fileToken, planHash: planned.value.plan?.hash ?? '' });
  ok('a used token: the upload has expired, with the sentence', reused.value.ok === false && reused.value.error === (await as(async () => msg.modelUploadExpired())), reused.body);
  const staleRoute = await post('model:importApply', { projectId: F.P, fileToken: (await upload(zip, 'model.zip')).fileToken, planHash: 'x' });
  ok('through the route, another hash: plan_changed', staleRoute.value.ok === false && staleRoute.value.code === 'plan_changed', staleRoute.body);
  const notZip = await post('model:importApply', { projectId: F.P, fileToken: (await upload(Buffer.from('not a zip'), 'model.zip')).fileToken, planHash: 'x' });
  ok('a file that is not a zip is refused with a sentence, and its upload is gone', notZip.value.ok === false && typeof notZip.value.error === 'string' && (await cleared()), notZip.body);

  // The before file is the model as it was: importing it is the undo.
  const before = await download(String(applied.value.before?.downloadToken ?? ''));
  ok('the before file downloads', before.status === 200 && before.bytes.length > 0, String(before.status));
  const undoPlan = await post('model:importPlan', { projectId: F.P, fileToken: (await upload(before.bytes, 'before.zip')).fileToken });
  const undo = await post('model:importApply', { projectId: F.P, fileToken: (await upload(before.bytes, 'before.zip')).fileToken, planHash: undoPlan.value.plan?.hash ?? '' });
  ok('the before file carries no base: the edit it undoes is an update, never "newer here"', itemOf(undoPlan.value.plan ?? { items: [] }, `metric:${avg}`).status === 'updated', undoPlan.body.slice(0, 400));
  ok('importing the before file undoes the import', undo.value.ok === true && (await metric(F.P, avg))?.description === 'another pod', undo.body.slice(0, 400));

  const input = { projectId: F.P, fileToken: up.fileToken, planHash: 'h', choices: { [`metric:${avg}`]: 'file' } };
  ok('contract: write, project-scoped, a strict input', !!contract && contract.access === 'write' && 'project' in contract && contract.project(input) === F.P && contract.input.safeParse(input).success
    && !contract.input.safeParse({ ...input, path: '/x' }).success && !contract.input.safeParse({ ...input, choices: { k: 'both' } }).success
    && !contract.input.safeParse({ ...input, planHash: 'h'.repeat(65) }).success && !contract.input.safeParse({ ...input, fileToken: '../x' }).success);
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: Identity, rank: number) => H.as(who, () => authz.authorize(contract as NonNullable<typeof contract>, input, who, grants(rank)));
  ok('a viewer is refused (403 before the handler)', !!contract && !(await decide(VIEWER, 1)).ok);
  ok('NEGATIVE CONTROL: a project editor may apply an import', !!contract && (await decide(EDITOR, 2)).ok);
  const asViewer = (await H.as(VIEWER, async () => rpc.handlers.get('model:importApply')?.(undefined, input))) as Record<string, unknown> | undefined;
  ok('a restricted caller reaching the handler is refused, with the sentence', asViewer?.ok === false && asViewer.error === (await H.as(VIEWER, async () => msg.modelRestricted())), JSON.stringify(asViewer));

  // ── 8. Byte for byte into a clone ─────────────────────────────────────────
  const G = await buildModelFixture();
  const a = await exported(G.P);
  const golden = readGolden();
  const mine = goldenOf(a);
  ok('the golden still matches (never re-recorded)', golden.size === mine.size && [...mine].every(([p, t]) => golden.get(p) === t), [...mine.keys()].filter((p) => golden.get(p) !== mine.get(p)).join());
  const twin = await as(async () => {
    const C = (await H.projects.createProject('Retail model')).id;
    await H.liveOver(C, { table: 'live_fake_orders' }, [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }]);
    const cols = [{ name: 'order_id', type: 'text' as const }, { name: 'customer_id', type: 'text' as const }, { name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }, { name: 'day', type: 'date' as const }, { name: 'units', type: 'number' as const }];
    const o = await H.datasets.saveDataset(C, { name: 'Orders', sourceKind: 'csv', columns: cols, rows: [['o1', 'c1', 'EU', 10, '2025-03-01', 4]] });
    const c = await H.datasets.saveDataset(C, { name: 'Customers', sourceKind: 'csv', columns: [{ name: 'id', type: 'text' }, { name: 'name', type: 'text' }], rows: [['c1', 'Ada']] });
    if (!o || !c) throw new Error('twin datasets not saved');
    return C;
  });
  const into = await applyPlanned(twin, a);
  const b = await exported(twin);
  const diff = (x: string, y: string): string => { const xs = x.split('\n'); const ys = y.split('\n'); const i = xs.findIndex((l, k) => l !== ys[k]); return i < 0 ? '' : `${xs.slice(Math.max(0, i - 3), i + 2).join('\n')}\n≠\n${ys.slice(Math.max(0, i - 3), i + 2).join('\n')}`; };
  ok('into the twin: nothing failed', done(into).failed.length === 0 && done(into).written.length > 0, show(into));
  ok('export → import into a clone → export: the same files, ids and bases aside', stripIds(a) === stripIds(b), diff(stripIds(a), stripIds(b)));
  const twinRev = jsonAt(b, 'metrics/revenue.json').id as string;
  ok('NEGATIVE CONTROL: one differing description shows', stripIds(a) !== stripIds(edit(b, 'metrics', twinRev, (m) => { m.description = 'x'; })));
  ok('… and the twin\'s own ids are new, so the comparison is not of the same records', twinRev !== G.revenue);

  // ── 9. Release B's kinds survive an import that updates their objects ───
  const statusStore: typeof import('../src/analysis/statusStore') = require('../src/analysis/statusStore');
  const { pinOf }: typeof import('../src/analysis/statusPin') = require('../src/analysis/statusPin');
  const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
  const datasetsMod: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
  const verifiedStore: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
  const K = await buildModelFixture();
  const GEO = [{ name: 'Geo', levels: ['region', 'customer_id'] }];
  const CALC = { name: 'double_amount', expression: '[amount] * 2', type: 'number' };
  const at9 = new Date().toISOString();
  const bKinds = async () => as(async () => ({
    hierarchies: JSON.stringify((await catalog.loadStrict(K.P)).tables?.[K.orders]?.hierarchies),
    calcs: JSON.stringify((await datasetsMod.getDatasetMeta(K.P, K.live))?.live?.calculated),
    state: (await statusStore.statusFor(K.P)(`metric:${K.revenue}`))?.state,
    topic: JSON.stringify(await topics.listTopics(K.P)),
    verified: JSON.stringify(await verifiedStore.listVerified(K.P)),
  }));
  await as(async () => {
    await tableDocs.setTableDoc(K.P, K.orders, { hierarchies: GEO });
    await liveDataset.setLiveCalcs(K.P, K.live, [CALC] as never);
    await statusStore.certify(K.P, `metric:${K.revenue}`, (await pinOf(K.P, `metric:${K.revenue}`))!, '');
    await topics.saveTopic(K.P, { name: 'Sales', datasets: [{ id: K.orders }, { id: K.live }], metricIds: [K.revenue], termIds: [] });
    await verifiedStore.writeVerified(K.P, { id: fid(70), projectId: K.P, question: 'Revenue by region', phrasings: [], note: '',
      spec: { datasetId: K.orders, category: 'region', measures: [{ column: 'amount', aggregation: 'sum', metricId: K.revenue }], filters: [], chartType: 'column', title: 'Revenue' },
      verifiedBy: 'x', verifiedAt: at9, createdAt: at9, updatedAt: at9, schemaVersion: 1 } as never);
  });
  const before9 = await bKinds();
  ok('setup: B\'s kinds are in place', before9.hierarchies.includes('"levels":["region","customer_id"]') && before9.calcs?.includes('double_amount') && before9.state === 'certified' && before9.topic.includes('Sales') && before9.verified.includes('Revenue by region'), show(before9));
  const k0 = await exported(K.P);
  let k1 = edit(k0, 'datasets', K.orders, (d) => { d.description = 'Orders, from git'; d.grain = 'One row per order'; });
  k1 = edit(k1, 'datasets', K.live, (d) => { d.baseFilters = [{ type: 'filter', column: 'region', op: '=', value: 'ME' }]; });
  k1 = edit(k1, 'metrics', K.revenue, (m) => { m.description = 'Revenue, from git'; });
  const r9 = await applyPlanned(K.P, k1);
  ok('the import lands its three updates', done(r9).failed.length === 0 && done(r9).written.length === 3, show(r9));
  const after9 = await bKinds();
  ok('…and keeps the hierarchy, the Live calc, the topic and the verified question as they were', after9.hierarchies === before9.hierarchies && after9.calcs === before9.calcs && after9.topic === before9.topic && after9.verified === before9.verified, show([before9, after9]));
  ok('…and the certification: a description is out of the metric\'s pin', after9.state === 'certified', String(after9.state));
  const r9b = await applyPlanned(K.P, edit(await exported(K.P), 'metrics', K.revenue, (m) => { m.filters = []; }));
  ok('NEGATIVE CONTROL: a definition the file changes moves the certified metric to needs review', done(r9b).written.length === 1 && (await bKinds()).state === 'needs_review', show([r9b, await bKinds()]));

  // ── 10. Dependents and order within one apply ─────────────────────────────
  const N = await buildModelFixture();
  const n0 = await exported(N.P);
  const nOrders = jsonAt(n0, 'metrics/orders.json');
  const EU = [{ type: 'filter', column: 'region', op: '=', value: 'EU' }];
  let nd = put(n0, 'terms/wholesale.json', { ...jsonAt(n0, 'terms/emea.json'), id: fid(80), name: 'Wholesale', aliases: undefined, filters: EU });
  nd = put(nd, 'metrics/wholesale-orders.json', { ...nOrders, id: fid(81), name: 'Wholesale orders', filters: [{ type: 'term', term: fid(80) }] });
  const r10 = done(await applyPlanned(N.P, nd, {}, async (key) => {
    if (key === `term:${fid(80)}`) await post('term:save', { projectId: N.P, input: { name: 'Wholesale', datasetId: N.orders, filters: EU } });
  }));
  const notWritten = await as(async () => msg.modelDependencyNotWritten());
  ok('a new term refused at its write: a metric naming it is not written, and fails under it', r10.failed.some((f) => f.key === `term:${fid(80)}`) && r10.failed.some((f) => f.key === `metric:${fid(81)}` && f.error === notWritten)
    && !(await as(() => metrics.listMetrics(N.P))).some((m) => m.name === 'Wholesale orders'), show(r10));
  // A new metric taking the name a rename gives up sorts before it ("Stock on hand" < "Zz stock"): written after it.
  const n1 = await exported(N.P);
  const taken = put(edit(n1, 'metrics', N.stock, (m) => { m.name = 'Zz stock'; }), 'metrics/new-stock.json', { ...jsonAt(n1, 'metrics/orders.json'), id: fid(82), name: 'Stock on hand' });
  const r10b = done(await applyPlanned(N.P, taken));
  const names10 = (await as(() => metrics.listMetrics(N.P))).map((m) => m.name);
  // A file that drops a snapshot's per, or the snapshot, clears it (the update sends null, as the editor does).
  const snapOf = async (): Promise<unknown> => ((await metric(N.P, N.stock))?.definition as { snapshot?: unknown } | undefined)?.snapshot;
  const r10c = done(await applyPlanned(N.P, edit(await exported(N.P), 'metrics', N.stock, (m) => { delete m.definition.snapshot.per; })));
  ok('a file without the snapshot\'s per: written, and the per is gone', r10c.written.includes(`metric:${N.stock}`) && JSON.stringify(await snapOf()) === '{"column":"day","take":"last"}', show([r10c, await snapOf()]));
  const r10d = done(await applyPlanned(N.P, edit(await exported(N.P), 'metrics', N.stock, (m) => { delete m.definition.snapshot; })));
  ok('… and a file without the snapshot: it is gone', r10d.written.includes(`metric:${N.stock}`) && (await snapOf()) === undefined, show([r10d, await snapOf()]));
  const asWas = edit(await exported(N.P), 'metrics', N.stock, (m) => { delete m.base; }); // what a before file holds: the model as it was, no base
  await applyPlanned(N.P, edit(await exported(N.P), 'metrics', N.stock, (m) => { m.definition.snapshot = { column: 'day', take: 'first' }; }));
  const added = await snapOf();
  await applyPlanned(N.P, asWas);
  ok('importing the before file of an import that added a snapshot removes it', JSON.stringify(added) === '{"column":"day","take":"first"}' && (await snapOf()) === undefined, show([added, await snapOf()]));
  ok('a rename and a new metric taking its old name: both land, in that order', r10b.failed.length === 0 && r10b.written.join() === `metric:${N.stock},metric:${fid(82)}` && names10.includes('Zz stock') && names10.includes('Stock on hand'), show(r10b));

  // A relationship's label is a name too, one per pair of datasets: a new edge taking the label a relabel gives up
  // (its id sorts first) lands after it; two edges swapping labels are refused by the plan.
  const n2 = await exported(N.P);
  const edge = jsonAt(n2, 'relationships.json').relationships[0];
  const second = { ...edge, id: fid(0), base: undefined, from: { ...edge.from, column: 'region' }, to: { ...edge.to, column: 'name' }, label: 'Customer' };
  const relabelled = editAt(n2, 'relationships.json', (o) => { o.relationships[0].label = 'Zz customer'; o.relationships.push(second); });
  const r10e = done(await applyPlanned(N.P, relabelled));
  const labels10 = (await as(() => rels.listRelationships(N.P))).map((r) => r.label).sort();
  ok('a relabel and a new relationship taking its old label: both land, in that order', r10e.failed.length === 0 && r10e.written.join() === `relationship:${edge.id},relationship:${fid(0)}` && labels10.join() === 'Customer,Zz customer', show([r10e, labels10]));
  const n3 = await exported(N.P);
  const swapLabels = editAt(n3, 'relationships.json', (o) => { for (const r of o.relationships) r.label = r.label === 'Customer' ? 'Zz customer' : 'Customer'; });
  const swapPlan = await plan(N.P, swapLabels);
  const swapItems = swapPlan.items.filter((i) => i.kind === 'relationship');
  const labelSwapSaid = await as(async () => [msg.modelNameSwap('Zz customer'), msg.modelNameSwap('Customer')]);
  ok('two relationships swapping labels: both skipped with the sentence, nothing written', swapItems.length === 2 && swapItems.every((i) => i.status === 'skipped' && i.reason === 'invalid' && labelSwapSaid.includes(String(i.error)))
    && done(await apply(N.P, swapLabels, swapPlan.hash)).written.length === 0, show(swapItems));

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
