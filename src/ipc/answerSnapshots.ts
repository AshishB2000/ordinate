// Answers keep the figures they had (docs/assistant/00-design.md, "Scale rules") — MAIN PROCESS.
//
// An answer turn stores its card as it was computed (../ai/answerSnapshot), so reopening a conversation runs no
// figure query. This module is the one way a stored turn reaches the browser (`turnsForBrowser`: copilot:history,
// copilot:ask, answer:rerun and a verified hit all reply through it) and `answer:refresh`, which computes a turn's
// card now and keeps that instead.
//
// THE CHECK. A stored card is sent only after the server works out again what decides the figures this person may
// see on its dataset (`accessPrint`: their row lock and the columns hidden from them, from the dataset's record, no
// row read) and finds it equal to the fingerprint the card was computed under, with the dataset still there.
// Otherwise the stored figures never leave: the turn goes without a card, the browser asks `answer:refresh`, and
// the card is computed under today's access and replaces the snapshot (and says so). A turn stored before
// snapshots gets its first one the same way, dated then. A card too big to keep is computed on every open.
//
// Not kept, worked out at every delivery as `answer:card` does (`liveBits`): whether its saved visual still
// exists, its name to remember, its "✓ Verified" (with the turn's guidance: whether it matched a verified question or
// drew one it was shown, ./verifiedMark `kind`), what "Answered from" says of its source to this caller
// (./answerSources). Saved visuals and dashboards are untouched.
//
// An SQL answer (./answerSql) keeps its result table the same way, as its `card` (`kind: 'sql'`): its fingerprint is of the caller's
// access on EVERY dataset the statement read (`sqlAccessPrint`), and Refresh runs the SQL again through the gate.

import { createHash } from 'crypto';
import { ipcMain } from './bus';
import { keepReads } from './askMemo';
import { verifiedMark } from './verifiedMark';
import { answeredFrom, keptMeta } from './answerSources';
import { hiddenColumnsFor, isRowPolicyError, rowLockFor } from '../data/rowAccess';
import { stableStringify } from '../engine/queryCache';
import * as copilot from '../ai/copilot';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import { loadShared as loadCatalog } from '../app/catalog';
import { shownNames, taughtNames } from '../app/columnNames';
import { resolveColumn, type AnswerSpec } from '../ai/answerSpec';
import { sanitizeLearn, type AnswerLearn } from '../ai/answerSuggest';
import { cardOf, keptView, makeSnapshot, periodsOf, type AnswerSnapshot, type KeptView } from '../ai/answerSnapshot';
import { answerNotRefreshed, answerNotThere } from '../ai/answerSnapshotMessages';
import { sameSql, type SqlCard, type SqlTurn } from '../ai/answerSql';
import { sqlCardFor } from './answerSql';
import { verifiedSqlOn } from './verifiedLookup';
import type { AnswerCard, Built, CardLearn, Failure } from './answers';

/** A turn as the browser gets it: no snapshot, and the stored card (checked) as `card`: a chart's, or an SQL answer's table. */
export type BrowserTurn = Omit<copilot.CopilotTurn, 'snapshot'> & { card?: Record<string, unknown> };

/**
 * What decides the figures the caller may see on `datasetId`, as a sha256: their row lock's values (or why they
 * are refused one) and the columns hidden from them. The two things every answer door applies for the caller
 * (./rowDoors `withLockOf`): a Live dataset's warehouse question takes the same lock. The Share policy's marked
 * columns are left out: they shape what a MODEL reads (../ai/answerFacts), never the card a person sees.
 * Reads the dataset's record only, never a row.
 */
export async function accessPrint(projectId: string, datasetId: string): Promise<string> {
  let lock: unknown;
  try {
    const held = await rowLockFor(projectId, datasetId);
    const sorted = (v: readonly unknown[]): string[] => v.map((x) => JSON.stringify(x)).sort();
    lock = held ? Object.fromEntries(Object.entries(held.values).map(([c, v]) => [c, sorted(v)])) : null;
  } catch (err) {
    if (!isRowPolicyError(err)) throw err;
    lock = { refused: err.reason };
  }
  const hidden = [...(await hiddenColumnsFor(projectId, datasetId))].sort();
  return createHash('sha256').update(stableStringify({ v: 1, lock, hidden })).digest('hex');
}

