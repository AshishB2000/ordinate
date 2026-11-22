// The agent router's scorer, its decision and its one model call (docs/agent-router/00-design.md), over fixed agents and
// questions — no model, no database (the topics are real records in a temp dir).
//
//   1. the scorer: data (a topic's datasets, a column only when the topic keeps it, a metric the topic names), verified
//      questions, document titles and the description; an agent with no topic gets no data points — NEGATIVE CONTROL: the
//      same hits do score for an agent whose topic holds them; a hit by meaning alone counts 1
//   2. the decision: nothing to go on, a clear winner (1.5x), a close call (up to three), ties keep list order
//   3. the reason is the app's words from the matches ("Matched the Payroll dataset and the payroll cost metric.")
//   4. routeAsk: ONE search for any number of agents; fewer than two usable agents never searches; an agent the caller may not
//      use is never scored, offered or named, even when it matches best — NEGATIVE CONTROL: the same agent in `usable` wins;
//      the model is called only on a close call, with the question and the two agents' names and descriptions and nothing else;
//      a model with no clear answer: the web is asked (buttons), Slack takes the one with more matches
//
//   npm run build:ts && node scripts/test-agentRoute.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-agentroute-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const route: typeof import('../src/ai/agentRoute') = require('../src/ai/agentRoute');
const prompt: typeof import('../src/ai/agentRoutePrompt') = require('../src/ai/agentRoutePrompt');
const msg: typeof import('../src/ai/agentRouteMessages') = require('../src/ai/agentRouteMessages');
const router: typeof import('../src/ipc/agentRoute') = require('../src/ipc/agentRoute');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const { sanitizeRoute }: typeof import('../src/ai/routeTurn') = require('../src/ai/routeTurn');

type Hit = import('../src/ai/agentRoute').RouteHit;
const hit = (kind: Hit['kind'], name: string, datasetId: string, score: number, id = name): Hit => ({ kind, id, name, datasetId, score });
const agent = (id: string, o: Partial<import('../src/ai/agentRoute').RouteAgent> = {}): import('../src/ai/agentRoute').RouteAgent =>
  ({ id, description: '', datasets: null, metricIds: new Set(), termIds: new Set(), titles: [], ...o });
const topicOf = (...ids: string[]): Map<string, readonly string[] | null> => new Map(ids.map((i) => [i, null] as const));

