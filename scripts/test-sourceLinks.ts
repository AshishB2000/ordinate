// Source tables in the lineage, and the links between a dataset and its source tables (semantic layer
// part 2, PR 08; docs/semantic-layer/02-source-tables.md D9, D10, D11).
//
// 1. perTableGraph: the pure rewrite of one node per connection into one node per (connection, table).
//
//   npm run build:ts && node scripts/test-sourceLinks.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const { buildGraph, focus }: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');
const { perTableGraph, tableNodeId }: typeof import('../src/analysis/sourceLineage') = require('../src/analysis/sourceLineage');

const C = '0b9f3c2a-7d1e-4f5a-9c8d-1e2f3a4b5c6d';
const C2 = '0b9f3c2a-7d1e-4f5a-9c8d-1e2f3a4b5c6e';
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

pure();
finish();
