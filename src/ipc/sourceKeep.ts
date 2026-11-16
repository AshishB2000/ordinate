// "Keep as a dataset" on an answer read straight from a source table (docs/assistant/00-design.md, "Asking needs no
// dataset; keeping makes one") — MAIN PROCESS ONLY.
//
// `answer:keepTable` (`write`, as `connection:import` is): the caller's own answer turn whose spec names a table
// (./sourceAnswers), the table's Live dataset made through the connection's own Live create (./liveDatasets
// createLiveDataset: its columns read from the warehouse's catalog, its first schema sync queued), and the turn's answer
// re-pointed at it, so Save as visual, Verify and Add to dashboard then work as on any dataset. The card is computed
// again on open, on the new dataset. A turn already kept (or never a table's) makes nothing: one click, one dataset.
// An SQL answer that read source tables (docs/live-data/01-live-sql.md F5, `sql.table`) keeps each the same way and
// re-points its datasets: its text is unchanged, since a kept table takes the names its view had, so Verify then saves
// the statement against the kept datasets. A table already kept (a Live dataset of the same connection and table the
// caller can open) is re-pointed at, never made twice: by a second turn, a chart turn, or Explore.
// `explore:keepTable` (`write`) is the same make for the table Explore is on, with no turn to re-point.

import { ipcMain } from './bus';
import * as copilot from '../ai/copilot';
import * as datasets from '../data/datasets';
import * as sqlDatasets from '../engine/sqlDatasets';
import type { SqlTurn } from '../ai/answerSql';
import { sourceView } from './sourceAnswers';
import { seesSourceNames } from '../data/sourceNames';
import { liveDatasetMissing } from '../engine/liveQueryMessages';
import { createLiveDataset } from './liveDatasets';
import { answerNotThere } from '../ai/answerSnapshotMessages';
import { notFromTable } from '../ai/sourceAnswerMessages';
import { turnsForBrowser } from './answerSnapshots';
import { LIVE_NOTE } from './liveAnswers';

/**
 * A Live dataset the caller can open over the same connection and table: its origin's table, no defining query, no base
 * filter to narrow it, no semantic layer. `named`: only one the gate names as the table's view was named (an SQL turn's
 * text reads the table by that slug, F5), so the kept text still reads it. Records only.
 */
async function keptAlready(projectId: string, connId: string, table: string, named: boolean): Promise<string | null> {
  const names = named ? await sqlDatasets.projectNames(projectId) : [];
  for (const s of await datasets.listDatasets(projectId)) { // only datasets the caller can open (folders)
    if (s.mode !== 'live' || s.originConnId !== connId) continue;
    const m = await datasets.getDatasetMeta(projectId, s.id);
    const o = m?.origin;
    if (!m?.live || o?.kind !== 'connection' || o.sql || o.table !== table || m.live.semantic || m.live.baseFilters?.length) continue;
    if (named && names.find((e) => e.id === m.id)?.slug !== sqlDatasets.slugify(table)) continue;
    return m.id;
  }
  return null;
}

/**
 * The table's Live dataset: one already kept (`keptAlready`), else made through the connection's own Live create; or why
 * not. Never a viewer's, even one given the table (E8, F6). Add to dashboard keeps a table's answer through it too (./answerDashboard).
 */
export async function keepView(projectId: string, connId: string, docId: string, named = false): Promise<{ ok: true; datasetId: string } | { ok: false; reason: string; needs?: 'copy' }> {
  if (!(await seesSourceNames(projectId))) return { ok: false, reason: liveDatasetMissing() }; // the route's `write` refuses them first
  const v = await sourceView(projectId, connId, docId);
  if (!v.ok) return v;
  const kept = await keptAlready(projectId, v.table.connId, v.table.table, named);
  if (kept) return { ok: true, datasetId: kept };
  const made = await createLiveDataset({ projectId, connId: v.table.connId, table: v.table.table, name: v.table.table });
  if (!made.ok || !('dataset' in made) || !made.dataset) return { ok: false, reason: ('error' in made && made.error) || notFromTable() };
  return { ok: true, datasetId: made.dataset.id };
}

export async function keepTable(projectId: string, threadId: string, turnId: string): Promise<Record<string, unknown>> {
  const turn = await copilot.findTurn(projectId, threadId, turnId);
  if (turn?.sql) return keepSql(projectId, threadId, turnId, turn.sql);
  if (!turn || !turn.answer) return { ok: false, reason: answerNotThere() };
  const spec = turn.answer;
  if (!spec.table) return { ok: false, reason: notFromTable() };
  const made = await keepView(projectId, spec.table, spec.datasetId);
  if (!made.ok) return made;
  const { table: _t, ...rest } = spec;
  const kept = { ...rest, datasetId: made.datasetId };
  if (!(await copilot.replaceAnswer(projectId, threadId, turnId, spec, kept, LIVE_NOTE))) return { ok: false, reason: answerNotThere() };
  return { ok: true, datasetId: made.datasetId, turns: await turnsForBrowser(projectId, await copilot.loadHistory(projectId, threadId)) };
}

/** An SQL answer's source tables (its ids that are no dataset), each kept as a Live dataset, and the turn re-pointed at them. */
async function keepSql(projectId: string, threadId: string, turnId: string, sql: SqlTurn): Promise<Record<string, unknown>> {
  if (!sql.table) return { ok: false, reason: notFromTable() };
  const ids = [...sql.datasetIds];
  // shortcut: a keep that fails after another table was kept leaves that dataset made and the turn as it was; a second
  // click makes it again. Upgrade if answers read several tables often.
  for (const [i, id] of ids.entries()) {
    if (await datasets.getDatasetMeta(projectId, id)) continue; // a Live dataset beside the table: already one
    const made = await keepView(projectId, sql.table, id, true);
    if (!made.ok) return made;
    ids[i] = made.datasetId;
  }
  const { table: _t, ...rest } = sql;
  if (!(await copilot.replaceAnswer(projectId, threadId, turnId, { sql: sql.text }, { ...rest, datasetIds: ids }))) return { ok: false, reason: answerNotThere() };
  return { ok: true, datasetId: ids.find((x) => !sql.datasetIds.includes(x)), turns: await turnsForBrowser(projectId, await copilot.loadHistory(projectId, threadId)) };
}

export function register(): void {
  ipcMain.handle('answer:keepTable', async (_e, { projectId, threadId, turnId }: Record<string, unknown> = {}) => {
    try {
      return await keepTable(String(projectId ?? ''), String(threadId ?? ''), String(turnId ?? ''));
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : notFromTable() };
    }
  });
  // Explore's Keep as a dataset (phase D): the table it is exploring (`table` its connection, `datasetId` its doc) made a
  // Live dataset, which Explore then opens. One click, one dataset: the page leaves the table for it.
  ipcMain.handle('explore:keepTable', async (_e, { projectId, datasetId, table }: Record<string, unknown> = {}) => {
    const made = await keepView(String(projectId ?? ''), String(table ?? ''), String(datasetId ?? ''));
    return made.ok ? made : { ok: false, error: made.reason, ...(made.needs ? { needs: made.needs } : {}) };
  });
}
