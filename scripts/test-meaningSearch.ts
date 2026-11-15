// Meaning search (docs/assistant/00-design.md, step 3 and "Scale rules", PR 7c): the fingerprint job
// (src/server/fingerprintJob.ts, ./fingerprintStore.ts) and the merge of words and meaning by rank in step 3's search
// (src/ipc/assistantSearch.ts) and the verified examples (src/ipc/verifiedLookup.ts), against a FAKE embedder: no
// network. The fake gives each text four concepts (its first four words after a small synonym table: "turnover" means
// revenue, and filler concepts of its own), each four of 768 dimensions at 0.25, so every similarity is a multiple of
// 1/16, exact in pgvector and in JS alike: ties are exact, broken by key. One shared concept is 0.25; a stray dimension
// shared by chance is 0.0625. So the fake's least similarity is 0.2 (MEANING_MIN_SIMILARITY below), for this suite only.
//
// Always: no database, no fingerprint request, words only. With DATABASE_URL and pgvector (ORDINATE_EXPECT_PGVECTOR=1
// fails without it; otherwise a skip line):
//   1. THE JOB: fills every item, each row's hash the sha256 of the JS reference text (itemText: the SQL text, natural
//      text with a column's dataset's name, is the reference's), so `region` on two datasets is two fingerprints;
//      batches of at most 100; bounded runs; idempotent (a second run sends nothing); a renamed dataset sends its own
//      text and its columns' only; a text the provider refuses alone is skipped after 3 attempts while the rest go on,
//      and a changed text is tried afresh (NEGATIVE CONTROL: a provider refusing everything records nothing); a model change refingerprints all in the background, the search reads only the new model's rows,
//      the old ones go once it covers the project; a failing provider leaves rows for the next run, logged once by code,
//      never a text; two pods through the jobs claim never send a text twice (NEGATIVE CONTROL: two runs outside it do).
//   2. THE SEARCH: a question sharing no word with an item finds it by meaning; THE DIFFERENTIAL, questions × kinds ×
//      limits × datasets × callers: the index === fuse(words reference, a meaning list by cosine in JS over the stored
//      vectors); a viewer never gets an editor's source table by meaning (NEGATIVE CONTROL: an editor does); a hidden
//      column never comes back (NEGATIVE CONTROL: the admin's does); no model, no pgvector, no fingerprints, a failing
//      embed or a failing query: exactly the words-only answer. A question sharing no word and no meaning gets no item
//      (NEGATIVE CONTROL: a synonym does); an agent's outside-the-topic offer never names a dataset found by meaning
//      alone (NEGATIVE CONTROL: one its words find).
//   3. THE EXAMPLES: meaning brings a differently-worded verified question in; the index === the reference with the JS
//      meaning list; off, the words-only examples. Step 2's exact match stays exact.
//   4. NEGATIVE CONTROL: no model, no request, from the job, a search or the examples.
//   5. The extension in a schema off the search_path: the job and the search still work.
//
//   npm run build:ts && [DATABASE_URL=… ORDINATE_EXPECT_PGVECTOR=1] node scripts/test-meaningSearch.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-meaning-'));
process.env.MEANING_MIN_SIMILARITY = '0.2'; // the fake's floor (see above); read at each question
const MAX_DISTANCE = 0.8;
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');
const { logger }: typeof import('../src/app/logger') = require('../src/app/logger');
const fp: typeof import('../src/ai/fingerprints') = require('../src/ai/fingerprints');
const aiConfig: typeof import('../src/server/aiConfig') = require('../src/server/aiConfig');
const vstore: typeof import('../src/server/vectorStore') = require('../src/server/vectorStore');
const job: typeof import('../src/server/fingerprintJob') = require('../src/server/fingerprintJob');
const runner: typeof import('../src/server/jobs/runner') = require('../src/server/jobs/runner');
const index: typeof import('../src/server/assistantSearchIndex') = require('../src/server/assistantSearchIndex');
const search: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const lookup: typeof import('../src/ipc/verifiedLookup') = require('../src/ipc/verifiedLookup');
const agentAsk: typeof import('../src/ipc/agentAsk') = require('../src/ipc/agentAsk');
import { meaningWorld, WHO, type World } from './meaningWorld';

