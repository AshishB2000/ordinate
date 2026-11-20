// Deep research, end to end through the REAL doors: a scripted model provider (scripts/researchHarness.ts) chooses each step; the
// real `computeCard`, drivers and SQL gate compute it; the run is claimed by the real worker, as its starter, with a lease.
// Covers: the model-call count of a run; a refused step (counts toward steps, not queries); facts and ledgers kept off every browser
// reply; the research turn; the private report; "Add to project" (the saved charts, the Story, the question-5 rule, idempotence);
// and every failure: a model error, an engine failure, a failed write, a stop, an exhausted AI budget, the deadline, and a
// crash retaken on "another pod" without repeating a finished step.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-researchRun.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { researchWorld, sleep, until, answerStep, PLAN } from './researchHarness';

const store: typeof import('../src/server/research/db') = require('../src/server/research/db');
const worker: typeof import('../src/server/research/worker') = require('../src/server/research/worker');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const slackDb: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const { shows }: typeof import('../src/ipc/turnsOpen') = require('../src/ipc/turnsOpen');
const budget = { clear: (): void => require("../src/server/slack/ask")._clearBudgetForTest() };
const say: typeof import('../src/server/researchMessages') = require('../src/server/researchMessages');

const DONE = '{"kind":"done"}';
const byRegion = (dataset: string) => answerStep({ dataset, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }] }, `sales by region on ${dataset}`);
const DRIVERS = JSON.stringify({ kind: 'drivers', request: { dataset: 'Plain', metric: { column: 'sales', aggregation: 'sum', label: 'Sales' }, compare: { mode: 'latest', column: 'day' } } });
const BAD_DRIVERS = JSON.stringify({ kind: 'drivers', request: { dataset: 'Plain', metric: { column: 'sales', aggregation: 'sum' }, compare: { mode: 'latest', column: 'no_such_date' } } });
const SQL = JSON.stringify({ kind: 'sql', intent: 'sales per region by SQL', datasets: ['Plain'] });
const WRITE = JSON.stringify({
  title: 'Where sales come from',
  summary: 'Sales were 6252 in total.',
  sections: [
    { heading: 'By region', text: 'Total sales were 6252 and West led at 1784. SECTION_ONE_CANARY.', steps: [1] },
    { heading: 'Why it moved', text: 'Sales rose by 13 but 999999 was claimed. SECTION_TWO_CANARY.', steps: [3] },
  ],
  caveats: ['The data is monthly.', 'Sales rose 12.5% somewhere'],
  conclusion: 'West leads at 1784.',
});

