// Pipeline node ids as a BROWSER sees them (T2.6). A file or URL source's id is
// its origin — `source:file:/srv/exports/q3.csv`, `source:url:https://…?api_key=…`
// — and an origin never reaches a browser (the reason `dataset:meta` has no
// contract). On the server those two kinds go out as `source:file:#<16 hex>` /
// `source:url:#<16 hex>` (the kind kept for the card's icon, the rest a hash of
// the real id: stable, so a selection survives a reload) and are mapped
// back by looking the hash up in the project's graph. Every other id (a
// dataset's UUID, a connection's UUID, `publish`) says nothing and stays.
// The desktop is unchanged: none of this runs without a server.

import { createHash } from 'crypto';
import { serverDataDir } from '../server/context';
import { loadGraph } from './pipelineView';

const SECRET_KIND = /^source:(file|url):/;
const MASKED = /^source:(file|url):#[0-9a-f]{16}$/;

const onServer = (): boolean => serverDataDir() !== null;

/** The id a browser gets for `id`. */
export function maskNodeId(id: string): string {
  if (!onServer() || !SECRET_KIND.test(id)) return id;
  const kind = id.startsWith('source:file:') ? 'file' : 'url';
  return `source:${kind}:#` + createHash('sha256').update(id).digest('hex').slice(0, 16);
}

/** A record keyed by node id (the live map), re-keyed for a browser. */
export function maskKeys<T>(rec: Record<string, T>): Record<string, T> {
  return onServer() ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [maskNodeId(k), v])) : rec;
}

type Node = { id: string };
type Edge = { from: string; to: string };

/** A pipelines:get view with every id masked. */
export function maskView<V extends { nodes: Node[]; edges: Edge[] }>(view: V): V {
  if (!onServer()) return view;
  return {
    ...view,
    nodes: view.nodes.map((n) => ({ ...n, id: maskNodeId(n.id) })),
    edges: view.edges.map((e) => ({ from: maskNodeId(e.from), to: maskNodeId(e.to) })),
  };
}

/** A run reply's outcomes with their ids masked. */
export function maskOutcomes<O extends { nodeId: string; blockedBy?: string }>(outcomes: O[]): O[] {
  if (!onServer()) return outcomes;
  return outcomes.map((o) => ({ ...o, nodeId: maskNodeId(o.nodeId), ...(o.blockedBy ? { blockedBy: maskNodeId(o.blockedBy) } : {}) }));
}

/** The real id behind a browser's `id` — null when no node of this project hashes to it. */
export async function unmaskNodeId(projectId: string, id: string): Promise<string | null> {
  if (!onServer()) return id;
  // A file / URL id that is not a mask is refused: a browser never had a real one to send.
  if (!MASKED.test(id)) return SECRET_KIND.test(id) ? null : id;
  const g = await loadGraph(projectId);
  if ('error' in g) return null;
  const hit = g.graph.nodes.find((n) => maskNodeId(n.id) === id);
  return hit ? hit.id : null;
}
