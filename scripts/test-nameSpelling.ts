// "Did you mean" by SPELLING (docs/assistant/00-design.md, "Spelling", phase C): a name a model's answer says that
// shares no word with any ("Ordrs") is offered the names spelled near it, by pg_trgm's similarity in Postgres (0031)
// and by its JS twin (../src/app/trigram) without it.
//
// Always (no database):
//   1. The JS similarity on pg_trgm's documented values. suggestFixes: word hits keep priority over spelling, a
//      transposed name ("Reveneu") is offered by spelling alone, below MIN_SIMILARITY nothing, a name under 3 letters nothing.
//   2. checkAction on the reference path (records in files): "Ordrs" → Orders; a column hidden from a restricted viewer
//      is never offered to them (NEGATIVE CONTROL: the admin is offered it); nothing near → nothing.
// With DATABASE_URL (a scratch database it may CREATE DATABASE on):
//   3. PARITY: the JS similarity === Postgres similarity() with Object.is on every pair of a corpus of names (accents,
//      ß, digits, Greek, Cyrillic, CJK, a combining mark, punctuation, long names). The migration made the extension
//      and the index, and the probe agrees (../src/server/nameTrigrams).
//   4. THE DIFFERENTIAL: the index's spelling (pg_trgm) === the reference's (every store read), a corpus of typos ×
//      admin and viewer × the whole project and an agent's topic; and the same SQL on every kind against the JS ranking.
//   5. checkAction through the index: "Ordrs" and "Reutrns" offered; NEGATIVE CONTROL: with spelling stubbed out, not
//      (the loss of 6b this removes); the hidden column as in 2; outside a topic, not; a retired dataset, never.
//   6. A C-ctype database: pg_trgm splits "é" otherwise, the probe says so, and spelling is ranked by the reference.
//   7. WITHOUT pg_trgm (DROP EXTENSION in the scratch database): the query reads the names and the reference ranks them:
//      the same answers as 4 and 5, "Ordrs" still offered.
//   8. SHARED FOLDERS (docs/team-folders D13), on pg_trgm and without it: Orders in a folder only admins open: the
//      differential holds for the admin and the viewer, and "Ordrs" offers the viewer nothing. NEGATIVE CONTROLS: the
//      admin is offered Orders; without the WHERE condition the viewer is, and the differential FAILS.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-nameSpelling.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-spelling-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');
const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
import { clearFolders, plantFolder } from './folderFixture';
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const columnAccess: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const search: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const index: typeof import('../src/server/assistantSearchIndex') = require('../src/server/assistantSearchIndex');
const trgm: typeof import('../src/server/nameTrigrams') = require('../src/server/nameTrigrams');
const answerCheck: typeof import('../src/ipc/answerCheck') = require('../src/ipc/answerCheck');
const T: typeof import('../src/app/trigram') = require('../src/app/trigram');
const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const S: typeof import('../src/ai/answerSuggest') = require('../src/ai/answerSuggest');

type Identity = import('../src/server/context').Identity;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const WHO: Array<[string, Identity]> = [['admin', ADMIN], ['viewer', VIEWER]];
const show = (v: unknown): string => JSON.stringify(v);

let req = 0;
const as = <T>(who: Identity, P: string | null, fn: () => Promise<T>): Promise<T> =>
  context.runInContext(who, `s${++req}`, async () => {
    if (P && who === VIEWER) caller.seedRank(P, 1); // what the RPC route seeds from `authorize`
    return fn();
  });

// ── 1. The similarity, and the ranking ──────────────────────────────────────