(async () => {
  const S = await researchWorld('research run');
  if (!S) return;
  const { W, stub } = S;
  const get = async (who: string, id: string) => (await W.call(who, 'research:get', { projectId: W.P, runId: id }));
  const go = async (who: string, q: string, o: { threadId?: string } = {}) => {
    const r = await S.start(who, q, o);
    if (r.status !== 200 || !r.body?.ok) throw new Error('start failed: ' + r.text);
    return r.body.runId as string;
  };
  try {
    // ── A run that writes a report ──────────────────────────────────────────────────────────────────────────────────────
    stub.steps = [byRegion('Plain'), byRegion('Nowhere'), DRIVERS, SQL, DONE];
    stub.sql = 'SELECT region, sum(sales) AS total FROM plain GROUP BY region ORDER BY region';
    stub.write = WRITE;
    const id = await go('ed', 'Why do sales move?');
    const started = await W.call('ed', 'research:get', { projectId: W.P, runId: id });
    ok('start: the run is queued and its reply names no fact', started.body?.ok && started.body.run.state === 'queued' && started.body.run.steps.length === 0, started.text.slice(0, 200));
    const run = await S.drive(id);
    ok('run: it ends done, with a report', run?.state === 'done' && !!run.report && !run.report.chartsOnly, `${run?.state} ${run?.errorCode}`);
    ok('steps: 1 chart, 1 refused, drivers and SQL computed by the engine', JSON.stringify(run?.steps.map((s) => [s.kind, s.status])) === '[["answer","done"],["answer","refused"],["drivers","done"],["sql","done"]]', JSON.stringify(run?.steps.map((s) => [s.kind, s.status, s.reason])));
    ok('limits: the refused step counts toward the steps (5 model calls, `done` is one) but not the queries (3)', run?.stepsUsed === 5 && run.queriesUsed === 3, `${run?.stepsUsed} ${run?.queriesUsed}`);
    ok('model calls: 1 plan + 5 steps + 1 write, plus 1 for the SQL statement (measured)', stub.calls.plan === 1 && stub.calls.step === 5 && stub.calls.write === 1 && stub.calls.sql === 1, JSON.stringify(stub.calls));
    ok('refused: the step keeps the app\'s reason, and nothing was repaired (the model was not asked again for it)', !!run?.steps[1].reason && run.steps[1].spec === undefined && stub.calls.step === 5);
    ok('step 1 facts are the engine\'s (they are stored, with the ledger)', /Total sales: 6252/.test(run?.steps[0].facts ?? '') && (run?.steps[0].ledger?.length ?? 0) > 0);
    ok('the step call is shown every earlier step\'s facts with its status', /STEP 1 \(answer\) — DONE/.test(stub.seen.step) && /STEP 2 \(answer\) — REFUSED/.test(stub.seen.step) && /STEP 4 \(sql\) — DONE/.test(stub.seen.step));
    const rep = run?.report;
    ok('audit: section 1\'s figures are its cited step\'s: no note', !!rep && !rep.sections[0].text.includes('Contains a figure the app did not compute'));
    ok('audit: section 2\'s invented 999999 gets the guard\'s note, and 6252 (step 1, not cited) too', !!rep && rep.sections[1].text.includes('999999') && rep.sections[1].text.includes('Contains a figure the app did not compute'));
    ok('caveats: the one with a figure is dropped', JSON.stringify(rep?.caveats) === '["The data is monthly."]');

    const got = await get('ed', id);
    ok('browser: research:get returns specs, statuses, reasons and the report', got.body.ok && got.body.run.steps.length === 4 && got.body.run.report.title === 'Where sales come from');
    ok('browser: never a facts block, a ledger or a dataset id', !/"facts"|"ledger"|datasetIds|Chart values|app-computed/.test(got.text), (/"facts"|"ledger"|datasetIds|Chart values|app-computed/.exec(got.text) ?? [''])[0]);
    ok('private: another person (an admin, a viewer, nobody) gets "not found" for get, card, stop, resume and add', (await Promise.all(['boss', 'east', 'nobody'].flatMap((who) => [
      W.call(who, 'research:get', { projectId: W.P, runId: id }), W.call(who, 'research:card', { projectId: W.P, runId: id, step: 1 }),
      W.call(who, 'research:stop', { projectId: W.P, runId: id }), W.call(who, 'research:addToProject', { projectId: W.P, runId: id }),
    ]))).every((r) => r.status === 403 || r.body?.ok === false));
    const card1 = await W.call('ed', 'research:card', { projectId: W.P, runId: id, step: 1 });
    const card3 = await W.call('ed', 'research:card', { projectId: W.P, runId: id, step: 3 });
    const card4 = await W.call('ed', 'research:card', { projectId: W.P, runId: id, step: 4 });
    ok('cards: an answer, a drivers waterfall and an SQL table are drawn live', card1.body?.ok && card1.body.data?.labels?.length > 0 && card3.body?.ok && card3.body.chartType === 'waterfall' && card4.body?.ok && card4.body.kind === 'sql', JSON.stringify([card1.body?.ok, card3.body, card4.body?.kind]).slice(0, 300));
    ok('cards: a refused step has none', (await W.call('ed', 'research:card', { projectId: W.P, runId: id, step: 2 })).body?.ok === false);

    // The research turn.
    const turns = await W.as('ed', () => copilot.loadHistory(W.P, run!.threadId));
    const turn = turns.find((t) => t.research?.runId === id);
    ok('turn: ONE assistant turn after the question carries the run id, with the fixed sentence', turns.length === 2 && turns[0].role === 'user' && turn?.role === 'assistant' && turn.text === say.turnText() && !/\d/.test(turn.text), JSON.stringify(turns.map((t) => [t.role, t.text])));
    ok('turn: factsFrom is written at the finish: shows() lists the datasets of every computed step', !!turn && shows(turn).includes(W.plain), JSON.stringify(turn && shows(turn)));
    ok('turn: it carries no fact and no figure (a later ask replays only the sentence)', !!turn && !JSON.stringify(turn).includes('Total sales') && !JSON.stringify(turn).includes('6252'));
    const listed = await W.call('ed', 'research:list', { projectId: W.P });
    ok('list: the caller\'s own runs, none active, the limit for the composer', listed.body?.runs.length === 1 && listed.body.activeRunId === null && listed.body.limits.minutes === 10);
    ok('list: another person sees none of it', (await W.call('boss', 'research:list', { projectId: W.P })).body?.runs.length === 0);

    // ── Add to project ──────────────────────────────────────────────────────────────────────────────────────────────────────
    const add = await W.call('ed', 'research:addToProject', { projectId: W.P, runId: id });
    ok('add: a Story is made', add.body?.ok === true && add.body.created === true && !!add.body.storyId, add.text.slice(0, 200));
    const story = await W.as('ed', async () => (await stories.readStory(W.P, add.body.storyId))?.rec);
    const sb = story?.blocks ?? [];
    const texts = sb.flatMap((b) => (b.kind === 'text' || b.kind === 'callout' ? [b.text] : []));
    const visualBlocks = sb.filter((b) => b.kind === 'visual') as Array<{ visualId: string }>;
    ok('add: the Story\'s blocks are the title, summary, per section a heading, charts and prose, a warning callout, a divider and the conclusion',
      texts[0] === '# Where sales come from' && texts.includes('## By region') && sb.some((b) => b.kind === 'callout' && b.tone === 'warning') && sb.some((b) => b.kind === 'divider') && texts.at(-1) === 'West leads at 1784.', JSON.stringify(sb.map((b) => b.kind)));
    ok('add: open data keeps the prose as written (the question-5 rule, nothing restricted), each section dated', texts.some((t) => t.includes('SECTION_ONE_CANARY')) && texts.some((t) => t.includes('SECTION_TWO_CANARY')) && texts.filter((t) => /^Written on .* from the data then\.$/.test(t)).length === 2, JSON.stringify(texts));
    const saved = await W.as('ed', async () => Promise.all(visualBlocks.map((b) => visuals.getVisual(W.P, b.visualId))));
    ok('add: each cited chart is a saved visual named "<title> · <heading>", the Story points at them', visualBlocks.length === 2 && saved.every((v) => !!v) && saved[0]?.name === 'Where sales come from · By region' && saved[1]?.name === 'Where sales come from · Why it moved' && saved[1]?.chartType === 'waterfall', JSON.stringify(saved.map((v) => v?.name)));
    const again = await W.call('ed', 'research:addToProject', { projectId: W.P, runId: id });
    const both = await Promise.all([W.call('ed', 'research:addToProject', { projectId: W.P, runId: id }), W.call('ed', 'research:addToProject', { projectId: W.P, runId: id })]);
    const n = (await W.as('ed', () => stories.listStories(W.P))).length;
    ok('add: a second press (and two at once) open the SAME story and make no copy', again.body?.storyId === add.body.storyId && again.body.created === false && both.every((r) => r.body?.storyId === add.body.storyId) && n === 1 && (await store.getRun('acme', id))?.storyId === add.body.storyId, `${n} ${again.text}`);
    ok('add: the run and its private report stay with the starter', (await get('ed', id)).body.run.storyId === add.body.storyId && (await get('boss', id)).body?.ok === false);

    // ── The question-5 rule: a restricted dataset's prose never reaches the Story ──────────────────────────────────────────
    stub.reset();
    stub.steps = [answerStep({ datasetId: W.orders, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }] }), byRegion('Plain'), DONE]; // Orders is named three times in this world: by id
    stub.write = JSON.stringify({
      title: 'Orders and plain', summary: 'SUMMARY_CANARY about both.',
      sections: [{ heading: 'Restricted section', text: 'RESTRICTED_CANARY west customers drive it.', steps: [1] }, { heading: 'Open section', text: 'OPEN_CANARY plain data.', steps: [2] }],
      caveats: [], conclusion: 'CONCLUSION_CANARY overall.',
    });
    const id2 = await go('boss', 'Orders versus plain');
    const run2 = await S.drive(id2);
    ok('q5: both steps computed as the admin', run2?.state === 'done' && run2.steps.every((s) => s.status === 'done'), JSON.stringify(run2?.steps.map((s) => [s.status, s.reason])));
    const add2 = await W.call('boss', 'research:addToProject', { projectId: W.P, runId: id2 });
    const story2 = await W.as('boss', async () => (await stories.readStory(W.P, add2.body.storyId))?.rec);
    const t2 = (story2?.blocks ?? []).flatMap((b) => (b.kind === 'text' || b.kind === 'callout' ? [b.text] : []));
    const all2 = JSON.stringify(story2);
    ok('q5: the restricted section keeps its heading and chart; its prose is the fixed line, with no model text', t2.includes('## Restricted section') && !all2.includes('RESTRICTED_CANARY') && t2.includes(say.restrictedProse()));
    ok('q5: the summary and conclusion follow the rule over ALL cited steps (one is restricted): fixed lines', !all2.includes('SUMMARY_CANARY') && !all2.includes('CONCLUSION_CANARY'));
    ok('q5 (negative control): the section on the unrestricted dataset keeps its prose, dated', t2.some((t) => t.includes('OPEN_CANARY')) && t2.filter((t) => /^Written on /.test(t)).length === 2);
    ok('q5: the fixed sentence has no digit and no data name', !/\d/.test(say.restrictedProse()) && !/Orders|Plain|sales/i.test(say.restrictedProse()));
    ok('q5: the private report still holds the full text for its starter', (await get('boss', id2)).text.includes('RESTRICTED_CANARY'));

    // ── Failures ───────────────────────────────────────────────────────────────────────────────────────────────────────
    // A model error at the plan: failed (model); resume plans again and the run completes.
    stub.reset();
    stub.fail.plan = 1;
    stub.steps = [byRegion('Plain'), DONE];
    stub.write = WRITE;
    const f1 = await go('ed', 'plan failure');
    const r1 = await S.drive(f1);
    ok('model error at the plan: failed with code model, no step run', r1?.state === 'failed' && r1.errorCode === 'model' && r1.steps.length === 0 && stub.calls.step === 0);
    ok('resume: only a partial or failed run, as its starter', (await W.call('boss', 'research:resume', { projectId: W.P, runId: f1 })).body?.ok === false && (await W.call('ed', 'research:resume', { projectId: W.P, runId: f1 })).body?.ok === true);
    const r1b = await S.drive(f1);
    ok('resume: the run plans again and completes', r1b?.state === 'done' && stub.calls.plan === 2 && r1b.steps.length === 1);

    // An engine failure: a drivers step with no date to compare is a failed step, and the run goes on.
    stub.reset();
    stub.steps = [byRegion('Plain'), BAD_DRIVERS, DONE];
    stub.write = WRITE;
    const r2 = await S.drive(await go('ed', 'engine failure'));
    ok('engine failure: a FAILED step (it counts as a query) with the app\'s sentence; the run goes on to done', r2?.steps[1]?.status === 'failed' && r2.steps[1].reason === say.stepFailed() && r2.queriesUsed === 2 && r2.state === 'done', JSON.stringify(r2?.steps.map((s) => [s.status, s.reason])));

    // A model error mid-run: the first step is kept and not run again on resume; the counts stay.
    stub.reset();
    stub.steps = [async () => { stub.fail.step = 1; return byRegion('Plain'); }, DRIVERS, DONE];
    stub.write = WRITE;
    const f3 = await go('ed', 'mid-run model error');
    const r3 = await S.drive(f3);
    ok('model error mid-run: the run is failed (model) with the step it had', r3?.state === 'failed' && r3.errorCode === 'model' && r3.steps.length === 1, `${r3?.state} ${r3?.errorCode} ${r3?.steps.length}`);
    const firstJson = JSON.stringify(r3?.steps[0]);
    const used3 = r3?.stepsUsed ?? 0;
    stub.steps = [DONE];
    stub.calls.step = 0;
    await W.call('ed', 'research:resume', { projectId: W.P, runId: f3 });
    const r3b = await S.drive(f3);
    ok('resume: a finished step is never run again (the same stored step), the step count continues', !!r3b?.steps[0] && JSON.stringify(r3b.steps[0]) === firstJson && r3b.stepsUsed === used3 + 1 && r3b.state === 'done', `${r3b?.state} ${r3b?.stepsUsed} ${used3}`);

    // A write that fails: partial, charts only.
    stub.reset();
    stub.steps = [byRegion('Plain'), DONE];
    stub.fail.write = 1;
    const f4 = await go('ed', 'write failure');
    const r4 = await S.drive(f4);
    ok('write failure: partial (write), the steps kept, a report of charts only with none of the model\'s words', r4?.state === 'partial' && r4.errorCode === 'write' && r4.report?.chartsOnly === true && r4.report.sections.length === 1 && r4.report.sections[0].text === '' && r4.steps.length === 1);
    ok('write failure: it can be added to the project as charts', (await W.call('ed', 'research:addToProject', { projectId: W.P, runId: f4 })).body?.ok === true);
    // Unusable write JSON: the same.
    stub.reset();
    stub.steps = [byRegion('Plain'), DONE];
    stub.write = 'sorry, no JSON';
    const r4b = await S.drive(await go('ed', 'bad write'));
    ok('write failure: a reply that is no report is charts only too', r4b?.state === 'partial' && r4b.report?.chartsOnly === true);

    // Nothing usable: failed, never an empty report.
    stub.reset();
    stub.steps = [byRegion('Nowhere'), DONE];
    const r5 = await S.drive(await go('ed', 'nothing worked'));
    ok('no usable step: failed (no_steps), no report, no write call', r5?.state === 'failed' && r5.errorCode === 'no_steps' && r5.report === null && stub.calls.write === 0);

    // Stop: a flag raised during the model call stops the run before the step it chose.
    stub.reset();
    let f6 = '';
    stub.steps = [byRegion('Plain'), async () => { await store.requestStop('acme', f6); return byRegion('Plain'); }, DONE];
    f6 = await go('ed', 'stop me');
    const r6 = await S.drive(f6);
    ok('stop: the run stops (stopped) after the step running, without the step the model chose next', r6?.state === 'stopped' && r6.steps.length === 1 && stub.calls.write === 0, `${r6?.state} ${r6?.steps.length}`);
    ok('stop (negative control): the same run is not resumable', (await W.call('ed', 'research:resume', { projectId: W.P, runId: f6 })).body?.ok === false);

    // Limits: the admin's, within the ceilings, are what the run uses.
    stub.reset();
    stub.steps = [byRegion('Plain')];
    stub.write = WRITE;
    ok('limits: only an org admin sets them', (await W.call('ed', 'research:setLimits', { steps: 3, queries: 12, minutes: 10 })).status === 403 && (await W.call('boss', 'research:setLimits', { steps: 3, queries: 12, minutes: 10 })).body?.ok === true);
    ok('limits: past a ceiling is refused by the contract', (await W.call('boss', 'research:setLimits', { steps: 21, queries: 12, minutes: 10 })).status === 400);
    const r7 = await S.drive(await go('ed', 'three steps only'));
    ok('limits: a run stops at the admin\'s 3 steps, still writes, and ends partial (steps)', r7?.stepsUsed === 3 && r7.state === 'partial' && r7.errorCode === 'steps' && stub.calls.step === 3 && stub.calls.write === 1, `${r7?.stepsUsed} ${r7?.state} ${r7?.errorCode}`);
    await W.call('boss', 'research:setLimits', { steps: 8, queries: 2, minutes: 10 });
    stub.reset();
    stub.steps = [byRegion('Plain')];
    stub.write = WRITE;
    const r8 = await S.drive(await go('ed', 'two queries only'));
    ok('limits: and at 2 engine queries', r8?.queriesUsed === 2 && r8.errorCode === 'queries' && stub.calls.step === 2);
    await W.call('boss', 'research:setLimits', { steps: 8, queries: 12, minutes: 10 });

    // The AI budget: model calls count against the person's per-minute budget.
    budget.clear();
    slackDb.useSlackDb(W.pool, null, { timeoutMs: 120_000, perMinute: 2 });
    stub.reset();
    stub.steps = [byRegion('Plain'), DONE];
    const r9 = await S.drive(await go('ed', 'budget'));
    slackDb.useSlackDb(W.pool, null, { timeoutMs: 120_000, perMinute: 1200 });
    ok('AI budget: calls past the person\'s budget end the run failed (limited), the steps kept, resumable', r9?.state === 'failed' && r9.errorCode === 'limited' && stub.calls.step === 1, `${r9?.state} ${r9?.errorCode} ${stub.calls.step}`);

    // ── A crash on one pod, retaken on another ───────────────────────────────────────────────────────────────────────────
    stub.reset();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stub.steps = [byRegion('Plain'), async () => { await gate; return DRIVERS; }, DONE];
    stub.write = WRITE;
    worker.tuneForTest({ leaseMs: 600, pollMs: 100 });
    const crash = await go('ed', 'crash me');
    const podA = worker.latestForTest()!;
    worker.pauseForTest(false);
    await podA.tick();
    await until(async () => ((await store.getRun('acme', crash))?.steps.length ?? 0) === 1 && stub.calls.step === 2);
    worker.pauseForTest(true);
    const before = await store.getRun('acme', crash);
    ok('crash: pod A finished step 1 and is inside step 2 (held)', before?.steps.length === 1 && before.state === 'running' && before.attempts === 1);
    await podA.stop(); // the pod goes away: its lease is abandoned, not finished
    release();
    await sleep(100);
    ok('crash: the run is left running with a lease nobody renews', (await store.getRun('acme', crash))?.state === 'running');
    const podB = worker.startResearchWorker({ error: () => undefined, warn: () => undefined });
    const stepJson = JSON.stringify(before?.steps[0]);
    const planCalls = stub.calls.plan;
    await sleep(700);
    worker.pauseForTest(false);
    await until(async () => { await podB.tick(); const r = await store.getRun('acme', crash); return !!r && !store.ACTIVE.includes(r.state); });
    worker.pauseForTest(true);
    const retaken = await store.getRun('acme', crash);
    ok('retake: another pod finishes it (attempt 2) to done', retaken?.state === 'done' && retaken.attempts === 2, `${retaken?.state} ${retaken?.attempts}`);
    ok('retake: step 1 was NOT run again (the stored step is identical) and the plan was not asked again', JSON.stringify(retaken?.steps[0]) === stepJson && stub.calls.plan === planCalls && retaken?.steps.length === 1);
    ok('retake: B made ONE step call (the model\'s `done`): 3 calls in all, 2 counted (the held call of the dead pod was never saved)', stub.calls.step === 3 && retaken?.stepsUsed === 2, `${stub.calls.step} ${retaken?.stepsUsed}`);
    await podB.stop();
    worker.tuneForTest({ leaseMs: 60_000 });
    worker.startResearchWorker({ error: () => undefined, warn: () => undefined }); // the pod the rest of the suite drives

    // The deadline: a run whose time ran out ends partial with charts only, no write call.
    stub.reset();
    stub.steps = [byRegion('Plain'), DONE];
    const dl = await go('ed', 'out of time');
    await store.claim('podDead', 60); // claims it, stores one finished step and an allowance of 50 ms, then dies
    await store.setDeadline('acme', dl, 'podDead', 50);
    const done1 = await (async () => { const g = await store.getRun('acme', dl); return g; })();
    await store.saveSteps('acme', dl, 'podDead', [{ n: 1, kind: 'answer', title: 'Sales by region', status: 'done', spec: { datasetId: W.plain, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Sales by region' }, facts: 'f', ledger: [], datasetIds: [W.plain] }], 1, 1);
    await store.savePlan('acme', dl, 'podDead', ['one', 'two', 'three']);
    void done1;
    await sleep(200);
    const rd = await S.drive(dl);
    ok('deadline: past it the run ends partial (deadline) with a charts-only report and no model call', rd?.state === 'partial' && rd.errorCode === 'deadline' && rd.report?.chartsOnly === true && stub.calls.step === 0 && stub.calls.write === 0 && stub.calls.plan === 0, `${rd?.state} ${rd?.errorCode} ${JSON.stringify(stub.calls)}`);
    ok('deadline: the stored step was kept and resume gives a fresh allowance', !!rd && rd.steps.length === 1 && (await W.call('ed', 'research:resume', { projectId: W.P, runId: dl })).body?.ok === true && (await store.getRun('acme', dl))?.deadlineAt === null);
    void PLAN;
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