type Identity = import('../src/server/context').Identity;
type ModelHit = import('../src/ipc/assistantSearch').ModelHit;
type SearchOptions = import('../src/ipc/assistantSearch').SearchOptions;
type ExampleAsk = import('../src/ipc/verifiedLookup').ExampleAsk;
const [[, ADMIN], [, EDITOR], [, VIEWER]] = WHO;

let req = 0;
const as = <T>(who: Identity, P: string | null, fn: () => Promise<T>): Promise<T> =>
  context.runInContext(who, `m${++req}`, async () => {
    if (P && who !== ADMIN) caller.seedRank(P, who === EDITOR ? 2 : 1);
    return fn();
  });

// ── The fake embedder: four distinct dimensions at 0.5 per text, the first four concepts' and then the text's own ──
const SYN: Record<string, string> = { turnover: 'revenue', income: 'revenue', sale: 'revenue', earning: 'revenue', territory: 'region', area: 'region',
  zone: 'region', compensation: 'salary', wage: 'salary', pay: 'salary', client: 'customer', buyer: 'customer' };
const STOP = new Set(['by', 'per', 'the', 'of', 'a', 'an', 'to', 'in', 'every', 'one', 'row', 'where', 'what', 'were', 'last', 'for', 'also', 'called']);
const dim = (s: string): number => crypto.createHash('sha256').update(s).digest().readUInt32BE(0) % 768;
function fake(text: string): Float32Array {
  const concepts = [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map((w) => (w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).map((w) => SYN[w] ?? w))].slice(0, 4);
  for (let i = 0; concepts.length < 4; i++) concepts.push(`${text}#${i}`);
  const dims = new Set<number>();
  for (const c of concepts) for (let j = 0; j < 4; j++) { let d = dim(`${c}/${j}`); while (dims.has(d)) d = (d + 1) % 768; dims.add(d); }
  const v = new Float32Array(768);
  for (const d of dims) v[d] = 0.25;
  return v;
}
interface Call { texts: string[]; purpose?: string }
let calls: Call[] = [];
let failOn: ((call: number, purpose?: string) => string | null) | null = null;
/** Refuse (400) any request holding a text this matches, as a provider refuses one text it will not take. */
let refuse: ((text: string) => boolean) | null = null;
(fp as { fingerprint: unknown }).fingerprint = async (texts: readonly string[], pick: unknown, o: { purpose?: string } = {}) => {
  if (!pick) return { ok: false, errorType: 'off', message: 'off' };
  calls.push({ texts: [...texts], purpose: o.purpose });
  await new Promise((r) => setImmediate(r)); // a real provider answers later: concurrent runs interleave
  const failed = failOn?.(calls.length, o.purpose);
  if (failed) return { ok: false, errorType: failed, message: failed, status: failed === 'rate_limit' ? 429 : undefined };
  if (refuse && texts.some(refuse)) return { ok: false, errorType: 'provider', message: 'refused', status: 400 };
  if (texts.length > fp.FINGERPRINT_BATCH) throw new Error('fake: more than a batch');
  return { ok: true, vectors: texts.map(fake) };
};
let pick: { provider: 'openai' | 'gateway'; model: string } | null = null;
(aiConfig as { currentFingerprintModel: unknown }).currentFingerprintModel = () => pick;
const A = { provider: 'openai' as const, model: 'text-embedding-3-small' };
const B = { provider: 'openai' as const, model: 'text-embedding-3-large' };
const modelOf = (p: { provider: string; model: string }): string => `${p.provider}:${p.model}`;
let fetched = 0;
globalThis.fetch = (async () => { fetched++; throw new Error('no network in this suite'); }) as typeof fetch;
const warned: string[] = [];
const realWarn = logger.warn;
logger.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };

const sent = (): string[] => calls.filter((c) => c.purpose === 'document').flatMap((c) => c.texts);
const sha = (t: string): string => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const run = (most?: number): Promise<boolean> => as(ADMIN, null, () => job.fingerprintOrg(Infinity, most));
async function runAll(): Promise<number> {
  const before = sent().length;
  for (let i = 0; i < 20 && (await run()); i++);
  return sent().length - before;
}

