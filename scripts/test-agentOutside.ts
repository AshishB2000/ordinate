// An Assistant agent's out-of-scope reply (docs/assistant-agents/00-design.md rule 10, src/ipc/agentAsk.ts), through the
// real `copilot:ask` handler — userData in a temp dir, the model stubbed at analyze.askCopilot, `datasets.getDataset`
// spied on so a read of any table is seen.
//
//   1. the model says the topic does not hold it ("outside"): the turn is the app's words and names a dataset OUTSIDE
//      the topic that shares the question's words; it is stored, so a reload offers it again; no table is read
//   2. the model answers anyway, with a chart of a dataset outside the topic: no chart, the same offer naming THAT
//      dataset, and no table read — NEGATIVE CONTROL: the same reply in the Project assistant's conversation is
//      charted, reading that dataset
//   3. a dataset the caller cannot read is never named: the matcher passes over it (to the next match, or to nowhere,
//      which says "Ask an editor" and offers nothing) — NEGATIVE CONTROL: readable, it is the one named
//   4. an answer inside the topic is the agent's own: charted, no offer; an agent with no topic never says "outside"
//
//   npm run build:ts && node scripts/test-agentOutside.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-agentoutside-'));
process.env.ORDINATE_LOCAL_DIR = tmp;
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const msg: typeof import('../src/ai/agentMessages') = require('../src/ai/agentMessages');
const agentAsk: typeof import('../src/ipc/agentAsk') = require('../src/ipc/agentAsk');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');

