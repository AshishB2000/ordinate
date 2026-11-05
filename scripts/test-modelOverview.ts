// `model:overview` (semantic layer part 1, step 10): the Data model's Datasets tab in one read — every
// dataset's role, key state, description, always-applied filters and calculated fields, and the ranked
// "To fill in next" strip, from METADATA only.
//
// 1. Every dataset, in dataset:list order; nothing filled in reads as blanks, the strip as four gaps by rank.
// 2. A key that repeats leads the strip with the stored count; the role, key state and description follow the docs.
// 3. A copy's Prepare filter steps and calculated fields, a Live dataset's base filters — copies as stored.
// 4. Metadata only: no dataset is hydrated and no warehouse statement is sent.
//    NEGATIVE CONTROL: todoOf of a row with everything filled in is empty.
// (The row-restricted caller's redaction is covered in scripts/test-rowPolicySafetyNet.ts.)
//
//   npm run build:ts && node scripts/test-modelOverview.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrates, post } from './liveRouteHarness';

const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
const { todoOf, TODO_SHOWN }: typeof import('../src/ipc/modelOverview') = require('../src/ipc/modelOverview');

(async () => {
  const { projectId: P, extractId: X, liveId: L } = await H.setupOrg(H.ORG_A);
  const ov = async (): Promise<Reply> => (await post('model:overview', { projectId: P })).value;
  const ids = ((await post('dataset:list', { projectId: P })).value as unknown as Reply[]).map((d) => d.id);

  // ── 1. Nothing filled in ─────────────────────────────────────────────────
  const a = await ov();
  ok('answers ok', a.ok === true, JSON.stringify(a).slice(0, 200));
  ok('every dataset, in dataset:list order', JSON.stringify(a.tables?.map((t: Reply) => t.datasetId)) === JSON.stringify(ids), JSON.stringify(a.tables));
  ok('nothing filled in', a.tables.every((t: Reply) => t.role === '' && t.key === '' && t.keyState === '' && t.description === ''));
  ok('four by rank, then how many more', TODO_SHOWN === 4 && JSON.stringify(a.todo.map((i: Reply) => i.kind)) === '["no_key","no_key","no_guide","no_guide"]' && a.more === 4, JSON.stringify(a.todo));

  // ── 2. A repeating key leads ─────────────────────────────────────────────
  await post('catalog:setTable', { projectId: P, datasetId: X, patch: { role: 'fact', key: 'region', guide: '# Fixture' } });
  await post('catalog:set', { projectId: P, ref: `dataset:${X}`, patch: { description: 'The parity fixture' } });
  const stored = (await post('catalog:getTable', { projectId: P, datasetId: X })).value.table.keyCheck.repeatedKeys;
  const b = await ov();
  const tag = (i: Reply) => [i.datasetId === X ? 'X' : 'L', i.kind];
  ok('setup: region repeats in the fixture', stored > 0, String(stored));
  ok('a repeating key leads, with the stored count', JSON.stringify(b.todo.map(tag)) === '[["X","key_repeats"],["L","no_key"],["L","no_guide"],["L","no_description"]]' && Object.is(b.todo[0].repeats, stored) && b.more === 1, JSON.stringify(b.todo));
  ok('X reads fact, repeats, described', ((t: Reply) => t.role === 'fact' && t.key === 'region' && t.keyState === 'repeats' && t.description === 'The parity fixture')(b.tables.find((t: Reply) => t.datasetId === X)));
  ok('only the strip\'s items carry a count', b.todo.slice(1).every((i: Reply) => !('repeats' in i)));

  // ── 3. Always applied, and calculated fields ─────────────────────────────
  await post('dataset:addStep', { projectId: P, datasetId: X, step: { type: 'filter', column: 'region', op: '=', value: 'North' } });
  await post('dataset:addStep', { projectId: P, datasetId: X, step: { type: 'calculated_field', name: 'double', expression: '[amt] * 2' } });
  // PR 08's store writer (live:setBaseFilters' own, without the schema sync that handler queues: no warehouse call here).
  ok('setup: a base filter on the Live dataset', !!(await H.as(H.ORG_A, () => liveDataset.setBaseFilters(P, L, [{ type: 'filter', column: 'region', op: '=', value: 'North' }]))));
  const calls0 = H.fake.calls.length;
  const hx = await hydrates(X, ov);
  const hl = await hydrates(L, ov);
  const c = hx.value;
  const row = (id: string): Reply => c.tables.find((t: Reply) => t.datasetId === id);
  const meta = await H.as(H.ORG_A, () => H.datasets.getDatasetMeta(P, X));
  ok('a copy: its Prepare filter steps as stored', JSON.stringify(row(X).alwaysApplied) === JSON.stringify({ kind: 'prepare', steps: meta!.steps!.filter((s) => s.type === 'filter') }), JSON.stringify(row(X).alwaysApplied));
  ok('a copy: its calculated field with its formula', JSON.stringify(row(X).calculated) === '[{"name":"double","formula":"[amt] * 2"}]', JSON.stringify(row(X).calculated));
  ok('Live: its base filters, and no calculated field', row(L).alwaysApplied.kind === 'live' && row(L).alwaysApplied.steps[0]?.value === 'North' && JSON.stringify(row(L).calculated) === '[]', JSON.stringify(row(L)));
  ok('an editor reads the values', !('valuesHidden' in row(X)) && !('valuesHidden' in row(L)));

  // ── 5. What needs review (part 4) ────────────────────────────────────────
  ok('NEGATIVE CONTROL: no status, no review key', !('review' in c));
  const save = async (name: string, definition: Reply, extra: Reply = {}): Promise<string> => (await post('metric:save', { projectId: P, input: { name, datasetId: X, definition, ...extra } })).value.metric.id;
  const certifyNow = async (ref: string): Promise<void> => {
    const pin = (await post('model:review', { projectId: P, ref })).value.pin;
    ok(`setup: ${ref.slice(0, 7)} certified`, (await post('model:certify', { projectId: P, ref, base: pin })).value.ok === true);
  };
  const sum = { column: 'amt', aggregation: 'sum' };
  const REV = await save('Revenue', sum);
  const GROSS = await save('Gross', sum);
  const NET = await save('Net', sum);
  const IDLE = await save('Idle', sum);
  await save('Uses gross', { formula: '[Gross] + 1' });
  await save('Uses gross again', { formula: '[Gross] * 2' });
  const EMEA = (await post('term:save', { projectId: P, input: { name: 'EMEA', aliases: [], description: '', datasetId: X, filters: [{ type: 'filter', column: 'region', op: 'in', values: ['North'] }] } })).value.term.id;
  await save('Emea sales', sum, { filters: [{ type: 'term', term: EMEA }] });
  await certifyNow(`metric:${REV}`);
  await post('metric:update', { projectId: P, id: REV, patch: { filters: [{ type: 'filter', column: 'region', op: '=', value: 'North' }] } });
  const retire = (ref: string, replacedBy?: string) => post('model:retire', { projectId: P, ref, ...(replacedBy && { replacedBy }) });
  await retire(`metric:${GROSS}`, `metric:${NET}`); // GROSS is named by two formulas
  await retire(`metric:${IDLE}`); // nobody uses it
  await retire(`term:${EMEA}`); // one metric filters by it
  const r = (await ov()).review;
  ok('changed since certified leads, then retired and used (most used first)', JSON.stringify(r?.map((i: Reply) => [i.ref, i.kind, i.uses ?? null]))
    === JSON.stringify([[`metric:${REV}`, 'needs_review', null], [`metric:${GROSS}`, 'retired_used', 2], [`term:${EMEA}`, 'retired_used', 1]]), JSON.stringify(r));
  ok('each carries the name it has now', r.map((i: Reply) => i.name).join() === 'Revenue,Gross,EMEA');
  ok('a retired item nobody uses is not listed', !r.some((i: Reply) => i.ref === `metric:${IDLE}`));
  ok('todo keeps its part-1 kinds only', (await ov()).todo.every((i: Reply) => ['key_repeats', 'no_key', 'no_guide', 'no_description', 'no_role'].includes(i.kind)));
  const usage = (await post('catalog:list', { projectId: P })).value.rows.find((x: Reply) => x.ref === `dataset:${X}`).usage;
  await retire(`dataset:${X}`);
  const dsItem = (await ov()).review.find((i: Reply) => i.ref === `dataset:${X}`);
  ok('a retired dataset in use carries the catalog\'s own count', dsItem?.kind === 'retired_used' && Object.is(dsItem.uses, usage) && usage > 0, JSON.stringify(dsItem));
  await post('model:clearStatus', { projectId: P, ref: `metric:${REV}` });
  ok('clearing an item takes it off the list', !(await ov()).review.some((i: Reply) => i.ref === `metric:${REV}`));
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => save(`Bulk ${i}`, sum)));
  for (const id of many) { await certifyNow(`metric:${id}`); await post('metric:update', { projectId: P, id, patch: { description: 'x' } }); await post('metric:update', { projectId: P, id, patch: { filters: [{ type: 'filter', column: 'region', op: '=', value: 'South' }] } }); }
  ok('at most 8 are listed', (await ov()).review.length === 8);

  // ── 4. Metadata only ─────────────────────────────────────────────────────
  ok('metadata only: nothing hydrated, no warehouse statement', !hx.hydrated && !hl.hydrated && H.fake.calls.length === calls0, `${hx.hydrated} ${hl.hydrated} ${H.fake.calls.length - calls0}`);
  ok('NEGATIVE CONTROL: todoOf with everything filled in', JSON.stringify(todoOf([{ datasetId: X, role: 'fact', key: 'k', repeatedKeys: 0, hasGuide: true, description: 'd' }])) === '{"todo":[],"more":0}');
  ok('NEGATIVE CONTROL: todoOf with an unchecked key asks for nothing about it', JSON.stringify(todoOf([{ datasetId: X, role: 'fact', key: 'k', repeatedKeys: null, hasGuide: true, description: 'd' }])) === '{"todo":[],"more":0}');
  const bad = await post('model:overview', { projectId: 'not-a-project' });
  ok('a bad project id is refused by the contract', bad.status === 400, `${bad.status} ${bad.body.slice(0, 120)}`);

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
