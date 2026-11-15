// Answers straight from a source table, no dataset (docs/assistant/00-design.md, outcome C, "Asking needs no dataset;
// keeping makes one") — MAIN PROCESS ONLY.
//
// An editor's question from Home also searches the documented tables of the project's connections (step 3's index,
// in the same query as the datasets: ./homeFacts `picksFrom`), and the best few go in the prompt with their columns,
// typed from the table's stored facts as a Live dataset's are declared (../data/liveSchema). An answer that names one
// carries `table` (its connection's id) beside `datasetId` (the table doc's id), and every door that draws it runs
// inside that table's Live VIEW (../data/sourceView): a DatasetMeta built here in memory, never written, so the figure
// takes the Live dataset's own path (liveCardFor → liveAnswer → liveTarget → warehouse(): bind parameters, the
// budget, the orgKey cache keyed on the facts' read time, the required date range, no JS fallback).
//
// Who: editors and admins only (`seesSourceNames`, p2-01). A viewer gets no table, no name and no fact here until
// teams are given tables (team folders E8); a spec naming one is answered as a dataset that does not exist. A table on a
// connection that is not asked live (`isLiveOffered`) is offered marked "copy first", and an answer naming it is
// refused with `needs: 'copy'` (the reason Ask an editor carries).

import * as connections from '../connectors/connections';
import type { Connection } from '../connectors/connections';
import { getConnector } from '../connectors';
import { readSourceDocs, type SourceTableDoc } from '../app/sourceTables';
import { seesSourceNames } from '../data/sourceNames';
import { liveColumns } from '../data/liveSchema';
import { DEFAULT_MAX_CACHE_AGE_SEC, newLiveSettings } from '../data/liveDataset';
import { isSourceView, withSourceViews } from '../data/sourceView';
import type { DatasetMeta } from '../data/datasets';
import { liveOfferRefusal } from './liveOptIn';
import { homePicks } from './homeFacts';
import { liveDatasetMissing } from '../engine/liveQueryMessages';
import { liveConnectionGoneMessage, liveDuplicateColumnMessage, liveNoColumnsMessage } from '../data/liveMessages';
import { sourceTablesBlock } from '../ai/sourceTablesBlock';
import type { AnswerSpec, SpecDataset } from '../ai/answerSpec';
import type { LedgerEntry } from '../ai/numberAudit';
import * as say from '../ai/sourceAnswerMessages';
import { logger } from '../app/logger';

/** A documented table an editor may be answered from: its view when its connection is asked live, else null (copy first). */
export interface SourceTable {
  connId: string;
  docId: string;
  table: string;
  connection: string;
  view: DatasetMeta | null;
  columns: { name: string; type: string }[];
}

export type SourceRefusal = { ok: false; reason: string; needs?: 'copy' };

/** A table doc and its connection → the table, or why it cannot be answered from. Records only: no warehouse call. */
function tableOf(projectId: string, connId: string, docId: string, doc: SourceTableDoc, conn: Connection | null): SourceTable | SourceRefusal {
  const facts = doc.facts;
  if (!conn) return { ok: false, reason: liveConnectionGoneMessage() };
  if (!facts || !facts.columns.length) return { ok: false, reason: say.tableNotRead(doc.table) };
  const def = getConnector(conn.connectorId);
  const base = { connId, docId, table: doc.table, connection: conn.name };
  if (!def?.live || liveOfferRefusal(def, conn.values)) return { ...base, view: null, columns: facts.columns.map((c) => ({ name: c.name, type: c.type })) };
  const typed = liveColumns(def.live.dialect, facts.columns);
  if (!typed.ok) return { ok: false, reason: typed.reason === 'duplicate' ? liveDuplicateColumnMessage(typed.name) : liveNoColumnsMessage() };
  const columns = typed.columns.map((c) => ({ name: c.name, type: c.type }));
  // The facts' read time is the view's "schema sync": a re-read moves its cache key, as a sync moves a dataset's.
  const view: DatasetMeta = {
    id: docId, projectId, name: doc.table, sourceKind: 'postgres', columns, rowCount: 0, createdAt: facts.readAt, updatedAt: facts.readAt,
    schemaVersion: 3, steps: [], resident: false, mode: 'live', origin: { kind: 'connection', connId, table: doc.table },
    live: { ...newLiveSettings(DEFAULT_MAX_CACHE_AGE_SEC, facts.readAt), profile: { columns: typed.columns.map((c) => ({ name: c.name, sourceType: c.sourceType })) } },
  };
  return { ...base, view, columns };
}

/** The tables `refs` name that may be answered from (docs in one read, each connection once), in order. The caller checked the role. */
async function tablesOf(projectId: string, refs: readonly { connId: string; docId: string }[]): Promise<SourceTable[]> {
  if (!refs.length) return [];
  const docs = await readSourceDocs(projectId, refs);
  const conns = new Map<string, Promise<Connection | null>>();
  const out: SourceTable[] = [];
  for (const r of refs) {
    const doc = docs.get(`${r.connId}:${r.docId}`);
    if (!conns.has(r.connId)) conns.set(r.connId, connections.getConnection(projectId, r.connId));
    const t = doc ? tableOf(projectId, r.connId, r.docId, doc, await conns.get(r.connId)!) : null;
    if (t && !('ok' in t)) out.push(t);
  }
  return out;
}

