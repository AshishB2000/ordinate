// Answers whose category or split is a RELATED dataset's column (docs/assistant/00-design.md, "Joins, as built"):
// src/ai/answerJoin.ts and src/ipc/answerJoined.ts, over the real RPC route (dev sign-in, server mode, no database).
//
//   spec        the three fields a visual's encoding has, with its meaning and whitelist: named by id or by name, a column of
//               THAT dataset, `categoryVia` only beside its dataset, `seriesDatasetId` only beside a split. A stored spec
//               without them sanitizes to what it did; `sameChart` tells a join from its plain twin; a follow-up carries it.
//   one door    a joined card's figures ARE the visual's for the same encoding and filters (`visual:data`, Object.is), and
//               go through `vizDataFor` once; a plain card never does (its own rows, as before). The reverse hop
//               (one → many) is refused with the planner's own sentence (joinPlan.findPath); NEGATIVE CONTROL: forward answers.
//   passes      chips keep the join and drill down the related dataset's hierarchy; Save as visual makes a visual of the same
//               encoding whose figures are the card's (its top-N cut too, bare or through its relationship); Add to
//               dashboard twice adds once, and the plain twin is not taken for it; a verified joined question marks only the
//               same join; the snapshot's print covers every table the join reads; the turn's `factsFrom` names the related
//               dataset; a follow-up's previous answer keeps the join and names it; Explain keeps a related category or
//               measure (scripts/test-answerJoinMeasures), and refuses a filter through a relationship (no spec has one).
//   prompt      the action line and the LINKED DATASETS block name "categoryDataset" / "seriesDataset".
//   ask         "Did you mean" for a category misspelt on the related dataset offers ITS columns and keeps the join (a
//               name it cannot teach there); a follow-up through copilot:ask ("now only open orders") keeps it.
//   mcp, facts  a related category marked personal is no label an MCP agent or a model reads; NEGATIVE CONTROL: unmarked.
// The route cases run on the file store (no database) and again on Postgres (DATABASE_URL), where, with real roles
// (./rowPolicyHarness), each side's access holds:
//   access      a viewer's joined card on two open datasets is the editor's and their own visual's; locked on the asked
//               dataset, refused `related` (and through copilot:ask the turn stays with the sentence); a related column
//               hidden from them refused; row rules on the RELATED dataset refused `related`, as their visual is. Each
//               with its NEGATIVE CONTROL (the editor or admin answers; a plain card answers).
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-answerJoins.js

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
const tableDocs: typeof import('../src/app/tableDocs') = require('../src/app/tableDocs');
const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const J: typeof import('../src/ai/answerJoin') = require('../src/ai/answerJoin');
const refine: typeof import('../src/ai/answerRefine') = require('../src/ai/answerRefine');
const suggested: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');
const linkedFacts: typeof import('../src/ai/linkedFacts') = require('../src/ai/linkedFacts');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const snapshots: typeof import('../src/ipc/answerSnapshots') = require('../src/ipc/answerSnapshots');
const joined: typeof import('../src/ipc/answerJoined') = require('../src/ipc/answerJoined');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const vLookup: typeof import('../src/ipc/verifiedLookup') = require('../src/ipc/verifiedLookup');

type Any = any; // any: each channel's own reply, read field by field
type ChartData = import('../src/analysis/vizData').ChartData;

/** Every figure of a chart by what it is of, so a ranked card and a visual in its own order compare. */
const figures = (d: ChartData): Map<string, unknown> => new Map(d.series.flatMap((s) => d.labels.map((l, i): [string, unknown] => [`${s.name}\u0000${String(l)}`, s.values[i]])));
const sameFigures = (a: ChartData | undefined, b: ChartData | undefined): boolean => {
  if (!a || !b) return false;
  const [fa, fb] = [figures(a), figures(b)];
  return fa.size > 0 && fa.size === fb.size && [...fa].every(([k, v]) => fb.has(k) && Object.is(v, fb.get(k)));
};

const T = (name: string) => ({ name, type: 'text' as const });
const SUM = [{ column: 'amount', aggregation: 'sum' as const }];

