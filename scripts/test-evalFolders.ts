// Evaluation suites in the team-folders world (docs/eval-suites/00-design.md, "Folders"): a case's spec names a dataset and its filter
// values, so a case on a dataset in a folder the caller cannot open is gone from their view as a verified question on it is: from the list of
// suites and its counts, from the cases, from a run's results and counts (recounted over what they may open), and from what a run of theirs
// asks. The answer's words go only to the person who ran it, and only while the data they read is open to them. Over scripts/folderHarness.ts.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-evalFolders.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import * as F from './folderHarness';

const worker: typeof import('../src/server/evals/worker') = require('../src/server/evals/worker');
const execConfig: any = require('../src/app/execConfig'); // any: the stub replaces its exports
const context: typeof import('../src/server/context') = require('../src/server/context');

(async () => {
  const W = await F.world('eval folders');
  if (!W) return;
  const real = { ready: execConfig.executionReady, on: execConfig.assistantOn };
  try {
    worker.pauseForTest(true);
    execConfig.executionReady = async () => { context.ctx(); return true; };
    execConfig.assistantOn = () => true;
    if (!(await W.pool.query('SELECT 1 FROM folders LIMIT 1')).rowCount) await W.plantFolders();
    const P = W.P;
    const suite = (await W.call('padmin', 'eval:suiteSave', { projectId: P, name: 'Everything' })).body.id as string;
    const hrCase = (await W.call('padmin', 'eval:caseFrom', { projectId: P, suiteId: suite, from: { kind: 'verified', id: W.hr.verified } })).body;
    const opsCase = (await W.call('padmin', 'eval:caseFrom', { projectId: P, suiteId: suite, from: { kind: 'verified', id: W.ops.verified } })).body;
    ok('fixture: the project admin makes a case from HR\'s verified question and one from Ops\'s', hrCase?.ok === true && opsCase?.ok === true, JSON.stringify([hrCase, opsCase]));
    const list = async (who: F.Person) => (await W.call(who, 'eval:cases', { projectId: P, suiteId: suite })).body;
    const count = async (who: F.Person) => (await W.call(who, 'eval:suites', { projectId: P })).body.suites[0].caseCount;

    ok('the project admin (who opens every folder) sees both cases', (await list('padmin')).cases.length === 2 && (await count('padmin')) === 2);
    const lead = await list('opsLead');
    ok('NEGATIVE CONTROL: an editor who cannot open HR sees the Ops case only, and it is counted so', lead.cases.length === 1 && lead.cases[0].id === opsCase.caseId && (await count('opsLead')) === 1, JSON.stringify(lead.cases?.map((c: { question: string }) => c.question)));
    ok('the HR case leaves no trace in what the editor gets: no question, no dataset name, no spec', !JSON.stringify(lead).includes('HRCANARY') && !JSON.stringify(await W.call('opsLead', 'eval:suites', { projectId: P })).includes('HRCANARY'));
    ok('an editor who cannot open HR cannot make a case from its verified question (as if it did not exist)', (await W.call('opsLead', 'eval:caseFrom', { projectId: P, suiteId: suite, from: { kind: 'verified', id: W.hr.verified } })).body?.error === (await W.call('opsLead', 'eval:caseFrom', { projectId: P, suiteId: suite, from: { kind: 'verified', id: randomUUID() } })).body?.error);

    // A finished run of padmin's over both cases, planted: results with words, and one that read HR.
    const run = randomUUID();
    await W.pool.query(`INSERT INTO eval_runs (org_id, project_id, id, suite_id, started_by, state, case_ids, cases_total, cases_done, passed, failed) VALUES ('acme', $1, $2, $3, 'padmin@acme.test', 'done', $4::jsonb, 2, 2, 1, 1)`, [P, run, suite, JSON.stringify([hrCase.caseId, opsCase.caseId])]);
    await W.pool.query(`INSERT INTO eval_results (org_id, run_id, case_id, position, question, outcome, reply, dataset_ids) VALUES ('acme', $1, $2, 1, 'HR question', 'fail', 'HRREPLY_CANARY', $3::jsonb), ('acme', $1, $4, 2, 'Ops question', 'pass', 'OPSREPLY_CANARY', $5::jsonb)`, [run, hrCase.caseId, JSON.stringify([W.hr.ds]), opsCase.caseId, JSON.stringify([W.ops.ds])]);
    const get = async (who: F.Person) => (await W.call(who, 'eval:runGet', { projectId: P, runId: run })).body;
    const g = await get('padmin');
    ok('the runner sees both results, with their words', g.cases.length === 2 && g.cases[0].reply === 'HRREPLY_CANARY' && g.cases[1].reply === 'OPSREPLY_CANARY' && g.run.casesTotal === 2 && g.run.failed === 1);
    const ge = await W.call('opsLead', 'eval:runGet', { projectId: P, runId: run });
    ok('NEGATIVE CONTROL: another editor, closed to HR, gets the Ops result only, the counts recounted over it, and none of the words', ge.body.cases.length === 1 && ge.body.run.casesTotal === 1 && ge.body.run.passed === 1 && ge.body.run.failed === 0 && !ge.text.includes('HRREPLY') && !ge.text.includes('OPSREPLY') && !ge.text.includes('HR question'), ge.text.slice(0, 300));
    ok('the list of runs counts the same way', (await W.call('opsLead', 'eval:runList', { projectId: P })).body.runs[0].casesDone === 1 && (await W.call('padmin', 'eval:runList', { projectId: P })).body.runs[0].casesDone === 2);
    const last = (await W.call('opsLead', 'eval:suites', { projectId: P })).body.suites[0].last;
    ok('the suite\'s last run counts the same way', last.casesDone === 1 && last.failed === 0 && last.passed === 1, JSON.stringify(last));

    // The runner themself, a person who later lost the folder: a result that read HR keeps its words from them.
    const run2 = randomUUID();
    await W.pool.query(`INSERT INTO eval_runs (org_id, project_id, id, suite_id, started_by, state, case_ids, cases_total, cases_done, passed) VALUES ('acme', $1, $2, $3, 'oplead@acme.test', 'done', $4::jsonb, 1, 1, 1)`.replace('oplead', 'opslead'), [P, run2, suite, JSON.stringify([opsCase.caseId])]);
    await W.pool.query(`INSERT INTO eval_results (org_id, run_id, case_id, position, question, outcome, reply, dataset_ids) VALUES ('acme', $1, $2, 1, 'Ops question', 'pass', 'LEAD_REPLY', $3::jsonb)`, [run2, opsCase.caseId, JSON.stringify([W.ops.ds])]);
    const mineOpen = (await W.call('opsLead', 'eval:runGet', { projectId: P, runId: run2 })).body.cases[0];
    await W.pool.query(`UPDATE eval_results SET dataset_ids = $2::jsonb WHERE run_id = $1`, [run2, JSON.stringify([W.ops.ds, W.hr.ds])]);
    const mineClosed = (await W.call('opsLead', 'eval:runGet', { projectId: P, runId: run2 })).body.cases[0];
    ok('the runner sees their own answer\'s words while the data it read is open to them', mineOpen.reply === 'LEAD_REPLY');
    ok('NEGATIVE CONTROL: once the answer read a dataset closed to them, the words are withheld even from the runner', mineClosed.reply === undefined && mineClosed.outcome === 'pass');

    // What a run of theirs asks.
    const started = await W.call('opsLead', 'eval:runStart', { projectId: P, suiteId: suite });
    const ids = started.body?.ok ? ((await W.pool.query('SELECT case_ids FROM eval_runs WHERE id = $1', [started.body.runId])).rows[0].case_ids as string[]) : [];
    ok('a run by an editor closed to HR asks the cases they may open and no others', started.body?.ok === true && ids.length === 1 && ids[0] === opsCase.caseId, started.text.slice(0, 200));
    await W.call('opsLead', 'eval:runStop', { projectId: P, runId: started.body.runId });
  } finally {
    execConfig.executionReady = real.ready;
    execConfig.assistantOn = real.on;
    await W.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
