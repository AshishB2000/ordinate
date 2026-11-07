// A dataset's suggested meanings, from its source tables' stored facts (docs/semantic-layer/02-source-tables.md,
// "never silent"). Two `write` channels, so a viewer never reaches a handler. `catalog:suggestions` reads records
// only: no warehouse call, no dataset hydrated, nothing written. `catalog:dismissSuggestion` stores a 12-character
// hash in the source doc's `dismissed[datasetId]`, never the text. Using one is the editor's own existing write
// (catalog:setColumn, catalog:set, catalog:setTable), so nothing here ever changes a dataset's docs.

import { ipcMain } from './bus';
import * as connections from '../connectors/connections';
import * as datasets from '../data/datasets';
import { docTablesOf, sourceTablesOf } from '../data/sourceTableOf';
import { getColumns, getDoc } from '../app/catalog';
import { getTableDoc } from '../app/tableDocs';
import { sourceDocGone } from '../app/sourceTableMessages';
import * as store from '../app/sourceTables';
import { suggestionsFor, type Suggestion, type SuggestionKind } from '../analysis/sourceSuggestions';

type Doc = Parameters<typeof suggestionsFor>[0]['docs'][number];

/** Each connection's index and each doc is read once per call, however many datasets use it. */
function reader(projectId: string) {
  const conns = new Map<string, Promise<Awaited<ReturnType<typeof connections.getConnection>>>>();
  const indexes = new Map<string, Promise<Map<string, string>>>();
  const docs = new Map<string, Promise<store.SourceTableDoc | undefined>>();
  const once = <T>(m: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> => {
    const had = m.get(key);
    if (had) return had;
    const p = make();
    m.set(key, p);
    return p;
  };
  return async (datasetId: string): Promise<Suggestion[]> => {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    const origin = meta?.origin;
    if (!meta || origin?.kind !== 'connection') return [];
    const conn = await once(conns, origin.connId, () => connections.getConnection(projectId, origin.connId));
    const index = await once(indexes, origin.connId, async () => new Map((await store.listSourceIndex(projectId, origin.connId)).map((e) => [e.table, e.docId])));
    const found: Doc[] = [];
    for (const table of docTablesOf(sourceTablesOf(origin, conn ?? undefined), [...index.keys()])) {
      const docId = index.get(table);
      if (!docId) continue;
      const doc = await once(docs, `${origin.connId}:${docId}`, async () => (await store.readSourceDoc(projectId, origin.connId, docId))?.rec);
      if (doc) found.push({ connId: origin.connId, docId, table, doc });
    }
    if (!found.length) return [];
    return suggestionsFor({
      datasetId, columns: meta.columns.map((c) => c.name), columnDocs: await getColumns(projectId, datasetId),
      description: (await getDoc(projectId, `dataset:${datasetId}`))?.description ?? '', key: (await getTableDoc(projectId, datasetId)).key, docs: found,
    });
  };
}

export function register(): void {
  ipcMain.handle('catalog:suggestions', async (_e, { projectId, datasetId }: { projectId: string; datasetId?: string }) => {
    const suggest = reader(projectId);
    const ids = datasetId ? [datasetId] : (await datasets.listDatasets(projectId)).filter((d) => d.originConnId !== undefined).map((d) => d.id);
    const suggestions: Suggestion[] = [];
    let withSome = 0;
    for (const id of ids) {
      const s = await suggest(id);
      if (s.length) withSome++;
      suggestions.push(...s);
    }
    return { ok: true, suggestions, total: suggestions.length, datasets: withSome };
  });

  ipcMain.handle('catalog:dismissSuggestion', async (_e, p: { projectId: string; datasetId: string; connId: string; docId: string; kind: SuggestionKind; column?: string; hash: string }) => {
    const saved = await store.updateSourceDoc(p.projectId, p.connId, p.docId, (d) => {
      const cur = d.dismissed?.[p.datasetId] ?? {};
      const next = p.kind === 'column' ? { ...cur, columns: { ...cur.columns, [p.column as string]: p.hash } } : { ...cur, [p.kind]: p.hash };
      return { ...d, dismissed: { ...d.dismissed, [p.datasetId]: next } };
    });
    return saved ? { ok: true } : { ok: false, error: sourceDocGone() };
  });
}
