// Verified questions IPC (semantic layer part 3 D5, D7) — list, save (new, or an edit in place with `base`), delete.
//
// A save re-reads the spec, refuses one that no longer runs or whose question is taken (checked under one lock with
// the write, as a Trash restore is: ../app/trash), and DRAWS it once through
// `computeCard` (row lock, Live door): a spec that does not draw cannot be verified. What is kept is the card's spec,
// never a figure. Whoever saves vouches for what the record now says, so every save restamps who and when.
//
// A caller row access rules close the dataset to gets a question whose spec compares with a row value (a hidden
// one) as its words only: no spec, and its value filters worded without a value (REDACT).

import { randomUUID } from 'crypto';
import type { z } from 'zod';
import { ipcMain } from './bus';
import { computeCard } from './answers';
import { verifiedEnv, verifiedProblem, verifiedStates, type VerifiedState } from './verifiedState';
import { sanitizeStoredSpec, type AnswerFilter, type AnswerSpec } from '../ai/answerSpec';
import { describeAnswer } from '../ai/answerFacts';
import { describeFilter } from '../analysis/metricFormat';
import { describePeriod, getCalendar } from '../analysis/dateIntel';
import { keyClash, questionKey, sanitizeVerified, type VerifiedQuestion } from '../analysis/verifiedRules';
import { listVerified, lockedKeys, readVerified, writeVerified } from '../analysis/verifiedQuestions';
import * as msg from '../analysis/verifiedMessages';
import { listTerms } from '../analysis/terms';
import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { restrictedOn } from '../data/rowAccess';
import { contentTag } from '../app/editConflict';
import { osUser } from '../app/catalog';
import * as trash from '../app/trash';
import type { VerifiedInput } from '../api/verified';
import { checkFor, startCheck } from './assistantCheck';

type Input = z.infer<typeof VerifiedInput>;
type Field = 'question' | 'phrasings' | 'spec';
type Saved = { ok: true; q: VerifiedQuestion } | { ok: false; error: string; field?: Field; code?: string };

export interface VerifiedRow {
  id: string;
  question: string;
  phrasings: string[];
  note?: string;
  datasetId: string;
  datasetName: string;
  /** "sum of amount by region" (../ai/answerFacts describeAnswer). */
  describe: string;
  /** Each filter in words; on a hidden question a value filter names its column only. */
  filters: string[];
  /** Absent when hidden (D5). */
  spec?: AnswerSpec;
  verifiedBy: string;
  verifiedAt: string;
  runs: boolean;
  problem?: string;
  /** The edit dialog's `base`. */
  tag: string;
}

function filterWords(f: AnswerFilter, termNames: ReadonlyMap<string, string>, hidden: boolean): string[] {
  if ('term' in f) return termNames.has(f.term) ? [termNames.get(f.term) as string] : []; // a deleted term: the problem says so
  if ('period' in f) return [`${f.column}: ${describePeriod({ preset: f.period, n: f.n }, getCalendar()).toLowerCase()}${f.yearsBack ? `, ${f.yearsBack} years back` : ''}`];
  if (hidden && ('value' in f || 'values' in f)) return [msg.verifiedValuesHidden(f.column)];
  return [describeFilter({ type: 'filter', ...f } as FilterStep)];
}

/** One question as the caller may read it. */
function rowOf(s: VerifiedState, names: ReadonlyMap<string, string>, termNames: ReadonlyMap<string, string>, restricted: boolean): VerifiedRow {
  const { q, hidden } = s;
  const row: VerifiedRow = {
    id: q.id, question: q.question, phrasings: q.phrasings, ...(q.note ? { note: q.note } : {}),
    datasetId: q.spec.datasetId, datasetName: names.get(q.spec.datasetId) ?? '',
    describe: describeAnswer(q.spec), filters: q.spec.filters.flatMap((f) => filterWords(f, termNames, hidden)),
    ...(hidden ? {} : { spec: q.spec }),
    verifiedBy: q.verifiedBy, verifiedAt: q.verifiedAt, runs: s.problem === null, ...(s.problem !== null ? { problem: s.problem } : {}), tag: s.tag,
  };
  // The stored tag would confirm a guessed spec that was not sent; a restricted caller cannot write, so theirs is of what they got.
  if (restricted) row.tag = contentTag('verified', { question: row.question, phrasings: row.phrasings, note: row.note, spec: row.spec });
  return row;
}

