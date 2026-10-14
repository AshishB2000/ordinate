// "Save as visual" on an answer card — `answer:saveVisual` (src/ipc/answers.ts,
// src/ipc/answerSave.ts) over the real RPC route, in server mode.
//
//   1. ACCESS. `write`, project-scoped, a strict input: a project VIEWER is
//      refused before the handler (authorize, a grant table standing in for
//      Postgres) — NEGATIVE CONTROL: the same viewer may draw the card. Over the
//      route, a member with no grant is a 403 and nothing is saved.
//   2. DIFFERENTIAL. For every shape of answer — a relative period, a value
//      fixed in case, a value the app matched, a top-N, a date axis, a split —
//      the saved visual's `visual:data` is, figure for figure (Object.is), the
//      card's chart data. NEGATIVE CONTROL: without the top-N's filter it is
//      another chart.
//   3. THE SERVER decides what is saved: the name, the type, the encoding and
//      the filter steps are rebuilt from the spec — steps or an encoding a
//      client slips into the spec change nothing. A period is saved as the
//      dates it resolved to. The save goes through the door `visual:save` takes
//      (one version recorded, as a visual saved there has).
//   4. REFUSALS: a spec that cannot be read, a dataset that is gone — nothing saved.
//
// A Live dataset's save is exercised with every other row reader: test-liveSafetyNet.
//
//   npm run build:ts && node scripts/test-answerSaveVisual.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-answersave-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const api: typeof import('../src/api/index') = require('../src/api/index');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');

type Identity = import('../src/server/context').Identity;
type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type ChartData = import('../src/analysis/vizData').ChartData;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };

const show = (v: unknown): string => JSON.stringify(v);
const COLUMNS: ParsedColumn[] = [{ name: 'order_date', type: 'date' }, { name: 'category', type: 'text' }, { name: 'region', type: 'text' }, { name: 'net_sales', type: 'number' }];
const ROWS: Cell[][] = [
  ['2024-10-02', 'Technology', 'West', 1234.5], ['2024-11-15', 'Furniture', 'East', 987.25], ['2024-12-20', 'Technology', 'East', 456.75],
  ['2024-12-05', 'Office Supplies', 'West', 55.5], ['2024-11-03', 'Technology', 'North', 2468.25], ['2024-10-09', 'Technology', 'South', 10.5],
  ['2023-11-03', 'Technology', 'West', 999], ['2024-06-03', 'Technology', 'West', 77],
];

/** Every figure of a chart by what it is of — series and category — so two charts compare whatever their order. */
const figures = (d: ChartData): Map<string, unknown> =>
  new Map(d.series.flatMap((s) => d.labels.map((l, i): [string, unknown] => [`${s.name}\u0000${String(l)}`, s.values[i]])));
const sameFigures = (a: ChartData, b: ChartData): boolean => {
  const fa = figures(a);
  const fb = figures(b);
  return fa.size > 0 && fa.size === fb.size && [...fa].every(([k, v]) => fb.has(k) && Object.is(v, fb.get(k)));
};

