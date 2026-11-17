// An answer's MEASURE, FILTER or GLOSSARY TERM from a related dataset (docs/assistant/00-design.md, "Joins in the chart
// form, as built"): src/ai/answerJoin.ts, src/ipc/answerJoined.ts, over the real RPC route (dev sign-in, no database),
// then with real roles on Postgres (DATABASE_URL).
//
//   spec       a measure names its dataset as a visual's measure does (`datasetId`, `via` beside it); a filter and a term
//              carry the related `datasetId` their steps are pinned to. Named by name or id, the column resolved THERE; a
//              period on a related column refused in its sentence; stored, compared and refined with them kept.
//   one door   each card is Object.is the visual's figures for the same encoding and steps (`visual:data`) AND the joinJs
//              reference over the same rows: a one-side measure (fan-in masked), a many-side measure (drill-across), a
//              related filter (never the asked dataset's same-named column), a related term. NEGATIVE CONTROLS: the
//              unmasked sum differs; the same filter on the asked dataset's own column differs; a filter on the MANY side
//              is refused in the planner's own sentence, word for word.
//   passes     Save as visual (the same encoding and pinned steps, the card's figures), Add to dashboard (the same tile
//              again; the plain twin another), Verify (the index row reads the related dataset), the snapshot's reads
//              (a filter-only join too), the turn's factsFrom, the previous answer naming it, "Did you mean" on the related
//              dataset, Explain on a visual with a related measure, the MCP verified tool's encoding; Alert me refuses.
//   access     (Postgres) a viewer's one-side measure card is the editor's and their own visual's; locked on the asked
//              dataset, or with row rules on the measure's dataset, refused `related`; the measure's column hidden from
//              them refused; each with its NEGATIVE CONTROL.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-answerJoinMeasures.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { serverMode, show, type Identity } from './notifyHarness';
import * as RP from './rowPolicyHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const joinPlan: typeof import('../src/analysis/joinPlan') = require('../src/analysis/joinPlan');
const joinJs: typeof import('../src/analysis/joinJs') = require('../src/analysis/joinJs');
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const J: typeof import('../src/ai/answerJoin') = require('../src/ai/answerJoin');
const refine: typeof import('../src/ai/answerRefine') = require('../src/ai/answerRefine');
const pick: typeof import('../src/ai/verifiedPick') = require('../src/ai/verifiedPick');
const msgs: typeof import('../src/ai/answerMessages') = require('../src/ai/answerMessages');
const alertMsgs: typeof import('../src/analysis/answerAlertMessages') = require('../src/analysis/answerAlertMessages');
const joined: typeof import('../src/ipc/answerJoined') = require('../src/ipc/answerJoined');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const vLookup: typeof import('../src/ipc/verifiedLookup') = require('../src/ipc/verifiedLookup');
const answerCheck: typeof import('../src/ipc/answerCheck') = require('../src/ipc/answerCheck');

type Any = any; // any: each channel's own reply, read field by field
type ChartData = import('../src/analysis/vizData').ChartData;
type FilterStep = import('../src/data/transforms').FilterStep;

const figures = (d: ChartData): Map<string, unknown> => new Map(d.series.flatMap((s) => d.labels.map((l, i): [string, unknown] => [`${s.name}\u0000${String(l)}`, s.values[i]])));
const sameFigures = (a: ChartData | undefined, b: ChartData | undefined): boolean => {
  if (!a || !b) return false;
  const [fa, fb] = [figures(a), figures(b)];
  return fa.size > 0 && fa.size === fb.size && [...fa].every(([k, v]) => fb.has(k) && Object.is(v, fb.get(k)));
};
const T = (name: string) => ({ name, type: 'text' as const });
const N = (name: string) => ({ name, type: 'number' as const });

