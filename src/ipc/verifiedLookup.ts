// An ask's two verified-question lookups (semantic part 3 D8, D10): is the question one of them word for word
// (step 2), and which to show the model as examples (step 3); and MCP's answer_verified_question, by id or wording.
// MAIN PROCESS ONLY. Each has two ways that must agree, field by field (test-verifiedIndex, test-verifiedNarrowEnv):
//
//   INDEXED    with a database: ../server/verifiedIndex finds the candidates, and only THOSE records are read and
//              checked (`statesOf`), against only what their charts name (`verifiedEnvFor`). A miss reads no verified
//              record at all; examples read a batch of 20 at a time.
//   REFERENCE  every verified record of the project, checked (`verifiedStates`), then ../ai/verifiedPick. Without a
//              database this is the path, and with one it answers whenever the index fails.
//
// Whether a question still runs, and what the caller may see of it, is never in the index: it is worked out on the
// records read, the same way on both paths.

import { rowsUnder } from '../app/recordFs';
import { logger } from '../app/logger';
import { orgDb } from '../server/db/inOrg';
import * as index from '../server/verifiedIndex';
import * as datasets from '../data/datasets';
import { readManyTagged, verifiedFromBody } from '../analysis/verifiedQuestions';
import type { Tagged } from '../app/editConflict';
import { questionKey, type VerifiedQuestion } from '../analysis/verifiedRules';
import { listTerms } from '../analysis/terms';
import { withheldColumns } from '../app/sharePolicy';
import { words } from '../ai/answerSuggest';
import { eligibleExample, exactHit, NOTHING_TAKEN, pickExamples, takeExamples, type Names, type PickOptions } from '../ai/verifiedPick';
import { statesOf, verifiedEnvFor, verifiedStates, type VerifiedState } from './verifiedState';

/** What a stored question puts in the index: its question and each phrasing, by key; the question's words. */
export const describeVerified: index.DescribeVerified = (projectId, id, body) => {
  const q = verifiedFromBody(projectId, body)?.rec;
  if (!q || q.id !== id) return []; // `listTagged` skips a misnamed record: so does the index
  return [q.question, ...q.phrasings].map((text, ord) => ({
    ord, key: questionKey(text), datasetId: q.spec.datasetId, updated: q.updatedAt, words: ord === 0 ? words(q.question) : [],
  }));
};
index.useVerifiedDescriber(describeVerified);

/** Examples come from the index this many at a time: one batch is the usual whole cost. */
const BATCH = 20;

let warned = false;
function fellBack(err: unknown): void {
  if (warned) return;
  warned = true;
  logger.warn(`[verified] the index lookup failed (${String((err as { code?: unknown })?.code ?? 'error')}); answering from the records. Further failures are not logged.`);
}

/** `fn`'s answer, or `reference`'s when there is no database (null) or the index fails. */
async function indexedOr<T>(fn: () => Promise<T | null>, reference: () => Promise<T>): Promise<T> {
  if (!orgDb()) return reference();
  try {
    const r = await fn();
    if (r !== null) return r;
  } catch (err) {
    fellBack(err);
  }
  return reference();
}

/** `statesOf` the questions an index lookup returned, against only what their charts name. */
const checked = async (projectId: string, list: readonly Tagged<VerifiedQuestion>[]): Promise<VerifiedState[]> =>
  statesOf(projectId, list, await verifiedEnvFor(projectId, list.map((t) => t.rec)));

// ── step 2: the exact match ─────────────────────────────────────────────

/** REFERENCE: every question of the project, checked, then the first whose wording is `question`, on `scope` (null = any). */
export async function referenceHit(projectId: string, question: string, scope: ReadonlySet<string> | null, exclude?: string): Promise<VerifiedQuestion | null> {
  const states = await verifiedStates(projectId);
  return exactHit(scope ? states.filter((s) => scope.has(s.q.spec.datasetId)) : states, question, exclude);
}

/** INDEXED: the questions with `question`'s key, read and checked; no record is read on a miss. Null without a database. */
export async function indexedHit(projectId: string, question: string, scope: ReadonlySet<string> | null, exclude?: string): Promise<{ q: VerifiedQuestion | null } | null> {
  const key = questionKey(question);
  if (!key) return orgDb() ? { q: null } : null; // a punctuation-only question never matches
  const ids = await index.keyHits(projectId, key, scope ? [...scope] : null, rowsUnder);
  if (!ids) return null;
  if (!ids.length) return { q: null };
  return { q: exactHit(await checked(projectId, await readManyTagged(projectId, ids)), question, exclude) };
}

/** The verified question `question` is word for word, on `scope` (null = any), or null. */
export async function verifiedHit(projectId: string, question: string, scope: ReadonlySet<string> | null, exclude?: string): Promise<VerifiedQuestion | null> {
  const r = await indexedOr(() => indexedHit(projectId, question, scope, exclude), async () => ({ q: await referenceHit(projectId, question, scope, exclude) }));
  return r.q;
}

// ── step 3: the examples ────────────────────────────────────────────────

