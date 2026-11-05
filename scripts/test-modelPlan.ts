// The import dry run (semantic layer part 7, a2; docs/semantic-layer/07-portability.md D4, D5, D7, Tests "Merge
// matrix" and "Leaks"), over ./modelFixture.ts. Each case edits a1's export of the fixture as git would.
//
// 1. Round trip: every item unchanged; the plan writes nothing and hydrates nothing; its hash is stable.
// 2. Renames, new objects, promotion across projects (same names, other ids: updates that keep the target's ids).
// 3. Skips and their dependents: a missing dataset, a term, a relationship (via) and a period base on it.
// 4. Only here (never a delete), sensitivity (rises, never falls), a missing column, base filters onto an extract.
// 5. Leaks: no planted secret, origin, SQL or rule value in a plan reply. NEGATIVE CONTROL: the guide canary is.
// 6. Three-way: edited here and in the file is a conflict; here only is unchanged and newer here; no base is an update.
//    The hash moves when a target moves.
//
//   npm run build:ts && node scripts/test-modelPlan.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, hydrated, post } from './liveRouteHarness';
import { buildModelFixture, GUIDE_CANARY } from './modelFixture';
import type { ImportPlan, PlanItem } from '../src/app/modelPlan';

const { exportModel }: typeof import('../src/app/modelExport') = require('../src/app/modelExport');
const { readModelFiles }: typeof import('../src/app/modelRead') = require('../src/app/modelRead');
const { planImport }: typeof import('../src/app/modelPlan') = require('../src/app/modelPlan');
const { modelJson }: typeof import('../src/app/modelFormat') = require('../src/app/modelFormat');

