// Section 6 of the folder safety net (docs/team-folders/00-design.md, "Indexes: inside the query"): ⌘K, the Assistant's
// search by words and by meaning, the counts, the verified lookup and the Assistant's history, as the note's people, in
// the world of ./folderHarness with its folders planted. Run by ./folderNet; not a test file itself (no `test-` prefix).
//
// Finance's canaries (FINCANARY: a dataset, a visual, a metric, a term, a verified question, a published dashboard, a
// scorecard and a report made from it, which follows everything it names) are made in Everyone — where opsViewer and
// finViewer each have a conversation about them — and then placed in Finance (team Finance: view, finViewer only).
//   - For every person, each index answer is the reference's (the caller-aware stores), with Object.is: ⌘K, step 3's
//     search, its spelling, its counts, Home's counts, the exact verified match and the examples.
//   - opsViewer, opsLead and ed never find a Finance canary — nor HR's — by ⌘K, words, spelling (a typo sharing no word,
//     and the "Did you mean" it makes), meaning (a fake embedder, as test-meaningSearch), the counts, the verified lookup
//     or their history — a prose answer (no chart) about Finance's dataset leaves it with its question, by the datasets
//     its facts were built from, and a conversation of only such turns leaves the list and reads as missing by id.
//     So does an answer asked on a dashboard page placed in Finance (no dataset of its own) and an alert's explanation on
//     Finance's dataset; a rename is told the count shown; an ask into a conversation of only hidden turns starts a new one
//     and replays the model none of them, and a follow-up chip and a plan's log into one start a new one too.
//     So does a chart on Plain whose category is read from Finance's dataset (a join: the related dataset in its
//     `factsFrom`), not listed, not counted and none by id; NEGATIVE CONTROLS: finViewer's is shown and counted, and the
//     same turn without that record is opsViewer's again.
//     NEGATIVE CONTROLS: finViewer and padmin do; a chip into a conversation with a turn shown appends there, and with the
//     folder checks off (no folder besides Everyone) the chip and the log land in the ones named; a stored turn without that record (an older release's) keeps its words;
//     with the WHERE condition removed (folderGate's seam), opsViewer's index answers carry them and differ from the
//     reference; a ⌘K row with no anchor (an older pod's) is not returned to opsViewer but is to padmin; an anchor
//     written in another case is still filtered, in ⌘K and in step 3's index.

import { randomUUID } from 'crypto';
import { ok } from './selfcheck';
import type * as H from './folderHarness';

const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const cmdK: typeof import('../src/ipc/search') = require('../src/ipc/search');
const model: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const lookup: typeof import('../src/ipc/verifiedLookup') = require('../src/ipc/verifiedLookup');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const answerCheck: typeof import('../src/ipc/answerCheck') = require('../src/ipc/answerCheck');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');

const FIN = /fincanary/i;
const CANARIES = /fincanary|hrcanary/i;
const OUTSIDE: H.Person[] = ['opsViewer', 'opsLead', 'ed'];
const EVERYONE: H.Person[] = [...OUTSIDE, 'finViewer', 'padmin'];
const QUERIES = ['fincanary', 'fincanary ledger', 'ledger', 'ops', 'board', 'hrcanary', 'chart'];
/** A typo of Finance's dataset that shares no word with it: found by spelling alone. */
const TYPO = 'Fincanry Ledgr';

interface Fin { ds: string; visual: string; board: string; question: string; sqlQuestion: string; sqlReads: string[] }

/** Finance's canaries, made in Everyone by boss. */
async function finance(W: H.World): Promise<Fin> {
  const { P } = W;
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const reportSpec: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
  const id = (r: H.Reply, ...keys: string[]): string => {
    const v = keys.map((k) => k.split('.').reduce<any>((o, x) => o?.[x], r.body)).find((x) => typeof x === 'string' && x); // any: each channel's own reply
    if (!v) throw new Error(`setup: ${r.text.slice(0, 200)}`);
    return v;
  };
  const columns = [{ name: 'dept', type: 'text' as const }, { name: 'salary', type: 'number' as const }, { name: 'fincanary_amount', type: 'number' as const }];
  const ds = await W.as('boss', async () => (await datasets.saveDataset(P, { name: 'FINCANARY Ledger', sourceKind: 'csv', columns, rows: [['d0', 3, 1], ['d1', 5, 2]] }))!.id);
  const enc = { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] };
  const visual = id(await W.call('boss', 'visual:save', { projectId: P, datasetId: ds, name: 'FINCANARY chart', chartType: 'bar', encoding: enc }), 'visual.id', 'id');
  const metric = id(await W.call('boss', 'metric:save', { projectId: P, input: { name: 'FINCANARY metric', datasetId: ds, definition: { column: 'salary', aggregation: 'sum' } } }), 'metric.id', 'id');
  id(await W.call('boss', 'term:save', { projectId: P, input: { name: 'FINCANARY term', aliases: [], description: 'FINCANARY words', datasetId: ds, filters: [{ type: 'filter', column: 'dept', op: '=', value: 'd1' }] } }), 'term.id', 'id');
  const question = 'FINCANARY question by dept';
  // A verified SQL question reading Plain (Everyone) first and Finance's dataset second: its index row is under Plain.
  const sqlQuestion = 'FINCANARY sql question by dept';
  const sq = await W.call('boss', 'verified:save', { projectId: P, input: { question: sqlQuestion, sql: 'SELECT p.dept, sum(f.salary) AS total FROM "Plain" p JOIN "FINCANARY Ledger" f ON f.dept = p.dept GROUP BY p.dept ORDER BY p.dept' } });
  if (sq.body?.ok !== true) throw new Error(`setup: verified SQL ${sq.text.slice(0, 200)}`);
  const vStore: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
  const sqlReads = (await W.as('boss', () => vStore.listBoth(P))).sql.find((t) => t.rec.question === sqlQuestion)?.rec.sql.datasetIds ?? [];
  id(await W.call('boss', 'verified:save', { projectId: P, input: { question, spec: { datasetId: ds, category: 'dept', measures: [{ column: 'salary', aggregation: 'sum' }], filters: [] } } }), 'q.id', 'question.id', 'id');
  const board = id(await W.call('boss', 'analysis:create', { projectId: P, name: 'FINCANARY board', sheets: [{ name: 'One', cards: [{ id: randomUUID(), layout: { x: 0, y: 0, w: 6, h: 4 }, type: 'visual', visualId: visual }] }] }), 'id', 'analysis.id');
  await W.call('boss', 'analysis:publish', { projectId: P, id: board });
  const scorecard = id(await W.call('boss', 'scorecard:create', { projectId: P, name: 'FINCANARY scorecard', rows: [{ metricId: metric }] }), 'scorecard.id');
  await W.as('boss', () => reportSpec.saveReport(P, { scorecardId: scorecard, name: 'FINCANARY scorecard report' } as never)); // no dashboard: it follows what it names
  return { ds, visual, board, question, sqlQuestion, sqlReads };
}

