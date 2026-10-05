// Running an Assistant plan (src/ai/planRun.ts) against a FAKE project: step
// order, the re-check right before a step runs, failure semantics (stop, Fix,
// Skip, Stop), and the undo grouping — one group per record touched, created
// records to the Trash, changed ones back to their state before the run's FIRST
// change, newest first. No disk, no model: the executors are injected.
//
//   npm run build:ts && node scripts/test-planRun.js

export {};
import { ok, finish } from './selfcheck';

const os: typeof import('os') = require('os');
process.env.ORDINATE_LOCAL_DIR = os.tmpdir();

const ps: typeof import('../src/ai/planSteps') = require('../src/ai/planSteps');
const pr: typeof import('../src/ai/planRun') = require('../src/ai/planRun');

type PlanCtx = import('../src/ai/planCheck').PlanCtx;
type PlanRun = import('../src/ai/planRun').PlanRun;
type StepOutcome = import('../src/ai/planRun').StepOutcome;
type PlanStep = import('../src/ai/planSteps').PlanStep;

// ── A fake project the executors write to ───────────────────────────────────
const FILES: Record<string, Array<{ name: string; type: 'text' | 'number' | 'date' }>> = {
  'sales.csv': [{ name: 'Region', type: 'text' }, { name: 'Sales', type: 'number' }, { name: 'Cost', type: 'number' }],
  'thin.csv': [{ name: 'Region', type: 'text' }],
};

interface Fake { db: PlanCtx; seq: number; executed: string[]; failOn: Set<string>; throwOn: Set<string>; file: string }

function fake(file = 'sales.csv'): Fake {
  return {
    db: {
      datasets: [], visuals: [], metrics: [],
      dashboards: [{ id: 'dash-existing', name: 'Existing' }],
    },
    seq: 0, executed: [], failOn: new Set(), throwOn: new Set(), file,
  };
}

function deps(f: Fake) {
  return {
    loadCtx: async (run: PlanRun): Promise<PlanCtx> => {
      const own = new Set(run.touches.filter((t) => t.created).map((t) => t.type + ':' + t.id));
      const c: PlanCtx = JSON.parse(JSON.stringify(f.db));
      c.datasets.forEach((d) => { d.fromRun = own.has('dataset:' + d.id); });
      c.visuals.forEach((v) => { v.fromRun = own.has('visual:' + v.id); });
      c.metrics.forEach((m) => { m.fromRun = own.has('metric:' + m.id); });
      c.dashboards.forEach((d) => { d.fromRun = own.has('dashboard:' + d.id); });
      return c;
    },
    execute: async (_run: PlanRun, step: PlanStep, index: number, ctx: PlanCtx): Promise<StepOutcome> => {
      f.executed.push(step.kind + '#' + index);
      if (f.throwOn.has(step.kind)) throw new Error('disk on fire');
      if (f.failOn.has(step.kind)) return { ok: false, error: 'The app said no to ' + step.kind + '.' };
      const id = step.kind + '-' + (++f.seq);
      const byName = (list: Array<{ id: string; name: string; fromRun?: boolean }>, n: string) =>
        list.filter((x) => x.name === n).sort((a, b) => Number(!!b.fromRun) - Number(!!a.fromRun))[0];
      switch (step.kind) {
        case 'import':
          f.db.datasets.push({ id, name: step.name, rowCount: 100, columns: FILES[f.file].map((c) => ({ ...c })) });
          return { ok: true, result: { summary: '100 rows', rowsAfter: 100, link: { type: 'dataset', id, name: step.name } }, touches: [{ type: 'dataset', id, name: step.name, created: true }] };
        case 'step':
        case 'calc': {
          const ds = byName(ctx.datasets, step.dataset);
          const real = f.db.datasets.find((d) => d.id === ds.id)!;
          const before = { steps: real.columns!.map((c) => c.name) };
          if (step.kind === 'calc') real.columns!.push({ name: step.name, type: 'number' });
          return { ok: true, result: { summary: '100 → 90 rows', rowsBefore: 100, rowsAfter: 90 }, touches: [{ type: 'dataset', id: ds.id, name: ds.name, created: false, before }] };
        }
        case 'metric': {
          const ds = byName(ctx.datasets, step.dataset);
          f.db.metrics.push({ id, name: step.name, datasetId: ds.id, column: step.column, aggregation: step.aggregation });
          return { ok: true, result: { summary: 'Revenue = $1,000', kpis: [{ name: step.name, display: '$1,000' }] }, touches: [{ type: 'metric', id, name: step.name, created: true }] };
        }
        case 'chart': {
          const ds = byName(ctx.datasets, step.dataset);
          f.db.visuals.push({ id, name: step.name, datasetId: ds.id, chartType: step.chartType });
          return { ok: true, result: { summary: 'bar chart' }, touches: [{ type: 'visual', id, name: step.name, created: true }] };
        }
        case 'dashboard':
          f.db.dashboards.push({ id, name: step.name });
          return { ok: true, result: { summary: '2 tiles' }, touches: [{ type: 'dashboard', id, name: step.name, created: true }] };
        case 'style': {
          const d = step.dashboard ? byName(ctx.dashboards, step.dashboard) : ctx.dashboards.filter((x) => x.fromRun).pop()!;
          return { ok: true, result: { summary: 'Styled' }, touches: [{ type: 'dashboard', id: d.id, name: d.name, created: false, before: { style: 'before-' + index } }] };
        }
        case 'alert':
          return { ok: true, result: { summary: 'Fires when' }, touches: [{ type: 'alert', id, name: 'A', created: true }] };
      }
      return { ok: false, error: 'unknown' };
    },
  };
}

