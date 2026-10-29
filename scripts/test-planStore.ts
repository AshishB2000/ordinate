// Plan runs as records (src/ai/planStore.ts; docs/any-pod/00-design.md §3.5),
// on the file backend of recordFs — the same code a database runs:
//
//   1. a run is written without the upload token, and read back only by its starter;
//   2. a claimed step holds a lease: a second claim is BUSY (two pods, one Next);
//   3. an apply by a claim that lost its lease still MERGES the touches (undo must
//      know what the step made) but leaves the status alone — NEGATIVE CONTROL for
//      the fence: the owning claim's apply does change it;
//   4. a lease left by a pod that went away is recovered: that step failed, "may
//      have partly run", the touches kept; a lost undo goes back to its state;
//   5. caps: 10 runs per user (oldest first), a run past 24 h goes, a leased run is
//      never pruned.
//
//   npm run build:ts && node scripts/test-planStore.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { randomUUID } from 'crypto';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-planstore-'));
process.env.ORDINATE_LOCAL_DIR = TMP;

const store: typeof import('../src/ai/planStore') = require('../src/ai/planStore');
const pr: typeof import('../src/ai/planRun') = require('../src/ai/planRun');
const ps: typeof import('../src/ai/planSteps') = require('../src/ai/planSteps');
const context: typeof import('../src/server/context') = require('../src/server/context');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');

type StepOutcome = import('../src/ai/planRun').StepOutcome;
const P = randomUUID();
const STEPS = ps.sanitizePlanSteps([
  { kind: 'import', file: 'sales.csv', name: 'Sales' },
  { kind: 'metric', dataset: 'Sales', name: 'Revenue', column: 'Sales', aggregation: 'sum' },
]).steps;
const made = (id: string): StepOutcome => ({ ok: true, result: { summary: 'made ' + id }, touches: [{ type: 'dataset', id, name: id, created: true }] });
// The prune orders runs by updatedAt, to the millisecond. Two runs made in the same one tie, and
// which of them goes is then up to directory order, so each new run starts on a later millisecond.
const nextMs = (): void => { const t = Date.now(); while (Date.now() === t) { /* spin, < 1 ms */ } };
const fresh = async () => {
  nextMs();
  return store.create({ ...pr.newRun(randomUUID(), P, '', 'test', STEPS), fileToken: 'x'.repeat(43) } as import('../src/ai/planRun').PlanRun);
};
const file = (runId: string): string => store.runPath(P, runId);
const edit = (runId: string, fn: (r: Record<string, any>) => void): void => { // any: a raw record on disk
  const r = JSON.parse(fs.readFileSync(file(runId), 'utf8'));
  fn(r);
  fs.writeFileSync(file(runId), JSON.stringify(r));
};

