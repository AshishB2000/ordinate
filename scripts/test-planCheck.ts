// The Assistant's PLAN — its shape whitelist (src/ai/planSteps.ts), the 'plan'
// action in the chat contract (src/ai/suggestedAction.ts), and what each step
// MEANS (src/ai/planCheck.ts): every step judged by the validator its single
// action uses, with FORWARD REFERENCES — a later step naming what an earlier
// one creates — resolved, deferred behind an import, or refused.
//
//   npm run build:ts && node scripts/test-planCheck.js

export {};
import { ok, finish } from './selfcheck';

const os: typeof import('os') = require('os');
const Module: any = require('module');

// dashboards.ts (the style presets) pulls in visuals.ts → electron. Nothing here
// touches a store; the stub only lets the pure validators load.
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() }, ipcMain: { handle: () => undefined }, net: {}, safeStorage: { isEncryptionAvailable: () => false } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const ps: typeof import('../src/ai/planSteps') = require('../src/ai/planSteps');
const pc: typeof import('../src/ai/planCheck') = require('../src/ai/planCheck');
const sa: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');

type PlanCtx = import('../src/ai/planCheck').PlanCtx;

const SALES = '11111111-1111-4111-8111-111111111111';
const OLD_SALES = '22222222-2222-4222-8222-222222222222';
const VIS = '33333333-3333-4333-8333-333333333333';
const MET = '44444444-4444-4444-8444-444444444444';
const DASH = '55555555-5555-4555-8555-555555555555';

function ctx(): PlanCtx {
  return {
    datasets: [{
      id: SALES, name: 'Orders', rowCount: 10,
      columns: [{ name: 'Region', type: 'text' }, { name: 'Sales', type: 'number' }, { name: 'Cost', type: 'number' }, { name: 'Zip', type: 'text' }],
    }],
    visuals: [{ id: VIS, name: 'Sales by region', datasetId: SALES, chartType: 'bar' }],
    metrics: [{ id: MET, name: 'Total sales', datasetId: SALES, column: 'Sales', aggregation: 'sum' }],
    dashboards: [{ id: DASH, name: 'Overview' }],
  };
}
const steps = (raw: unknown[]) => ps.sanitizePlanSteps(raw).steps;

// ── Shape ────────────────────────────────────────────────────────────────────
{
  const { steps: s, dropped } = ps.sanitizePlanSteps([
    { kind: 'import', file: '/Users/x/secret/sales.csv', name: 'Sales' },
    { kind: 'banana' }, 'x', null,
    { kind: 'alert', metric: 'M', op: '>', value: '10' },
  ]);
  ok('shape: unknown kinds and non-objects are dropped and COUNTED', s.length === 2 && dropped === 3, JSON.stringify({ s, dropped }));
  ok('shape: an import carries a file NAME, never a path', s[0].kind === 'import' && (s[0] as any).file === 'sales.csv');
  ok('shape: a non-number alert value is null, never coerced', s[1].kind === 'alert' && (s[1] as any).value === null);
  const many = ps.sanitizePlanSteps(Array.from({ length: 20 }, () => ({ kind: 'style', preset: 'dark' })));
  ok('shape: at most MAX_PLAN_STEPS steps, the rest counted as dropped',
    many.steps.length === ps.MAX_PLAN_STEPS && many.dropped === 20 - ps.MAX_PLAN_STEPS);
  const big = ps.sanitizePlanSteps([{ kind: 'chart', dataset: 'd', name: 'n', encoding: { category: 'x'.repeat(5000) } }]);
  ok('shape: an oversized encoding is emptied, not trusted', JSON.stringify((big.steps[0] as any).encoding) === '{}');
}

