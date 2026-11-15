// Follow the links (docs/assistant/00-design.md, step 3 "Follow the links") — MAIN PROCESS ONLY.
//
// For the datasets an ask's facts hold (./askTableFacts askDatasets), the datasets linked to them in Relationships, up to
// LINK_HOPS links away and at most LINKED_MAX in all: the nearest first, then in the facts' order.
//
// THE DIRECTION RULE: a link is followed only from its many side to its one side (`many_to_one`, from → to) or across a
// one-to-one, the walk the chart planner takes (../analysis/joinPlan `reachable`), so no row of the dataset it starts
// from can repeat: never one → many, never across a link whose one side was found to repeat (`warning.repeats`), and
// never a cardinality this release does not know (Relationships store no many-to-many).
//
// Reads: relationships.json (one record), then every dataset within two links in one query (../app/recordTexts); never a
// list. A dataset is added only when no row access rule restricts the caller on it (`closedToCaller`, rows only) and they
// see a column of it; its hidden columns are left out, and a link through a hidden column, or through a dataset that is
// not added, is not followed. Metadata only, never a row. Never throws: facts must never cost an answer.

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import type { ParsedColumn } from '../data/parse';
import { datasetFilePath } from '../data/datasetRecord';
import { CARDINALITIES, listRelationships, type Relationship } from '../analysis/relationships';
import { reachable, type Hop } from '../analysis/joinPlan';
import { closedToCaller, hiddenColumnsFor } from '../data/rowAccess';
import { dropHidden } from '../ai/hiddenFacts';
import { assistantColumnDocs } from '../app/sharePolicy';
import { readTexts } from '../app/recordTexts';
import { linkedBlock, type LinkedEntry } from '../ai/linkedFacts';
import { resolveColumn } from '../ai/answerSpec';
import type { LedgerEntry } from '../ai/numberAudit';
import { logger } from '../app/logger';
import { perAsk } from './askMemo';

/** Linked datasets one ask adds, in all. */
export const LINKED_MAX = 6;
/** Links walked from a dataset of the facts. */
export const LINK_HOPS = 2;

export interface LinkPath { id: string; base: string; hops: Hop[] }

/** PURE. The datasets `rels` link `bases` to under the direction rule, nearest first, then in the bases' order; never a base. */
export function linkPaths(bases: readonly string[], rels: Relationship[]): LinkPath[] {
  const walkable = rels.filter((r) => CARDINALITIES.includes(r.cardinality) && r.warning?.kind !== 'repeats');
  const found = bases.flatMap((base) => [...reachable(base, walkable)].map(([id, hops]) => ({ id, base, hops })))
    .filter((p) => p.hops.length <= LINK_HOPS && !bases.includes(p.id))
    .sort((a, b) => a.hops.length - b.hops.length); // stable: the bases' order within a distance
  return found.filter((p, i) => found.findIndex((q) => q.id === p.id) === i);
}

/** `columns`: the ones the caller sees. */
export interface Linked { meta: DatasetMeta; columns: ParsedColumn[]; entry: LinkedEntry }

async function follow(projectId: string, bases: readonly string[]): Promise<Linked[]> {
  if (!bases.length) return [];
  const rels = await listRelationships(projectId);
  const near = rels.length ? linkPaths(bases, rels) : [];
  if (!near.length) return [];
  const ids = [...new Set([...bases, ...near.map((p) => p.id)])];
  const textOf = await readTexts(ids.map((id) => datasetFilePath(projectId, id)));
  const metas = new Map<string, DatasetMeta>();
  for (const id of ids) {
    const m = await datasets.getDatasetMeta(projectId, id, false, textOf(datasetFilePath(projectId, id)));
    if (m) metas.set(id, m);
  }
  // Only links whose two datasets and two columns still exist (./relationships `live`), walked again: every dataset within
  // two of them was read above, since dropping links never brings one nearer.
  const has = (e: { datasetId: string; column: string }): boolean => !!metas.get(e.datasetId)?.columns.some((c) => c.name === e.column);
  const paths = linkPaths(bases, rels.filter((r) => has(r.from) && has(r.to)));
  const hidden = new Map<string, ReadonlySet<string>>();
  const hiddenOf = async (id: string): Promise<ReadonlySet<string>> => {
    if (!hidden.has(id)) hidden.set(id, await hiddenColumnsFor(projectId, id));
    return hidden.get(id)!;
  };
  const opens = async (id: string): Promise<boolean> =>
    !(await closedToCaller(projectId, id, { rowsOnly: true })) && dropHidden(metas.get(id)!.columns, await hiddenOf(id)).length > 0;
  const shows = async (e: { datasetId: string; column: string }): Promise<boolean> => !(await hiddenOf(e.datasetId)).has(e.column);
  const nameOf = (id: string): string => metas.get(id)!.name;
  const out: Linked[] = [];
  for (const p of paths) {
    if (out.length >= LINKED_MAX) break;
    let fine = true;
    for (const h of p.hops) fine = fine && (await opens(h.to.datasetId)) && (await shows(h.from)) && (await shows(h.to));
    if (!fine) continue;
    const meta = metas.get(p.id)!;
    const columns = dropHidden(meta.columns, await hiddenOf(p.id));
    const hops = p.hops.map((h) => ({ from: { dataset: nameOf(h.from.datasetId), column: h.from.column }, to: { dataset: nameOf(h.to.datasetId), column: h.to.column } }));
    out.push({ meta, columns, entry: { schema: { name: meta.name, columns, docs: await assistantColumnDocs(projectId, p.id) }, base: nameOf(p.base), hops } });
  }
  return out;
}

/** The datasets linked to `bases` the caller may be told of, once per ask. Never throws. */
export async function linkedDatasets(projectId: string, bases: readonly string[]): Promise<Linked[]> {
  try {
    return await perAsk(`linked\0${projectId}\0${bases.join()}`, () => follow(projectId, bases));
  } catch (err: unknown) {
    logger.error('[links] left out of the ask:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** The LINKED DATASETS block for one ask (../ai/linkedFacts), and the linked datasets (their table facts follow, ./askTableFacts). */
export async function askLinkedFacts(projectId: string, about: readonly DatasetMeta[]): Promise<{ text: string; ledger: LedgerEntry[]; metas: DatasetMeta[] }> {
  const linked = await linkedDatasets(projectId, about.map((m) => m.id));
  return { ...linkedBlock(linked.map((l) => l.entry)), metas: linked.map((l) => l.meta) };
}

/**
 * The linked dataset that has the column a model's answer said on `datasetId`, bare or as "Customers.region", or null:
 * the chart form reads one dataset, so it is refused with that (../ai/answerMessages linkedColumnRefused).
 */
export async function linkedColumnOf(projectId: string, datasetId: string, said: unknown): Promise<{ dataset: string; column: string } | null> {
  if (typeof said !== 'string' || !said.trim()) return null;
  for (const { meta, columns } of await linkedDatasets(projectId, [datasetId])) {
    const s = said.trim();
    const col = resolveColumn(s.toLowerCase().startsWith(meta.name.toLowerCase() + '.') ? s.slice(meta.name.length + 1) : s, columns);
    if (col) return { dataset: meta.name, column: col.name };
  }
  return null;
}
