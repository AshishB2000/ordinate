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
// records read, the same way on both paths. But for shared folders: the index's WHERE keeps only questions every dataset
// of which is in a folder the caller opens (docs/team-folders D13; `reads`, 0034), as the reference's caller-aware list does.
//
// A verified SQL question (../analysis/verifiedRules `VerifiedSqlQuestion`) is in the index under the first dataset it
// reads, with every one it reads in `reads`, and is read by the same lookups: step 2 matches it word for word when every
// dataset it reads is inside the scope (./verifiedSql reruns it), a card's "✓ Verified" finds it (`verifiedSqlOn`), MCP is
// told what it is (`verifiedSqlNamed`). It is no example: an example is a chart spec for the model to follow.

import { rowsUnder } from '../app/recordFs';
import { perAsk } from './askMemo';
import { logger } from '../app/logger';
import { orgDb } from '../server/db/inOrg';
import * as index from '../server/verifiedIndex';
import * as datasets from '../data/datasets';
import { listBoth, listVerified, readManyBoth, readManyTagged, verifiedFromBody, verifiedSqlFromBody } from '../analysis/verifiedQuestions';
import type { Tagged } from '../app/editConflict';
import { isSqlQuestion, questionKey, type AnyVerified, type VerifiedQuestion, type VerifiedSqlQuestion } from '../analysis/verifiedRules';
import { relatedIds } from '../ai/answerJoin';
import { getTerm } from '../analysis/terms';
import { withheldColumns } from '../app/sharePolicy';
import { words } from '../ai/answerSuggest';
import { eligibleExample, exactHit, examplesHead, NOTHING_TAKEN, pickExamples, takeExamples, tierOf, type Names, type PickOptions } from '../ai/verifiedPick';
import { MEANING_K, cut } from '../app/assistantSearchRank';
import { clean } from '../app/searchMatch';
import { meaningOf, nearOrWords } from './meaning';
import { statesOf, verifiedEnv, verifiedEnvFor, verifiedStates, type VerifiedState } from './verifiedState';
import { indexFolders, levelsOf, openOnly } from '../server/authz/folderGate';

/** The folders the caller opens, for the index's WHERE (null: nothing restricts them). */
const openFolders = async (projectId: string): Promise<string[] | null> => (await indexFolders(projectId))?.open ?? null;

/** SQL questions read by id, each kept only when the caller opens every dataset it reads (`listBoth`'s rule, D3). */
async function sqlOpen(projectId: string, list: readonly Tagged<VerifiedSqlQuestion>[]): Promise<Tagged<VerifiedSqlQuestion>[]> {
  const level = await levelsOf(projectId, 'dataset');
  return level ? list.filter((t) => t.rec.sql.datasetIds.every((id) => level(id) !== 'none')) : [...list];
}

/** A question as it is fingerprinted (0030 `text`): as written, trimmed, at most 1,000 code points. */
export const questionText = (question: string): string => cut(clean(question).trim());