function pureLeg(): void {
  ok('1. similarity("word", "two words") is pg_trgm\'s documented 0.363636 (4 of 11 trigrams, as float4)', Object.is(T.similarity('word', 'two words'), Math.fround(4 / 11)));
  ok('…"cat" has show_trgm\'s four: "  c", " ca", "cat", "at "', T.trigrams('cat').size === 4 && T.trigrams('CAT!').size === 4 && Object.is(T.similarity('cat', 'CAT!'), 1));
  ok('…case and punctuation separate nothing new: "sales  by" is "Sales by"; nothing in common is 0, nothing at all is 0',
    Object.is(T.similarity('sales  by', 'Sales by'), 1) && Object.is(T.similarity('Orders', 'xyzzy'), 0) && Object.is(T.similarity('', ''), 0) && Object.is(T.similarity('---', 'Orders'), 0));
  const cols = (...names: string[]) => names.map((name) => ({ name, type: 'number' as const }));
  const D = '11111111-1111-4111-8111-111111111111';
  const ledger = { id: D, name: 'Ledger', columns: [{ name: 'region', type: 'text' as const }, ...cols('revenue_adjustments_q3_final', 'nett revenu', 'revenue', 'discount')] };
  const small = { id: D, name: 'Small', columns: [{ name: 'region', type: 'text' as const }, ...cols('net')] };
  const offered = (measure: string, ds: import('../src/ai/answerSpec').SpecDataset = ledger): string[] => {
    const raw = { dataset: ds.name, category: 'region', measures: [measure] };
    const v = A.validateAnswerSpec(raw, [ds], {});
    return !v.ok && v.miss ? S.suggestFixes(raw, v.miss, [ds]).map((o) => o.label) : ['(validated)'];
  };
  ok('…suggestFixes: containment and a shared word keep priority over a nearer spelling, which is offered after them',
    show(offered('net revenue')) === '["revenue","revenue_adjustments_q3_final","nett revenu"]'
    && T.similarity('net revenue', 'nett revenu') > T.similarity('net revenue', 'revenue_adjustments_q3_final'), show(offered('net revenue')));
  ok('…a transposition, no edit apart and no word shared, is offered by its spelling alone, nearest first',
    show(offered('Reveneu')) === '["revenue","nett revenu"]' && T.similarity('Reveneu', 'revenue') > T.similarity('Reveneu', 'nett revenu'), show(offered('Reveneu')));
  ok('…below MIN_SIMILARITY nothing ("regoin" is 0.27 from "region")', offered('regoin').length === 0 && T.similarity('regoin', 'region') < T.MIN_SIMILARITY, show(offered('regoin')));
  ok('…a name under 3 letters nothing, though "ne" is 0.4 from "net" (negative control: "nex" is offered net)',
    offered('ne', small).length === 0 && T.similarity('ne', 'net') >= T.MIN_SIMILARITY && show(offered('nex', small)) === '["net"]', show([offered('ne', small), offered('nex', small)]));
}

// ── The world: built twice, into files (2) and into Postgres (4 on) ─────────

interface World { P: string; orders: string; returns: string; stores: string; retired: string }

async function world(): Promise<World> {
  return as(ADMIN, null, async () => {
    await projects.init();
    const P = (await projects.createProject('Spelling'))!.id;
    const num = (name: string) => ({ name, type: 'number' as const });
    const txt = (name: string) => ({ name, type: 'text' as const });
    const save = async (name: string, columns: Array<{ name: string; type: 'text' | 'number' }>) =>
      (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns, rows: [columns.map((c) => (c.type === 'number' ? 1 : 'x'))] as never }))!.id;
    const orders = await save('Orders', [txt('region'), num('amount'), txt('customer'), num('revenue'), num('discount')]);
    await save('Order lines', [txt('sku'), num('quantity'), txt('region')]);
    const returns = await save('Returns', [txt('reason'), num('refunds')]);
    const stores = await save('Stores', [txt('city'), num('sales')]);
    for (const n of ['Customer data', 'Café crème', 'Zürich 2024', 'Sales 2024', 'Q3-2024 forecast', 'Москва', 'Straße 7', '東京 売上']) await save(n, [txt('label'), num('value')]);
    const retired = await save('Budget old', [txt('line'), num('plan')]);
    await catalog.updateStatus(P, (s) => { s[`dataset:${retired}`] = { status: 'retired', by: 'ana@acme.test', at: '', note: '' }; });
    await metrics.saveMetric(P, { name: 'Revenue', datasetId: orders, definition: { column: 'revenue', aggregation: 'sum' } });
    await terms.saveTerm(P, { name: 'West coast', aliases: [], datasetId: orders, filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] });
    await record.serialized(record.datasetFilePath(P, orders), (raw) => {
      raw.columnAccess = columnAccess.buildColumnAccess(raw, [{ column: 'discount', visibleTo: [{ userId: '33333333-3333-4333-8333-333333333333' }] }], 'ana@acme.test', new Date().toISOString());
      return true;
    });
    return { P, orders, returns, stores, retired };
  });
}

