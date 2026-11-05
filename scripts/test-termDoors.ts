// Every figure entry refuses a filter step it cannot apply (semantic layer, PR 05a) — over the real
// RPC route, in server mode, on an extract dataset and a Live one over the fake warehouse
// (scripts/liveFakeConnector.ts), as scripts/test-liveSafetyNet.ts sets them up.
//
// A glossary `term` step, a malformed one, or a step a newer release writes is kept in the record
// (src/data/filterList.ts). A door that reaches an engine without applying it would draw a WIDER
// figure; one that let the row lock see it would drop it (rowAccess.withLockSteps). So:
//
//   § doors     each entry (charts, the batch, KPIs, metric values, tiles, answers, the rows behind a
//               mark, statistics, drivers, scenarios, an alert's test) refuses: 409 `term`, or the item
//               `{ok:false, code:'term'}`, with the catalog's sentence — never a figure. The same
//               request without the step answers (negative control).
//   § kept      a future step and a malformed term refuse alike; a saved visual holding one refuses
//               when drawn; a scenario driver aimed through one refuses; an alert's raw Prepare step
//               (it used to run) refuses; a KPI tile whose metric refused says why, never "deleted"
//   § lock      the refusal comes before the row lock: the lock is never asked for (a spy on it)
//   § route     a thrown refusal is 409 with its code, reason and sentence; one a handler caught is
//               typed by the route; the request fold (applyPipelineAsync) rejects a term
//
//   npm run build:ts && node scripts/test-termDoors.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-termdoors-'));

const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const termStep: typeof import('../src/data/termStep') = require('../src/data/termStep');
const termMsgs: typeof import('../src/data/termMessages') = require('../src/data/termMessages');
const termExpand: typeof import('../src/analysis/termExpand') = require('../src/analysis/termExpand');
const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');

type Cell = import('../src/data/transforms').Cell;
type FilterStep = import('../src/data/transforms').FilterStep;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };

const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'sales', type: 'number' },
  { name: 'day', type: 'date' },
  { name: 'customer', type: 'text' },
  { name: 'qty', type: 'number' },
];
const ROWS: Cell[][] = Array.from({ length: 120 }, (_, i) => [
  `r${i % 5}`, (i * 37) % 101, `2024-0${1 + (i % 9)}-1${i % 9}`, `c${i % 17}`, (i * 7) % 13,
]);

const U = '7d2c1f4e-1111-4222-8333-444455556666';
const F0 = { type: 'filter', column: 'qty', op: '>', value: 0 };
const TERM = { type: 'term', term: U };
const FUTURE = { type: 'future_x', a: 1, nested: { b: [2] } };
const ANSWER_F0 = { column: 'qty', op: '>', value: 0 };