function same(a: readonly ModelHit[] | null, b: readonly ModelHit[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i] as unknown as Record<string, unknown>;
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => Object.is((x as unknown as Record<string, unknown>)[k], y[k]));
  });
}
const names = (hs: readonly ModelHit[] | null): string[] => (hs ?? []).map((h) => `${h.kind}:${h.name}`);

/** Every fingerprint of `model` in the project, read back: item → vector. */
async function stored(pool: Pool, P: string, model: string): Promise<Map<string, Float32Array>> {
  const r = await pool.query('SELECT item, embedding::text AS e FROM assistant_search_vectors WHERE project_id = $1 AND model = $2', [P, model]);
  return new Map(r.rows.map((x: { item: string; e: string }) => [x.item, Float32Array.from(JSON.parse(x.e) as number[])]));
}
/** The JS meaning list's distances: cosine over the stored vectors, the question's by the fake. */
function cosineOf(vectors: Map<string, Float32Array>, question: string): (item: string) => number | undefined {
  const q = fake(question);
  return (item) => {
    const v = vectors.get(item);
    if (!v) return undefined;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < 768; i++) { dot += q[i] * v[i]; na += q[i] * q[i]; nb += v[i] * v[i]; }
    return 1 - dot / Math.sqrt(na * nb);
  };
}
const nearIds = (vectors: Map<string, Float32Array>, question: string): string[] => {
  const d = cosineOf(vectors, question);
  return [...vectors.keys()].filter((k) => k.startsWith('verified:')).map((k) => ({ k, d: d(k) as number })).filter((x) => x.d <= MAX_DISTANCE)
    .sort((x, y) => x.d - y.d || (x.k < y.k ? -1 : 1)).slice(0, 50).map((x) => x.k.slice(9));
};

const QUESTIONS = ['turnover', 'turnover per territory', 'revenue by region', 'compensation', 'clients', 'pay', 'income ledger', 'online orders', 'margin', 'region', 'zebra giraffe', 'zzz', ''];
const KINDS: Array<SearchOptions['kinds']> = [undefined, ['column'], ['metric', 'term'], ['dataset', 'table']];

async function differential(pool: Pool, w: World, label: string, flip = false): Promise<boolean> {
  const vectors = await stored(pool, w.P, modelOf(pick!));
  if (vectors.size === 0) return false; // nothing fingerprinted: the comparison would be words against words
  const cosine = (v: Map<string, Float32Array>, q: string) => { const d = cosineOf(v, q); return flip ? (k: string) => { const x = d(k); return x === undefined ? x : 1 - x; } : d; };
  const unequal: string[] = [];
  const within: Array<Partial<SearchOptions>> = [{}, { datasetIds: [w.orders] }, { exceptDatasetIds: [w.orders] }];
  for (const [who, id] of WHO) for (const q of QUESTIONS) for (const kinds of KINDS) for (const limit of [1, 12, 60]) for (const on of within) {
    const o: SearchOptions = { limit, ...(kinds ? { kinds } : {}), ...on };
    const [r, i] = [await as(id, w.P, () => search.referenceModel(w.P, q, o, { distance: cosine(vectors, q), maxDistance: MAX_DISTANCE })), await as(id, w.P, () => search.indexedModel(w.P, q, o))];
    if (!same(r, i)) unequal.push(`${label} ${who} "${q}" ${JSON.stringify(o)}: ${JSON.stringify(names(r))} vs ${JSON.stringify(names(i))}`);
  }
  if (unequal.length) console.log(unequal.slice(0, 4).join('\n'));
  return unequal.length === 0;
}

/** Words only: the index is today's answer, the reference's without meaning, for every question and caller. */
async function wordsOnly(w: World): Promise<boolean> {
  for (const [, id] of WHO) for (const q of QUESTIONS) for (const limit of [1, 12]) {
    const [r, i] = [await as(id, w.P, () => search.referenceModel(w.P, q, { limit })), await as(id, w.P, () => search.indexedModel(w.P, q, { limit }))];
    if (!same(r, i)) return false;
  }
  return true;
}

const ASKS = (w: World): ExampleAsk[] => [{ question: 'turnover per territory' }, { question: 'turnover per territory', datasetId: w.orders },
  { question: 'clients by city', datasetId: w.customers }, { question: 'orders by month', first: new Set([w.customers]) }, { question: 'zzz' }];