// ── the spec, pure ───────────────────────────────────────────────────────
function specCases(): void {
  const O = { id: randomUUID(), name: 'Orders', columns: [T('cust_id'), T('region'), T('status'), N('amount'), { name: 'day', type: 'date' as const }] };
  const C = { id: randomUUID(), name: 'Customers', columns: [T('cust_id'), T('region'), T('tier'), N('target'), { name: 'since', type: 'date' as const }] };
  const all = [O, C];
  const base = { dataset: 'Orders', category: 'status' };
  const m = A.validateAnswerSpec({ ...base, measures: [{ column: 'target', aggregation: 'sum', dataset: 'Customers' }] }, all);
  ok('spec: a measure naming its dataset resolves THERE, a visual\'s measure (`datasetId`)', m.ok && m.spec.measures[0].datasetId === C.id && m.spec.measures[0].column === 'target', show(m));
  const byId = A.validateAnswerSpec({ ...base, measures: [{ column: 'target', aggregation: 'sum', datasetId: C.id }] }, all);
  ok('spec: …and by its id, the same spec', byId.ok && m.ok && JSON.stringify(byId.spec) === JSON.stringify(m.spec));
  const own = A.validateAnswerSpec({ ...base, measures: [{ column: 'target', aggregation: 'sum' }] }, all);
  ok('spec: NEGATIVE CONTROL: the same measure without its dataset is unknown on Orders (rejection, not repair)', !own.ok && own.miss?.part === 'measure' && own.miss.datasetId === O.id, show(own));
  const missRel = A.validateAnswerSpec({ ...base, measures: [{ column: 'targt', aggregation: 'sum', dataset: 'Customers' }] }, all);
  ok('spec: a measure misspelt on its dataset is unknown THERE ("Did you mean" reads Customers)', !missRel.ok && missRel.miss?.part === 'measure' && missRel.miss.datasetId === C.id, show(missRel));
  const f = A.validateAnswerSpec({ ...base, measures: [{ column: 'amount' }], filters: [{ column: 'region', op: '=', value: 'West', dataset: 'Customers' }] }, all);
  ok('spec: a filter naming its dataset carries `datasetId`; the same name on Orders carries none', f.ok && (f.spec.filters[0] as Any).datasetId === C.id
    && !('datasetId' in ((A.validateAnswerSpec({ ...base, measures: [{ column: 'amount' }], filters: [{ column: 'region', op: '=', value: 'West' }] }, all) as Any).spec.filters[0])), show(f));
  const period = A.validateAnswerSpec({ ...base, measures: [{ column: 'amount' }], filters: [{ column: 'since', period: 'last_year', dataset: 'Customers' }] }, all);
  ok('spec: a period on a related date column is refused in its sentence; NEGATIVE CONTROL: on Orders\' own date it is a filter',
    !period.ok && period.reason === msgs.relatedPeriodRefused('since', 'Customers', 'Orders') && A.validateAnswerSpec({ ...base, measures: [{ column: 'amount' }], filters: [{ column: 'day', period: 'last_year' }] }, all).ok, show(period));
  const TERM = { id: randomUUID(), name: 'Gold customers', aliases: [], datasetId: C.id };
  const t = A.validateAnswerSpec({ ...base, measures: [{ column: 'amount' }], filters: [{ term: 'Gold customers' }] }, all, { terms: [TERM] as never });
  ok('spec: a term of a related dataset is kept with that dataset', t.ok && JSON.stringify(t.spec.filters) === JSON.stringify([{ term: TERM.id, datasetId: C.id }]), show(t));
  const far = A.validateAnswerSpec({ ...base, measures: [{ column: 'amount' }], filters: [{ term: 'Gold customers' }] }, [O], { terms: [TERM] as never });
  ok('spec: …even when the vocabulary holds only the asked dataset (an ask names a term, not its dataset): the door judges its reach', far.ok && JSON.stringify(far.spec.filters) === JSON.stringify([{ term: TERM.id, datasetId: C.id }]), show(far));
  const oldRef = A.validateAnswerSpec({ ...base, measures: [{ column: 'amount' }], filters: [{ term: TERM.id }] }, all, { terms: [TERM] as never });
  ok('spec: NEGATIVE CONTROL: a stored reference by id with no dataset beside it (an older answer\'s) is refused, as the card door refuses it; with it, kept',
    !oldRef.ok && /is a term of another dataset/.test(oldRef.reason) && A.validateAnswerSpec({ ...base, measures: [{ column: 'amount' }], filters: [{ term: TERM.id, datasetId: C.id }] }, all, { terms: [TERM] as never }).ok, show(oldRef));
  if (!m.ok || !f.ok || !t.ok) return;

  const VIA = randomUUID();
  const stored = A.sanitizeStoredSpec({ ...m.spec, measures: [{ ...m.spec.measures[0], via: VIA }], filters: [...f.spec.filters, ...t.spec.filters] });
  ok('stored: a measure\'s datasetId and via, a filter\'s and a term\'s datasetId are kept, as ids',
    stored?.measures[0].datasetId === C.id && stored.measures[0].via === VIA && (stored.filters[0] as Any).datasetId === C.id && (stored.filters[1] as Any).datasetId === C.id, show(stored));
  const odd = A.sanitizeStoredSpec({ ...m.spec, measures: [{ ...m.spec.measures[0], datasetId: '../x', via: VIA }], filters: [{ column: 'region', op: '=', value: 'W', datasetId: O.id }] });
  ok('stored: a non-id is dropped (and its via), and the asked dataset\'s own id is no related one', !!odd && !('datasetId' in odd.measures[0]) && !('via' in odd.measures[0]) && !('datasetId' in odd.filters[0]), show(odd));
  ok('stored: a plain spec sanitizes with no key added', JSON.stringify(Object.keys(A.sanitizeStoredSpec({ ...m.spec, measures: [{ column: 'amount', aggregation: 'sum' }], filters: [] })!.measures[0])) === '["column","aggregation"]');
  ok('helpers: relatedIds names the measure\'s, the filter\'s and the term\'s dataset once; ownNames leaves them out',
    JSON.stringify(J.relatedIds(stored)) === JSON.stringify([C.id]) && JSON.stringify(J.ownNames(stored!)) === '["status"]' && JSON.stringify(J.ownNames(f.spec)) === '["status","amount"]');
  const steps = A.specFilterSteps(f.spec, O.columns, []).steps;
  ok('steps: a related filter is a step pinned to its dataset (never dropped, never Orders\' same-named column)', steps.length === 1 && steps[0].datasetId === C.id && steps[0].column === 'region', show(steps));
  const twin = { ...f.spec, filters: [{ column: 'region', op: '=' as const, value: 'West' }] };
  ok('sameChart: a related filter and the same one on Orders are two charts; a related measure and Orders\' are two', !refine.sameChart(f.spec, twin)
    && !refine.sameChart(m.spec, { ...m.spec, measures: [{ column: 'target', aggregation: 'sum' }] }) && refine.sameChart(m.spec, { ...m.spec, title: 'other' })
    && !refine.sameChart(stored!, { ...stored!, measures: [{ ...stored!.measures[0], via: undefined }] }));
  const r1 = A.validateAnswerSpec(refine.refineSpec({ ...m.spec, filters: f.spec.filters }, { filters: [{ column: 'status', op: '=', value: 'open' }] }, O), all);
  ok('refine: a follow-up keeps the related measure and filter', r1.ok && r1.spec.measures[0].datasetId === C.id && r1.spec.filters.some((x) => (x as Any).datasetId === C.id) && r1.spec.filters.length === 2, show(r1));
  const r2 = A.validateAnswerSpec(refine.refineSpec(f.spec, { filters: [{ column: 'region', op: '=', value: 'East', dataset: 'Customers' }] }, O), all);
  ok('refine: a patch restating the related filter replaces it', r2.ok && r2.spec.filters.length === 1 && (r2.spec.filters[0] as Any).value === 'East', show(r2));
  const names = { dataset: (id: string) => (id === C.id ? 'Customers' : 'Orders'), term: () => 'Gold customers' };
  const raw = pick.rawSpec({ ...m.spec, filters: f.spec.filters }, names);
  ok('examples: a verified question is shown with each related field\'s dataset by NAME, as the model writes it', JSON.stringify(raw).includes('"dataset":"Customers"') && !JSON.stringify(raw).includes(C.id)
    && A.validateAnswerSpec(raw, all).ok, show(raw));
  const state = (sp: object) => ({ q: { id: randomUUID(), question: 'q', phrasings: [], spec: sp }, problem: null, hidden: false, tag: '' }) as never;
  ok('examples: a measure through a labelled relationship is no example; NEGATIVE CONTROL: without it, it is', !pick.eligibleExample(state(stored!), { withheld: () => new Set() })
    && pick.eligibleExample(state(m.spec), { withheld: () => new Set() }));
  ok('examples: a value filter on a column Customers marks is none (its own dataset\'s marks); NEGATIVE CONTROL: Orders\' marks do not hide it',
    !pick.eligibleExample(state(f.spec), { withheld: (id) => new Set(id === C.id ? ['region'] : []) }) && pick.eligibleExample(state(f.spec), { withheld: (id) => new Set(id === O.id ? ['region'] : []) }));
}

