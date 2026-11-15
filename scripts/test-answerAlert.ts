// "Alert me" on an Assistant answer (docs/assistant/00-design.md, step 8; src/ipc/answerAlert.ts,
// `alerts:fromAnswer`), over real HTTP in dev mode.
//
//   access      write, as alerts:save: a viewer is refused (control: the editor may; the viewer may
//               still draw the card)
//   prefill     the subject is the answer's one measure under its filters — a relative period kept
//               as a period — and the figure the rule reads now is Object.is the by-hand dialog's
//               (`dashboard:metric` on the same fields), the answer's own total, and alerts:test's
//   same rule   alerts:save of the prefilled rule stores what alerts:save of the same fields typed by
//               hand stores (all but the id)
//   suggest     a tenth under the figure, two significant figures; a tenth further below a negative
//               one; none without a figure
//   refused     two measures, a calculation, a top-N, a period in an earlier year, an unreadable spec:
//               each its own sentence, and nothing saved (control: the plain answer passes)
//
//   npm run build:ts && node scripts/test-answerAlert.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-answeralert-'));
process.env.ORDINATE_TODAY = '2025-01-15'; // "last quarter" is 2024-Q4
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const api: typeof import('../src/api/index') = require('../src/api/index');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const say: typeof import('../src/analysis/answerAlertMessages') = require('../src/analysis/answerAlertMessages');
const { suggestThreshold }: typeof import('../src/ipc/answerAlert') = require('../src/ipc/answerAlert');

type Identity = import('../src/server/context').Identity;
type Cell = import('../src/data/transforms').Cell;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };
const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);

const ROWS: Cell[][] = [
  ['2024-10-02', 'West', 1200], ['2024-11-15', 'East', 900], ['2024-12-20', 'East', 450], ['2024-12-05', 'West', 50],
  ['2024-11-03', 'North', 2400], ['2023-11-03', 'West', 999], ['2024-06-03', 'South', 77],
];