const ex = (a: ExampleAsk, w: World) => as(ADMIN, w.P, () => lookup.indexedExamples(w.P, a));

async function jobLeg(pool: Pool, w: World): Promise<void> {
  const { P } = w;
  const expected = new Map(await as(ADMIN, P, () => search.referenceTexts(P)));
  for (const q of w.verified) expected.set(`verified:${q.id}`, lookup.questionText(q.question));
  pick = A;
  ok('fixture: more than one batch of items', expected.size > fp.FINGERPRINT_BATCH, expected.size);
  ok('a bounded run: 7 texts, then it says there is more', (await run(7)) === true && sent().length === 7);
  const filled = await runAll();
  const rows = new Map((await pool.query('SELECT item, text_hash FROM assistant_search_vectors WHERE project_id = $1 AND model = $2', [P, modelOf(A)])).rows.map((r: { item: string; text_hash: string }) => [r.item, r.text_hash]));
  const wrong = [...expected].filter(([k, t]) => rows.get(k) !== sha(t)).map(([k]) => k);
  ok('THE JOB fills every item and question, each row the sha256 of the JS reference text (ITEM_TEXT === itemText)', rows.size === expected.size && wrong.length === 0, { rows: rows.size, expected: expected.size, wrong: wrong.slice(0, 3) });
  ok('…sending each text once, in batches of at most 100, as documents', filled + 7 === expected.size && new Set(sent()).size === new Set(expected.values()).size
    && calls.every((c) => c.texts.length <= 100 && c.purpose === 'document'), { filled, sizes: calls.map((c) => c.texts.length) });
  const region = [...expected].filter(([k]) => /^column:.*\/region$/.test(k));
  ok('natural text: a column is its dataset\'s name, its own, its other names and its description', expected.get(`column:${w.orders}/region`) === 'Online orders · region — also called Sales region, territory — Where the order shipped'
    && region.length === 2 && rows.get(region[0][0]) !== rows.get(region[1][0]), region);
  calls = [];
  ok('idempotent: a second run sends nothing', (await run()) === false && calls.length === 0);
  await w.rename(w.customers, 'Clients');
  await run();
  ok('a dataset renamed: its own text and its 3 columns\' are sent again, nothing else', sent().length === 4 && sent().every((t) => t.startsWith('Clients')), sent());

  // A model change: in the background, the search reads only the new model's rows meanwhile
  calls = [];
  pick = B;
  ok('a new model with no rows yet: words only, and no request', (await wordsOnly(w)) && calls.length === 0);
  await run(5);
  const bRows = await stored(pool, P, modelOf(B));
  const near = await as(ADMIN, P, async () => index.nearestPage(P, ['turnover'], { audiences: ['all', 'editor'] }, { model: modelOf(B), literal: vstore.vectorLiteral(fake('turnover')), place: (await vstore.vectorPlace())!, maxDistance: 1 }, 50, recordFs.rowsUnder));
  ok('…part way, the nearest items are only those the new model has fingerprinted (5), though the old model has them all', bRows.size === 5 && near?.length === 5
    && (await stored(pool, P, modelOf(A))).size === expected.size, { b: bRows.size, near: near?.length });
  await runAll();
  ok('…once it covers the project, the old model\'s rows are gone and every item has the new one\'s', (await stored(pool, P, modelOf(A))).size === 0 && (await stored(pool, P, modelOf(B))).size === expected.size);

  // A failing provider: the rest is left for the next run, logged once by its code
  pick = A;
  calls = [];
  warned.length = 0;
  failOn = (n) => (n >= 2 ? 'rate_limit' : null);
  ok('a provider failing on the second batch: the run stops', (await run()) === false && calls.length === 2);
  ok('…the first batch is saved, the rest is not', (await stored(pool, P, modelOf(A))).size === 100);
  await run();
  const lines = warned.filter((l) => l.includes('[fingerprints]'));
  ok('…logged once, by its code, never a text', lines.length === 1 && lines[0].includes('rate_limit') && ![...expected.values()].some((t) => t.length > 3 && lines[0].includes(t)), lines);
  failOn = null;
  calls = [];
  await runAll();
  ok('…and the next run sends exactly what was left', sent().length === expected.size - 100 && (await stored(pool, P, modelOf(A))).size === expected.size && (await stored(pool, P, modelOf(B))).size === 0);
  const failures = async (model: string): Promise<number[]> => (await pool.query('SELECT attempts FROM assistant_search_vector_failures WHERE project_id = $1 AND model = $2 ORDER BY item', [P, model])).rows.map((r: { attempts: number }) => r.attempts);
  ok('NEGATIVE CONTROL: a transient failure (429) is held against no text: retried, nothing recorded', (await failures(modelOf(A))).length === 0);
  await poisonLeg(pool, w, expected.size, failures);

  // Two pods: the jobs claim (FOR UPDATE SKIP LOCKED, a lease) lets one run the org's job
  pick = { provider: 'gateway', model: 'pods/c' };
  calls = [];
  await pool.query(`INSERT INTO jobs (org_id, kind, next_run_at) VALUES ('acme', $1, now()) ON CONFLICT DO NOTHING`, [job.FINGERPRINT_JOB]);
  const quiet = { warn: () => undefined, error: () => undefined, info: () => undefined } as unknown as import('fastify').FastifyBaseLogger;
  const pod = async (): Promise<number> => { let n = 0; for (let c = await runner.claimOne(pool, [job.FINGERPRINT_JOB]); c; c = await runner.claimOne(pool, [job.FINGERPRINT_JOB])) { n++; await runner.runClaim(pool, c, quiet); } return n; };
  const runs = await Promise.all([pod(), pod()]);
  ok('two pods: one claims the org\'s run, and every text is sent exactly once', runs[0] + runs[1] === 1 && sent().length === expected.size && new Set(sent()).size === new Set(expected.values()).size, { runs, sent: sent().length });
  pick = { provider: 'gateway', model: 'pods/d' };
  calls = [];
  await Promise.all([run(), run()]);
  ok('NEGATIVE CONTROL: two runs outside the claim send texts twice', sent().length > expected.size, sent().length);
  pick = A;
  await runAll(); // the last model covered the project, so A's rows went: A again for the legs below
  calls = [];
}