// ── the spec, pure ───────────────────────────────────────────────────────
function specCases(): void {
  const O = { id: randomUUID(), name: 'Orders', columns: [T('country_id'), T('continent'), T('status'), { name: 'amount', type: 'number' as const }] };
  const C = { id: randomUUID(), name: 'Countries', columns: [T('country_id'), T('country_name'), T('continent')] };
  const all = [O, C];
  const raw = { dataset: 'Orders', category: 'country_name', categoryDataset: 'Countries', measures: SUM };
  const v = A.validateAnswerSpec(raw, all);
  ok('spec: a related category named by its dataset\'s name resolves to that dataset\'s id and column', v.ok && v.spec.categoryDatasetId === C.id && v.spec.category === 'country_name', show(v));
  const byId = A.validateAnswerSpec({ ...raw, categoryDataset: undefined, categoryDatasetId: C.id }, all);
  ok('spec: …and by its id, the same spec', byId.ok && v.ok && JSON.stringify(byId.spec) === JSON.stringify(v.spec));
  const plain = A.validateAnswerSpec({ dataset: 'Orders', category: 'continent', measures: SUM }, all);
  const twin = A.validateAnswerSpec({ ...raw, category: 'continent' }, all);
  ok('spec: the same name on each side is two categories: the related one carries its dataset, the own one none', plain.ok && twin.ok && !plain.spec.categoryDatasetId && twin.spec.categoryDatasetId === C.id);
  const miss = A.validateAnswerSpec({ ...raw, category: 'status' }, all);
  ok('spec: a column of the asked dataset named on the related one is unknown THERE ("Did you mean" reads that dataset)', !miss.ok && miss.miss?.part === 'category' && miss.miss.datasetId === C.id, show(miss));
  const gone = A.validateAnswerSpec({ ...raw, categoryDataset: 'Planets' }, all);
  ok('spec: a related dataset that is none: refused, no "Did you mean" for the asked dataset', !gone.ok && gone.reason === 'Unknown dataset "Planets".' && !gone.miss, show(gone));
  const self = A.validateAnswerSpec({ dataset: 'Orders', category: 'continent', categoryDataset: 'Orders', measures: SUM }, all);
  ok('spec: the asked dataset named as the related one is its own column, no field', self.ok && plain.ok && JSON.stringify(self.spec) === JSON.stringify(plain.spec));
  const split = A.validateAnswerSpec({ dataset: 'Orders', category: 'status', series: 'continent', seriesDataset: 'Countries', measures: SUM }, all);
  ok('spec: a related split carries seriesDatasetId', split.ok && split.spec.seriesDatasetId === C.id && split.spec.series === 'continent' && !split.spec.categoryDatasetId, show(split));
  const same = A.validateAnswerSpec({ ...raw, category: 'continent', series: 'continent', seriesDataset: 'Countries' }, all);
  const across = A.validateAnswerSpec({ ...raw, category: 'continent', series: 'continent' }, all);
  ok('spec: the split cannot be the category on the same dataset; NEGATIVE CONTROL: the same name on the other side can', !same.ok && same.reason === 'The split cannot be the category.' && across.ok);
  const VIA = randomUUID();
  const via = A.validateAnswerSpec({ ...raw, categoryVia: VIA }, all);
  const viaAlone = A.validateAnswerSpec({ dataset: 'Orders', category: 'continent', categoryVia: VIA, measures: SUM }, all);
  ok('spec: categoryVia is kept only beside its dataset, and only as an id', via.ok && via.spec.categoryVia === VIA && viaAlone.ok && !viaAlone.spec.categoryVia
    && A.validateAnswerSpec({ ...raw, categoryVia: 'Ship country' }, all).ok && !(A.validateAnswerSpec({ ...raw, categoryVia: 'Ship country' }, all) as Any).spec.categoryVia);
  ok('spec: measures and filters stay the asked dataset\'s own: a related column there is unknown', !A.validateAnswerSpec({ ...raw, measures: [{ column: 'country_name', aggregation: 'count' }] }, all).ok
    && !A.validateAnswerSpec({ ...raw, filters: [{ column: 'country_name', op: '=', value: 'France' }] }, all).ok);

  if (split.ok && v.ok) {
    const both = { ...v.spec, series: 'continent', seriesDatasetId: C.id };
    ok('helpers: relatedIds names each related dataset once and never the asked one; ownNames leaves a related category and split out',
      JSON.stringify(J.relatedIds(both)) === JSON.stringify([C.id]) && JSON.stringify(J.relatedIds({ ...both, categoryDatasetId: O.id, seriesDatasetId: undefined })) === '[]'
      && JSON.stringify(J.ownNames(both)) === '["amount"]' && JSON.stringify(J.ownNames(split.spec)) === '["status","amount"]');
  }

  // Stored: the visual's whitelist.
  const base = { datasetId: O.id, category: 'country_name', measures: SUM, filters: [], chartType: 'column', title: 'x' };
  const kept = A.sanitizeStoredSpec({ ...base, categoryDatasetId: C.id, categoryVia: VIA, series: 'status', seriesDatasetId: C.id });
  ok('stored: the three fields are kept as ids', kept?.categoryDatasetId === C.id && kept.categoryVia === VIA && kept.seriesDatasetId === C.id, show(kept));
  const odd = A.sanitizeStoredSpec({ ...base, categoryDatasetId: '../x', categoryVia: VIA, seriesDatasetId: C.id });
  ok('stored: a non-id is dropped, and so is a via without its dataset and a seriesDatasetId without a split', !!odd && !('categoryDatasetId' in odd) && !('categoryVia' in odd) && !('seriesDatasetId' in odd), show(odd));
  ok('stored: a spec without them sanitizes to exactly what it did (no key added)', JSON.stringify(A.sanitizeStoredSpec(base)) === JSON.stringify({ ...base, title: 'X' }));
  if (!v.ok || !twin.ok || !plain.ok) return;
  const joinedSpec = v.spec;
  ok('sameChart: a join and its plain twin of the same names are two charts; the same join is one', !refine.sameChart({ ...twin.spec, title: 'a' }, { ...twin.spec, categoryDatasetId: undefined, title: 'a' })
    && refine.sameChart(joinedSpec, { ...joinedSpec, title: 'another title' }) && !refine.sameChart(twin.spec, plain.spec));
  ok('NEGATIVE CONTROL: sameChart still tells two plain charts apart', !refine.sameChart(plain.spec, { ...plain.spec, category: 'status' }));

  // A follow-up carries the join (./answerRefine), and drops it with the category it qualified.
  const r1 = A.validateAnswerSpec(refine.refineSpec(joinedSpec, { filters: [{ column: 'status', op: '=', value: 'open' }] }, O), all);
  ok('refine: a filter added keeps the related category', r1.ok && r1.spec.categoryDatasetId === C.id && r1.spec.category === 'country_name' && r1.spec.filters.length === 1, show(r1));
  const r2 = A.validateAnswerSpec(refine.refineSpec(joinedSpec, { category: 'status' }, O), all);
  ok('refine: a new own category drops it', r2.ok && r2.spec.category === 'status' && !r2.spec.categoryDatasetId, show(r2));
  const r3 = A.validateAnswerSpec(refine.refineSpec(plain.spec, { category: 'country_name', categoryDataset: 'Countries' }, O), all);
  ok('refine: a patch naming a related category takes it', r3.ok && r3.spec.categoryDatasetId === C.id, show(r3));
  const withSplit = A.validateAnswerSpec({ ...raw, series: 'continent', seriesDataset: 'Countries' }, all);
  const r4 = withSplit.ok ? A.validateAnswerSpec(refine.refineSpec(withSplit.spec, { series: null }, O), all) : withSplit;
  ok('refine: "series": null removes a related split and its dataset', withSplit.ok && r4.ok && !r4.spec.series && !r4.spec.seriesDatasetId, show(r4));

  // A verified question as a prompt example: a joined one is named by its datasets; one through a labelled relationship
  // is no example (a model names no relationship: its copy would draw the default path's chart).
  const pick: typeof import('../src/ai/verifiedPick') = require('../src/ai/verifiedPick');
  const state = (sp: object) => ({ q: { id: randomUUID(), question: 'q', phrasings: [], spec: sp }, problem: null, hidden: false, tag: '' }) as never;
  const names = { dataset: (id: string) => (id === C.id ? 'Countries' : 'Orders'), term: () => '' };
  ok('examples: a joined verified question is shown by name, its category\'s dataset with it', JSON.stringify(pick.rawSpec(joinedSpec, names)).includes('"categoryDataset":"Countries"')
    && pick.eligibleExample(state(joinedSpec), { withheld: () => new Set() }));
  ok('examples: one through a labelled relationship is left out; NEGATIVE CONTROL: the same without it is in', !pick.eligibleExample(state({ ...joinedSpec, categoryVia: randomUUID() }), { withheld: () => new Set() })
    && pick.eligibleExample(state(joinedSpec), { withheld: () => new Set() }));

  // The prompt: one call, the fields named, the block saying what they are for.
  ok('prompt: the action line names "categoryDataset", "seriesDataset" and a measure\'s or filter\'s own "dataset"', suggested.CHAT_SYSTEM_PROMPT.includes('"categoryDataset":"<its name>"')
    && suggested.CHAT_SYSTEM_PROMPT.includes('"seriesDataset":"<its name>"') && suggested.CHAT_SYSTEM_PROMPT.includes('"dataset":"<its name>" inside the measure or filter'));
  const block = linkedFacts.linkedBlock([{ schema: { name: 'Countries', columns: C.columns }, base: 'Orders', hops: [{ from: { dataset: 'Orders', column: 'country_id' }, to: { dataset: 'Countries', column: 'country_id' } }] }]);
  ok('prompt: the LINKED DATASETS block says a category, split, measure or filter may come from one, and no digit', block.text.includes('"categoryDataset"') && block.text.includes('a measure or a')
    && !block.text.includes('An answer reads ONE dataset') && !/\d/.test(block.text.split('\n').slice(0, 4).join('\n')), block.text);

  // Chips (pure): a related category's own hierarchy, never a same-named level of the asked dataset's.
  const GEO = { id: 'h', name: 'Geography', levels: ['continent', 'country_name'] };
  const cont = { ...joinedSpec, category: 'continent' };
  const chips = A.answerChips(cont, { columns: O.columns, splitCandidates: ['status'], hierarchies: [GEO], ladder: ['year', 'month', 'day'], category: C.columns });
  const down = chips.find((c) => c.label === 'By country_name');
  ok('chips: down the related dataset\'s hierarchy, the join kept', !!down && down.spec.category === 'country_name' && down.spec.categoryDatasetId === C.id, show(chips));
  ok('chips: every chip keeps the related category; the split one is an own column', chips.every((c) => c.spec.categoryDatasetId === C.id) && chips.find((c) => c.label === 'Split by status')?.spec.seriesDatasetId === undefined);
  const noCols = A.answerChips(cont, { columns: [...O.columns, T('country_name')], splitCandidates: [], hierarchies: [GEO], ladder: [] });
  ok('chips: NEGATIVE CONTROL: without the related dataset\'s columns the level is no chip, though the asked dataset has a column of that name', !noCols.some((c) => c.label.startsWith('By ')), show(noCols.map((c) => c.label)));
}

