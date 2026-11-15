// An ask's table facts (docs/assistant/00-design.md, step 3 "Table facts") — MAIN PROCESS ONLY.
//
// For each Live dataset the ask is about, the facts stored on its source tables' docs (src/app/sourceTables.ts),
// as a few lines (../ai/tableFactsBlock). The datasets are the ones the guidance reads (./guidance): the open dataset,
// a visual's dataset, Home's 12 step 3 picks (./homeFacts), or a topic's first 12. No whole-project list: the
// connections' indexes in one read, then the docs by id in one read, at most TABLES_MAX of them. Records only: never a
// warehouse call, a row or a secret. Who may read what is decided here: the table's name only for a caller who sees
// source names, no hidden column, no size for a caller row access rules restrict. Never throws: facts must never cost an answer.

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import * as visuals from '../analysis/visuals';
import { isLive } from '../data/liveDataset';
import { docTablesOf, sourceTablesOf } from '../data/sourceTableOf';
import { closedToCaller, hiddenColumnsFor } from '../data/rowAccess';
import { seesSourceNames } from '../data/sourceNames';
import { readSourceDocs, readSourceIndexes } from '../app/sourceTables';
import { tableFactsBlock, type TableFactsEntry } from '../ai/tableFactsBlock';
import type { LedgerEntry } from '../ai/numberAudit';
import { logger } from '../app/logger';
import { HOME_DATASETS, homeDatasets } from './homeFacts';
import { topicDatasets } from './guidance';

/** Source tables an ask reads the docs of: Home's 12 datasets with one table each, or a few with several. */
export const TABLES_MAX = 12;

const NONE = { text: '', ledger: [] as LedgerEntry[] };

/** The datasets the ask is about, as the guidance picks them, Live ones from a connection only. */
async function liveDatasets(projectId: string, context: { kind?: string; id?: string }, factsKind: string, question: string): Promise<DatasetMeta[]> {
  const id = typeof context.id === 'string' ? context.id : '';
  let metas: (DatasetMeta | null)[] = [];
  if (factsKind === 'project') {
    const topic = context.kind === 'topic' && id ? await topicDatasets(projectId, id) : null;
    metas = topic ? await Promise.all(topic.slice(0, HOME_DATASETS).map((d) => datasets.getDatasetMeta(projectId, d.id))) : (await homeDatasets(projectId, question)).slice(0, HOME_DATASETS);
  } else if (factsKind === 'dataset' && id) {
    metas = [await datasets.getDatasetMeta(projectId, id)];
  } else if (factsKind === 'visual' && id) {
    const v = await visuals.getVisual(projectId, id);
    metas = v ? [await datasets.getDatasetMeta(projectId, v.datasetId)] : [];
  }
  return metas.filter((m): m is DatasetMeta => !!m && isLive(m) && m.origin?.kind === 'connection');
}

/** The block for one `copilot:ask`, after the facts `buildFacts` built (`factsKind`: their provenance's kind). */
export async function askTableFacts(projectId: string, context: { kind?: string; id?: string }, factsKind: string, question: string, now = Date.now()): Promise<{ text: string; ledger: LedgerEntry[] }> {
  try {
    const live = await liveDatasets(projectId, context, factsKind, question);
    if (!live.length) return NONE;
    const connOf = (m: DatasetMeta): string => (m.origin?.kind === 'connection' ? m.origin.connId : '');
    const indexes = await readSourceIndexes(projectId, live.map(connOf));
    // A Live dataset names its table or its linked tables on its origin, so the connection's own saved table (the fallback
    // for a copy made before the workbench) is never needed: the connection is not read.
    const picks: { meta: DatasetMeta; connId: string; docId: string; nth: number; of: number }[] = [];
    for (const meta of live) {
      const index = indexes.get(connOf(meta)) ?? [];
      const byName = new Map(index.map((e) => [e.table, e.docId]));
      const docIds = docTablesOf(sourceTablesOf(meta.origin, undefined), [...byName.keys()]).flatMap((t) => (byName.has(t) ? [byName.get(t)!] : []));
      docIds.forEach((docId, i) => picks.push({ meta, connId: connOf(meta), docId, nth: i + 1, of: docIds.length }));
    }
    const kept = picks.slice(0, TABLES_MAX);
    if (!kept.length) return NONE;
    const docs = await readSourceDocs(projectId, kept);
    const withFacts = kept.flatMap((p) => {
      const doc = docs.get(`${p.connId}:${p.docId}`);
      return doc?.facts ? [{ ...p, doc, facts: doc.facts }] : [];
    });
    if (!withFacts.length) return NONE;
    const names = await seesSourceNames(projectId);
    const entries: TableFactsEntry[] = await Promise.all(withFacts.map(async (p) => ({
      table: p.doc.table, dataset: p.meta.name, nth: p.nth, of: p.of, names, facts: p.facts,
      hidden: await hiddenColumnsFor(projectId, p.meta.id),
      rows: !(await closedToCaller(projectId, p.meta.id)),
      notes: { requiredFilters: p.doc.requiredFilters, guide: p.doc.guide, refresh: p.doc.refresh },
    })));
    return tableFactsBlock(entries, now);
  } catch (err: unknown) {
    logger.error('[tableFacts] left out of the ask:', err instanceof Error ? err.message : err);
    return NONE;
  }
}