/** One text the provider always refuses: the rest go on; after 3 attempts it is skipped; renamed, it goes. */
async function poisonLeg(pool: Pool, w: World, total: number, failures: (model: string) => Promise<number[]>): Promise<void> {
  const { P } = w;
  refuse = (t) => /poison/i.test(t);
  pick = { provider: 'gateway', model: 'poison/1' };
  calls = [];
  warned.length = 0;
  await runAll();
  ok('a text refused alone (two: "Poison data" and its column) does not stop the others', (await stored(pool, P, modelOf(pick))).size === total - 2
    && JSON.stringify(await failures(modelOf(pick))) === '[1,1]', await failures(modelOf(pick)));
  await run();
  await run();
  const lines = warned.filter((l) => l.includes('skipped'));
  ok('…after 3 attempts each is skipped, logged once by its code, never the text', JSON.stringify(await failures(modelOf(pick))) === '[3,3]' && lines.length === 1 && !lines[0].includes('oison'), lines);
  calls = [];
  ok('…and a later run sends nothing for them', (await run()) === false && calls.length === 0);
  await w.rename(w.poison, 'Antidote data');
  await run();
  ok('a changed text gets fresh attempts: renamed, both are sent and taken', (await stored(pool, P, modelOf(pick))).size === total && sent().every((t) => t.startsWith('Antidote')), sent());
  await w.rename(w.poison, 'Poison data');
  refuse = () => true;
  pick = { provider: 'gateway', model: 'refuses/everything' };
  calls = [];
  ok('NEGATIVE CONTROL: a provider refusing every text: the run stops after a batch and 3 alone, and holds nothing against a text',
    (await run()) === false && calls.length === 4 && (await failures(modelOf(pick))).length === 0, calls.length);
  refuse = null;
  pick = A;
  await runAll();
}

