// Follow the links (docs/assistant/00-design.md, step 3 "Follow the links"; src/ipc/askLinks.ts, src/ai/linkedFacts.ts).
//
// 1. walk (pure, `linkPaths`): two links away and no further; DIFFERENTIAL: every path is the chart planner's own
//    (joinPlan.findPath, relationship ids compared with Object.is), and what it leaves out the planner refuses as a
//    fan-out or reaches only past two links. NEGATIVE CONTROLS: the same chain reversed adds nothing; a many-to-many
//    (a cardinality this release does not know) and a link whose one side repeats are never walked, each walked once
//    made a plain many-to-one; a one-to-one is walked both ways; nearest first over several bases.
// 2. block (pure): a linked dataset's line, the framing, the character cap, no block for nothing.
// 3. prompt, through the real `copilot:ask` (the model stubbed, the prompt captured): with Purchases open, from Home and
//    in a topic, Customers (one link) and Regions and Segments (two) are in the facts, marked with their links; Countries
//    (three) and Items (one → many) never; an agent's topic follows none. A linked Live dataset's table facts follow
//    (Segments). At most LINKED_MAX on a star of eight. The model's answer from a linked dataset validates and is drawn;
//    one naming a linked dataset's column on Purchases is refused with the documented sentence, and the same NAMING its
//    linked dataset ("categoryDataset": "Regions", two links away) is the chart form in one model call, its figures read
//    through both links (docs/assistant "Joins, as built"). NEGATIVE CONTROL: the links deleted, no block, no table facts,
//    and the ordinary refusal.
//    With DATABASE_URL, real roles (./rowPolicyHarness): a viewer never reads a column hidden from them (Customers'
//    email and segment_id) nor a dataset linked through one (Segments); a dataset row access rules restrict them on
//    (Regions) is never added, for a viewer with no rows and for one with some. NEGATIVE CONTROL: an editor reads them all.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-askFollowLinks.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as RP from './rowPolicyHarness';
import type { Relationship } from '../src/analysis/relationships';

const links: typeof import('../src/ipc/askLinks') = require('../src/ipc/askLinks');
const linkedFacts: typeof import('../src/ai/linkedFacts') = require('../src/ai/linkedFacts');
const joinPlan: typeof import('../src/analysis/joinPlan') = require('../src/analysis/joinPlan');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const msg: typeof import('../src/ai/answerMessages') = require('../src/ai/answerMessages');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');

// ── 1. The walk ──────────────────────────────────────────────────────────────

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const edge = (n: number, from: string, to: string, cardinality = 'many_to_one', extra: Partial<Relationship> = {}): Relationship =>
  ({ id: id(900 + n), from: { datasetId: from, column: 'k' }, to: { datasetId: to, column: 'k' }, cardinality, verified: { matched: 0, unmatchedFrom: 0 }, ...extra }) as Relationship;

