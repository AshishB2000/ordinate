// Source tables in the lineage, and the links between a dataset and its source tables (semantic layer
// part 2, PR 08; docs/semantic-layer/02-source-tables.md D9, D10, D11).
//
// 1. perTableGraph: the pure rewrite of one node per connection into one node per (connection, table).
// 2. linking: what `setReadsTables` writes (a label, no refresh or Live change) and how `choiceOrder` sorts.
// 3. the channels: sourceTable:lineage, :forDataset, dataset:setSourceTables, :sourceTableChoices (records only; the
//    choices read the warehouse once, on the call). The viewer's 403 on each is in test-sourceNamesHidden.
//
//   npm run build:ts && node scripts/test-sourceLinks.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, post, hydrates, type Reply } from './liveRouteHarness';

const { buildGraph, focus }: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');
const { perTableGraph, tableNodeId }: typeof import('../src/analysis/sourceLineage') = require('../src/analysis/sourceLineage');

const C = '0b9f3c2a-7d1e-4f5a-9c8d-1e2f3a4b5c6d';
const C2 = '0b9f3c2a-7d1e-4f5a-9c8d-1e2f3a4b5c6e';
const { selectionForDataset }: typeof import('../src/ipc/connections') = require('../src/ipc/connections');
const { liveSourceOf }: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
const { getConnector }: typeof import('../src/connectors/index') = require('../src/connectors/index');
const { setReadsTables, choiceOrder }: typeof import('../src/data/datasetSourceTables') = require('../src/data/datasetSourceTables');

const visualsStore: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const metricsStore: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');

const DOC_A = 'a1b2c3d4-0000-4000-8000-0000000000a1';

function pure(): void {
  const ds = (id: string, origin: object) => ({ id, name: `ds ${id}`, origin: { kind: 'connection', ...origin } });
  const input = {
    datasets: [ds('A', { connId: C, table: 'wh_a' }), ds('B', { connId: C, table: 'wh_b' }), ds('Q', { connId: C, sql: 'select 1' }), ds('N', { connId: C2, sql: 'select 2' }), ds('M', { connId: C, table: 'wh_c' })],
    visuals: [{ id: 'VA', name: 'va', datasetId: 'A', encoding: {}, filters: [] }],
    dashboards: [], metrics: [], reports: [], alerts: [],
    connections: [{ id: C, name: 'Warehouse', kind: 'live-fake' }, { id: C2, name: 'Other', kind: 'live-fake' }],
  };
  const g = buildGraph(input);
  const links = new Map([
    ['A', [{ connId: C, table: 'wh_a', docId: DOC_A }]],
    ['B', [{ connId: C, table: 'wh_b' }]],
    ['Q', [{ connId: C, table: 'wh_a', docId: DOC_A }, { connId: C, table: 'wh_b' }]],
  ]);
  const out = perTableGraph(g, links, (id) => (id === C ? 'Warehouse' : 'Other'));
  const idA = tableNodeId(C, DOC_A, 0), idB = tableNodeId(C, undefined, 0);
  const parents = (id: string): string[] => out.edges.filter((e) => e.to === id).map((e) => e.from).sort();
  ok('table ids: a documented table by doc id, an undocumented one by index, no name in either', idA === `source:st:${C}:${DOC_A}` && idB === `source:st:${C}:u0`);
  ok('a linked dataset is a child of its table node, not of the connection', parents('dataset:A').join() === idA && !out.nodes.some((n) => n.id === `source:conn:${C}` && out.edges.some((e) => e.from === n.id && e.to === 'dataset:A')));
  ok('a linked query is a child of each table it names', parents('dataset:Q').join() === [idA, idB].sort().join());
  ok('a table node carries the table, the connection and no ref', ((n) => n?.name === 'wh_a' && n.sub === 'Warehouse' && n.kind === 'source' && n.ref === undefined)(out.nodes.find((n) => n.id === idA)));
  ok('an unlinked dataset keeps its connection edge', parents('dataset:M').join() === `source:conn:${C}` && parents('dataset:N').join() === `source:conn:${C2}`);
  ok('a connection node with no edge left is gone; one with an unlinked dataset stays', ((all) => all.has(`source:conn:${C}`) && all.has(`source:conn:${C2}`))(new Set(out.nodes.map((n) => n.id)))
    && !perTableGraph(buildGraph({ ...input, datasets: [input.datasets[0]] }), links, () => 'x').nodes.some((n) => n.id === `source:conn:${C}`));
  const f = focus(out, idA);
  const ids = f.nodes.map((n) => n.id);
  ok('focus on a table: its datasets and what is built on them, not the other table\'s dataset', ids.includes('dataset:A') && ids.includes('dataset:Q') && ids.includes('visual:VA') && !ids.includes('dataset:B'));
  ok('NEGATIVE CONTROL: no table name in any node id', out.nodes.every((n) => !/wh_/.test(n.id)));
  ok('perTableGraph leaves the input graph alone', JSON.stringify(g) === JSON.stringify(buildGraph(input)));
}

