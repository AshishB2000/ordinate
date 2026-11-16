// Verified SQL questions (docs/assistant/00-design.md, "The SQL lane") — MAIN PROCESS. An editor's Verify on an SQL
// answer keeps its statement as a verified question (../analysis/verifiedRules `VerifiedSqlQuestion`): no figure,
// only the SQL and the datasets it reads. Here: whether one still runs (`sqlProblem`), the save, the Verified page's
// rows, and step 2's answer when it is asked word for word (`verifiedSqlAsk`), which runs the SQL again
// through the Query tab's gate for whoever asks, under their access: a viewer under row rules gets the gate's refusal.
// Over Live datasets (docs/live-data/01-live-sql.md, F4) it is phase F's path instead (./answerSql `runAnswerSql`):
// translated again for the asker and printed under THEIR lock, so two entitlements are two statements, each cached
// under its own key, and the Verified page's check translates without a warehouse call (`liveSqlProblem`).

import { randomUUID } from 'crypto';
import * as copilot from '../ai/copilot';
import * as datasets from '../data/datasets';
import * as sqlDatasets from '../engine/sqlDatasets';
import { closedToCaller } from '../data/rowAccess';
import { isLive } from '../data/liveDataset';
import * as lmsg from '../engine/liveSqlMessages';
import { osUser } from '../app/catalog';
import type { SqlTurn } from '../ai/answerSql';
import * as msg from '../ai/answerSqlMessages';
import * as vmsg from '../analysis/verifiedMessages';
import { keyClash, questionKey, sanitizeVerifiedSql, type VerifiedSqlQuestion } from '../analysis/verifiedRules';
import { listBoth, lockedKeys, writeVerifiedSql } from '../analysis/verifiedQuestions';
import { NO_ACTION } from '../ai/suggestedAction';
import type { TurnGuidance } from '../ai/turnGuidance';
import { liveSqlProblem, runAnswerSql } from './answerSql';
import { sqlSnapshotFor, turnsForBrowser } from './answerSnapshots';

/** How many of the question's datasets are Live, or null when one is gone. */
async function liveOf(projectId: string, q: VerifiedSqlQuestion): Promise<number | null> {
  let n = 0;
  for (const id of q.sql.datasetIds) {
    const meta = await datasets.getDatasetMeta(projectId, id);
    if (!meta) return null;
    if (isLive(meta)) n += 1;
  }
  return n;
}

/**
 * Why `q` no longer runs, in a sentence, or null. Metadata always: every dataset it reads still there, and all of them
 * Live or none (F-D9: a copy switched to Live beside one that was not). `deep` (the Verified page): the statement
 * DESCRIBEd through the gate too, no row read, or over Live translated, bound and printed for the caller with no
 * warehouse call (F4), so a column gone (a schema sync dropped it), a dataset renamed or a construct a warehouse can't
 * carry says why. A dataset the caller may not read whole is not checked for them: that is their access, not a
 * breakage, and asking it gives them the gate's refusal (on Live, the row rules' own, which carries no code).
 */
export async function sqlProblem(projectId: string, q: VerifiedSqlQuestion, deep: boolean): Promise<string | null> {
  const live = await liveOf(projectId, q);
  if (live === null) return vmsg.verifiedDatasetGone();
  if (live && live < q.sql.datasetIds.length) return msg.verifiedSqlBroken(lmsg.sqlMixedEngines());
  if (!deep) return null;
  if (live) {
    const why = await liveSqlProblem(projectId, q.sql.text, q.sql.datasetIds);
    return why?.code ? msg.verifiedSqlBroken(why.reason) : null;
  }
  for (const id of q.sql.datasetIds) if (await closedToCaller(projectId, id)) return null;
  const r = await sqlDatasets.explainSql(projectId, q.sql.text, []);
  if (!r.ok) return msg.verifiedSqlBroken(r.error);
  const stray = r.deps.find((id) => !q.sql.datasetIds.includes(id));
  return stray ? msg.verifiedSqlBroken(msg.sqlNotPicked((await datasets.getDatasetMeta(projectId, stray))?.name ?? stray)) : null;
}

export interface SqlSaveInput { question: string; phrasings?: string[]; note?: string; sql: string }
type Saved = { ok: true; q: VerifiedSqlQuestion } | { ok: false; error: string; field?: 'question' | 'phrasings' | 'spec' };

/**
 * Verify an SQL answer: the statement runs once through the gate for the editor (it must run to be kept), or over Live
 * datasets once through phase F (F4), and what is kept is that text and the datasets the gate says it read (the
 * translator's, on Live), never the browser's list and never a figure. New only:
 * an SQL question is not edited in place (the Verified page offers no edit for one); delete and verify again.
 */