async function searchLeg(pool: Pool, w: World): Promise<void> {
  const { P } = w;
  const words1 = await as(ADMIN, P, () => search.referenceModel(P, 'turnover', { limit: 5 }));
  const meant = await as(ADMIN, P, () => search.searchModel(P, 'turnover', { limit: 5 }));
  ok('a question sharing no word with an item finds it by meaning: "turnover" → the Revenue metric (words alone: nothing)', words1.length === 0 && names(meant).includes('metric:Revenue'), names(meant));
  ok('…the question is fingerprinted as a query', calls.some((c) => c.purpose === 'query' && c.texts[0] === 'turnover'));
  ok('THE DIFFERENTIAL: index === fuse(words reference, JS cosine over the stored vectors), every question × kinds × limit × datasets × caller', await differential(pool, w, 'meaning'));
  ok('NEGATIVE CONTROL: the reference with its meaning list reversed makes the differential FAIL', !(await differential(pool, w, 'reversed (expected)', true)));
  const tables = async (who: Identity) => (await as(who, P, () => search.searchModel(P, 'turnover', { limit: 60 }))).filter((h) => h.kind === 'table').map((h) => h.name);
  ok('a viewer never gets a source table by meaning; an editor does (NEGATIVE CONTROL)', (await tables(VIEWER)).length === 0 && (await tables(EDITOR)).includes('ANALYTICS.INCOME_LEDGER'));
  const salary = async (who: Identity) => (await as(who, P, () => search.searchModel(P, 'compensation', { limit: 60 }))).map((h) => `${h.kind}:${h.id}`);
  ok('a hidden column never comes back by meaning; the admin\'s does (NEGATIVE CONTROL)', !(await salary(VIEWER)).includes('column:salary') && (await salary(ADMIN)).includes('column:salary'));
  ok('…nor a metric on it', !(await as(VIEWER, P, () => search.searchModel(P, 'compensation', { limit: 60 }))).some((h) => h.name === 'Payroll'));
  ok('a question sharing no word and no meaning gets no item at all (every one under the least similarity)', (await as(ADMIN, P, () => search.searchModel(P, 'zebra giraffe', { limit: 60 }))).length === 0);
  ok('NEGATIVE CONTROL: a synonym does: "turnover" gets items its words do not', (await as(ADMIN, P, () => search.searchModel(P, 'turnover', { limit: 60 }))).length > 0);
  const outside = new Set([w.customers]);
  const byMeaning = await as(ADMIN, P, () => search.searchModel(P, 'turnover', { kinds: ['dataset', 'column', 'metric', 'term'], limit: 60, exceptDatasetIds: [...outside] }));
  ok('an agent\'s outside-the-topic offer never names a dataset found by meaning alone (its search finds some)', byMeaning.some((h) => h.datasetId === w.orders && h.score === 0)
    && (await as(ADMIN, P, () => agentAsk.matchOutside(P, 'turnover', outside, async () => true))) === null);
  ok('NEGATIVE CONTROL: one its words find is offered', (await as(ADMIN, P, () => agentAsk.matchOutside(P, 'revenue', outside, async () => true)))?.id === w.orders);

  // Words only, exactly
  const saved = pick;
  pick = null;
  calls = [];
  ok('no model: exactly the words-only answer, and no request', (await wordsOnly(w)) && calls.length === 0);
  pick = saved;
  const place = vstore.vectorPlace;
  (vstore as { vectorPlace: unknown }).vectorPlace = async () => null;
  ok('no pgvector: exactly the words-only answer, and no request', (await wordsOnly(w)) && calls.length === 0);
  (vstore as { vectorPlace: unknown }).vectorPlace = place;
  warned.length = 0;
  failOn = (_n, purpose) => (purpose === 'query' ? 'network' : null);
  ok('a failing embed: exactly the words-only answer', await wordsOnly(w));
  failOn = null;
  const nearest = index.nearestPage;
  (index as { nearestPage: unknown }).nearestPage = async () => { throw Object.assign(new Error('down'), { code: '57P01' }); };
  ok('a failing nearest query: exactly the words-only answer', await wordsOnly(w));
  (index as { nearestPage: unknown }).nearestPage = nearest;
  const lines = warned.filter((l) => l.includes('[meaning search]'));
  ok('…logged once, by its code, never the question', lines.length === 1 && lines[0].includes('network') && !lines[0].includes('turnover'), lines);
}