async function rowsFor(projectId: string, states: VerifiedState[]): Promise<VerifiedRow[]> {
  const names = new Map((await datasets.listDatasets(projectId)).map((d) => [d.id, d.name] as const));
  const termNames = new Map((await listTerms(projectId)).map((t) => [t.id, t.name] as const));
  const restricted = await restrictedOn(projectId);
  return states.map((s) => rowOf(s, names, termNames, restricted));
}

/**
 * The save's body (also the sample project's seed): checks, draws once, then stores. `at`: an edit in place of `at.id`,
 * refused 409 `record_changed` (thrown) when `at.base` is not the stored tag.
 */
export async function saveVerifiedQuestion(projectId: string, input: Input, at?: { id: string; base?: string }): Promise<Saved> {
  const spec = sanitizeStoredSpec(input.spec);
  if (!spec) return { ok: false, error: msg.verifiedNotRead(), field: 'spec' };
  if (!questionKey(input.question)) return { ok: false, error: msg.verifiedNoWords(), field: 'question' };
  if (at && !(await readVerified(projectId, at.id))) return { ok: false, error: msg.verifiedGone() };
  const now = new Date().toISOString();
  const draft = sanitizeVerified({
    id: at ? at.id : randomUUID(), projectId, question: input.question, phrasings: input.phrasings ?? [], note: input.note, spec,
    verifiedBy: osUser(), verifiedAt: now, createdAt: now, updatedAt: now, schemaVersion: 1,
  });
  if (!draft) return { ok: false, error: msg.verifiedNoWords(), field: 'question' };
  const problem = verifiedProblem(draft, await verifiedEnv(projectId));
  if (problem) return { ok: false, error: problem, field: 'spec' };
  const built = await computeCard(projectId, draft.spec); // row lock, Live door; a stored spec is drawn as it stands
  if ('ok' in built) return { ok: false, error: msg.verifiedDoesNotDraw(built.reason), field: 'spec', ...(built.code ? { code: built.code } : {}) };
  const q = sanitizeVerified({ ...draft, spec: built.card.spec }); // the card's spec: no `matched`, the question its title
  if (!q) return { ok: false, error: msg.verifiedGone() };
  // The key check and the write under one lock (the draw stays outside it): two saves of one question cannot both pass.
  return lockedKeys(projectId, async (): Promise<Saved> => {
    const taken = keyClash(await listVerified(projectId), [q.question, ...q.phrasings], at?.id);
    if (taken !== null) return { ok: false, error: msg.verifiedTaken(taken), field: taken === q.question ? 'question' : 'phrasings' };
    const saved = await writeVerified(projectId, q, at?.base);
    return saved ? { ok: true, q: saved } : { ok: false, error: msg.verifiedGone() };
  });
}

export function register(): void {
  ipcMain.handle('verified:list', async (_e, { projectId, datasetId }: { projectId: string; datasetId?: string }) => {
    const states = await verifiedStates(projectId);
    const first = (s: VerifiedState): number => (s.q.spec.datasetId === datasetId ? 0 : 1);
    const ordered = datasetId ? states.slice().sort((a, b) => first(a) - first(b)) : states; // stable: newest within each
    return { ok: true, broken: states.filter((s) => s.problem !== null).length, questions: await rowsFor(projectId, ordered) };
  });

  // A stale `base` throws ERECORDCHANGED: the route's 409 `record_changed`, with the catalog's sentence and the current tag.
  ipcMain.handle('verified:save', async (_e, { projectId, id, base, input }: { projectId: string; id?: string; base?: string; input: Input }) => {
    const r = await saveVerifiedQuestion(projectId, input, id ? { id, base } : undefined);
    if (!r.ok) return r;
    const [question] = await rowsFor(projectId, [{ q: r.q, problem: null, hidden: false, tag: contentTag('verified', r.q) }]); // its saver may write: never hidden
    return { ok: true, question };
  });

  ipcMain.handle('verified:delete', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const done = await trash.trashRecord(projectId, 'verified', id); // to the Trash
    return done.ok ? { ok: true } : { ok: false, error: msg.verifiedGone() };
  });

  // Check the Assistant (./assistantCheck): the reply leaves before the first model call; the run goes on as a job.
  ipcMain.handle('verified:check', async (_e, { projectId }: { projectId: string }) => {
    const r = await startCheck(projectId);
    return r.ok ? { ok: true, runId: r.runId } : r;
  });

  ipcMain.handle('verified:checkResult', async (_e, { projectId }: { projectId: string }) => ({ ok: true, run: await checkFor(projectId) }));
}