/** One table's view for a spec that names it, or why not: a viewer is told what any missing dataset tells. */
export async function sourceView(projectId: string, connId: string, docId: string): Promise<{ ok: true; table: SourceTable & { view: DatasetMeta } } | SourceRefusal> {
  if (!(await seesSourceNames(projectId))) return { ok: false, reason: liveDatasetMissing() };
  const doc = (await readSourceDocs(projectId, [{ connId, docId }])).get(`${connId}:${docId}`);
  if (!doc) return { ok: false, reason: liveDatasetMissing() };
  const t = tableOf(projectId, connId, docId, doc, await connections.getConnection(projectId, connId));
  if ('ok' in t) return t;
  return t.view ? { ok: true, table: { ...t, view: t.view } } : { ok: false, reason: say.copyFirst(t.table), needs: 'copy' };
}

/**
 * `fn` inside the view `spec` names (`spec.table`), or `fn` as it is for any other spec. `strict`: a table that cannot be
 * answered from is its refusal; otherwise `fn` runs outside any view, where the id is no dataset (the figures stay put).
 */
export async function inSourceTable<T>(projectId: string, spec: Pick<AnswerSpec, 'datasetId' | 'table'> | undefined, fn: () => Promise<T>, strict: true): Promise<T | SourceRefusal>;
export async function inSourceTable<T>(projectId: string, spec: Pick<AnswerSpec, 'datasetId' | 'table'> | undefined, fn: () => Promise<T>): Promise<T>;
export async function inSourceTable<T>(projectId: string, spec: Pick<AnswerSpec, 'datasetId' | 'table'> | undefined, fn: () => Promise<T>, strict = false): Promise<T | SourceRefusal> {
  if (!spec?.table || isSourceView(projectId, spec.datasetId)) return fn();
  const v = await sourceView(projectId, spec.table, spec.datasetId);
  if (v.ok) return withSourceViews(projectId, [v.table.view], fn);
  return strict ? v : fn();
}

/** The tables an editor's Home question offers (./homeFacts `homePicks`, once per ask). None for anything else. */
async function homeTables(projectId: string, context: { kind?: string } | undefined, question: string): Promise<SourceTable[]> {
  if (context?.kind || !(await seesSourceNames(projectId))) return []; // a viewer's ask reads nothing more
  return tablesOf(projectId, (await homePicks(projectId, question)).tables);
}

const NONE = { text: '', ledger: [] as LedgerEntry[] };

/** The SOURCE TABLES block of an editor's Home question (../ai/sourceTablesBlock). Never throws: tables must never cost an answer. */
export async function askSourceTables(projectId: string, context: { kind?: string }, question: string): Promise<{ text: string; ledger: LedgerEntry[] }> {
  try {
    const tables = await homeTables(projectId, context, question);
    return tables.length ? sourceTablesBlock(tables.map((t) => ({ table: t.table, connection: t.connection, live: !!t.view, columns: t.columns }))) : NONE;
  } catch (err: unknown) {
    logger.error('[sourceTables] left out of the ask:', err instanceof Error ? err.message : err);
    return NONE;
  }
}

/** What an answer's spec may name beyond the datasets: the ask's tables, and the table the answer it continues was read from. */
export async function sourceVocabulary(projectId: string, context: { kind?: string } | undefined, question: string, previous?: AnswerSpec): Promise<SourceTable[]> {
  const tables: SourceTable[] = await homeTables(projectId, context, question).catch(() => []);
  if (previous?.table && !tables.some((t) => t.docId === previous.datasetId)) {
    const v = await sourceView(projectId, previous.table, previous.datasetId);
    if (v.ok) tables.push(v.table);
  }
  return tables;
}

/** The views as the validator reads a dataset. */
export const viewDatasets = (tables: readonly SourceTable[]): SpecDataset[] =>
  tables.flatMap((t) => (t.view ? [{ id: t.docId, name: t.table, columns: t.view.columns }] : []));

/** An answer naming a table that must be copied first: its refusal (`needs: 'copy'`), before any validation. */
export function copyRefusal(tables: readonly SourceTable[], raw: unknown): SourceRefusal | null {
  const said = raw && typeof raw === 'object' ? (raw as { dataset?: unknown }).dataset : undefined;
  const t = typeof said === 'string' ? tables.find((x) => !x.view && x.table.trim().toLowerCase() === said.trim().toLowerCase()) : undefined;
  return t ? { ok: false, reason: say.copyFirst(t.table), needs: 'copy' } : null;
}

/** A validated spec on a view, with the table it is read from; any other spec as it is. */
export function withTable(spec: AnswerSpec, tables: readonly SourceTable[]): AnswerSpec {
  const t = tables.find((x) => x.view && x.docId === spec.datasetId);
  return t ? { ...spec, table: t.connId } : spec;
}