const FULL = ps.sanitizePlanSteps([
  { kind: 'import', file: 'sales.csv', name: 'Sales' },
  { kind: 'step', dataset: 'Sales', step: { type: 'filter', column: 'Region', op: 'not_empty' } },
  { kind: 'calc', dataset: 'Sales', name: 'Margin', expression: '[Sales] - [Cost]' },
  { kind: 'metric', dataset: 'Sales', name: 'Revenue', column: 'Sales', aggregation: 'sum' },
  { kind: 'chart', dataset: 'Sales', name: 'By region', chartType: 'bar', encoding: { category: 'Region', values: [{ column: 'Margin', aggregation: 'sum' }] } },
  { kind: 'dashboard', name: 'Regional', visuals: ['By region'], metrics: ['Revenue'] },
  { kind: 'style', preset: 'dark' },
  { kind: 'alert', metric: 'Revenue', op: '<', value: 10 },
]).steps;

async function runAll(run: PlanRun, d: ReturnType<typeof deps>): Promise<void> {
  for (let guard = 0; guard < 50; guard++) {
    if ((await pr.runNext(run, d)) < 0 || run.state !== 'paused') return;
  }
}

void (async () => {
  // ── The happy path, in order ─────────────────────────────────────────────
  {
    const f = fake();
    const run = pr.newRun('r1', 'p', 't', 'build it', FULL);
    ok('start: every step pending, nothing executed', run.status.every((s) => s === 'pending') && run.state === 'ready');
    const first = await pr.runNext(run, deps(f));
    ok('step through: one click runs exactly step 1', first === 0 && run.status[0] === 'done' && run.status[1] === 'pending' && run.state === 'paused');
    await runAll(run, deps(f));
    ok('run all: every step done, in order', run.state === 'finished' && run.status.every((s) => s === 'done')
      && f.executed.join(',') === 'import#0,step#1,calc#2,metric#3,chart#4,dashboard#5,style#6,alert#7', f.executed.join(','));
    ok('run all: results carry the app\'s figures (rows before/after, KPI values)',
      run.results[1]!.rowsBefore === 100 && run.results[1]!.rowsAfter === 90 && run.results[3]!.kpis![0].display === '$1,000');
    ok('finished: running again does nothing', (await pr.runNext(run, deps(f))) === -1 && f.executed.length === 8);
    const log = pr.runLogText(run);
    ok('log: one line per step, marked, with the app-written summary',
      /^Plan run finished — 8 of 8 steps done\./.test(log) && /1\. ✓ Import sales\.csv as "Sales" — 100 rows/.test(log) && log.split('\n').length === 9, log);
  }

  // ── The re-check right before a step runs ────────────────────────────────
  {
    // The deferred steps meet the REAL columns once the import has run: this
    // file has no Sales column, so the metric is refused by the validator and
    // never reaches its executor.
    const f = fake('thin.csv');
    const run = pr.newRun('r2', 'p', 't', '', ps.sanitizePlanSteps([
      { kind: 'import', file: 'thin.csv', name: 'Sales' },
      { kind: 'metric', dataset: 'Sales', name: 'Revenue', column: 'Sales', aggregation: 'sum' },
      { kind: 'chart', dataset: 'Sales', name: 'C', chartType: 'bar', encoding: { category: 'Region', values: [{ column: 'Region', aggregation: 'count' }] } },
    ]).steps);
    await runAll(run, deps(f));
    ok('re-check: a deferred step is judged against the imported columns, and fails', run.status[0] === 'done' && run.status[1] === 'failed'
      && /"Sales" is not a column of "Sales"/.test(String(run.errors[1])), JSON.stringify(run.errors));
    ok('re-check: the refused step never reached its executor', f.executed.join(',') === 'import#0');
    ok('failure: the run STOPS on it — later steps stay pending', run.state === 'failed' && run.status[2] === 'pending');
    ok('failure: nothing can skip ahead of the failed step', !pr.skipStep(run, 2));

    // Fix: the step is replaced and runs again.
    const fixed = ps.sanitizePlanStep({ kind: 'metric', dataset: 'Sales', name: 'Regions', column: 'Region', aggregation: 'count' })!;
    ok('fix: a failed step can be replaced', pr.replaceStep(run, 1, fixed) && run.status[1] === 'pending' && run.state === 'paused' && run.errors[1] === null);
    await runAll(run, deps(f));
    ok('fix: the replaced step runs, and the rest follow', run.state === 'finished' && run.status.every((s) => s === 'done'));
    ok('fix: a DONE step cannot be replaced', !pr.replaceStep(run, 0, fixed));
  }

  // ── Executor failure, Skip, and a dependent that then fails ──────────────
  {
    const f = fake();
    f.failOn.add('chart');
    const run = pr.newRun('r3', 'p', 't', '', FULL);
    await runAll(run, deps(f));
    ok('failure: the executor\'s own error is kept verbatim', run.status[4] === 'failed' && run.errors[4] === 'The app said no to chart.');
    ok('skip: the failed step can be skipped', pr.skipStep(run, 4) && run.status[4] === 'skipped' && run.state === 'paused');
    await runAll(run, deps(f));
    ok('skip: a later step naming what the skipped one would have made fails on its own check',
      run.status[5] === 'failed' && /No visual called "By region"/.test(String(run.errors[5])), JSON.stringify(run.errors));
    ok('stop: the run ends and what ran stays', pr.stopRun(run) && run.state === 'stopped' && run.status[3] === 'done');
    ok('stop: nothing runs, skips or is replaced after a stop',
      (await pr.runNext(run, deps(f))) === -1 && !pr.skipStep(run, 5) && !pr.replaceStep(run, 5, FULL[5]));
    ok('log: a stopped run says so, with the failed and not-run steps',
      /^Plan run stopped — 4 of 8 steps done\./.test(pr.runLogText(run)) && /5\. – .* — skipped/.test(pr.runLogText(run)) && /7\. · .* — not run/.test(pr.runLogText(run)), pr.runLogText(run));
  }

  // ── An executor that throws, and partial writes ─────────────────────────
  {
    const f = fake();
    f.throwOn.add('import');
    const run = pr.newRun('r4', 'p', 't', '', FULL.slice(0, 2));
    await pr.runNext(run, deps(f));
    ok('throw: a thrown executor is a failed step with its message, never a crash', run.status[0] === 'failed' && run.errors[0] === 'disk on fire');
    const d = deps(f);
    const partial = {
      loadCtx: d.loadCtx,
      execute: async (): Promise<StepOutcome> => ({ ok: false, error: 'half done', touches: [{ type: 'dataset', id: 'x', name: 'X', created: true }] }),
    };
    await pr.runNext(run, partial);
    ok('partial: a step that failed part-way keeps its writes for the undo', run.touches.length === 1 && pr.canUndo(run));
  }

  // ── Undo: one group per record ──────────────────────────────────────────
  {
    const T = (type: any, id: string, created: boolean, before?: unknown) => ({ type, id, name: id, created, before });
    const groups = pr.undoGroups([
      T('dataset', 'ds', true),
      T('dataset', 'ds', false, { steps: 'after-import' }),
      T('dataset', 'ds', false, { steps: 'after-step' }),
      T('dataset', 'old', false, { steps: 'FIRST' }),
      T('dataset', 'old', false, { steps: 'second' }),
      T('visual', 'v', true),
      T('dashboard', 'd', true),
      T('dashboard', 'd', false, { style: 'x' }),
      T('dashboard', 'existing', false, { style: 'ORIGINAL' }),
      T('dashboard', 'existing', false, { style: 'after-1' }),
    ]);
    ok('undo: exactly one group per record touched', groups.length === 5, JSON.stringify(groups));
    ok('undo: newest record first (dashboard before its visual before its dataset)',
      groups.map((g) => g.id).join(',') === 'existing,d,v,old,ds', groups.map((g) => g.id).join(','));
    const by = (id: string) => groups.find((g) => g.id === id)!;
    ok('undo: a record the run created goes to the Trash, however often it was touched after',
      by('ds').action === 'trash' && by('d').action === 'trash' && by('v').action === 'trash' && by('ds').before === undefined);
    ok('undo: a changed record goes back to its state before the run\'s FIRST change',
      by('old').action === 'restore' && (by('old').before as any).steps === 'FIRST' && (by('existing').before as any).style === 'ORIGINAL');
    const late = pr.undoGroups([T('dataset', 'z', false, { steps: 'b' }), T('dataset', 'z', true)]);
    ok('undo: a record later found to be created by the run is trashed, not restored', late.length === 1 && late[0].action === 'trash' && late[0].before === undefined);

    // undoRun over a real run: every group executed once, failures reported, the rest still run.
    const f = fake();
    const run = pr.newRun('r5', 'p', 't', '', FULL);
    await runAll(run, deps(f));
    const calls: string[] = [];
    const report = await pr.undoRun(run, async (g) => {
      calls.push(g.action + ':' + g.type + ':' + g.id);
      return g.type === 'visual' ? { ok: false, error: 'locked' } : { ok: true };
    });
    ok('undo run: the dataset touched by import + prepare + calc is ONE group, trashed',
      calls.filter((c) => c.indexOf(':dataset:') >= 0).length === 1 && calls.some((c) => /^trash:dataset:/.test(c)), calls.join(' | '));
    ok('undo run: the dashboard created then styled is ONE group, trashed', calls.filter((c) => c.indexOf(':dashboard:') >= 0).length === 1);
    ok('undo run: a failing group is reported and the rest still undo', report.failed.length === 1 && report.failed[0].error === 'locked' && report.undone === calls.length - 1);
    ok('undo run: the run is over, and cannot be undone twice', run.state === 'undone' && !pr.canUndo(run)
      && (await pr.runNext(run, deps(f))) === -1);
    ok('log: an undone run says how many records were put back, and what could not be',
      /^Plan run undone — 4 records put back\./.test(pr.runLogText(run)) && /Could not undo: By region \(locked\)/.test(pr.runLogText(run)), pr.runLogText(run));

    // An existing dashboard restyled: restored, not trashed.
    const g = fake();
    const styleRun = pr.newRun('r6', 'p', 't', '', ps.sanitizePlanSteps([
      { kind: 'style', dashboard: 'Existing', preset: 'dark' },
      { kind: 'style', dashboard: 'Existing', preset: 'executive' },
    ]).steps);
    await runAll(styleRun, deps(g));
    const sg = pr.undoGroups(styleRun.touches);
    ok('undo: an existing dashboard styled twice is restored once, to before the FIRST style',
      sg.length === 1 && sg[0].action === 'restore' && (sg[0].before as any).style === 'before-0', JSON.stringify(sg));
  }

  finish();
})();