/** `accessPrint` of every dataset an SQL answer read, as one sha256: a change on any of them, and its table is computed again. */
export async function sqlAccessPrint(projectId: string, datasetIds: readonly string[]): Promise<string> {
  const prints = await Promise.all(datasetIds.map((id) => accessPrint(projectId, id)));
  return createHash('sha256').update(stableStringify({ v: 1, sql: prints })).digest('hex');
}

/** A snapshot of an SQL answer's card just run, or undefined: none kept (past the cap), the table runs again on open. */
export async function sqlSnapshotFor(projectId: string, card: SqlCard, sql: SqlTurn): Promise<AnswerSnapshot | undefined> {
  try {
    const now = new Date().toISOString();
    return makeSnapshot(card, { asOf: now, firstAsked: now }, await sqlAccessPrint(projectId, sql.datasetIds), []) ?? undefined;
  } catch {
    return undefined;
  }
}

/** An SQL card's "✓ Verified · who": a verified SQL question with the same statement, on its first dataset (worked out at every delivery). */
export async function sqlVerifiedMark(projectId: string, sql: Pick<SqlTurn, 'text' | 'datasetIds'>): Promise<{ verified?: { id: string; question: string; by: string; at: string } }> {
  const q = (await verifiedSqlOn(projectId, sql.datasetIds[0])).find((v) => sameSql(v.sql.text, sql.text));
  return q ? { verified: { id: q.id, question: q.question, by: q.verifiedBy, at: q.verifiedAt } } : {};
}

/** An SQL card as delivered: its mark worked out now, and what it kept. */
export const sqlDelivered = async (projectId: string, card: object, sql: SqlTurn, view: KeptView) =>
  ({ ...card, ...(await sqlVerifiedMark(projectId, sql)), snapshot: view });

