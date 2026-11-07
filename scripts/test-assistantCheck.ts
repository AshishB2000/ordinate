// Check the Assistant (semantic layer part 3 D13 (3), Q3): an editor runs the project's working verified questions
// against its own model, once each, as a job on the in-process queue. The run's progress and result are one project
// record any pod reads; the model's replies are scored by the same judge CI's replay uses (../src/ipc/verifiedJudge).
//
//   §1 the run: it answers before any model call, one at a time per project, leave-one-out in every prompt, the cap,
//      Live without the warehouse, no model no check, and a record that holds no spec, figure or prompt
//   §2 the two channels: `verified:check` replies with the run id while the model is still asked; `verified:checkResult`
//      reads it back; a dead pod's run (a stale heartbeat) reads as stopped and does not block the next start. The
//      viewer's 403 and the restricted reader's missing reasons are scripts/test-rowPolicySafetyNet.ts' (they need roles).
//
//   npm run build:ts && node scripts/test-assistantCheck.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

// Server mode and the fake warehouse, loaded BEFORE anything that reads app paths.
const H: typeof import('./liveQueryHarness') = require('./liveQueryHarness');
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const store: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const { projectDir }: typeof import('../src/app/recordKinds') = require('../src/app/recordKinds');
const { SAMPLE_VERIFIED }: typeof import('../src/app/sampleGuidance') = require('../src/app/sampleGuidance');
const C: typeof import('../src/ipc/assistantCheck') = require('../src/ipc/assistantCheck');
const msg: typeof import('../src/ipc/assistantCheckMessages') = require('../src/ipc/assistantCheckMessages');
const api: typeof import('../src/api/index') = require('../src/api/index');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<unknown>> = require('../src/server/rpc').handlers;
type Run = import('../src/ipc/assistantCheck').CheckRun;
type Spec = import('../src/ai/answerSpec').AnswerSpec;

const REV = [{ column: 'revenue', aggregation: 'sum' as const }];
const answer = (spec: unknown) => ({ ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: '', spec } });
// Revenue → its exact spec; Profit → a wrong measure; Top 5 → prose only; the fourth → the model's error.
const REPLY: Record<string, unknown> = {
  'Revenue by region': answer({ dataset: 'Retail orders', category: 'region', measures: REV }),
  'Profit by category': answer({ dataset: 'Retail orders', category: 'category', measures: REV }),
  'Top 5 states by revenue': { ok: true, text: 'California leads.', suggestedAction: { kind: 'none', intent: '' } },
  'Revenue by month last year': { ok: false, errorType: 'network', message: 'No connection. Check your internet and try again.' },
  'Amount by region': answer({ dataset: 'Live', category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }], filters: [{ column: 'region', op: 'in', values: ['West'] }] }),
};
const PROSE = { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } };

const outcome = (run: Run, question: string, ids: Map<string, string>) => run.results.find((r) => r.id === ids.get(question))?.outcome;
const rawCheck = (projectId: string): string => fs.readFileSync(path.join(projectDir(projectId), 'assistant-check.json'), 'utf8');

/** Start a check and wait for its job, whatever it ends in; the record as it then reads. */
async function runToEnd(projectId: string): Promise<Run> {
  const s = await C.startCheck(projectId);
  if (!s.ok) throw new Error('could not start: ' + s.error);
  await s.done.catch(() => undefined);
  return (await C.readCheck(projectId))!;
}

/** Plant `n` more working questions, older than the sample's, without drawing each (the store, not the save). */
async function plant(projectId: string, n: number): Promise<void> {
  const [like] = await store.listVerified(projectId);
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString();
    await store.writeVerified(projectId, { ...like, id: randomUUID(), question: `Planted question number ${i}`, phrasings: [], createdAt: at, updatedAt: at, verifiedAt: at });
  }
}