type Files = Map<string, string>;
type Json = Record<string, any>; // any: a model file, edited as git would edit it

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
const without = (files: Files, p: string): Files => new Map([...files].filter(([k]) => k !== p));
const fid = (n: number): string => `5e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BASE = 'b'.repeat(43);

async function plan(projectId: string, files: Files): Promise<ImportPlan> {
  return H.as(H.ORG_A, async () => {
    const read = await readModelFiles(files);
    if ('refused' in read) throw new Error(`refused: ${read.refused}`);
    return planImport(projectId, read);
  });
}
const itemOf = (p: ImportPlan, key: string): PlanItem => p.items.find((i) => i.key === key) ?? ({ key: 'none', status: 'none' } as unknown as PlanItem);
const show = (p: ImportPlan | PlanItem): string => JSON.stringify(p).slice(0, 1500);

(async () => {
  const F = await buildModelFixture();
  const files0 = (await H.as(H.ORG_A, () => exportModel(F.P))).files;
  const zipBefore = [...files0].join('\n');
  const avg = jsonAt(files0, 'metrics/avg-basket.json').id as string;

  // ── 1. Round trip ─────────────────────────────────────────────────────────
  const from = hydrated.length;
  const p0 = await plan(F.P, files0);
  ok('round trip: every item unchanged', p0.items.length > 0 && p0.items.every((i) => i.status === 'unchanged') && p0.counts.unchanged === p0.items.length, show(p0));
  ok('round trip: tables, fields, base filters, relationships, terms and metrics each have items', ['table', 'field', 'baseFilters', 'relationship', 'term', 'metric'].every((k) => p0.items.some((i) => i.kind === k)), p0.items.map((i) => i.key).join());
  ok('the plan names the files\' source', p0.source.project === 'Retail model' && typeof p0.source.appVersion === 'string');
  ok('what the files never carry is listed', p0.notCarried.join() === 'metricTrees', p0.notCarried.join());
  ok('the plan hash is stable', (await plan(F.P, files0)).hash === p0.hash && /^[A-Za-z0-9_-]{43}$/.test(p0.hash));
  ok('the plan writes nothing', [...(await H.as(H.ORG_A, () => exportModel(F.P))).files].join('\n') === zipBefore);
  ok('the plan hydrates no dataset', hydrated.length === from, hydrated.slice(from).join());
  ok('items in write order: tables and fields, base filters, relationships, terms, metrics', (() => {
    const order = ['dataset', 'table', 'field', 'baseFilters', 'relationship', 'term', 'metric'];
    return p0.items.every((it, i) => i === 0 || order.indexOf(p0.items[i - 1].kind) <= order.indexOf(it.kind));
  })());

  // ── 2. Renames, new objects, promotion ────────────────────────────────────
  const renamed = itemOf(await plan(F.P, edit(files0, 'metrics', avg, (m) => { m.name = 'Average basket'; })), `metric:${avg}`);
  ok('same id, new name: renamed, with the change', renamed.status === 'renamed' && renamed.name === 'Average basket' && renamed.targetId === avg && renamed.changes?.some((c) => c.field === 'name' && c.here === 'Avg basket' && c.file === 'Average basket') === true, show(renamed));
  const fresh = put(put(files0, 'metrics/gross-margin.json', { ...jsonAt(files0, 'metrics/orders.json'), id: fid(1), name: 'Gross margin' }), 'terms/enterprise.json', { ...jsonAt(files0, 'terms/emea.json'), id: fid(2), name: 'Enterprise', aliases: [] });
  const pf = await plan(F.P, fresh);
  ok('a new metric and a new term are new, with no target', itemOf(pf, `metric:${fid(1)}`).status === 'new' && itemOf(pf, `term:${fid(2)}`).status === 'new' && itemOf(pf, `metric:${fid(1)}`).targetId === undefined, show(itemOf(pf, `metric:${fid(1)}`)));

  const clone = await H.as(H.ORG_A, async () => {
    const C = (await H.projects.createProject('Clone')).id;
    const cols = [{ name: 'order_id', type: 'text' as const }, { name: 'customer_id', type: 'text' as const }, { name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }, { name: 'day', type: 'date' as const }, { name: 'units', type: 'number' as const }];
    const o = await H.datasets.saveDataset(C, { name: 'Orders', sourceKind: 'csv', columns: cols, rows: [['o1', 'c1', 'EU', 10, '2025-03-01', 4]] });
    const c = await H.datasets.saveDataset(C, { name: 'Customers', sourceKind: 'csv', columns: [{ name: 'id', type: 'text' }, { name: 'name', type: 'text' }], rows: [['c1', 'Ada']] });
    if (!o || !c) throw new Error('clone datasets not saved');
    return { C, orders: o.id };
  });
  const revClone = (await post('metric:save', { projectId: clone.C, input: { datasetId: clone.orders, name: 'Revenue', definition: { column: 'amount', aggregation: 'sum' } } })).value.metric.id as string;
  const pc = await plan(clone.C, files0);
  const revInClone = itemOf(pc, `metric:${F.revenue}`);
  ok('across projects: an update keeps the target id, never a new duplicate', revInClone.status === 'updated' && revInClone.targetId === revClone, show(revInClone));
  ok('across projects: every difference is shown as a change', revInClone.changes?.some((c) => c.field === 'description' && c.here === undefined && c.file === 'Net revenue in EMEA') === true, show(revInClone));
  ok('across projects: the table doc is an update onto the clone\'s dataset', itemOf(pc, `table:${F.orders}`).status === 'updated' && itemOf(pc, `table:${F.orders}`).targetId === clone.orders);
  ok('across projects: a term the clone lacks is new', itemOf(pc, `term:${F.emea}`).status === 'new');
  ok('across projects: a dataset the clone lacks is skipped', itemOf(pc, `dataset:${F.live}`).status === 'skipped' && itemOf(pc, `dataset:${F.live}`).reason === 'dataset_missing');

  // ── 3. Skips and their dependents ─────────────────────────────────────────
  const RETURNS = fid(10);
  let s = put(files0, 'datasets/returns.json', { id: RETURNS, name: 'Returns', base: BASE });
  s = put(s, 'metrics/refunds.json', { ...jsonAt(files0, 'metrics/orders.json'), id: fid(11), name: 'Refunds', dataset: RETURNS });
  s = put(s, 'terms/returned.json', { ...jsonAt(files0, 'terms/emea.json'), id: fid(12), name: 'Returned', aliases: [], dataset: RETURNS });
  s = put(s, 'metrics/emea-returns.json', { ...jsonAt(files0, 'metrics/orders.json'), id: fid(13), name: 'Returned orders', filters: [{ type: 'term', term: fid(12) }] });
  const rel = jsonAt(files0, 'relationships.json').relationships[0];
  s = put(s, 'relationships.json', { relationships: [rel, { ...rel, id: fid(14), label: 'Returned', to: { dataset: RETURNS, column: 'id' } }] });
  s = put(s, 'metrics/via-returns.json', { ...jsonAt(files0, 'metrics/orders.json'), id: fid(15), name: 'Via returns', filters: [{ type: 'filter', column: 'reason', op: '=', value: 'x', via: fid(14) }] });
  s = put(s, 'metrics/refunds-mtd.json', { ...jsonAt(files0, 'metrics/revenue-mtd.json'), id: fid(16), name: 'Refunds MTD', definition: { base: fid(11), window: { to_date: 'month' } } });
  const ps = await plan(F.P, s);
  ok('a missing dataset is skipped', itemOf(ps, `dataset:${RETURNS}`).status === 'skipped' && itemOf(ps, `dataset:${RETURNS}`).reason === 'dataset_missing', show(itemOf(ps, `dataset:${RETURNS}`)));
  ok('a metric on it is skipped, naming why', itemOf(ps, `metric:${fid(11)}`).reason === 'depends_on_skipped' && itemOf(ps, `metric:${fid(11)}`).because === `dataset:${RETURNS}`, show(itemOf(ps, `metric:${fid(11)}`)));
  ok('a term on it is skipped', itemOf(ps, `term:${fid(12)}`).reason === 'depends_on_skipped');
  ok('a metric whose term step names the skipped term is skipped', itemOf(ps, `metric:${fid(13)}`).reason === 'depends_on_skipped' && itemOf(ps, `metric:${fid(13)}`).because === `term:${fid(12)}`, show(itemOf(ps, `metric:${fid(13)}`)));
  ok('a relationship to it is skipped, and a via naming that relationship', itemOf(ps, `relationship:${fid(14)}`).reason === 'depends_on_skipped' && itemOf(ps, `metric:${fid(15)}`).reason === 'depends_on_skipped' && itemOf(ps, `metric:${fid(15)}`).because === `relationship:${fid(14)}`, show(itemOf(ps, `metric:${fid(15)}`)));
  ok('a period metric whose base is skipped is skipped, never written with a dangling id', itemOf(ps, `metric:${fid(16)}`).reason === 'depends_on_skipped' && itemOf(ps, `metric:${fid(16)}`).because === `metric:${fid(11)}`, show(itemOf(ps, `metric:${fid(16)}`)));
  ok('NEGATIVE CONTROL: what does not depend on it is untouched', itemOf(ps, `metric:${F.revenue}`).status === 'unchanged' && itemOf(ps, `relationship:${rel.id}`).status === 'unchanged');
  const dangling = itemOf(await plan(F.P, put(files0, 'metrics/dangling.json', { ...jsonAt(files0, 'metrics/orders.json'), id: fid(17), name: 'Dangling', filters: [{ type: 'term', term: fid(18) }] })), `metric:${fid(17)}`);
  ok('a reference to nothing in either side is skipped', dangling.reason === 'depends_on_skipped' && dangling.because === `term:${fid(18)}`, show(dangling));
  const bad = await plan(F.P, put(files0, 'metrics/bad.json', '7'));
  ok('an unreadable file is one skipped item', bad.items.filter((i) => i.status === 'skipped').length === 1 && itemOf(bad, 'metric:file:metrics/bad.json').reason === 'invalid' && typeof itemOf(bad, 'metric:file:metrics/bad.json').error === 'string');

  // ── 4. Only here, sensitivity, columns, base filters ──────────────────────
  const onlyHere = await plan(F.P, without(files0, 'terms/emea.json'));
  ok('only here is listed and never a delete', itemOf(onlyHere, `term:here:${F.emea}`).status === 'onlyHere' && itemOf(onlyHere, `term:here:${F.emea}`).targetId === F.emea, show(onlyHere));
  ok('a metric naming a term only here still plans', itemOf(onlyHere, `metric:${F.revenue}`).status === 'unchanged');
  const fieldOf = (files: Files, column: string, change: (f: Json) => void): Files => edit(files, 'datasets', F.orders, (d) => {
    let f = d.fields.find((x: Json) => x.name === column);
    if (!f) d.fields.push((f = { name: column }));
    change(f);
  });
  const lowered = itemOf(await plan(F.P, fieldOf(files0, 'amount', (f) => { delete f.sensitivity; })), `field:${F.orders}:amount`);
  ok('sensitivity financial → none is skipped', lowered.status === 'skipped' && lowered.reason === 'sensitivity_lowered', show(lowered));
  ok('sensitivity financial → personal is skipped', itemOf(await plan(F.P, fieldOf(files0, 'amount', (f) => { f.sensitivity = 'personal'; })), `field:${F.orders}:amount`).reason === 'sensitivity_lowered');
  const raised = itemOf(await plan(F.P, fieldOf(files0, 'region', (f) => { f.sensitivity = 'financial'; })), `field:${F.orders}:region`);
  ok('NEGATIVE CONTROL: none → financial applies', raised.status === 'updated' && raised.changes?.some((c) => c.field === 'sensitivity' && c.file === 'financial') === true, show(raised));
  ok('a new field doc on a column with none is an update', itemOf(await plan(F.P, fieldOf(files0, 'units', (f) => { f.description = 'Units sold'; })), `field:${F.orders}:units`).status === 'updated');
  const gone = itemOf(await plan(F.P, fieldOf(files0, 'gone_col', (f) => { f.description = 'x'; })), `field:${F.orders}:gone_col`);
  ok('a field doc for a missing column is skipped', gone.status === 'skipped' && gone.reason === 'column_missing', show(gone));
  const ontoExtract = itemOf(await plan(F.P, edit(files0, 'datasets', F.orders, (d) => { d.baseFilters = [{ type: 'filter', column: 'region', op: '=', value: 'EU' }]; })), `baseFilters:${F.orders}`);
  ok('base filters onto an extract: not_live', ontoExtract.status === 'skipped' && ontoExtract.reason === 'not_live', show(ontoExtract));
  const onLive = itemOf(await plan(F.P, edit(files0, 'datasets', F.live, (d) => { d.baseFilters = [{ type: 'filter', column: 'region', op: '=', value: 'ME' }]; })), `baseFilters:${F.live}`);
  ok('NEGATIVE CONTROL: base filters onto a Live dataset are an update', onLive.status === 'updated', show(onLive));

  // ── 5. Leaks ──────────────────────────────────────────────────────────────
  const guided = put(files0, 'datasets/orders.md', `${files0.get('datasets/orders.md')}\n\nOne more line.`);
  const leakPlan = await plan(F.P, guided);
  const reply = JSON.stringify(leakPlan);
  for (const [what, needle] of F.planted) ok(`no ${what} in the plan reply`, needle.length > 0 && !reply.includes(needle), needle);
  ok('NEGATIVE CONTROL: the guide canary is in it', reply.includes(GUIDE_CANARY) && itemOf(leakPlan, `table:${F.orders}`).status === 'updated');

  // ── 6. Three-way ──────────────────────────────────────────────────────────
  const hashBefore = (await plan(F.P, files0)).hash;
  const edited = await post('metric:update', { projectId: F.P, id: F.revenue, patch: { description: 'here' } });
  if (edited.value.ok !== true) throw new Error(`edit here failed: ${edited.body}`);
  const both = itemOf(await plan(F.P, edit(files0, 'metrics', F.revenue, (m) => { m.description = 'file'; })), `metric:${F.revenue}`);
  ok('edited here and in the file: conflict', both.status === 'conflict' && both.changes?.some((c) => c.field === 'description' && c.here === 'here' && c.file === 'file') === true, show(both));
  const stale = itemOf(await plan(F.P, files0), `metric:${F.revenue}`);
  ok('edited here only: unchanged, newer here', stale.status === 'unchanged' && stale.newerHere === true, show(stale));
  const noBase = itemOf(await plan(F.P, edit(files0, 'metrics', F.revenue, (m) => { delete m.base; m.description = 'file'; })), `metric:${F.revenue}`);
  ok('no base: every difference is an update', noBase.status === 'updated', show(noBase));
  const hashAfter = (await plan(F.P, files0)).hash;
  ok('the hash moves when a target moves', hashBefore !== hashAfter);
  await post('term:update', { projectId: F.P, id: F.emea, patch: { description: 'x' } });
  ok('the hash moves when a term moves too', (await plan(F.P, files0)).hash !== hashAfter);
  const tableBoth = await post('catalog:setTable', { projectId: F.P, datasetId: F.orders, patch: { grain: 'One row per line' } });
  if (tableBoth.value.ok !== true) throw new Error(`table edit failed: ${tableBoth.body}`);
  ok('a table doc edited here only: newer here', itemOf(await plan(F.P, files0), `table:${F.orders}`).newerHere === true);

  // ── 7. The editor's gates ─────────────────────────────────────────────────
  // metric:save and metric:update, byte for byte: their replies hashed (ids, stamps and tags normalized) before their
  // bodies moved to src/ipc/metricSave.ts, and pinned.
  const pinOf = async (): Promise<string> => {
    const save = async (input: Record<string, unknown>) => (await post('metric:save', { projectId: F.P, input: { datasetId: F.orders, format: { kind: 'number', decimals: 0, compact: false }, ...input } })).value;
    const update = async (id: string, patch: Record<string, unknown>) => (await post('metric:update', { projectId: F.P, id, patch })).value;
    const sum = { column: 'amount', aggregation: 'sum' };
    const replies: unknown[] = [
      await save({ name: 'Revenue', definition: sum }),
      await save({ name: ' emea ', definition: sum }),
      await save({ name: 'Pin period', definition: { base: fid(90), window: { to_date: 'month' } } }),
      await save({ name: 'Pin period', definition: { base: F.revenue, window: { to_date: 'month' } }, timeColumn: 'day' }),
      await save({ name: 'Pin funnel', definition: { funnel: { entity: 'nope', event: 'region', time: 'day', steps: ['EU', 'ME'], window: { n: 7, unit: 'days' } }, show: 'rate' } }),
      await save({ name: 'Pin snapshot', definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'region', take: 'last' } } }),
      await save({ name: 'Pin per', definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: 'day' } } }),
      await save({ name: 'Pin per', definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: 'nope' } } }),
      await save({ name: 'Pin time', definition: sum, timeColumn: 'region' }),
      await save({ name: 'Pin target', definition: sum, timeColumn: 'day', target: { source: { value: 5 } } }),
      await save({ name: 'Pin gone', definition: sum, datasetId: fid(91) }),
      await update(F.stock, { name: 'revenue' }),
      await update(F.mtd, { definition: { base: fid(92), window: { to_date: 'month' } } }),
      await update(F.stock, { definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'region', take: 'last' } } }),
      await update(F.stock, { timeColumn: 'region' }),
      await update(F.revenue, { target: { source: { value: 5 } } }),
      await update(fid(93), { description: 'x' }),
    ];
    const made = await save({ name: 'Pin metric', definition: sum, description: 'pinned', timeColumn: 'day' });
    const distinct = await save({ name: 'Pin distinct', definition: { column: 'order_id', aggregation: 'countd' } });
    replies.push(made, await update(made.metric.id, { description: 'pinned again', timeColumn: 'day' }), distinct);
    for (const m of [made, distinct]) await post('metric:delete', { projectId: F.P, id: m.metric.id });
    const text = JSON.stringify(replies)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'TS')
      .replace(/"tag":"[^"]*"/g, '"tag":"TAG"');
    return require('crypto').createHash('sha256').update(text).digest('hex') as string;
  };
  const PIN = 'fb294aaf7473ae590e4294ea900089c81ccb2ad486fa22a249663b9b11140839';
  const pin = await pinOf();
  ok('metric:save and metric:update replies are byte-identical to before the lift', pin === PIN, pin);

  // Each defect is refused with the sentence the editor itself gives for it (asked of the editor, which refuses too).
  const filesG = (await H.as(H.ORG_A, () => exportModel(F.P))).files;
  const editor = async (channel: string, payload: Record<string, unknown>): Promise<string> => {
    const r = await post(channel, { projectId: F.P, ...payload });
    if (r.value.ok !== false) throw new Error(`the editor took ${channel}: ${r.status} ${r.body.slice(0, 300)}`);
    return String(r.value.error);
  };
  const dupLabels = [{ value: 'EU', label: 'Europe' }, { value: 'EE', label: 'Europe' }];
  const badBase = [{ type: 'filter', column: 'nope', op: '=', value: 'x' }];
  const rel0 = jsonAt(filesG, 'relationships.json').relationships[0];
  const NEG: Array<[string, Files, string, string]> = [
    ['a duplicate value label', fieldOf(filesG, 'region', (f) => { f.values = dupLabels; }), `field:${F.orders}:region`, await editor('catalog:setColumn', { datasetId: F.orders, column: 'region', patch: { values: dupLabels } })],
    ['value labels on a column that is not text', fieldOf(filesG, 'amount', (f) => { f.values = [{ value: '1', label: 'One' }]; }), `field:${F.orders}:amount`, await editor('catalog:setColumn', { datasetId: F.orders, column: 'amount', patch: { values: [{ value: '1', label: 'One' }] } })],
    ['an "Also called" name another column answers to', fieldOf(filesG, 'amount', (f) => { f.aliases = ['region']; }), `field:${F.orders}:amount`, await editor('catalog:setColumn', { datasetId: F.orders, column: 'amount', patch: { aliases: ['region'] } })],
    ['a key that is not a column', edit(filesG, 'datasets', F.orders, (d) => { d.key = 'nope'; }), `table:${F.orders}`, await editor('catalog:setTable', { datasetId: F.orders, patch: { key: 'nope' } })],
    ['a base filter on a column the Live dataset lacks', edit(filesG, 'datasets', F.live, (d) => { d.baseFilters = badBase; }), `baseFilters:${F.live}`, await editor('live:setBaseFilters', { datasetId: F.live, filters: badBase })],
    ['a term inside a term', edit(filesG, 'terms', F.emea, (t) => { t.filters = [{ type: 'term', term: F.emea }]; }), `term:${F.emea}`, await editor('term:update', { id: F.emea, patch: { filters: [{ type: 'term', term: F.emea }] } })],
    ['a term named like a metric', edit(filesG, 'terms', F.emea, (t) => { t.name = 'Revenue'; }), `term:${F.emea}`, await editor('term:update', { id: F.emea, patch: { name: 'Revenue' } })],
    ['a metric named like a term', edit(filesG, 'metrics', F.revenue, (m) => { m.name = 'EMEA'; }), `metric:${F.revenue}`, await editor('metric:update', { id: F.revenue, patch: { name: 'EMEA' } })],
    ['a snapshot on a column that is not a date', edit(filesG, 'metrics', F.stock, (m) => { m.definition.snapshot.column = 'region'; }), `metric:${F.stock}`, await editor('metric:update', { id: F.stock, patch: { definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'region', take: 'last', per: 'region' } } } })],
    ['a period metric with a date of its own', edit(filesG, 'metrics', F.mtd, (m) => { m.timeColumn = 'day'; }), `metric:${F.mtd}`, await editor('metric:update', { id: F.mtd, patch: { timeColumn: 'day' } })],
    ['a formula that does not compile', edit(filesG, 'metrics', avg, (m) => { m.definition = { formula: '[Revenue] +' }; }), `metric:${avg}`, String((await post('metric:check', { projectId: F.P, datasetId: F.orders, expression: '[Revenue] +', name: 'Avg basket', id: avg })).value.error)],
    ['a relationship label another one between the two datasets has', put(filesG, 'relationships.json', { relationships: [rel0, { ...rel0, id: fid(40), base: BASE, from: { dataset: F.orders, column: 'region' }, to: { dataset: F.customers, column: 'name' } }] }), `relationship:${fid(40)}`,
      await editor('relationship:save', { relationship: { from: { datasetId: F.orders, column: 'region' }, to: { datasetId: F.customers, column: 'name' }, cardinality: 'many_to_one', label: 'Customer' } })],
  ];
  for (const [what, f, key, sentence] of NEG) {
    const i = itemOf(await plan(F.P, f), key);
    ok(`${what}: skipped with the editor's sentence`, sentence.length > 0 && i.status === 'skipped' && i.reason === 'invalid' && i.error === sentence, `${show(i)} / ${sentence}`);
  }
  const ordersMetric = jsonAt(filesG, 'metrics/orders.json');
  const twoNew = await plan(F.P, put(put(filesG, 'metrics/margin-a.json', { ...ordersMetric, id: fid(41), name: 'Margin' }), 'metrics/margin-b.json', { ...ordersMetric, id: fid(42), name: 'Margin' }));
  const taken = await H.as(H.ORG_A, async () => require('../src/ipc/metrics').nameTakenMessage('Margin') as string);
  ok('two new metrics with one name: both skipped with the editor\'s sentence', [41, 42].every((n) => itemOf(twoNew, `metric:${fid(n)}`).error === taken), show(twoNew));
  const swapped = await plan(F.P, edit(edit(filesG, 'metrics', F.stock, (m) => { m.name = 'Orders'; }), 'metrics', jsonAt(filesG, 'metrics/orders.json').id, (m) => { m.name = 'Stock on hand'; }));
  ok('two metrics swapping names: both plan, against the names after the import', itemOf(swapped, `metric:${F.stock}`).status === 'renamed' && itemOf(swapped, `metric:${ordersMetric.id}`).status === 'renamed', show(swapped));
  const pending = await plan(F.P, put(put(filesG, 'metrics/units.json', { ...ordersMetric, id: fid(43), name: 'Units', definition: { column: 'units', aggregation: 'sum' }, timeColumn: 'day' }), 'metrics/units-mtd.json', { ...jsonAt(filesG, 'metrics/revenue-mtd.json'), id: fid(44), name: 'Units MTD', definition: { base: fid(43), window: { to_date: 'month' } } }));
  ok('a period metric over a new base metric is new: its base is checked when it is written', itemOf(pending, `metric:${fid(44)}`).status === 'new' && itemOf(pending, `metric:${fid(43)}`).status === 'new', show(pending));
  let withSkip = put(filesG, 'datasets/returns.json', { id: fid(45), name: 'Returns', base: BASE });
  withSkip = put(withSkip, 'metrics/refunds.json', { ...ordersMetric, id: fid(46), name: 'Refunds', dataset: fid(45) });
  withSkip = put(withSkip, 'metrics/refund-share.json', { ...ordersMetric, id: fid(47), name: 'Refund share', definition: { formula: '[Refunds] / [Revenue]' } });
  const share = itemOf(await plan(F.P, withSkip), `metric:${fid(47)}`);
  ok('a formula naming a metric the import skips is refused as the editor refuses an unknown name', share.reason === 'invalid' && share.error === String((await post('metric:check', { projectId: F.P, datasetId: F.orders, expression: '[Refunds] / [Revenue]', name: 'Refund share' })).value.error), show(share));
  ok('NEGATIVE CONTROL: the same files without a defect plan clean', (await plan(F.P, filesG)).items.every((i) => i.status !== 'skipped'), show(await plan(F.P, filesG)));
  ok('metric:save still refuses a taken name with field "name"', (await post('metric:save', { projectId: F.P, input: { datasetId: F.orders, name: 'Revenue', definition: { column: 'amount', aggregation: 'sum' } } })).value.field === 'name');

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