async function examplesLeg(pool: Pool, w: World): Promise<void> {
  const rbr = w.verified.find((q) => q.question === 'Revenue by region')!;
  const on = await ex({ question: 'turnover per territory' }, w);
  pick = null;
  const off = await ex({ question: 'turnover per territory' }, w);
  ok('meaning brings a differently-worded verified question into the examples; words alone leave it out (the oldest)', !!on?.ids.includes(rbr.id) && !!off && !off.ids.includes(rbr.id), JSON.stringify({ rbr: rbr.id, on: on?.ids, off: off?.ids, lines: on?.lines }));
  ok('off: the index\'s examples are the words-only reference\'s', (await Promise.all(ASKS(w).map(async (a) => {
    const [i, r] = [await ex(a, w), await as(ADMIN, w.P, () => lookup.referenceExamples(w.P, a))];
    return !!i && i.ids.join() === r.ids.join() && i.lines.join('\n') === r.lines.join('\n');
  }))).every(Boolean));
  pick = A;
  const vectors = await stored(pool, w.P, modelOf(A));
  const unequal: string[] = [];
  for (const a of ASKS(w)) {
    const [i, r] = [await ex(a, w), await as(ADMIN, w.P, () => lookup.referenceExamples(w.P, a, nearIds(vectors, a.question)))];
    if (!i || i.ids.join() !== r.ids.join() || i.lines.join('\n') !== r.lines.join('\n')) unequal.push(`${a.question}: ${i?.ids} vs ${r.ids}`);
  }
  ok('THE DIFFERENTIAL: the examples with meaning === the reference with the JS meaning list', unequal.length === 0, unequal);
  ok('step 2 stays exact: a question near a verified one by meaning is no hit', (await as(ADMIN, w.P, () => lookup.verifiedHit(w.P, 'turnover per territory', null))) === null);
}

async function offLeg(w: World): Promise<void> {
  pick = null;
  calls = [];
  const ran = await run();
  await as(VIEWER, w.P, () => search.searchModel(w.P, 'turnover', { limit: 12 }));
  await ex({ question: 'turnover per territory' }, w);
  ok('NEGATIVE CONTROL: no model, no request — the job, a search and the examples send nothing (fetch neither)', ran === false && calls.length === 0 && fetched === 0);
  pick = A;
}

async function schemaLeg(pool: Pool, w: World): Promise<void> {
  await pool.query('CREATE SCHEMA "vec ext"; ALTER EXTENSION vector SET SCHEMA "vec ext"');
  await vstore.vectorStatus(0); // the place is read again
  pick = B;
  calls = [];
  await runAll();
  ok('the extension in a schema off the search_path: the job saves through the qualified type', (await stored(pool, w.P, modelOf(B))).size > 0 && sent().length > 0);
  ok('…and the search through the qualified operator, as the reference', await differential(pool, w, 'schema'));
}

async function dbLeg(pool: Pool): Promise<void> {
  inOrg.useOrgDb(pool);
  const st = await vstore.vectorStatus(0);
  if (!st.table) {
    if (process.env.ORDINATE_EXPECT_PGVECTOR === '1') ok('pgvector is installed (ORDINATE_EXPECT_PGVECTOR=1)', false, st);
    else console.log(`skip the meaning legs: no pgvector table here (${st.reason})`);
    return;
  }
  const w = await meaningWorld((fn) => as(ADMIN, null, fn));
  await jobLeg(pool, w);
  await searchLeg(pool, w);
  await examplesLeg(pool, w);
  await offLeg(w);
  await schemaLeg(pool, w);
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  search.register();
  job.wireFingerprints();
  pick = A;
  const w = await meaningWorld((fn) => as(ADMIN, null, fn));
  ok('no database: the job sends nothing', (await run()) === false && calls.length === 0);
  ok('no database: the search is the words-only reference, and no request', same(await as(VIEWER, w.P, () => search.searchModel(w.P, 'turnover pay', { limit: 5 })), await as(VIEWER, w.P, () => search.referenceModel(w.P, 'turnover pay', { limit: 5 }))) && calls.length === 0);

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_meaning_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined);
  try {
    await mig.migrate(pool);
    recordFs.useRecordDb(pool);
    await dbLeg(pool);
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('meaning search suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    logger.warn = realWarn;
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