async function main(): Promise<void> {
  const live = await H.setupOrg(H.ORG_A);
  await H.as(H.ORG_A, async () => {
    const P = String((await sample.seedSampleProject({ again: true })).projectId);
    const ids = new Map((await store.listVerified(P)).map((q) => [q.question, q.id] as const));
    (execConfig as any).executionReady = async () => true;

    // ── §1 The run ──────────────────────────────────────────────────────────
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prompts: { q: string; facts: string }[] = [];
    (analyze as any).askCopilot = async (_p: unknown, facts: string, q: string) => {
      prompts.push({ q, facts });
      await gate;
      return REPLY[q] ?? PROSE;
    };
    const s = await C.startCheck(P);
    const first = await C.readCheck(P);
    ok('it starts and replies before any answer', s.ok && first?.state === 'running' && first.asked === 0 && first.runId === s.runId, JSON.stringify(first));
    const again = await C.startCheck(P);
    ok('a second start is refused while it runs', !again.ok && again.error === msg.checkRunning(), JSON.stringify(again));
    const job = jobs.snapshot().active.find((j) => j.kind === 'assistant-check');
    ok('it is a cancellable job on the in-process queue, labelled', job?.label === msg.checkLabel() && job.cancellable && job.projectId === P, JSON.stringify(job));
    release();
    if (s.ok) await s.done;
    const run = (await C.readCheck(P))!;
    ok('outcomes', run.state === 'done' && outcome(run, 'Revenue by region', ids) === 'match' && outcome(run, 'Profit by category', ids) === 'differs'
      && outcome(run, 'Top 5 states by revenue', ids) === 'refused', JSON.stringify(run));
    ok('prose only is refused with the sentence; a model error with its message',
      run.results.find((r) => r.id === ids.get('Top 5 states by revenue'))?.reason === msg.checkNoChart()
        && run.results.find((r) => r.id === ids.get('Revenue by month last year'))?.reason === 'No connection. Check your internet and try again.', JSON.stringify(run.results));
    ok('counts are the server\'s', run.total === 4 && run.asked === 4 && run.matched === 1 && run.skipped === 0 && !!run.finishedAt, JSON.stringify(run));
    ok('each question asked once, newest first, by its own words', prompts.map((p) => p.q).join('|') === SAMPLE_VERIFIED.map((v) => v.question).join('|'), prompts.map((p) => p.q).join('|'));
    ok('leave-one-out in every prompt', prompts.every((p) => !p.facts.includes(`"${p.q}" →`)) && prompts.every((p) => p.facts.includes('Verified questions')), prompts[0]?.facts.slice(-400));
    ok('no figure and no spec in the record', !/"(labels|series|spec|measures|values|facts)"/.test(rawCheck(P)) && !rawCheck(P).includes('Retail orders'), rawCheck(P));
    ok('the record holds who started it', run.startedBy === H.ORG_A.user.email);

    // The cap: the 50 newest of 59 working questions.
    (analyze as any).askCopilot = async (_p: unknown, _f: string, q: string) => REPLY[q] ?? PROSE;
    await plant(P, 55);
    const capped = await runToEnd(P);
    ok('at most 50 a run', capped.state === 'done' && capped.asked === 50 && capped.total === 50 && capped.skipped === 9 && capped.results.length === 50, JSON.stringify({ ...capped, results: capped.results.length }));
    ok('the record places every working question: the run\'s 50 first, in the order asked, then the 9 skipped', capped.ids?.length === 59
      && capped.ids.slice(0, 50).join() === capped.results.map((r) => r.id).join(), JSON.stringify(capped.ids?.length));

    // The heartbeat is written before each model call, the first too: a slow model call is not a dead pod's run.
    const copilotMod = require('../src/ipc/copilot') as { buildFacts: (...a: unknown[]) => Promise<unknown> };
    const realFacts = copilotMod.buildFacts;
    copilotMod.buildFacts = async (...a: unknown[]) => { await new Promise((r) => setTimeout(r, 40)); return realFacts(...a); }; // a slow inventory
    const beats: number[] = [];
    (analyze as any).askCopilot = async (_p: unknown, _f: string, q: string) => {
      const st = JSON.parse(rawCheck(P));
      beats.push(Date.parse(st.heartbeatAt) - Date.parse(st.startedAt));
      return REPLY[q] ?? PROSE;
    };
    await runToEnd(P);
    copilotMod.buildFacts = realFacts;
    ok('a fresh heartbeat is stored before each model call, the first one too', beats.length === 50 && beats[0] >= 40 && beats.every((b, i) => i === 0 || b >= beats[i - 1]), JSON.stringify(beats.slice(0, 3)));

    // Cancel between questions: the record says stopped.
    let hold!: () => void;
    const slow = new Promise<void>((r) => (hold = r));
    (analyze as any).askCopilot = async () => { await slow; return PROSE; };
    const cs = await C.startCheck(P);
    const cj = jobs.snapshot().active.find((j) => j.kind === 'assistant-check');
    await H.until(() => jobs.get(cj!.id)?.state === 'running');
    jobs.cancel(cj!.id);
    hold();
    if (cs.ok) await cs.done.catch(() => undefined);
    const cancelled = (await C.readCheck(P))!;
    ok('a cancel writes stopped', cancelled.state === 'stopped' && cancelled.asked < cancelled.total && !!cancelled.finishedAt, JSON.stringify({ ...cancelled, results: cancelled.results.length }));

    // A throw writes error, its message cut to 300.
    (analyze as any).askCopilot = async () => { throw new Error('x'.repeat(400)); };
    const broke = await runToEnd(P);
    ok('a throw writes error, cut to 300', broke.state === 'error' && broke.error?.length === 300, JSON.stringify({ ...broke, results: broke.results.length }));

    ok('a record read twice reads the same (sanitize twice == once)', JSON.stringify(C.sanitizeCheck(JSON.parse(rawCheck(P)))) === JSON.stringify(C.sanitizeCheck(C.sanitizeCheck(JSON.parse(rawCheck(P))))));
    ok('a corrupt record reads as none', (fs.writeFileSync(path.join(projectDir(P), 'assistant-check.json'), '{"runId":'), (await C.readCheck(P)) === null));

    // Live: specs only, no warehouse statement (the copy draws; a Live dataset is never asked).
    const P2 = live.projectId;
    const atStart = H.fake.calls.length;
    const saved = await verified.saveVerifiedQuestion(P2, { question: 'Amount by region', spec: { datasetId: live.liveId, category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Amount by region' } as Spec & Record<string, unknown> });
    if (!saved.ok) throw new Error('fixture: ' + saved.error);
    (analyze as any).askCopilot = async (_p: unknown, _f: string, q: string) => REPLY[q] ?? PROSE;
    const before = H.fake.calls.length;
    ok('NEGATIVE CONTROL: drawing the Live question does ask the warehouse', before > atStart);
    const lr = await runToEnd(P2);
    ok('Live: no warehouse statement', H.fake.calls.length === before && lr.state === 'done' && lr.asked === 1 && lr.results[0]?.outcome === 'differs', JSON.stringify(lr));

    (execConfig as any).executionReady = async () => false;
    const none = await C.startCheck(P);
    ok('no model, no check', !none.ok && none.error === msg.checkNoModel(), JSON.stringify(none));
    (execConfig as any).executionReady = async () => true;
    const empty = (await (require('../src/app/projects') as typeof import('../src/app/projects')).createProject('No questions')).id;
    const nothing = await C.startCheck(empty);
    ok('no working question, no check', !nothing.ok && nothing.error === msg.checkNothing(), JSON.stringify(nothing));

    // ── §2 The two channels ─────────────────────────────────────────────────
    ok('contracts: start is write, the result is read, both project-scoped', api.contracts['verified:check'].access === 'write' && api.contracts['verified:checkResult'].access === 'read'
      && typeof (api.contracts['verified:check'] as { project?: unknown }).project === 'function' && typeof (api.contracts['verified:checkResult'] as { project?: unknown }).project === 'function');
    verified.register();
    const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload); // any: each handler's own reply
    let open!: () => void;
    const held = new Promise<void>((r) => (open = r));
    (analyze as any).askCopilot = async (_p: unknown, _f: string, q: string) => { await held; return REPLY[q] ?? PROSE; };
    const finished = new Promise<void>((r) => { const off = jobs.onFinish((j) => { if (j.kind === 'assistant-check') { off(); r(); } }); });
    const started = await call('verified:check', { projectId: P });
    ok('verified:check replies with the run id while the model is still asked', started.ok === true && typeof started.runId === 'string' && !('done' in started), JSON.stringify(started));
    const reading = await call('verified:checkResult', { projectId: P });
    ok('verified:checkResult reads the same run, running', reading.ok === true && reading.run?.runId === started.runId && reading.run.state === 'running', JSON.stringify(reading));
    open();
    await finished;
    const read = (await call('verified:checkResult', { projectId: P })).run;
    ok('…and its result once done, reasons and all for an editor', read.state === 'done' && read.asked === 50 && read.results.some((r: { reason?: string }) => r.reason === msg.checkNoChart()), JSON.stringify({ ...read, results: read.results.length }));
    const old = new Date(Date.now() - 3 * 60_000).toISOString();
    fs.writeFileSync(path.join(projectDir(P), 'assistant-check.json'), JSON.stringify({ ...read, state: 'running', heartbeatAt: old, finishedAt: undefined }));
    const dead = (await call('verified:checkResult', { projectId: P })).run;
    ok('a dead pod\'s run (heartbeat 3 minutes old) reads as stopped', dead.state === 'stopped' && dead.runId === read.runId, JSON.stringify({ ...dead, results: dead.results.length }));
    fs.writeFileSync(path.join(projectDir(P), 'assistant-check.json'), JSON.stringify({ ...read, state: 'running', heartbeatAt: new Date().toISOString() }));
    ok('NEGATIVE CONTROL: a fresh heartbeat still blocks a start', (await call('verified:check', { projectId: P })).error === msg.checkRunning());
    fs.writeFileSync(path.join(projectDir(P), 'assistant-check.json'), JSON.stringify({ ...read, state: 'running', heartbeatAt: old }));
    const next = await call('verified:check', { projectId: P });
    ok('…and a stale one does not', next.ok === true && next.runId !== read.runId, JSON.stringify(next));
    await new Promise<void>((r) => { const off = jobs.onFinish((j) => { if (j.kind === 'assistant-check') { off(); r(); } }); });
  });
  H.cleanup();
  finish();
}

main().catch((err) => { console.error(err); process.exitCode = 1; finish(); });