// ── over the route ───────────────────────────────────────────────────────
/** Where the route cases run: the file store with a dev admin (no database), or the row-policy world's Postgres as boss. */
interface Bench {
  /** In the org's context as the caller. */
  inCtx<R>(fn: () => Promise<R>): Promise<R>;
  /** A new project of the caller's. */
  project(name: string): Promise<string>;
  post(channel: string, payload: unknown): Promise<{ status: number; body: string; value: Any }>;
  close(): Promise<void>;
}

function fileBench(): Bench {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-answerjoins-'));
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
      return { status: r.statusCode, body: r.body, value: r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body) };
    },
    close: async () => fs.rmSync(DATA, { recursive: true, force: true }),
  };
}

function dbBench(W: RP.World): Bench {
  return {
    inCtx: (fn) => W.as('boss', fn),
    project: async (name) => (await W.call('boss', 'projects:create', { name })).body.id,
    post: async (channel, payload) => { const r = await W.call('boss', channel, payload); return { status: r.status, body: r.text, value: r.body }; },
    close: async () => undefined,
  };
}

async function routeCases(b: Bench): Promise<void> {
  const { inCtx, post } = b;
  const P0 = await b.project('Answer joins');
  const seed = await inCtx(async () => {
    const P = P0;
    const orders = (await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: [T('order_id'), T('country_id'), T('ship_country_id'), T('continent'), T('status'), { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }], rows: [
      ['o1', 'c1', 'c2', 'Team A', 'open', '2026-01-05', 10], ['o2', 'c2', 'c2', 'Team A', 'shipped', '2026-02-07', 5], ['o3', 'c1', 'c3', 'Team B', 'shipped', '2026-03-09', 7.5],
      ['o4', 'c3', 'c1', 'Team B', 'open', '2025-11-11', 3], ['o5', 'c4', 'c4', 'Team A', 'open', '2025-12-20', 2], ['o6', 'c2', 'c1', 'Team B', 'shipped', '2026-04-28', -0],
    ] }))!.id;
    const countries = (await datasets.saveDataset(P, { name: 'Countries', sourceKind: 'csv', columns: [T('country_id'), T('country_name'), T('continent')], rows: [['c1', 'France', 'Europe'], ['c2', 'Japan', 'Asia'], ['c3', 'Chile', 'America']] }))!.id;
    const byCountry = randomUUID(), byShip = randomUUID();
    await rels.saveRelationship(P, { id: byCountry, from: { datasetId: orders, column: 'country_id' }, to: { datasetId: countries, column: 'country_id' }, cardinality: 'many_to_one', verified: { matched: 5, unmatchedFrom: 1 } });
    await rels.saveRelationship(P, { id: byShip, from: { datasetId: orders, column: 'ship_country_id' }, to: { datasetId: countries, column: 'country_id' }, cardinality: 'many_to_one', label: 'Ship country', verified: { matched: 5, unmatchedFrom: 1 } });
    await tableDocs.setTableDoc(P, countries, { hierarchies: [{ id: randomUUID(), name: 'Geography', levels: ['continent', 'country_name'] }] } as never);
    return { P, orders, countries, byCountry, byShip };
  });
  const { P, orders, countries } = seed;
  const spec = (extra: object = {}) => ({ datasetId: orders, category: 'country_name', categoryDatasetId: countries, measures: SUM, filters: [], chartType: 'column', title: 'Amount by country', ...extra });
  const viz = async (encoding: object, filters: unknown[] = []) => (await post('visual:data', { projectId: P, datasetId: orders, encoding, filters })).value;

  // Spy on THE chart door, as the answer path calls it.
  const realDoor = visualsIpc.vizDataFor;
  let doors = 0;
  (visualsIpc as { vizDataFor: unknown }).vizDataFor = (...a: Parameters<typeof realDoor>) => { doors++; return realDoor(...a); };
  try {
    // ── one door ──
    doors = 0;
    const card = (await post('answer:card', { projectId: P, spec: spec() })).value;
    const asked = doors;
    const visual = await viz({ category: 'country_name', categoryDatasetId: countries, values: SUM });
    ok('door: the joined card answers, its spec keeping the join', card.ok === true && card.spec.categoryDatasetId === countries && card.data.labels.length === 4, show(card));
    ok('door: DIFFERENTIAL: the card\'s figures are the visual\'s for the same encoding (Object.is), the unmatched row\'s bar included', sameFigures(card.data, visual?.data), show([card.data, visual?.data]));
    ok('door: …and the figures are the join\'s (France 10 + 7.5, Japan 5 + -0, Chile 3, one unmatched 2)', figures(card.data).get('sum of amount\u0000France') === 17.5 && Object.is(figures(card.data).get('sum of amount\u0000Japan'), 5) && figures(card.data).get('sum of amount\u0000Chile') === 3, show(card.data));
    ok('door: the joined card went through vizDataFor (the chart door) exactly once', asked === 1, String(asked));
    doors = 0;
    const own = (await post('answer:card', { projectId: P, spec: { ...spec(), category: 'continent', categoryDatasetId: undefined } })).value;
    ok('door: a plain card never asks the chart door: today\'s path on its own rows', own.ok === true && doors === 0 && !('categoryDatasetId' in own.spec), `${doors} ${show(own.spec)}`);
    ok('door: NEGATIVE CONTROL: the plain twin (Orders\' own continent) is another chart', own.ok === true && !sameFigures(own.data, (await post('answer:card', { projectId: P, spec: spec({ category: 'continent' }) })).value.data));
    const filtered = (await post('answer:card', { projectId: P, spec: spec({ filters: [{ column: 'status', op: '=', value: 'open' }], series: 'continent', seriesDatasetId: countries }) })).value;
    const fViz = await viz({ category: 'country_name', categoryDatasetId: countries, series: 'continent', seriesDatasetId: countries, values: SUM }, filtered.steps);
    ok('door: DIFFERENTIAL with an own filter and a related split: the card is the visual of its steps (Object.is)', filtered.ok === true && sameFigures(filtered.data, fViz?.data), show([filtered.data, fViz?.data]));
    const shipped = (await post('answer:card', { projectId: P, spec: spec({ categoryVia: seed.byShip }) })).value;
    const sViz = await viz({ category: 'country_name', categoryDatasetId: countries, categoryVia: seed.byShip, values: SUM });
    ok('door: DIFFERENTIAL through a labelled relationship (categoryVia, Ship country): the visual\'s figures, not the default path\'s', shipped.ok === true && sameFigures(shipped.data, sViz?.data) && !sameFigures(shipped.data, card.data), show([shipped.data, card.data]));
    const dated = (await post('answer:card', { projectId: P, spec: { datasetId: orders, category: 'day', grain: 'month', series: 'continent', seriesDatasetId: countries, measures: [{ ...SUM[0], calc: { kind: 'running_total' } }], filters: [], chartType: 'line', title: 'Running' } })).value;
    const dViz = await viz({ category: 'day', grain: 'month', series: 'continent', seriesDatasetId: countries, values: SUM });
    ok('door: a related split under a date axis, a calc worked out on the door\'s totals', dated.ok === true && dated.data.labels.join() === dViz?.data?.labels?.join() && dated.data.series.length === dViz.data.series.length, show([dated.data, dViz?.data]));

    // A measure naming a saved metric: the door follows the metric as a visual's measure (planMetricMeasures), and a simple
    // metric of the column is that column's figure, so the card is the visual's AND the bare column's.
    const metric = (await post('metric:save', { projectId: P, input: { name: 'Revenue', datasetId: orders, definition: { column: 'amount', aggregation: 'sum' } } })).value;
    const metricId = metric.metric?.id ?? metric.id;
    const mCard = (await post('answer:card', { projectId: P, spec: spec({ measures: [{ ...SUM[0], metricId }] }) })).value;
    const mViz = await viz({ category: 'country_name', categoryDatasetId: countries, values: [{ ...SUM[0], metricId }] });
    ok('door: a measure named by a saved metric: the visual\'s figures through the door, and the bare column\'s (Object.is)', typeof metricId === 'string' && mCard.ok === true && sameFigures(mCard.data, mViz?.data) && sameFigures(mCard.data, card.data), show([mCard.data, mViz?.data]));

    // The reverse hop: one → many, refused with the planner's sentence.
    const reverse = (await post('answer:card', { projectId: P, spec: { datasetId: countries, category: 'status', categoryDatasetId: orders, measures: [{ column: 'country_id', aggregation: 'count' }], filters: [], chartType: 'column', title: 'x' } })).value;
    const names = new Map([[orders, 'Orders'], [countries, 'Countries']]);
    const planner = joinPlan.findPath(countries, orders, await inCtx(() => rels.listRelationships(P)), (id) => names.get(id) ?? id);
    ok('reverse: one → many is refused with the planner\'s own sentence, word for word', reverse.ok === false && !planner.ok && reverse.reason === planner.error && /inflated/.test(reverse.reason), show([reverse, planner]));
    ok('reverse: NEGATIVE CONTROL: the same planner reaches Countries from Orders', joinPlan.findPath(orders, countries, await inCtx(() => rels.listRelationships(P))).ok);
    const deleted = (await post('answer:card', { projectId: P, spec: spec({ categoryDatasetId: randomUUID() }) })).value;
    ok('door: a related dataset that is gone: the planner\'s refusal, never the asked dataset\'s same-named column', deleted.ok === false && deleted.reason === 'A related dataset no longer exists.', show(deleted));
    const goneColumn = (await post('answer:card', { projectId: P, spec: spec({ category: 'capital' }) })).value;
    ok('door: a related column no longer there says so, naming its dataset', goneColumn.ok === false && goneColumn.reason === '"capital" is no longer a column of Countries.', show(goneColumn));

    // ── chips ──
    const byContinent = (await post('answer:card', { projectId: P, spec: spec({ category: 'continent' }) })).value;
    const down = (byContinent.chips as Any[]).find((c) => c.label === 'By country_name');
    ok('chips: the card drills down Countries\' own hierarchy, keeping the join', !!down && down.spec.categoryDatasetId === countries, show(byContinent.chips));
    const chipped = down ? (await post('answer:rerun', { projectId: P, spec: down.spec, label: down.label })).value : null;
    ok('chips: the chip runs, its card the joined one\'s figures', chipped?.ok === true && sameFigures(chipped.turns.at(-1).card?.data, card.data), show(chipped));

    // ── Save as visual, its top-N cut ──
    const saved = (await post('answer:saveVisual', { projectId: P, spec: spec({ top: 2 }) })).value;
    const v = saved.ok ? (await post('visual:get', { projectId: P, id: saved.visual.id })).value : null;
    const topCard = (await post('answer:card', { projectId: P, spec: spec({ top: 2 }) })).value;
    const vData = v ? await viz(v.encoding, v.filters) : null;
    ok('save: the visual\'s encoding carries the join', v?.encoding?.categoryDatasetId === countries && v.encoding.category === 'country_name', show(v?.encoding));
    ok('save: DIFFERENTIAL: the saved visual draws the card\'s figures, its top 2 cut on Countries\' column (bare: its nearest owner)', sameFigures(vData?.data, topCard.data) && topCard.data.labels.length === 2 && v.filters.some((f: Any) => f.column === 'country_name' && f.op === 'in' && !f.via), show([vData?.data, topCard.data, v?.filters]));
    const savedVia = (await post('answer:saveVisual', { projectId: P, spec: spec({ top: 2, categoryVia: seed.byShip }) })).value;
    const vVia = savedVia.ok ? (await post('visual:get', { projectId: P, id: savedVia.visual.id })).value : null;
    const viaCard = (await post('answer:card', { projectId: P, spec: spec({ top: 2, categoryVia: seed.byShip }) })).value;
    ok('save: through a labelled relationship the cut names it (via), and the figures are the card\'s', vVia?.encoding?.categoryVia === seed.byShip && vVia.filters.some((f: Any) => f.via === seed.byShip) && sameFigures((await viz(vVia.encoding, vVia.filters))?.data, viaCard.data), show(vVia));

    // ── Add to dashboard, twice; and the plain twin ──
    const first = (await post('answer:addToDashboard', { projectId: P, spec: spec(), name: 'Joined board' })).value;
    const again = first.ok ? (await post('answer:addToDashboard', { projectId: P, spec: spec(), analysisId: first.dashboard.id })).value : null;
    const twin = first.ok ? (await post('answer:addToDashboard', { projectId: P, spec: spec({ category: 'continent', categoryDatasetId: undefined }), analysisId: first.dashboard.id })).value : null;
    const twinJoined = first.ok ? (await post('answer:addToDashboard', { projectId: P, spec: spec({ category: 'continent' }), analysisId: first.dashboard.id })).value : null;
    ok('dashboard: the same joined answer again is the tile already there', again?.ok === true && again.already === true && again.visual.id === first.visual.id, show(again));
    ok('dashboard: chartKey tells the join apart: Orders\' own continent and Countries\' continent are two tiles', twin?.ok === true && !twin.already && twinJoined?.ok === true && !twinJoined.already && twin.visual.id !== twinJoined.visual.id, show([twin, twinJoined]));

    // ── Verify: only the same join is marked ──
    const vq = (await post('verified:save', { projectId: P, input: { question: 'Amount by country name', spec: spec() } })).value;
    const marked = (await post('answer:card', { projectId: P, spec: spec() })).value;
    const unmarked = (await post('answer:card', { projectId: P, spec: spec({ category: 'continent', categoryDatasetId: undefined }) })).value;
    const otherJoin = (await post('answer:card', { projectId: P, spec: spec({ categoryVia: seed.byShip }) })).value;
    ok('verify: a joined question saves, keeping its join', vq.ok === true, show(vq));
    ok('verify: its card is marked; the plain chart and the same names through another relationship are not', marked.verified?.question === 'Amount by country name' && !unmarked.verified && !otherJoin.verified, show([marked.verified, unmarked.verified, otherJoin.verified]));
    const stored = await inCtx(async () => (await (require('../src/analysis/verifiedQuestions') as typeof import('../src/analysis/verifiedQuestions')).listBoth(P)).spec.find((t) => t.rec.question === 'Amount by country name'));
    const described = stored ? vLookup.describeVerified(P, stored.rec.id, JSON.stringify(stored.rec)) : [];
    ok('verify: its index row reads Orders and Countries (the folders\' WHERE)', described.length > 0 && described[0].datasetId === orders && JSON.stringify(described[0].reads) === JSON.stringify([orders, countries]), show(described));

    // ── MCP, and what a model reads: a related category marked personal is withheld as an own one is ──
    const mcp: typeof import('../src/automation/verifiedTools') = require('../src/automation/verifiedTools');
    const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
    const ctx = { projectId: P } as Parameters<typeof mcp.answerVerifiedQuestion>[0];
    await inCtx(async () => {
      const listed = (await mcp.listVerifiedQuestions(ctx)).questions.find((q) => q.question === 'Amount by country name');
      ok('mcp: a joined question offers no one-dataset `aggregate`, only answer_verified_question', !!listed && !listed.aggregate && !!listed.use, show(listed));
      const open = await mcp.answerVerifiedQuestion(ctx, 'Amount by country name');
      const factsOpen = await answers.computeCard(P, A.sanitizeStoredSpec(spec())!);
      await catalog.setColumn(P, countries, 'country_name', { sensitivity: 'personal' } as never);
      const shut = await mcp.answerVerifiedQuestion(ctx, 'Amount by country name').catch((e: Error) => e);
      const factsShut = await answers.computeCard(P, A.sanitizeStoredSpec(spec())!);
      await catalog.setColumn(P, countries, 'country_name', { sensitivity: null } as never);
      ok('mcp: NEGATIVE CONTROL: unmarked, the agent reads Countries\' labels', open.labels.includes('France'), show(open));
      ok('mcp: marked personal ON Countries, the agent reads no label of it (masked, or refused)', shut instanceof Error || !shut.labels.includes('France'), show(shut));
      ok('facts: marked personal on Countries, the model\'s facts name no label of it; NEGATIVE CONTROL: unmarked they do',
        'card' in factsOpen && 'card' in factsShut && factsOpen.factsText.includes('France') && !factsShut.factsText.includes('France'), show(['card' in factsShut ? factsShut.factsText : factsShut]));
    });

    // ── snapshots: what decides the figures, on every table read ──
    await inCtx(async () => {
      const reads = await joined.answerReads(P, A.sanitizeStoredSpec(spec())!);
      const print = await snapshots.answerAccessPrint(P, A.sanitizeStoredSpec(spec())!);
      ok('snapshot: a joined answer reads Orders and Countries, and its print is theirs together', JSON.stringify(reads) === JSON.stringify([orders, countries]) && print === await snapshots.sqlAccessPrint(P, [orders, countries]));
      ok('snapshot: a plain answer\'s print is its dataset\'s, exactly as before', await snapshots.answerAccessPrint(P, A.sanitizeStoredSpec({ ...spec(), categoryDatasetId: undefined })!) === await snapshots.accessPrint(P, orders));
      ok('snapshot: NEGATIVE CONTROL: the two prints differ', print !== await snapshots.accessPrint(P, orders));
    });

    // ── the turn: factsFrom, the previous answer ──
    const ran = (await post('answer:rerun', { projectId: P, spec: spec(), label: 'amount by country name' })).value;
    const plainRan = (await post('answer:rerun', { projectId: P, spec: { ...spec(), category: 'continent', categoryDatasetId: undefined }, label: 'amount by team' })).value;
    await inCtx(async () => {
      const turns = await copilot.loadHistory(P, ran.threadId);
      const t = turns.filter((x) => x.role === 'assistant').at(-2); // the joined one; the plain one after it
      const tp = turns.filter((x) => x.role === 'assistant').at(-1);
      ok('turn: a joined answer\'s factsFrom names the related dataset (0039\'s SQL count reads it)', t?.answer?.categoryDatasetId === countries && JSON.stringify(t.factsFrom) === JSON.stringify([countries]), show(t));
      ok('turn: NEGATIVE CONTROL: a plain answer from a chip stores no factsFrom, as before', plainRan.ok === true && !tp?.answer?.categoryDatasetId && tp?.factsFrom === undefined, show(tp));
      const prev = await answers.previousAnswer(P, turns.slice(0, -2));
      ok('follow-up: the previous answer keeps the join and tells the model where the category comes from', prev?.spec.categoryDatasetId === countries && prev.block.includes('category "country_name" from "Countries"'), show(prev));
    });

    // ── "Did you mean" and a follow-up, through the ask (the model stubbed: one call each) ──
    const answerCheck: typeof import('../src/ipc/answerCheck') = require('../src/ipc/answerCheck');
    const meant = await inCtx(() => answerCheck.checkAction(P, {}, { kind: 'answer', intent: 'q', spec: { dataset: 'Orders', category: 'countri_name', categoryDataset: 'Countries', measures: SUM } }, 'q'));
    const option = !meant.ok && 'suggest' in meant ? meant.suggest?.options[0] : undefined;
    ok('did you mean: a category misspelt on the related dataset is offered from ITS columns, the option keeping the join', option?.spec.category === 'country_name' && option.spec.categoryDatasetId === countries, show(meant));
    const optRun = option ? (await post('answer:rerun', { projectId: P, spec: option.spec, label: option.label, learn: { said: 'countri_name', column: 'country_name' } })).value : null;
    const optTurn = optRun?.turns?.at(-1);
    ok('did you mean: the option draws the joined chart, and teaches no name on the asked dataset for a related column', optRun?.ok === true && sameFigures(optTurn?.card?.data, card.data) && !optTurn?.learn, show(optTurn));
    const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
    const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
    const real = { ask: analyze.askCopilot, ready: execConfig.executionReady, on: execConfig.assistantOn };
    let action: unknown = null;
    let calls = 0;
    (analyze as { askCopilot: unknown }).askCopilot = async () => { calls++; return { ok: true, text: 'Here it is.', suggestedAction: action }; };
    (execConfig as { executionReady: unknown }).executionReady = async () => true;
    (execConfig as { assistantOn: unknown }).assistantOn = () => true;
    try {
      const threadId = (await post('copilot:newThread', { projectId: P })).value.thread.id;
      const ask = async (question: string, a: unknown) => { action = a; return (await post('copilot:ask', { projectId: P, threadId, context: { kind: 'dataset', id: orders }, question })).value; };
      const first = await ask('the amount for each country name', { kind: 'answer', intent: 'amount by country name', spec: { dataset: 'Orders', category: 'country_name', categoryDataset: 'Countries', measures: SUM } });
      const then = await ask('now only open orders', { kind: 'answer', intent: 'amount by country name, open orders', spec: { refine: true, filters: [{ column: 'status', op: '=', value: 'open' }] } });
      const t = then.turns?.at(-1);
      ok('follow-up: the ask\'s first answer is the joined chart, in one call', first.ok === true && first.turns?.at(-1)?.answer?.categoryDatasetId === countries, show(first));
      ok('follow-up: "now only open orders" refines it: the join kept, the filter added, two calls in all', then.ok === true && t?.answer?.categoryDatasetId === countries && t.answer.filters.length === 1 && calls === 2, `${calls} ${show(t?.answer)}`);
      const openViz = await viz({ category: 'country_name', categoryDatasetId: countries, values: SUM }, t?.card?.steps ?? []);
      ok('follow-up: DIFFERENTIAL: the refined card is the visual of its steps (Object.is)', sameFigures(t?.card?.data, openViz?.data), show([t?.card?.data, openViz?.data]));
    } finally {
      (analyze as { askCopilot: unknown }).askCopilot = real.ask;
      (execConfig as { executionReady: unknown }).executionReady = real.ready;
      (execConfig as { assistantOn: unknown }).assistantOn = real.on;
    }

    // ── Explain ──
    const relatedVisual = (await post('visual:save', { projectId: P, datasetId: orders, name: 'By country', chartType: 'column', encoding: { category: 'country_name', categoryDatasetId: countries, values: SUM } })).value;
    const explained = (await post('answer:explain', { projectId: P, visualId: relatedVisual.id ?? relatedVisual.visual?.id })).value;
    const explainedTurn = explained.ok ? await inCtx(async () => (await copilot.loadHistory(P, explained.threadId)).at(-1)) : null;
    ok('explain: a visual with a related category is explained with its join', explained.ok === true && explainedTurn?.answer?.categoryDatasetId === countries, show([explained, explainedTurn?.answer]));
    const measureVisual = (await post('visual:save', { projectId: P, datasetId: countries, name: 'Orders by country', chartType: 'column', encoding: { category: 'country_name', values: [{ column: 'amount', aggregation: 'sum', datasetId: orders }] } })).value;
    const kept = (await post('answer:explain', { projectId: P, visualId: measureVisual.id ?? measureVisual.visual?.id })).value;
    const keptTurn = kept.ok ? await inCtx(async () => (await copilot.loadHistory(P, kept.threadId)).at(-1)) : null;
    ok('explain: one with a related (many-side) MEASURE is explained with it (scripts/test-answerJoinMeasures), never the asked dataset\'s same-named column', kept.ok === true && keptTurn?.answer?.measures[0].datasetId === orders, show([kept, keptTurn?.answer]));
    const viaFilter = (await post('visual:save', { projectId: P, datasetId: orders, name: 'Via filter', chartType: 'column', encoding: { category: 'status', values: SUM }, filters: [{ type: 'filter', column: 'country_name', op: '=', value: 'France', via: seed.byShip }] })).value, refused = (await post('answer:explain', { projectId: P, visualId: viaFilter.id ?? viaFilter.visual?.id })).value;
    ok('explain: NEGATIVE CONTROL: one with a filter through a relationship is refused (a spec\'s filter has no via)', refused.ok === false && refused.reason === 'This chart cannot be explained.', show(refused));
  } finally {
    (visualsIpc as { vizDataFor: unknown }).vizDataFor = realDoor;
    await b.close();
  }
}