async function main(): Promise<void> {
  const pid = (await projects.createProject('Out of scope'))!.id;
  const num = (name: string) => ({ name, type: 'number' as const });
  const txt = (name: string) => ({ name, type: 'text' as const });
  const invoices = (await datasets.saveDataset(pid, { name: 'Invoices', sourceKind: 'csv', columns: [txt('vendor'), num('amount')], rows: [['Acme', 10], ['Bolt', 5]] }))!;
  const orders = (await datasets.saveDataset(pid, { name: 'orders', sourceKind: 'csv', columns: [txt('region'), num('revenue'), txt('channel')], rows: [['West', 3, 'web'], ['East', 4, 'shop']] }))!;
  const shipments = (await datasets.saveDataset(pid, { name: 'Shipments', sourceKind: 'csv', columns: [txt('region'), num('parcels')], rows: [['West', 1]] }))!;
  const topic = (await topics.saveTopic(pid, { name: 'Finance', datasets: [{ id: invoices.id }] }))!;
  const fin = (await agents.saveAgent(pid, { name: 'Finance assistant', topicId: topic.id, model: null, build: true, teamIds: [] }))!;
  const wide = (await agents.saveAgent(pid, { name: 'All data assistant', topicId: null, model: null, build: true, teamIds: [] }))!;

  require('../src/ipc/copilot').register();
  const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);
  const replies: any[] = [];
  (analyze as any).askCopilot = async () => replies.shift() ?? { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } };
  (execConfig as any).executionReady = () => true;
  const realGet = datasets.getDataset;
  const read: string[] = [];
  (datasets as any).getDataset = async (...args: Parameters<typeof realGet>) => { read.push(args[1]); return realGet(...args); };
  const thread = async (agentId: string | null): Promise<string> => (await call('copilot:newThread', { projectId: pid, agentId })).thread.id;
  const finT = await thread(fin.id);
  const ask = (question: string, threadId: string): Promise<any> => call('copilot:ask', { projectId: pid, context: {}, question, threadId });

  // ── 1. "outside" ──────────────────────────────────────────────────────────
  read.length = 0;
  replies.push({ ok: true, text: 'That is not in the Finance data.', suggestedAction: { kind: 'outside', intent: 'revenue by region' } });
  const r1 = await ask('What was revenue by region and channel?', finT);
  const turn = r1.turns.at(-1);
  ok('outside: the app\'s words, naming the dataset outside the topic the question matches',
    r1.ok && turn.text === `${msg.outsideTopic('Finance')}\n${msg.outsideOffer('orders')}` && turn.outside?.dataset === 'orders' && !turn.answer, JSON.stringify(turn));
  ok('…the model\'s own sentence is not what is kept', !turn.text.includes('That is not in the Finance data.'));
  ok('…kept on the turn, so a reload offers it again', (await copilot.loadHistory(pid, finT)).at(-1)?.outside?.dataset === 'orders');
  ok('…and no table was read for it', read.length === 0, read.join());

  // ── 2. an answer on a dataset outside the topic ──────────────────────────
  const chart = { ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'revenue by region', spec: { dataset: 'orders', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }] } } };
  read.length = 0;
  replies.push(structuredClone(chart));
  const r2 = await ask('Revenue by region', finT);
  const t2 = r2.turns.at(-1);
  ok('an answer outside the topic: no chart, the offer naming that dataset', r2.ok && !t2.answer && t2.outside?.dataset === 'orders' && t2.text.startsWith(msg.outsideTopic('Finance')), JSON.stringify(t2));
  ok('…nothing outside the topic was computed (no table read at all)', read.length === 0, read.join());
  const paT = await thread(null);
  read.length = 0;
  replies.push(structuredClone(chart));
  const r3 = await ask('Revenue by region', paT);
  ok('NEGATIVE CONTROL: the Project assistant charts the same reply, reading that dataset', r3.ok && r3.turns.at(-1).answer?.datasetId === orders.id && read.includes(orders.id) && !r3.turns.at(-1).outside, JSON.stringify({ read, t: r3.turns.at(-1) }));

  // ── 3. never a dataset the caller cannot read ────────────────────────────
  const only = new Set([invoices.id]);
  const all = async (): Promise<boolean> => true;
  const notOrders = async (_p: string, id: string): Promise<boolean> => id !== orders.id;
  const none = async (): Promise<boolean> => false;
  ok('NEGATIVE CONTROL: readable, the best match is named', (await agentAsk.matchOutside(pid, 'revenue by region and channel', only, all))?.id === orders.id);
  ok('unreadable, it is passed over for the next match', (await agentAsk.matchOutside(pid, 'revenue by region and channel', only, notOrders))?.id === shipments.id);
  ok('…and with nothing readable left, none is named', (await agentAsk.matchOutside(pid, 'revenue by region and channel', only, none)) === null);
  ok('a dataset INSIDE the topic is never the offer', (await agentAsk.matchOutside(pid, 'amount by vendor', only, all)) === null);
  replies.push({ ok: true, text: 'Not here.', suggestedAction: { kind: 'outside', intent: 'weather' } });
  const r4 = await ask('What was the weather like?', finT);
  ok('nowhere: "Ask an editor", and no offer', r4.ok && r4.turns.at(-1).text === `${msg.outsideTopic('Finance')}\n${msg.outsideNowhere()}` && !r4.turns.at(-1).outside, JSON.stringify(r4.turns.at(-1)));

  // ── 4. inside the topic, and no topic ────────────────────────────────────
  read.length = 0;
  replies.push({ ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'amount by vendor', spec: { dataset: 'Invoices', category: 'vendor', measures: [{ column: 'amount', aggregation: 'sum' }] } } });
  const r5 = await ask('Amount by vendor', finT);
  ok('inside the topic: the agent\'s own chart, no offer', r5.ok && r5.turns.at(-1).answer?.datasetId === invoices.id && !r5.turns.at(-1).outside && read.every((id) => id === invoices.id), JSON.stringify({ read, t: r5.turns.at(-1) }));
  const wideT = await thread(wide.id);
  replies.push({ ok: true, text: 'Not here.', suggestedAction: { kind: 'outside', intent: 'x' } });
  const r6 = await ask('Revenue by region', wideT);
  ok('an agent with no topic never says "outside": its reply stands', r6.ok && r6.turns.at(-1).text === 'Not here.' && !r6.turns.at(-1).outside && r6.suggestedAction.kind === 'none');
  (datasets as any).getDataset = realGet;
}

main().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
