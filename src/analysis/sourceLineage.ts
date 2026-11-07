// Per-table lineage (docs/semantic-layer/02-source-tables.md, D10): the graph `buildGraph` draws has one
// source node per connection; here each `source:conn → dataset` edge becomes one edge per linked table.
// Beside `buildGraph`, never inside it, so `lineage:get` is untouched. Pure: no record is read.
// A node id never holds a table name: `source:st:<connId>:<docId>`, or `source:st:<connId>:u<n>` for an
// undocumented table, where n is its index among that connection's linked undocumented names, sorted.

import type { LineageGraph, LineageNode } from './lineage';

export interface TableLink { connId: string; table: string; docId?: string }

export const tableNodeId = (connId: string, docId: string | undefined, undocumentedIndex: number): string =>
  `source:st:${connId}:${docId ?? 'u' + undocumentedIndex}`;

/** Each `source:conn:<connId> → dataset:<id>` edge becomes one edge per linked table; a connection node left with no edge goes. */
export function perTableGraph(g: LineageGraph, links: ReadonlyMap<string, TableLink[]>, connName: (connId: string) => string): LineageGraph {
  const undocumented = new Map<string, string[]>();
  for (const list of links.values()) for (const l of list) {
    if (l.docId === undefined && !undocumented.get(l.connId)?.includes(l.table)) undocumented.set(l.connId, [...(undocumented.get(l.connId) ?? []), l.table]);
  }
  for (const names of undocumented.values()) names.sort((a, b) => a.localeCompare(b));
  const idOf = (l: TableLink): string => tableNodeId(l.connId, l.docId, undocumented.get(l.connId)?.indexOf(l.table) ?? 0);

  const tables = new Map<string, LineageNode>();
  const edges: LineageGraph['edges'] = [];
  for (const e of g.edges) {
    const m = /^source:conn:(.+)$/.exec(e.from);
    const mine = m && e.to.startsWith('dataset:') ? (links.get(e.to.slice('dataset:'.length)) ?? []).filter((l) => l.connId === m[1]) : [];
    if (!mine.length) { edges.push(e); continue; }
    for (const l of mine) {
      const id = idOf(l);
      if (!tables.has(id)) tables.set(id, { id, kind: 'source', name: l.table, sub: connName(l.connId) });
      edges.push({ from: id, to: e.to });
    }
  }
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  return { nodes: [...tables.values(), ...g.nodes.filter((n) => !n.id.startsWith('source:conn:') || used.has(n.id))], edges };
}
