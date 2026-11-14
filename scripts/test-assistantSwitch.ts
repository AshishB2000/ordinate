// The org's Assistant switch (`copilot:setEnabled`, config.copilotEnabled) holds on the SERVER, not only in the dock:
// with it off, every channel that would ask a model for the Assistant asks none, and an API token or a crafted RPC
// gets the catalogued "The Assistant is off" sentence (copilot:ask's `notReady`, which the dock already handles).
//
//   §1 one table, every channel: switched on, each asks the model (NEGATIVE CONTROL); switched off through the real
//      channel, none does; switched back on, each asks again — no restart, no cache to drop.
//   §2 what the app computes with no model stays: a verified question asked word for word (no prose), a chip, Explain,
//      an answer card and MCP's answer_verified_question answer with the switch off.
//   §3 a check already running stops before its next model call once the switch goes off.
//
//   npm run build:ts && node scripts/test-assistantSwitch.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-assistantswitch-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const planIpc: typeof import('../src/ipc/plan') = require('../src/ipc/plan');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const tools: typeof import('../src/automation/verifiedTools') = require('../src/automation/verifiedTools');
const { assistantOff }: typeof import('../src/ai/aiMessages') = require('../src/ai/aiMessages');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OFF = assistantOff();
const PROSE = 'Narrated.';

