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
import * as H from './rowPolicyHarness';
import * as crypto from 'crypto';

const store: typeof import('../src/server/research/db') = require('../src/server/research/db');
const worker: typeof import('../src/server/research/worker') = require('../src/server/research/worker');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const slackDb: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const { shows }: typeof import('../src/ipc/turnsOpen') = require('../src/ipc/turnsOpen');
const budget = { clear: (): void => require("../src/server/slack/ask")._clearBudgetForTest() };
const answersMod: any = require('../src/ipc/answers'); // any: patched by a test
const knowledge: typeof import('../src/knowledge/store') = require('../src/knowledge/store');
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
    { heading: 'Why it moved', text: 'Sales rose by 13 but 999999 was claimed, and 6252 belongs to step 1. SECTION_TWO_CANARY.', steps: [3] },
  ],
  caveats: ['The data is monthly.', 'Sales rose 12.5% somewhere'],
  conclusion: 'West leads at 1784.',
});

(async () => {
  const S = await researchWorld('research run');
  if (!S) return;
  const { W, stub } = S;
  const get = async (who: string, id: string) => (await W.call(who, 'research:get', { projectId: W.P, runId: id }));
  const go = async (who: string, q: string, o: { threadId?: string; agentId?: string } = {}) => {
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
    ok('audit: section 2\'s invented 999999 and 6252 (step 1\'s, NOT cited by this section) both get the guard\'s note', !!rep && /Contains a figure the app did not compute: [^]*999999[^]*6252|Contains a figure the app did not compute: [^]*6252[^]*999999/.test(rep.sections[1].text) && !/Contains a figure the app did not compute: [^]*\b13\b/.test(rep.sections[1].text), rep?.sections[1].text);
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

    // ── The question-5 rule, decided for the whole RUN: restricted data anywhere means no model sentence in the Story ───────
    const FIG = String(H.only('West').reduce((a, r) => a + (r[4] as number), 0)); // a figure only the Orders step (row rules) computes: West's quantity
    stub.reset();
    stub.steps = [answerStep({ datasetId: W.orders, category: 'region', measures: [{ column: 'qty', aggregation: 'sum' }], filters: [{ column: 'region', op: '=', value: 'West' }] }), byRegion('Plain'), DONE]; // Orders is named three times here: by id
    stub.write = JSON.stringify({
      title: `Quantity ${FIG} in the West`, summary: `Plain sales were 6252 and the West quantity was ${FIG}. SUMMARY_CANARY.`, // cites nothing: quotes the restricted step
      sections: [
        { heading: `West lost ${FIG} units`, text: `Plain sales: 6252. Also ${FIG}. OPEN_STEP_CANARY.`, steps: [2] }, // cites only the open step, quotes the restricted figure
        { heading: 'West lost 4500 customers', text: 'RESTRICTED_CANARY.', steps: [1] }, // a bare-integer heading
        { heading: 'Plain data', text: 'PLAIN_CANARY.', steps: [2] },
      ],
      caveats: ['CAVEAT_CANARY about the sites.'], conclusion: `Overall ${FIG}. CONCLUSION_CANARY.`,
    });
    const id2 = await go('boss', 'Orders versus plain');
    const run2 = await S.drive(id2);
    ok('q5: both steps computed as the admin, one of them over row-ruled data', run2?.state === 'done' && run2.steps.every((s) => s.status === 'done') && (run2.steps[0].facts ?? '').includes(FIG), JSON.stringify(run2?.steps.map((s) => [s.status, s.reason])));
    const add2 = await W.call('boss', 'research:addToProject', { projectId: W.P, runId: id2 });
    const story2 = await W.as('boss', async () => (await stories.readStory(W.P, add2.body.storyId))?.rec);
    const t2 = (story2?.blocks ?? []).flatMap((b) => (b.kind === 'text' || b.kind === 'callout' ? [b.text] : []));
    const savedNames = await W.as('boss', async () => Promise.all((story2?.blocks ?? []).flatMap((b) => (b.kind === 'visual' ? [visuals.getVisual(W.P, (b as { visualId: string }).visualId).then((v) => v?.name ?? '')] : []))));
    const everything = JSON.stringify([story2, savedNames]);
    ok('q5: the restricted figure appears NOWHERE in the Story (blocks, name) or in any saved visual\'s name', !everything.includes(FIG) && !everything.includes('4500'), everything.slice(0, 300));
    ok('q5: no model sentence is kept: summary (it cites nothing), every section\'s text (even the one citing only the open step) and the conclusion are the fixed line', ['SUMMARY_CANARY', 'OPEN_STEP_CANARY', 'RESTRICTED_CANARY', 'PLAIN_CANARY', 'CONCLUSION_CANARY'].every((c) => !everything.includes(c)) && t2.filter((t) => t === say.restrictedProse()).length === 5, JSON.stringify(t2));
    ok('q5: the caveats are the fixed line; the headings with a digit are "Finding n", the Story is named by the starter\'s question', !everything.includes('CAVEAT_CANARY') && t2.includes(say.restrictedCaveats().replace(/^/, '- ')) && t2.includes('## Finding 1') && t2.includes('## Finding 2') && t2.includes('## Plain data') && story2?.name === 'Orders versus plain', JSON.stringify([story2?.name, t2]));
    ok('q5: the saved visuals are named from the safe title and headings (Finding n)', savedNames.length >= 2 && savedNames.every((n) => n.startsWith('Orders versus plain · ')), JSON.stringify(savedNames));
    ok('q5: the fixed sentences have no digit and no data name; each section is dated', !/\d/.test(say.restrictedProse() + say.restrictedCaveats()) && !/Orders|Plain|sales/i.test(say.restrictedProse()) && t2.filter((t) => /^Written on /.test(t)).length === 3);
    ok('q5: the private report still holds the full text for its starter', (await get('boss', id2)).text.includes('RESTRICTED_CANARY'));

    // ── Add to project: a failed save leaves nothing to duplicate; two presses at once make one story; no connection is held ──
    stub.reset();
    stub.steps = [byRegion('Plain'), DRIVERS, DONE];
    stub.write = JSON.stringify({ title: 'Sales and why', summary: 'S.', sections: [{ heading: 'By region', text: 'West led.', steps: [1] }, { heading: 'Why it moved', text: 'It rose.', steps: [2] }], caveats: [], conclusion: 'C.' });
    const countVisuals = async () => (await W.as('ed', () => visuals.listVisuals(W.P))).length;
    const countStories = async () => (await W.as('ed', () => stories.listStories(W.P))).length;
    const ra = await go('ed', 'add with a failing save');
    await S.drive(ra);
    const v0 = await countVisuals();
    const s0 = await countStories();
    const realSave = stories.saveStory;
    stories.saveStory = (async () => { throw new Error('disk full'); }) as typeof stories.saveStory;
    const failedAdd = await W.call('ed', 'research:addToProject', { projectId: W.P, runId: ra });
    stories.saveStory = realSave;
    const v1 = await countVisuals();
    ok('add: a story save that throws fails the press and leaves the run unlinked, its two visuals recorded on the run', failedAdd.body?.ok === false && v1 === v0 + 2 && (await store.getRun('acme', ra))?.storyId === null && Object.keys((await W.pool.query(`SELECT add_visuals FROM research_runs WHERE id = $1`, [ra])).rows[0].add_visuals).length === 2, JSON.stringify([failedAdd.body, v0, v1]));
    const retried = await W.call('ed', 'research:addToProject', { projectId: W.P, runId: ra });
    ok('add: the retry reuses the saved visuals (none twice) and makes ONE story', retried.body?.ok === true && (await countVisuals()) === v1 && (await countStories()) === s0 + 1, JSON.stringify([retried.body, v1, await countVisuals()]));
    stub.reset();
    stub.steps = [byRegion('Plain'), DRIVERS, DONE];
    stub.write = JSON.stringify({ title: 'Twice at once', summary: 'S.', sections: [{ heading: 'By region', text: 'West led.', steps: [1] }, { heading: 'Why', text: 'It rose.', steps: [2] }], caveats: [], conclusion: 'C.' });
    const rb = await go('ed', 'two presses');
    await S.drive(rb);
    const v2 = await countVisuals();
    const s2 = await countStories();
    let idleInTx = -1;
    stories.saveStory = (async (...a: Parameters<typeof realSave>) => {
      idleInTx = Number((await W.pool.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`)).rows[0].n);
      return realSave(...a);
    }) as typeof stories.saveStory;
    const pair = await Promise.all([W.call('ed', 'research:addToProject', { projectId: W.P, runId: rb }), W.call('ed', 'research:addToProject', { projectId: W.P, runId: rb })]);
    stories.saveStory = realSave;
    ok('add: two presses at once make ONE story and ONE set of visuals', pair.every((r) => r.body?.ok === true) && pair[0].body.storyId === pair[1].body.storyId && [pair[0].body.created, pair[1].body.created].filter(Boolean).length === 1 && (await countStories()) === s2 + 1 && (await countVisuals()) === v2 + 2, JSON.stringify(pair.map((r) => r.body)));
    ok('add: no connection is held in a transaction while the story is saved (a pool is not starved by concurrent adds)', idleInTx === 0, String(idleInTx));

    // ── Stop in the write phase; a run retaken while writing keeps its limit code ────────────────────────────────────────────
    stub.reset();
    let rs1 = '';
    stub.steps = [byRegion('Plain'), async () => { await store.requestStop('acme', rs1); return DONE; }];
    stub.write = WRITE;
    rs1 = await go('ed', 'stop before the write');
    const rr1 = await S.drive(rs1);
    ok('stop: a stop asked for just before the write call is honored: stopped, and the write call (a model call) is never made', rr1?.state === 'stopped' && stub.calls.write === 0, `${rr1?.state} ${stub.calls.write}`);
    stub.reset();
    let rs2 = '';
    stub.steps = [byRegion('Plain'), DONE];
    stub.write = async () => { await store.requestStop('acme', rs2); return WRITE; };
    rs2 = await go('ed', 'stop during the write');
    const rr2 = await S.drive(rs2);
    ok('stop: a stop asked for during the write call wins: stopped (the report written is kept, not resumable)', rr2?.state === 'stopped' && rr2.errorCode === null && !!rr2.report && !(await W.call('ed', 'research:resume', { projectId: W.P, runId: rs2 })).body?.ok, `${rr2?.state} ${rr2?.errorCode}`);
    stub.reset();
    stub.write = WRITE;
    const rw = await go('ed', 'retaken while writing');
    await store.claim('podW0', 80); // a pod that reached the write phase after a step limit, then died
    await store.setDeadline('acme', rw, 'podW0', 600_000);
    await store.savePlan('acme', rw, 'podW0', ['a', 'b', 'c']);
    await store.saveSteps('acme', rw, 'podW0', [{ n: 1, kind: 'answer', title: 'Sales by region', status: 'done', spec: { datasetId: W.plain, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Sales by region' }, facts: 'f', ledger: [], datasetIds: [W.plain] }], 8, 1);
    await store.setWriting('acme', rw, 'podW0', 'steps');
    await sleep(200);
    const rrw = await S.drive(rw);
    ok('retake in writing: the run keeps its step-limit end: partial (steps), not done; no step or plan call, one write call', rrw?.state === 'partial' && rrw.errorCode === 'steps' && !!rrw.report && stub.calls.step === 0 && stub.calls.plan === 0 && stub.calls.write === 1, `${rrw?.state} ${rrw?.errorCode} ${JSON.stringify(stub.calls)}`);

    // ── An SQL step never reaches the project's source tables ──────────────────────────────────────────────────────────────
    const sourceAnswers: any = require('../src/ipc/sourceAnswers'); // any: spied
    const realVocab = sourceAnswers.sourceVocabulary;
    const seenContexts: unknown[] = [];
    sourceAnswers.sourceVocabulary = async (...a: unknown[]) => { seenContexts.push(a[1]); return realVocab(...a); };
    stub.reset();
    stub.steps = [JSON.stringify({ kind: 'sql', intent: 'a table that is no dataset', datasets: ['no_such_dataset'] }), DONE];
    await S.drive(await go('ed', 'sql by name'));
    sourceAnswers.sourceVocabulary = realVocab;
    ok('sql: the step asks for NO source tables (noSources), so a name that matches no dataset cannot fall through to one', seenContexts.length >= 1 && seenContexts.every((c) => (c as { noSources?: boolean } | undefined)?.noSources === true), JSON.stringify(seenContexts));

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
    ok('release: the stopping pod handed the run back at once (its lease already lapsed, the attempt not burned)', ((await W.pool.query(`SELECT lease_until < now() AS lapsed, attempts FROM research_runs WHERE id = $1`, [crash])).rows[0] ?? {}).lapsed === true);
    worker.pauseForTest(false);
    await until(async () => { await podB.tick(); const r = await store.getRun('acme', crash); return !!r && !store.ACTIVE.includes(r.state); });
    worker.pauseForTest(true);
    const retaken = await store.getRun('acme', crash);
    ok('retake: another pod takes it AT ONCE (no lease to wait out) and finishes it: attempt 1, since the stopping pod\'s was returned', retaken?.state === 'done' && retaken.attempts === 1, `${retaken?.state} ${retaken?.attempts}`);
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

    // ── Review round 3 ───────────────────────────────────────────────────────────────────────────────────────────────────────
    await W.pool.query(`UPDATE research_runs SET state = 'stopped' WHERE state IN ('queued', 'running', 'writing')`);
    const prose = (name: string, extra = '') => JSON.stringify({ title: 'Report', summary: `${name}_SUMMARY.`, sections: [{ heading: 'By region', text: `${name}_SECTION.`, steps: [1] }], caveats: [], conclusion: `${name}_END.`, ...(extra ? {} : {}) });
    const storyText = async (storyId: string) => JSON.stringify(await W.as('boss', async () => (await stories.readStory(W.P, storyId))?.rec?.blocks));

    // 1. A restricted dataset deleted after the run must not let prose through: the flag was recorded when the step ran.
    stub.reset();
    stub.steps = [answerStep({ datasetId: W.east, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }] }), DONE];
    stub.write = prose('GONE');
    const del = await go('boss', 'restricted then deleted');
    const rdel = await S.drive(del);
    ok('deleted dataset: a step on row-ruled data records `restricted` on the run when it is computed', rdel?.state === 'done' && rdel.restricted === true, `${rdel?.state} ${rdel?.restricted}`);
    stub.reset();
    stub.steps = [byRegion('Plain'), DONE];
    stub.write = prose('OPEN');
    const rOpen = await S.drive(await go('boss', 'open and kept'));
    ok('deleted dataset (control): a run over open data is not flagged', rOpen?.restricted === false);
    ok('fixture: the restricted dataset is deleted after the run', (await W.call('boss', 'dataset:delete', { projectId: W.P, id: W.east })).body?.ok !== false);
    const addDel = await W.call('boss', 'research:addToProject', { projectId: W.P, runId: del });
    const textDel = addDel.body?.ok ? await storyText(addDel.body.storyId) : '';
    ok('deleted dataset: Add keeps NO prose (a deleted dataset reads as open to restricted(); the stored flag and the missing record close it)', addDel.body?.ok === true && !textDel.includes('GONE_SUMMARY') && !textDel.includes('GONE_SECTION') && !textDel.includes('GONE_END') && textDel.includes('Written on'), textDel.slice(0, 300));
    const addOpen = await W.call('boss', 'research:addToProject', { projectId: W.P, runId: rOpen!.id });
    const textOpen = await storyText(addOpen.body.storyId);
    ok('deleted dataset (negative control): an all-open run with every dataset present keeps its prose', textOpen.includes('OPEN_SUMMARY') && textOpen.includes('OPEN_SECTION') && textOpen.includes('OPEN_END'));

    // 2. The add lease: lapsing or a Resume mid-Add leaves one story and one set of charts, never an orphan.
    const mkDone = async (q: string, write = true) => {
      stub.reset();
      stub.steps = [byRegion('Plain'), DRIVERS, DONE];
      stub.write = JSON.stringify({ title: 'Lease', summary: 'S.', sections: [{ heading: 'By region', text: 'West led.', steps: [1] }, { heading: 'Why', text: 'It rose.', steps: [2] }], caveats: [], conclusion: 'C.' });
      if (!write) stub.fail.write = 1;
      const id = await go('ed', q);
      await S.drive(id);
      return id;
    };
    const slow = (): { gate: Promise<void>; open(): void; seen(): number; restore(): void } => {
      const real = answersMod.computeCard;
      let n = 0;
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      answersMod.computeCard = async (...a: unknown[]) => { n += 1; if (n === 1) await gate; return real(...a); };
      return { gate, open, seen: () => n, restore: () => { answersMod.computeCard = real; } };
    };
    const lapse = await mkDone('lease lapses');
    const vL = await countVisuals();
    const sL = await countStories();
    const hold = slow();
    const pressA = W.call('ed', 'research:addToProject', { projectId: W.P, runId: lapse });
    await until(async () => hold.seen() >= 1);
    await W.pool.query(`UPDATE research_runs SET add_until = now() - interval '1 second' WHERE id = $1`, [lapse]); // press A\'s 60 s lease runs out while it computes
    const pressC = await W.call('ed', 'research:addToProject', { projectId: W.P, runId: lapse });
    hold.open();
    const aDone = await pressA;
    hold.restore();
    ok('add lease lapses mid-Add: the second press finishes; the first, which lost its lease, is refused', pressC.body?.ok === true && pressC.body.created === true && aDone.body?.ok === false, JSON.stringify([pressC.body, aDone.body]));
    ok('add lease lapses mid-Add: exactly ONE story and ONE set of charts (the chart the lapsed press saved is deleted)', (await countStories()) === sL + 1 && (await countVisuals()) === vL + 2 && (await store.getRun('acme', lapse))?.storyId === pressC.body.storyId, `${await countStories()} ${await countVisuals()} (${sL} ${vL})`);

    const resumable = await mkDone('resume mid add', false);
    const vR = await countVisuals();
    const sR = await countStories();
    const hold2 = slow();
    const pressR = W.call('ed', 'research:addToProject', { projectId: W.P, runId: resumable });
    await until(async () => hold2.seen() >= 1);
    const resumed = await W.call('ed', 'research:resume', { projectId: W.P, runId: resumable });
    hold2.open();
    const rDone = await pressR;
    hold2.restore();
    ok('Resume mid-Add: the Add is refused and leaves no orphan story or chart', resumed.body?.ok === true && rDone.body?.ok === false && (await countStories()) === sR && (await countVisuals()) === vR, `${JSON.stringify(rDone.body)} ${await countStories()} ${await countVisuals()} (${sR} ${vR})`);
    await W.pool.query(`UPDATE research_runs SET state = 'stopped' WHERE state IN ('queued', 'running', 'writing')`);

    const lateLoss = await mkDone('lease lost before the story');
    const vS = await countVisuals();
    const sS = await countStories();
    const realSave2 = stories.saveStory;
    stories.saveStory = (async (...a: Parameters<typeof realSave2>) => {
      await W.pool.query(`UPDATE research_runs SET add_token = NULL, add_visuals = '{}'::jsonb WHERE id = $1`, [lateLoss]); // a Resume cleared it
      return realSave2(...a);
    }) as typeof stories.saveStory;
    const lost = await W.call('ed', 'research:addToProject', { projectId: W.P, runId: lateLoss });
    stories.saveStory = realSave2;
    ok('lease lost at the story: the press deletes its own story and charts (finalize found nobody\'s story id)', lost.body?.ok === false && (await countStories()) === sS && (await countVisuals()) === vS, `${JSON.stringify(lost.body)} ${await countStories()} ${await countVisuals()} (${sS} ${vS})`);

    // 3. An agent's own documents reach the run and make it restricted (only the agent's users may read them); a project document does not.
    const agentRun = async (name: string, teamIds: string[]) => {
      const agentId: string = (await W.call('boss', 'agent:save', { projectId: W.P, agent: { name, topicId: null, model: null, build: true, teamIds } })).body?.agent?.id;
      await W.as('boss', () => knowledge.createDoc(W.P, agentId, { title: `${name} handbook`, text: `# ${name}\n\nzebrawords policy: always compare by region first.` }, crypto.randomUUID(), 'boss@acme.test'));
      stub.reset();
      stub.steps = [byRegion('Plain'), DONE];
      stub.write = prose(name.toUpperCase());
      const id = await go('boss', 'zebrawords policy please', { agentId });
      const r = await S.drive(id);
      return { id, r, plan: stub.seen.plan };
    };
    const team = await agentRun('Team', [W.team]);
    ok('agent documents: the agent\'s own passages reach the plan call (the agent id is passed to askGuidance)', /always compare by region first/.test(team.plan), team.plan.slice(0, 200));
    ok('agent documents: a team-only agent\'s document used → the run is restricted', team.r?.state === 'done' && team.r.restricted === true);
    const addTeam = await W.call('boss', 'research:addToProject', { projectId: W.P, runId: team.id });
    const textTeam = await storyText(addTeam.body.storyId);
    ok('agent documents: so Add keeps no prose', !textTeam.includes('TEAM_SUMMARY') && !textTeam.includes('TEAM_SECTION'));
    const everyone = await agentRun('Everyone', []);
    const addEvery = await W.call('boss', 'research:addToProject', { projectId: W.P, runId: everyone.id });
    const textEvery = await storyText(addEvery.body.storyId);
    ok('agent documents: an agent with no teams is editors-only (mayUse), so its document restricts the run too: no prose', everyone.r?.restricted === true && !textEvery.includes('EVERYONE_SUMMARY') && !textEvery.includes('EVERYONE_SECTION') && /always compare/.test(everyone.plan));
    // Negative control: a PROJECT document is read by every reader of the project, so it does not restrict the run.
    await W.as('boss', () => knowledge.createDoc(W.P, null, { title: 'Project handbook', text: '# Project\n\nquokkawords policy: always compare by region first.' }, crypto.randomUUID(), 'boss@acme.test'));
    stub.reset();
    stub.steps = [byRegion('Plain'), DONE];
    stub.write = prose('PROJECT');
    const projId = await go('boss', 'quokkawords policy please', {});
    const projRun = await S.drive(projId);
    const projPlan = stub.seen.plan;
    const addProj = await W.call('boss', 'research:addToProject', { projectId: W.P, runId: projId });
    const textProj = await storyText(addProj.body.storyId);
    ok('agent documents (negative control): a PROJECT document used → not restricted, prose kept', projRun?.restricted === false && textProj.includes('PROJECT_SUMMARY') && /quokkawords policy/.test(projPlan), `${projRun?.restricted} ${textProj.slice(0, 120)}`);

    // 5. A start whose turn cannot be written does not hold the person\'s slot.
    const realAppend = copilot.appendTurn;
    let appended = 0;
    copilot.appendTurn = (async (...a: Parameters<typeof realAppend>) => { appended += 1; if (appended === 2) throw new Error('disk full'); return realAppend(...a); }) as typeof copilot.appendTurn;
    const broken = await S.start('ed', 'turn fails');
    copilot.appendTurn = realAppend;
    ok('start: a turn that cannot be written refuses the start and stops the run (it does not hold the slot)', broken.body?.ok === false && (await W.pool.query(`SELECT 1 FROM research_runs WHERE started_by = 'ed@acme.test' AND state IN ('queued', 'running', 'writing')`)).rowCount === 0, broken.text.slice(0, 200));
    ok('start (control): the person can start another at once', (await S.start('ed', 'try again')).body?.ok === true);
    await W.pool.query(`UPDATE research_runs SET state = 'stopped' WHERE state IN ('queued', 'running', 'writing')`);
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
