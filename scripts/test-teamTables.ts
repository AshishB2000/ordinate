// Connection tables per team (docs/team-folders/00-design.md D19, "Connection tables per team"; 0036;
// src/server/authz/teamTables.ts, src/ipc/teamTables.ts, src/ipc/sourceAnswers.ts): which documented warehouse tables a
// project viewer may ask about, under which label, and which of their columns stay hidden.
//
// Both modes:
//   1. THE RULE (pure): include, exclude, schema-level, the union of two teams and hidden columns (most permissive
//      wins), each with its NEGATIVE CONTROL; and the index's half of it (`givenKeys`, what the WHERE matches) equal to
//      the rule over a corpus of tables and team sets (NEGATIVE CONTROL: without the denied keys it is not).
// DATABASE_URL only (real grants, ./rowPolicyHarness; the warehouse is ./liveFakeConnector):
//   2. CHANNELS: `teamTables:set` / `:get` round-trip as a project admin, tidied; an editor is refused 403; a team with no
//      role on the project reads `role: null`.
//   3. WHO: the resolver gives each viewer exactly the rule over their teams' rows, and a team with no project role
//      gives nothing (NEGATIVE CONTROL: once it has one, it gives).
//   4. THE INDEX: a viewer's step 3 search finds exactly the given, labelled tables, by their labels, never by a
//      warehouse name, and its counts agree; the index equals the reference (Object.is). NEGATIVE CONTROL: without the
//      WHERE the viewer finds every labelled table; an editor finds them by their names.
//   5. THE ANSWER: a viewer's Home question gets the given tables under their labels, less hidden columns; the answer
//      from one is Object.is the editor's from the same table, through ONE warehouse statement; a hidden column, an
//      excluded table and an unlabelled one are refused as unknown (NEGATIVE CONTROL: the editor's answer); a kept
//      card on a column hidden since is never served again.
//   6. SAFETY NET: no reply, prompt or MCP tool the viewers get carries an unticked or excluded table's name, a given
//      table's warehouse name, its schema or its connection (NEGATIVE CONTROL: the editor's carry them).
//
//   npm run build:ts && [DATABASE_URL=… ORDINATE_EXPECT_PGVECTOR=1] node scripts/test-teamTables.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as RP from './rowPolicyHarness';
import type { TableFacts } from '../src/connectors/tableFacts';

const rule: typeof import('../src/server/authz/teamTables') = require('../src/server/authz/teamTables');
type Row = import('../src/server/authz/teamTables').TeamTableRow;

const C = '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d';
const S = 'tt_sales';
const tr = (teamId: string, schema: string, table: string | null, include: boolean, hidden: string[] = []): Row => ({ teamId, connId: C, schema, table, include, hidden });
const EAST_ROWS = [tr('east', S, null, true), tr('east', S, 'paycanary_7e2', false), tr('east', S, 'returns', false), tr('east', S, 'orders', true, ['EMAIL'])];
const OPS_ROWS = [tr('ops', S, 'returns', true, ['reason']), tr('ops', S, 'orders', true, ['email', 'region'])];
const access = (rows: Row[], table: string) => rule.tableAccess(rule.givenFrom(rows), C, table);
const hid = (rows: Row[], table: string): string => { const a = access(rows, table); return a ? [...a.hidden].sort().join(',') : 'none'; };