/** Every index answer of `who` beside its reference, as text pairs: [label, index, reference]. */
async function answers(W: H.World, who: H.Person, fin: Fin): Promise<Array<[string, string, string]>> {
  const { P } = W;
  return W.as(who, async () => {
    const out: Array<[string, string, string]> = [];
    const pair = async (label: string, idx: () => Promise<unknown>, ref: () => Promise<unknown>) => out.push([label, JSON.stringify(await idx()), JSON.stringify(await ref())]);
    const viewer = await analysis.readsPublishedOnly(P);
    for (const q of QUERIES) {
      await pair(`⌘K "${q}"`, () => cmdK.searchIndexed(P, q, viewer, 20), async () => (await cmdK.searchNames(P, q)).slice(0, 20));
      await pair(`step 3 "${q}"`, () => model.indexedModel(P, q, { limit: 12 }), () => model.referenceModel(P, q, { limit: 12 }));
    }
    await pair(`spelling "${TYPO}"`, () => model.indexedSpelling(P, TYPO, { limit: 20 }), () => model.referenceSpelling(P, TYPO, { limit: 20 }));
    await pair('step 3 counts', () => model.indexedCount(P), () => model.referenceCount(P));
    await pair('Home counts', () => cmdK.countNamed(P), () => cmdK.countListed(P));
    await pair('verified match', async () => (await lookup.indexedHit(P, fin.question, null))?.q?.question ?? null, async () => (await lookup.referenceHit(P, fin.question, null))?.question ?? null);
    await pair('verified examples', () => lookup.indexedExamples(P, { question: 'fincanary ledger by dept' }), () => lookup.referenceExamples(P, { question: 'fincanary ledger by dept' }));
    // The verified SQL question (#528): found only by a caller who opens EVERY dataset it reads, Plain and Finance's.
    const vStore: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
    const sqlRef = async () => (await vStore.listBoth(P)).sql.map((t) => t.rec);
    await pair('verified SQL match', async () => (await lookup.indexedHit(P, fin.sqlQuestion, null))?.q?.question ?? null, async () => (await lookup.referenceHit(P, fin.sqlQuestion, null))?.question ?? null);
    await pair('verified SQL on Plain', async () => (await lookup.verifiedSqlOn(P, W.plain)).map((q) => q.question), async () => (await sqlRef()).filter((q) => q.sql.datasetIds[0] === W.plain).map((q) => q.question));
    await pair('verified SQL by wording', async () => (await lookup.verifiedSqlNamed(P, fin.sqlQuestion))?.question ?? null, async () => (await sqlRef()).find((q) => q.question === fin.sqlQuestion)?.question ?? null);
    return out;
  });
}

/** What `who` finds by meaning for a question sharing no word with Finance's items: the fake makes them, and it, one vector. */
async function byMeaning(W: H.World, who: H.Person): Promise<string> {
  return W.as(who, async () => JSON.stringify([await model.searchModel(W.P, 'money book', { limit: 30 }), await lookup.verifiedExamples(W.P, { question: 'money book' })]));
}

/** Fingerprints for the org, from a fake model: Finance's texts and the question "money book" one vector, all else another. */
async function fingerprinted(W: H.World): Promise<(() => void) | null> {
  const vstore: typeof import('../src/server/vectorStore') = require('../src/server/vectorStore');
  if (!(await vstore.vectorStatus(0)).table) {
    ok('pgvector is installed for section 6\'s meaning checks (ORDINATE_EXPECT_PGVECTOR=1)', process.env.ORDINATE_EXPECT_PGVECTOR !== '1');
    console.log('     skip meaning in section 6: no pgvector table');
    return null;
  }
  const fp: typeof import('../src/ai/fingerprints') = require('../src/ai/fingerprints');
  const aiConfig: typeof import('../src/server/aiConfig') = require('../src/server/aiConfig');
  const job: typeof import('../src/server/fingerprintJob') = require('../src/server/fingerprintJob');
  const [realFp, realPick, realMin] = [fp.fingerprint, aiConfig.currentFingerprintModel, process.env.MEANING_MIN_SIMILARITY];
  const unit = (d: number): Float32Array => { const v = new Float32Array(768); v[d] = 1; return v; };
  (fp as { fingerprint: unknown }).fingerprint = async (texts: readonly string[]) => ({ ok: true, vectors: texts.map((t) => unit(/fincanary|money book/i.test(t) ? 0 : 1)) });
  (aiConfig as { currentFingerprintModel: unknown }).currentFingerprintModel = () => ({ provider: 'openai', model: 'text-embedding-3-small' });
  process.env.MEANING_MIN_SIMILARITY = '0.5';
  while (await W.as('boss', () => job.fingerprintOrg(Infinity, 5_000)));
  return (restore = () => {
    (fp as { fingerprint: unknown }).fingerprint = realFp;
    (aiConfig as { currentFingerprintModel: unknown }).currentFingerprintModel = realPick;
    if (realMin === undefined) delete process.env.MEANING_MIN_SIMILARITY;
    else process.env.MEANING_MIN_SIMILARITY = realMin;
    restore = () => undefined;
  });
}