(async () => {
  // 1. Written, read back, owned.
  const run = await fresh();
  const raw = fs.readFileSync(file(run.id), 'utf8');
  ok('a run is a record under its project, without the upload token', !raw.includes('fileToken') && !raw.includes('x'.repeat(43)) && JSON.parse(raw).by === 'desktop');
  ok('its starter reads it back', (await store.read(P, run.id))?.id === run.id);
  const stranger = await context.runInContext({ user: { email: 'eve@x.test', role: 'admin' }, org: { id: 'desktop' } }, 't', () => store.read(P, run.id));
  ok('anyone else finds nothing, as for an unknown run', stranger === null);

  // 2. One claim at a time.
  const c1 = await store.claim(P, run.id, 'step', pr.beginStep);
  const c2 = await store.claim(P, run.id, 'step', pr.beginStep);
  ok('a claimed step is leased; a second claim (another pod\'s Next) is busy', !!c1 && !c1.busy && c1.index === 0 && !!c2 && c2.busy && c2.run.status[0] === 'running');

  // 3. The fence: touches merge always, the transition only for the owner.
  const foreign = await store.apply(P, run.id, 'not-this-claim', (r) => pr.addTouches(r, made('d1')), (r) => pr.endStep(r, 0, made('d1')));
  ok('a claim that lost its lease still merges its touches, and changes no status', !!foreign && foreign.touches.length === 1 && foreign.status[0] === 'running' && !!foreign.lease);
  const mine = await store.apply(P, run.id, c1!.claim, (r) => pr.addTouches(r, made('d2')), (r) => pr.endStep(r, 0, made('d2')));
  ok('NEGATIVE CONTROL for the fence: the owning claim\'s apply does move the step on, and lets go', !!mine && mine.status[0] === 'done' && mine.state === 'paused' && !mine.lease && mine.touches.length === 2);

  // 4. A pod that went away mid-step, then mid-undo.
  const c3 = await store.claim(P, run.id, 'step', pr.beginStep);
  edit(run.id, (r) => { r.lease.until = 0; });
  const late = await store.apply(P, run.id, c3!.claim, (r) => pr.addTouches(r, made('d3')), (r) => pr.endStep(r, 1, made('d3')));
  ok('an expired lease is recovered: that step failed, "may have partly run", and its late touches are still kept for undo',
    !!late && late.status[1] === 'failed' && late.errors[1] === store.INTERRUPTED && late.state === 'failed' && late.touches.length === 3 && !late.lease,
    JSON.stringify(late && { status: late.status, state: late.state }));
  ok('…so undo still trashes what the interrupted step made', pr.undoGroups(late!.touches).some((g) => g.id === 'd3' && g.action === 'trash'));
  const u = await store.claim(P, run.id, 'undo', (r) => { if (!pr.canUndo(r)) return -1; r.state = 'running'; return 0; });
  edit(run.id, (r) => { r.lease.until = 0; });
  const back = await store.update(P, run.id, (r) => r.state);
  ok('a lost undo goes back to the state it had', !!u && u.index === 0 && back?.out === 'failed' && !back.run.lease);

  // 5. Caps and TTL.
  const leased = await fresh();
  await store.claim(P, leased.id, 'step', pr.beginStep);
  const others: string[] = [];
  for (let i = 0; i < 11; i++) others.push((await fresh()).id);
  const left = (): string[] => fs.readdirSync(path.dirname(file(run.id))).filter((n) => n.endsWith('.json')).map((n) => n.replace('.json', ''));
  ok(`10 runs per user, oldest first (${left().length} left: 10 newest + the leased one)`, left().length === 11 && left().includes(leased.id) && !left().includes(run.id) && others.slice(1).every((id) => left().includes(id)));
  edit(others[others.length - 1], (r) => { r.updatedAt = new Date(Date.now() - 25 * 3_600_000).toISOString(); });
  await store.prune();
  ok('a run untouched for 24 h goes; a leased run is never pruned', !left().includes(others[others.length - 1]) && left().includes(leased.id));

  // L6: plan:start prunes only the caller's runs in its project; the sweep's full prune does the rest.
  const Q = randomUUID();
  const inQ = async () => store.create(pr.newRun(randomUUID(), Q, '', 'other project', STEPS));
  for (let i = 0; i < 11; i++) await inQ();
  const qLeft = (): number => fs.readdirSync(path.dirname(store.runPath(Q, randomUUID()))).filter((n) => n.endsWith('.json')).length;
  const pBefore = left().length;
  await fresh(); // a start in P
  ok(`a start in one project reads and prunes only that project (the other keeps its ${qLeft()} runs, per-user capped there)`, qLeft() === 10 && left().length <= pBefore + 1);
  await store.prune();
  ok('the full prune holds the user to 10 runs across every project (the leased one aside)', left().length + qLeft() <= 11, JSON.stringify({ p: left().length, q: qLeft() }));

  // L1: an apply that meets a busy record is tried again — the step's touches are never lost.
  const run2 = await fresh();
  const cl = await store.claim(P, run2.id, 'step', pr.beginStep);
  const realLocked = recordFs.locked;
  let failures = 1;
  (recordFs as { locked: typeof realLocked }).locked = (async (p: string, fn: () => Promise<unknown>) => {
    if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'ERECORDBUSY' });
    return realLocked(p, fn);
  }) as typeof realLocked;
  const applied = await store.apply(P, run2.id, cl!.claim, (r) => pr.addTouches(r, made('kept')), (r) => pr.endStep(r, 0, made('kept'))).catch(() => null);
  (recordFs as { locked: typeof realLocked }).locked = realLocked;
  ok('an apply that meets ERECORDBUSY once is tried again: the touches and the step\'s result land', !!applied && applied.touches.some((t) => t.id === 'kept') && applied.status[0] === 'done');
})()
  .catch((err) => ok('the suite ran to the end', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
