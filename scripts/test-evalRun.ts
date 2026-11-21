// Evaluation suites, a batch run end to end through the REAL doors (scripts/evalHarness.ts): the real `copilot:ask` handler with a scripted
// model, the real `computeCard`, the lease and the worker. Covers: a case that passes, one that fails, one that should refuse; the wrong
// dataset, the wrong filter and a made-up figure each failing (and the right one passing); the judge (a score, a bad reply, a failed
// call); the model-call count; the hidden conversation (never listed, gone afterwards); one run per project; stop; the per-person cap
// and resume; a crash retaken without asking a finished case again, and the fence; the comparison with the last run; and what each person
// may see of a result.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-evalRun.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { evalWorld, answerAction, until, sleep } from './evalHarness';
import * as H from './rowPolicyHarness';

const store: typeof import('../src/server/evals/db') = require('../src/server/evals/db');
const worker: typeof import('../src/server/evals/worker') = require('../src/server/evals/worker');
const runMod: typeof import('../src/server/evals/run') = require('../src/server/evals/run');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const slackDb: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const budget = { clear: (): void => require('../src/server/slack/ask')._clearBudgetForTest() };

const BY_REGION = (dataset: string, extra: Record<string, unknown> = {}) => answerAction({ dataset, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], ...extra });
const WEST = [{ column: 'region', op: '=', value: 'West' }];