// ── access, with real roles (DATABASE_URL): each side's row rules, hidden columns and lock ─────────────────────
async function accessCases(W: RP.World): Promise<void> {
  const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
  const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
  const msg: typeof import('../src/data/rowPolicyError') = require('../src/data/rowPolicyError');
  const P = W.P;
  const names = await W.as('boss', async () => {
    const id = (await datasets.saveDataset(P, { name: 'Region names', sourceKind: 'csv', columns: [T('region'), T('label')], rows: [['East', 'Eastern'], ['West', 'Western'], ['North', 'Northern']] }))!.id;
    for (const from of [W.plain, W.orders]) await rels.saveRelationship(P, { id: randomUUID(), from: { datasetId: from, column: 'region' }, to: { datasetId: id, column: 'region' }, cardinality: 'many_to_one', verified: { matched: 1, unmatchedFrom: 0 } });
    return id;
  });
  const on = (datasetId: string, category = 'label') => ({ datasetId, category, categoryDatasetId: names, measures: [{ column: 'sales', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Sales by region name' });
  const card = (who: string, spec: object) => W.call(who, 'answer:card', { projectId: P, spec });
  const viz = (who: string, datasetId: string, category = 'label') => W.call(who, 'visual:data', { projectId: P, datasetId, encoding: { category, categoryDatasetId: names, values: [{ column: 'sales', aggregation: 'sum' }] }, filters: [] });
  const typed = (r: RP.Reply, reason: 'related' | 'hidden' | 'columns'): boolean =>
    r.status === 200 && r.body?.ok === false && r.body.code === 'row_policy' && r.body.error === msg.rowPolicyRefusal(reason).error && !RP.leaks(r.text);
  const same = (a: RP.Reply, b: RP.Reply): string => (a.body?.ok !== true || b.body?.ok !== true ? `not answered: ${a.text.slice(0, 160)} | ${b.text.slice(0, 160)}` : RP.diff(a.body.data, b.body.data, {}));

  // Plain and Region names have no rules: the viewer's joined card is the editor's, and their own visual's.
  const east = await card('east', on(W.plain));
  ok('access: a viewer\'s joined card on two open datasets is the editor\'s, Object.is', same(east, await card('ed', on(W.plain))) === '', same(east, await card('ed', on(W.plain))));
  const eastViz = await viz('east', W.plain);
  ok('access: …and their own visual of that encoding (the one door), figure by figure', east.body?.ok === true && sameFigures(east.body.data, eastViz.body?.data), show([east.body?.data, eastViz.body?.data]));

  // A viewer LOCKED on the asked dataset (Orders' rules): the door refuses a question that reaches another dataset.
  const locked = await card('east', on(W.orders));
  ok('access: a viewer row rules lock on the asked dataset gets the joined card refused, typed `related`, no figure', typed(locked, 'related'), locked.text.slice(0, 240));
  ok('access: NEGATIVE CONTROL: the same viewer\'s plain card on Orders answers, locked to their rows', (await card('east', { ...on(W.orders), category: 'region', categoryDatasetId: undefined })).body?.ok === true);
  ok('access: NEGATIVE CONTROL: the editor\'s joined card on Orders answers', (await card('ed', on(W.orders))).body?.ok === true);
  // …and through the ask: the turn stays, with the reason, never a failed ask.
  const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
  const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
  const real = { ask: analyze.askCopilot, ready: execConfig.executionReady, on: execConfig.assistantOn };
  let action: unknown = null;
  (analyze as { askCopilot: unknown }).askCopilot = async () => ({ ok: true, text: 'Here it is.', suggestedAction: action });
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (execConfig as { assistantOn: unknown }).assistantOn = () => true;
  try {
    const ask = async (spec: object) => {
      action = { kind: 'answer', intent: 'sales by region name', spec };
      const threadId = (await W.call('east', 'copilot:newThread', { projectId: P })).body.thread.id;
      return W.call('east', 'copilot:ask', { projectId: P, threadId, context: { kind: '' }, question: 'sales by region name' }); // from Home: a dataset page's facts read the whole dataset (refused `reader` for them)
    };
    const asked = await ask({ dataset: W.orders, category: 'label', categoryDataset: 'Region names', measures: [{ column: 'sales', aggregation: 'sum' }] });
    const t = asked.body?.turns?.at(-1);
    ok('access: through copilot:ask the locked viewer keeps the turn: no chart, the refusal\'s sentence, nothing of West', asked.status === 200 && asked.body?.ok === true && !t?.answer
      && String(asked.body.answer).includes(`(No chart: ${msg.rowPolicyRefusal('related').error})`) && !RP.leaks(asked.text), asked.text.slice(0, 300));
    const plainAsk = await ask({ dataset: W.orders, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }] });
    ok('access: NEGATIVE CONTROL: the same viewer\'s plain ask on Orders draws its chart', plainAsk.body?.ok === true && !!plainAsk.body.turns?.at(-1)?.answer, plainAsk.text.slice(0, 200));
  } finally {
    (analyze as { askCopilot: unknown }).askCopilot = real.ask;
    (execConfig as { executionReady: unknown }).executionReady = real.ready;
    (execConfig as { assistantOn: unknown }).assistantOn = real.on;
  }

  // Kept cards (../src/ipc/answerSnapshots): the viewer's joined answer and a plain one on Plain, before any rule on Region names.
  const keep = async (spec: object) => {
    const threadId = (await W.call('east', 'copilot:newThread', { projectId: P })).body.thread.id as string; // each its own: a rerun lands in the latest otherwise
    return (await W.call('east', 'answer:rerun', { projectId: P, threadId, spec, label: 'sales by region name' })).body?.threadId as string;
  };
  const keptJoined = await keep(on(W.plain));
  const keptPlain = await keep({ ...on(W.plain), category: 'region', categoryDatasetId: undefined });
  const cardIn = async (threadId: string) => !!(await W.call('east', 'copilot:history', { projectId: P, threadId })).body?.turns?.at(-1)?.card;
  ok('setup: both kept cards come back with their conversation, each its own', keptJoined !== keptPlain && (await cardIn(keptJoined)) && (await cardIn(keptPlain)));

  // A column of Region names hidden from the viewer: grouping by it is refused, typed; another of its columns still joins.
  const plant = (rules: object[]) => W.as('boss', () => rec.serialized(rec.datasetFilePath(P, names), (raw) => {
    raw.columnAccess = access.buildColumnAccess(raw, rules as never, 'boss@acme.test', new Date().toISOString());
    return true;
  }));
  await plant([{ column: 'label', visibleTo: [{ teamId: randomUUID() }] }]);
  const hidden = await card('east', on(W.plain));
  ok('access: a related column hidden from the viewer: their joined card by it is refused, typed, no label of it', hidden.status === 200 && hidden.body?.ok === false && hidden.body.code === 'row_policy' && !/Eastern|Western|Northern/.test(hidden.text), hidden.text.slice(0, 240));
  ok('access: NEGATIVE CONTROL: the admin, who sees it, gets the card', (await card('boss', on(W.plain))).body?.ok === true);
  ok('access: NEGATIVE CONTROL: the viewer still joins by a column of it they see', (await card('east', on(W.plain, 'region'))).body?.ok === true);
  await plant([]);

  // Row rules on Region names that give the viewer's team its East row only: a joined card reads it, so it is refused.
  const set = await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: names, policy: { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } });
  if (set.body?.ok !== true) throw new Error(`setup: rules on Region names: ${set.text}`);
  const ruled = await card('east', on(W.plain));
  ok('access: row rules on the RELATED dataset: the viewer\'s joined card on an open dataset is refused, typed `related`', typed(ruled, 'related'), ruled.text.slice(0, 240));
  const ruledViz = await viz('east', W.plain);
  ok('access: …as their visual of the same encoding is (the one door)', ruledViz.body?.ok === false && ruledViz.body.code === 'row_policy', ruledViz.text.slice(0, 200));
  ok('access: NEGATIVE CONTROL: the editor\'s joined card answers', (await card('ed', on(W.plain))).body?.ok === true);
  ok('snapshot: the rule on Region names changed what decides the joined card: it comes back without its kept card (computed again on open)', !(await cardIn(keptJoined)));
  ok('snapshot: NEGATIVE CONTROL: the plain card on Plain, which reads no Region names, keeps its card', await cardIn(keptPlain));
}

(async () => {
  specCases();
  if (!process.env.DATABASE_URL) {
    await routeCases(fileBench());
    console.log('skip the joined answers\' access cases: DATABASE_URL is unset (roles need Postgres)');
    return;
  }
  const W = await RP.world('answer joins');
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