export async function saveVerifiedSql(projectId: string, input: SqlSaveInput): Promise<Saved> {
  if (!questionKey(input.question)) return { ok: false, error: vmsg.verifiedNoWords(), field: 'question' };
  const run = await runAnswerSql(projectId, input.sql, null, input.question);
  if (!run.ok) return { ok: false, error: vmsg.verifiedDoesNotDraw(run.reason), field: 'spec' };
  const now = new Date().toISOString();
  const q = sanitizeVerifiedSql({
    id: randomUUID(), projectId, question: input.question, phrasings: input.phrasings ?? [], note: input.note,
    sql: { text: input.sql, datasetIds: run.deps }, verifiedBy: osUser(), verifiedAt: now, createdAt: now, updatedAt: now, schemaVersion: 1,
  });
  if (!q) return { ok: false, error: vmsg.verifiedNotRead(), field: 'spec' };
  return lockedKeys(projectId, async (): Promise<Saved> => {
    const both = await listBoth(projectId);
    const taken = keyClash([...both.spec, ...both.sql].map((t) => t.rec), [q.question, ...q.phrasings]);
    if (taken !== null) return { ok: false, error: vmsg.verifiedTaken(taken), field: taken === q.question ? 'question' : 'phrasings' };
    const saved = await writeVerifiedSql(projectId, q);
    return saved ? { ok: true, q: saved } : { ok: false, error: vmsg.verifiedGone() };
  });
}

/** A row of the Verified page for an SQL question: its words, the datasets it reads, whether it runs. No SQL text and no spec. */
export async function sqlRow(projectId: string, q: VerifiedSqlQuestion, tag: string, problem: string | null) {
  const names = await Promise.all(q.sql.datasetIds.map(async (id) => (await datasets.getDatasetMeta(projectId, id))?.name ?? ''));
  return {
    id: q.id, question: q.question, phrasings: q.phrasings, ...(q.note ? { note: q.note } : {}),
    datasetId: q.sql.datasetIds[0], datasetName: names.filter(Boolean).join(', '), describe: msg.verifiedSqlDescribe(), filters: [] as string[],
    verifiedBy: q.verifiedBy, verifiedAt: q.verifiedAt, runs: problem === null, ...(problem !== null ? { problem } : {}), tag, sql: true as const,
  };
}

/** Every SQL question of the project as the Verified page lists it, each checked through the gate (DESCRIBE, no row), or translated (Live, no warehouse call). */
export async function sqlRows(projectId: string, list: ReadonlyArray<{ rec: VerifiedSqlQuestion; tag: string }>) {
  return Promise.all(list.map(async (t) => sqlRow(projectId, t.rec, t.tag, await sqlProblem(projectId, t.rec, true))));
}

/**
 * Step 2 for an SQL question asked word for word: null when it no longer runs by its metadata (a dataset gone: the model
 * takes the question, as for a chart's). Otherwise its SQL runs again for the caller, and a refusal or a failure answers
 * `{ ok: false }` with the reason and falls no further, as a chart's hit does. No model call, no words of the model.
 * Over Live it is translated again for the caller and printed under their lock (F4): their own statement and cache entry.
 */
export async function verifiedSqlAsk(projectId: string, hit: VerifiedSqlQuestion, question: string, target: () => Promise<string | undefined>, note: string | null) {
  if ((await sqlProblem(projectId, hit, false)) !== null) return null;
  const live = !!(await liveOf(projectId, hit));
  // The caller may not read a dataset whole: the gate's refusal is theirs, said as the gate says it. Else a failure is a breakage.
  const closed = !live && (await Promise.all(hit.sql.datasetIds.map((id) => closedToCaller(projectId, id)))).some(Boolean);
  const run = await runAnswerSql(projectId, hit.sql.text, hit.sql.datasetIds, hit.question);
  // On Live a breakage is what the translate-only check names (no warehouse call); the rest (their lock, the cost limits, the warehouse) is said as is.
  if (!run.ok) return { ok: false as const, error: live ? ((await sqlProblem(projectId, hit, true)) ?? run.reason) : closed ? run.reason : msg.verifiedSqlBroken(run.reason) };
  const sql: SqlTurn = { text: hit.sql.text, datasetIds: run.deps, title: hit.question };
  const guidance: TurnGuidance = { verifiedId: hit.id, instructions: 0, examples: [] };
  const text = note ?? '';
  const provenance: copilot.CopilotProvenance = { kind: 'dataset', name: run.card.datasets.join(', '), note: 'computed by the query engine' };
  const snapshot = await sqlSnapshotFor(projectId, run.card, sql);
  const tid = await target();
  await copilot.appendTurn(projectId, { role: 'user', text: question }, tid);
  const turns = await copilot.appendTurn(projectId, { role: 'assistant', text, provenance, sql, ...(snapshot ? { snapshot } : {}), guidance }, tid);
  return {
    ok: true as const, answer: text, provenance, turns: await turnsForBrowser(projectId, turns || []), threadId: tid || null,
    suggestedAction: NO_ACTION, ledger: [], numberAudit: { ok: true as const, violations: [] }, guidance,
  };
}