/** What a stored question puts in the index: its question and each phrasing, by key; the question's words. An SQL question's dataset is the first it reads. */
export const describeVerified: index.DescribeVerified = (projectId, id, body) => {
  const q: AnyVerified | undefined = verifiedFromBody(projectId, body)?.rec ?? verifiedSqlFromBody(projectId, body)?.rec;
  if (!q || q.id !== id) return []; // `listTagged` skips a misnamed record: so does the index
  const datasetId = isSqlQuestion(q) ? q.sql.datasetIds[0] : q.spec.datasetId;
  const reads = isSqlQuestion(q) ? q.sql.datasetIds : [datasetId, ...relatedIds(q.spec)]; // every dataset it reads, a related category's or split's too: the folders' WHERE (0034)
  return [q.question, ...q.phrasings].map((text, ord) => ({
    ord, key: questionKey(text), datasetId, reads, updated: q.updatedAt, words: ord === 0 ? words(q.question) : [], text: ord === 0 ? questionText(q.question) : '',
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

/** The first SQL question (newest first) whose wording is `question`, every dataset it reads inside `scope` (null = any). Whether it still runs is ./verifiedSql's. */
function sqlHit(list: readonly Tagged<VerifiedSqlQuestion>[], question: string, scope: ReadonlySet<string> | null, exclude?: string): VerifiedSqlQuestion | null {
  const key = questionKey(question);
  if (!key) return null;
  return list.find(({ rec: q }) => q.id !== exclude && (!scope || q.sql.datasetIds.every((id) => scope.has(id)))
    && [q.question, ...q.phrasings].some((t) => questionKey(t) === key))?.rec ?? null;
}

/** REFERENCE: every question of the project, checked, then the first whose wording is `question`, on `scope` (null = any): a chart's, else an SQL one. */
export async function referenceHit(projectId: string, question: string, scope: ReadonlySet<string> | null, exclude?: string): Promise<AnyVerified | null> {
  const both = await listBoth(projectId); // one listing, as verifiedStates' own
  const states = await statesOf(projectId, both.spec, await verifiedEnv(projectId));
  return exactHit(scope ? states.filter((s) => scope.has(s.q.spec.datasetId)) : states, question, exclude) ?? sqlHit(both.sql, question, scope, exclude);
}

/** INDEXED: the questions with `question`'s key, read and checked; no record is read on a miss. Null without a database. */
export async function indexedHit(projectId: string, question: string, scope: ReadonlySet<string> | null, exclude?: string): Promise<{ q: AnyVerified | null } | null> {
  const key = questionKey(question);
  if (!key) return orgDb() ? { q: null } : null; // a punctuation-only question never matches
  const ids = await index.keyHits(projectId, key, scope ? [...scope] : null, rowsUnder, await openFolders(projectId));
  if (!ids) return null;
  if (!ids.length) return { q: null };
  const both = await readManyBoth(projectId, ids); // ONE read, either kind
  return { q: exactHit(await checked(projectId, both.spec), question, exclude) ?? sqlHit(both.sql, question, scope, exclude) };
}

/** The verified question `question` is word for word, on `scope` (null = any), or null. */
export async function verifiedHit(projectId: string, question: string, scope: ReadonlySet<string> | null, exclude?: string): Promise<AnyVerified | null> {
  const r = await indexedOr(() => indexedHit(projectId, question, scope, exclude), async () => ({ q: await referenceHit(projectId, question, scope, exclude) }));
  return r.q;
}

// ── a card's "✓ Verified": the questions on its dataset ─────────────────

/** REFERENCE: every question of the project, then those on `datasetId`, newest first. */
export async function referenceOn(projectId: string, datasetId: string): Promise<VerifiedQuestion[]> {
  return (await listVerified(projectId)).filter((q) => q.spec.datasetId === datasetId);
}

/**
 * The questions on `datasetId`, newest first: with a database only those records are read (./verifiedMark). Once per
 * dataset in a kept call (./askMemo): a reopened conversation marks every card. Its readers never change the list.
 */
export function verifiedOn(projectId: string, datasetId: string): Promise<VerifiedQuestion[]> {
  return perAsk(`verifiedOn\0${projectId}\0${datasetId}`, () => indexedOr(async () => {
    const ids = await index.datasetHits(projectId, datasetId, rowsUnder, await openFolders(projectId));
    return ids && (await readManyTagged(projectId, ids)).map((t) => t.rec);
  }, () => referenceOn(projectId, datasetId)));
}

/** The SQL questions whose first dataset is `datasetId`, newest first: an SQL card's "✓ Verified" (./verifiedSql). */
export function verifiedSqlOn(projectId: string, datasetId: string): Promise<VerifiedSqlQuestion[]> {
  return perAsk(`verifiedSqlOn\0${projectId}\0${datasetId}`, () => indexedOr(async () => {
    const ids = await index.datasetHits(projectId, datasetId, rowsUnder, await openFolders(projectId));
    return ids && (await readManyBoth(projectId, ids)).sql.map((t) => t.rec);
  }, async () => (await listBoth(projectId)).sql.map((t) => t.rec).filter((q) => q.sql.datasetIds[0] === datasetId)));
}

// ── step 3: the examples ────────────────────────────────────────────────

export type ExampleAsk = Pick<PickOptions, 'question' | 'datasetId' | 'exclude' | 'first'>;
export interface Examples { lines: string[]; ids: string[] }

/** Dataset names and withheld columns for `pickExamples`, read once per dataset as more questions come in. */
class Lookups {
  private readonly name = new Map<string, string>();
  private readonly held = new Map<string, ReadonlySet<string>>();
  /** The terms the questions' filters name, by id: their own records, never the project's list. */
  private readonly term = new Map<string, string>();
  constructor(private readonly projectId: string) {}

  async cover(states: readonly VerifiedState[]): Promise<void> {
    const ids = [...new Set(states.map((s) => s.q.spec.datasetId))].filter((id) => !this.name.has(id));
    const tIds = [...new Set(states.flatMap((s) => s.q.spec.filters.flatMap((f) => ('term' in f ? [f.term] : []))))].filter((id) => !this.term.has(id));
    const [metas, withheld, ts] = await Promise.all([
      Promise.all(ids.map((id) => datasets.getDatasetMeta(this.projectId, id))), Promise.all(ids.map((id) => withheldColumns(this.projectId, id))),
      Promise.all(tIds.map((id) => getTerm(this.projectId, id).catch(() => null))),
    ]);
    ids.forEach((id, i) => { this.name.set(id, metas[i]?.name ?? ''); this.held.set(id, withheld[i]); });
    tIds.forEach((id, i) => this.term.set(id, ts[i]?.id === id ? ts[i].name : ''));
  }

  names(): Names {
    return { dataset: (id) => this.name.get(id) ?? '', term: (id) => this.term.get(id) ?? '' };
  }

  readonly withheld = (id: string): ReadonlySet<string> => this.held.get(id) ?? new Set();
}

/** REFERENCE: every question of the project, checked, then `pickExamples`. `near`: the ids nearest by meaning (the differential's), merged in as the index does. */
export async function referenceExamples(projectId: string, a: ExampleAsk, near?: readonly string[]): Promise<Examples> {
  const states = await verifiedStates(projectId);
  if (!states.length) return { lines: [], ids: [] };
  const look = new Lookups(projectId);
  await look.cover(states);
  return pickExamples(states, { ...a, names: look.names(), withheld: look.withheld, ...(near ? { near } : {}) });
}

type Pages = AsyncGenerator<index.Ranked[] | null>;

/** The index's exampleOrder, BATCH at a time from `from`. */
async function* ranked(projectId: string, order: index.ExampleOrder, from: number): Pages {
  for (let offset = from; ; offset += BATCH) {
    const page = await index.rankedIds(projectId, order, offset, BATCH, rowsUnder);
    yield page;
    if (!page || page.length < BATCH) return;
  }
}

/**
 * With meaning: ../ai/verifiedPick examplesWithMeaning, paged. The head's questions of a tier no later question can
 * precede come first, so the usual ask reads no page past the head; then each page of exampleOrder, merged by tier.
 */
async function* withMeaning(projectId: string, order: index.ExampleOrder, near: readonly index.Ranked[], tier: (datasetId: string) => number): Pages {
  const words = await index.rankedIds(projectId, order, 0, MEANING_K, rowsUnder);
  if (!words) {
    yield null;
    return;
  }
  const head = examplesHead(words, near, tier, MEANING_K);
  const inHead = new Set(head.map((r) => r.id));
  const tail = words.length === MEANING_K; // every later question's tier is the last one's or after
  let i = 0;
  const upTo = (t: number): index.Ranked[] => { const from = i; while (i < head.length && tier(head[i].datasetId) <= t) i++; return head.slice(from, i); };
  yield upTo(tail ? tier(words[MEANING_K - 1].datasetId) : Infinity);
  if (!tail) return;
  for await (const page of ranked(projectId, order, MEANING_K)) {
    if (!page) {
      yield null;
      return;
    }
    yield page.flatMap((t) => (inHead.has(t.id) ? [] : [...upTo(tier(t.datasetId)), t]));
  }
  yield head.slice(i);
}

/** INDEXED: the index ranks every question in `exampleOrder` (with meaning, merged); records are read and checked a batch at a time until five are taken. */
export async function indexedExamples(projectId: string, a: ExampleAsk): Promise<Examples | null> {
  const open = await openFolders(projectId);
  const order = { asked: [...new Set(words(a.question))], datasetId: a.datasetId, first: a.first ? [...a.first] : undefined, open };
  const to = await meaningOf(projectId, a.question);
  const near = to && (await nearOrWords(() => index.nearestIds(projectId, to, MEANING_K, rowsUnder, open)));
  const look = new Lookups(projectId);
  let taken = NOTHING_TAKEN;
  let batch: string[] = [];
  const take = async (): Promise<void> => {
    const states = await checked(projectId, await readManyTagged(projectId, batch));
    batch = [];
    await look.cover(states);
    const o = { exclude: a.exclude, withheld: look.withheld };
    taken = takeExamples(states.filter((s) => eligibleExample(s, o)).map((s) => s.q), look.names(), taken); // already in order
  };
  for await (const page of near ? withMeaning(projectId, order, near, tierOf(a)) : ranked(projectId, order, 0)) {
    if (!page) return null;
    for (const r of page) {
      batch.push(r.id);
      if (batch.length === BATCH) await take();
      if (taken.done) return { lines: taken.lines, ids: taken.ids };
    }
  }
  if (batch.length) await take();
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
  const hits = key ? await index.keyHits(projectId, key, null, rowsUnder, await openFolders(projectId)) : [];
  if (!hits) return null;
  // By id too (not an id: no record), so the folders' check is the store's here, as `getVerified` reads one (D12).
  const list = (await openOnly(projectId, 'dataset', await readManyTagged(projectId, [...new Set([...hits, question])]), (t) => t.rec.spec.datasetId)).sort(newestFirst);
  if (!list.length) return { s: null };
  return { s: (await checked(projectId, list)).find(namedBy(question)) ?? null };
}

/** The verified question `question` names, by its id or any of its wordings, whether it runs or not; null for none. */
export async function verifiedNamed(projectId: string, question: string): Promise<VerifiedState | null> {
  return (await indexedOr(() => indexedNamed(projectId, question), async () => ({ s: await referenceNamed(projectId, question) }))).s;
}

/** The verified SQL question `question` names, by its id or any of its wordings; null for none. MCP's answer for one is a refusal. */
export async function verifiedSqlNamed(projectId: string, question: string): Promise<VerifiedSqlQuestion | null> {
  const key = questionKey(question);
  const named = (q: VerifiedSqlQuestion): boolean => q.id === question || (key !== '' && [q.question, ...q.phrasings].some((t) => questionKey(t) === key));
  const list = await indexedOr(async () => {
    const hits = key ? await index.keyHits(projectId, key, null, rowsUnder, await openFolders(projectId)) : [];
    return hits && sqlOpen(projectId, (await readManyBoth(projectId, [...new Set([...hits, question])])).sql); // by id too: the store's rule
  }, async () => (await listBoth(projectId)).sql);
  return list.map((t) => t.rec).find(named) ?? null;
}