async function linking(): Promise<void> {
  const { fakeMod, ORG_A } = H;
  const seed = await H.as(ORG_A, async () => {
    await H.projects.init();
    const P = (await H.projects.createProject('Source links')).id;
    const live = await H.liveOver(P, { table: fakeMod.ORDERS_TABLE }, fakeMod.ORDERS_COLUMNS, fakeMod.LIVE_FAKE_ID, { fixture: 'orders' });
    const q = await H.liveRecord.saveLiveRecord(P, { name: 'A query', columns: [{ name: 'x', type: 'number' }], origin: { kind: 'connection', connId: live.connId, sql: 'select 1 as x' } });
    const csv = await H.datasets.saveDataset(P, { name: 'A file', sourceKind: 'csv', columns: [{ name: 'a', type: 'text' }], rows: [['x']] });
    if (!q || !csv) throw new Error('not saved');
    return { P, C: live.connId, Q: q.id, CSV: csv.id };
  });
  const { P, Q, CSV } = seed;
  const meta = (id: string) => H.as(ORG_A, () => H.datasets.getDatasetMeta(P, id));
  const metaBefore = await meta(Q);
  ok('link: stored as given, order kept', JSON.stringify(await H.as(ORG_A, () => setReadsTables(P, Q, ['wh_b', 'wh_a']))) === '["wh_b","wh_a"]');
  const after = (await meta(Q))!;
  const def = getConnector(fakeMod.LIVE_FAKE_ID)!;
  ok('link: the refresh and the Live target are unchanged', JSON.stringify(selectionForDataset(after.origin)) === JSON.stringify(selectionForDataset(metaBefore!.origin))
    && JSON.stringify(liveSourceOf(after.origin as never, def, 'duckdb')) === JSON.stringify(liveSourceOf(metaBefore!.origin as never, def, 'duckdb')));
  ok('link: the record keeps it', JSON.stringify((after.origin as { readsTables?: string[] }).readsTables) === '["wh_b","wh_a"]');
  ok('link: dataset:source does not print it', !(await post('dataset:source', { projectId: P, id: Q })).value.label.includes('wh_'));
  ok('link: [] removes it', !('readsTables' in (await H.as(ORG_A, async () => { await setReadsTables(P, Q, []); return (await H.datasets.getDatasetMeta(P, Q))!.origin!; }))));
  ok('link: refused for a CSV dataset', (await H.as(ORG_A, () => setReadsTables(P, CSV, ['t']))) === null);
  ok('link: a name over 1,000 characters is dropped, 17 names are cut to 16', (await H.as(ORG_A, () => setReadsTables(P, Q, ['x'.repeat(1001), ...Array.from({ length: 17 }, (_, i) => `t${i}`)])))!.length === 16);
  ok('choiceOrder: words in the query first, never a substring', JSON.stringify(choiceOrder(['wh_z', 'PUBLIC.WH_B', 'wh_a', 'wh_ab'], 'select * from wh_b join wh_a using (k)')) === '["PUBLIC.WH_B","wh_a","wh_ab","wh_z"]');
  ok('choiceOrder: NEGATIVE CONTROL: with no query it is the plain name order', JSON.stringify(choiceOrder(['b', 'a'], '')) === '["a","b"]');
}