const check = (w: World, spec: Record<string, unknown>, only?: ReadonlySet<string>) =>
  answerCheck.checkAction(w.P, {}, { kind: 'answer', intent: 'q', spec }, 'q', undefined, undefined, only);
const options = async (who: Identity, w: World, spec: Record<string, unknown>, only?: ReadonlySet<string>): Promise<string[]> => {
  const r = await as(who, w.P, () => recordFs.withReadMemo(() => check(w, spec, only)));
  return r.ok ? ['(ok)'] : (r.suggest?.options ?? []).map((o) => `${o.label}${o.spec.datasetId === w.orders ? '@orders' : ''}`);
};
const BY = (dataset: string, measure = 'amount') => ({ dataset, category: 'region', measures: [{ column: measure, aggregation: 'sum' }] });

/** "Did you mean" as a person sees it: the cases 2, 5 and 7 hold. */
async function suggestions(w: World, where: string): Promise<void> {
  ok(`${where}: "Ordrs" (no word shared) → Orders`, show(await options(ADMIN, w, BY('Ordrs'))) === '["Orders@orders"]', show(await options(ADMIN, w, BY('Ordrs'))));
  ok(`${where}: "Reutrns" (a transposition) → Returns`, show(await options(ADMIN, w, { dataset: 'Reutrns', category: 'reason', measures: ['sum(refunds)'] })) === '["Returns"]');
  ok(`${where}: a measure "dicsount": the admin is offered discount (NEGATIVE CONTROL), the viewer it is hidden from nothing`,
    show(await options(ADMIN, w, BY('Orders', 'dicsount'))) === '["discount@orders"]' && show(await options(VIEWER, w, BY('Orders', 'dicsount'))) === '[]',
    show([await options(ADMIN, w, BY('Orders', 'dicsount')), await options(VIEWER, w, BY('Orders', 'dicsount'))]));
  ok(`${where}: nothing near → nothing ("Xyzzy", "Bdgt")`, (await options(ADMIN, w, BY('Xyzzy'))).length === 0 && (await options(ADMIN, w, BY('Bdgt'))).length === 0);
}

// ── 3. Parity with Postgres ─────────────────────────────────────────────────

const NAMES = [
  'Orders', 'Ordrs', 'Order lines', 'order-lines', 'Revenue', 'Reveneu', 'region', 'regon', 'regoin', 'customer', 'cutomer',
  'sales  by region', 'Sales by region', 'Sales 2024', 'sales_2025', 'Q3-2024 forecast', 'q3 2024 forcast', '2024', '٣٤٥ sales',
  'Café crème', 'CAFE CREME', 'Crème brûlée', 'Straße', 'STRASSE', 'Zürich', 'ZURICH', 'naïve', 'Ñandú', 'København', 'Ærø',
  'école', 'école', 'İstanbul', 'ISTANBUL', 'ΟΔΟΣ', 'οδός', 'Москва', 'москва', '東京都', '東京', 'データ 2024', '東京 売上',
  "O'Brien & Co.", 'obrien co', '#tag @user 100%', '---', '', '   ', 'x', 'ab', 'a b c', '🙂 sales', 'Customer data', 'Returns',
  'Reutrns', 'x'.repeat(300), `${'Long name '.repeat(20)}end`,
];

