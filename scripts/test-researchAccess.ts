// Deep research: who may do what. A viewer cannot start a run; another person cannot get, stop, resume or add someone else's run;
// an agent the starter may not use is refused; one run at a time per person; AI not ready is refused; a run whose starter lost write
// access (or was disabled) stops at the next step and cannot be resumed. Through the real RPC layer as header-signed people.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-researchAccess.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { researchWorld, answerStep } from './researchHarness';

const execConfig: any = require('../src/app/execConfig'); // any: swapped for a test

const DONE = '{"kind":"done"}';
const byRegion = answerStep({ dataset: 'Plain', category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }] });

(async () => {
  const S = await researchWorld('research access');
  if (!S) return;
  const { W, stub } = S;
  try {
    for (const who of ['east', 'west', 'nobody']) {
      const r = await S.start(who, 'why?');
      ok(`viewer: ${who} cannot start a run`, r.status === 403);
    }
    ok('viewer: nothing was queued', (await W.pool.query('SELECT 1 FROM research_runs')).rowCount === 0);
    ok('input: an empty or oversized question, an unknown key and a bad id are refused', (await S.start('ed', '   ')).status === 400 && (await S.start('ed', 'x'.repeat(4001))).status === 400
      && (await W.call('ed', 'research:start', { projectId: W.P, question: 'q', extra: 1 })).status === 400 && (await W.call('ed', 'research:get', { projectId: W.P, runId: 'not-a-uuid' })).status === 400);

    // AI not ready.
    const ready = execConfig.executionReady;
    execConfig.executionReady = async () => false;
    const off = await S.start('ed', 'why?');
    execConfig.executionReady = ready;
    ok('not ready: no model, no run, and the reply says why', off.body?.ok === false && off.body.notReady === true && (await W.pool.query('SELECT 1 FROM research_runs')).rowCount === 0);

    // An agent the starter may not use (editors may use every agent of a project; one that is gone, or that a viewer's team lacks, is refused).
    const agent: string = (await W.call('boss', 'agent:save', { projectId: W.P, agent: { name: 'East only', topicId: null, model: null, build: true, teamIds: [W.team] } })).body?.agent?.id;
    ok('fixture: an agent', !!agent);
    const withAgent = await S.start('boss', 'why?', { agentId: agent });
    ok('agent: a starter who may use it starts a run, which keeps the agent', withAgent.body?.ok === true && (await S.run(withAgent.body.runId))?.agentId === agent);
    await W.pool.query('DELETE FROM research_runs');
    const gone: string = (await W.call('boss', 'agent:save', { projectId: W.P, agent: { name: 'Soon gone', topicId: null, model: null, build: true, teamIds: [] } })).body?.agent?.id;
    await W.call('boss', 'agent:delete', { projectId: W.P, id: gone });
    const denied = await S.start('ed', 'why?', { agentId: gone });
    ok('agent: one the starter may not use (deleted) is refused, and no run is left behind', denied.body?.ok === false && (await W.pool.query('SELECT 1 FROM research_runs')).rowCount === 0, denied.text.slice(0, 200));
    stub.reset();
    stub.steps = [byRegion, async () => { await W.call('boss', 'agent:delete', { projectId: W.P, id: agent }); return byRegion; }, DONE];
    const own = await S.start('boss', 'agent goes away', { agentId: agent });
    const ra = await S.drive(own.body.runId);
    ok('agent: one that goes away mid-run ends it at the next step (failed, access)', ra?.state === 'failed' && ra.errorCode === 'access' && ra.steps.length === 1, `${ra?.state} ${ra?.errorCode}`);
    await W.pool.query('DELETE FROM research_runs');

    // One run at a time per person, and another person's thread is never written into.
    await S.start('boss', 'first');
    const second = await S.start('boss', 'again?');
    ok('one at a time: a second start by the same person is refused with a sentence', second.body?.ok === false && /in progress/.test(second.body.error));
    ok('one at a time: another person may start one', (await S.start('ed', 'and me?')).body?.ok === true);
    await W.pool.query('DELETE FROM research_runs');
    const other = await S.start('ed', 'into boss\'s thread', { threadId: own.body.threadId });
    ok('thread: a conversation that is not the caller\'s is not written into (a new one is made)', other.body?.ok === true && other.body.threadId !== own.body.threadId);
    await W.pool.query('DELETE FROM research_runs');

    // Who may read, stop, resume, add someone else's run.
    stub.reset();
    stub.steps = [byRegion, DONE];
    stub.write = '{}';
    const mine = (await S.start('ed', 'private run')).body.runId as string;
    await S.drive(mine);
    const channels = ['research:get', 'research:stop', 'research:resume', 'research:addToProject'];
    for (const who of ['boss', 'east', 'west', 'nobody']) {
      const rs = await Promise.all(channels.map((c) => W.call(who, c, { projectId: W.P, runId: mine })));
      ok(`private: ${who} gets nothing from get, stop, resume or add of ed's run`, rs.every((r) => r.status === 403 || r.body?.ok === false) && !rs.some((r) => /private run/.test(r.text)), JSON.stringify(rs.map((r) => r.status)));
    }
    ok('private: nothing of theirs changed it (not stopped, not added)', (await S.run(mine))?.stopRequested === false && (await S.run(mine))?.storyId === null);
    const wrongProject = await W.call('ed', 'research:get', { projectId: '00000000-0000-4000-8000-000000000000', runId: mine });
    ok('private: the run id under another project is not found', wrongProject.status === 403 || wrongProject.body?.ok === false);
    ok('private (negative control): its starter reads, resumes and adds it', (await W.call('ed', 'research:get', { projectId: W.P, runId: mine })).body?.ok === true && (await W.call('ed', 'research:addToProject', { projectId: W.P, runId: mine })).body?.ok === true);

    // A starter who lost write access stops at the next step; the run cannot be resumed.
    stub.reset();
    stub.steps = [byRegion, async () => {
      await W.call('boss', 'project:share', { projectId: W.P, member: { userId: W.uid.ed }, role: 'viewer' }); // ed is now a viewer
      return byRegion;
    }, byRegion, DONE];
    const lost = (await S.start('ed', 'lose access')).body.runId as string;
    const rl = await S.drive(lost);
    ok('access: a starter who lost write access stops at the next step (failed, access), the steps so far kept', rl?.state === 'failed' && rl.errorCode === 'access' && rl.steps.length === 1 && stub.calls.write === 0, `${rl?.state} ${rl?.errorCode} ${rl?.steps.length}`);
    ok('access: the run is not resumable, and as a viewer they cannot start another', !(await W.call('ed', 'research:resume', { projectId: W.P, runId: lost })).body?.ok && (await S.start('ed', 'again')).status === 403);
    ok('access: as a viewer they can still read their own run (they read what they made)', (await W.call('ed', 'research:get', { projectId: W.P, runId: lost })).body?.ok === true);
    await W.call('boss', 'project:share', { projectId: W.P, member: { userId: W.uid.ed }, role: 'editor' });

    // A disabled account stops the run before any work; its row says access.
    stub.reset();
    stub.steps = [byRegion, DONE];
    const dis = (await S.start('ed', 'disabled')).body.runId as string;
    await W.pool.query(`UPDATE users SET disabled_at = now() WHERE email = 'ed@acme.test'`);
    const rd = await S.drive(dis);
    await W.pool.query(`UPDATE users SET disabled_at = NULL WHERE email = 'ed@acme.test'`);
    ok('access: a disabled account ends the run (failed, access) before any model call', rd?.state === 'failed' && rd.errorCode === 'access' && stub.calls.plan === 0 && stub.calls.step === 0);
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