async function main(): Promise<void> {
  // ── 1. the scorer ─────────────────────────────────────────────────────────
  const hr = agent('hr', { datasets: topicOf('d-hr'), metricIds: new Set(['m-pay']) });
  const sales = agent('sales', { datasets: topicOf('d-sales') });
  const hits = [hit('dataset', 'Payroll', 'd-hr', 4), hit('column', 'cost', 'd-hr', 4), hit('metric', 'payroll cost', 'd-hr', 8, 'm-pay'), hit('dataset', 'Orders', 'd-sales', 4)];
  const [top, runnerUp] = route.scoreAgents('What is our payroll cost?', [sales, hr], hits, []);
  ok('scorer: the agent whose topic holds the matches wins, whatever the list order', top.id === 'hr' && top.score === 16 && runnerUp.id === 'sales' && runnerUp.score === 4, JSON.stringify([top.score, runnerUp.score]));
  ok('scorer: a name matched by dataset and column is two matches, the best first', top.matches[0].name === 'payroll cost' && top.matches.length === 3);
  const nt = route.scoreAgents('What is our payroll cost?', [agent('all', { description: 'Everything' })], hits, [{ texts: ['Payroll cost by team'], datasetIds: ['d-hr'] }]);
  ok('scorer NEGATIVE CONTROL: an agent with no topic gets no data and no verified points (it would win everything)', nt[0].score === 0);
  const kept = route.scoreAgents('cost', [agent('f', { datasets: new Map([['d-hr', ['salary']]]) }), agent('g', { datasets: new Map([['d-hr', ['cost']]]) })], [hit('column', 'cost', 'd-hr', 4)], []);
  ok('scorer: a column counts only when the topic keeps that field', kept[0].id === 'g' && kept[0].score === 4 && kept[1].score === 0);
  const meaning = route.scoreAgents('how many people left', [hr], [hit('dataset', 'Staff', 'd-hr', 0)], []);
  ok('scorer: a hit found by meaning alone (score 0) counts 1', meaning[0].score === 1);
  const v = route.scoreAgents('payroll cost per team', [hr, sales], [], [{ texts: ['Payroll cost by team', 'x'], datasetIds: ['d-hr'] }, { texts: ['Payroll cost by team'], datasetIds: ['d-hr', 'd-sales'] }]);
  ok('scorer: a verified question counts 2 per shared word, only when every dataset it reads is the agent\'s', v[0].id === 'hr' && v[0].score === 2 * 3 && v[1].score === 0, JSON.stringify(v.map((x) => x.score)));
  const doc = route.scoreAgents('holiday policy', [agent('a', { titles: ['Holiday policy 2026'] }), agent('b', { description: 'Answers about the holiday rota' })], [], []);
  ok('scorer: a document title counts 2 per word, a description 1', doc[0].id === 'a' && doc[0].score === 4 && doc[1].score === 1);
  const tie = route.scoreAgents('holiday', [agent('b', { description: 'holiday' }), agent('a', { description: 'holiday' })], [], []);
  ok('scorer: an equal score keeps the list order', tie.map((s) => s.id).join() === 'b,a');

  // ── 2. the decision ───────────────────────────────────────────────────────
  const s = (id: string, score: number): import('../src/ai/agentRoute').Scored => ({ id, score, matches: [] });
  ok('decide: nothing matches', route.decide([s('a', 0), s('b', 0)]).kind === 'none' && route.decide([]).kind === 'none');
  ok('decide: one stray word is no evidence', route.decide([s('a', 1), s('b', 0)]).kind === 'none');
  ok('decide: a clear winner (one or many agents)', JSON.stringify(route.decide([s('a', 6), s('b', 4)])) === '{"kind":"clear","id":"a"}' && route.decide([s('a', 2)]).kind === 'clear');
  ok('decide NEGATIVE CONTROL: just under 1.5x is a close call', JSON.stringify(route.decide([s('a', 6), s('b', 5)])) === '{"kind":"close","ids":["a","b"]}');
  ok('decide: a tie is close, at most three offered', JSON.stringify(route.decide([s('a', 5), s('b', 5), s('c', 5), s('d', 5)])) === '{"kind":"close","ids":["a","b","c"]}');
  ok('decide: one far behind is not offered', JSON.stringify(route.decide([s('a', 9), s('b', 8), s('c', 3)])) === '{"kind":"close","ids":["a","b"]}');

  // ── 3. the reason ─────────────────────────────────────────────────────────
  ok('why: the two best matches, in the app\'s words', route.whyOf(top) === msg.routeMatchedTwo(msg.routeMetric('payroll cost'), msg.routeDataset('Payroll')) && /^Matched the payroll cost metric and the Payroll dataset\.$/.test(route.whyOf(top)), route.whyOf(top));
  ok('why: one match, a document, a description, a verified question', route.whyOf(doc[0]) === msg.routeMatchedOne(msg.routeDocument('Holiday policy 2026')) && route.whyOf(doc[1]) === msg.routeMatchedOne(msg.routeDescription()) && route.whyOf(v[0]).includes(msg.routeVerified()));
  ok('why: none, nothing said', route.whyOf(s('x', 0)) === '');
  ok('route note: one line, cut, and nothing else survives', sanitizeRoute({ why: ' a\n b ', other: 1 })?.why === 'a b' && sanitizeRoute({ why: '' }) === undefined && sanitizeRoute('x') === undefined && sanitizeRoute({ why: 'x'.repeat(400) })?.why.length === 300);

  // ── the model call's text ─────────────────────────────────────────────────
  const u = prompt.routeUser('Revenue  per\nemployee?', { name: 'Finance', description: 'Money in and out' }, { name: 'Sales', description: '' });
  ok('model call: the question and the two agents\' names and descriptions, nothing else', u === 'Question: Revenue per employee?\n\nAssistants:\n1. Finance - Money in and out\n2. Sales', u);
  ok('model call: only a clear 1 or 2 is an answer', prompt.parseRoute('1') === 0 && prompt.parseRoute(' 2\n') === 1 && prompt.parseRoute('0') === null && prompt.parseRoute('1 because') === null && prompt.parseRoute('3') === null && prompt.parseRoute(undefined) === null);

  // ── 4. routeAsk, over real topics ─────────────────────────────────────────
  const pid = (await projects.createProject('Router'))!.id;
  const txt = (name: string) => ({ name, type: 'text' as const });
  const num = (name: string) => ({ name, type: 'number' as const });
  const people = (await datasets.saveDataset(pid, { name: 'Payroll', sourceKind: 'csv', columns: [txt('team'), num('cost')], rows: [['Ops', 7]] }))!;
  const orders = (await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: [txt('region'), num('revenue')], rows: [['West', 3]] }))!;
  const stock = (await datasets.saveDataset(pid, { name: 'Stock', sourceKind: 'csv', columns: [txt('sku'), num('units')], rows: [['A', 3]] }))!;
  const tHr = (await topics.saveTopic(pid, { name: 'HR', datasets: [{ id: people.id }] }))!;
  const tSales = (await topics.saveTopic(pid, { name: 'Sales', datasets: [{ id: orders.id }] }))!;
  const tStock = (await topics.saveTopic(pid, { name: 'Stock', datasets: [{ id: stock.id }] }))!;
  const mk = async (name: string, topicId: string | null, description?: string) => (await agents.saveAgent(pid, { name, description, topicId, model: null, build: false, teamIds: [] }))!;
  const aHr = await mk('HR agent', tHr.id, 'People and payroll');
  const aSales = await mk('Sales agent', tSales.id, 'Orders and revenue');
  const aStock = await mk('Stock agent', tStock.id, 'Inventory');

  let searches = 0;
  const calls: string[][] = [];
  const fake = (over: Partial<import('../src/ipc/agentRoute').RouteDeps> = {}): Partial<import('../src/ipc/agentRoute').RouteDeps> => ({
    search: async () => { searches += 1; return [hit('dataset', 'Payroll', people.id, 4), hit('column', 'cost', people.id, 4), hit('dataset', 'Orders', orders.id, 4), hit('dataset', 'Stock', stock.id, 2)]; },
    verified: async () => [],
    titles: async () => new Map(),
    pick: async (q, a, b) => { calls.push([q, a.name, b.name]); return null; },
    ...over,
  });
  const all = [aHr, aSales, aStock];

  searches = 0;
  const clear = await router.routeAsk(pid, 'payroll cost by team', all, 'ask', fake());
  ok('routeAsk: ONE search for three agents, and the clear winner answers with its reason', searches === 1 && clear.kind === 'agent' && clear.agentId === aHr.id && /^Matched /.test(clear.why) && calls.length === 0, JSON.stringify(clear));
  searches = 0;
  const one = await router.routeAsk(pid, 'payroll cost', [aHr], 'ask', fake());
  ok('routeAsk: with fewer than two usable agents nothing is searched or scored (Auto changes nothing)', one.kind === 'none' && searches === 0);
  searches = 0;
  const hidden = await router.routeAsk(pid, 'stock units', [aHr, aSales], 'ask', fake({ search: async () => { searches += 1; return [hit('dataset', 'Stock', stock.id, 20), hit('dataset', 'Payroll', people.id, 4)]; } }));
  ok('routeAsk: an agent the person may not use never wins, however well it matches (the Stock agent is not in `usable`)', hidden.kind === 'agent' && hidden.agentId === aHr.id, JSON.stringify(hidden));
  const named = await router.routeAsk(pid, 'stock units', [aHr, aSales], 'ask', fake({ search: async () => [hit('dataset', 'Stock', stock.id, 20), hit('dataset', 'Payroll', people.id, 4), hit('dataset', 'Orders', orders.id, 4)], pick: async () => null }));
  ok('…nor is it offered or named when the call is close', named.kind === 'choose' && !JSON.stringify(named).includes('Stock') && !JSON.stringify(named).includes(aStock.id), JSON.stringify(named));
  const control = await router.routeAsk(pid, 'stock units', all, 'ask', fake({ search: async () => [hit('dataset', 'Stock', stock.id, 20)] }));
  ok('routeAsk NEGATIVE CONTROL: the same agent, usable, wins', control.kind === 'agent' && control.agentId === aStock.id);
  const nothing = await router.routeAsk(pid, 'hello there', all, 'ask', fake({ search: async () => [] }));
  ok('routeAsk: nothing matches, the usual pick stands', nothing.kind === 'none');

  const close = fake({ search: async () => [hit('dataset', 'Payroll', people.id, 6), hit('dataset', 'Orders', orders.id, 5)] });
  calls.length = 0;
  const asked = await router.routeAsk(pid, 'headcount spend', [aHr, aSales], 'ask', close);
  ok('close call: the model is asked once, with the question and the two agents', calls.length === 1 && calls[0].join('|') === 'headcount spend|HR agent|Sales agent');
  ok('…and when it cannot say, the web gets two agent buttons (no answer yet)', asked.kind === 'choose' && asked.options.map((o) => o.name).join() === 'HR agent,Sales agent' && asked.options[0].description === 'People and payroll', JSON.stringify(asked));
  const best = await router.routeAsk(pid, 'headcount spend', [aHr, aSales], 'best', close);
  ok('…a Slack direct message takes the one with more matches', best.kind === 'agent' && best.agentId === aHr.id && best.why === msg.routeMoreMatches(), JSON.stringify(best));
  const second = await router.routeAsk(pid, 'headcount spend', [aHr, aSales], 'ask', fake({ search: close.search, pick: async () => 1 }));
  ok('…and a model that picks the second is believed, and the reason is the app\'s sentence, not the model\'s', second.kind === 'agent' && second.agentId === aSales.id && second.why === msg.routeModelPicked(), JSON.stringify(second));
  calls.length = 0;
  await router.routeAsk(pid, 'payroll cost by team', all, 'ask', fake());
  ok('NEGATIVE CONTROL: a clear winner makes no model call', calls.length === 0);
  const broken = await router.routeAsk(pid, 'payroll cost by team', all, 'ask', fake({ titles: async () => { throw new Error('boom'); } }));
  ok('routeAsk: a read that throws never costs the question: nothing to compare, the usual pick stands', broken.kind === 'none');
  const docs = await router.routeAsk(pid, 'holiday policy', [aHr, aSales], 'ask', fake({ search: async () => [], titles: async () => new Map([[aSales.id, ['Holiday policy']]]) }));
  ok('routeAsk: a document title decides, and is named', docs.kind === 'agent' && docs.agentId === aSales.id && docs.why === msg.routeMatchedOne(msg.routeDocument('Holiday policy')), JSON.stringify(docs));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
