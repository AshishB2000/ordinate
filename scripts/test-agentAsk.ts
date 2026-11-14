// An Assistant agent answering (docs/assistant-agents/00-design.md, "The ask" and "Conversations"), through the real
// `copilot:ask`, `copilot:newThread`, `copilot:threads`, `copilot:history` and `plan:start` handlers — userData in a temp
// dir, the model stubbed at analyze.askCopilot (as test-askFollowUp.ts), so every word a model was sent is read back.
//
//   1. conversations: newThread with an agent stores it; the list and the history name it; switching agents is a NEW
//      conversation and the old one keeps its own; an ask that starts the first conversation starts it with its agent
//   2. facts: only the topic's datasets — NEGATIVE CONTROL: the Project assistant's hold the rest; a dataset on screen
//      inside the topic keeps its own facts, one outside it gives the topic's
//   3. guidance: the project's instructions, then the agent's under the line that says they win — NEGATIVE CONTROL:
//      the Project assistant gets no agent line; examples: the topic's verified question first — NEGATIVE CONTROL: not so
//      for the Project assistant; an exact verified question outside the topic is no hit for the agent; inside it, only one
//      on the dataset open on screen
//   4. model and build: the agent's model is the one asked for (and the choice falls back when it is not enabled);
//      build off asks with the answer-only prompt, drops a proposed plan, and plan:start refuses its conversation —
//      NEGATIVE CONTROL: the Project assistant's plan is offered and starts
//   5. a deleted agent: its conversation stays readable and the next question goes to the Project assistant, with the
//      line saying so; restored from the Trash, it answers again; purged, its conversations are marked deleted
//   6. a follow-up chip in its conversation: outside the topic refused before anything is drawn, inside narrated by the
//      agent — NEGATIVE CONTROL: the Project assistant's draws and narrates it
//   7. a stale conversation id lands in the latest conversation, whose agent answered
//   8. the instructions' room: full lists each keep half — NEGATIVE CONTROL: a short project list leaves the rest
//
//   npm run build:ts && node scripts/test-agentAsk.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-agentask-'));
process.env.ORDINATE_LOCAL_DIR = tmp;
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const instructions: typeof import('../src/app/instructions') = require('../src/app/instructions');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const msg: typeof import('../src/ai/agentMessages') = require('../src/ai/agentMessages');
const aiConfig: typeof import('../src/server/aiConfig') = require('../src/server/aiConfig');
const sa: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const guidance: typeof import('../src/ai/guidanceFacts') = require('../src/ai/guidanceFacts');

type Sent = { facts: string; q: string; opts: import('../src/ai/suggestedAction').AskOptions | undefined };