(async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  fakeMod.registerLiveFake();
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Term doors')).id;
    const extract = await datasets.saveDataset(projectId, { name: 'Orders copy', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
    await fakeMod.loadWarehouseTable('term_doors_orders', COLUMNS, ROWS);
    const conn = await connections.saveConnection(projectId, { name: 'Fake warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
    const live = conn && await liveRecord.saveLiveRecord(projectId, {
      name: 'Orders live', columns: COLUMNS, origin: { kind: 'connection', connId: conn.id, table: 'term_doors_orders' },
    });
    if (!extract || !live) throw new Error('fixture not saved');
    return { projectId, extract: extract.id, live: live.id };
  });
  const P = seed.projectId;
  duck.forbidSyncOnMainThread();

  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  type Reply = { status: number; text: string; value: any }; // any: each channel's own reply
  const post = async (channel: string, payload: unknown): Promise<Reply> => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }),
      payload: wire.encode({ args: [payload] }),
    });
    let value: unknown = null;
    try {
      value = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body);
    } catch {
      value = null;
    }
    return { status: r.statusCode, text: r.body, value };
  };
  const SENTENCE = termMsgs.termUnreadable();
  const items = (v: unknown): any[] => (Array.isArray(v) ? v : [v]); // any: a reply's items
  /** HTTP 409 `term`, or an item `{ok:false, code:'term'}`. */
  const refusedTerm = (r: Reply): boolean =>
    (r.status === 409 && r.value?.code === termStep.TERM_CODE) || (r.status === 200 && items(r.value).some((o) => o && o.ok === false && o.code === termStep.TERM_CODE));
  /** Any item of a 200 that answered. */
  const hasFigure = (r: Reply): boolean => r.status === 200 && items(r.value).some((o) => o && o.ok !== false);
  const refusedWithSentence = (r: Reply): boolean => refusedTerm(r) && r.text.includes(SENTENCE) && !hasFigure(r);

  // The records the doors name: a metric on each dataset; on the extract, a scenario over it, and one whose driver is aimed through a term.
  const metricOn = async (datasetId: string): Promise<string> => {
    const m = await post('metric:save', { projectId: P, input: { name: `Sales ${datasetId.slice(0, 4)}`, datasetId, definition: { column: 'sales', aggregation: 'sum' } } });
    return String(m.value?.metric?.id ?? m.value?.id ?? '');
  };
  type Ds = { mode: 'extract' | 'live'; id: string; metricId: string };
  const EXTRACT: Ds = { mode: 'extract', id: seed.extract, metricId: await metricOn(seed.extract) };
  const LIVE: Ds = { mode: 'live', id: seed.live, metricId: await metricOn(seed.live) };
  const scenarioWith = async (target: object): Promise<string> => {
    const s = await post('scenario:create', { projectId: P, input: { name: 'What if', baseMetricIds: [EXTRACT.metricId], drivers: [{ kind: 'pct', value: 10, target }] } });
    return String(s.value?.scenario?.id ?? '');
  };
  const SCENARIO = await scenarioWith({ column: 'sales' });
  const TERM_SCENARIO = await scenarioWith({ column: 'sales', filter: TERM });
  ok('fixtures: a metric on each dataset, and two scenarios', [EXTRACT.metricId, LIVE.metricId, SCENARIO, TERM_SCENARIO].every((x) => /^[0-9a-f-]{36}$/.test(x)));

  const enc = { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] };
  const stats = (d: Ds) => ({ kind: 'distribution', datasetId: d.id, columns: ['sales'] });
  const tiles = (d: Ds, f: unknown[]) => [
    { kind: 'visual', datasetId: d.id, encoding: enc, filters: f },
    { kind: 'metric', datasetId: d.id, column: '', aggregation: 'sum', metricId: d.metricId, filters: f }, // a KPI with a metric and no column
    { kind: 'stats', spec: stats(d), filters: f },
  ];
  const rule = (d: Ds, f: unknown[]) => ({ datasetId: d.id, metric: { column: 'sales', aggregation: 'sum', filters: f }, compare: 'threshold', threshold: { op: '>', value: 10 } });
  const fl = (t: boolean): unknown[] => (t ? [F0, TERM] : [F0]);
  const tile = (it: object) => ({ projectId: P, items: [it] });
  /**
   * [label, channel, body (with the term or without), also on the Live dataset]. `metric:value`, `stats:tile` and
   * `scenario:card` have no route of their own: a dashboard's tiles reach them (analysis:tiles), so they are asked
   * there. The four extract-only ones already refuse Live with `live_dataset`.
   */
  const ENTRIES: Array<[string, string, (d: Ds, t: boolean) => object, boolean]> = [
    ['visual:data', 'visual:data', (d, t) => ({ projectId: P, datasetId: d.id, encoding: enc, filters: fl(t) }), true],
    ['visual:dataBatch', 'visual:dataBatch', (d, t) => ({ projectId: P, items: [{ datasetId: d.id, encoding: enc, filters: fl(t) }] }), true],
    ['dashboard:metric', 'dashboard:metric', (d, t) => ({ projectId: P, datasetId: d.id, column: 'sales', aggregation: 'sum', filters: fl(t) }), true],
    ['metric:value (a KPI tile)', 'analysis:tiles', (d, t) => tile({ kind: 'metric', datasetId: d.id, column: '', aggregation: 'sum', metricId: d.metricId, filters: fl(t) }), true],
    ['metric:values', 'metric:values', (d, t) => ({ projectId: P, ids: [d.metricId], filters: fl(t) }), true],
    ['analysis:tiles', 'analysis:tiles', (d, t) => ({ projectId: P, items: tiles(d, fl(t)) }), true],
    ['answer:card', 'answer:card', (d, t) => ({ projectId: P, spec: { datasetId: d.id, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: t ? [ANSWER_F0, { term: U }] : [ANSWER_F0] } }), true],
    ['alerts:test', 'alerts:test', (d, t) => ({ projectId: P, rule: rule(d, fl(t)) }), true],
    ['visual:rows', 'visual:rows', (d, t) => ({ projectId: P, datasetId: d.id, encoding: enc, filters: fl(t), mark: { category: 'r1' } }), false],
    ['stats:tile (a statistics tile)', 'analysis:tiles', (d, t) => tile({ kind: 'stats', spec: stats(d), filters: fl(t) }), false],
    ['drivers:explain', 'drivers:explain', (d, t) => ({ projectId: P, request: { datasetId: d.id, metric: { column: 'sales', aggregation: 'sum' }, compare: { mode: 'latest', column: 'day' }, dimension: 'region', filters: fl(t) } }), false],
  ];

  // ── § doors ────────────────────────────────────────────────────────────────
  for (const [label, ch, body, liveToo] of ENTRIES) {
    for (const ds of liveToo ? [EXTRACT, LIVE] : [EXTRACT]) {
      const r = await post(ch, body(ds, true));
      ok(`${label} on ${ds.mode}: refused, typed, with the sentence — never a figure`, refusedWithSentence(r), `${r.status} ${r.text.slice(0, 300)}`);
      const plain = await post(ch, body(ds, false));
      ok(`NEGATIVE CONTROL: ${label} on ${ds.mode} without the term answers`, !refusedTerm(plain) && hasFigure(plain), `${plain.status} ${plain.text.slice(0, 300)}`);
    }
  }
  // scenario:card's own scope: a tile's KPI refuses first, so its handler is asked as a tile asks it.
  const scenarioCard = rpc.handlers.get('scenario:card')!;
  const scoped = (t: boolean) => context.runInContext(ADMIN, 'scenario', async () => (await scenarioCard(null, { projectId: P, scenarioId: SCENARIO, metricId: EXTRACT.metricId, filters: fl(t) })) as any); // any: the handler's reply
  const scen = await scoped(true);
  const scenPlain = await scoped(false);
  ok('scenario:card under a term in its scope: refused with the sentence — never a figure; NEGATIVE CONTROL: without it, a figure',
    scen?.ok === false && scen.error === SENTENCE && !('value' in scen) && scenPlain?.ok === true && typeof scenPlain.value === 'number', JSON.stringify({ scen, scenPlain }));

  // ── § kept ─────────────────────────────────────────────────────────────────
  for (const ds of [EXTRACT, LIVE]) {
    const tilesReply = await post('analysis:tiles', { projectId: P, items: tiles(ds, fl(true)) });
    const kpi = tilesReply.value?.[1];
    ok(`a KPI with no column whose metric:value refused says why, not "deleted" (${ds.mode})`, kpi?.code === 'term' && kpi.error === SENTENCE && !/was deleted/.test(String(kpi.error)), JSON.stringify(kpi));
    for (const [label, step] of [['a future step', FUTURE], ['a term with no id', { type: 'term' }], ['a term with a number id', { type: 'term', term: 5 }]] as const) {
      const chart = await post('visual:data', { projectId: P, datasetId: ds.id, encoding: enc, filters: [F0, step] });
      const card = await post('dashboard:metric', { projectId: P, datasetId: ds.id, column: 'sales', aggregation: 'sum', filters: [F0, step] });
      ok(`${label} refuses the chart and the KPI alike, unreadable (${ds.mode})`, refusedWithSentence(chart) && refusedWithSentence(card) && chart.value?.reason === 'unreadable' && card.value?.reason === 'unreadable',
        `${chart.text.slice(0, 200)} | ${card.text.slice(0, 200)}`);
    }
    // A visual saved holding a step this pod cannot read keeps it (saving is intended) and refuses when drawn.
    const saved = await post('visual:save', { projectId: P, datasetId: ds.id, name: 'Kept', chartType: 'bar', encoding: enc, filters: [F0, FUTURE] });
    const plainVis = await post('visual:save', { projectId: P, datasetId: ds.id, name: 'Plain', chartType: 'bar', encoding: enc, filters: [F0] });
    const idOf = (r: Reply): string => String(r.value?.visual?.id ?? r.value?.id ?? '');
    const thumbs = await post('visual:thumbs', { projectId: P, ids: [idOf(saved), idOf(plainVis)] });
    ok(`a saved visual with a kept step refuses when drawn; NEGATIVE CONTROL: its plain twin draws (${ds.mode})`,
      thumbs.status === 200 && thumbs.value?.[0]?.code === 'term' && thumbs.value[0].ok === false && thumbs.value?.[1]?.ok === true, thumbs.text.slice(0, 300));
  }
  const raw = await post('alerts:test', { projectId: P, rule: rule(EXTRACT, [{ type: 'calculated_field', name: 'x', expression: '1' }]) });
  ok('alerts:test refuses a raw calculated_field step (it used to run)', refusedWithSentence(raw), raw.text.slice(0, 300));
  const whatIf = (scenarioId: string) => post('analysis:tiles', tile({ kind: 'metric', datasetId: EXTRACT.id, column: 'sales', aggregation: 'sum', metricId: EXTRACT.metricId, scenarioId, filters: [F0] }));
  const aimed = (await whatIf(TERM_SCENARIO)).value?.[0];
  const unaimed = (await whatIf(SCENARIO)).value?.[0];
  ok('a scenario whose driver is aimed through a term refuses at scenario:card, typed (the KPI beside it stands); NEGATIVE CONTROL: one aimed at a column answers',
    aimed?.ok === true && aimed.scenario?.ok === false && aimed.scenario.code === 'term' && aimed.scenario.error === SENTENCE && !('value' in aimed.scenario)
      && unaimed?.scenario?.ok === true && typeof unaimed.scenario.value === 'number', JSON.stringify({ aimed, unaimed }));

  // ── § lock: the refusal is before the lock, so a kept step never reaches withLockSteps ──
  const rowDoors: typeof import('../src/ipc/rowDoors') = require('../src/ipc/rowDoors');
  const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
  const ipcDatasets: typeof import('../src/ipc/datasets') = require('../src/ipc/datasets');
  const LOCK_STEP = { type: 'filter', column: 'region', op: '=', value: 'r1' } as FilterStep;
  const realLockFor = rowAccess.rowLockFor;
  let asked = 0;
  (rowAccess as { rowLockFor: unknown }).rowLockFor = async () => {
    asked++;
    return { values: { region: ['r1'] }, steps: [LOCK_STEP], covers: async () => true };
  };
  try {
    await context.runInContext(ADMIN, 'lock', async () => {
      const got: FilterStep[][] = [];
      const body = async (_p: string, _d: string, _e: unknown, f: FilterStep[]) => { got.push(f); return { ok: true as const }; };
      const viz = await rowDoors.lockedViz(P, seed.extract, enc as never, [F0, FUTURE] as FilterStep[], {}, body);
      ok('lockedViz: a kept step under a lock is refused, typed — the lock never asked, the body never run',
        (viz as { code?: string }).code === 'term' && asked === 0 && got.length === 0, JSON.stringify({ viz, asked, got }));
      const rejects = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, (e) => termStep.isTermNotExpandedError(e) && e.reason === 'unreadable');
      ok('lockedMetric, computeCard and pageFor throw it before the lock',
        await rejects(rowDoors.lockedMetric(P, seed.extract, { column: 'sales' }, [F0, FUTURE] as FilterStep[], undefined, async () => 1))
        && await rejects(answers.computeCard(P, { datasetId: seed.extract, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [{ term: U }] } as never))
        && await rejects(ipcDatasets.pageFor(P, seed.extract, { offset: 0, limit: 5, filters: [F0, TERM] as FilterStep[] }, 'termDoors'))
        && asked === 0, String(asked));
      await rowDoors.lockedViz(P, seed.extract, enc as never, [F0] as FilterStep[], {}, body);
      ok('NEGATIVE CONTROL: a plain filter under the same lock asks it, and the body sees the lock first', asked === 1 && got.length === 1 && got[0][0] === LOCK_STEP && got[0].length === 2, JSON.stringify(got));
      // The expander itself: every step that is not a plain filter, and nothing else.
      const exp = await termExpand.expandTerms(P, seed.extract, [F0 as FilterStep]);
      ok('expandTerms: plain filters come back as they are, with no notes', exp.steps.length === 1 && exp.steps[0] === F0 && exp.notes.length === 0);
      ok('expandTerms: a term, a malformed term, a future step and a Prepare step each refuse, unreadable',
        (await Promise.all([TERM, { type: 'term' }, { type: 'term', term: 5 }, FUTURE, { type: 'dedupe' }, null].map((s) => rejects(termExpand.expandTerms(P, seed.extract, [F0, s] as FilterStep[]))))).every(Boolean));
      const answerSpec = (filters: unknown[]) => ({ datasetId: seed.extract, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters }) as never;
      ok('expandAnswerTerms refuses as specFilterSteps does — a { term } and a filter typed term; NEGATIVE CONTROL: a column filter passes',
        await rejects(termExpand.expandAnswerTerms(P, answerSpec([{ term: U }]))) && await rejects(termExpand.expandAnswerTerms(P, answerSpec([{ type: 'term', column: 'region', op: '=', value: 'r1' }])))
          && (await termExpand.expandAnswerTerms(P, answerSpec([ANSWER_F0]))).steps.length === 0);
    });
  } finally {
    (rowAccess as { rowLockFor: unknown }).rowLockFor = realLockFor;
  }

  // ── § route ────────────────────────────────────────────────────────────────
  const handlerMap = rpc.handlers as Map<string, import('../src/server/rpc').Handler>;
  const real = handlerMap.get('visual:data')!;
  handlerMap.set('visual:data', () => { throw new termStep.TermNotExpandedError('unreadable'); });
  let thrown: Reply;
  try {
    thrown = await post('visual:data', { projectId: P, datasetId: seed.extract, encoding: enc });
  } finally {
    handlerMap.set('visual:data', real);
  }
  ok('a refusal thrown past a handler is 409 term, with its reason and sentence', thrown.status === 409 && thrown.value?.error === 'term' && thrown.value.code === 'term'
    && thrown.value.reason === 'unreadable' && thrown.value.message === SENTENCE, thrown.text);
  const restored = await post('visual:data', { projectId: P, datasetId: seed.extract, encoding: enc });
  ok('NEGATIVE CONTROL: the real handler answers 200', restored.status === 200 && restored.value?.ok === true);
  ok('a caught refusal is typed by its sentence; NEGATIVE CONTROL: another failure is not',
    termStep.tagTermRefusals<{ ok: false; error: string; code?: string }>({ ok: false, error: SENTENCE }).code === 'term'
      && termStep.tagTermRefusals<{ ok: false; error: string; code?: string }>({ ok: false, error: 'Dataset not found' }).code === undefined);
  const { applyPipelineAsync }: typeof import('../src/data/regexOffThread') = require('../src/data/regexOffThread');
  const REGEX = { type: 'replace_values', column: 'region', mode: 'regex', rules: [{ from: 'r', to: 'x' }] };
  const fold = (steps: unknown[]) => context.runInContext(ADMIN, 'fold', () => applyPipelineAsync({ columns: COLUMNS, rows: ROWS }, steps as never)
    .then((r) => r, (e: unknown) => e));
  const folded = await fold([REGEX, TERM]);
  const regexOnly = await fold([REGEX]) as { rowCount?: number; rows?: Cell[][] };
  ok('the request fold (applyPipelineAsync, off the request thread) rejects a term, typed', termStep.isTermNotExpandedError(folded), String(folded));
  ok('NEGATIVE CONTROL: the same fold without the term resolves, the regex applied', regexOnly.rowCount === ROWS.length && regexOnly.rows?.[0]?.[0] === 'x0', JSON.stringify(regexOnly).slice(0, 200));

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
