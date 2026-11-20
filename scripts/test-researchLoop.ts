// Deep research: the run's loop with fake dependencies and a fake clock — limits, rejected steps, done, stop, the deadline, resume.
//   npm run build:ts && node scripts/test-researchLoop.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const L: typeof import('../src/ai/researchLoop') = require('../src/ai/researchLoop');
type Action = import('../src/ai/researchActions').ResearchAction;
type Deps = import('../src/ai/researchLoop').LoopDeps;

const answer: Action = { kind: 'answer', intent: 'x', spec: { dataset: 'Sales' } };
const good = { status: 'done' as const, title: 'T', spec: { a: 1 }, facts: 'f', ledger: [], datasetIds: ['d'] };

interface World { clock: number; model: number; computed: number; saved: number; stop: boolean; denied: boolean; lost: boolean }
function world(script: Array<'act' | 'done' | 'refuse' | 'model'>, over: Partial<Deps> & { compute?: Deps['compute'] } = {}): { w: World; deps: Deps } {
  const w: World = { clock: 0, model: 0, computed: 0, saved: 0, stop: false, denied: false, lost: false };
  const deps: Deps = {
    now: () => w.clock, deadline: 600_000, lost: () => w.lost, stopRequested: async () => w.stop, allowed: async () => !w.denied,
    async decide() {
      const s = script[Math.min(w.model, script.length - 1)];
      w.model += 1;
      return s === 'done' ? { ok: true, action: { kind: 'done' } } : s === 'refuse' ? { ok: false, refused: 'nope' } : s === 'model' ? { ok: false, fatal: 'model' } : { ok: true, action: answer };
    },
    async compute() { w.computed += 1; return good; },
    async save() { w.saved += 1; },
    ...over,
  };
  return { w, deps };
}
const empty = { steps: [], stepsUsed: 0, queriesUsed: 0 };
const lim = (o: Partial<import('../src/ai/researchLoop').Limits> = {}) => ({ ...L.DEFAULT_LIMITS, ...o });

(async () => {
  ok('limits: the defaults are 8 steps, 12 queries, 10 minutes and the ceilings 20, 30, 30', L.DEFAULT_LIMITS.steps === 8 && L.DEFAULT_LIMITS.queries === 12 && L.DEFAULT_LIMITS.minutes === 10 && L.CEILING.steps === 20 && L.CEILING.queries === 30 && L.CEILING.minutes === 30);

  let { w, deps } = world(['act']);
  let r = await L.runLoop(lim(), empty, deps);
  ok('steps: stops at exactly 8 model calls', r.end === 'steps' && w.model === 8 && r.state.stepsUsed === 8 && r.state.steps.length === 8 && w.computed === 8, JSON.stringify([r.end, w.model]));
  ok('steps: every step was saved as it finished', w.saved === 8);

  ({ w, deps } = world(['act']));
  r = await L.runLoop(lim({ queries: 3 }), empty, deps);
  ok('queries: stops at exactly 3 queries when the limit is 3', r.end === 'queries' && w.computed === 3 && r.state.queriesUsed === 3 && w.model === 3);

  ({ w, deps } = world(['refuse']));
  r = await L.runLoop(lim(), empty, deps);
  ok('refused: counts toward the steps (8) but not the queries (0), and runs no engine query', r.end === 'steps' && r.state.queriesUsed === 0 && w.computed === 0 && r.state.steps.every((s) => s.status === 'refused' && s.reason === 'nope'));

  ({ w, deps } = world(['refuse', 'refuse', 'act']));
  r = await L.runLoop(lim({ queries: 2 }), empty, deps);
  ok('refused: a refusal does not use a query, so 2 queries still run after 2 refusals', r.end === 'queries' && r.state.queriesUsed === 2 && r.state.steps.filter((s) => s.status === 'refused').length === 2);

  ({ w, deps } = world(['act', 'act', 'done']));
  r = await L.runLoop(lim(), empty, deps);
  ok('done: ends the loop; it was a model call, so 3 steps used, 2 queries', r.end === 'done' && r.state.stepsUsed === 3 && r.state.queriesUsed === 2 && r.state.steps.length === 2);

  ({ w, deps } = world(['act', 'act']));
  deps.compute = async () => { w.computed += 1; if (w.computed === 1) w.stop = true; return good; };
  r = await L.runLoop(lim(), empty, deps);
  ok('stop: the step running finishes first, and no model call follows the flag', r.end === 'stopped' && w.computed === 1 && w.model === 1 && r.state.steps.length === 1, JSON.stringify([r.end, w.model, w.computed]));

  ({ w, deps } = world(['act']));
  deps.decide = async () => { w.model += 1; w.stop = true; return { ok: true, action: answer }; };
  r = await L.runLoop(lim(), empty, deps);
  ok('stop: a flag raised during the model call stops BEFORE the step it chose runs', r.end === 'stopped' && w.computed === 0);

  ({ w, deps } = world(['act']));
  deps.compute = async () => { w.computed += 1; w.clock = 600_001; return good; };
  r = await L.runLoop(lim(), empty, deps);
  ok('deadline: past the allowance no further model call is made', r.end === 'deadline' && w.model === 1 && w.computed === 1);
  ({ w, deps } = world(['act']));
  w.clock = 600_000;
  r = await L.runLoop(lim(), empty, deps);
  ok('deadline (negative control): the clock before the deadline runs, at it does not', r.end === 'deadline' && w.model === 0);
  ({ w, deps } = world(['done']));
  w.clock = 599_999;
  ok('deadline (negative control): one ms earlier it runs', (await L.runLoop(lim(), empty, deps)).end === 'done');

  ({ w, deps } = world(['act']));
  w.denied = true;
  r = await L.runLoop(lim(), empty, deps);
  ok('access: a starter who may no longer write stops the run before any call', r.end === 'access' && w.model === 0);
  ({ w, deps } = world(['act']));
  deps.compute = async () => { w.computed += 1; w.denied = true; return good; };
  r = await L.runLoop(lim(), empty, deps);
  ok('access: re-read before every step: one step, then the stop', r.end === 'access' && w.computed === 1);

  ({ w, deps } = world(['act']));
  w.lost = true;
  r = await L.runLoop(lim(), empty, deps);
  ok('lease lost: stops at once, nothing run, nothing saved', r.end === 'lost' && w.model === 0 && w.saved === 0);

  ({ w, deps } = world(['act', 'model']));
  r = await L.runLoop(lim(), empty, deps);
  ok('model error: ends the loop with "model", the steps so far kept', r.end === 'model' && r.state.steps.length === 1);

  // Resume: continues from the stored steps; none is run again; the counts stay.
  ({ w, deps } = world(['act', 'done']));
  const stored = { steps: [{ n: 1, kind: 'answer' as const, title: 'T', status: 'done' as const, spec: { a: 1 } }, { n: 2, kind: 'answer' as const, title: 'T', status: 'failed' as const, reason: 'x' }], stepsUsed: 2, queriesUsed: 2 };
  r = await L.runLoop(lim(), stored, deps);
  ok('resume: step 3 is the next, the first two are untouched and not computed again', r.state.steps.length === 3 && r.state.steps[0] === stored.steps[0] && w.computed === 1 && r.state.steps[2].n === 3 && r.end === 'done');
  ({ w, deps } = world(['act']));
  r = await L.runLoop(lim(), { ...stored, stepsUsed: 8 }, deps);
  ok('resume: the counts stay: a run already at its step limit makes no new call', r.end === 'steps' && w.model === 0);
  finish();
})().catch((e) => { console.error(e); process.exitCode = 1; finish(); });
