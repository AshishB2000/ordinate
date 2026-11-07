// A source table in the lineage, and a dataset's links to its source tables (docs/semantic-layer/
// 02-source-tables.md, D9 to D11). Four `write` channels, so a viewer never reaches a handler. Records
// only, except `dataset:sourceTableChoices`, which lists the connection's tables on a click. The SQL of a
// dataset never leaves: a reply names tables and notes, never `origin.sql`.

import { ipcMain } from './bus';
import * as connections from '../connectors/connections';
import * as connectionRun from '../connectors/connectionRun';
import { getConnector } from '../connectors';
import { buildGraph, focus } from '../analysis/lineage';
import { perTableGraph, tableNodeId, type TableLink } from '../analysis/sourceLineage';
import { loadInput, redactSources } from './lineage';
import { loadSecrets } from './connectionSecrets';
import * as datasets from '../data/datasets';
import { sourceTablesOf } from '../data/sourceTableOf';
import { choiceOrder, setReadsTables } from '../data/datasetSourceTables';
import { connectionGone, notLinkable, sourceDocGone } from '../app/sourceTableMessages';
import { usedTables } from '../app/sourceTableList';
import * as store from '../app/sourceTables';

/** What the Guide block shows of one source table (never the columns, the dismissals or the SQL). */
interface SourceBlock {
  connId: string; connName: string; table: string; docId?: string;
  owner: string; refresh: string; requiredFilters: string; guide: string;
  primaryKey?: { columns: string[]; enforced: boolean };
  partition?: { columns: string[]; method?: string; required?: boolean };
  updatedBy?: string; updatedAt?: string;
}

export function register(): void {
  ipcMain.handle('sourceTable:lineage', async (_e, { projectId, connId, docId }: { projectId: string; connId: string; docId: string }) => {
    const conns = await connections.listConnections(projectId);
    if (!conns.some((c) => c.id === connId) || !(await store.listSourceIndex(projectId, connId)).some((e) => e.docId === docId)) return { ok: false, error: sourceDocGone() };
    const used = await usedTables(projectId, conns);
    const links = new Map<string, TableLink[]>();
    for (const c of conns) {
      const docs = new Map((await store.listSourceIndex(projectId, c.id)).map((e) => [e.table, e.docId]));
      for (const [table, list] of used.get(c.id) ?? []) for (const d of list) links.set(d.id, [...(links.get(d.id) ?? []), { connId: c.id, table, docId: docs.get(table) }]);
    }
    const name = new Map(conns.map((c) => [c.id, c.name]));
    const g = redactSources(focus(perTableGraph(buildGraph(await loadInput(projectId)), links, (id) => name.get(id) ?? ''), tableNodeId(connId, docId, 0)));
    const at = g.nodes.find((n) => n.id === g.focus)?.col ?? 0;
    return { ok: true, ...g, upstream: g.nodes.filter((n) => (n.col ?? 0) < at).length };
  });

  ipcMain.handle('sourceTable:forDataset', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    const origin = meta?.origin;
    if (origin?.kind !== 'connection') return { ok: true, linkable: false, byQuery: false, tables: [] };
    const conn = await connections.getConnection(projectId, origin.connId);
    const index = new Map((await store.listSourceIndex(projectId, origin.connId)).map((e) => [e.table, e.docId]));
    const tables: SourceBlock[] = [];
    for (const table of sourceTablesOf(origin, conn ?? undefined).slice(0, 16)) {
      const docId = index.get(table);
      const rec = docId ? (await store.readSourceDoc(projectId, origin.connId, docId))?.rec : undefined;
      tables.push({
        connId: origin.connId, connName: conn?.name ?? '', table, ...(rec ? { docId } : {}),
        owner: rec?.owner ?? '', refresh: rec?.refresh ?? '', requiredFilters: rec?.requiredFilters ?? '', guide: rec?.guide ?? '',
        ...(rec?.facts?.primaryKey ? { primaryKey: rec.facts.primaryKey } : {}), ...(rec?.facts?.partition ? { partition: rec.facts.partition } : {}),
        ...(rec ? { updatedBy: rec.updatedBy, updatedAt: rec.updatedAt } : {}),
      });
    }
    return { ok: true, linkable: true, byQuery: !!origin.sql, tables };
  });

  ipcMain.handle('dataset:setSourceTables', async (_e, { projectId, datasetId, tables }: { projectId: string; datasetId: string; tables: string[] }) => {
    const kept = await setReadsTables(projectId, datasetId, tables);
    return kept ? { ok: true, tables: kept } : { ok: false, error: notLinkable() };
  });

  ipcMain.handle('dataset:sourceTableChoices', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => {
    try {
      const origin = (await datasets.getDatasetMeta(projectId, datasetId))?.origin;
      if (origin?.kind !== 'connection') return { ok: false, error: notLinkable() };
      const conn = await connections.getConnection(projectId, origin.connId);
      if (!conn) return { ok: false, error: connectionGone() };
      const res = await connectionRun.listTables(conn.connectorId, conn.values, await loadSecrets(conn.id, getConnector(conn.connectorId)));
      if (!res.ok) return { ok: false, error: res.error };
      // schema.name, as a doc, a table import and the web's `qualify` name it, so a link meets its doc
      return { ok: true, tables: choiceOrder(res.tables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name)), origin.sql ?? ''), linked: sourceTablesOf(origin, conn) };
    } catch {
      return { ok: false, error: connectionGone() };
    }
  });
}