// ── The action contract ─────────────────────────────────────────────────────
{
  const line = '@@ACTION {"kind":"plan","intent":"import and build","steps":[{"kind":"import","file":"sales.csv","name":"Sales"},{"kind":"style","dashboard":"D","preset":"dark"}]}';
  const { text, action } = sa.splitAction('I will import the file and build it.\n' + line);
  ok('contract: a plan line is split off the prose', text === 'I will import the file and build it.', text);
  ok('contract: the plan action carries its sanitized steps',
    action.kind === 'plan' && Array.isArray(action.steps) && action.steps.length === 2 && action.intent === 'import and build');
  ok('contract: a plan with no usable step is no action', sa.validateAction({ kind: 'plan', intent: 'x', steps: [{ kind: 'nope' }] }).kind === 'none');
  ok('contract: a plan with no steps field is no action', sa.validateAction({ kind: 'plan', intent: 'x' }).kind === 'none');
  const huge = Array.from({ length: 12 }, () => ({ kind: 'calc', dataset: 'd', name: 'n', expression: 'x'.repeat(1500) }));
  ok('contract: a plan over MAX_PLAN_CHARS is refused whole', sa.validateAction({ kind: 'plan', intent: 'x', steps: huge }).kind === 'none');
  ok('contract: steps never ride on another kind', sa.validateAction({ kind: 'dashboard', intent: 'x', steps: [{ kind: 'import', file: 'a.csv' }] }).steps === undefined);
  ok('contract: the chat prompt names the plan kind and every step kind',
    /plan, none/.test(sa.CHAT_SYSTEM_PROMPT) && ps.PLAN_STEP_KINDS.every((k) => sa.CHAT_SYSTEM_PROMPT.indexOf('"kind":"' + k + '"') >= 0));
}

// ── Each kind, against the validator its single action uses ────────────────
{
  const c = (raw: unknown) => pc.checkPlan(steps([raw]), ctx())[0];
  ok('step: a filter on a real column passes', c({ kind: 'step', dataset: 'Orders', step: { type: 'filter', column: 'Region', op: '=', value: 'West' } }).ok);
  const badCol = c({ kind: 'step', dataset: 'Orders', step: { type: 'filter', column: 'Nope', op: '=', value: 'x' } });
  ok('step: an unknown column fails with the PIPELINE\'s own warning', !badCol.ok && /unknown column "Nope"/.test(String(badCol.error)), badCol.error);
  ok('step: an unknown step type fails', !c({ kind: 'step', dataset: 'Orders', step: { type: 'explode' } }).ok);
  ok('step: an unknown dataset fails, naming it', /No dataset called "Nope"/.test(String(c({ kind: 'step', dataset: 'Nope', step: { type: 'trim' } }).error)));
  const badFormula = c({ kind: 'calc', dataset: 'Orders', name: 'M', expression: '[Sales] * * 2' });
  ok('calc: a formula that does not compile fails with the compiler\'s error', !badFormula.ok && /did not compile/.test(String(badFormula.error)));
  ok('calc: an existing column name is refused', !c({ kind: 'calc', dataset: 'Orders', name: 'Sales', expression: '[Cost]' }).ok);
  ok('calc: a formula over an unknown column fails', !c({ kind: 'calc', dataset: 'Orders', name: 'M', expression: '[Nope] * 2' }).ok);
  ok('metric: sum of a number column passes', c({ kind: 'metric', dataset: 'Orders', name: 'Cost total', column: 'Cost', aggregation: 'sum' }).ok);
  const textSum = c({ kind: 'metric', dataset: 'Orders', name: 'Z', column: 'Zip', aggregation: 'sum' });
  ok('metric: sum of a TEXT column fails (validatePlan\'s KPI rule — "007" is not 7)', !textSum.ok && /needs a number column/.test(String(textSum.error)), textSum.error);
  ok('metric: a duplicate metric name is refused', !c({ kind: 'metric', dataset: 'Orders', name: 'total SALES', column: 'Cost', aggregation: 'sum' }).ok);
  ok('chart: a drawable chart passes', c({ kind: 'chart', dataset: 'Orders', name: 'C', chartType: 'bar', encoding: { category: 'Region', values: [{ column: 'Sales', aggregation: 'sum' }] } }).ok);
  const badType = c({ kind: 'chart', dataset: 'Orders', name: 'C', chartType: 'hologram', encoding: { category: 'Region', values: [{ column: 'Sales', aggregation: 'sum' }] } });
  ok('chart: an invented chart type fails (the closed vocabulary)', !badType.ok && /chart type/.test(String(badType.error)), badType.error);
  ok('dashboard: existing visual + metric pass', c({ kind: 'dashboard', name: 'D', visuals: ['Sales by region'], metrics: ['Total sales'] }).ok);
  ok('dashboard: an empty dashboard fails', !c({ kind: 'dashboard', name: 'D', visuals: [], metrics: [] }).ok);
  ok('dashboard: an unknown visual fails', /No visual called "Ghost"/.test(String(c({ kind: 'dashboard', name: 'D', visuals: ['Ghost'] }).error)));
  ok('style: a preset on a named dashboard passes', c({ kind: 'style', dashboard: 'Overview', preset: 'dark' }).ok);
  ok('style: an invented preset fails', !c({ kind: 'style', dashboard: 'Overview', preset: 'neon' }).ok);
  ok('style: no dashboard named and none created by the plan fails', !c({ kind: 'style', preset: 'dark' }).ok);
  ok('alert: a threshold on a metric passes', c({ kind: 'alert', metric: 'Total sales', op: '>', value: 100 }).ok);
  ok('alert: no number fails (the model never invents one)', /needs the number/.test(String(c({ kind: 'alert', metric: 'Total sales', op: '>' }).error)));
  ok('alert: an unknown comparison fails', !c({ kind: 'alert', metric: 'Total sales', op: '=~', value: 1 }).ok);
  ok('import: a non-data file is refused', !c({ kind: 'import', file: 'notes.pdf' }).ok);
}

