// Auto on the real `copilot:ask` handler (docs/agent-router/00-design.md, phase 2) — userData in a temp dir, the model stubbed at
// analyze.askCopilot (what an agent answers with) and analyze.dispatch (the router's one small call), so every word a model
// was sent is read back.
//
//   1. a first question with `auto` is answered by the agent the question matches, the conversation is with it, and the stored
//      answer says why in the app's words ("Matched the Payroll dataset …") — NEGATIVE CONTROL: without `auto` the same
//      question, asked with no agent, is the Project assistant's and keeps no route
//   2. a follow-up keeps the conversation's agent whatever it is about; a blank conversation with another agent is replaced
//   3. a close call asks the small model once (question and the two agents' names and descriptions only); when it cannot say, the
//      reply is `choose` with the agents and NOTHING is written or answered — no model asked for an answer, no new conversation
//   4. a verified question, word for word, keeps the route too
//   5. a person with one agent, or none: `auto` changes nothing
//
//   npm run build:ts && node scripts/test-agentRouteAsk.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-agentrouteask-'));
process.env.ORDINATE_LOCAL_DIR = tmp;
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const sa: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const msg: typeof import('../src/ai/agentRouteMessages') = require('../src/ai/agentRouteMessages');

async function main(): Promise<void> {
  const pid = (await projects.createProject('Router ask'))!.id;
  const txt = (name: string) => ({ name, type: 'text' as const });
  const num = (name: string) => ({ name, type: 'number' as const });
  const payroll = (await datasets.saveDataset(pid, { name: 'Payroll', sourceKind: 'csv', columns: [txt('team'), num('cost')], rows: [['Ops', 7]] }))!;
  const orders = (await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: [txt('region'), num('revenue')], rows: [['West', 3]] }))!;
  const tHr = (await topics.saveTopic(pid, { name: 'HR', datasets: [{ id: payroll.id }] }))!;
  const tSales = (await topics.saveTopic(pid, { name: 'Sales', datasets: [{ id: orders.id }] }))!;
  const mk = async (name: string, topicId: string, description: string) => (await agents.saveAgent(pid, { name, description, topicId, model: null, build: false, teamIds: [] }))!;
  const hr = await mk('HR agent', tHr.id, 'People');
  const sales = await mk('Sales agent', tSales.id, 'Deals');
  const spec = { datasetId: payroll.id, category: 'team', measures: [{ column: 'cost', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 'x' };
  const v = await verified.saveVerifiedQuestion(pid, { question: 'Cost by team', spec });
  if (!v.ok) throw new Error('fixture: ' + JSON.stringify(v));

  require('../src/ipc/copilot').register();
  require('../src/ipc/agents').register();
  const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);

  let narrations = 0;
  const dispatched: Array<{ system: string; text: string }> = [];
  let pick = '0';
  (analyze as any).askCopilot = async () => { narrations += 1; return { ok: true, text: 'Fine.', suggestedAction: sa.NO_ACTION }; };
  (analyze as any).dispatch = async (system: string, messages: Array<{ text: string }>) => { dispatched.push({ system, text: messages[0].text }); return { rawText: pick }; };
  (execConfig as any).executionReady = () => true;
  const ask = (question: string, extra: object = {}): Promise<any> => call('copilot:ask', { projectId: pid, context: {}, question, ...extra });
  const lastAssistant = (r: any): any => [...r.turns].reverse().find((t: any) => t.role === 'assistant');
  const threads = async (): Promise<any[]> => (await call('copilot:threads', { projectId: pid })).threads;

  // ── 1. a first question ───────────────────────────────────────────────────
  const first = await ask('What is the payroll cost by team?', { auto: true });
  const t1 = lastAssistant(first);
  ok('auto: the agent the question matches answers, and the conversation is with it', first.ok && first.agent?.id === hr.id && (await threads())[0].agentId === hr.id, JSON.stringify(first.agent));
  ok('…the stored answer says why, in the app\'s words, from what matched', t1?.route?.why === msg.routeMatchedTwo(msg.routeDataset('Payroll'), msg.routeColumn('cost')) || /^Matched the .*Payroll dataset/.test(t1?.route?.why ?? ''), JSON.stringify(t1?.route));
  ok('…no small model call was needed', dispatched.length === 0 && narrations === 1);
  const stored = (await copilot.loadHistory(pid, first.threadId)).find((t) => t.role === 'assistant');
  ok('…and the note is on the stored turn (a reload keeps it)', stored?.route?.why === t1?.route?.why);
  const plain = await ask('What is the payroll cost by team?', {});
  ok('NEGATIVE CONTROL: without auto the same question has no route (here: the latest conversation\'s agent answers it, unrouted)', plain.ok && !lastAssistant(plain)?.route);
  const fresh = await call('copilot:newThread', { projectId: pid, agentId: null });
  const pa = await ask('What is the payroll cost by team?', { threadId: fresh.thread.id });
  ok('NEGATIVE CONTROL: …and in a Project assistant conversation, with no agent and no route', pa.ok && pa.agent === null && !lastAssistant(pa)?.route);

  // ── 2. follow-ups and a blank conversation ────────────────────────────────
  const follow = await ask('And orders revenue by region?', { threadId: first.threadId, auto: true });
  ok('a follow-up keeps the conversation\'s agent, whatever it is about', follow.ok && follow.threadId === first.threadId && follow.agent?.id === hr.id && !lastAssistant(follow)?.route, JSON.stringify(follow.agent));
  ok('…and asks nobody (no route, no small model)', dispatched.length === 0 && (await threads()).filter((t) => t.id === first.threadId).length === 1);
  const blank = (await call('copilot:newThread', { projectId: pid, agentId: hr.id })).thread;
  const before = (await threads()).length;
  const swapped = await ask('Orders revenue by region', { threadId: blank.id, auto: true });
  const after = await threads();
  ok('a blank conversation with another agent is replaced by one with the routed agent (and not left behind)', swapped.ok && swapped.agent?.id === sales.id && swapped.threadId !== blank.id
    && after.length === before && !after.some((t) => t.id === blank.id) && after.some((t) => t.id === swapped.threadId && t.agentId === sales.id), JSON.stringify([swapped.agent, before, after.length]));
  const same = (await call('copilot:newThread', { projectId: pid, agentId: sales.id })).thread;
  const kept = await ask('Orders revenue by region', { threadId: same.id, auto: true });
  ok('NEGATIVE CONTROL: a blank conversation already with the routed agent is kept as it is', kept.ok && kept.threadId === same.id && kept.agent?.id === sales.id);

  // ── 3. a close call ───────────────────────────────────────────────────────
  narrations = 0;
  const blankPa = async (): Promise<string> => (await call('copilot:newThread', { projectId: pid, agentId: null })).thread.id;
  const spare = await blankPa();
  const open = (await threads()).length;
  const close = await ask('payroll orders', { auto: true, threadId: spare });
  ok('close call: the small model is asked once with the question and the two agents\' names and descriptions', dispatched.length === 1 && dispatched[0].text === 'Question: payroll orders\n\nAssistants:\n1. HR agent - People\n2. Sales agent - Deals' && /^Reply with one character/.test(dispatched[0].system.replace(/^You pick[^.]*\. /, '')), JSON.stringify(dispatched));
  ok('…it cannot say (0): the reply is the two agents, and NOTHING was asked or stored', close.ok && close.choose?.length === 2 && close.choose.map((o: any) => o.name).join() === 'HR agent,Sales agent' && !close.turns && narrations === 0 && (await threads()).length === open, JSON.stringify(close));
  pick = '2';
  const picked = await ask('payroll orders', { auto: true, threadId: await blankPa() });
  ok('…and when it says 2, the second answers, the reason is the app\'s sentence', picked.ok && picked.agent?.id === sales.id && lastAssistant(picked)?.route?.why === msg.routeModelPicked(), JSON.stringify([picked.agent, lastAssistant(picked)?.route]));
  const choice = await ask('payroll orders', { agentId: hr.id, threadId: (await call('copilot:newThread', { projectId: pid, agentId: hr.id })).thread.id });
  ok('NEGATIVE CONTROL: a click on a button is an ordinary ask with that agent: no router, no route', choice.ok && choice.agent?.id === hr.id && !lastAssistant(choice)?.route);

  // ── 4. a verified question ────────────────────────────────────────────────
  const vq = await ask('Cost by team', { auto: true, threadId: await blankPa() });
  ok('a verified question word for word is answered by the app, with the route', vq.ok && vq.agent?.id === hr.id && /^Matched /.test(lastAssistant(vq)?.route?.why ?? ''), JSON.stringify([vq.agent, lastAssistant(vq)?.route]));

  // ── 5. one agent, or none ─────────────────────────────────────────────────
  const solo = (await projects.createProject('Router solo'))!.id;
  const only = (await agents.saveAgent(solo, { name: 'Only agent', topicId: null, model: null, build: false, teamIds: [] }))!;
  const rs = await call('copilot:ask', { projectId: solo, context: {}, question: 'Anything about payroll?', auto: true });
  ok('with one agent, auto changes nothing: no route, and the conversation is the Project assistant\'s as asked', rs.ok && rs.agent === null && !lastAssistant(rs)?.route, JSON.stringify(rs.agent));
  const mine = (await call('copilot:newThread', { projectId: solo, agentId: only.id })).thread.id;
  const rn = await call('copilot:ask', { projectId: solo, context: {}, question: 'Anything about payroll?', auto: true, threadId: mine });
  ok('…and a blank conversation with that one agent stays with it', rn.ok && rn.threadId === mine && rn.agent?.id === only.id && !lastAssistant(rn)?.route, JSON.stringify(rn.agent));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