export type ExampleAsk = Pick<PickOptions, 'question' | 'datasetId' | 'exclude' | 'first'>;
export interface Examples { lines: string[]; ids: string[] }

/** Dataset names and withheld columns for `pickExamples`, read once per dataset as more questions come in. */
class Lookups {
  private readonly name = new Map<string, string>();
  private readonly held = new Map<string, ReadonlySet<string>>();
  private terms: Promise<Array<{ id: string; name: string }>> | null = null;
  constructor(private readonly projectId: string) {}

  async cover(states: readonly VerifiedState[]): Promise<void> {
    const ids = [...new Set(states.map((s) => s.q.spec.datasetId))].filter((id) => !this.name.has(id));
    this.terms ??= listTerms(this.projectId);
    const [metas, withheld] = await Promise.all([
      Promise.all(ids.map((id) => datasets.getDatasetMeta(this.projectId, id))), Promise.all(ids.map((id) => withheldColumns(this.projectId, id))), this.terms,
    ]);
    ids.forEach((id, i) => { this.name.set(id, metas[i]?.name ?? ''); this.held.set(id, withheld[i]); });
  }

  async names(): Promise<Names> {
    const terms = await (this.terms ??= listTerms(this.projectId));
    return { dataset: (id) => this.name.get(id) ?? '', term: (id) => terms.find((t) => t.id === id)?.name ?? '' };
  }

  readonly withheld = (id: string): ReadonlySet<string> => this.held.get(id) ?? new Set();
}

/** REFERENCE: every question of the project, checked, then `pickExamples`. */
export async function referenceExamples(projectId: string, a: ExampleAsk): Promise<Examples> {
  const states = await verifiedStates(projectId);
  if (!states.length) return { lines: [], ids: [] };
  const look = new Lookups(projectId);
  await look.cover(states);
  return pickExamples(states, { ...a, names: await look.names(), withheld: look.withheld });
}

/** INDEXED: the index ranks every question in `exampleOrder`; records are read and checked a batch at a time until five are taken. */
export async function indexedExamples(projectId: string, a: ExampleAsk): Promise<Examples | null> {
  const order = { asked: [...new Set(words(a.question))], datasetId: a.datasetId, first: a.first ? [...a.first] : undefined };
  const look = new Lookups(projectId);
  let taken = NOTHING_TAKEN;
  for (let offset = 0; !taken.done; offset += BATCH) {
    const ids = await index.rankedIds(projectId, order, offset, BATCH, rowsUnder);
    if (!ids) return null;
    if (!ids.length) break;
    const states = await checked(projectId, await readManyTagged(projectId, ids));
    await look.cover(states);
    const o = { exclude: a.exclude, withheld: look.withheld };
    taken = takeExamples(states.filter((s) => eligibleExample(s, o)).map((s) => s.q), await look.names(), taken); // already in order
    if (ids.length < BATCH) break;
  }
  return { lines: taken.lines, ids: taken.ids };
}

/** Up to 5 verified questions to show the model for `a.question`, as lines and ids. */
export function verifiedExamples(projectId: string, a: ExampleAsk): Promise<Examples> {
  return indexedOr(() => indexedExamples(projectId, a), () => referenceExamples(projectId, a));
}

// ── MCP answer_verified_question: by id or by any wording ────────────────

const namedBy = (question: string): ((s: VerifiedState) => boolean) => {
  const key = questionKey(question);
  return (s) => s.q.id === question || (key !== '' && [s.q.question, ...s.q.phrasings].some((t) => questionKey(t) === key));
};

/** REFERENCE: the first question of the project, checked, whose id is `question` or one of whose wordings it is, on any dataset. */
export async function referenceNamed(projectId: string, question: string): Promise<VerifiedState | null> {
  return (await verifiedStates(projectId)).find(namedBy(question)) ?? null;
}

/** `listTagged`'s order: newest first, then by id (a record's file name, as its folder lists them). */
const newestFirst = (a: Tagged<VerifiedQuestion>, b: Tagged<VerifiedQuestion>): number =>
  a.rec.updatedAt < b.rec.updatedAt ? 1 : a.rec.updatedAt > b.rec.updatedAt ? -1 : a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0;

/** INDEXED: the question whose id is `question` and those with its key, read, in the reference's order, and checked. Null without a database. */
export async function indexedNamed(projectId: string, question: string): Promise<{ s: VerifiedState | null } | null> {
  if (!orgDb()) return null;
  const key = questionKey(question);
  const hits = key ? await index.keyHits(projectId, key, null, rowsUnder) : [];
  if (!hits) return null;
  const list = (await readManyTagged(projectId, [...new Set([...hits, question])])).sort(newestFirst); // not an id: no record
  if (!list.length) return { s: null };
  return { s: (await checked(projectId, list)).find(namedBy(question)) ?? null };
}

/** The verified question `question` names, by its id or any of its wordings, whether it runs or not; null for none. */
export async function verifiedNamed(projectId: string, question: string): Promise<VerifiedState | null> {
  return (await indexedOr(() => indexedNamed(projectId, question), async () => ({ s: await referenceNamed(projectId, question) }))).s;
}