// ── Forward references ──────────────────────────────────────────────────────
{
  // The whole request: import, clean, calculate, measure, chart, assemble, style, alert.
  const plan = steps([
    { kind: 'import', file: 'sales.csv', name: 'Sales' },
    { kind: 'step', dataset: 'Sales', step: { type: 'dedupe', columns: ['Order'] } },
    { kind: 'calc', dataset: 'Sales', name: 'Margin', expression: '[Sales] - [Cost]' },
    { kind: 'metric', dataset: 'Sales', name: 'Revenue', column: 'Sales', aggregation: 'sum' },
    { kind: 'chart', dataset: 'Sales', name: 'Revenue by region', chartType: 'bar', encoding: { category: 'Region', values: [{ column: 'Sales', aggregation: 'sum' }] } },
    { kind: 'dashboard', name: 'Regional', visuals: ['Revenue by region'], metrics: ['Revenue'] },
    { kind: 'style', preset: 'executive' },
    { kind: 'alert', metric: 'Revenue', op: '<', value: 1000 },
  ]);
  const checks = pc.checkPlan(plan, ctx());
  ok('forward: every step of the full request passes', checks.every((x) => x.ok), JSON.stringify(checks));
  ok('forward: steps over a not-yet-imported dataset are DEFERRED, and say which step imports it',
    [1, 2, 3, 4].every((i) => /imported by step 1/.test(String(checks[i].deferred))), JSON.stringify(checks));
  ok('forward: a dashboard naming a visual and a metric earlier steps create passes, with nothing deferred', checks[5].ok && !checks[5].deferred);
  ok('forward: style with no dashboard named takes the one the plan created', checks[6].ok);

  // Real columns: a calc column is nameable by the next step.
  const real = pc.checkPlan(steps([
    { kind: 'calc', dataset: 'Orders', name: 'Margin', expression: '[Sales] - [Cost]' },
    { kind: 'step', dataset: 'Orders', step: { type: 'filter', column: 'Margin', op: '>', value: 0 } },
    { kind: 'metric', dataset: 'Orders', name: 'Margin total', column: 'Margin', aggregation: 'sum' },
    { kind: 'step', dataset: 'Orders', step: { type: 'rename_column', from: 'Region', to: 'Area' } },
    { kind: 'chart', dataset: 'Orders', name: 'By area', chartType: 'bar', encoding: { category: 'Area', values: [{ column: 'Margin', aggregation: 'sum' }] } },
    { kind: 'step', dataset: 'Orders', step: { type: 'filter', column: 'Region', op: '=', value: 'x' } },
  ]), ctx());
  ok('forward: a calc column is filterable by the next step', real[0].ok && real[1].ok && !real[1].deferred, JSON.stringify(real));
  ok('forward: SUM of a calc column passes (its type is unknown until it runs — validatePlan\'s proposed-column rule)', real[2].ok, JSON.stringify(real[2]));
  ok('forward: a renamed column is chartable by its NEW name', real[3].ok && real[4].ok, JSON.stringify(real[4]));
  ok('forward: …and its OLD name is gone', !real[5].ok && /unknown column "Region"/.test(String(real[5].error)), JSON.stringify(real[5]));

  // A failed step creates nothing downstream.
  const broken = pc.checkPlan(steps([
    { kind: 'chart', dataset: 'Orders', name: 'Bad', chartType: 'hologram', encoding: { category: 'Region', values: [{ column: 'Sales', aggregation: 'sum' }] } },
    { kind: 'dashboard', name: 'D', visuals: ['Bad'] },
  ]), ctx());
  ok('forward: a step naming what a FAILED step would have made fails too', !broken[0].ok && !broken[1].ok && /No visual called "Bad"/.test(String(broken[1].error)));

  // Order matters: a reference to something made LATER is not a forward reference.
  const early = pc.checkPlan(steps([
    { kind: 'dashboard', name: 'D', visuals: ['Later'] },
    { kind: 'chart', dataset: 'Orders', name: 'Later', chartType: 'bar', encoding: { category: 'Region', values: [{ column: 'Sales', aggregation: 'sum' }] } },
  ]), ctx());
  ok('forward: naming something a LATER step makes fails', !early[0].ok && early[1].ok);
}

