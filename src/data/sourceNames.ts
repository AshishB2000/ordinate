// Who may see a dataset's source names: its warehouse table, host, database, SQL and URL
// (docs/semantic-layer/02-source-tables.md, D13). The rule is "can open the connection":
// a project editor or admin does, a viewer does not. Every reply that carries a source name
// asks here, so the answer is one place. Fails closed: a role lookup that throws, or an id that is not a project id, is a viewer.

import { isValidId } from '../app/ids';
import { getConnector } from '../connectors';
import * as datasets from './datasets';
import type { Connection } from '../connectors/connections';
import { closedToCaller, restrictedOn } from './rowAccess';
import type { DatasetSummary } from './datasetSummary';

export async function seesSourceNames(projectId: string): Promise<boolean> {
  // restrictedOn answers "unrestricted" for an id that is not a project id: a bad id must not read names.
  return isValidId(projectId) && !(await restrictedOn(projectId).catch(() => true));
}

/** The project's datasets copied from a connection: a warehouse driver's error about one quotes the relation it could not find. */
export async function connectionDatasetIds(projectId: string): Promise<Set<string>> {
  return new Set((await datasets.listDatasets(projectId)).filter((d) => d.originConnId).map((d) => d.id));
}

/** …those whose refresh errors this caller may not read: none for one who sees source names, so an editor's reply is untouched. */
export async function unreadableErrorIds(projectId: string): Promise<Set<string>> {
  return (await seesSourceNames(projectId)) ? new Set() : connectionDatasetIds(projectId);
}

/**
 * Dataset summaries as this caller may read them (dataset:list, home:overview). Row or column rules: `scoped` says
 * the caller sees part of it (nothing about the rules leaves), and a failed refresh's text and the anomaly keys an
 * alert last told of, which can quote a value, are not theirs to read (N2, #16). A viewer never reads a warehouse
 * driver's refresh error either: it quotes the relation it could not find (D13). An editor's are untouched.
 */
export async function summariesFor<T extends DatasetSummary>(projectId: string, list: T[]): Promise<Array<T | Omit<T, 'lastRefreshError'> & { scoped?: true }>> {
  if (await seesSourceNames(projectId)) return list;
  return Promise.all(list.map(async (d) => {
    const { lastRefreshError: _e, ...rest } = d;
    if (!(await closedToCaller(projectId, d.id))) return d.originConnId ? rest : d;
    const auto = rest.autoRefresh ? (({ lastAnomalyKeys: _k, ...a }) => a)(rest.autoRefresh) : undefined;
    return { ...rest, ...(auto ? { autoRefresh: auto } : {}), scoped: true as const };
  }));
}

/** The name a caller who may not see source names reads for a connection. A blank-named connection is named after its database, host or URL, so a name that is or holds a hidden value of the connection (any case) reads as the connector's label; every reply that names a connection uses this. */
export function viewerName(c: Connection): string {
  const name = c.name.trim().toLowerCase();
  const hidden = [...Object.values(c.values), c.table, c.query, ...c.queries.map((q) => q.sql)].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return hidden.some((v) => name.includes(v.trim().toLowerCase())) ? (getConnector(c.connectorId)?.label ?? c.connectorId) : c.name;
}

/** What `connections:list` gives a caller who may not see source names: the card, never the address, selection, SQL, failure text or dates. A whitelist, so a field added to a connection stays hidden until it is listed here. */
export const viewerConnection = (c: Connection, datasetCount: number) => ({ id: c.id, name: viewerName(c), connectorId: c.connectorId, lastStatus: c.lastStatus, datasetCount });