async function channels(): Promise<void> {
  const { fakeMod, fake, ORG_A } = H;
  const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
  const api: typeof import('../src/api/index') = require('../src/api/index');
  const rows = [['a', 1, '2024-01-01']];
  const s = await H.as(ORG_A, async () => {
    await H.projects.init();
    const P = (await H.projects.createProject('Source link channels')).id;
    const cols = [{ name: 'k', type: 'text' as const }, { name: 'amt', type: 'number' as const }, { name: 'day', type: 'date' as const }];
    await fakeMod.loadWarehouseTable('wh_a', cols, rows as never);
    await fakeMod.loadWarehouseTable('wh_b', cols, rows as never);
    const conn = await H.connections.saveConnection(P, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
    if (!conn) throw new Error('connection not saved');
    const live = async (name: string, origin: object) => { const r = await H.liveRecord.saveLiveRecord(P, { name, columns: [{ name: 'amt', type: 'number' }], origin: { kind: 'connection', connId: conn.id, ...origin } }); if (!r) throw new Error('not saved'); return r.id; };
    const A = await live('Live A', { table: 'wh_a' }), B = await live('Live B', { table: 'wh_b' });
    const Q = await live('Query', { sql: 'select * from wh_a join wh_b using (k)' }), Q0 = await live('Query two', { sql: 'select 1 as amt' });
    const enc = { category: 'k', values: [{ column: 'amt', aggregation: 'sum' }] };
    const visA = (await visualsStore.saveVisual(P, { name: 'By k A', datasetId: A, chartType: 'bar', encoding: enc, filters: [] } as never))!.id;
    await metricsStore.saveMetric(P, { name: 'Sum A', datasetId: A, definition: { column: 'amt', aggregation: 'sum' } });
    await metricsStore.saveMetric(P, { name: 'Sum B', datasetId: B, definition: { column: 'amt', aggregation: 'sum' } });
    const dash = (await analysisStore.saveAnalysis(P, { name: 'Board A', sheets: [{ name: 'One', cards: [{ type: 'visual', visualId: visA, layout: { x: 0, y: 0, w: 6, h: 6 } }] }] }))!.id;
    const csv = (await H.datasets.saveDataset(P, { name: 'A file', sourceKind: 'csv', columns: [{ name: 'a', type: 'text' }], rows: [['x']] }))!.id;
    const doc = await store.createSourceDoc(P, conn.id, 'wh_a', { owner: 'Data platform', refresh: 'Hourly', requiredFilters: 'day', guide: '# Filter on day' });
    if (!doc.ok) throw new Error(doc.error);
    return { P, C: conn.id, A, B, Q, Q0, csv, visA, dash, DA: doc.docId };
  });
  const { P, C, A, B, Q, Q0, csv, visA, dash, DA } = s;
  const copy = await post('dataset:copyLive', { projectId: P, datasetId: A });
  const copyOfA = String(copy.value?.dataset?.id ?? '');
  ok('setup: a copy of the Live view', copyOfA !== '', copy.body.slice(0, 200));

  const before = (await post('lineage:get', { projectId: P, type: 'dataset', id: A })).body;
  const n0 = fake.catalogCalls;
  const lin = async () => (await post('sourceTable:lineage', { projectId: P, connId: C, docId: DA })).value;
  const g = await lin();
  const ids: string[] = g.nodes.map((n: Reply) => n.id);
  ok('lineage: rooted at the table, its datasets and what is built on them', g.focus === `source:st:${C}:${DA}` && ids.includes(`dataset:${A}`) && ids.includes(`visual:${visA}`) && ids.includes(`dashboard:${dash}`), JSON.stringify(ids));
  ok('lineage: the other table\'s dataset is not shown', !ids.includes(`dataset:${B}`));
  ok('lineage: no node id holds a table name', ids.every((id) => !/wh_[ab]/.test(id)));
  ok('lineage: the table node names the table on its connection', g.nodes.find((n: Reply) => n.id === g.focus)?.name === 'wh_a' && g.nodes.find((n: Reply) => n.id === g.focus)?.sub === 'Warehouse' && typeof g.upstream === 'number');
  ok('lineage: a query with no link is not a child', !ids.includes(`dataset:${Q}`));
  const set = await post('dataset:setSourceTables', { projectId: P, datasetId: Q, tables: ['wh_a', 'wh_b'] });
  ok('setSourceTables: ok, the tables back', set.value.ok === true && set.value.tables.join() === 'wh_a,wh_b', set.body);
  ok('lineage: a linked query is a child of each table it names', (await lin()).nodes.some((n: Reply) => n.id === `dataset:${Q}`));
  ok('lineage:get is byte-identical after docs and links', (await post('lineage:get', { projectId: P, type: 'dataset', id: A })).body === before);
  ok('setSourceTables: a CSV dataset gets the sentence', (await post('dataset:setSourceTables', { projectId: P, datasetId: csv, tables: ['t'] })).value.error === 'Only a dataset built from a connection names its source tables.');
  ok('setSourceTables: 17 names refused at the door', (await post('dataset:setSourceTables', { projectId: P, datasetId: Q0, tables: Array(17).fill('t') })).status === 400);

  const fd = async (id: string) => (await post('sourceTable:forDataset', { projectId: P, datasetId: id })).value;
  const fa = await fd(A);
  ok('guide block: the doc\'s fields, with the connection', fa.ok === true && fa.linkable === true && fa.byQuery === false && ((b: Reply) => b.docId === DA && b.table === 'wh_a' && b.connName === 'Warehouse' && b.owner === 'Data platform' && b.refresh === 'Hourly' && b.requiredFilters === 'day' && b.guide === '# Filter on day')(fa.tables[0]), JSON.stringify(fa));
  ok('guide block: a Live view and its copy show one doc', (await fd(copyOfA)).tables[0].docId === DA);
  ok('guide block: a table with no doc has empty strings and no docId', ((b: Reply) => b.table === 'wh_b' && b.docId === undefined && b.guide === '' && b.owner === '')((await fd(B)).tables[0]));
  ok('guide block: a linked query shows its tables, byQuery', ((r: Reply) => r.byQuery === true && r.tables.map((t: Reply) => t.table).join() === 'wh_a,wh_b')(await fd(Q)));
  ok('guide block: a query with no link says so', ((r: Reply) => r.byQuery === true && r.linkable === true && r.tables.length === 0)(await fd(Q0)));
  ok('guide block: a file dataset is not linkable', (await fd(csv)).linkable === false);
  await H.as(ORG_A, () => store.updateSourceDoc(P, C, DA, (d) => ({ ...d, facts: { columns: [{ name: 'secretcol', type: 'int' }], primaryKey: { columns: ['k'], enforced: false }, partition: { columns: ['day'], method: 'RANGE' }, readAt: 'x', readBy: 'y' }, dismissed: { [A]: { table: 'AbCdEf012345' } } })));
  const withFacts = await post('sourceTable:forDataset', { projectId: P, datasetId: A });
  ok('guide block: the key and partition come with it; no columns, no dismissals, no SQL', withFacts.value.tables[0].primaryKey.columns[0] === 'k' && withFacts.value.tables[0].partition.columns[0] === 'day'
    && !/secretcol|dismissed|AbCdEf012345|select \*/.test(withFacts.body), withFacts.body);

  const c = (await post('dataset:sourceTableChoices', { projectId: P, datasetId: Q0 })).value;
  const n1 = fake.catalogCalls;
  ok('choices: one warehouse call, tables sorted', c.ok === true && n1 === n0 + 1 && Array.isArray(c.tables) && c.tables.includes('wh_a') && c.linked.length === 0, JSON.stringify(c));
  const cq = (await post('dataset:sourceTableChoices', { projectId: P, datasetId: Q })).value;
  ok('choices: the words of the query first, the linked ones come back', cq.tables.slice(0, 2).join() === 'wh_a,wh_b' && cq.linked.join() === 'wh_a,wh_b');
  ok('choices: a CSV dataset gets the sentence', (await post('dataset:sourceTableChoices', { projectId: P, datasetId: csv })).value.ok === false);

  const probe = await hydrates(A, async () => { await lin(); await fd(A); });
  ok('lineage and the guide block read no warehouse and hydrate nothing', !probe.hydrated && fake.catalogCalls === n1 + 1, String(fake.catalogCalls - n1));
  const contracts = api.contracts as unknown as Record<string, { access: string; project(i: unknown): unknown }>;
  const names = ['sourceTable:lineage', 'sourceTable:forDataset', 'dataset:setSourceTables', 'dataset:sourceTableChoices'];
  ok('contracts: all write, scoped by projectId', names.every((n) => contracts[n]?.access === 'write' && contracts[n].project({ projectId: P }) === P));
}

(async () => {
  pure();
  await linking();
  await channels();
  await close();
  finish();
})().catch((err: unknown) => { console.error(err); process.exit(1); });
