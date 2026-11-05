// An exact match through the real `copilot:ask` handler (semantic part 3 D8, D10): a question asked word for
// word as a verified one is answered by the app — no model decides it, and none is needed. Any other question
// goes to the model, with the project's verified questions beside it as examples.
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
  ok('no model, exact match: answered by the app', r.ok && r.guidance?.verifiedId === V && calls === 0, JSON.stringify(r));
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
  ok('a model narrates a hit, but never picks it', narrated.ok && narrated.answer === 'West leads.' && narrated.guidance.verifiedId === V);

  await finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