async function main(): Promise<void> {
  const pid = (await projects.createProject('Assistant switch'))!.id;
  const ds = (await datasets.saveDataset(pid, {
    name: 'Orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
    rows: [['West', 10], ['East', 20], ['West', 5]],
  }))!;
  copilotIpc.register();
  planIpc.register();
  verified.register();
  const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);
  const SPEC = { datasetId: ds.id, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 'Revenue by region' };
  for (const [question, category] of [['Revenue by region', 'region'], ['Revenue by amount', 'amount']] as const) {
    const s = await verified.saveVerifiedQuestion(pid, { question, spec: { ...SPEC, category } });
    if (!s.ok) throw new Error('fixture: ' + JSON.stringify(s));
  }

  // A model is "ready" and every call to it is counted; the switch itself is never stubbed.
  let calls = 0;
  (execConfig as any).executionReady = async () => true;
  (analyze as any).askCopilot = async () => { calls++; return { ok: true, text: PROSE, suggestedAction: { kind: 'none', intent: '' } }; };
  const FIXED = { kind: 'metric', dataset: 'Orders', name: 'Orders total', column: 'amount', aggregation: 'sum' };
  (analyze as any).dispatch = async () => { calls++; return { rawText: JSON.stringify(FIXED), error: null }; };
  const setEnabled = (enabled: boolean): Promise<any> => call('copilot:setEnabled', { enabled });
  const ask = (question: string, extra: object = {}): Promise<any> => call('copilot:ask', { projectId: pid, context: { kind: '' }, question, ...extra });

  /** A plan run whose one step failed (it names no dataset there is): what `plan:fix` acts on. */
  async function failedRun(): Promise<string> {
    const s = await call('plan:start', { projectId: pid, intent: 'a total', steps: [{ ...FIXED, dataset: 'Nope' }] });
    const n = await call('plan:next', { projectId: pid, runId: s.runId });
    if (n.status?.[0] !== 'failed') throw new Error('fixture: the plan step did not fail ' + JSON.stringify(n).slice(0, 300));
    return s.runId;
  }
  /** Start a check through its channel and wait for its job to end, so the next start is not "already running". */
  async function check(): Promise<any> {
    const r = await call('verified:check', { projectId: pid });
    for (let i = 0; r.ok && i < 200 && (await call('verified:checkResult', { projectId: pid })).run?.state === 'running'; i++) await sleep(10);
    return r;
  }

  // §1 Every channel that asks a model for the Assistant. `on` is its answer with the model; `off` its refusal.
  const testThread = (await call('copilot:newThread', { projectId: pid })).thread.id;
  const refusedAsk = (r: any) => r.ok === false && r.notReady === true && r.error === OFF;
  const CASES: Array<{ channel: string; run: () => Promise<any>; on: (r: any) => boolean; off: (r: any) => boolean }> = [
    { channel: 'copilot:ask (the dock)', run: () => ask('profit by region'), on: (r) => r.ok && r.answer === PROSE, off: refusedAsk },
    {
      channel: 'copilot:ask (the test chat: its own thread, streamed)',
      run: () => ask('profit by region', { threadId: testThread, askId: crypto.randomUUID() }),
      on: (r) => r.ok && r.threadId === testThread, off: refusedAsk,
    },
    { channel: 'answer:rerun (a chip: its narration)', run: () => call('answer:rerun', { projectId: pid, spec: SPEC, label: 'Again' }), on: (r) => r.ok && r.turns.at(-1).text === PROSE, off: (r) => r.ok && r.turns.at(-1).text === '' },
    { channel: 'answer:explain (its narration)', run: () => call('answer:explain', { projectId: pid, tile: { datasetId: ds.id, encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, filters: [], chartType: 'column', name: 'Revenue' } }), on: (r) => r.ok && r.narrated === true, off: (r) => r.ok && r.narrated === false },
    { channel: 'verified:check (Check the Assistant)', run: check, on: (r) => r.ok === true, off: (r) => r.ok === false && r.error === OFF },
    { channel: 'plan:fix', run: async () => call('plan:fix', { projectId: pid, runId: await failedRun(), index: 0 }), on: (r) => r.ok === true && r.fixed === 0, off: (r) => r.ok === false && r.error === OFF },
  ];

  async function sweep(state: 'on' | 'off' | 'on again'): Promise<void> {
    for (const c of CASES) {
      const before = calls;
      const r = await c.run();
      const asked = calls - before;
      const want = state === 'off' ? c.off(r) && asked === 0 : c.on(r) && asked > 0;
      ok(`${state}: ${c.channel} ${state === 'off' ? 'asks no model' : 'asks the model'}`, want, `asked ${asked}: ${JSON.stringify(r).slice(0, 300)}`);
    }
  }

  await sweep('on'); // NEGATIVE CONTROL: the stubs are reached, so a zero below means the switch held
  ok('the switch goes off through its own channel', (await setEnabled(false)).ok === true && execConfig.publicConfig().copilotEnabled === false);
  await sweep('off');

  // §2 What the app computes stays, switched off: no model, no prose, the figures the engine drew.
  const before = calls;
  const card = await call('answer:card', { projectId: pid, spec: SPEC });
  ok('off: answer:card still draws', card.ok === true && card.datasetName === 'Orders' && JSON.stringify(card.data).includes('West'), JSON.stringify(card).slice(0, 200));
  const mcp = await tools.answerVerifiedQuestion({ projectId: pid } as never, 'Revenue by region').then((a) => a, (e: Error) => e.message);
  ok('off: MCP answer_verified_question still answers', typeof mcp === 'object' && JSON.stringify(mcp).includes('West'), JSON.stringify(mcp).slice(0, 200));
  const typed = await ask('Revenue by region'); // asks no model, on or off (test-verifiedAsk)
  ok('off: a verified question word for word still answers, with no prose', typed.ok && typed.answer === '' && !!typed.guidance?.verifiedId, JSON.stringify(typed).slice(0, 200));
  ok('off: and none of them asked a model', calls === before);

  ok('the switch comes back on without a restart', (await setEnabled(true)).ok === true && execConfig.publicConfig().copilotEnabled === true);
  await sweep('on again');

  // §3 A check already running: the switch going off stops it before its next question.
  (analyze as any).askCopilot = async () => { calls++; await setEnabled(false); return { ok: true, text: PROSE, suggestedAction: { kind: 'none', intent: '' } }; };
  const mid = calls;
  ok('a running check starts', (await check()).ok === true);
  const run = (await call('verified:checkResult', { projectId: pid })).run;
  ok('switched off mid-run, it stops after the question it was on', run?.state === 'stopped' && run.asked === 1 && calls === mid + 1, JSON.stringify(run).slice(0, 300));
  await setEnabled(true);
}

main().then(() => finish(), (err) => { console.error(err); process.exitCode = 1; finish(); });