function pureRule(): void {
  ok('1. INCLUDE: a table row gives its table, with its hidden columns', hid(OPS_ROWS, `${S}.orders`) === 'email,region', hid(OPS_ROWS, `${S}.orders`));
  ok('1. …NEGATIVE CONTROL: without it, nothing', hid(OPS_ROWS.filter((r) => r.table !== 'orders'), `${S}.orders`) === 'none');
  ok('1. EXCLUDE: a table row that excludes wins over its schema row', hid(EAST_ROWS, `${S}.paycanary_7e2`) === 'none');
  ok('1. …NEGATIVE CONTROL: without the exclude, the schema gives it', hid(EAST_ROWS.filter((r) => r.table !== 'paycanary_7e2'), `${S}.paycanary_7e2`) === '');
  ok('1. SCHEMA: an include schema row gives every table in it, one added later too, nothing hidden', hid(EAST_ROWS, `${S}.refunds`) === '' && hid(EAST_ROWS, `${S}.added_later`) === '');
  ok('1. …NEGATIVE CONTROL: not another schema, not a dotted name inside it (a hide), not another connection', hid(EAST_ROWS, 'tt_hr.salcanary_7e2') === 'none' && hid(EAST_ROWS, `${S}.a.b`) === 'none'
    && rule.tableAccess(rule.givenFrom(EAST_ROWS), 'a6c0e7a4-7f1b-4c51-9a0e-2b3c4d5e6f70', `${S}.refunds`) === null);
  ok('1. UNION: one team excludes a table another includes: given', hid([...EAST_ROWS, ...OPS_ROWS], `${S}.returns`) === 'reason');
  ok('1. …NEGATIVE CONTROL: the excluding team alone does not', hid(EAST_ROWS, `${S}.returns`) === 'none');
  ok('1. HIDDEN: a column is hidden only when every giving team hides it (case-insensitive)', hid([...EAST_ROWS, ...OPS_ROWS], `${S}.orders`) === 'email' && hid(EAST_ROWS, `${S}.orders`) === 'email');
  const viaSchema = [...OPS_ROWS, tr('third', S, null, true)];
  ok('1. …a team giving it through its schema hides nothing, so nothing is', hid(viaSchema, `${S}.orders`) === '');
  ok('1. …NEGATIVE CONTROL: the stricter team alone hides both', hid(OPS_ROWS, `${S}.orders`) === 'email,region');

  // The index's half: a viewer row (keys: its table's and its schema's) is found when it meets `keys` and no `denied`.
  const tables = [`${S}.orders`, `${S}.refunds`, `${S}.returns`, `${S}.paycanary_7e2`, `${S}.added_later`, 'tt_hr.salcanary_7e2', 'plain', `${S}.a.b`];
  const teamSets: Row[][] = [[], EAST_ROWS, OPS_ROWS, [...EAST_ROWS, ...OPS_ROWS], viaSchema, [tr('x', '', null, true), tr('x', '', 'plain', false)], [tr('x', '', null, true)], [tr('ghost', 'tt_hr', null, true), ...OPS_ROWS]];
  const found = (g: { keys: string[]; denied: string[] }, t: string): boolean => {
    const k = [rule.tableKey(C, t), rule.schemaKey(C, rule.schemaOf(t))];
    return k.some((x) => g.keys.includes(x)) && !k.some((x) => g.denied.includes(x));
  };
  const differs = (drop: boolean): string[] => teamSets.flatMap((rows, i) => {
    const given = rule.givenFrom(rows);
    const g = rule.givenKeys(given);
    const keys = drop ? { ...g, denied: [] } : g;
    return tables.filter((t) => found(keys, t) !== (rule.tableAccess(given, C, t) !== null)).map((t) => `${i}:${t}`);
  });
  ok(`1. THE INDEX'S RULE: givenKeys finds exactly what the rule gives, over ${tables.length} tables × ${teamSets.length} team sets`, differs(false).length === 0, differs(false).join(' '));
  ok('1. …NEGATIVE CONTROL: without the denied keys, an excluded table is found', differs(true).length > 0);
}

// ── With a database ────────────────────────────────────────────────────────────

const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const search: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const index: typeof import('../src/server/assistantSearchIndex') = require('../src/server/assistantSearchIndex');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const budget: typeof import('../src/engine/live/liveBudget') = require('../src/engine/live/liveBudget');
const missing: typeof import('../src/engine/liveQueryMessages') = require('../src/engine/liveQueryMessages');
const registry: typeof import('../src/automation/serverMcp') = require('../src/automation/serverMcp');

const CONN = 'whcanary_7e2';
/** Every name no viewer may read: warehouse names (given or not), the schemas, the connection, the labels of tables not given. */
const CANARY = /tt_sales|tt_hr|paycanary_7e2|salcanary_7e2|nolabel_7e2|whcanary_7e2|Pay runs|Staff costs/;
const ROWS = [['North', 12.5, 'a@x.test'], ['South', 7, 'b@x.test'], ['North', 0.1, 'c@x.test'], ['East', 3.25, 'd@x.test']];
const FACTS: TableFacts = { columns: [{ name: 'region', type: 'VARCHAR' }, { name: 'amount', type: 'DOUBLE' }, { name: 'email', type: 'VARCHAR' }] };
/** Documented tables: [warehouse name, label for viewers]. */
const DOCS: Array<[string, string | undefined]> = [
  [`${S}.orders`, 'Shop orders'], [`${S}.refunds`, 'Refunds'], [`${S}.returns`, 'Returns'], [`${S}.paycanary_7e2`, 'Pay runs'], ['tt_hr.salcanary_7e2', 'Staff costs'], [`${S}.nolabel_7e2`, undefined],
];
const ALL_WORDS = 'shop orders refunds returns pay runs staff costs nolabel';