function walk(): void {
  const [P, C, R, K, I, S] = [1, 2, 3, 4, 5, 6].map(id); // Purchases, Customers, Regions, Countries, Items, Segments
  const graph = [edge(1, P, C), edge(2, C, R), edge(3, R, K), edge(4, I, P), edge(5, C, S)];
  const got = links.linkPaths([P], graph);
  ok('walk: one link (Customers) then two (Regions, Segments), nearest first', got.map((p) => p.id).join() === [C, R, S].join(), got.map((p) => p.id).join());
  const planner = got.every((p) => {
    const f = joinPlan.findPath(P, p.id, graph);
    return f.ok && f.value.length === p.hops.length && f.value.every((h, i) => Object.is(h.relId, p.hops[i].relId));
  });
  ok('walk: DIFFERENTIAL: every path is the chart planner\'s own (joinPlan.findPath)', planner);
  const items = joinPlan.findPath(P, I, graph);
  const countries = joinPlan.findPath(P, K, graph);
  ok('walk: what it leaves out, the planner refuses as a fan-out (Items) or reaches only past two links (Countries)', !items.ok && /repeat/.test(items.error) && countries.ok && countries.value.length === 3);
  const chain = [edge(1, P, C), edge(2, C, R), edge(3, R, K)];
  const reversed = chain.map((r) => ({ ...r, from: r.to, to: r.from }));
  ok('walk: the chain adds Customers and Regions', links.linkPaths([P], chain).map((p) => p.id).join() === [C, R].join());
  ok('NEGATIVE CONTROL: the same chain reversed (one → many from Purchases) adds nothing', links.linkPaths([P], reversed).length === 0);
  ok('NEGATIVE CONTROL: a many-to-many is never walked; made many-to-one, it is', links.linkPaths([P], [edge(1, P, C, 'many_to_many')]).length === 0 && links.linkPaths([P], [edge(1, P, C)]).length === 1);
  ok('NEGATIVE CONTROL: a link whose one side repeats is never walked; one whose key is another column is', links.linkPaths([P], [edge(1, P, C, 'many_to_one', { warning: { kind: 'repeats', repeats: 3 } })]).length === 0
    && links.linkPaths([P], [edge(1, P, C, 'many_to_one', { warning: { kind: 'not_key', key: 'x' } })]).length === 1);
  ok('walk: a one-to-one is walked both ways', links.linkPaths([P], [edge(1, C, P, 'one_to_one')]).map((p) => p.id).join() === C);
  const two = links.linkPaths([P, I], [edge(1, P, C), edge(2, C, R), edge(3, I, R)]);
  ok('walk: over several bases, each dataset once, by its nearest link, and a base is never linked', two.map((p) => `${p.id === C ? 'C' : 'R'}${p.hops.length}`).join() === 'C1,R1' && two[1].base === I && !two.some((p) => p.id === P || p.id === I), JSON.stringify(two.map((p) => [p.id, p.base, p.hops.length])));
}

// ── 2. The block ─────────────────────────────────────────────────────────────

function block(): void {
  const entry = {
    schema: { name: 'Regions', columns: [{ name: 'id', type: 'text' }, { name: 'region', type: 'text' }], docs: { region: { aliases: ['area'] } } as never },
    base: 'Purchases',
    hops: [{ from: { dataset: 'Purchases', column: 'customer_id' }, to: { dataset: 'Customers', column: 'id' } }, { from: { dataset: 'Customers', column: 'region_id' }, to: { dataset: 'Regions', column: 'id' } }],
  };
  const b = linkedFacts.linkedBlock([entry]);
  ok('block: the line names the links, then the columns as the facts list them', b.text.split('\n').at(-1)!.startsWith('- Regions (linked to Purchases via Purchases.customer_id → Customers.id, then Customers.region_id → Regions.id): id (text), region (text'), b.text);
  ok('block: it says a linked dataset may give the category or split, measures and filters staying the dataset\'s own', b.text.startsWith('LINKED DATASETS') && b.text.includes('"categoryDataset"') && b.text.includes('measures and filters stay'));
  const many = linkedFacts.linkedBlock(Array.from({ length: 40 }, (_, i) => ({ ...entry, schema: { ...entry.schema, name: `D${i}`, columns: Array.from({ length: 12 }, (_, c) => ({ name: `column_${c}`, type: 'text' })) } })));
  const shown = many.text.split('\n').filter((l) => l.startsWith('- D')).length;
  ok(`block: at most ${linkedFacts.LINKED_FACTS_MAX} characters of datasets, then "(more not shown)"`, shown > 0 && shown < 40 && many.text.endsWith('- (more linked datasets not shown)'), `${shown} shown`);
  ok('block: nothing linked: no block, no ledger', linkedFacts.linkedBlock([]).text === '' && linkedFacts.linkedBlock([]).ledger.length === 0);
}

// ── The bench both modes share ───────────────────────────────────────────────

interface Bench {
  P: string;
  as<T>(fn: () => Promise<T>): Promise<T>;
  /** `copilot:ask` as `who` with the model replying `reply`; the prompt it was handed. */
  ask(who: string, payload: object, reply?: object): Promise<{ reply: any; prompt: string }>;
}