(async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Keep an answer')).id;
    const ds = await datasets.saveDataset(projectId, { name: 'Orders', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
    if (!ds) throw new Error('fixture not saved');
    return { projectId, datasetId: ds.id };
  });
  // A dataset with a category really called "Other" — a cell's text, not the fold of a long tail.
  const kinds = await context.runInContext(ADMIN, 'seed', async () => (await datasets.saveDataset(seed.projectId, {
    name: 'Kinds', sourceKind: 'csv', columns: [{ name: 'kind', type: 'text' }, { name: 'amount', type: 'number' }],
    rows: [['Other', 100], ['Chairs', 50], ['Desks', 30], ['Lamps', 10], ['Rugs', 5]],
  }))!.id);
  const P = seed.projectId;
  const appFor = (who: Identity) => appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => who);
  const admin = appFor(ADMIN);
  const post = async (channel: string, payload: unknown, app = admin) => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    return { status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: each reply is narrowed by the check that reads it
  };
  const count = async (): Promise<number> => ((await post('visual:list', { projectId: P })).value as unknown[]).length;

  const MEASURES = [{ column: 'net_sales', aggregation: 'sum' }];
  // As a turn stores it after the app matched "tech": a period, the matched value, and a value in another case.
  const SPEC = {
    datasetId: seed.datasetId, category: 'region', measures: MEASURES, chartType: 'column', title: 'Tech revenue by region',
    filters: [{ column: 'order_date', period: 'last_quarter' }, { column: 'category', op: '=', value: 'Technology' }, { column: 'region', op: '!=', value: 'south' }],
    matched: [{ column: 'category', said: 'tech', value: 'Technology' }],
  };

  // ── 1. Access ─────────────────────────────────────────────────────────────
  const contract = api.contracts['answer:saveVisual'];
  const input = { projectId: P, spec: SPEC };
  ok('contract: write, project-scoped by projectId', contract.access === 'write' && 'project' in contract && contract.project(input) === P);
  ok('contract: a strict input — steps, an encoding or a name beside the spec are refused, as is a spec without a dataset id',
    contract.input.safeParse(input).success && !contract.input.safeParse({ ...input, steps: [] }).success && !contract.input.safeParse({ ...input, encoding: {} }).success
    && !contract.input.safeParse({ ...input, name: 'x' }).success && !contract.input.safeParse({ projectId: P, spec: { category: 'region' } }).success);
  // The grant lookup is one Postgres query; a table answering one rank stands in for it.
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: Identity, channel: 'answer:saveVisual' | 'answer:card', rank: number) =>
    context.runInContext(who, 'authz', () => authz.authorize(api.contracts[channel], input, who, grants(rank)));
  ok('access: a project VIEWER may not save an answer as a visual', !(await decide(VIEWER, 'answer:saveVisual', 1)).ok);
  ok('access NEGATIVE CONTROL: the same viewer may draw the card', (await decide(VIEWER, 'answer:card', 1)).ok);
  ok('access: a project editor may save it', (await decide(EDITOR, 'answer:saveVisual', 2)).ok);
  const viewerApp = appFor(VIEWER);
  const denied = await post('answer:saveVisual', input, viewerApp);
  ok('route: a member without a grant gets a 403, and nothing is saved', denied.status === 403 && (await count()) === 0, `${denied.status} ${denied.body}`);
  ok('route: steps sent beside the spec are a 400, and nothing is saved',
    (await post('answer:saveVisual', { ...input, steps: [{ type: 'filter', column: 'region', op: '=', value: 'East' }] })).status === 400 && (await count()) === 0);
  await viewerApp.close();

  // ── 2. Differential: the saved visual draws what the card drew ────────────
  /** Save `spec`; hand back the card it was saved from, the stored visual and that visual's own `visual:data`. */
  const keep = async (spec: unknown) => {
    const card = (await post('answer:card', { projectId: P, spec })).value;
    const saved = await post('answer:saveVisual', { projectId: P, spec });
    const visual = saved.value?.ok ? (await post('visual:get', { projectId: P, id: saved.value.visual.id })).value : null;
    const data = visual ? (await post('visual:data', { projectId: P, datasetId: visual.datasetId, encoding: visual.encoding, filters: visual.filters })).value : null;
    return { card, saved, visual, data };
  };

  const one = await keep(SPEC);
  ok('save: ok, and the reply is the new visual\'s id and name — nothing else',
    one.saved.status === 200 && one.saved.value.ok === true && show(Object.keys(one.saved.value.visual)) === '["id","name"]' && /^[0-9a-f-]{36}$/.test(one.saved.value.visual.id), one.saved.body);
  ok('save: the card had figures to keep (the check is not vacuous)', one.card.ok && one.card.data.labels.join() === 'North,West,East' && one.card.data.series[0].values.every((v: unknown) => typeof v === 'number'), show(one.card.data));
  ok('differential: the saved visual\'s visual:data equals the card\'s chart data — a period, a matched value and a value fixed in case (Object.is on every figure)',
    !!one.data && one.data.ok === true && sameFigures(one.data.data, one.card.data), show([one.data?.data, one.card.data]));
  ok('save: the card\'s title is the name, the card\'s chart type the type, ranked as the card ranks',
    one.visual.name === 'Tech revenue by region' && one.visual.chartType === one.card.chartType && one.visual.overrides.sort === 'desc', show(one.visual));

  const top = await keep({ ...SPEC, top: 2 });
  ok('differential: a top-N card — the visual holds the same two categories and their figures',
    top.card.data.labels.join() === 'North,West' && !!top.data && sameFigures(top.data.data, top.card.data), show([top.data?.data, top.card.data]));
  ok('differential: …where the visual saved without the cut is another chart (negative control)', !sameFigures(one.data.data, top.card.data));

  const dated = await keep({ datasetId: seed.datasetId, category: 'order_date', grain: 'month', measures: MEASURES, chartType: 'line', title: 'Tech revenue by month', filters: [{ column: 'category', op: '=', value: 'technology' }] });
  ok('differential: a date axis — the same periods in the same order, and no ranking saved',
    dated.card.data.labels.length >= 4 && !!dated.data && sameFigures(dated.data.data, dated.card.data)
    && dated.card.data.labels.every((l: unknown, i: number) => Object.is(l, dated.data.data.labels[i])) && dated.visual.overrides.sort === undefined && dated.visual.encoding.grain === 'month', show([dated.data?.data, dated.card.data]));

  const split = await keep({ ...SPEC, series: 'category', chartType: 'stacked_column', filters: [{ column: 'order_date', period: 'last_quarter' }] });
  ok('differential: a split — every series and every figure', split.card.data.series.length === 3 && !!split.data && sameFigures(split.data.data, split.card.data) && split.visual.encoding.series === 'category', show([split.data?.data, split.card.data]));

  const other = await keep({ datasetId: kinds, category: 'kind', measures: [{ column: 'amount', aggregation: 'sum' }], top: 2, chartType: 'column', title: 'Amount by kind', filters: [] });
  ok('differential: a top-N that keeps a category really called "Other" — it is a cell\'s text, so the cut is saved and the visual holds the same two',
    other.card.data.labels.join() === 'Other,Chairs' && !!other.data && sameFigures(other.data.data, other.card.data)
    && show(other.visual.filters) === show([{ type: 'filter', column: 'kind', op: 'in', values: ['Other', 'Chairs'] }]), show([other.data?.data, other.card.data]));

  // A stored spec is saved as it stands — the card the person saw — never matched loosely as an answer just written is.
  const asIs = await keep({ ...SPEC, filters: [{ column: 'category', op: '!=', value: 'tech' }], matched: undefined });
  ok('stored: a value a unique prefix would match is NOT matched on save — the card\'s step keeps "tech", and so does the visual',
    asIs.card.ok && !('matched' in asIs.card.spec) && show(asIs.card.steps) === show([{ type: 'filter', column: 'category', op: '!=', value: 'tech' }])
    && show(asIs.visual.filters) === show(asIs.card.steps) && !!asIs.data && sameFigures(asIs.data.data, asIs.card.data), show([asIs.card.steps, asIs.visual?.filters]));
  const cardOf = async (filters: unknown[]): Promise<ChartData> => (await post('answer:card', { projectId: P, spec: { ...SPEC, filters, matched: undefined } })).value.data;
  ok('stored: …so the visual counts every row, Technology\'s among them — the chart unfiltered, not the chart without Technology (negative control)',
    !!asIs.data && sameFigures(asIs.data.data, await cardOf([])) && !sameFigures(asIs.data.data, await cardOf([{ column: 'category', op: '!=', value: 'Technology' }])));

  // ── 3. The server decides what is saved ───────────────────────────────────
  ok('server: the encoding is the spec\'s names', show(one.visual.encoding) === show({ category: 'region', values: MEASURES }), show(one.visual.encoding));
  ok('server: the filters are the card\'s own steps — the period as the dates it resolved to, the values as the data holds them',
    show(one.visual.filters) === show(one.card.steps) && show(one.visual.filters) === show([
      { type: 'filter', column: 'order_date', op: '>=', value: '2024-10-01' }, { type: 'filter', column: 'order_date', op: '<=', value: '2024-12-31' },
      { type: 'filter', column: 'category', op: '=', value: 'Technology' }, { type: 'filter', column: 'region', op: '!=', value: 'South' },
    ]), show(one.visual.filters));
  ok('server: a top-N is saved as a filter to the categories the card kept',
    show(top.visual.filters) === show([...top.card.steps, { type: 'filter', column: 'region', op: 'in', values: ['North', 'West'] }]), show(top.visual.filters));
  const slipped = await keep({ ...SPEC, steps: [{ type: 'filter', column: 'region', op: '=', value: 'East' }], encoding: { category: 'category', values: [] }, name: 'Mine', overrides: { sort: 'asc' } });
  ok('server: steps, an encoding, a name or overrides slipped into the spec change nothing',
    slipped.saved.value.ok === true && show([slipped.visual.name, slipped.visual.chartType, slipped.visual.encoding, slipped.visual.filters, slipped.visual.overrides])
    === show([one.visual.name, one.visual.chartType, one.visual.encoding, one.visual.filters, one.visual.overrides]), show(slipped.visual));
  const byDoor = (await post('visual:save', { projectId: P, datasetId: seed.datasetId, name: 'By hand', chartType: 'column', encoding: { category: 'region', values: MEASURES } })).value;
  const versionsOf = async (id: string): Promise<number> => ((await post('versions:list', { projectId: P, type: 'visual', id })).value as unknown[]).length;
  ok('server: it went through the door visual:save takes — one version recorded, as a visual saved there has',
    (await versionsOf(one.visual.id)) === 1 && (await versionsOf(byDoor.id)) === 1, `${await versionsOf(one.visual.id)} ${await versionsOf(byDoor.id)}`);

  // ── 4. Refusals ───────────────────────────────────────────────────────────
  const before = await count();
  const unread = await post('answer:saveVisual', { projectId: P, spec: { datasetId: seed.datasetId, category: 'region' } });
  ok('refused: a spec that cannot be read', unread.status === 200 && unread.value.ok === false && unread.value.reason === 'This answer could not be read.', unread.body);
  const gone = await post('answer:saveVisual', { projectId: P, spec: { ...SPEC, datasetId: '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d' } });
  ok('refused: a dataset that is gone', gone.status === 200 && gone.value.ok === false && typeof gone.value.reason === 'string', gone.body);
  const dropped = await post('answer:saveVisual', { projectId: P, spec: { ...SPEC, category: 'territory' } });
  ok('refused: a column that is gone, in the card\'s own words', dropped.value.ok === false && dropped.value.reason === '"territory" is no longer a column of Orders.', dropped.body);
  ok('refused: nothing was saved by any of them', (await count()) === before, String(await count()));

  await admin.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
