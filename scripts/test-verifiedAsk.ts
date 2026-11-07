// An exact match through the real `copilot:ask` handler (semantic part 3 D8, D10): a question asked word for
// word as a verified one is answered by the app — no model decides it, and none is needed. Any other question
// goes to the model, with the project's verified questions beside it as examples.
//
// PART 5 (p5-09): a verified question over a period metric can't be answered by a card, so its save refuses, and a
// stored one (asked, or through MCP answer_verified_question) says the kind can't be shown here yet, never "a newer
// version of Ordinate". NEGATIVE CONTROL: the same question on the base's column saves and is answered.
//
//   npm run build:ts && node scripts/test-verifiedAsk.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-verifiedask-'));
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const rules: typeof import('../src/ai/answerRefine') = require('../src/ai/answerRefine');

async function main(): Promise<void> {
  const pid = (await projects.createProject('Verified ask'))!.id;
  const ds = (await datasets.saveDataset(pid, {
    name: 'Orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
    rows: [['West', 10], ['East', 20], ['West', 5]],
  }))!;
  const tmp = (await datasets.saveDataset(pid, {
    name: 'Scratch', sourceKind: 'csv', columns: [{ name: 'k', type: 'text' }, { name: 'v', type: 'number' }], rows: [['a', 1]],
  }))!;
  copilotIpc.register();
  const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);
  const SPEC = { datasetId: ds.id, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 'x' };
  const saved = await verified.saveVerifiedQuestion(pid, { question: 'Revenue by region', phrasings: ['revenue per region'], spec: SPEC });
  if (!saved.ok) throw new Error('fixture: ' + JSON.stringify(saved));
  const V = saved.q.id;
  const scratch = await verified.saveVerifiedQuestion(pid, { question: 'Scratch by k', spec: { ...SPEC, datasetId: tmp.id, category: 'k', measures: [{ column: 'v', aggregation: 'sum' as const }] } });
  if (!scratch.ok) throw new Error('fixture: ' + JSON.stringify(scratch));

  let calls = 0;
  (analyze as any).askCopilot = async () => { calls++; return { ok: false, errorType: 'not_ready' }; };
  (analyze as any).dispatch = async () => { calls++; throw new Error('no model'); };
  (execConfig as any).executionReady = async () => false;
  const ask = (question: string, extra: object = {}): Promise<any> => call('copilot:ask', { projectId: pid, context: {}, question, ...extra });

  const r = await ask('revenue by region?');
  ok('no model, exact match: answered by the app, and its guidance says no model narrated it', r.ok && r.guidance?.verifiedId === V && calls === 0 && !('narrated' in r.guidance), JSON.stringify(r));
  ok('the turn stores the verified spec', rules.sameChart(r.turns.at(-1).answer, saved.q.spec));
  const again = await ask('Revenue per region', { threadId: r.threadId });
  ok('a phrasing answers into the same thread', again.ok && again.threadId === r.threadId && again.turns.length === r.turns.length + 2 && calls === 0);
  ok('punctuation only is no match', (await ask('???')).notReady === true && calls === 1);
  ok('control: "…last year" goes to the model', (await ask('revenue by region last year')).notReady === true && calls === 2);

  await datasets.deleteDataset(pid, tmp.id);
  const before = calls;
  ok('a question that no longer runs is not matched', (await ask('Scratch by k')).notReady === true && calls === before + 1);

  (execConfig as any).executionReady = async () => true;
  (analyze as any).askCopilot = async () => ({ ok: true, text: 'West leads.', suggestedAction: { kind: 'none', intent: '' } });
  const narrated = await ask('Revenue by region');
  ok('a model narrates a hit, but never picks it, and the guidance says it narrated', narrated.ok && narrated.answer === 'West leads.' && narrated.guidance.verifiedId === V
    && narrated.guidance.narrated === true, JSON.stringify(narrated.guidance));

  // ── Examples ──────────────────────────────────────────────────────────────
  const sent: string[] = [];
  (analyze as any).askCopilot = async (_p: unknown, facts: string) => { sent.push(facts); return { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } }; };
  const ex = await ask('profit by region');
  const open = sent[0].indexOf('<<<GUIDANCE');
  const block = sent[0].slice(open, sent[0].indexOf('\nGUIDANCE', open));
  ok('a model-bound question carries the verified questions as examples, in the fence',
    block.includes('Verified questions — when a question means one of these') && block.includes('- "Revenue by region" → {"dataset":"Orders"'), sent[0].slice(-600));
  ok('the reply names the examples shown', ex.ok && ex.guidance.examples.join() === V && ex.guidance.instructions === 0 && ex.guidance.verifiedId === undefined, JSON.stringify(ex.guidance));
  ok('a question that no longer runs is no example', !block.includes('Scratch by k'));
  const bare = (await projects.createProject('No verified'))!.id;
  await call('copilot:ask', { projectId: bare, context: { kind: '' }, question: 'profit by region' });
  const guidanceMod: typeof import('../src/ipc/guidance') = require('../src/ipc/guidance');
  ok('NEGATIVE CONTROL: with no verified question the prompt is the old one', !sent[1].includes('Verified questions') && Object.is(sent[1].includes('GUIDANCE'), false)
    && Object.is((await guidanceMod.askGuidance(bare, { kind: '' }, 'project', 'profit by region')).text, (await guidanceMod.askGuidance(bare, { kind: '' }, 'project')).text));

  // ── How it was answered stays on the stored turn ──────────────────────────
  const hist = async (t: string): Promise<any[]> => (await call('copilot:history', { projectId: pid, threadId: t })).turns;
  (analyze as any).askCopilot = async () => ({ ok: true, text: 'Narrated.', suggestedAction: { kind: 'none', intent: '' } });
  const kept = await ask('Revenue by region');
  ok('a verified answer remembers how, narrated and all', ((g) => g?.verifiedId === V && g.narrated === true)((await hist(kept.threadId)).at(-1).guidance));
  (analyze as any).askCopilot = async (_p: unknown, facts: string) => { sent.push(facts); return { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } }; };
  const modelled = await ask('profit by region', { threadId: kept.threadId });
  const mg = (await hist(kept.threadId)).at(-1).guidance;
  ok('a model answer remembers its counts and examples', modelled.ok && mg && mg.instructions === 0 && mg.examples.join() === V && !('verifiedId' in mg), JSON.stringify(mg));
  const rr = await call('answer:rerun', { projectId: pid, threadId: kept.threadId, spec: SPEC, label: 'Again' });
  ok('a chip rerun stores none', rr.ok && !('guidance' in rr.turns.at(-1)) && !('guidance' in (await hist(kept.threadId)).at(-1)));

  // ── Part 5's kinds (p5-09): the card says where it can't be shown, not that Ordinate is old ──────────────
  const metricsStore: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
  const pendingMsg: typeof import('../src/analysis/pendingMessages') = require('../src/analysis/pendingMessages');
  const store: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
  const tools: typeof import('../src/automation/verifiedTools') = require('../src/automation/verifiedTools');
  const visits = (await datasets.saveDataset(pid, {
    name: 'Visits', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }],
    rows: [['West', '2024-01-05', 3], ['East', '2024-02-05', 4]],
  }))!;
  const base = (await metricsStore.saveMetric(pid, { name: 'Visit amount', datasetId: visits.id, timeColumn: 'day', definition: { column: 'amount', aggregation: 'sum' } }))!;
  const ytd = (await metricsStore.saveMetric(pid, { name: 'Visit amount YTD', datasetId: visits.id, definition: { base: base.id, window: { to_date: 'year' } } }))!;
  const KIND = { ...SPEC, datasetId: visits.id, measures: [{ column: 'amount', aggregation: 'sum' as const, metricId: ytd.id }] };
  const said = pendingMsg.metricKindNotHere(ytd.name);
  const refused = await verified.saveVerifiedQuestion(pid, { question: 'Visit amount YTD by region', spec: KIND });
  ok('part 5: a verified question over a period metric is refused at save, saying the kind can\'t be shown here yet', !refused.ok && refused.error.includes(said) && !/newer version/.test(refused.error), JSON.stringify(refused));
  const planted = await store.writeVerified(pid, { ...saved.q, id: crypto.randomUUID(), question: 'Visit YTD by region', phrasings: [], spec: KIND });
  if (!planted) throw new Error('fixture: planted verified question');
  (analyze as any).askCopilot = async () => { calls++; return { ok: false, errorType: 'not_ready' }; };
  const before5 = calls;
  const asked = await ask('Visit YTD by region');
  ok('part 5: asked word for word, the stored one says the same, and no model is asked', asked.ok === false && asked.error === said && calls === before5, JSON.stringify(asked).slice(0, 300));
  const mcp = await tools.answerVerifiedQuestion({ projectId: pid } as never, 'Visit YTD by region').then(() => 'answered', (e: Error) => e.message);
  ok('part 5: …and so does MCP answer_verified_question', mcp === said, mcp);
  const plain = await verified.saveVerifiedQuestion(pid, { question: 'Visit amount by region', spec: { ...KIND, measures: [{ column: 'amount', aggregation: 'sum' as const }] } });
  ok('NEGATIVE CONTROL: part 5: the same question on the base\'s column saves, and is answered', plain.ok && (await ask('Visit amount by region')).ok === true, JSON.stringify(plain).slice(0, 200));

  finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