let restore = (): void => undefined;

/** Per person, conversations of prose answers (a fake model, no chart) had while Finance's dataset and `board` were in Everyone. */
type Prose = { board: string; of: Map<H.Person, { mixed: string; fin: string; board: string; alert: string }> };

/** `fn` with a fake model answering in prose (no chart); `priors`: the turns each of its calls was replayed, in order. */
async function fakeModel<T>(fn: (priors: Array<Array<{ text: string }>>) => Promise<T>): Promise<T> {
  const real = { ask: analyze.askCopilot, ready: execConfig.executionReady };
  const priors: Array<Array<{ text: string }>> = [];
  (analyze as { askCopilot: unknown }).askCopilot = async (prior: Array<{ text: string }>, _facts: string, q: string) => {
    priors.push(prior);
    return { ok: true, text: FIN.test(q) ? 'FINCANARY prose answer.' : 'Plain prose answer.', suggestedAction: { kind: 'none', intent: '' } };
  };
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  try {
    return await fn(priors);
  } finally {
    (analyze as { askCopilot: unknown }).askCopilot = real.ask;
    (execConfig as { executionReady: unknown }).executionReady = real.ready;
  }
}

/**
 * `mixed`: a prose answer on Plain, then one on Finance's dataset; `fin`: only the one on Finance's dataset; `board`: one
 * asked on the page of a published dashboard with no tile (no dataset: only the dashboard can hide it); `alert`: an
 * alert's explanation on Finance's dataset (../src/ipc/alerts `explainEvent`, the push's path: no channel of its own).
 */
async function proseThreads(W: H.World, fin: Fin): Promise<Prose> {
  const { P } = W;
  const alerts: typeof import('../src/ipc/alerts') = require('../src/ipc/alerts');
  const made = (await W.call('boss', 'analysis:create', { projectId: P, name: 'Tileless board', sheets: [{ name: 'One', cards: [] }] })).body;
  const board = (made?.id ?? made?.analysis?.id) as string;
  if (!board || (await W.call('boss', 'analysis:publish', { projectId: P, id: board })).body?.ok === false) throw new Error('setup: the tileless board');
  return fakeModel(async () => {
    const of: Prose['of'] = new Map();
    const thread = async (who: H.Person, asks: Array<[object, string]>): Promise<string> => {
      const id = (await W.call(who, 'copilot:newThread', { projectId: P })).body?.thread?.id as string;
      for (const [context, question] of asks) {
        const r = await W.call(who, 'copilot:ask', { projectId: P, threadId: id, context, question });
        if (r.body?.ok !== true) throw new Error(`setup: a prose answer for ${who}: ${r.text.slice(0, 300)}`);
      }
      return id;
    };
    const on = (id: string) => ({ kind: 'dataset', id });
    for (const who of ['opsViewer', 'finViewer'] as H.Person[]) {
      const event = { id: randomUUID(), ruleId: randomUUID(), ruleName: 'Ledger', datasetId: fin.ds, at: new Date().toISOString(), value: 1, previous: 2, delta: -1, deltaPct: -50, message: 'FINCANARY Ledger fell.', seen: false };
      const alert = await W.as(who, () => alerts.explainEvent(P, event));
      if (!alert) throw new Error(`setup: an alert explanation for ${who}`);
      of.set(who, {
        mixed: await thread(who, [[on(W.plain), 'plain prose question'], [on(fin.ds), 'fincanary prose question']]), fin: await thread(who, [[on(fin.ds), 'fincanary prose question']]),
        board: await thread(who, [[{ kind: 'analysis', id: board }, 'tileless board question']]), alert,
      });
    }
    return { board, of };
  });
}

/**
 * Per person, a conversation of ONE chart answer on Plain (Everyone) whose category is read from Finance's dataset
 * (docs/assistant "Joins, as built"), had while it was in Everyone. The link is made for it and deleted after, so no
 * other check of this world follows it; the turn keeps the related dataset in its `factsFrom` whatever the links say.
 */
