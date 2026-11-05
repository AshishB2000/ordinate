// Source tables in the lineage, and the links between a dataset and its source tables (semantic layer
// part 2, PR 08; docs/semantic-layer/02-source-tables.md D9, D10, D11).
//
// 1. perTableGraph: the pure rewrite of one node per connection into one node per (connection, table).
// 2. linking: what `setReadsTables` writes (a label, no refresh or Live change) and how `choiceOrder` sorts.
// 3. the channels (added with them).
//
//   npm run build:ts && node scripts/test-sourceLinks.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, post } from './liveRouteHarness';

const { buildGraph, focus }: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');
const { perTableGraph, tableNodeId }: typeof import('../src/analysis/sourceLineage') = require('../src/analysis/sourceLineage');

const C = '0b9f3c2a-7d1e-4f5a-9c8d-1e2f3a4b5c6d';
const C2 = '0b9f3c2a-7d1e-4f5a-9c8d-1e2f3a4b5c6e';
const { selectionForDataset }: typeof import('../src/ipc/connections') = require('../src/ipc/connections');
const { liveSourceOf }: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
const { getConnector }: typeof import('../src/connectors/index') = require('../src/connectors/index');
const { setReadsTables, choiceOrder }: typeof import('../src/data/datasetSourceTables') = require('../src/data/datasetSourceTables');

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

(async () => {
  pure();
  await linking();
  await close();
  finish();
})().catch((err: unknown) => { console.error(err); process.exit(1); });