// ── Names: the run's own records win ────────────────────────────────────────
{
  const c = ctx();
  c.datasets.push({ id: OLD_SALES, name: 'Sales', rowCount: 3, columns: [{ name: 'Only', type: 'text' }] });
  const s = pc.checkPlan(steps([
    { kind: 'import', file: 'sales.csv', name: 'Sales' },
    { kind: 'step', dataset: 'Sales', step: { type: 'filter', column: 'Region', op: '=', value: 'W' } },
  ]), c);
  ok('names: after "import … as Sales", "Sales" is the NEW dataset, not an older namesake', s[1].ok && /imported by step 1/.test(String(s[1].deferred)), JSON.stringify(s));
  c.datasets.push({ id: '66666666-6666-4666-8666-666666666666', name: 'Sales', rowCount: 3, columns: [] });
  const amb = pc.resolveRef(c.datasets, 'Sales', 'dataset');
  ok('names: two datasets sharing a name is an error that says so, never a silent pick', !amb.hit && /2 datasets are called "Sales"/.test(String(amb.error)));
  ok('names: by id always resolves', pc.resolveRef(c.datasets, OLD_SALES, 'dataset').hit?.id === OLD_SALES);
  ok('names: case-insensitive when unique', pc.resolveRef(ctx().datasets, 'orders', 'dataset').hit?.id === SALES);
  ok('names: a virtual id is never a UUID (it can never reach a path)', !/^[0-9a-f-]{36}$/.test(pc.virtualId(3)));
}

// ── Facts for Fix: names and types, never a row ────────────────────────────
{
  const facts = pc.ctxFactsText(ctx());
  ok('facts: lists datasets with typed columns, visuals, metrics and dashboards',
    /"Orders": Region \(text\), Sales \(number\)/.test(facts) && /"Sales by region"/.test(facts) && /"Total sales"/.test(facts) && /"Overview"/.test(facts), facts);
}

finish();