/** A snapshot of a card just computed for `spec` (the turn's stored answer), or undefined: none kept, the card computes on open. */
export async function snapshotFor(projectId: string, card: AnswerCard, spec: AnswerSpec): Promise<AnswerSnapshot | undefined> {
  try {
    const now = new Date().toISOString();
    return makeSnapshot(card, { asOf: now, firstAsked: now }, await accessPrint(projectId, spec.datasetId), periodsOf(spec)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a name is still to remember, worked out now — never stored, so a name taught in the Columns tab, or by
 * anyone's card, shows at once. Metadata and the catalog only: a Live dataset is never hydrated. Nothing when the
 * column is gone.
 */
export async function learnState(projectId: string, datasetId: string, learn: AnswerLearn): Promise<CardLearn | undefined> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || !meta.columns.some((c) => c.name === learn.column)) return undefined;
  const docs = (await loadCatalog(projectId)).columns[datasetId];
  const known = resolveColumn(learn.said, meta.columns, taughtNames(meta.columns, docs))?.name === learn.column;
  return { ...learn, label: shownNames(meta.columns, docs)[learn.column] || learn.column, state: known ? 'known' : 'offer' };
}

/** What a card says that is not a figure, worked out now for the turn it draws (as `answer:card` does). */
async function liveBits(projectId: string, spec: AnswerSpec, turn: Pick<copilot.CopilotTurn, 'learn' | 'savedVisualId' | 'guidance'>): Promise<Record<string, unknown>> {
  const said = sanitizeLearn(turn.learn, spec);
  const taught = said ? await learnState(projectId, spec.datasetId, said) : undefined;
  const saved = turn.savedVisualId && (await visuals.getVisual(projectId, turn.savedVisualId)) ? turn.savedVisualId : undefined;
  return { ...(taught ? { learn: taught } : {}), ...(saved ? { savedVisualId: saved } : {}), ...(await verifiedMark(projectId, spec, turn.guidance)), ...(await answeredFrom(projectId, spec.datasetId)) };
}

const delivered = async (projectId: string, card: object, spec: AnswerSpec, turn: copilot.CopilotTurn, view: KeptView) =>
  ({ ...card, ...(await liveBits(projectId, spec, turn)), snapshot: view });

/**
 * `turns` as the browser may see them: never a snapshot, and an answer's stored card only while the caller's access
 * on its dataset is what it was computed under and the dataset is still there. Each dataset is checked once.
 */
export async function turnsForBrowser(projectId: string, turns: readonly copilot.CopilotTurn[]): Promise<BrowserTurn[]> {
  const now = new Map<string, Promise<string | null>>();
  // null: the dataset is gone, or its access cannot be worked out — either way the stored figures stay here.
  const accessNow = (id: string): Promise<string | null> => {
    let p = now.get(id);
    if (!p) {
      p = (async () => ((await keptMeta(projectId, id)) ? accessPrint(projectId, id) : null))().catch(() => null); // the record "Answered from" reads too
      now.set(id, p);
    }
    return p;
  };
  // An SQL answer's: every dataset it read still there, and the access on all of them as it was.
  const sqlAccessNow = async (ids: readonly string[]): Promise<string | null> => {
    for (const id of ids) if ((await accessNow(id)) === null) return null;
    return sqlAccessPrint(projectId, ids).catch(() => null);
  };
  const out: BrowserTurn[] = [];
  for (const { snapshot, ...turn } of turns) {
    if (turn.sql) {
      const kept = snapshot && (await sqlAccessNow(turn.sql.datasetIds)) === snapshot.access ? cardOf(snapshot) : null;
      out.push(kept && snapshot ? { ...turn, card: await sqlDelivered(projectId, kept, turn.sql, keptView(snapshot, snapshot.firstAsked, [])) } : turn);
      continue;
    }
    const card = snapshot && turn.answer && (await accessNow(turn.answer.datasetId)) === snapshot.access ? cardOf(snapshot) : null;
    out.push(card && snapshot && turn.answer
      ? { ...turn, card: await delivered(projectId, card, turn.answer, turn, keptView(snapshot, snapshot.firstAsked, snapshot.periods)) }
      : turn);
  }
  return out;
}

/** Refresh of an SQL answer: its SQL run again through the gate for the caller, kept in place of its snapshot (firstAsked stays). */
async function refreshSql(projectId: string, threadId: string, turnId: string, turn: copilot.CopilotTurn, sql: SqlTurn): Promise<Record<string, unknown>> {
  const built = await sqlCardFor(projectId, sql);
  if (!built.ok) return built; // the gate's sentence; a Live dataset's is typed by the route
  const access = await sqlAccessPrint(projectId, sql.datasetIds);
  const firstAsked = turn.snapshot?.firstAsked ?? turn.createdAt;
  const snap = makeSnapshot(built.card, { asOf: new Date().toISOString(), firstAsked }, access, []);
  await copilot.setSnapshot(projectId, threadId, turnId, { sql: sql.text }, snap);
  return sqlDelivered(projectId, built.card, sql, keptView(snap, firstAsked, [], !!turn.snapshot && turn.snapshot.access !== access));
}

type Compute = (projectId: string, spec: AnswerSpec) => Promise<Built | Failure>;

/** Registered from ./answers `register`, which hands over THE answer door (`computeCard`). */
export function registerSnapshots(compute: Compute): void {
  // Refresh, and the first draw of a card the conversation did not bring (none kept, or its access changed): the
  // caller's own answer turn, computed now under their access, and kept in place of its snapshot (firstAsked stays).
  // A card that fails keeps the snapshot it had; one too big to keep stores none and is computed on each open.
  ipcMain.handle('answer:refresh', keepReads(async (_e, { projectId, threadId, turnId }: any = {}) => {
    try {
      const turn = typeof threadId === 'string' && typeof turnId === 'string' ? await copilot.findTurn(projectId, threadId, turnId) : null;
      if (turn?.sql) return await refreshSql(projectId, threadId, turnId, turn, turn.sql);
      if (!turn || !turn.answer) return { ok: false, reason: answerNotThere() };
      const spec = turn.answer;
      const built = await compute(projectId, spec);
      if ('ok' in built) return built;
      const access = await accessPrint(projectId, spec.datasetId);
      const firstAsked = turn.snapshot?.firstAsked ?? turn.createdAt;
      const periods = periodsOf(spec);
      const snap = makeSnapshot(built.card, { asOf: new Date().toISOString(), firstAsked }, access, periods);
      await copilot.setSnapshot(projectId, threadId, turnId, spec, snap);
      return delivered(projectId, built.card, spec, turn, keptView(snap, firstAsked, periods, !!turn.snapshot && turn.snapshot.access !== access));
    } catch (err: any) {
      return { ok: false, reason: err?.message || answerNotRefreshed() };
    }
  }));
}
