// Background jobs (src/app/jobs.ts): the state machine, the concurrency rules
// (three overall, one per dataset), cancel in both states, `interrupted`
// after a crash, and a queued job running as whoever SUBMITTED it.
//
//   npm run build:ts && node scripts/test-jobs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import * as jobs from '../src/app/jobs';

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A job whose run() waits until released — so the test controls the order. */
function gate() {
  let release!: (v?: unknown) => void;
  let fail!: (e: unknown) => void;
  const p = new Promise((res, rej) => { release = res; fail = rej; });
  return { p, release, fail };
}

void (async () => {
  // ── The happy path ─────────────────────────────────────────────────────────
  jobs.reset();
  const seen: string[] = [];
  jobs.onChange((s) => { for (const j of s.active) seen.push(j.state); });
  const g = gate();
  const a = jobs.submit({
    kind: 'export', label: 'Export CSV',
    run: async (ctx) => { ctx.progress(0.5, 'half'); await g.p; return '/tmp/out.csv'; },
    resultOf: (p) => ({ path: p }),
  });
  await tick();
  ok('state: a submitted job is running (queue empty below the cap)', jobs.get(a.id)?.state === 'running');
  ok('progress: reported progress and note are visible', jobs.get(a.id)?.progress === 0.5 && jobs.get(a.id)?.note === 'half');
  g.release();
  const v = await a.done;
  const done = jobs.get(a.id);
  ok('done: resolves with the run value', v === '/tmp/out.csv');
  ok('done: final state, progress 1, result path kept for Reveal',
    done?.state === 'done' && done.progress === 1 && done.result?.path === '/tmp/out.csv');
  ok('done: moved to recent', jobs.snapshot().active.length === 0 && jobs.snapshot().recent[0].id === a.id);
  ok('events: queued then running were both emitted', seen.includes('queued') && seen.includes('running'));

  // ── Errors ─────────────────────────────────────────────────────────────────
  const bad = jobs.submit({ kind: 'import', label: 'Bad import', run: async () => { throw new Error('parse failed at row 7'); } });
  let rejected = false;
  try { await bad.done; } catch (_) { rejected = true; }
  ok('error: the promise rejects', rejected);
  ok('error: state error with the message', jobs.get(bad.id)?.state === 'error' && jobs.get(bad.id)?.error === 'parse failed at row 7');
  const sync = jobs.submit({ kind: 'import', label: 'Sync throw', run: (() => { throw new Error('boom'); }) as never });
  try { await sync.done; } catch (_) { /* expected */ }
  ok('error: a run() that throws synchronously is still an error, not a crash', jobs.get(sync.id)?.state === 'error');

  // ── Concurrency: three overall ─────────────────────────────────────────────
  jobs.reset();
  const gates = [gate(), gate(), gate(), gate()];
  const four = gates.map((gg, i) => jobs.submit({ kind: 'report', label: 'R' + i, run: async () => gg.p }));
  await tick();
  ok('cap: three run, the fourth waits', jobs.snapshot().active.filter((j) => j.state === 'running').length === jobs.MAX_RUNNING &&
    jobs.get(four[3].id)?.state === 'queued');
  gates[0].release();
  await four[0].done;
  await tick();
  ok('cap: a finished job lets the queued one start', jobs.get(four[3].id)?.state === 'running');
  gates.forEach((gg) => gg.release());
  await Promise.all(four.map((f) => f.done));

  // ── Concurrency: one per dataset, and no head-of-line blocking ─────────────
  jobs.reset();
  const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const D2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const g1 = gate(), g2 = gate(), g3 = gate();
  const r1 = jobs.submit({ kind: 'refresh', label: 'D1 first', datasetId: D1, run: async () => g1.p });
  const r2 = jobs.submit({ kind: 'quality', label: 'D1 second', datasetId: D1, run: async () => g2.p });
  const r3 = jobs.submit({ kind: 'refresh', label: 'D2', datasetId: D2, run: async () => g3.p });
  await tick();
  ok('dataset: the second job on the same dataset waits', jobs.get(r2.id)?.state === 'queued');
  ok('dataset: a job on ANOTHER dataset behind it still starts', jobs.get(r3.id)?.state === 'running');
  g1.release();
  await r1.done;
  await tick();
  ok('dataset: the waiting job starts once the first finishes', jobs.get(r2.id)?.state === 'running');
  g2.release(); g3.release();
  await Promise.all([r2.done, r3.done]);

  // ── A queued job runs in its SUBMITTER's async context ─────────────────────
  // It is started by whichever job finishes first — inside THAT job's context.
  // On the server the context is the org: a refresh queued by org B behind
  // three of org A's ran as org A (found by L0.3's queued refreshes).
  jobs.reset();
  const who = new AsyncLocalStorage<string>();
  const ga = [gate(), gate(), gate()];
  const asA = ga.map((gg) => who.run('org-a', () => jobs.submit({ kind: 'report', label: 'A', run: async () => gg.p })));
  const sawB: Array<string | undefined> = [];
  const asB = who.run('org-b', () => jobs.submit({ kind: 'report', label: 'B', run: async () => { sawB.push(who.getStore()); } }));
  const sawNone: Array<string | undefined> = [];
  const asNone = jobs.submit({ kind: 'report', label: 'none', run: async () => { sawNone.push(who.getStore()); } });
  await tick();
  ok('context: B and the context-free job are queued behind A\'s three', jobs.get(asB.id)?.state === 'queued' && jobs.get(asNone.id)?.state === 'queued');
  ga[0].release();
  await asB.done;
  ok('context: a queued job started by org A\'s finish runs as org B, who submitted it', sawB.join() === 'org-b', sawB.join());
  ga[1].release();
  await asNone.done;
  ok('context (control): one submitted outside any context sees none — not the finisher\'s', sawNone.length === 1 && sawNone[0] === undefined, String(sawNone[0]));
  ga[2].release();
  await Promise.all(asA.map((a) => a.done));

  // ── Cancel ─────────────────────────────────────────────────────────────────
  jobs.reset();
  const gl = [gate(), gate(), gate()];
  const blockers = gl.map((gg) => jobs.submit({ kind: 'report', label: 'block', run: async () => gg.p }));
  const queued = jobs.submit({ kind: 'export', label: 'queued', run: async () => 'never' });
  await tick();
  ok('cancel: queued → cancelled immediately', jobs.cancel(queued.id) && jobs.get(queued.id)?.state === 'cancelled');
  let qRejected = false;
  try { await queued.done; } catch (e) { qRejected = e instanceof jobs.JobCancelled; }
  ok('cancel: a queued job\'s promise rejects with JobCancelled', qRejected);
  gl.forEach((gg) => gg.release());
  await Promise.all(blockers.map((b) => b.done));

  let chunks = 0;
  const long = jobs.submit({
    kind: 'import', label: 'long import',
    run: async (ctx) => {
      for (let i = 0; i < 1000; i++) {
        ctx.checkCancelled();
        chunks++;
        ctx.progress(i / 1000);
        await tick();
      }
      return 'finished';
    },
  });
  await tick(); await tick();
  ok('cancel: running + cancellable → accepted', jobs.cancel(long.id));
  try { await long.done; } catch (_) { /* expected */ }
  ok('cancel: running job stops at its next check and ends cancelled',
    jobs.get(long.id)?.state === 'cancelled' && chunks < 1000);

  const nc = gate();
  const fixed = jobs.submit({ kind: 'backup', label: 'not cancellable', cancellable: false, run: async () => nc.p });
  await tick();
  ok('cancel: a non-cancellable job refuses', jobs.cancel(fixed.id) === false);
  nc.release();
  await fixed.done;

  const late = gate();
  const finishesAnyway = jobs.submit({ kind: 'export', label: 'ignores the signal', run: async () => { await late.p; return 'written'; } });
  await tick();
  jobs.cancel(finishesAnyway.id);
  late.release();
  await finishesAnyway.done;
  ok('cancel: a job that finishes anyway is reported DONE — its output exists',
    jobs.get(finishesAnyway.id)?.state === 'done');

  // ── A draining server (src/server/shutdown.ts) ────────────────────────────
  jobs.reset();
  const SENTENCE = 'Ordinate restarted while this was running. Run it again.';
  jobs.refuseNew(() => new Error('Ordinate is restarting. Try again in a minute.'));
  let refusedMsg = '';
  try { jobs.submit({ kind: 'export', label: 'x', run: async () => 1 }); } catch (err) { refusedMsg = (err as Error).message; }
  ok('drain: while draining, submit refuses with the sentence it was given', refusedMsg === 'Ordinate is restarting. Try again in a minute.', refusedMsg);
  jobs.refuseNew(null);
  const after = jobs.submit({ kind: 'export', label: 'x', run: async () => 1 });
  ok('NEGATIVE CONTROL: refuseNew(null) takes jobs again', (await after.done) === 1);

  jobs.reset();
  const drainSeen: Array<{ id: string; state: string; error?: string }> = [];
  jobs.onChange((s) => { for (const j of s.recent) drainSeen.push({ id: j.id, state: j.state, error: j.error }); });
  const quick = gate();
  const quickJob = jobs.submit({ kind: 'export', label: 'finishes in time', run: async () => { await quick.p; return 'ok'; } });
  const coop = jobs.submit({ kind: 'import', label: 'honours its signal', run: (ctx) => new Promise((_res, rej) => {
    ctx.signal.addEventListener('abort', () => rej(new Error('an unrelated error, raised by the abort')));
  }) });
  const deaf = gate();
  const deafJob = jobs.submit({ kind: 'refresh', label: 'ignores its signal', run: async () => { await deaf.p; return 'late'; } });
  const waiting = jobs.submit({ kind: 'report', label: 'still queued', run: async () => 'never' });
  for (const p of [coop.done, deafJob.done, waiting.done]) p.catch(() => undefined);
  await tick();
  setTimeout(() => quick.release(), 30);
  const reason = new Error(SENTENCE);
  const t0 = Date.now();
  const left = await jobs.drain(Date.now() + 150, reason, 100);
  const tookMs = Date.now() - t0;
  ok('drain: a queued job is cancelled with the sentence, never started', jobs.get(waiting.id)?.state === 'cancelled' && jobs.get(waiting.id)?.error === SENTENCE);
  ok('drain: a job that finishes before the deadline is done', jobs.get(quickJob.id)?.state === 'done');
  ok('drain: a running job is cancelled at the deadline with the sentence, whatever its run threw',
    jobs.get(coop.id)?.state === 'cancelled' && jobs.get(coop.id)?.error === SENTENCE, JSON.stringify(jobs.get(coop.id)));
  let coopErr = '';
  try { await coop.done; } catch (err) { coopErr = (err as Error).message; }
  ok('…and its caller is rejected with the sentence too', coopErr === SENTENCE, coopErr);
  ok('drain: a job that ignores its signal ends interrupted with the sentence, and is returned',
    jobs.get(deafJob.id)?.state === 'interrupted' && jobs.get(deafJob.id)?.error === SENTENCE && left.length === 1 && left[0].id === deafJob.id);
  ok(`drain: bounded by deadline + slice (${tookMs} ms)`, tookMs >= 240 && tookMs < 600, tookMs);
  ok('drain: every outcome was emitted (the owner\'s tab hears before the streams close)',
    [waiting.id, coop.id, deafJob.id].every((id) => drainSeen.some((j) => j.id === id && j.error === SENTENCE)));
  deaf.release();
  await tick();
  ok('drain: a late finish does not overwrite interrupted', jobs.get(deafJob.id)?.state === 'interrupted');

  // A job sees its own signal through the request context (withAbort), even
  // when the submitter's context has no signal — a scheduled refresh's.
  jobs.reset();
  const context: typeof import('../src/server/context') = require('../src/server/context');
  const sys = { user: { email: 'jobs@system', role: 'admin' as const }, org: { id: 'default' } };
  const seenSignal: { aborted?: boolean; had?: boolean } = {};
  const held = gate();
  const fromTick = context.runInContext(sys, 'job:refresh', () => jobs.submit({ kind: 'refresh', label: 'scheduled', run: async () => {
    seenSignal.had = !!context.ctx().signal;
    await held.p;
    seenSignal.aborted = context.ctx().signal?.aborted;
    return 1;
  } }));
  await tick();
  jobs.cancel(fromTick.id);
  held.release();
  await fromTick.done.catch(() => undefined);
  ok('signal: a job submitted from a signal-less context runs, with ITS signal in ctx()', seenSignal.had === true);
  ok('…and its Cancel aborts ctx().signal (so a DuckDB call it is in is interrupted)', seenSignal.aborted === true);
  const reqAc = new AbortController();
  const both: { aborted?: boolean } = {};
  const held2 = gate();
  const fromReq = context.runInContext(sys, 'rpc', () => jobs.submit({ kind: 'export', label: 'from a request', run: async () => {
    await held2.p;
    both.aborted = context.ctx().signal?.aborted;
    return 1;
  } }), undefined, reqAc.signal);
  await tick();
  reqAc.abort();
  held2.release();
  await fromReq.done;
  ok('signal: the submitting request\'s signal still reaches the job (as before)', both.aborted === true);

  // ── Persistence and interrupted ────────────────────────────────────────────
  jobs.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-test-'));
  const file = path.join(dir, 'jobs.json');
  jobs.configure({ file });
  const hang = gate();
  const running = jobs.submit({ kind: 'import', label: 'Import sales.csv', run: async () => hang.p });
  await tick();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('persist: the running job is on disk while it runs',
    onDisk.active.some((j: { id: string; state: string }) => j.id === running.id && j.state === 'running'));

  // Simulate a crash: forget the in-memory state, keep the file, boot again.
  jobs.reset();
  jobs.configure({ file });
  const interrupted = jobs.restore();
  ok('interrupted: the job that was running comes back as interrupted',
    interrupted.length === 1 && interrupted[0].id === running.id && interrupted[0].state === 'interrupted');
  ok('interrupted: it carries a human reason and sits in recent',
    /closed while/.test(jobs.snapshot().recent[0].error || '') && jobs.snapshot().active.length === 0);
  jobs.reset();
  jobs.configure({ file });
  ok('interrupted: a second boot does not interrupt it twice', jobs.restore().length === 0);

  fs.writeFileSync(file, '{not json');
  jobs.reset();
  jobs.configure({ file });
  ok('persist: a corrupt jobs file is ignored, never fatal', jobs.restore().length === 0);
  fs.writeFileSync(file, JSON.stringify({ active: [{ id: 'x', kind: 'rm -rf', state: 'running' }], recent: 'nope' }));
  jobs.reset();
  jobs.configure({ file });
  ok('persist: an unknown kind on disk is dropped by the sanitizer', jobs.restore().length === 0);

  let threw = false;
  try { jobs.submit({ kind: 'nonsense' as never, label: 'x', run: async () => 1 }); } catch (_) { threw = true; }
  ok('submit: an unknown kind is refused', threw);

  fs.rmSync(dir, { recursive: true, force: true });
  jobs.reset();
  finish();
})();