// ── over the route ───────────────────────────────────────────────────────
interface Bench { inCtx<R>(fn: () => Promise<R>): Promise<R>; project(name: string): Promise<string>; post(channel: string, payload: unknown): Promise<{ status: number; value: Any }>; close(): Promise<void> }

function fileBench(): Bench {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-answerjoinmeasures-'));
  const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
  serverMode(DATA);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const inCtx = <R>(fn: () => Promise<R>): Promise<R> => context.runInContext(ADMIN, `q-${randomUUID()}`, fn);
  return {
    inCtx,
    project: (name) => inCtx(async () => { await projects.init(); return (await projects.createProject(name)).id; }),
    post: async (channel, payload) => {
      const r = await app.inject({ method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
      return { status: r.statusCode, value: r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body) };
    },
    close: async () => fs.rmSync(DATA, { recursive: true, force: true }),
  };
}

function dbBench(W: RP.World): Bench {
  return {
    inCtx: (fn) => W.as('boss', fn),
    project: async (name) => (await W.call('boss', 'projects:create', { name })).body.id,
    post: async (channel, payload) => { const r = await W.call('boss', channel, payload); return { status: r.status, value: r.body }; },
    close: async () => undefined,
  };
}

async function routeCases(b: Bench): Promise<void> {
  const { inCtx, post } = b;
  const P = await b.project('Answer join measures');
  const seed = await inCtx(async () => {
    // Orders' own `region` holds other values than Customers' `region`: a filter read on the wrong table shows.
    const orders = (await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: [T('order_id'), T('cust_id'), T('region'), T('status'), N('amount')], rows: [
      ['o1', 'c1', 'R-A', 'open', 10], ['o2', 'c1', 'R-B', 'shipped', 5], ['o3', 'c2', 'R-A', 'open', 7.5], ['o4', 'c3', 'R-B', 'open', 3],
      ['o5', 'c4', 'R-A', 'shipped', 2], ['o6', 'c2', 'R-B', 'shipped', -0], ['o7', 'c1', 'West', 'open', 1],
    ] }))!.id;
    const customers = (await datasets.saveDataset(P, { name: 'Customers', sourceKind: 'csv', columns: [T('cust_id'), T('region'), T('tier'), N('target')], rows: [
      ['c1', 'West', 'Gold', 100], ['c2', 'East', 'Silver', 40], ['c3', 'West', 'Silver', 25],
    ] }))!.id;
    const link = randomUUID();
    await rels.saveRelationship(P, { id: link, from: { datasetId: orders, column: 'cust_id' }, to: { datasetId: customers, column: 'cust_id' }, cardinality: 'many_to_one', verified: { matched: 6, unmatchedFrom: 1 } });
    const gold = (await terms.saveTerm(P, { name: 'Gold customers', datasetId: customers, filters: [{ type: 'filter', column: 'tier', op: '=', value: 'Gold' }] } as never))!;
    // A dataset nothing links to, with a term of its own: an answer on Orders cannot reach it.
    const planets = (await datasets.saveDataset(P, { name: 'Planets', sourceKind: 'csv', columns: [T('name')], rows: [['Mars']] }))!.id;
    const red = (await terms.saveTerm(P, { name: 'Red planets', datasetId: planets, filters: [{ type: 'filter', column: 'name', op: '=', value: 'Mars' }] } as never))!;
    return { orders, customers, link, gold: gold.id, planets, red: red.id };
  });
  const { orders, customers } = seed;
  const viz = async (datasetId: string, encoding: object, filters: unknown[] = []) => (await post('visual:data', { projectId: P, datasetId, encoding, filters })).value;
  const card = async (spec: object) => (await post('answer:card', { projectId: P, spec })).value;
  const TARGET = [{ column: 'target', aggregation: 'sum' as const, datasetId: customers }];
  const AMOUNT = [{ column: 'amount', aggregation: 'sum' as const }];
  const on = (extra: object = {}) => ({ datasetId: orders, category: 'status', measures: TARGET, filters: [], chartType: 'column', title: 'Target by status', ...extra });

  // The JS reference over the same rows: the planner's join, then joinJs (rule 3, the fan-in mask), or without it.
  const reference = async (primary: string, encoding: Any, filters: FilterStep[], masked = true) => inCtx(async () => {
    const list = await rels.listRelationships(P);
    const infos = new Map<string, Any>();
    const tables = new Map<string, Any>();
    for (const id of [orders, customers]) {
      const ds = (await datasets.getDataset(P, id))!;
      infos.set(id, { id, name: ds.name, columns: ds.columns });
      tables.set(id, { columns: ds.columns, rows: ds.rows });
    }
    const j = joinPlan.resolveVizJoin(primary, encoding, filters, list, infos);
    if (!j || !j.ok) return null;
    if (masked) return joinJs.joinedVizDataJs(j.value, tables, infos).data;
    const t = joinJs.joinTables(j.value.plan, j.value.layout, tables, infos);
    return vizData.buildVizData(t.columns, t.rows, j.value.encoding, j.value.filters).data;
  });

  // ── 1. a one-side measure: fan-in masked ──
  const one = await card(on());
  const oneViz = await viz(orders, { category: 'status', values: TARGET });
  const oneRef = await reference(orders, { category: 'status', values: TARGET }, []);
  ok('one side: the card answers, its spec keeping the measure\'s dataset', one.ok === true && one.spec.measures[0].datasetId === customers, show(one));
  ok('one side: DIFFERENTIAL: Object.is the visual\'s figures for the same encoding AND the joinJs reference', sameFigures(one.data, oneViz?.data) && sameFigures(one.data, oneRef ?? undefined), show([one.data, oneViz?.data, oneRef]));
  const sumOf = (d: ChartData | null | undefined, label: string): unknown => (d?.series[0] ? figures(d).get(`${d.series[0].name}\u0000${label}`) : undefined);
  ok('one side: each customer\'s target once per status (open: c1 + c2 + c3 = 165, though c1 has two open orders)', sumOf(one.data, 'open') === 165, show(one.data));
  const unmasked = await reference(orders, { category: 'status', values: TARGET }, [], false);
  ok('one side: NEGATIVE CONTROL: the unmasked sum differs (target × orders: open 265)', !!unmasked && !sameFigures(one.data, unmasked) && sumOf(unmasked, 'open') === 265, show(unmasked));

  // ── 2. a many-side measure: drill-across ──
  const manySpec = { datasetId: customers, category: 'tier', measures: [{ column: 'amount', aggregation: 'sum', datasetId: orders }], filters: [], chartType: 'column', title: 'Amount by tier' };
  const many = await card(manySpec);
  const manyViz = await viz(customers, { category: 'tier', values: manySpec.measures });
  const manyRef = await reference(orders, { category: 'tier', categoryDatasetId: customers, values: AMOUNT }, []); // the drill-across question: ON Orders, by Customers' tier
  ok('many side: the card answers through the drill-across, Object.is the visual\'s figures', many.ok === true && sameFigures(many.data, manyViz?.data), show([many, manyViz]));
  ok('many side: DIFFERENTIAL: Object.is the joinJs reference of its question on Orders (Gold 16, Silver 10.5)', !!manyRef && [...figures(many.data)].every(([k, v]) => Object.is(figures(manyRef).get(k), v))
    && sumOf(many.data, 'Gold') === 16 && sumOf(many.data, 'Silver') === 10.5, show([many.data, manyRef]));

  // ── 3. a related filter, never Orders' same-named column ──
  const westSpec = { datasetId: orders, category: 'status', measures: AMOUNT, filters: [{ column: 'region', op: '=', value: 'West', datasetId: customers }], chartType: 'column', title: 'Amount by status, West customers' };
  const west = await card(westSpec);
  const westViz = await viz(orders, { category: 'status', values: AMOUNT }, west.steps);
  const westRef = await reference(orders, { category: 'status', values: AMOUNT }, [{ type: 'filter', column: 'region', op: '=', value: 'West', datasetId: customers }]);
  ok('filter: the card\'s step is pinned to Customers, and its figures Object.is the visual of its steps AND the joinJs reference',
    west.ok === true && west.steps?.[0]?.datasetId === customers && sameFigures(west.data, westViz?.data) && sameFigures(west.data, westRef ?? undefined), show([west.steps, west.data, westViz?.data, westRef]));
  ok('filter: …the West customers\' orders (open 10 + 3 + 1, shipped 5)', sumOf(west.data, 'open') === 14 && sumOf(west.data, 'shipped') === 5, show(west.data));
  const ownWest = await card({ ...westSpec, filters: [{ column: 'region', op: '=', value: 'West' }] });
  ok('filter: NEGATIVE CONTROL: the same filter on Orders\' own region is another chart (o7 alone)', ownWest.ok === true && !sameFigures(ownWest.data, west.data) && ownWest.data.labels.length === 1, show(ownWest.data));
  const manyFilter = await card({ datasetId: customers, category: 'tier', measures: [{ column: 'target', aggregation: 'sum' }], filters: [{ column: 'status', op: '=', value: 'open', datasetId: orders }], chartType: 'column', title: 'x' });
  const names = new Map([[orders, 'Orders'], [customers, 'Customers']]);
  const planner = joinPlan.findPath(customers, orders, await inCtx(() => rels.listRelationships(P)), (id) => names.get(id) ?? id);
  ok('reverse: a filter on the MANY side is refused in the planner\'s own sentence, word for word', manyFilter.ok === false && !planner.ok && manyFilter.reason === planner.error && /inflated/.test(manyFilter.reason), show([manyFilter, planner]));
  const doorSays = await viz(customers, { category: 'tier', values: [{ column: 'target', aggregation: 'sum' }] }, [{ type: 'filter', column: 'status', op: '=', value: 'open', datasetId: orders }]);
  ok('reverse: …why the answer path says findPath\'s sentence first: the door\'s own refusal of that pinned step is worded for a glossary term', doorSays?.ok === false && /glossary term/.test(doorSays.error) && doorSays.error !== manyFilter.reason, show(doorSays));

  // ── 4. a related glossary term ──
  const goldSpec = { ...westSpec, filters: [{ term: seed.gold, datasetId: customers }], title: 'Amount by status, Gold customers' };
  const gold = await card(goldSpec);
  const goldViz = await viz(orders, { category: 'status', values: AMOUNT }, [{ type: 'term', term: seed.gold }]);
  const goldRef = await reference(orders, { category: 'status', values: AMOUNT }, [{ type: 'filter', column: 'tier', op: '=', value: 'Gold', datasetId: customers }]);
  ok('term: a related term\'s card Object.is the visual with that term AND the joinJs reference of its pinned steps (Gold: c1)',
    gold.ok === true && sameFigures(gold.data, goldViz?.data) && sameFigures(gold.data, goldRef ?? undefined) && sumOf(gold.data, 'open') === 11, show([gold, goldViz?.data, goldRef]));
  ok('term: the card\'s spec keeps the reference with its dataset; its steps keep the reference (a save expands it there)', JSON.stringify(gold.spec?.filters) === JSON.stringify([{ term: seed.gold, datasetId: customers }])
    && gold.steps?.some((s: Any) => s.type === 'term' && s.term === seed.gold), show([gold.spec?.filters, gold.steps]));
  const bareTerm = await card({ ...goldSpec, filters: [{ term: seed.gold }] });
  ok('term: NEGATIVE CONTROL: the reference without its dataset is refused as another dataset\'s term, as before', bareTerm.ok === false && /filters Customers, not Orders/.test(bareTerm.reason), show(bareTerm));
  const termMsgs: typeof import('../src/data/termMessages') = require('../src/data/termMessages');
  const farTerm = await card({ ...goldSpec, filters: [{ term: seed.red, datasetId: seed.planets }] });
  ok('term: a term of a dataset the answer cannot reach is refused typed, in the term door\'s sentence', farTerm.ok === false && farTerm.code === 'term' && farTerm.reason === termMsgs.termUnreachable('Red planets', 'Planets', 'Orders'), show(farTerm));

  // ── 2b. a many-side measure narrowed by a filter on its own (many) side: the drill-across narrows it, the door decides ──
  const narrowed = { ...manySpec, filters: [{ column: 'status', op: '=', value: 'open', datasetId: orders }] };
  const nCard = await card(narrowed);
  const nViz = await viz(customers, { category: 'tier', values: manySpec.measures }, nCard.steps ?? []);
  ok('many side + its own side\'s filter: the card answers, Object.is the visual of its steps (Gold 11, Silver 10.5)', nCard.ok === true && sameFigures(nCard.data, nViz?.data)
    && sumOf(nCard.data, 'Gold') === 11 && sumOf(nCard.data, 'Silver') === 10.5, show([nCard, nViz?.data]));

  // ── passes: Save as visual, Add to dashboard, Verify, snapshot, factsFrom, previous answer, Did you mean, Explain, MCP, Alert ──
  const both = on({ filters: westSpec.filters });
  const bothCard = await card(both);
  const saved = (await post('answer:saveVisual', { projectId: P, spec: both })).value;
  const v = saved.ok ? (await post('visual:get', { projectId: P, id: saved.visual.id })).value : null;
  const vData = v ? await viz(orders, v.encoding, v.filters) : null;
  ok('save: the visual keeps the measure\'s dataset and the pinned filter, and draws the card\'s figures (Object.is)',
    v?.encoding?.values?.[0]?.datasetId === customers && v.filters.some((s: Any) => s.datasetId === customers) && sameFigures(vData?.data, bothCard.data), show([v?.encoding, v?.filters, vData?.data, bothCard.data]));
  const first = (await post('answer:addToDashboard', { projectId: P, spec: both, name: 'Joined measures' })).value;
  const again = first.ok ? (await post('answer:addToDashboard', { projectId: P, spec: both, analysisId: first.dashboard.id })).value : null;
  const twin = first.ok ? (await post('answer:addToDashboard', { projectId: P, spec: { ...both, filters: [{ column: 'region', op: '=', value: 'West' }] }, analysisId: first.dashboard.id })).value : null;
  ok('dashboard: the same answer again is the tile there; the filter on Orders\' own region is another tile', again?.already === true && twin?.ok === true && !twin.already && twin.visual.id !== first.visual.id, show([again, twin]));
  const vq = (await post('verified:save', { projectId: P, input: { question: 'Target by status for West customers', spec: both } })).value;
  const marked = await card(both);
  const unmarked = await card({ ...both, filters: [] });
  ok('verify: it saves, its card is marked; the same without the related filter is not', vq.ok === true && marked.verified?.question === 'Target by status for West customers' && !unmarked.verified, show([vq, marked.verified, unmarked.verified]));
  const storedQ = await inCtx(async () => (await (require('../src/analysis/verifiedQuestions') as typeof import('../src/analysis/verifiedQuestions')).listBoth(P)).spec.find((t) => t.rec.question === 'Target by status for West customers'));
  const described = storedQ ? vLookup.describeVerified(P, storedQ.rec.id, JSON.stringify(storedQ.rec)) : [];
  ok('verify: its index row reads Orders and Customers (the folders\' WHERE)', JSON.stringify(described[0]?.reads) === JSON.stringify([orders, customers]), show(described));
  await inCtx(async () => {
    const filterOnly = A.sanitizeStoredSpec({ ...westSpec })!;
    ok('snapshot: a join read only by a filter reads Orders and Customers', JSON.stringify(await joined.answerReads(P, filterOnly)) === JSON.stringify([orders, customers]));
    ok('snapshot: NEGATIVE CONTROL: the same filter on Orders reads Orders alone', JSON.stringify(await joined.answerReads(P, { ...filterOnly, filters: [{ column: 'region', op: '=', value: 'West' }] })) === JSON.stringify([orders]));
  });
  const ran = (await post('answer:rerun', { projectId: P, spec: both, label: 'target by status for west customers' })).value;
  await inCtx(async () => {
    const turns = await copilot.loadHistory(P, ran.threadId);
    const t = turns.filter((x) => x.role === 'assistant').at(-1);
    ok('turn: factsFrom names the measure\'s and the filter\'s dataset once (0039\'s SQL count reads it)', JSON.stringify(t?.factsFrom) === JSON.stringify([customers]) && t?.answer?.measures[0].datasetId === customers, show(t));
    const prev = await answers.previousAnswer(P, turns);
    ok('follow-up: the previous answer keeps them and names Customers beside the measure and the filter', prev?.spec.measures[0].datasetId === customers
      && prev.block.includes('sum(target) from "Customers"') && /region = West from "Customers"|region.*West.*from "Customers"/.test(prev.block), show(prev?.block));
  });
  const meant = await inCtx(() => answerCheck.checkAction(P, {}, { kind: 'answer', intent: 'q', spec: { dataset: 'Orders', category: 'status', measures: [{ column: 'targt', aggregation: 'sum', dataset: 'Customers' }] } }, 'q'));
  const option = !meant.ok && 'suggest' in meant ? meant.suggest?.options[0] : undefined;
  ok('did you mean: a measure misspelt on Customers is offered from ITS columns, the option keeping the dataset', option?.spec.measures[0].column === 'target' && option.spec.measures[0].datasetId === customers, show(meant));
  const meantF = await inCtx(() => answerCheck.checkAction(P, {}, { kind: 'answer', intent: 'q', spec: { dataset: 'Orders', category: 'status', measures: AMOUNT, filters: [{ column: 'tiers', op: '=', value: 'Gold', dataset: 'Customers' }] } }, 'q'));
  const optF = !meantF.ok && 'suggest' in meantF ? meantF.suggest?.options[0] : undefined;
  ok('did you mean: …and a filter column misspelt there, the option\'s filter still pinned to Customers', (optF?.spec.filters[0] as Any)?.column === 'tier' && (optF?.spec.filters[0] as Any)?.datasetId === customers, show(meantF));
  // The ask: a model's answer naming the linked dataset for a measure and a filter, and a linked dataset's term by name only.
  const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
  const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
  const real = { ask: analyze.askCopilot, ready: execConfig.executionReady, on: execConfig.assistantOn };
  let calls = 0;
  const action = { kind: 'answer', intent: 'target by status, West Gold customers', spec: { dataset: 'Orders', category: 'status', measures: [{ column: 'target', aggregation: 'sum', dataset: 'Customers' }],
    filters: [{ column: 'region', op: '=', value: 'West', dataset: 'Customers' }, { term: 'Gold customers' }] } };
  (analyze as { askCopilot: unknown }).askCopilot = async () => { calls++; return { ok: true, text: 'Here it is.', suggestedAction: action }; };
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (execConfig as { assistantOn: unknown }).assistantOn = () => true;
  try {
    const threadId = (await post('copilot:newThread', { projectId: P })).value.thread.id;
    const asked = (await post('copilot:ask', { projectId: P, threadId, context: { kind: 'dataset', id: orders }, question: 'target by status for West Gold customers' })).value;
    const t = asked.turns?.at(-1);
    const tViz = t?.card ? await viz(orders, { category: 'status', values: TARGET }, t.card.steps) : null;
    ok('ask: the model\'s answer is the chart form in ONE call: the measure, the filter and the term each on Customers',
      asked.ok === true && calls === 1 && t?.answer?.measures[0].datasetId === customers && t.answer.filters.length === 2 && t.answer.filters.every((x: Any) => x.datasetId === customers), show([asked.answer, t?.answer, calls]));
    ok('ask: …its card Object.is the visual of the card\'s steps (c1, a Gold West customer: open 100, shipped 100)', sameFigures(t?.card?.data, tViz?.data) && sumOf(t?.card?.data, 'open') === 100, show([t?.card?.data, tViz?.data]));
  } finally {
    (analyze as { askCopilot: unknown }).askCopilot = real.ask;
    (execConfig as { executionReady: unknown }).executionReady = real.ready;
    (execConfig as { assistantOn: unknown }).assistantOn = real.on;
  }
  const measureVisual = (await post('visual:save', { projectId: P, datasetId: orders, name: 'Target by status', chartType: 'column', encoding: { category: 'status', values: TARGET }, filters: [westSpec.filters[0] && { type: 'filter', ...westSpec.filters[0] }] })).value;
  const explained = (await post('answer:explain', { projectId: P, visualId: measureVisual.id ?? measureVisual.visual?.id })).value;
  const explainedTurn = explained.ok ? await inCtx(async () => (await copilot.loadHistory(P, explained.threadId)).at(-1)) : null;
  ok('explain: a visual with a related measure and a pinned filter is explained with both, its card the visual\'s figures',
    explained.ok === true && explainedTurn?.answer?.measures[0].datasetId === customers && (explainedTurn.answer.filters[0] as Any)?.datasetId === customers
    && sameFigures((await card(explainedTurn.answer)).data, (await viz(orders, { category: 'status', values: TARGET }, [{ type: 'filter', ...westSpec.filters[0] }]))?.data), show([explained, explainedTurn?.answer]));
  const mcp: typeof import('../src/automation/verifiedTools') = require('../src/automation/verifiedTools');
  await inCtx(async () => {
    const got = await mcp.answerVerifiedQuestion({ projectId: P } as never, 'Target by status for West customers');
    ok('mcp: the verified question\'s figures are the card\'s (Object.is), its measure read on Customers', sameFigures({ labels: got.labels, series: got.series } as ChartData, marked.data), show([got, marked.data]));
    const listed = (await mcp.listVerifiedQuestions({ projectId: P } as never)).questions.find((q) => q.question === 'Target by status for West customers');
    ok('mcp: no one-dataset `aggregate` hint for it', !!listed && !listed.aggregate, show(listed));
  });
  const alert = (await post('alerts:fromAnswer', { projectId: P, spec: on() })).value;
  const plainAlert = (await post('alerts:fromAnswer', { projectId: P, spec: { ...on(), measures: AMOUNT } })).value;
  ok('alert: Alert me refuses a related measure in its sentence; NEGATIVE CONTROL: the plain twin drafts one', alert.ok === false && alert.reason === alertMsgs.alertNoLinked() && plainAlert.ok === true, show([alert, plainAlert]));
  const filterAlert = (await post('alerts:fromAnswer', { projectId: P, spec: westSpec })).value;
  ok('alert: …and a related filter', filterAlert.ok === false && filterAlert.reason === alertMsgs.alertNoLinked(), show(filterAlert));
  await b.close();
}

