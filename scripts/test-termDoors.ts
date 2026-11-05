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
//   § assistant (05b) an answer card by a real term equals the inline filter, keeps the reference in its
//               steps, spec and chips, saves it on a visual; another dataset's term is refused; the facts name it
//   § real terms (05b) at every door a term equals its filter inline (and filters something); an edit changes
//               the next figure, cached or not (an unedited ask is a hit); a deleted one is refused with its name;
//               a term of another dataset on a Live chart is refused; a dashboard term a tile cannot use is a
//               note on the chart and the KPI, the tile's own is refused; a metric's own term equals inline
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
  // 05b: TERM names no term record, so it is refused as deleted for good — the Assistant's `{ term }` too.
  const PURGED = termMsgs.termPurged();
  const items = (v: unknown): any[] => (Array.isArray(v) ? v : [v]); // any: a reply's items
  /** HTTP 409 `term`, or an item `{ok:false, code:'term'}`. */
  const refusedTerm = (r: Reply): boolean =>
    (r.status === 409 && r.value?.code === termStep.TERM_CODE) || (r.status === 200 && items(r.value).some((o) => o && o.ok === false && o.code === termStep.TERM_CODE));
  /** Any item of a 200 that answered. */
  const hasFigure = (r: Reply): boolean => r.status === 200 && items(r.value).some((o) => o && o.ok !== false);
  const refusedWith = (sentence: string) => (r: Reply): boolean => refusedTerm(r) && r.text.includes(sentence) && !hasFigure(r);
  const refusedWithSentence = refusedWith(SENTENCE);

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
      ok(`${label} on ${ds.mode}: refused, typed, with the sentence — never a figure`, refusedWith(PURGED)(r), `${r.status} ${r.text.slice(0, 300)}`);
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
    scen?.ok === false && scen.error === PURGED && !('value' in scen) && scenPlain?.ok === true && typeof scenPlain.value === 'number', JSON.stringify({ scen, scenPlain }));

  // ── § kept ─────────────────────────────────────────────────────────────────
  for (const ds of [EXTRACT, LIVE]) {
    const tilesReply = await post('analysis:tiles', { projectId: P, items: tiles(ds, fl(true)) });
    const kpi = tilesReply.value?.[1];
    ok(`a KPI with no column whose metric:value refused says why, not "deleted" (${ds.mode})`, kpi?.code === 'term' && kpi.error === PURGED && !/The metric this card showed/.test(String(kpi.error)), JSON.stringify(kpi));
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
    aimed?.ok === true && aimed.scenario?.ok === false && aimed.scenario.code === 'term' && aimed.scenario.error === termMsgs.termNotHere() && !('value' in aimed.scenario)
      && unaimed?.scenario?.ok === true && typeof unaimed.scenario.value === 'number', JSON.stringify({ aimed, unaimed }));

  // ── § assistant: the Assistant reads and filters by a real term (05b) ────────
  /** Two replies' figures agree, number by number with Object.is (a chart's data, a KPI's value, an answer card's data). */
  const sameFigure = (a: Reply, b: Reply): boolean => {
    // A reply's figures: a chart's data, a KPI's value, else the whole reply without what names how it was asked (its echo, its token, its time).
    const ASKED = new Set(['asOf', 'token', 'filters', 'spec', 'steps', 'filterLabels', 'chips', 'title', 'notes']);
    const fig = (r: Reply): unknown => {
      const v = Array.isArray(r.value) ? r.value[0] : r.value;
      if (!v || v.ok === false) return undefined;
      return v.data ?? ('value' in v ? v.value : Object.fromEntries(Object.entries(v).filter(([k]) => !ASKED.has(k))));
    };
    const same = (x: unknown, y: unknown): boolean => (Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => same(v, y[i]))
      : x && y && typeof x === 'object' && typeof y === 'object' ? Object.keys({ ...x, ...y }).every((k) => same((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k])) : Object.is(x, y));
    return fig(a) !== undefined && same(fig(a), fig(b));
  };
  const R12 = { type: 'filter', column: 'region', op: 'in', values: ['r1', 'r2'] };
  const termOn = async (d: Ds, name: string): Promise<string> =>
    String((await post('term:save', { projectId: P, input: { name, datasetId: d.id, filters: [R12] } })).value?.term?.id ?? '');
  for (const ds of [EXTRACT, LIVE]) {
    const T = await termOn(ds, `Pair ${ds.mode}`);
    const spec = (filters: unknown[]) => ({ projectId: P, spec: { datasetId: ds.id, category: 'customer', measures: [{ column: 'sales', aggregation: 'sum' }], filters } });
    const withT = await post('answer:card', spec([{ term: T }]));
    const inline = await post('answer:card', spec([{ column: 'region', op: 'in', values: ['r1', 'r2'] }]));
    const bare = await post('answer:card', spec([]));
    ok(`answer:card (${ds.mode}): a term equals its filter written inline, and its steps and spec keep the reference`, sameFigure(withT, inline)
      && withT.value.steps.some((x: { type: string; term?: string }) => x.type === 'term' && x.term === T) && withT.value.spec.filters.some((f: { term?: string }) => f.term === T)
      && withT.value.filterLabels.includes(`Pair ${ds.mode}`), `${withT.text.slice(0, 300)} | ${inline.text.slice(0, 300)}`);
    ok(`NEGATIVE CONTROL: answer:card (${ds.mode}) — the term filters something`, !sameFigure(withT, bare));
    ok(`answer:card (${ds.mode}): its chips keep the term`, withT.value.chips.every((c: { spec: { filters: { term?: string }[] } }) => c.spec.filters.some((f) => f.term === T)));
    const saved = await post('answer:saveVisual', spec([{ term: T }]));
    const vis = await post('visual:get', { projectId: P, id: saved.value?.visual?.id });
    ok(`answer:saveVisual (${ds.mode}) stores the term step`, Array.isArray(vis.value?.filters) && vis.value.filters.some((x: { type: string; term?: string }) => x.type === 'term' && x.term === T), `${saved.text.slice(0, 200)} | ${vis.text.slice(0, 200)}`);
  }
  const otherT = await termOn(LIVE, 'Live pair');
  const far = await post('answer:card', { projectId: P, spec: { datasetId: EXTRACT.id, category: 'customer', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [{ term: otherT }] } });
  ok('answer:card: a term of another dataset is refused, typed, with both names', refusedTerm(far) && far.text.includes(termMsgs.termOtherDataset('Live pair', 'Orders live', 'Orders copy')) && !hasFigure(far), far.text.slice(0, 300));
  const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
  const facts = await context.runInContext(ADMIN, 'facts', () => copilotIpc.buildFacts(P, { kind: 'dataset', id: EXTRACT.id }));
  ok('the dataset facts name its terms and how to filter by one', facts.text.includes('{"term":"<name>"}') && facts.text.includes('"Pair extract"') && facts.text.includes('region in r1, r2')
    && !facts.text.includes('"Live pair"'), facts.text.slice(-600));

  // ── § real terms: every door expands a term exactly as its filter written inline (05b) ──
  const queryCache: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
  let runs = 0; // a cache miss runs its body; a hit does not
  const realThrough = queryCache.through;
  (queryCache as { through: unknown }).through = (op: string, key: string, deps: string[], run: () => Promise<unknown>, keep: (r: unknown) => boolean) =>
    realThrough(op as never, key, deps, () => { runs++; return run(); }, keep as never);
  const OTHER = await context.runInContext(ADMIN, 'other', async () => (await datasets.saveDataset(P, { name: 'Other', sourceKind: 'csv', columns: COLUMNS, rows: ROWS }))!.id);
  const NARROW = { type: 'filter', column: 'region', op: '=', value: 'r1' };
  const flt = (mode: 'term' | 'inline' | 'none', T: string): unknown[] => (mode === 'term' ? [F0, { type: 'term', term: T }] : mode === 'inline' ? [F0, R12] : [F0]);
  const answerFlt = (mode: 'term' | 'inline' | 'none', T: string): unknown[] => (mode === 'term' ? [ANSWER_F0, { term: T }] : mode === 'inline' ? [ANSWER_F0, { column: 'region', op: 'in', values: ['r1', 'r2'] }] : [ANSWER_F0]);
  for (const ds of [EXTRACT, LIVE]) {
    const T = await termOn(ds, `Doors ${ds.mode}`);
    // The rows behind a mark: the mark is r2 (in the term, out of its narrowed edit), or r3 (out of it) for the control.
    const ask = (label: string, ch: string, body: (d: Ds, t: boolean) => object, mode: 'term' | 'inline' | 'none', mark = 'r2') => {
      const raw = JSON.stringify(body(ds, true)).split('"mark":{"category":"r1"}').join(`"mark":{"category":"${mark}"}`);
      const swapped = raw.split(JSON.stringify(fl(true))).join(JSON.stringify(flt(mode, T))).split(JSON.stringify([ANSWER_F0, { term: U }])).join(JSON.stringify(answerFlt(mode, T)));
      return post(ch, JSON.parse(swapped));
    };
    const before: Record<string, Reply> = {};
    for (const [label, ch, body, liveToo] of ENTRIES) {
      if (!liveToo && ds.mode === 'live') continue;
      const t = await ask(label, ch, body, 'term');
      before[label] = t;
      ok(`${label} (${ds.mode}): a term equals its filter written inline`, sameFigure(t, await ask(label, ch, body, 'inline')), `${t.text.slice(0, 240)}`);
      const control = label === 'visual:rows' ? [await ask(label, ch, body, 'term', 'r3'), await ask(label, ch, body, 'none', 'r3')] : [t, await ask(label, ch, body, 'none')];
      ok(`NEGATIVE CONTROL: ${label} (${ds.mode}): the term filters something`, !sameFigure(control[0], control[1]));
    }
    await post('term:update', { projectId: P, id: T, patch: { filters: [NARROW] } });
    for (const [label, ch, body, liveToo] of ENTRIES) {
      if (!liveToo && ds.mode === 'live') continue;
      const after = await ask(label, ch, body, 'term');
      ok(`${label} (${ds.mode}): editing the term changes the figure, cached or not`, hasFigure(after) && !sameFigure(after, before[label]), after.text.slice(0, 240));
    }
    const runs0 = runs;
    await ask('visual:data', 'visual:data', ENTRIES[0][2], 'term');
    ok(`NEGATIVE CONTROL: visual:data (${ds.mode}) asked again unedited is a cache hit`, ds.mode === 'live' || runs === runs0, `${runs0} → ${runs}`);
    await post('term:delete', { projectId: P, id: T });
    for (const [label, ch, body, liveToo] of ENTRIES) {
      if (!liveToo && ds.mode === 'live') continue;
      const r = await ask(label, ch, body, 'term');
      ok(`${label} (${ds.mode}): a deleted term is refused with its sentence`, refusedTerm(r) && r.text.includes(termMsgs.termDeleted(`Doors ${ds.mode}`)) && !hasFigure(r), r.text.slice(0, 240));
    }
  }
  (queryCache as { through: unknown }).through = realThrough;
  // A term on the extract dataset on a Live chart: Live joins nothing, so it is refused.
  const extractT = await termOn(EXTRACT, 'Extract pair');
  const onLive = await post('visual:data', { projectId: P, datasetId: LIVE.id, encoding: enc, filters: [F0, { type: 'term', term: extractT }] });
  ok('a term of another dataset on a Live chart is refused, unreachable', refusedTerm(onLive) && onLive.value?.reason === 'unreachable', onLive.text.slice(0, 240));
  // The dashboard scope: a term a tile cannot use is a NOTE on the tile; the tile's own is refused.
  const scopeT = { type: 'term', term: extractT, fromControl: true };
  const onOther = await post('analysis:tiles', { projectId: P, items: [
    { kind: 'visual', datasetId: OTHER, encoding: enc, filters: [F0, scopeT] },
    { kind: 'metric', datasetId: OTHER, column: 'sales', aggregation: 'sum', filters: [F0, scopeT] },
  ] });
  const NOTE = termMsgs.termNotApplied('Extract pair', 'Other');
  ok('analysis:tiles: a scope term on an unrelated tile — the chart and the KPI answer, each with the note', onOther.value?.[0]?.ok === true && onOther.value[0].notes?.[0] === NOTE
    && onOther.value?.[1]?.ok === true && onOther.value[1].notes?.[0] === NOTE, onOther.text.slice(0, 400));
  const plainTiles = await post('analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: OTHER, encoding: enc, filters: [F0] }, { kind: 'metric', datasetId: OTHER, column: 'sales', aggregation: 'sum', filters: [F0] }] });
  ok('…and draws the figures it draws without the term; NEGATIVE CONTROL: a reply with nothing left out carries no notes', sameFigure({ ...onOther, value: [onOther.value[0]] }, { ...plainTiles, value: [plainTiles.value[0]] })
    && Object.is(onOther.value[1].value, plainTiles.value[1].value) && !('notes' in plainTiles.value[0]) && !('notes' in plainTiles.value[1]));
  const own = await post('analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: OTHER, encoding: enc, filters: [F0, { type: 'term', term: extractT }] }] });
  ok('the same term as the tile\'s own filter is refused, unreachable', own.value?.[0]?.ok === false && own.value[0].code === 'term' && own.value[0].reason === 'unreachable', own.text.slice(0, 240));
  // A metric whose own filters hold a term: metric:value equals the inline metric.
  const metricWith = async (filters: unknown[]): Promise<string> => String((await post('metric:save', { projectId: P, input: { name: `Sales ${JSON.stringify(filters).length}`, datasetId: EXTRACT.id, definition: { column: 'sales', aggregation: 'sum' }, filters } })).value?.metric?.id ?? '');
  const pairT = await termOn(EXTRACT, 'Metric pair');
  const mT = await metricWith([{ type: 'term', term: pairT }]);
  const mInline = await metricWith([R12, F0]);
  const mv = (id: string) => post('analysis:tiles', tile({ kind: 'metric', datasetId: EXTRACT.id, column: '', aggregation: 'sum', metricId: id, filters: [F0] }));
  const [a, b] = [await mv(mT), await mv(mInline)];
  ok('metric:value of a metric whose filters hold a term equals the inline metric', a.value?.[0]?.ok === true && Object.is(a.value[0].value, b.value?.[0]?.value), `${a.text.slice(0, 200)} | ${b.text.slice(0, 200)}`);

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
      const rejectsAs = (reason: string) => async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, (e) => termStep.isTermNotExpandedError(e) && e.reason === reason);
      const rejects = rejectsAs('unreadable');
      ok('lockedMetric, computeCard and pageFor throw it before the lock',
        await rejects(rowDoors.lockedMetric(P, seed.extract, { column: 'sales' }, [F0, FUTURE] as FilterStep[], undefined, async () => 1))
        && await rejectsAs('deleted')(answers.computeCard(P, { datasetId: seed.extract, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [{ term: U }] } as never))
        && await rejectsAs('deleted')(ipcDatasets.pageFor(P, seed.extract, { offset: 0, limit: 5, filters: [F0, TERM] as FilterStep[] }, 'termDoors'))
        && asked === 0, String(asked));
      await rowDoors.lockedViz(P, seed.extract, enc as never, [F0] as FilterStep[], {}, body);
      ok('NEGATIVE CONTROL: a plain filter under the same lock asks it, and the body sees the lock first', asked === 1 && got.length === 1 && got[0][0] === LOCK_STEP && got[0].length === 2, JSON.stringify(got));
      // The expander itself: every step that is not a plain filter, and nothing else.
      const exp = await termExpand.expandTerms(P, seed.extract, [F0 as FilterStep]);
      ok('expandTerms: plain filters come back as they are, with no notes', exp.steps.length === 1 && exp.steps[0] === F0 && exp.notes.length === 0);
      ok('expandTerms: a malformed term, a future step and a Prepare step each refuse, unreadable; a term with no record, deleted',
        (await Promise.all([{ type: 'term' }, { type: 'term', term: 5 }, FUTURE, { type: 'dedupe' }, null].map((s) => rejects(termExpand.expandTerms(P, seed.extract, [F0, s] as FilterStep[]))))).every(Boolean)
          && await rejectsAs('deleted')(termExpand.expandTerms(P, seed.extract, [F0, TERM] as FilterStep[])));
      const answerSpec = (filters: unknown[]) => ({ datasetId: seed.extract, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters }) as never;
      ok('expandAnswerTerms refuses as specFilterSteps does — a { term } and a filter typed term; NEGATIVE CONTROL: a column filter passes',
        await rejectsAs('deleted')(termExpand.expandAnswerTerms(P, answerSpec([{ term: U }]))) && await rejects(termExpand.expandAnswerTerms(P, answerSpec([{ type: 'term', column: 'region', op: '=', value: 'r1' }])))
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