async function joinedAnswers(W: H.World, fin: Fin): Promise<Map<H.Person, string>> {
  const { P } = W;
  const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
  const link = randomUUID();
  await W.as('boss', () => rels.saveRelationship(P, { id: link, from: { datasetId: W.plain, column: 'dept' }, to: { datasetId: fin.ds, column: 'dept' }, cardinality: 'many_to_one', verified: { matched: 2, unmatchedFrom: 0 } }));
  const spec = { datasetId: W.plain, category: 'dept', categoryDatasetId: fin.ds, measures: [{ column: 'salary', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'FINCANARY joined' };
  const out = new Map<H.Person, string>();
  try {
    for (const who of ['opsViewer', 'finViewer'] as H.Person[]) {
      const id = (await W.call(who, 'copilot:newThread', { projectId: P })).body?.thread?.id as string;
      const r = await W.call(who, 'answer:rerun', { projectId: P, threadId: id, spec, label: 'fincanary joined question' });
      if (r.body?.ok !== true || r.body.threadId !== id) throw new Error(`setup: a joined answer for ${who}: ${r.text.slice(0, 300)}`);
      out.set(who, id);
    }
  } finally {
    await W.as('boss', () => rels.deleteRelationship(P, link));
  }
  return out;
}

/** With Finance's dataset in Finance: the joined chart on Plain is hidden by its RELATED dataset, from the list's count and by id. */
async function joinedChecks(W: H.World, threads: Map<H.Person, string>): Promise<void> {
  const { P, pool } = W;
  const read = async (who: H.Person, threadId: string) => {
    const r = (await W.call(who, 'copilot:history', { projectId: P, threadId })).body ?? {};
    const list = ((await W.call(who, 'copilot:threads', { projectId: P })).body?.threads ?? []) as Array<{ id: string; turnCount: number }>;
    return { threadId: r.threadId as string | null, turns: ((r.turns ?? []) as unknown[]).length, listed: list.find((t) => t.id === threadId)?.turnCount ?? null, raw: JSON.stringify(r) };
  };
  const ops = await read('opsViewer', threads.get('opsViewer')!);
  ok('history: opsViewer\'s chart on Plain whose category is read from Finance\'s dataset is gone with its question — not listed (so not counted), none by id',
    ops.listed === null && ops.threadId === null && ops.turns === 0 && !CANARIES.test(ops.raw), JSON.stringify(ops).slice(0, 300));
  const fins = await read('finViewer', threads.get('finViewer')!);
  ok('NEGATIVE CONTROL: finViewer is shown theirs, both turns, and the list counts both', fins.threadId === threads.get('finViewer') && fins.turns === 2 && fins.listed === 2 && FIN.test(fins.raw), JSON.stringify(fins).slice(0, 300));
  // The turn keeps the related dataset in its factsFrom (0039's SQL function reads it): without it, the chart reads as Plain's alone.
  const row = (await pool.query<{ id: string; body: string }>(`SELECT id::text, body FROM assistant_turns WHERE project_id = $1 AND thread_id = $2 AND role = 'assistant'`, [P, threads.get('opsViewer')])).rows[0];
  ok('setup: that answer records the related dataset in what its facts came from, and nothing else', !!row && JSON.stringify(JSON.parse(row.body).factsFrom) === JSON.stringify([JSON.parse(row.body).answer?.categoryDatasetId]), row?.body.slice(0, 300));
  await pool.query(`UPDATE assistant_turns SET body = (body::jsonb - 'factsFrom')::text WHERE project_id = $1 AND id = $2`, [P, row.id]);
  let bare: Awaited<ReturnType<typeof read>>;
  try {
    bare = await read('opsViewer', threads.get('opsViewer')!);
  } finally {
    await pool.query('UPDATE assistant_turns SET body = $3 WHERE project_id = $1 AND id = $2', [P, row.id, row.body]);
  }
  ok('NEGATIVE CONTROL: without the record, opsViewer lists it, counts both turns and is shown them', bare.listed === 2 && bare.turns === 2 && bare.threadId === threads.get('opsViewer'), JSON.stringify(bare).slice(0, 300));
}

/** With Finance's dataset in Finance: the prose answers about it, and the conversation of only those, as each person sees them. */
async function proseChecks(W: H.World, prose: Prose): Promise<void> {
  const { P, pool } = W;
  const texts = async (who: H.Person, threadId: string) => {
    const r = (await W.call(who, 'copilot:history', { projectId: P, threadId })).body ?? {};
    return { threadId: r.threadId as string | null, texts: ((r.turns ?? []) as Array<{ text: string }>).map((t) => t.text), raw: JSON.stringify(r) };
  };
  const listed = async (who: H.Person) => ((await W.call(who, 'copilot:threads', { projectId: P })).body?.threads ?? []).map((t: { id: string }) => t.id) as string[];
  const ops = prose.of.get('opsViewer')!;
  const fins = prose.of.get('finViewer')!;
  const mixed = await texts('opsViewer', ops.mixed);
  ok('history: opsViewer\'s prose answer on Finance\'s dataset (no chart) is gone with its question; the one on Plain before it stays', JSON.stringify(mixed.texts) === JSON.stringify(['plain prose question', 'Plain prose answer.']), mixed.raw.slice(0, 300));
  const finMixed = await texts('finViewer', fins.mixed);
  ok('NEGATIVE CONTROL: finViewer is shown all four, Finance\'s prose answer included, and no reply names what the facts came from', finMixed.texts.length === 4 && finMixed.texts.includes('FINCANARY prose answer.') && !/factsFrom/.test(finMixed.raw), finMixed.raw.slice(0, 300));
  const gone = await texts('opsViewer', ops.fin);
  ok('history: a conversation whose every turn is hidden is not in opsViewer\'s list, and answers by id as none (no turns, no id, no title)', !(await listed('opsViewer')).includes(ops.fin) && gone.threadId === null && gone.texts.length === 0 && !CANARIES.test(gone.raw), gone.raw.slice(0, 300));
  const empty = ((await W.call('opsViewer', 'copilot:threads', { projectId: P })).body?.threads ?? []).filter((t: { turnCount: number }) => t.turnCount === 0).map((t: { id: string }) => t.id) as string[];
  const stored = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_turns WHERE project_id = $1 AND thread_id = ANY($2::uuid[])', [P, empty])).rows[0].n;
  ok(`history: each of opsViewer's ${empty.length} listed conversations shown with no turn has none stored (a new one): none whose every turn is hidden is listed`, stored === 0, String(stored));
  ok('NEGATIVE CONTROL: finViewer lists theirs and opens it', (await listed('finViewer')).includes(fins.fin) && (await texts('finViewer', fins.fin)).texts.length === 2);
  gate.setIndexWhereForTest(false);
  const unfiltered = await listed('opsViewer').finally(() => gate.setIndexWhereForTest(true));
  ok('NEGATIVE CONTROL: without the folders in the list\'s WHERE, opsViewer\'s list carries it', unfiltered.includes(ops.fin));
  // A turn stored without the record (as before this release): its words stay, as the design says. Then put back.
  const turn = (await pool.query<{ id: string; body: string }>('SELECT id::text, body FROM assistant_turns WHERE project_id = $1 AND thread_id = $2 AND text = $3', [P, ops.mixed, 'FINCANARY prose answer.'])).rows[0];
  ok('setup: opsViewer\'s stored prose answer records the datasets its facts were built from', !!turn && Array.isArray(JSON.parse(turn.body).factsFrom), turn?.body.slice(0, 200));
  await pool.query(`UPDATE assistant_turns SET body = (body::jsonb - 'factsFrom')::text WHERE project_id = $1 AND id = $2`, [P, turn.id]);
  let old: Awaited<ReturnType<typeof texts>>;
  try {
    old = await texts('opsViewer', ops.mixed);
  } finally {
    await pool.query('UPDATE assistant_turns SET body = $3 WHERE project_id = $1 AND id = $2', [P, turn.id, turn.body]);
  }
  ok('NEGATIVE CONTROL: the same turn without the record keeps its words for opsViewer (a turn stored before it)', old.texts.includes('FINCANARY prose answer.'), old.raw.slice(0, 300));

  // An alert's explanation on Finance's dataset: by what its facts came from, as an ask's.
  const alert = await texts('opsViewer', ops.alert);
  ok('history: opsViewer\'s alert explanation on Finance\'s dataset is gone — not listed, and none by id', !(await listed('opsViewer')).includes(ops.alert) && alert.threadId === null && !CANARIES.test(alert.raw), alert.raw.slice(0, 300));
  const finAlert = await texts('finViewer', fins.alert);
  ok('NEGATIVE CONTROL: finViewer is shown theirs, both turns', (await listed('finViewer')).includes(fins.alert) && finAlert.texts.length === 2 && FIN.test(finAlert.raw), finAlert.raw.slice(0, 300));

  // An answer asked on the page of a dashboard placed in Finance, though it shows no dataset: by the dashboard it recorded.
  const board = await texts('opsViewer', ops.board);
  ok('history: opsViewer\'s answer asked on a dashboard in Finance (no dataset of its own) is gone — not listed, and none by id', !(await listed('opsViewer')).includes(ops.board) && board.threadId === null && board.texts.length === 0, board.raw.slice(0, 300));
  const finBoard = await texts('finViewer', fins.board);
  ok('NEGATIVE CONTROL: finViewer is shown theirs, and no reply names the dashboards it recorded', finBoard.texts.join('|') === 'tileless board question|Plain prose answer.' && !/dashboardsFrom/.test(finBoard.raw), finBoard.raw.slice(0, 300));
  const asked = (await pool.query<{ id: string; body: string }>(`SELECT id::text, body FROM assistant_turns WHERE project_id = $1 AND thread_id = $2 AND role = 'assistant'`, [P, ops.board])).rows[0];
  ok('setup: that answer records the dashboard, and no dataset its facts came from', JSON.stringify(JSON.parse(asked?.body ?? '{}').dashboardsFrom) === JSON.stringify([prose.board]) && !JSON.parse(asked?.body ?? '{}').factsFrom, asked?.body.slice(0, 200));
  await pool.query(`UPDATE assistant_turns SET body = (body::jsonb - 'dashboardsFrom')::text WHERE project_id = $1 AND id = $2`, [P, asked.id]);
  let unboarded: { listed: boolean; texts: string[] };
  try {
    unboarded = { listed: (await listed('opsViewer')).includes(ops.board), texts: (await texts('opsViewer', ops.board)).texts };
  } finally {
    await pool.query('UPDATE assistant_turns SET body = $3 WHERE project_id = $1 AND id = $2', [P, asked.id, asked.body]);
  }
  ok('NEGATIVE CONTROL: without the record, opsViewer lists it and is shown both turns', unboarded.listed && unboarded.texts.length === 2, JSON.stringify(unboarded));

  // A rename is told the count of the turns shown, as the list counts them.
  const renamed = async (who: H.Person, threadId: string) => (await W.call(who, 'copilot:renameThread', { projectId: P, threadId, title: 'Renamed' })).body?.thread?.turnCount as number;
  ok('history: opsViewer renaming the mixed conversation is told its 2 turns shown, not the 4 stored', (await renamed('opsViewer', ops.mixed)) === 2);
  ok('NEGATIVE CONTROL: finViewer renaming theirs is told all 4', (await renamed('finViewer', fins.mixed)) === 4);
  gate.setIndexWhereForTest(false);
  const told = await renamed('opsViewer', ops.mixed).finally(() => gate.setIndexWhereForTest(true));
  ok('NEGATIVE CONTROL: counted without the folders, opsViewer\'s rename would say 4', told === 4, String(told));

  // An ask naming a conversation of only hidden turns starts a new one: none of them is replayed, kept or named.
  const into = async (who: H.Person, threadId: string) => fakeModel(async (priors) => {
    const r = (await W.call(who, 'copilot:ask', { projectId: P, threadId, context: { kind: 'dataset', id: W.plain }, question: 'plain prose question again' })).body ?? {};
    const n = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_turns WHERE project_id = $1 AND thread_id = $2', [P, threadId])).rows[0].n;
    return { threadId: r.threadId as string, turns: ((r.turns ?? []) as Array<{ text: string }>).length, replayed: priors.flat().map((t) => t.text), stored: n, raw: JSON.stringify(r) };
  });
  const fresh = await into('opsViewer', ops.fin);
  ok('history: opsViewer\'s ask into their conversation of only hidden turns lands in a new one, replays the model none of them, and leaves the old one as it was', fresh.threadId !== ops.fin && fresh.turns === 2 && fresh.replayed.length === 0 && fresh.stored === 2 && !CANARIES.test(fresh.raw), JSON.stringify(fresh).slice(0, 300));
  const kept = await into('finViewer', fins.fin);
  ok('NEGATIVE CONTROL: finViewer\'s lands in the one named, replaying its two turns', kept.threadId === fins.fin && kept.turns === 4 && kept.replayed.length === 2 && FIN.test(kept.replayed.join(' ')) && kept.stored === 4, JSON.stringify(kept).slice(0, 300));
}

/**
 * Every other write naming a conversation lands as an ask does (../src/ipc/turnsOpen `askThread`): a follow-up chip
 * (answer:rerun) and a plan's log, into one of only hidden turns, start a new one, and the old one gains no turn.
 */
async function landingChecks(W: H.World, prose: Prose, fin: Fin): Promise<void> {
  const { P, pool } = W;
  const turnsIn = async (threadId: string) => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_turns WHERE project_id = $1 AND thread_id = $2', [P, threadId])).rows[0].n;
  const unchecked = async <T>(fn: () => Promise<T>): Promise<T> => {
    gate.setFolderChecksForTest(false); // as with no folder besides Everyone, or for an admin: `levelsOf` answers null
    try {
      return await fn();
    } finally {
      gate.setFolderChecksForTest(true);
    }
  };
  const chip = { datasetId: W.plain, category: 'dept', measures: [{ column: 'salary', aggregation: 'sum' }], filters: [] };
  const rerun = async (who: H.Person, threadId: string) => {
    const before = await turnsIn(threadId);
    const r = (await W.call(who, 'answer:rerun', { projectId: P, threadId, spec: chip, label: 'plain chip' })).body ?? {};
    return { ok: r.ok === true, threadId: r.threadId as string, turns: ((r.turns ?? []) as unknown[]).length, gained: (await turnsIn(threadId)) - before, raw: JSON.stringify(r).slice(0, 300) };
  };
  const ops = prose.of.get('opsViewer')!;
  const fresh = await rerun('opsViewer', ops.fin);
  ok('history: opsViewer\'s follow-up chip into their conversation of only hidden turns lands in a new one, named in the reply, and the old one gains no turn', fresh.ok && fresh.threadId !== ops.fin && fresh.turns === 2 && fresh.gained === 0 && !CANARIES.test(fresh.raw), JSON.stringify(fresh));
  const mixed = await rerun('opsViewer', ops.mixed);
  ok('NEGATIVE CONTROL: opsViewer\'s chip into their conversation with turns shown appends there, as before', mixed.ok && mixed.threadId === ops.mixed && mixed.turns === 4 && mixed.gained === 2 && !CANARIES.test(mixed.raw), JSON.stringify(mixed));
  const fins = await rerun('finViewer', prose.of.get('finViewer')!.fin);
  ok('NEGATIVE CONTROL: finViewer\'s into theirs on Finance\'s dataset lands in the one named', fins.ok && fins.threadId === prose.of.get('finViewer')!.fin && fins.gained === 2, JSON.stringify(fins));
  const asked = (who: H.Person) => fakeModel(async () => { // a conversation of one prose answer on Finance's dataset
    const id = (await W.call(who, 'copilot:newThread', { projectId: P })).body?.thread?.id as string;
    await W.call(who, 'copilot:ask', { projectId: P, threadId: id, context: { kind: 'dataset', id: fin.ds }, question: 'fincanary prose question' });
    return id;
  });
  const admins = await asked('padmin');
  const admin = await rerun('padmin', admins);
  ok('NEGATIVE CONTROL: padmin\'s into theirs on Finance\'s dataset lands in it', admin.ok && admin.threadId === admins && admin.gained === 2 && admin.turns === 4, JSON.stringify(admin));

  // A plan's log, at its run's end, into the conversation plan:start named: opsLead's, asked while the checks were off.
  const leads = await unchecked(() => asked('opsLead'));
  ok('setup: opsLead\'s conversation has 2 turns, none shown to them', (await turnsIn(leads)) === 2 && (await W.call('opsLead', 'copilot:history', { projectId: P, threadId: leads })).body?.threadId === null);
  const threads = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_threads WHERE project_id = $1', [P])).rows[0].n;
  const logged = async (name: string) => {
    const before = await turnsIn(leads);
    const run = (await W.call('opsLead', 'plan:start', { projectId: P, threadId: leads, intent: 'x', steps: [{ kind: 'import', file: 'a.csv', name }] })).body?.runId as string;
    const log = (await W.call('opsLead', 'plan:stop', { projectId: P, runId: run })).body?.log as string | undefined;
    const at = async () => (await pool.query<{ t: string }>('SELECT thread_id::text AS t FROM assistant_turns WHERE project_id = $1 AND text = $2', [P, log ?? ''])).rows.map((r) => r.t);
    const [where, gained, n] = [await at(), (await turnsIn(leads)) - before, await threads()];
    // A plan:next after the run ended: the log is written once, so it lands nowhere again and opens no conversation.
    const repeat = (await W.call('opsLead', 'plan:next', { projectId: P, runId: run })).body?.log ?? null;
    return { log: !!log, at: where, gained, again: { log: repeat, copies: (await at()).length, threads: (await threads()) - n, gained: (await turnsIn(leads)) - before - gained } };
  };
  const once = (r: Awaited<ReturnType<typeof logged>>) => r.again.log === null && r.again.copies === 1 && r.again.threads === 0 && r.again.gained === 0;
  const away = await logged('Hidden log');
  ok('history: a plan\'s log into opsLead\'s conversation of only hidden turns lands in a new one, and the old one gains no turn', away.log && away.at.length === 1 && away.at[0] !== leads && away.gained === 0, JSON.stringify(away));
  ok('history: …and a plan:next after that run ended logs it nowhere again and opens no conversation', once(away), JSON.stringify(away.again));
  const inert = await unchecked(async () => ({ chip: await rerun('opsViewer', ops.fin), log: await logged('Shown log') }));
  ok('NEGATIVE CONTROL: with the folder checks off, opsViewer\'s chip and opsLead\'s log land in the ones named, the log once', inert.chip.threadId === ops.fin && inert.chip.gained === 2 && inert.log.gained === 1 && once(inert.log), JSON.stringify(inert));
}

export async function indexSections(W: H.World): Promise<void> {
  const { P, pool } = W;
  const fin = await finance(W);
  // Conversations had while Finance's dataset was in Everyone: a chart answer and an "Explain" of its visual.
  for (const who of ['opsViewer', 'finViewer'] as H.Person[]) {
    await W.call(who, 'answer:rerun', { projectId: P, spec: { datasetId: fin.ds, category: 'dept', measures: [{ column: 'salary', aggregation: 'sum' }], filters: [] } });
    await W.call(who, 'answer:explain', { projectId: P, visualId: fin.visual });
    // …and the verified SQL question asked word for word: an SQL answer turn (no model call), reading Plain and Finance's.
    const sql = await W.call(who, 'copilot:ask', { projectId: P, context: { kind: '' }, question: fin.sqlQuestion });
    if (!((sql.body?.turns ?? []) as Array<{ sql?: unknown }>).some((t) => t.sql)) throw new Error(`setup: an SQL answer for ${who}: ${sql.text.slice(0, 300)}`);
  }
  const joinedThreads = await joinedAnswers(W, fin); // a chart on Plain whose category is read from Finance's dataset
  const prose = await proseThreads(W, fin);
  const place = (kind: string, id: string) => pool.query('INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, $3, $4, $5, $6)', ['acme', P, kind, id, W.folders.fin, 'boss@acme.test']);
  await place('dataset', fin.ds);
  await place('dashboard', fin.board);
  await place('dashboard', prose.board);
  try {
    // ── per person: the index is the reference, and only Finance's openers find Finance ──
    const seen = new Map<H.Person, Array<[string, string, string]>>();
    for (const who of EVERYONE) seen.set(who, await answers(W, who, fin));
    const unequal = EVERYONE.flatMap((who) => seen.get(who)!.filter(([, i, r]) => i !== r).map(([l, i, r]) => `${who} ${l}: ${i.slice(0, 160)} | ${r.slice(0, 160)}`));
    ok(`indexes: for each of ${EVERYONE.length} people, ⌘K, step 3, its counts, Home's counts and the verified lookup from the index are the reference's (${seen.get('opsViewer')!.length} answers each)`, unequal.length === 0, unequal.slice(0, 4).join('\n'));
    ok('setup: the verified SQL question reads Plain first, then Finance\'s dataset: its index row is under Plain, which everyone opens', fin.sqlReads.length === 2 && fin.sqlReads[0] === W.plain && fin.sqlReads[1] === fin.ds, JSON.stringify(fin.sqlReads));
    for (const who of OUTSIDE) {
      const leaks = seen.get(who)!.filter(([, i]) => CANARIES.test(i)).map(([l]) => l);
      ok(`indexes: no index answer to ${who} carries a Finance or HR canary`, leaks.length === 0, leaks.join(', '));
    }
    for (const who of ['finViewer', 'padmin'] as H.Person[]) {
      const found = seen.get(who)!.filter(([, i]) => FIN.test(i)).map(([l]) => l);
      ok(`NEGATIVE CONTROL: ${who} finds Finance's canaries by ⌘K, step 3, spelling and the verified lookup, the SQL question's three included`,
        ['⌘K "fincanary"', 'step 3 "fincanary"', `spelling "${TYPO}"`, 'verified match', 'verified examples', 'verified SQL match', 'verified SQL on Plain', 'verified SQL by wording'].every((l) => found.includes(l)), found.join(', '));
    }
    // "Did you mean" for a model's answer naming the typo (../src/ipc/answerCheck): its options come from words and spelling.
    const meant = async (who: H.Person) => W.as(who, async () => JSON.stringify(await answerCheck.checkAction(P, {}, { kind: 'answer', intent: 'q', spec: { dataset: TYPO, category: 'dept', measures: [{ column: 'salary', aggregation: 'sum' }] } }, 'q')));
    ok(`spelling: "Did you mean" for "${TYPO}" offers opsViewer, opsLead and ed nothing of Finance`, (await Promise.all(OUTSIDE.map(meant))).every((r) => !FIN.test(r)));
    ok('NEGATIVE CONTROL: finViewer is offered FINCANARY Ledger', /FINCANARY Ledger/.test(await meant('finViewer')), (await meant('finViewer')).slice(0, 300));
    const kOf = async (who: H.Person) => ((await W.call(who, 'search:query', { projectId: P, query: 'fincanary' })).body?.results ?? []).map((r: { name: string }) => r.name).sort().join(' | ');
    ok('indexes: ⌘K over the route finds nothing of Finance for opsViewer, opsLead or ed', (await Promise.all(OUTSIDE.map(kOf))).every((n) => n === ''));
    ok('NEGATIVE CONTROL: finViewer finds all of it, the published board and the report that follows its scorecard included',
      (await kOf('finViewer')) === 'FINCANARY Ledger | FINCANARY board | FINCANARY chart | FINCANARY metric | FINCANARY scorecard report', await kOf('finViewer'));

    // ── meaning ──
    const unmeaning = await fingerprinted(W);
    if (unmeaning) {
      const meant = new Map(await Promise.all(EVERYONE.map(async (who) => [who, await byMeaning(W, who)] as const)));
      ok('meaning: "money book" (no word of Finance\'s) finds nothing of Finance for opsViewer, opsLead or ed — items or verified examples', OUTSIDE.every((who) => !FIN.test(meant.get(who)!)), OUTSIDE.map((w) => meant.get(w)!.slice(0, 120)).join(' | '));
      ok('NEGATIVE CONTROL: finViewer and padmin find Finance\'s items and its verified question by meaning', ['finViewer', 'padmin'].every((w) => /FINCANARY metric/.test(meant.get(w as H.Person)!) && /FINCANARY question/.test(meant.get(w as H.Person)!)), meant.get('finViewer')!.slice(0, 300));
      gate.setIndexWhereForTest(false);
      const open = await byMeaning(W, 'opsViewer').finally(() => gate.setIndexWhereForTest(true));
      unmeaning(); // words only again, as the reference answers
      ok('NEGATIVE CONTROL: without the WHERE condition opsViewer finds Finance\'s items by meaning', FIN.test(open), open.slice(0, 200));
    }

    // ── history ──
    const history = async (who: H.Person) => (await W.call(who, 'copilot:history', { projectId: P })).text + (await W.call(who, 'copilot:threads', { projectId: P })).text;
    ok('history: opsViewer\'s conversations about Finance\'s dataset — a chart, an Explain, an SQL answer — held while it was in Everyone, carry no canary now (the answers and their questions are gone, titles untitled)', !CANARIES.test(await history('opsViewer')));
    ok('NEGATIVE CONTROL: finViewer\'s own conversation still names it', FIN.test(await history('finViewer')));
    // Each conversation's count is of the turns its caller is shown (copilotRows listPage, in the page's one query).
    const counts = async (who: H.Person): Promise<Array<[number, number]>> => {
      const threads = ((await W.call(who, 'copilot:threads', { projectId: P })).body?.threads ?? []) as Array<{ id: string; turnCount: number }>;
      return Promise.all(threads.map(async (t) => [t.turnCount, ((await W.call(who, 'copilot:history', { projectId: P, threadId: t.id })).body?.turns ?? []).length] as [number, number]));
    };
    const [opsCounts, finCounts] = [await counts('opsViewer'), await counts('finViewer')];
    ok('history: each of opsViewer\'s conversations counts the turns they are shown — none of the hidden ones', opsCounts.length >= 2 && opsCounts.every(([n, shown]) => n === shown), JSON.stringify(opsCounts));
    ok('NEGATIVE CONTROL: finViewer\'s count every turn of theirs', finCounts.length >= 2 && finCounts.every(([n, shown]) => n === shown && n > 0), JSON.stringify(finCounts));
    gate.setIndexWhereForTest(false);
    const unfiltered = await counts('opsViewer').finally(() => gate.setIndexWhereForTest(true));
    ok('NEGATIVE CONTROL: counted without the folders, opsViewer\'s list would say how many turns are hidden', unfiltered.some(([n, shown]) => n > shown), JSON.stringify(unfiltered));
    await proseChecks(W, prose);
    await joinedChecks(W, joinedThreads);
    await landingChecks(W, prose, fin);

    // ── NEGATIVE CONTROL: the WHERE removed ──
    gate.setIndexWhereForTest(false);
    try {
      const open = await answers(W, 'opsViewer', fin);
      const leaks = open.filter(([, i]) => FIN.test(i)).map(([l]) => l);
      // (Not the verified lookup: a question on a dataset the stores read as missing does not run, so none is shown anyway.)
      ok('NEGATIVE CONTROL: without the WHERE condition opsViewer\'s ⌘K, step 3, spelling and the verified SQL match from the index carry Finance\'s canaries, and differ from the reference',
        ['⌘K "fincanary"', 'step 3 "fincanary"', `spelling "${TYPO}"`, 'verified SQL match'].every((l) => leaks.includes(l)) && open.some(([, i, r]) => i !== r), leaks.join(', '));
      // (Not "Did you mean": its options are read through the stores, which read a closed dataset as missing — a second guard.)
    } finally {
      gate.setIndexWhereForTest(true);
    }

    // ── an older pod's row, and an anchor in another case ──
    const names = async (who: H.Person, q: string) => W.as(who, async () => ((await cmdK.searchIndexed(P, q, await analysis.readsPublishedOnly(P), 20)) ?? []).map((f) => f.name).join(' | '));
    const mine = 'Anchorless Ops chart';
    await W.call('boss', 'visual:save', { projectId: P, datasetId: W.ops.ds, name: mine, chartType: 'bar', encoding: { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] } });
    ok('setup: opsViewer finds an Ops chart by ⌘K', (await names('opsViewer', 'anchorless')) === mine);
    await pool.query('UPDATE search_entries SET anchor_kind = NULL, anchor_id = NULL WHERE project_id = $1 AND name = $2', [P, mine]);
    ok('a ⌘K row with no anchor (an older pod\'s) is not returned to opsViewer', (await names('opsViewer', 'anchorless')) === '');
    ok('NEGATIVE CONTROL: …but is to padmin', (await names('padmin', 'anchorless')) === mine);
    await pool.query('UPDATE search_entries SET anchor_id = upper(anchor_id) WHERE project_id = $1 AND anchor_id = $2', [P, fin.ds]);
    await pool.query('UPDATE assistant_search SET dataset_id = upper(dataset_id) WHERE project_id = $1 AND dataset_id = $2', [P, fin.ds]);
    const upper = await W.as('opsViewer', async () => JSON.stringify(await model.indexedModel(P, 'fincanary', { limit: 12 })));
    ok('an anchor written in another case is still filtered, in ⌘K and in step 3\'s index', !(await names('opsViewer', 'fincanary')) && !FIN.test(upper), upper.slice(0, 200));
    ok('NEGATIVE CONTROL: …and padmin still finds it there', FIN.test(await names('padmin', 'fincanary')));
    await pool.query('DELETE FROM search_sources WHERE project_id = $1', [P]); // both rebuilt on the next search, as written
    await pool.query('DELETE FROM assistant_search_built WHERE project_id = $1', [P]);
  } finally {
    restore();
  }
}