(async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Alert from an answer')).id;
    const ds = await datasets.saveDataset(projectId, {
      name: 'Orders', sourceKind: 'csv', rows: ROWS,
      columns: [{ name: 'order_date', type: 'date' }, { name: 'region', type: 'text' }, { name: 'net_sales', type: 'number' }],
    });
    if (!ds) throw new Error('fixture not saved');
    return { projectId, datasetId: ds.id };
  });
  const P = seed.projectId;
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const post = async (channel: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    return { status: r.statusCode, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: each reply is narrowed by the check that reads it
  };
  const rules = async (): Promise<any[]> => (await post('alerts:list', { projectId: P })).value.rules.filter((r: { fromWatch?: boolean }) => !r.fromWatch); // any: a stored rule

  const SPEC = {
    datasetId: seed.datasetId, category: 'region', measures: [{ column: 'net_sales', aggregation: 'sum' }], chartType: 'column', title: 'Sales by region',
    filters: [{ column: 'order_date', period: 'last_quarter' }, { column: 'region', op: '!=', value: 'North' }],
  };

  // ── access ────────────────────────────────────────────────────────────────
  const input = { projectId: P, spec: SPEC };
  const contract = api.contracts['alerts:fromAnswer'];
  ok('contract: write, as alerts:save, project-scoped by projectId', contract.access === 'write' && api.contracts['alerts:save'].access === 'write' && 'project' in contract && contract.project(input) === P);
  ok('contract: a strict input — a spec without a dataset id, or anything beside the spec, is refused',
    contract.input.safeParse(input).success && !contract.input.safeParse({ projectId: P, spec: { category: 'region' } }).success && !contract.input.safeParse({ ...input, rule: {} }).success);
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: Identity, channel: string, rank: number) =>
    context.runInContext(who, 'authz', () => authz.authorize(api.contracts[channel as 'alerts:fromAnswer'], input, who, grants(rank)));
  ok('access: a project VIEWER may not ask for an alert from an answer', !(await decide(VIEWER, 'alerts:fromAnswer', 1)).ok);
  ok('access NEGATIVE CONTROL: the same viewer may draw the answer card', (await decide(VIEWER, 'answer:card', 1)).ok);
  ok('access: a project editor may', (await decide(EDITOR, 'alerts:fromAnswer', 2)).ok);

  // ── prefill ───────────────────────────────────────────────────────────────
  const r = await post('alerts:fromAnswer', input);
  const d = r.value;
  ok('prefill: ok, with the answer\'s measure and dataset', r.status === 200 && d.ok === true && d.subject.datasetId === seed.datasetId && d.subject.column === 'net_sales' && d.subject.aggregation === 'sum', show(d));
  const period = d.subject?.filters?.find((f: { op: string }) => f.op === 'period');
  ok('prefill: a relative period stays a period, so the alert moves with the clock', period && period.column === 'order_date' && period.period.preset === 'last_quarter', show(d.subject?.filters));
  ok('prefill: a comparison filter is kept as it is', d.subject?.filters?.some((f: { op: string; value?: unknown; column: string }) => f.op === '!=' && f.column === 'region' && f.value === 'North'));
  ok('prefill: the category is not a filter — it says the number covers every region', d.subject?.filters?.length === 2 && d.scope === say.alertAcross('region'), d.scope);
  const byHand = await post('dashboard:metric', { projectId: P, datasetId: seed.datasetId, column: 'net_sales', aggregation: 'sum', filters: d.subject.filters });
  ok('prefill: its figure is Object.is the by-hand dialog\'s (dashboard:metric on the same fields)', byHand.value.ok && Object.is(d.value, byHand.value.value), show([d.value, byHand.value]));
  const card = (await post('answer:card', input)).value;
  const total = (card.data.series[0].values as number[]).reduce((a, b) => a + b, 0);
  ok('prefill: …and the answer\'s own total (whole numbers: the sum is exact)', card.ok && Object.is(d.value, total) && d.value === 1200 + 900 + 450 + 50, show([d.value, total]));
  ok('prefill: the threshold to start from is the server\'s', JSON.stringify(d.suggest) === JSON.stringify(suggestThreshold(d.value)) && d.suggest.op === '<' && d.suggest.value === 2300, show(d.suggest));

  // ── same rule ─────────────────────────────────────────────────────────────
  const prefilled = { id: '11111111-1111-4111-8111-111111111111', name: 'Sales falls below 2300', datasetId: d.subject.datasetId,
    metric: { column: d.subject.column, aggregation: d.subject.aggregation, filters: d.subject.filters }, compare: 'threshold', threshold: d.suggest, enabled: true };
  const typed = { id: '22222222-2222-4222-8222-222222222222', name: 'Sales falls below 2300', datasetId: seed.datasetId,
    metric: { column: 'net_sales', aggregation: 'sum', filters: [{ type: 'filter', column: 'order_date', op: 'period', period: { preset: 'last_quarter' } }, { type: 'filter', column: 'region', op: '!=', value: 'North' }] },
    compare: 'threshold', threshold: { op: '<', value: 2300 }, enabled: true };
  const tests = [await post('alerts:test', { projectId: P, rule: prefilled }), await post('alerts:test', { projectId: P, rule: typed })];
  ok('same rule: alerts:test reads the prefill\'s figure on both — the prefilled rule and the one typed by hand', tests.every((t) => t.value.ok && Object.is(t.value.value, d.value)), show(tests.map((t) => t.value)));
  const saved = [await post('alerts:save', { projectId: P, rule: prefilled }), await post('alerts:save', { projectId: P, rule: typed })];
  const strip = (x: Record<string, unknown>) => JSON.stringify({ ...x, id: undefined });
  ok('same rule: alerts:save stores the prefilled rule as it stores the one typed by hand (all but the id)', saved.every((s) => s.value.ok) && strip(saved[0].value.rule) === strip(saved[1].value.rule), show(saved.map((s) => s.value)));

  // ── suggest ───────────────────────────────────────────────────────────────
  ok('suggest: a tenth under the figure, to two significant figures', suggestThreshold(1_234_567)?.value === 1_100_000 && suggestThreshold(87)?.value === 78 && suggestThreshold(0.4567)?.value === 0.41);
  ok('suggest: a tenth further below a negative figure, never above it', suggestThreshold(-100)?.value === -110);
  ok('suggest: none without a figure', suggestThreshold(null) === null && suggestThreshold(Number.NaN) === null && suggestThreshold(0)?.value === 0);

  // ── refused ───────────────────────────────────────────────────────────────
  const before = (await rules()).length;
  const refused = async (label: string, spec: unknown, reason: string) => {
    const x = await post('alerts:fromAnswer', { projectId: P, spec });
    ok(`refused: ${label}, with its reason`, x.status === 200 && x.value.ok === false && x.value.reason === reason, show(x.value));
  };
  await refused('two measures', { ...SPEC, measures: [{ column: 'net_sales', aggregation: 'sum' }, { column: 'net_sales', aggregation: 'avg' }] }, say.alertOneMeasure(2));
  await refused('a calculation', { ...SPEC, measures: [{ column: 'net_sales', aggregation: 'sum', calc: { kind: 'running_total' } }] }, say.alertNoCalc());
  await refused('a top-N', { ...SPEC, top: 3 }, say.alertNoTop());
  await refused('a period in an earlier year', { ...SPEC, filters: [{ column: 'order_date', period: 'last_quarter', yearsBack: 1 }] }, say.alertNoYearsBack());
  await refused('a spec that does not read', { datasetId: seed.datasetId, category: '', measures: [] }, say.alertAnswerUnreadable());
  ok('refused: nothing was saved', (await rules()).length === before);
  ok('refused NEGATIVE CONTROL: the plain answer passes', (await post('alerts:fromAnswer', input)).value.ok === true);

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