(async () => {
  const S = await evalWorld('eval run');
  if (!S) return;
  const { W, stub } = S;
  try {
    await W.as('boss', async () => (await datasets.saveDataset(W.P, { name: 'Other', sourceKind: 'csv', columns: H.COLUMNS, rows: H.ROWS }))!.id);
    const results = async (runId: string) => store.resultsOf('acme', runId);
    /** ed asks `question` (the model answers as scripted), and makes that answer a test in `suiteId`. */
    async function fromAnswer(suiteId: string, question: string, say?: string): Promise<string> {
      const a = await W.call('ed', 'copilot:ask', { projectId: W.P, context: { kind: '' }, question });
      const turn = a.body?.turns?.at(-1);
      const made = await W.call('ed', 'eval:caseFrom', { projectId: W.P, suiteId, from: { kind: 'turn', threadId: a.body.threadId, turnId: turn.id, ...(say ? { say } : {}) } });
      if (made.body?.ok !== true) throw new Error('caseFrom failed: ' + made.text);
      return made.body.caseId as string;
    }
    const start = async (who: string, suiteId: string) => W.call(who, 'eval:runStart', { projectId: W.P, suiteId });
    const runOf = async (who: string, suiteId: string): Promise<string> => {
      const r = await start(who, suiteId);
      if (r.body?.ok !== true) throw new Error('runStart failed: ' + r.text);
      return r.body.runId as string;
    };

    // ── One run: the right answer passes; the wrong dataset, the wrong filter and a made-up figure each fail ──────────────
    stub.asks['Sales by region?'] = { text: 'West leads.', action: BY_REGION('Plain') };
    const suite = await S.suite('ed', 'Revenue');
    const c1 = await fromAnswer(suite, 'Sales by region?');
    stub.asks['Sales by region, other data?'] = { text: 'West leads.', action: BY_REGION('Other') };
    const c2 = await fromAnswer(suite, 'Sales by region, other data?');
    stub.asks['West only?'] = { text: 'West only.', action: BY_REGION('Plain', { filters: WEST }) };
    const c3 = await fromAnswer(suite, 'West only?');
    stub.asks['Total sales?'] = { text: 'Total sales were 6252.', action: BY_REGION('Plain') };
    const c4 = await fromAnswer(suite, 'Total sales?');
    // The test turns of these four are the right answers. Now the model changes its mind on three of them.
    stub.asks['Sales by region, other data?'] = { text: 'West leads.', action: BY_REGION('Plain') }; // the wrong dataset
    stub.asks['West only?'] = { text: 'All regions.', action: BY_REGION('Plain') }; // the wrong filter (none)
    stub.asks['Total sales?'] = { text: 'Total sales were 987654.', action: BY_REGION('Plain') }; // a made-up figure
    const cr = (await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId: suite, question: 'Delete all the data', refuse: true })).body.id as string; // should refuse
    stub.asks['Delete all the data'] = { text: 'Sure, deleted.' }; // prose: not a refusal
    const cr2 = (await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId: suite, question: 'Sales by nowhere', refuse: true })).body.id as string;
    stub.asks['Sales by nowhere'] = { text: 'Here you go.', action: BY_REGION('Nowhere') }; // the app refuses the chart: a refusal
    stub.calls.ask = 0;
    stub.seen.questions = [];

    // The hidden conversation is in no list while a case is asked: the stub looks at History from inside the ask.
    const listed: string[][] = [];
    const real = stub.asks['Sales by region?'] as { text: string; action: Record<string, unknown> };
    stub.asks['Sales by region?'] = async () => {
      const t = await W.call('ed', 'copilot:threads', { projectId: W.P });
      const h = await W.call('ed', 'copilot:history', { projectId: W.P });
      listed.push([...(t.body?.threads ?? []).map((x: { id: string }) => x.id), String(h.body?.threadId)]);
      return real;
    };
    const before = ((await W.call('ed', 'copilot:threads', { projectId: W.P })).body.threads as unknown[]).length;
    const id1 = await runOf('ed', suite);
    ok('start: a second run in the same project is refused while one is queued', (await start('boss', suite)).body?.ok === false && /already going/.test((await start('boss', suite)).body.error));
    const run1 = await S.drive(id1);
    const res1 = await results(id1);
    const by = (id: string) => res1.find((r) => r.caseId === id);
    const failing = (id: string) => (by(id)?.checks ?? []).filter((k) => !k.ok).map((k) => k.id).join(',');
    ok('run: it ends done with a result for each of the 6 cases', run1?.state === 'done' && res1.length === 6 && run1.casesDone === 6, `${run1?.state} ${run1?.errorCode} ${res1.length}`);
    ok('the right answer passes, with every check', by(c1)?.outcome === 'pass' && (by(c1)?.checks ?? []).map((k) => k.id).join() === 'answered,question,figure,audit' && failing(c1) === '', JSON.stringify(by(c1)));
    ok('NEGATIVE CONTROL: the wrong dataset fails the question', by(c2)?.outcome === 'fail' && failing(c2).includes('question'), JSON.stringify(by(c2)?.checks));
    ok('NEGATIVE CONTROL: the wrong filter fails the question and the figure', by(c3)?.outcome === 'fail' && failing(c3) === 'question,figure', JSON.stringify(by(c3)?.checks));
    ok('NEGATIVE CONTROL: a made-up figure fails the audit alone', by(c4)?.outcome === 'fail' && failing(c4) === 'audit', JSON.stringify(by(c4)?.checks));
    ok('NEGATIVE CONTROL: a prose-only reply where a refusal was expected fails', by(cr)?.outcome === 'fail' && by(cr)?.checks[0]?.code === 'prose', JSON.stringify(by(cr)?.checks));
    ok('refuse: a chart the app refused passes', by(cr2)?.outcome === 'pass', JSON.stringify(by(cr2)?.checks));
    ok('counts: 2 passed, 4 failed, and one model call per case (the judge is not called without words)', run1?.passed === 2 && run1.failed === 4 && run1.modelCalls === 6 && stub.calls.ask === 6 && stub.calls.judge === 0, `${run1?.passed} ${run1?.failed} ${run1?.modelCalls} ${stub.calls.ask}`);
    ok('the hidden conversation: in no list nor "the latest" while the case was asked', listed.length === 1 && listed[0].length === before + 1 && !listed[0].includes('undefined') && (await W.pool.query(`SELECT count(*)::int AS n FROM assistant_threads WHERE hidden`)).rows[0].n === 0, JSON.stringify(listed));
    ok('the hidden conversation: gone afterwards, History is as before', ((await W.call('ed', 'copilot:threads', { projectId: W.P })).body.threads as unknown[]).length === before);
    ok('the run kept no card and no figure: a result holds words, codes and ids', !JSON.stringify(res1).includes('"series"') && !JSON.stringify(res1).includes('Chart values'));

    // ── Who sees what ───────────────────────────────────────────────────────────────────────────────────────────────────────
    const edGet = await W.call('ed', 'eval:runGet', { projectId: W.P, runId: id1 });
    const bossGet = await W.call('boss', 'eval:runGet', { projectId: W.P, runId: id1 });
    ok('runner: the answer\'s words come with their own result', edGet.body?.ok && edGet.body.cases.find((c: { caseId: string }) => c.caseId === c4)?.reply?.startsWith('Total sales were 987654.') && edGet.body.run.mine === true, edGet.text.slice(0, 200));
    ok('another editor (the admin): every outcome and check, but no reply, no judge line', bossGet.body?.ok && bossGet.body.cases.length === 6 && bossGet.body.cases.every((c: { reply?: string; why?: string }) => c.reply === undefined && c.why === undefined) && !bossGet.text.includes('987654') && bossGet.body.run.mine === false, bossGet.text.slice(0, 200));
    ok('a viewer cannot read a run, start one or stop one', (await Promise.all(['east', 'west', 'nobody'].flatMap((w) => [W.call(w, 'eval:runGet', { projectId: W.P, runId: id1 }), start(w, suite), W.call(w, 'eval:suites', { projectId: W.P })]))).every((r) => r.status === 403));

    // ── The comparison with the last run ────────────────────────────────────────────────────────────────────────────────────
    stub.asks['Sales by region, other data?'] = { text: 'West leads.', action: BY_REGION('Other') }; // the agent is fixed: c2 now passes
    stub.asks['Sales by region?'] = { text: 'West leads.', action: BY_REGION('Plain', { filters: WEST }) }; // …and c1 got worse
    const id2 = await runOf('ed', suite);
    await S.drive(id2);
    const g2 = await W.call('ed', 'eval:runGet', { projectId: W.P, runId: id2 });
    const move = (id: string) => g2.body.cases.find((c: { caseId: string }) => c.caseId === id)?.move;
    ok('compare: c2 is better, c1 is worse, the other four are the same', move(c2) === 'better' && move(c1) === 'worse' && [c3, c4, cr, cr2].every((c) => move(c) === 'same') && g2.body.compare?.runId === id1, JSON.stringify(g2.body.compare));
    ok('compare: the totals say so', g2.body.compare?.better === 1 && g2.body.compare.worse === 1 && g2.body.compare.same === 4 && g2.body.compare.new === 0);
    const list = await W.call('boss', 'eval:suites', { projectId: W.P });
    ok('suites: the last run, the case count and no stale part while nothing changed', list.body?.ok && list.body.suites[0].caseCount === 6 && list.body.suites[0].last.runId === id2 && list.body.suites[0].stale.length === 0, JSON.stringify(list.body?.suites?.[0]));

    // ── The judge ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    stub.reset();
    const sj = await S.suite('ed', 'Words');
    stub.asks['Why is revenue net?'] = { text: 'Revenue is net of refunds.' };
    await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId: sj, question: 'Why is revenue net?', say: 'says revenue is net of refunds' });
    const wRun = async (...replies: string[]) => { stub.calls.judge = 0; stub.judge = replies; return (await results(await S.drive(await runOf('ed', sj)).then((r) => r!.id)))[0]; };
    const j5 = await wRun('{"score":5,"why":"says it"}');
    ok('judge: a 5 passes; the model call count is the ask and the judge', j5.outcome === 'pass' && j5.score === 5 && j5.judged === 'scored' && j5.calls === 2 && stub.calls.judge === 1, JSON.stringify(j5));
    ok('judge: it reads the question, the reply and the words, fenced', /QUESTION\n<<<\nWhy is revenue net\?\n>>>/.test(stub.seen.judgeUser[0]) && /ANSWER\n<<<\nRevenue is net of refunds\.\n>>>/.test(stub.seen.judgeUser[0]) && /SHOULD SAY\n<<<\nsays revenue is net of refunds\n>>>/.test(stub.seen.judgeUser[0]));
    const j2 = await wRun('{"score":2,"why":"misses it"}');
    ok('judge: a 2 fails', j2.outcome === 'fail' && j2.score === 2);
    const jbad = await wRun('I think it is great');
    ok('NEGATIVE CONTROL: an unreadable judge reply is "not scored", never a pass', jbad.outcome === 'not_scored' && jbad.score === null && jbad.judged === 'not_scored', JSON.stringify(jbad));
    stub.asks['Sales by region?'] = { text: 'West leads.', action: BY_REGION('Plain') };
    const sk = await S.suite('ed', 'Skip judge');
    const cs = await fromAnswer(sk, 'Sales by region?', 'says West leads');
    stub.asks['Sales by region?'] = { text: 'West leads.', action: BY_REGION('Other') }; // wrong dataset
    stub.calls.judge = 0;
    const rs = (await results((await S.drive(await runOf('ed', sk)))!.id))[0];
    ok('NEGATIVE CONTROL: a case whose figure check failed is a fail with no judge call', rs.caseId === cs && rs.outcome === 'fail' && rs.judged === 'none' && stub.calls.judge === 0 && rs.calls === 1, JSON.stringify(rs));

    // ── Stop ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    stub.reset();
    const st = await S.suite('ed', 'Stop');
    for (const q of ['one?', 'two?', 'three?']) await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId: st, question: q, say: 'x' });
    let release!: () => void;
    stub.hold = new Promise<void>((r) => { release = r; });
    const idStop = await runOf('ed', st);
    worker.pauseForTest(false);
    await until(async () => { await worker.latestForTest()?.tick(); return stub.calls.ask >= 1; });
    worker.pauseForTest(true);
    const stopped = await W.call('boss', 'eval:runStop', { projectId: W.P, runId: idStop });
    release();
    const runStop = await S.drive(idStop);
    ok('stop: any editor may stop it; it ends stopped, with the cases it had finished', stopped.body?.ok && runStop?.state === 'stopped' && runStop.casesDone < 3, `${runStop?.state} ${runStop?.casesDone}`);
    ok('stop: a stopped run cannot be resumed, and its project is free again', (await W.call('ed', 'eval:runResume', { projectId: W.P, runId: idStop })).body?.ok === false && (await start('ed', st)).body?.ok === true);
    await S.drive((await store.listRuns('acme', W.P, st))[0].id);

    // ── The per-person cap, and resume ───────────────────────────────────────────────────────────────────────────────────────
    stub.reset();
    const cap = await S.suite('ed', 'Cap');
    for (const q of ['a?', 'b?', 'c?']) await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId: cap, question: q, refuse: true });
    slackDb.useSlackDb(W.pool, null, { timeoutMs: 120_000, perMinute: 2 });
    runMod.tuneForTest({ budgetPollMs: 20, budgetTries: 3 });
    budget.clear();
    const idCap = await runOf('ed', cap);
    const capped = await S.drive(idCap);
    ok('cap: the person\'s model-call cap is respected: 2 cases asked, then the run ends partial (limited)', capped?.state === 'partial' && capped.errorCode === 'limited' && stub.calls.ask === 2 && capped.casesDone === 2, `${capped?.state} ${capped?.errorCode} ${stub.calls.ask}`);
    slackDb.useSlackDb(W.pool, null, { timeoutMs: 120_000, perMinute: 1200 });
    budget.clear();
    ok('resume: only the runner may', (await W.call('boss', 'eval:runResume', { projectId: W.P, runId: idCap })).body?.ok === false);
    ok('resume: the runner does', (await W.call('ed', 'eval:runResume', { projectId: W.P, runId: idCap })).body?.ok === true);
    const resumed = await S.drive(idCap);
    ok('resume: it finishes with the third case, and the two finished ones were not asked again', resumed?.state === 'done' && resumed.casesDone === 3 && stub.calls.ask === 3, `${resumed?.state} ${stub.calls.ask}`);
    runMod.tuneForTest({ budgetPollMs: 2000, budgetTries: 30 });

    // ── A crash, retaken by "another pod" ────────────────────────────────────────────────────────────────────────────────────
    stub.reset();
    const cr3 = await S.suite('ed', 'Crash');
    const ids: string[] = [];
    for (const q of ['p1?', 'p2?', 'p3?']) ids.push((await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId: cr3, question: q, refuse: true })).body.id);
    const idCrash = await runOf('ed', cr3);
    const claimed = await store.claim('pod-a/1/aaaa', 300);
    const mkResult = (caseId: string, position: number) => ({ caseId, position, question: 'x', outcome: 'pass' as const, checks: [], judged: { state: 'none' as const }, calls: 1, errorCode: null, reply: null, why: null, datasetIds: [] });
    ok('crash: pod A claims the run and finishes the first case', claimed?.id === idCrash && (await store.recordResult('acme', idCrash, 'pod-a/1/aaaa', mkResult(ids[0], 1))) === true);
    await sleep(450); // pod A's lease lapses: it died
    const crashed = await S.drive(idCrash);
    ok('crash: another pod retakes it and asks only the two cases with no result', crashed?.state === 'done' && crashed.casesDone === 3 && stub.calls.ask === 2 && stub.seen.questions.join() === 'p2?,p3?', `${crashed?.state} ${stub.calls.ask} ${stub.seen.questions}`);
    ok('NEGATIVE CONTROL (the fence): a late result from the pod that died applies nothing', (await store.recordResult('acme', idCrash, 'pod-a/1/aaaa', mkResult(ids[1], 2))) === false && (await results(idCrash)).length === 3);

    // ── A dataset that is gone, a provider that fails ───────────────────────────────────────────────────────────────────────
    stub.reset();
    const temp = await W.as('boss', async () => (await datasets.saveDataset(W.P, { name: 'Temp', sourceKind: 'csv', columns: H.COLUMNS, rows: H.ROWS }))!.id);
    const sg = await S.suite('ed', 'Gone data');
    stub.asks['Temp by region?'] = { text: 'West leads.', action: BY_REGION('Temp') };
    const cg = await fromAnswer(sg, 'Temp by region?');
    await W.as('boss', () => datasets.deleteDataset(W.P, temp));
    const rg = await results((await S.drive(await runOf('ed', sg)))!.id);
    ok('NEGATIVE CONTROL: a case whose dataset was deleted FAILS (never an empty comparison that passes)', rg[0].caseId === cg && rg[0].outcome === 'fail' && rg[0].checks.some((k) => k.id === 'answered' && !k.ok), JSON.stringify(rg[0]));
    stub.asks['Temp by region?'] = { text: 'x', fail: true };
    const sf = await S.suite('ed', 'Provider fails');
    await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId: sf, question: 'Temp by region?', refuse: true });
    await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId: sf, question: 'Fine?', refuse: true });
    const runF = await S.drive(await runOf('ed', sf));
    const rf = await results(runF!.id);
    ok('a model error on one case is an `error` result, counted as failed, and the run goes on to the next', runF?.state === 'done' && rf.length === 2 && rf[0].outcome === 'error' && rf[0].errorCode === 'failed' && runF.failed >= 1 && rf[1].outcome === 'fail', `${runF?.state} ${JSON.stringify(rf.map((r) => [r.outcome, r.errorCode]))}`);

    // ── An agent that is gone cannot be tested ───────────────────────────────────────────────────────────────────────────────
    const agent = await S.agent('Finance');
    const sa = await S.suite('ed', 'Finance tests', agent);
    await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId: sa, question: 'q?', refuse: true });
    ok('an agent\'s suite runs', (await start('ed', sa)).body?.ok === true);
    await S.drive((await store.listRuns('acme', W.P, sa))[0].id);
    await W.call('boss', 'agent:delete', { projectId: W.P, id: agent });
    const gone = await start('ed', sa);
    ok('NEGATIVE CONTROL: once the agent is deleted the suite is refused, not run as the Project assistant', gone.body?.ok === false && /cannot use that assistant/.test(gone.body.error), gone.text);

  } finally {
    await S.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