let lastPrompt = '';
let nextAction: unknown = { kind: 'none', intent: '' };
function stubModel(): void {
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (execConfig as { assistantOn: unknown }).assistantOn = () => true;
  (analyze as { askCopilot: unknown }).askCopilot = async (prior: unknown, facts: string, q: string) => {
    lastPrompt = `${JSON.stringify(prior)}\n${facts}\n${q}`;
    return { ok: true, text: 'Here it is.', suggestedAction: nextAction };
  };
}

const lastAssistant = (reply: any) => [...(reply?.turns ?? [])].reverse().find((t: { role: string }) => t.role === 'assistant'); // any: copilot:ask's reply
const figures = (c: any): string => JSON.stringify((c?.data?.labels ?? []).map((l: unknown, i: number) => [l, c.data.series[0].values[i]])); // any: a card
const spec = (datasetId: string, table: string, category = 'region') => ({ datasetId, table, category, measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Amount by region' });

async function withDatabase(W: RP.World): Promise<void> {
  const P = W.P;
  const seen: string[] = []; // every reply and prompt a viewer got
  const as = async (who: string, channel: string, payload: object) => {
    const r = await W.call(who, channel, payload);
    if (who !== 'ed' && who !== 'boss') seen.push(`${channel} ${r.text}`);
    return r;
  };
  const team = async (name: string, members: string[], role: string | null): Promise<string> => {
    const id = (await W.pool.query<{ id: string }>(`INSERT INTO teams (org_id, name) VALUES ('acme', $1) RETURNING id::text`, [name])).rows[0].id;
    for (const m of members) await W.pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [id, W.uid[m]]);
    if (role) await W.call('boss', 'project:share', { projectId: P, member: { teamId: id }, role });
    return id;
  };
  const ops = await team('Ops', ['east', 'west'], 'viewer');
  const ghost = await team('Ghost', ['nobody'], null);
  const seeded = await W.as('boss', async () => {
    fakeMod.registerLiveFake();
    await duck.execAsync(`CREATE SCHEMA IF NOT EXISTS ${S}`);
    await duck.execAsync(`CREATE OR REPLACE TABLE ${S}.orders (region VARCHAR, amount DOUBLE, email VARCHAR)`);
    for (const r of ROWS) await duck.queryAsync(`INSERT INTO ${S}.orders VALUES ($1, $2, $3)`, r as (string | number)[]);
    const conn = (await connections.saveConnection(P, { name: CONN, connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!;
    const ids: Record<string, string> = {};
    for (const [table, label] of DOCS) {
      const made = await store.createSourceDoc(P, conn.id, table, label ? { label } : {});
      if (!made.ok) throw new Error('fixture: a source doc');
      await store.updateSourceDoc(P, conn.id, made.docId, (d) => ({ ...d, facts: { ...FACTS, readAt: new Date().toISOString(), readBy: 'ed@acme.test' } }));
      ids[table] = made.docId;
    }
    return { conn: conn.id, ids };
  });
  const conn = seeded.conn;
  const doc = (t: string): string => seeded.ids[t];
  const ours = (rows: Row[]) => rows.map((r) => ({ schema: r.schema, ...(r.table ? { table: r.table } : {}), include: r.include, ...(r.hidden.length ? { hidden: [...r.hidden] } : {}) }));

  // 2. The channels.
  const setEast = await W.call('boss', 'teamTables:set', { projectId: P, teamId: W.team, connId: conn, rows: [...ours(EAST_ROWS), { schema: S, table: 'refunds', include: false, hidden: ['amount'] }, { schema: S, table: 'refunds', include: true }] });
  await W.call('boss', 'teamTables:set', { projectId: P, teamId: ops, connId: conn, rows: ours(OPS_ROWS) });
  await W.call('boss', 'teamTables:set', { projectId: P, teamId: ghost, connId: conn, rows: [{ schema: 'tt_hr', include: true }] });
  const got = (await W.call('boss', 'teamTables:get', { projectId: P, teamId: W.team })).body;
  const refunds = got?.rows?.find((r: { table?: string }) => r.table === 'refunds');
  ok('2. CHANNELS: a project admin sets a team\'s ticks and reads them back (one row per table, the last wins)', setEast.body?.ok === true && got?.ok === true && got.role === 'viewer' && got.rows.length === 5
    && refunds?.include === true && refunds.hidden.length === 0, JSON.stringify(got));
  const byEd = await W.call('ed', 'teamTables:set', { projectId: P, teamId: W.team, connId: conn, rows: [] });
  const ghostGot = (await W.call('boss', 'teamTables:get', { projectId: P, teamId: ghost })).body;
  ok('2. …an editor is refused before the handler; a team with no project role reads role null', byEd.status === 403 && ghostGot?.ok === true && ghostGot.role === null && ghostGot.rows.length === 1, JSON.stringify([byEd.status, ghostGot]));
  // Back to exactly EAST_ROWS (refunds through the schema).
  await W.call('boss', 'teamTables:set', { projectId: P, teamId: W.team, connId: conn, rows: ours(EAST_ROWS) });

  // 3. Who.
  const re = (rows: Row[]) => rows.map((r) => ({ ...r, connId: conn }));
  const expect: Record<string, Row[]> = { east: re([...EAST_ROWS, ...OPS_ROWS]), west: re(OPS_ROWS), nobody: [] };
  const tables = DOCS.map(([t]) => t);
  const rulePrint = (rows: Row[]) => tables.map((t) => { const a = rule.tableAccess(rule.givenFrom(rows), conn, t); return a ? [...a.hidden].sort().join('+') || '-' : 'x'; }).join(' ');
  for (const who of ['east', 'west', 'nobody']) {
    const given = await W.as(who, () => rule.givenOn(P));
    const print = tables.map((t) => { const a = rule.tableAccess(given, conn, t); return a ? [...a.hidden].sort().join('+') || '-' : 'x'; }).join(' ');
    ok(`3. WHO: ${who} is given exactly the rule over their teams' rows (${print})`, print === rulePrint(expect[who]), `${print} vs ${rulePrint(expect[who])}`);
  }
  await W.call('boss', 'project:share', { projectId: P, member: { teamId: ghost }, role: 'viewer' });
  const ghostGives = await W.as('nobody', () => rule.givenOn(P));
  ok('3. …NEGATIVE CONTROL: once Ghost holds a role on the project, its ticks give', rule.tableAccess(ghostGives, conn, 'tt_hr.salcanary_7e2') !== null);
  await W.call('boss', 'project:share', { projectId: P, member: { teamId: ghost }, role: null });

  // 4. The index.
  const labelsOf = (who: string): string[] => DOCS.flatMap(([t, label]) => (label && rule.tableAccess(rule.givenFrom(expect[who] ?? []), conn, t) ? [label] : [])).sort();
  const names = (hits: Array<{ name: string }> | null): string[] => (hits ?? []).map((h) => h.name).sort();
  for (const who of ['east', 'west', 'nobody']) {
    const [indexed, reference, counts] = await W.as(who, async () => [
      await search.indexedModel(P, ALL_WORDS, { kinds: ['table'], limit: 50 }), await search.referenceModel(P, ALL_WORDS, { kinds: ['table'], limit: 50 }), await search.countModel(P),
    ] as const);
    const same = JSON.stringify(indexed) === JSON.stringify(reference) && (indexed ?? []).every((h, i) => Object.is(h.score, reference[i].score));
    ok(`4. INDEX: ${who} finds exactly the given, labelled tables by their labels (${names(indexed).join(', ') || 'none'}), as the reference does, and counts them`,
      indexed !== null && same && JSON.stringify(names(indexed)) === JSON.stringify(labelsOf(who)) && Object.is(counts.table, labelsOf(who).length), JSON.stringify({ indexed, reference, counts }));
  }
  const byName = await W.as('east', () => search.searchModel(P, 'tt_sales orders paycanary_7e2 salcanary_7e2', { kinds: ['table'], limit: 50 }));
  ok('4. …never by a warehouse name: the words of tt_sales.paycanary_7e2 find no label', byName.every((h) => h.name === 'Shop orders'), JSON.stringify(byName));
  index.setGivenWhereForTest(false);
  const open = await W.as('east', () => search.indexedModel(P, ALL_WORDS, { kinds: ['table'], limit: 50 }));
  index.setGivenWhereForTest(true);
  ok('4. NEGATIVE CONTROL: without the WHERE, east finds every labelled table', names(open).includes('Pay runs') && names(open).includes('Staff costs'), JSON.stringify(open));
  const ed = await W.as('ed', () => search.searchModel(P, 'paycanary_7e2', { kinds: ['table'], limit: 50 }));
  ok('4. NEGATIVE CONTROL: the editor finds a table by its warehouse name', ed.some((h) => h.name === `${S}.paycanary_7e2`), JSON.stringify(ed));

  // 5. The answer.
  stubModel();
  const counted: string[] = [];
  budget.setDailyCheckForTest((_org, datasetId) => { counted.push(datasetId); return { ok: true }; });
  const ask = async (who: string, question: string, action: unknown, threadId?: string) => {
    nextAction = action;
    lastPrompt = '';
    const r = await as(who, 'copilot:ask', { projectId: P, context: { kind: '' }, question, ...(threadId ? { threadId } : {}) });
    if (who !== 'ed') seen.push(lastPrompt);
    return { reply: r.body, prompt: lastPrompt };
  };
  const prompted = await ask('east', ALL_WORDS, { kind: 'none', intent: '' });
  const block = prompted.prompt.slice(prompted.prompt.indexOf('SOURCE TABLES'));
  ok('5. PROMPT: east\'s Home question names the given tables by their labels, without the hidden column or a connection',
    block.includes('- Shop orders: region (text), amount (number)\n') && block.includes('- Refunds: region (text), amount (number), email (text)') && block.includes('- Returns: region (text), amount (number), email (text)') && !/Shop orders[^\n]*email/.test(block),
    block.slice(0, 600));
  fakeMod.resetFake();
  const answered = await ask('east', 'shop orders amount by region', { kind: 'answer', intent: 'Amount by region', spec: { dataset: 'Shop orders', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }] } });
  const turn = lastAssistant(answered.reply);
  const edCard = (await W.call('ed', 'answer:card', { projectId: P, spec: spec(doc(`${S}.orders`), conn) })).body;
  ok('5. ANSWER: east\'s answer names the table by its doc and connection, and its card is Object.is the editor\'s on the same table',
    turn?.answer?.datasetId === doc(`${S}.orders`) && turn.answer.table === conn && turn.card?.ok === true && edCard?.ok === true && figures(turn.card) === figures(edCard) && figures(edCard).length > 2,
    JSON.stringify({ turn: turn?.card ?? turn, edCard }).slice(0, 600));
  ok('5. …through ONE warehouse statement, counted under the table\'s view', fakeMod.fake.calls.length === 1 && counted[0] === doc(`${S}.orders`), JSON.stringify({ calls: fakeMod.fake.calls.length, counted }));
  const edEmail = (await W.call('ed', 'answer:card', { projectId: P, spec: spec(doc(`${S}.orders`), conn, 'email') })).body;
  const hidden = await as('east', 'answer:card', { projectId: P, spec: spec(doc(`${S}.orders`), conn, 'email') });
  ok('5. HIDDEN: a card on the hidden column is refused to east (the editor\'s answered it first), with none of its values', hidden.body?.ok === false && !hidden.text.includes('@x.test') && edEmail?.ok === true && JSON.stringify(edEmail).includes('a@x.test'), hidden.text.slice(0, 300));
  for (const [t, why] of [[`${S}.paycanary_7e2`, 'excluded'], ['tt_hr.salcanary_7e2', 'never ticked'], [`${S}.nolabel_7e2`, 'given but unlabelled']] as const) {
    const r = await as('east', 'answer:card', { projectId: P, spec: spec(doc(t), conn) });
    const e = (await W.call('ed', 'answer:card', { projectId: P, spec: spec(doc(t), conn) })).body;
    ok(`5. …a table ${why} is answered as a dataset that does not exist (NEGATIVE CONTROL: the editor's card answers)`, r.body?.ok === false && r.body.reason === missing.liveDatasetMissing() && e?.ok !== undefined && e.reason !== missing.liveDatasetMissing(), `${r.text.slice(0, 200)} | ${JSON.stringify(e).slice(0, 200)}`);
  }
  // A kept card on a column hidden since: East and Ops both hide region now.
  const threadId = answered.reply?.threadId;
  await W.call('boss', 'teamTables:set', { projectId: P, teamId: W.team, connId: conn, rows: ours([...EAST_ROWS.filter((r) => r.table !== 'orders'), tr('east', S, 'orders', true, ['email', 'region'])]) });
  const reopened = lastAssistant((await as('east', 'copilot:history', { projectId: P, threadId })).body);
  const refreshed = await as('east', 'answer:refresh', { projectId: P, threadId, turnId: reopened?.id ?? '' });
  ok('5. SNAPSHOT: once region is hidden, the kept card is not sent again and a refresh refuses', reopened && !reopened.card?.data && refreshed.body?.ok !== true, JSON.stringify({ card: reopened?.card, refreshed: refreshed.text.slice(0, 200) }));
  await W.call('boss', 'teamTables:set', { projectId: P, teamId: W.team, connId: conn, rows: ours(EAST_ROWS) });

  // 6. The safety net.
  for (const who of ['east', 'west', 'nobody']) {
    await ask(who, ALL_WORDS, { kind: 'none', intent: '' });
    await as(who, 'search:query', { projectId: P, query: 'paycanary_7e2' });
    await as(who, 'search:query', { projectId: P, query: 'Pay runs' });
    await as(who, 'copilot:history', { projectId: P, ...(threadId && who === 'east' ? { threadId } : {}) });
  }
  const token = async (who: string): Promise<string> => String((await W.call(who, 'tokens:create', { name: 'net', expiresInDays: 1 })).body?.token ?? '');
  const values: Record<string, unknown> = { project: P, dataset: 'Shop orders', sql: `SELECT 1 AS one`, limit: 10, name: 'net', question: 'shop orders', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } };
  const tools = registry.SERVER_COMMANDS.filter((c) => c.readOnly).map((c) => ({ name: String(c.tool), args: Object.fromEntries(Object.keys(c.args).filter((k) => k in values).map((k) => [k, values[k]])) }));
  const viewerToken = await token('east');
  for (const t of tools) {
    const r = await W.app.inject({ method: 'POST', url: '/api/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${viewerToken}` }, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: t.name, arguments: t.args } }), remoteAddress: '127.0.0.1' });
    seen.push(`mcp ${t.name} ${r.body}`);
  }
  const leaks = seen.filter((s) => CANARY.test(s)).map((s) => s.slice(0, 160));
  ok(`6. SAFETY NET: none of the viewers' ${seen.length} replies, prompts and MCP answers (${tools.length} tools) names an unticked table, a warehouse name, a schema or the connection`,
    seen.length > 20 && tools.length > 10 && leaks.length === 0, leaks.join('\n'));
  ok('6. …and the given tables reached them under their labels', seen.some((s) => s.includes('Shop orders')) && seen.some((s) => s.includes('Returns')));
  const edPrompt = (await ask('ed', ALL_WORDS, { kind: 'none', intent: '' })).prompt;
  ok('6. NEGATIVE CONTROL: the editor\'s prompt carries the warehouse names and the connection', CANARY.test(edPrompt) && edPrompt.includes(`${S}.orders`) && edPrompt.includes(CONN), edPrompt.slice(edPrompt.indexOf('SOURCE TABLES'), edPrompt.indexOf('SOURCE TABLES') + 400));
  budget.setDailyCheckForTest(null);
}

(async () => {
  pureRule();
  if (!process.env.DATABASE_URL) {
    console.log('skip sections 2–6: DATABASE_URL is unset (teams need Postgres)');
    return;
  }
  const W = await RP.world('team tables');
  if (!W) return;
  try {
    await withDatabase(W);
  } finally {
    await W.close();
  }
})()
  .catch((e) => ok('team tables suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