// ── access, with real roles (DATABASE_URL) ───────────────────────────────
async function accessCases(W: RP.World): Promise<void> {
  const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
  const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
  const msg: typeof import('../src/data/rowPolicyError') = require('../src/data/rowPolicyError');
  const P = W.P;
  const targets = await W.as('boss', async () => {
    const id = (await datasets.saveDataset(P, { name: 'Region targets', sourceKind: 'csv', columns: [T('region'), N('target'), N('bonus')], rows: [['East', 50, 1], ['West', 70, 2], ['North', 30, 3]] }))!.id;
    for (const from of [W.plain, W.orders]) await rels.saveRelationship(P, { id: randomUUID(), from: { datasetId: from, column: 'region' }, to: { datasetId: id, column: 'region' }, cardinality: 'many_to_one', verified: { matched: 1, unmatchedFrom: 0 } });
    return id;
  });
  const spec = (datasetId: string, column = 'target') => ({ datasetId, category: 'region', measures: [{ column, aggregation: 'sum', datasetId: targets }], filters: [], chartType: 'column', title: 'Target by region' });
  const card = (who: string, sp: object) => W.call(who, 'answer:card', { projectId: P, spec: sp });
  const typed = (r: RP.Reply, reason: 'related'): boolean => r.status === 200 && r.body?.ok === false && r.body.code === 'row_policy' && r.body.error === msg.rowPolicyRefusal(reason).error && !RP.leaks(r.text);
  const east = await card('east', spec(W.plain));
  const eastViz = await W.call('east', 'visual:data', { projectId: P, datasetId: W.plain, encoding: { category: 'region', values: spec(W.plain).measures }, filters: [] });
  ok('access: a viewer\'s related-measure card on two open datasets is the editor\'s and their own visual\'s, Object.is',
    east.body?.ok === true && RP.diff(east.body.data, (await card('ed', spec(W.plain))).body?.data, {}) === '' && sameFigures(east.body.data, eastViz.body?.data), east.text.slice(0, 240));
  const locked = await card('east', spec(W.orders));
  ok('access: locked on the asked dataset, the related measure is refused `related`, no figure', typed(locked, 'related'), locked.text.slice(0, 240));
  ok('access: NEGATIVE CONTROL: the editor\'s card on Orders answers', (await card('ed', spec(W.orders))).body?.ok === true);
  const plant = (rules: object[]) => W.as('boss', () => rec.serialized(rec.datasetFilePath(P, targets), (raw) => {
    raw.columnAccess = access.buildColumnAccess(raw, rules as never, 'boss@acme.test', new Date().toISOString());
    return true;
  }));
  await plant([{ column: 'target', visibleTo: [{ teamId: randomUUID() }] }]);
  const hidden = await card('east', spec(W.plain));
  ok('access: the measure\'s column hidden from the viewer: refused, typed, no figure of it', hidden.status === 200 && hidden.body?.ok === false && hidden.body.code === 'row_policy', hidden.text.slice(0, 240));
  ok('access: NEGATIVE CONTROL: the admin gets it, and the viewer a measure of it they see', (await card('boss', spec(W.plain))).body?.ok === true && (await card('east', spec(W.plain, 'bonus'))).body?.ok === true);
  await plant([]);
  const set = await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: targets, policy: { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } });
  if (set.body?.ok !== true) throw new Error(`setup: rules on Region targets: ${set.text}`);
  ok('access: row rules on the MEASURE\'s dataset: the viewer\'s card is refused `related`', typed(await card('east', spec(W.plain)), 'related'));
  ok('access: NEGATIVE CONTROL: the editor\'s answers, and the viewer\'s plain card on Plain', (await card('ed', spec(W.plain))).body?.ok === true
    && (await card('east', { ...spec(W.plain), measures: [{ column: 'sales', aggregation: 'sum' }] })).body?.ok === true);
}

(async () => {
  specCases();
  if (!process.env.DATABASE_URL) {
    await routeCases(fileBench());
    console.log('skip the access cases: DATABASE_URL is unset (roles need Postgres)');
    return;
  }
  const W = await RP.world('answer join measures');
  if (!W) return;
  try {
    await routeCases(dbBench(W));
    await accessCases(W);
  } finally {
    await W.close();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