async function parityLeg(pool: Pool): Promise<void> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < NAMES.length; i++) for (let j = i; j < NAMES.length; j++) pairs.push([NAMES[i], NAMES[j]]);
  const r = await pool.query<{ s: number }>('SELECT similarity(a, b)::float8 AS s FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS u(a, b, n) ORDER BY n', [pairs.map((p) => p[0]), pairs.map((p) => p[1])]);
  const differ = pairs.filter(([a, b], i) => !Object.is(r.rows[i]?.s, T.similarity(a, b))).map(([a, b]) => `${show(a)} ~ ${show(b)}`);
  const near = pairs.filter(([a, b]) => a !== b && T.similarity(a, b) >= T.MIN_SIMILARITY).length;
  ok(`3. PARITY: the JS similarity === Postgres similarity(), Object.is on every one of ${pairs.length} pairs (${near} of them near)`, pairs.length >= 200 && differ.length === 0 && r.rows.length === pairs.length, differ.slice(0, 10).join('\n'));
  // show_trgm prints a trigram as its three characters, or one it hashed (multibyte) as 0x and its three bytes.
  const shown = await pool.query<{ t: string[] }>('SELECT show_trgm(a) AS t FROM unnest($1::text[]) WITH ORDINALITY AS u(a, n) ORDER BY n', [NAMES]);
  const asCode = (t: string): number => (/^0x[0-9a-f]{6}$/.test(t) ? parseInt(t.slice(2), 16) : [...Buffer.from(t, 'latin1')].reduce((n, b) => (n << 8) | b, 0));
  const sorted = (xs: Iterable<number>): string => show([...xs].sort((a, b) => a - b));
  const unlike = NAMES.filter((n, i) => sorted(shown.rows[i].t.map(asCode)) !== sorted(T.trigrams(n)));
  const hashed = shown.rows.reduce((k, r) => k + r.t.filter((t) => t.startsWith('0x')).length, 0);
  ok(`…every name\'s trigrams are show_trgm\'s, byte for byte: ${hashed} of them multibyte, hashed by the legacy CRC-32`, unlike.length === 0 && hashed > 50, unlike.map(show).join(', '));
  const made = (await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS ext, to_regclass('assistant_search_name_trgm') IS NOT NULL AS ix`)).rows[0];
  ok('…the migration made the extension and the trigram index', made.ext === true && made.ix === true, show(made));
  ok('…and the probe agrees: spelling runs on pg_trgm here', !!(await trgm.trgmPlace(0)));
}

// ── 4. The differential ─────────────────────────────────────────────────────

const TYPOS = ['Ordrs', 'Reutrns', 'Reveneu', 'regon', 'cutomer', 'sales  by', 'Cafe creme', 'zurich 2024', 'Strasse', 'sales 2025', 'q3 2024 forcast',
  'Inventory', 'xyzzy', '', 'ab', 'CUSTOMER DATA', 'Ödrers', '2024', 'Budget old', 'Москв', 'Order', '東京', 'west cost', 'revnue'];

/** Every typo × who × scope, through `fn`: what must be Object.is-equal across the paths. */
async function answersOf(w: World, fn: (said: string, o: import('../src/ipc/assistantSearch').SpellOptions) => Promise<unknown>): Promise<string[]> {
  const out: string[] = [];
  for (const [who, id] of WHO) for (const only of [undefined, [w.orders, w.stores, w.returns]]) for (const said of TYPOS) {
    out.push(`${who} ${only ? 'topic' : 'all'} ${show(said)}: ${show(await as(id, w.P, () => fn(said, { limit: 20, ...(only ? { datasetIds: only } : {}) })))}`);
  }
  return out;
}
/** The same SQL on every kind, by hand: what the JS ranking over the rows it reads (7) must equal. */
async function everyKind(w: World): Promise<string[]> {
  const out: string[] = [];
  for (const said of TYPOS) out.push(`${show(said)}: ${show(await as(ADMIN, w.P, () => index.speltPage(w.P, said, { audiences: ['all', 'editor'] }, 20, recordFs.rowsUnder)))}`);
  return out;
}

async function differentialLeg(w: World): Promise<{ spelt: string[]; kinds: string[] }> {
  const [indexed, reference] = [await answersOf(w, (s, o) => search.indexedSpelling(w.P, s, o)), await answersOf(w, (s, o) => search.referenceSpelling(w.P, s, o))];
  const unequal = indexed.filter((x, i) => !Object.is(x, reference[i]));
  ok(`4. THE DIFFERENTIAL: the index's spelling (pg_trgm) === the reference's, ${indexed.length} answers: ${TYPOS.length} typos × admin, viewer × project, topic`, unequal.length === 0 && indexed.length === reference.length, unequal.map((x, i) => `${x}\n   vs ${reference[indexed.indexOf(x)] ?? i}`).join('\n'));
  ok('…NEGATIVE CONTROL: it can tell them apart (Orders for "Ordrs", nothing for "xyzzy", no retired dataset, a topic narrows)',
    indexed.some((x) => x.startsWith('admin all "Ordrs"') && x.includes(`"id":"${w.orders}"`)) && indexed.some((x) => x.startsWith('admin all "xyzzy": []'))
    && !indexed.some((x) => x.includes(w.retired)) && indexed.some((x) => x.startsWith('admin topic "Cafe creme": []')) && indexed.some((x) => x.startsWith('admin all "Cafe creme"') && x.includes('Café crème')), indexed.filter((x) => /Ordrs|xyzzy|Cafe/.test(x)).join('\n'));
  const kinds = await everyKind(w);
  ok('…the query on every kind finds columns, metrics and terms by their spelling too ("cutomer", "revnue", "west cost")',
    kinds.some((x) => x.startsWith('"cutomer"') && x.includes('"kind":"column"')) && kinds.some((x) => x.startsWith('"revnue"') && x.includes('"kind":"metric"')) && kinds.some((x) => x.startsWith('"west cost"') && x.includes('"kind":"term"')), kinds.join('\n'));
  return { spelt: indexed, kinds };
}

/** 5. Through checkAction, on the index. */
async function indexedLeg(w: World): Promise<void> {
  await suggestions(w, '5. index');
  ok('…outside an agent\'s topic a near dataset is not offered; inside it, it is (negative control)',
    (await options(ADMIN, w, BY('Ordrs'), new Set([w.stores]))).length === 0 && show(await options(ADMIN, w, BY('Ordrs'), new Set([w.stores, w.orders]))) === '["Orders@orders"]');
  ok('…a retired dataset is never offered ("Budget olds")', (await options(ADMIN, w, { dataset: 'Budget olds', category: 'line', measures: ['sum(plan)'] })).length === 0);
  const real = search.spellModel;
  (search as { spellModel: unknown }).spellModel = async () => [];
  try {
    ok('…NEGATIVE CONTROL: with spelling stubbed out, "Ordrs" is offered nothing on the index (the loss spelling removes)', (await options(ADMIN, w, BY('Ordrs'))).length === 0);
  } finally {
    (search as { spellModel: unknown }).spellModel = real;
  }
}

/** 8. Orders in a folder only admins open, on whichever path the database takes (`label`). */
async function folderLeg(pool: Pool, w: World, label: string): Promise<void> {
  await plantFolder(pool, w.P, { name: 'Finance', items: [['dataset', w.orders]] });
  try {
    const differs = async (): Promise<string[]> => {
      const [indexed, reference] = [await answersOf(w, (s, o) => search.indexedSpelling(w.P, s, o)), await answersOf(w, (s, o) => search.referenceSpelling(w.P, s, o))];
      return indexed.filter((x, i) => !Object.is(x, reference[i]));
    };
    const unequal = await differs();
    ok(`8. folders (${label}): the differential holds for the admin and the viewer`, unequal.length === 0, unequal.join('\n'));
    const offered = async (who: Identity) => show(await as(who, w.P, () => search.spellModel(w.P, 'Ordrs', { limit: 20 })));
    ok(`…"Ordrs" offers the viewer nothing of Orders (${label})`, !(await offered(VIEWER)).includes(w.orders));
    ok(`…NEGATIVE CONTROL: the admin is offered Orders (${label})`, (await offered(ADMIN)).includes(w.orders));
    gate.setIndexWhereForTest(false);
    try {
      ok(`…NEGATIVE CONTROL: without the WHERE condition the viewer is offered Orders, and the differential FAILS (${label})`, (await offered(VIEWER)).includes(w.orders) && (await differs()).length > 0);
    } finally {
      gate.setIndexWhereForTest(true);
    }
  } finally {
    await clearFolders(pool, w.P);
  }
}

/** 6. A C-ctype database: pg_trgm treats "é" as no letter, so the probe refuses it. */
async function cTypeLeg(adminUrl: string, admin: Client, pool: Pool): Promise<void> {
  const name = `ordinate_spelling_c_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  const u = new URL(adminUrl);
  u.pathname = '/' + name;
  const c = new Pool({ connectionString: u.toString(), max: 2 });
  c.on('error', () => undefined);
  try {
    await c.query('CREATE EXTENSION pg_trgm');
    const sim = async (p: Pool): Promise<number> => (await p.query<{ s: number }>(`SELECT similarity('Café crème', 'CAFE creme')::float8 AS s`)).rows[0].s;
    const [inC, inUtf8] = [await sim(c), await sim(pool)];
    inOrg.useOrgDb(c);
    const place = await trgm.trgmPlace(0);
    inOrg.useOrgDb(pool);
    ok('6. a C-ctype database splits "Café crème" otherwise than the reference, and the probe refuses its pg_trgm',
      !Object.is(inC, T.similarity('Café crème', 'CAFE creme')) && Object.is(inUtf8, T.similarity('Café crème', 'CAFE creme')) && place === null, show([inC, inUtf8, place]));
    ok('…NEGATIVE CONTROL: the UTF-8 database\'s it takes', !!(await trgm.trgmPlace(0)));
  } finally {
    inOrg.useOrgDb(pool);
    await c.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

/** 7. Without pg_trgm: the same answers, ranked by the reference over the names the query reads. */
async function withoutLeg(pool: Pool, w: World, before: { spelt: string[]; kinds: string[] }): Promise<void> {
  await pool.query('DROP EXTENSION pg_trgm CASCADE'); // and the index with it
  ok('7. without pg_trgm (dropped): the probe finds none', (await trgm.trgmPlace(0)) === null && (await pool.query(`SELECT to_regclass('assistant_search_name_trgm') AS ix`)).rows[0].ix === null);
  const [indexed, reference] = [await answersOf(w, (s, o) => search.indexedSpelling(w.P, s, o)), await answersOf(w, (s, o) => search.referenceSpelling(w.P, s, o))];
  ok('…the index path answers by the reference over the names it reads: === the reference\'s, and === what pg_trgm answered',
    indexed.every((x, i) => Object.is(x, reference[i]) && Object.is(x, before.spelt[i])), indexed.filter((x, i) => !Object.is(x, before.spelt[i])).join('\n'));
  const kinds = await everyKind(w);
  ok('…on every kind too: the JS ranking of the rows === the pg_trgm query\'s', kinds.every((x, i) => Object.is(x, before.kinds[i])), kinds.filter((x, i) => !Object.is(x, before.kinds[i])).join('\n'));
  await suggestions(w, '…without pg_trgm');
  await folderLeg(pool, w, 'without pg_trgm');
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  pureLeg();
  await suggestions(await world(), '2. reference (no database)');
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres legs: DATABASE_URL is unset (without a database the reference is the only path)');
    return;
  }
  const dbName = `ordinate_spelling_${process.pid}_${Date.now()}`;
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
    inOrg.useOrgDb(pool);
    search.register();
    await parityLeg(pool);
    const w = await world();
    const before = await differentialLeg(w);
    await folderLeg(pool, w, 'pg_trgm');
    await indexedLeg(w);
    await cTypeLeg(adminUrl, admin, pool);
    await withoutLeg(pool, w, before);
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('name spelling suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