async function main(): Promise<void> {
  const pid = (await projects.createProject('Agents ask'))!.id;
  const num = (name: string) => ({ name, type: 'number' as const });
  const txt = (name: string) => ({ name, type: 'text' as const });
  const invoices = (await datasets.saveDataset(pid, { name: 'Invoices', sourceKind: 'csv', columns: [txt('vendor'), num('amount')], rows: [['Acme', 10], ['Bolt', 5]] }))!;
  const payroll = (await datasets.saveDataset(pid, { name: 'Payroll', sourceKind: 'csv', columns: [txt('team'), num('cost')], rows: [['Ops', 7]] }))!;
  const orders = (await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: [txt('region'), num('revenue')], rows: [['West', 3]] }))!;
  const topic = (await topics.saveTopic(pid, { name: 'Finance', datasets: [{ id: invoices.id }, { id: payroll.id }] }))!;
  await instructions.changeInstructions(pid, { kind: 'add', text: 'Revenue means booked deals' });
  const fin = (await agents.saveAgent(pid, { name: 'Finance assistant', topicId: topic.id, model: { provider: 'gateway', model: 'finance-model' }, build: false, teamIds: [] }))!;
  await agents.changeAgentInstructions(pid, fin.id, { kind: 'add', text: 'Revenue means recognized revenue' });
  const all = (await agents.saveAgent(pid, { name: 'Everything assistant', topicId: null, model: null, build: true, teamIds: [] }))!;
  // Two verified questions that share the most words with the question asked below: the Orders one shares more.
  const spec = (d: { id: string }, cat: string, m: string) => ({ datasetId: d.id, category: cat, measures: [{ column: m, aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 'x' });
  const vOrders = await verified.saveVerifiedQuestion(pid, { question: 'Total cost of revenue by region', spec: spec(orders, 'region', 'revenue') });
  const vInvoices = await verified.saveVerifiedQuestion(pid, { question: 'Amount by vendor', spec: spec(invoices, 'vendor', 'amount') });
  if (!vOrders.ok || !vInvoices.ok) throw new Error('fixture: ' + JSON.stringify([vOrders, vInvoices]));

  require('../src/ipc/copilot').register();
  require('../src/ipc/agents').register();
  require('../src/ipc/plan').register();
  const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);

  const sent: Sent[] = [];
  const replies: any[] = [];
  (analyze as any).askCopilot = async (_prior: unknown, facts: string, q: string, _d: unknown, opts?: Sent['opts']) => {
    sent.push({ facts, q, opts });
    return replies.shift() ?? { ok: true, text: 'Fine.', suggestedAction: sa.NO_ACTION };
  };
  (execConfig as any).executionReady = () => true;
  const ask = (question: string, extra: object = {}): Promise<any> => call('copilot:ask', { projectId: pid, context: {}, question, ...extra });

  // ── 1. conversations ──────────────────────────────────────────────────────
  const first = await ask('What do we have?', { agentId: fin.id });
  const firstThreads = (await call('copilot:threads', { projectId: pid })).threads;
  ok('conversations: the ask that starts the first one starts it with its agent', first.ok && first.agent?.id === fin.id && firstThreads.length === 1
    && firstThreads[0].agentId === fin.id && firstThreads[0].agentName === 'Finance assistant', JSON.stringify(firstThreads));
  const pa = (await call('copilot:newThread', { projectId: pid, agentId: null })).thread;
  ok('switching to the Project assistant is a new conversation, with no agent', !!pa && pa.id !== first.threadId && !('agentId' in pa), JSON.stringify(pa));
  const finT = (await call('copilot:newThread', { projectId: pid, agentId: fin.id })).thread;
  ok('switching back is another new one, with the agent stored', !!finT && finT.id !== pa.id && finT.id !== first.threadId && finT.agentId === fin.id);
  const hist = await call('copilot:history', { projectId: pid, threadId: finT.id });
  ok('history names the conversation\'s agent', hist.ok && hist.agent?.id === fin.id && hist.agent.name === 'Finance assistant' && !hist.agent.gone, JSON.stringify(hist.agent));
  const paHist = await call('copilot:history', { projectId: pid, threadId: pa.id });
  ok('NEGATIVE CONTROL: …and the Project assistant\'s none', paHist.ok && paHist.agent === null);
  const into = await ask('Anything new?', { threadId: first.threadId, agentId: all.id });
  ok('an existing conversation keeps its own agent, whatever the ask names', into.ok && into.threadId === first.threadId && into.agent?.id === fin.id && sent.at(-1)?.opts?.topic === true);

  // ── 2. facts ──────────────────────────────────────────────────────────────
  sent.length = 0;
  await ask('Show me everything', { threadId: finT.id });
  await ask('Show me everything', { threadId: pa.id });
  const [agentFacts, projectFacts] = [sent[0].facts, sent[1].facts];
  const head = (f: string): string => f.slice(0, f.indexOf('<<<GUIDANCE') < 0 ? undefined : f.indexOf('<<<GUIDANCE'));
  ok('facts: the topic\'s datasets and no other', /Invoices/.test(head(agentFacts)) && /Payroll/.test(head(agentFacts)) && !/Orders/.test(head(agentFacts))
    && /Topic: "Finance"/.test(agentFacts) && /all this assistant answers from/.test(agentFacts), head(agentFacts));
  ok('NEGATIVE CONTROL: the Project assistant\'s facts hold the rest', /Orders/.test(head(projectFacts)) && !/Topic: "Finance"/.test(projectFacts), head(projectFacts));
  sent.length = 0;
  await ask('Tell me about it', { threadId: finT.id, context: { kind: 'dataset', id: invoices.id } });
  await ask('Tell me about it', { threadId: finT.id, context: { kind: 'dataset', id: orders.id } });
  ok('facts: a dataset on screen inside the topic keeps its own facts', /amount/.test(sent[0].facts) && !/Topic: "Finance"/.test(sent[0].facts), sent[0].facts.slice(0, 300));
  ok('…one outside it gives the topic\'s instead', /Topic: "Finance"/.test(sent[1].facts) && !/region/.test(head(sent[1].facts)), head(sent[1].facts));

  // ── 3. guidance and examples ──────────────────────────────────────────────
  const at = (f: string, s: string): number => f.indexOf(s);
  ok('guidance: the project\'s instructions, then the agent\'s, under the line that says they win',
    at(agentFacts, 'Revenue means booked deals') > 0 && at(agentFacts, 'Instructions for the assistant "Finance assistant"') > at(agentFacts, 'Revenue means booked deals')
    && at(agentFacts, 'Revenue means recognized revenue') > at(agentFacts, 'Instructions for the assistant') && /WIN where the two disagree/.test(agentFacts), agentFacts.slice(at(agentFacts, '<<<GUIDANCE')));
  ok('NEGATIVE CONTROL: the Project assistant\'s guidance has the project\'s and no agent\'s', at(projectFacts, 'Revenue means booked deals') > 0
    && !/recognized revenue/.test(projectFacts) && !/Instructions for the assistant/.test(projectFacts));
  sent.length = 0;
  await ask('Cost of revenue by vendor and region', { threadId: finT.id });
  await ask('Cost of revenue by vendor and region', { threadId: pa.id });
  const order = (f: string): string => (at(f, '"Amount by vendor"') < at(f, '"Total cost of revenue by region"') ? 'invoices-first' : 'orders-first');
  ok('examples: the topic\'s verified question first', at(sent[0].facts, '"Amount by vendor"') > 0 && order(sent[0].facts) === 'invoices-first', sent[0].facts.slice(at(sent[0].facts, 'Verified')));
  ok('NEGATIVE CONTROL: the Project assistant ranks by shared words, the other first', order(sent[1].facts) === 'orders-first', sent[1].facts.slice(at(sent[1].facts, 'Verified')));
  sent.length = 0;
  const exactOut = await ask('Total cost of revenue by region', { threadId: finT.id });
  const exactPa = await ask('Total cost of revenue by region', { threadId: pa.id });
  ok('an exact verified question outside the topic is no hit for the agent: the model is asked (and may say it is outside)', exactOut.ok && sent.length === 1 && exactOut.guidance?.verifiedId === undefined);
  ok('NEGATIVE CONTROL: for the Project assistant it is the app\'s answer, no model', exactPa.ok && sent.length === 1 && exactPa.guidance?.verifiedId === vOrders.q.id);
  // Both limits at once: inside the agent's topic, only what is open matches. "Amount by vendor" is verified on Invoices.
  sent.length = 0;
  const onPayroll = await ask('Amount by vendor', { threadId: finT.id, context: { kind: 'dataset', id: payroll.id } });
  const onInvoices = await ask('Amount by vendor', { threadId: finT.id, context: { kind: 'dataset', id: invoices.id } });
  ok('the agent with Payroll open, inside its topic: a verified question on Invoices is no hit, the model is asked',
    onPayroll.ok && onPayroll.guidance?.verifiedId === undefined && sent.length === 1, JSON.stringify(onPayroll.guidance));
  ok('NEGATIVE CONTROL: …with Invoices open it is the app\'s answer, no model', onInvoices.ok && onInvoices.guidance?.verifiedId === vInvoices.q.id && sent.length === 1, JSON.stringify(onInvoices.guidance));

  // ── 4. model and build ────────────────────────────────────────────────────
  sent.length = 0;
  replies.push({ ok: true, text: 'Here is a plan.', suggestedAction: { kind: 'plan', intent: 'build it', steps: [{ kind: 'import', file: 'a.csv', name: 'A' }] } });
  const planned = await ask('Make a plan for my file', { threadId: finT.id });
  ok('model: the agent\'s model is the one asked for', stableModel(sent[0].opts?.model) === 'gateway/finance-model');
  ok('build off: the answer-only prompt (no plan, no dashboard offered)', sent[0].opts?.build === false
    && !sa.chatSystemPrompt({ build: false, topic: true }).includes('"plan"') && !sa.chatSystemPrompt({ build: false, topic: true }).includes('"dashboard"'));
  ok('build off: a plan the model proposes anyway is dropped', planned.ok && planned.suggestedAction.kind === 'none', JSON.stringify(planned.suggestedAction));
  const refused = await call('plan:start', { projectId: pid, threadId: finT.id, intent: 'x', steps: [{ kind: 'import', file: 'a.csv', name: 'A' }] });
  ok('build off: plan:start refuses its conversation, in the agent\'s name', refused.ok === false && refused.error === msg.agentAnswersOnly('Finance assistant'), JSON.stringify(refused));
  replies.push({ ok: true, text: 'Here is a plan.', suggestedAction: { kind: 'plan', intent: 'build it', steps: [{ kind: 'import', file: 'a.csv', name: 'A' }] } });
  const paPlan = await ask('Make a plan for my file', { threadId: pa.id });
  const started = await call('plan:start', { projectId: pid, threadId: pa.id, intent: 'x', steps: [{ kind: 'import', file: 'a.csv', name: 'A' }] });
  ok('NEGATIVE CONTROL: the Project assistant offers the plan, with no model of its own, and it starts', paPlan.suggestedAction.kind === 'plan'
    && sent.at(-1)?.opts?.model === undefined && sent.at(-1)?.opts?.build === true && started.ok !== false, JSON.stringify(started).slice(0, 200));
  const models = [
    { provider: 'gateway', model: 'finance-model', label: 'F', isDefault: false },
    { provider: 'anthropic', model: 'mine', label: 'M', isDefault: false },
    { provider: 'anthropic', model: 'default', label: 'D', isDefault: true },
  ];
  const agentModel = { provider: 'gateway', model: 'finance-model' };
  ok('model choice: the agent\'s while it is enabled', aiConfig.chooseModel(models, agentModel, { provider: 'anthropic', model: 'mine' })?.model === 'finance-model');
  ok('…no longer enabled: the person\'s own pick', aiConfig.chooseModel(models.slice(1), agentModel, { provider: 'anthropic', model: 'mine' })?.model === 'mine');
  ok('…and with no pick either, the default', aiConfig.chooseModel(models.slice(1), agentModel, null)?.model === 'default');
  ok('NEGATIVE CONTROL: no agent model, the person\'s pick', aiConfig.chooseModel(models, null, { provider: 'anthropic', model: 'mine' })?.model === 'mine');

  // ── 5. a deleted agent ────────────────────────────────────────────────────
  await trash.trashRecord(pid, 'agent', fin.id);
  sent.length = 0;
  const kept = await call('copilot:history', { projectId: pid, threadId: finT.id });
  const after = await ask('Show me everything', { threadId: finT.id });
  ok('deleted: its conversation stays readable, named as deleted', kept.ok && kept.turns.length > 0 && kept.agent?.gone === true && kept.agent.name === 'Finance assistant', JSON.stringify(kept.agent));
  ok('deleted: the next question goes to the Project assistant (all data, no agent model), with the line saying so',
    after.ok && after.threadId === finT.id && /Orders/.test(head(sent[0].facts)) && sent[0].opts?.model === undefined && sent[0].opts?.topic === false
      && after.answer.startsWith(msg.agentWasDeleted('Finance assistant')) && after.turns.at(-1).text.startsWith(msg.agentWasDeleted('Finance assistant')), after.answer);
  await trash.restore(pid, 'agent', fin.id);
  sent.length = 0;
  const back = await ask('Show me everything', { threadId: finT.id });
  ok('restored: it answers again, from its topic, with no line', back.ok && !/Orders/.test(head(sent[0].facts)) && sent[0].opts?.topic === true && !back.answer.includes('Project assistant answered'), back.answer);

  // ── 6. a follow-up chip in an agent's conversation ───────────────────────
  sent.length = 0;
  const before = (await call('copilot:history', { projectId: pid, threadId: finT.id })).turns.length;
  const outsideChip = await call('answer:rerun', { projectId: pid, threadId: finT.id, spec: spec(orders, 'region', 'revenue'), label: 'Revenue by region' });
  ok('a chart outside the topic is refused in the agent\'s conversation, before anything is drawn or asked', outsideChip.ok === false && outsideChip.reason === msg.outsideTopic('Finance')
    && sent.length === 0 && (await call('copilot:history', { projectId: pid, threadId: finT.id })).turns.length === before, JSON.stringify(outsideChip));
  const insideChip = await call('answer:rerun', { projectId: pid, threadId: finT.id, spec: spec(invoices, 'vendor', 'amount'), label: 'Amount by vendor' });
  ok('…one inside it is narrated by the agent: its model, its instructions after the project\'s', insideChip.ok && sent.length === 1 && stableModel(sent[0].opts?.model) === 'gateway/finance-model'
    && /Revenue means recognized revenue/.test(sent[0].facts) && /Revenue means booked deals/.test(sent[0].facts), JSON.stringify(sent[0]?.opts));
  sent.length = 0;
  const paChip = await call('answer:rerun', { projectId: pid, threadId: pa.id, spec: spec(orders, 'region', 'revenue'), label: 'Revenue by region' });
  ok('NEGATIVE CONTROL: the Project assistant\'s conversation draws it, with the person\'s own model', paChip.ok && sent.length === 1 && sent[0].opts?.model === undefined && !/recognized revenue/.test(sent[0].facts));

  // ── 7. where an ask lands ────────────────────────────────────────────────
  const stale = '00000000-0000-4000-8000-00000000dead';
  const latest = (await call('copilot:threads', { projectId: pid })).threads[0];
  const landed = await ask('Anything else?', { threadId: stale });
  ok('a stale conversation id lands in the latest conversation, whose agent answered, and says so', landed.ok && landed.threadId === latest.id && (landed.agent?.id ?? null) === (latest.agentId ?? null), JSON.stringify([landed.threadId, latest]));

  // ── 8. an agent gone for good ────────────────────────────────────────────
  const temp = (await agents.saveAgent(pid, { name: 'Temporary assistant', topicId: null, model: null, build: true, teamIds: [] }))!;
  const tempT = (await call('copilot:newThread', { projectId: pid, agentId: temp.id })).thread;
  await trash.trashRecord(pid, 'agent', temp.id);
  await trash.purge(pid, 'agent', temp.id);
  const row = (await call('copilot:threads', { projectId: pid })).threads.find((t: { id: string }) => t.id === tempT.id);
  ok('a conversation whose agent was purged is marked deleted, with no name to show', row?.agentId === temp.id && row.agentGone === true && !('agentName' in row), JSON.stringify(row));
  ok('…and its history says the same', (await call('copilot:history', { projectId: pid, threadId: tempT.id })).agent?.gone === true);

  // ── 9. the instructions' room ────────────────────────────────────────────
  const long = (tag: string) => Array.from({ length: 40 }, (_, i) => `${tag} rule ${String(i).padStart(2, '0')}: ${'x'.repeat(260)}`);
  const both = guidance.guidanceBlock({ instructions: long('Project'), agent: { name: 'Finance assistant', instructions: long('Agent') } });
  const count = (tag: string) => both.text.split('\n').filter((l) => l.startsWith(`- ${tag} rule`)).length;
  ok('full lists: each keeps at least half the room — the project\'s apply to every agent, the agent\'s win', count('Project') >= 6 && count('Agent') >= 6 && both.text.length < guidance.INSTRUCTIONS_BLOCK_MAX + 1200, `${count('Project')} / ${count('Agent')}`);
  const lone = guidance.guidanceBlock({ instructions: ['Revenue means booked deals'], agent: { name: 'Finance assistant', instructions: long('Agent') } });
  ok('NEGATIVE CONTROL: a short project list leaves its room to the agent\'s', lone.text.includes('Revenue means booked deals') && lone.text.split('\n').filter((l) => l.startsWith('- Agent rule')).length > count('Agent'));
}

const stableModel = (m: { provider: string; model: string } | null | undefined): string => (m ? `${m.provider}/${m.model}` : '');

main().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