let lastPrompt = '';
let modelCalls = 0;
const replies: object[] = [];
function stubModel(): void {
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (analyze as { dispatch: unknown }).dispatch = async () => { modelCalls++; throw new Error('no second model call in this suite'); }; // the SQL lane's
  (analyze as { askCopilot: unknown }).askCopilot = async (_prior: unknown, facts: string) => {
    modelCalls++;
    lastPrompt = facts;
    return replies.shift() ?? { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } };
  };
}
const answer = (spec: object) => ({ ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'it', spec } });

type Col = { name: string; type: 'text' | 'number' };
const T = (name: string): Col => ({ name, type: 'text' });
const N = (name: string): Col => ({ name, type: 'number' });
const SEG_TABLE = 'seg_live_7c1';

interface Seeded { purchases: string; customers: string; regions: string; segments: string; topic: string; agent: string; star: string }

async function seed(b: Bench): Promise<Seeded> {
  return b.as(async () => {
    const save = async (name: string, columns: Col[], rows: unknown[][]) => (await datasets.saveDataset(b.P, { name, sourceKind: 'csv', columns, rows: rows as never }))!.id;
    const purchases = await save('Purchases', [T('order_id'), T('customer_id'), N('amount')], [['o1', 'c1', 5], ['o2', 'c2', 7]]);
    const customers = await save('Customers', [T('id'), T('name'), T('region_id'), T('segment_id'), T('email')], [['c1', 'Ann', 'r1', 's1', 'a@x'], ['c2', 'Bo', 'r2', 's1', 'b@x']]);
    const regions = await save('Regions', [T('id'), T('region'), T('country_id')], [['r1', 'East', 'k1'], ['r2', 'West', 'k1']]);
    const countries = await save('Countries', [T('id'), T('country')], [['k1', 'Utopia']]);
    const items = await save('Items', [T('order_id'), T('sku'), N('qty')], [['o1', 'A', 1], ['o1', 'B', 2]]);
    fakeMod.registerLiveFake();
    await fakeMod.loadWarehouseTable(SEG_TABLE, [T('id'), T('segment')], [['s1', 'Retail']]);
    const conn = (await connections.saveConnection(b.P, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!;
    const segments = (await liveRecord.saveLiveRecord(b.P, { name: 'Segments', columns: [T('id'), T('segment')], origin: { kind: 'connection', connId: conn.id, table: SEG_TABLE } }))!.id;
    const doc = await store.createSourceDoc(b.P, conn.id, SEG_TABLE, {});
    if (!doc.ok) throw new Error('fixture: a source doc');
    await store.updateSourceDoc(b.P, conn.id, doc.docId, (d) => ({ ...d, facts: { columns: [], rowEstimate: 4200, readAt: new Date().toISOString(), readBy: 'boss@acme.test' } }));
    const link = async (from: string, fc: string, to: string, tc: string) => {
      if (!(await rels.saveRelationship(b.P, { from: { datasetId: from, column: fc }, to: { datasetId: to, column: tc }, cardinality: 'many_to_one' }))) throw new Error('fixture: a link');
    };
    await link(purchases, 'customer_id', customers, 'id');
    await link(customers, 'region_id', regions, 'id');
    await link(regions, 'country_id', countries, 'id');
    await link(items, 'order_id', purchases, 'order_id');
    await link(customers, 'segment_id', segments, 'id');
    // A star of eight dimensions, for the cap.
    const star = await save('Star fact', [...Array.from({ length: 8 }, (_, i) => T(`dim${i}_id`)), N('v')], [[...Array.from({ length: 8 }, () => 'x'), 1]]);
    for (let i = 0; i < 8; i++) await link(star, `dim${i}_id`, await save(`Star dim ${i}`, [T('id'), T(`label${i}`)], [['x', 'y']]), 'id');
    for (let i = 0; i < 12; i++) await save(`Clone ${i}`, [T('page'), N('views')], [['home', i]]); // more than Home's 12, the newest
    const topic = (await topics.saveTopic(b.P, { name: 'Buying', datasets: [{ id: purchases }], metricIds: [], termIds: [] }))!;
    const agent = (await agents.saveAgent(b.P, { name: 'Buying assistant', topicId: topic.id, model: null, build: true, teamIds: [] }))!;
    return { purchases, customers, regions, segments, topic: topic.id, agent: agent.id, star };
  });
}

// ── 3. The prompt ────────────────────────────────────────────────────────────

const HEAD = 'LINKED DATASETS';
const CUSTOMERS = '- Customers (linked to Purchases via Purchases.customer_id → Customers.id): id (text), name (text), region_id (text)';
const REGIONS = '- Regions (linked to Purchases via Purchases.customer_id → Customers.id, then Customers.region_id → Regions.id): id (text), region (text), country_id (text)';
const SEGMENTS = '- Segments (linked to Purchases via Purchases.customer_id → Customers.id, then Customers.segment_id → Segments.id)';
const SEG_FACTS = `- ${SEG_TABLE} (source table of "Segments" · ~4.2K rows`;

async function prompts(b: Bench, s: Seeded, editor: string): Promise<void> {
  const open = await b.ask(editor, { context: { kind: 'dataset', id: s.purchases }, question: 'amount by region' });
  const p = open.prompt;
  ok('prompt: with Purchases open, one link and two links away are in the facts, marked with their links', open.reply?.ok === true && p.includes(HEAD) && p.includes(CUSTOMERS) && p.includes(REGIONS) && p.includes(SEGMENTS), p.slice(p.indexOf(HEAD), p.indexOf(HEAD) + 900));
  ok('prompt: NEGATIVE CONTROL: three links away (Countries) and one → many (Items) never', !p.includes('Countries') && !p.includes('Items'));
  ok('prompt: the linked Live dataset\'s table facts follow it (Segments)', p.includes('SOURCE TABLE FACTS') && p.includes(SEG_FACTS), p.slice(p.indexOf('SOURCE TABLE'), p.indexOf('SOURCE TABLE') + 300));
  const home = await b.ask(editor, { context: { kind: '' }, question: 'amount' });
  ok('prompt: from Home (Purchases among the 12), the same links', home.reply?.ok === true && home.reply.provenance?.kind === 'project' && home.prompt.includes(CUSTOMERS) && home.prompt.includes(REGIONS), JSON.stringify(home.reply).slice(0, 300) + home.prompt.slice(0, 1500));
  const topic = await b.ask(editor, { context: { kind: 'topic', id: s.topic }, question: 'amount by region' });
  ok('prompt: in a topic, its datasets\' links', topic.reply?.ok === true && topic.prompt.includes('Topic: "Buying"') && topic.prompt.includes(CUSTOMERS));
  const agent = await b.ask(editor, { threadId: await newThread(b, editor, s.agent), context: { kind: '' }, question: 'amount by region' });
  ok('prompt: NEGATIVE CONTROL: an agent answers from its topic alone, so it follows no link', agent.reply?.ok === true && agent.reply.agent?.id === s.agent && agent.prompt.includes('Topic: "Buying"') && !agent.prompt.includes(HEAD), JSON.stringify(agent.reply).slice(0, 300) + agent.prompt.slice(0, 400));
  const star = await b.ask(editor, { context: { kind: 'dataset', id: s.star }, question: 'v by label' });
  const dims = star.prompt.split('\n').filter((l) => l.startsWith('- Star dim ')).length;
  ok(`prompt: at most ${links.LINKED_MAX} linked datasets in all (a star of 8)`, dims === links.LINKED_MAX, String(dims));

  const fromLinked = await b.ask(editor, { context: { kind: 'dataset', id: s.purchases }, question: 'customers by region' }, answer({ dataset: 'Customers', category: 'region_id', measures: [{ column: 'id', aggregation: 'count' }] }));
  ok('answer: one drawn from a linked dataset itself validates and is drawn', fromLinked.reply?.ok === true && fromLinked.reply.turns.at(-1)?.answer?.datasetId === s.customers, JSON.stringify(fromLinked.reply).slice(0, 300));
  const refused = (r: any, sentence: string) => r?.ok === true && !r.turns.at(-1)?.answer && String(r.answer).includes(`(No chart: ${sentence})`) && !r.turns.at(-1)?.suggest;
  const across = await b.ask(editor, { context: { kind: 'dataset', id: s.purchases }, question: 'amount by region' }, answer({ category: 'region_id', measures: [{ column: 'amount', aggregation: 'sum' }] }));
  ok('answer: a linked dataset\'s column on Purchases is refused with the documented sentence, no "Did you mean"', refused(across.reply, msg.linkedColumnRefused('region_id', 'Customers', 'Purchases')), JSON.stringify(across.reply).slice(0, 400));
  const dotted = await b.ask(editor, { context: { kind: 'dataset', id: s.purchases }, question: 'amount by region' }, answer({ category: 'Regions.region', measures: [{ column: 'amount', aggregation: 'sum' }] }));
  ok('answer: …named "Regions.region" too', refused(dotted.reply, msg.linkedColumnRefused('region', 'Regions', 'Purchases')), JSON.stringify(dotted.reply).slice(0, 400));
  // THE WIN (docs/assistant "Joins, as built"): the same question, the category NAMING its linked dataset, two links away, is
  // the chart form — one model call, no SQL lane — and its figures are Regions' through both links (East 5, West 7).
  const calls0 = modelCalls;
  const joined = await b.ask(editor, { context: { kind: 'dataset', id: s.purchases }, question: 'amount by region' }, answer({ category: 'region', categoryDataset: 'Regions', measures: [{ column: 'amount', aggregation: 'sum' }] }));
  const t = joined.reply?.turns?.at(-1);
  const byRegion = t?.card ? Object.fromEntries((t.card.data.labels as string[]).map((l, i) => [l, t.card.data.series[0].values[i]])) : {};
  ok('answer: naming the linked dataset ("categoryDataset": "Regions") it is the chart form, in ONE model call and no second', joined.reply?.ok === true && t?.answer?.datasetId === s.purchases
    && t.answer.categoryDatasetId === s.regions && modelCalls - calls0 === 1 && !t.sql && !String(joined.reply.answer).includes('(No chart'), JSON.stringify(joined.reply).slice(0, 400));
  ok('answer: …its figures read Regions through both links', byRegion.East === 5 && byRegion.West === 7 && Object.keys(byRegion).length === 2, JSON.stringify(byRegion));
}

async function unlinked(b: Bench, s: Seeded, editor: string): Promise<void> {
  await b.as(() => rels.updateRelationships(b.P, () => []));
  const open = await b.ask(editor, { context: { kind: 'dataset', id: s.purchases }, question: 'amount by region' }, answer({ category: 'region_id', measures: [{ column: 'amount', aggregation: 'sum' }] }));
  const r = open.reply;
  ok('NEGATIVE CONTROL: the links deleted: no linked datasets, no table facts, and the ordinary refusal', r?.ok === true && !open.prompt.includes(HEAD) && !open.prompt.includes(SEG_TABLE)
    && String(r.answer).includes('(No chart: ') && !String(r.answer).includes(msg.linkedColumnRefused('region_id', 'Customers', 'Purchases')), String(r?.answer).slice(0, 300));
}

/** A new conversation, with `agentId` or the Project assistant: every ask has its own. */
let newThread: (b: Bench, who: string, agentId?: string) => Promise<string> = async () => '';

// ── The two benches ──────────────────────────────────────────────────────────

async function withoutDatabase(): Promise<void> {
  const R: typeof import('./liveRouteHarness') = require('./liveRouteHarness');
  try {
    const P = await R.H.as(R.H.ORG_A, async () => {
      await R.H.projects.init();
      return (await R.H.projects.createProject('Follow links')).id;
    });
    const b: Bench = {
      P,
      as: (fn) => R.H.as(R.H.ORG_A, fn),
      ask: async (_who, payload, reply) => {
        lastPrompt = '';
        replies.length = 0;
        if (reply) replies.push(reply);
        const threadId = (payload as { threadId?: string }).threadId ?? await newThread(b, 'admin');
        const r = await R.post('copilot:ask', { projectId: P, ...payload, threadId });
        return { reply: r.value, prompt: lastPrompt };
      },
    };
    newThread = async (_b, _who, agentId) => (await R.post('copilot:newThread', { projectId: P, ...(agentId ? { agentId } : {}) })).value.thread.id;
    const s = await seed(b);
    await prompts(b, s, 'admin');
    await unlinked(b, s, 'admin');
  } finally {
    await R.close();
  }
}

async function withDatabase(W: RP.World): Promise<void> {
  const b: Bench = {
    P: W.P,
    as: (fn) => W.as('boss', fn),
    ask: async (who, payload, reply) => {
      lastPrompt = '';
      replies.length = 0;
      if (reply) replies.push(reply);
      const threadId = (payload as { threadId?: string }).threadId ?? await newThread(b, who);
      const r = await W.call(who, 'copilot:ask', { projectId: W.P, ...payload, threadId });
      return { reply: r.body, prompt: lastPrompt };
    },
  };
  newThread = async (_b, who, agentId) => (await W.call(who, 'copilot:newThread', { projectId: W.P, ...(agentId ? { agentId } : {}) })).body.thread.id;
  const s = await seed(b);
  // Customers' email and segment_id are for team East alone; Regions has row rules (team East: East's rows).
  const ruled = await W.as('boss', () => rec.serialized(rec.datasetFilePath(W.P, s.customers), (raw) => {
    raw.columnAccess = access.buildColumnAccess(raw, ['email', 'segment_id'].map((column) => ({ column, visibleTo: [{ teamId: W.team }] })), 'boss@acme.test', new Date().toISOString());
    return true;
  }));
  const set = await W.call('boss', 'dataset:setRowPolicy', { projectId: W.P, datasetId: s.regions, policy: { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } });
  if (!ruled || set.body?.ok !== true) throw new Error(`fixture: the rules: ${set.text}`);
  await prompts(b, { ...s }, 'ed'); // an editor: every row and column, so every link
  const q = { context: { kind: 'dataset', id: s.purchases }, question: 'amount by region' };
  const nobody = await b.ask('nobody', q);
  const np = nobody.prompt;
  ok('viewer: Customers is linked, without the columns hidden from them', nobody.reply?.ok === true && np.split('\n').includes('- Customers (linked to Purchases via Purchases.customer_id → Customers.id): id (text), name (text), region_id (text)'), np.slice(np.indexOf(HEAD), np.indexOf(HEAD) + 600));
  ok('viewer: NEGATIVE CONTROL: no hidden column anywhere, nor the dataset linked through one (Segments)', !np.includes('email') && !np.includes('segment_id') && !np.includes('Segments') && !np.includes(SEG_TABLE));
  ok('viewer: NEGATIVE CONTROL: a dataset row rules give them no rows of (Regions) is never added', !np.includes('- Regions'));
  const east = await b.ask('east', q);
  ok('viewer: …nor for a viewer the rules give some of its rows; the columns shown to their team are there', east.reply?.ok === true && !east.prompt.includes('- Regions') && east.prompt.includes('segment_id (text), email (text)') && east.prompt.includes(SEGMENTS), east.prompt.slice(east.prompt.indexOf(HEAD), east.prompt.indexOf(HEAD) + 700));
  await unlinked(b, s, 'ed');
}

(async () => {
  walk();
  block();
  stubModel();
  if (!process.env.DATABASE_URL) {
    await withoutDatabase();
    console.log('skip the viewer\'s links: DATABASE_URL is unset (roles need Postgres)');
    return;
  }
  const W = await RP.world('follow the links');
  if (!W) return;
  try {
    await withDatabase(W);
  } finally {
    await W.close();
  }
})()
  .catch((e) => ok('follow-links suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
