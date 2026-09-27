// Background jobs (src/app/jobs.ts): the state machine, the concurrency rules
// (three overall, one per dataset), cancel in both states, and `interrupted`
// after a crash.
//
//   npm run build:ts && node scripts/test-jobs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
