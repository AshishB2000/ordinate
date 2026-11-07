// A dbt Semantic Layer dataset (BETA) through the three doors (semantic layer part 7, d1;
// docs/live-data/dbt-semantic-layer.md): the SHIPPED `dbt-semantic-layer` connector and encoder — not a test connector —
// over the real RPC route (scripts/liveRouteHarness.ts), dbt Cloud played by the fake GraphQL API
// (scripts/semanticFakeDbt.ts, through the connector's `setTransport`): every createQuery decoded as dbt would read it
// and answered over the parity fixture as jsonResult pages.
//
//   § doors     Connections lists the saved queries, Add as dataset, the sync's mirrors; charts, "Other", a month axis
//               under a relative period, a split, a filter, a batch, KPI tiles and a comparison,
//               metric:values, answer:card and a value list, each equal to the extract's with equal Ordinate metrics
//               (Object.is; sum/avg within 1e-13); a saved query's own filter applied (NEGATIVE CONTROL: it changes the
//               figure); every value only in where text; NEGATIVE CONTROL a filtered dbt chart is not the unfiltered one
//   § refusals  each D16 code at its door with "dbt" in the sentence and nothing created; a value the encoder cannot
//               write is `layerFilter` (NEGATIVE CONTROL: the same chart without it answers); a row lock refused
//               (`layerRowPolicy`), asking nothing; NEGATIVE CONTROL the same question unrestricted answers
//   § secrets   connections:list carries the has-secret flag only; dbt's error text carrying the token reaches the log
//               redacted and no reply
//   § nightly   scripts/semanticDbtLive.ts end to end against the fake API (its checks count here)
//
//   npm run build:ts && node scripts/test-semanticDbtDoors.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';
import { captureLogs } from './logCapture';

const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
const liveTarget: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const dbtConn: typeof import('../src/connectors/dbt') = require('../src/connectors/dbt');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const fakeDbt: typeof import('./semanticFakeDbt') = require('./semanticFakeDbt');

const { ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x)).slice(0, 600);
const TOKEN = `dbtc_${Date.now().toString(36)}_doors_canary`;
const ENV = 70;
const COLUMNS = fakeDbt.asDbtTypes(H.fx.COLUMNS);
const NOT_NORTH = "({{ Dimension('region') }} <> 'North' OR {{ Dimension('region') }} IS NULL)";
const fake = fakeDbt.startFakeDbt({ token: TOKEN, environmentId: ENV, models: [
  { name: 'orders', label: 'Orders', description: 'Every order', table: 'live_typed', columns: COLUMNS },
  { name: 'orders_outside_north', label: 'Orders outside the North', table: 'live_typed', columns: COLUMNS, where: NOT_NORTH },
] });
const TWINS: Array<{ layer: string; def: { column: string; aggregation: string }; tolerant: boolean }> = [
  { layer: 'revenue', def: { column: 'amt', aggregation: 'sum' }, tolerant: true },
  { layer: 'orders', def: { column: 'many', aggregation: 'count' }, tolerant: false },
  { layer: 'avg_amount', def: { column: 'amt', aggregation: 'avg' }, tolerant: true },
  { layer: 'max_amount', def: { column: 'amt', aggregation: 'max' }, tolerant: false },
];
const tolerantOf = (layer: string): boolean => TWINS.find((t) => t.layer === layer)!.tolerant;
const SIX_MONTHS = [{ type: 'filter', column: 'd', op: 'period', period: { preset: 'last_n_months', n: 6 } }];
const WEST = { type: 'filter', column: 'region', op: '=', value: 'West' };

void (async () => {
  dbtConn.setTransport(fake.transport);
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const X = s.extractId;
  const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(ORG_A, fn);
  const CONN = await as(async () => {
    const c = await H.connections.saveConnection(P, { name: 'dbt prod', connectorId: 'dbt-semantic-layer', values: { region: 'north-america', environmentId: String(ENV) } });
    await secretsIpc.storeSecrets(c!.id, { token: TOKEN });
    return c!.id;
  });
  const created = (): number => fake.ops('createQuery');
  const mirrorsOf = async (ds: string): Promise<Awaited<ReturnType<typeof metrics.listMetrics>>> => {
    let ms: Awaited<ReturnType<typeof metrics.listMetrics>> = [];
    for (let i = 0; i < 300 && ms.length < 4; i += 1) {
      ms = (await as(() => metrics.listMetrics(P))).filter((m) => m.datasetId === ds);
      if (ms.length < 4) await new Promise((r) => setTimeout(r, 10));
    }
    return ms;
  };

  // ── § doors ──
  const listed = (await post('connection:semanticModels', { projectId: P, connId: CONN })).value;
  ok('Connections lists the dbt environment\'s saved queries', listed.ok === true && show(listed.models?.map((m: Reply) => m.name)) === show(['orders', 'orders_outside_north']), show(listed));
  const added = (await post('connection:addSemanticDataset', { projectId: P, connId: CONN, model: 'orders', name: 'Orders (dbt)' })).value;
  ok('…and one is added as a dataset', added.ok === true && typeof added.dataset?.id === 'string', show(added));
  const SEM: string = added.dataset.id;
  ok('…its dimensions are the saved query\'s group-bys as dbt types them (categorical text, time date), no table or SQL stored',
    show(added.dataset.columns) === show(COLUMNS.map((c) => ({ name: c.name, type: c.type }))), show(added.dataset.columns));
  const mirrors = await mirrorsOf(SEM);
  ok('…the queued sync mirrors its four metrics, the SIMPLE SUM and COUNT ones marked as adding up', mirrors.length === 4
    && show(mirrors.map((m) => [m.name, (m.definition as { additive?: boolean }).additive === true]).sort()) === show([['avg_amount', false], ['max_amount', false], ['orders', true], ['revenue', true]]), show(mirrors));
  const mirror = (n: string, ms = mirrors): string => ms.find((m) => (m.definition as { external?: string }).external === n)!.id; // a second dataset's names clash: "revenue · dbt prod"
  const twin = new Map<string, string>();
  for (const t of TWINS) twin.set(t.layer, (await as(() => metrics.saveMetric(P, { name: `${t.layer} X`, datasetId: X, definition: t.def })))!.id);
  const onSem = (layer: string, ms = mirrors) => ({ column: '', aggregation: 'sum', metricId: mirror(layer, ms) });
  const onExt = (layer: string) => ({ ...TWINS.find((t) => t.layer === layer)!.def, metricId: twin.get(layer)! });
  const enc = (d: string, layers: string[], over: Record<string, unknown> = {}) => ({ category: 'region', values: layers.map((x) => (d === X ? onExt(x) : onSem(x))), ...over });
  const chart = async (d: string, layers: string[], over: Record<string, unknown> = {}, filters: unknown[] = []): Promise<Reply> =>
    (await post('visual:data', { projectId: P, datasetId: d, encoding: enc(d, layers, over), filters })).value;
  const agree = (e: Reply, l: Reply, layers: string[], split = false): string[] => {
    if (!e || e.ok !== true || !l || l.ok !== true) return [`not both answered: ${show({ e, l })}`];
    const ext = { labels: e.data.labels, series: e.data.series.map((x: Reply) => ({ name: x.name, values: x.values })) };
    const sem = { labels: l.data.labels, series: l.data.series.map((x: Reply, i: number) => ({ name: split ? x.name : ext.series[i]?.name, values: x.values })) };
    return cmp.compareCharts(ext, sem, split ? () => tolerantOf(layers[0]) : (i) => tolerantOf(layers[i]), split);
  };
  const charts = async (label: string, layers: string[], over: Record<string, unknown> = {}, filters: unknown[] = [], split = false): Promise<void> => {
    const p = agree(await chart(X, layers, over, filters), await chart(SEM, layers, over, filters), layers, split);
    ok(`${label}: the dbt figures equal the extract's`, p.length === 0, p.join(' | '));
  };
  const ALL4 = TWINS.map((t) => t.layer);
  await charts('visual:data, a text axis, all four metrics', ALL4);
  const before = created();
  await charts('visual:data, 60 categories ("Other" asked of dbt)', ['avg_amount'], { category: 'many' });
  const other = fake.requests.filter((r) => r.op === 'createQuery').at(-1)!.variables;
  ok('…"Other" was a second createQuery, the 50 kept excluded by a NOT IN in where text', created() - before === 2 && show(other.groupBy) === '[]'
    && (other.where as Array<{ sql: string }>).length === 1 && ((other.where as Array<{ sql: string }>)[0].sql.match(/'/g)?.length ?? 0) >= 100 && /NOT IN/.test(show(other.where)), show(other));
  await charts('visual:data, a month axis under a relative period', ['revenue', 'avg_amount'], { category: 'd', grain: 'month' }, SIX_MONTHS);
  ok('…the month asked as a MONTH group-by, the period as TimeDimension day comparisons',
    fake.requests.some((r) => r.op === 'createQuery' && show(r.variables.groupBy) === show([{ name: 'd', grain: 'MONTH' }]) && /TimeDimension\('d', 'day'\) \}\} >= '\d{4}-\d{2}-\d{2}'/.test(show(r.variables.where))));
  await charts('visual:data, a split', ['orders'], { category: 'many', series: 'region' }, [], true);
  await charts('visual:data, under a filter', ['max_amount'], {}, [WEST]);
  for (const g of ['week', 'quarter', 'year']) await charts(`visual:data, a date axis by ${g}`, ['orders'], { category: 'd', grain: g });
  const batch = async (d: string): Promise<Reply[]> => (await post('visual:dataBatch', { projectId: P, items: [{ datasetId: d, encoding: enc(d, ['revenue']) }, { datasetId: d, encoding: enc(d, ['orders'], { category: 'd', grain: 'quarter' }) }] })).value as unknown as Reply[];
  const [be, bl] = [await batch(X), await batch(SEM)];
  const bp = [...agree(be[0], bl[0], ['revenue']), ...agree(be[1], bl[1], ['orders'])];
  ok('visual:dataBatch: both items equal the extract\'s', bp.length === 0, bp.join(' | '));
  for (const t of TWINS) {
    const tiles = async (d: string): Promise<Reply[]> => (await post('analysis:tiles', { projectId: P, items: [
      { kind: 'metric', datasetId: d, ...(d === SEM ? onSem(t.layer) : onExt(t.layer)) },
      { kind: 'metric', datasetId: d, ...(d === SEM ? onSem(t.layer) : onExt(t.layer)), filters: SIX_MONTHS, compare: { mode: 'previous_period' } },
    ] })).value as unknown as Reply[];
    const [e, l] = [await tiles(X), await tiles(SEM)];
    ok(`analysis:tiles KPI (${t.layer}): the same figure, dated live`, typeof l[0]?.value === 'number' && cmp.sameNumber(e[0]?.value, l[0].value, t.tolerant) && l[0]?.asOf?.mode === 'live', show([e[0], l[0]]));
    const [ec, lc] = [e[1]?.compare as Reply, l[1]?.compare as Reply];
    ok(`metric:compare, the previous period (${t.layer}): both figures and the delta equal`, !!lc && lc.ok === true && ['value', 'previous', 'delta'].every((k) => cmp.sameNumber(ec?.[k], lc[k], t.tolerant)), show([ec, lc]));
    const values = async (id: string): Promise<Reply> => ((await post('metric:values', { projectId: P, ids: [id], filters: [WEST] })).value as unknown as Reply[])[0];
    const [ve, vl] = [await values(twin.get(t.layer)!), await values(mirror(t.layer))];
    ok(`metric:values under a filter (${t.layer})`, typeof vl?.value === 'number' && cmp.sameNumber(ve?.value, vl.value, t.tolerant), show([ve, vl]));
  }
  const card = async (d: string): Promise<Reply> => (await post('answer:card', { projectId: P, spec: { datasetId: d, category: 'cat', measures: [d === SEM ? onSem('revenue') : onExt('revenue')], filters: [], chartType: 'bar', title: 'T', top: 5 } })).value;
  const cp = agree(await card(X), await card(SEM), ['revenue']);
  ok('answer:card: the ranked, cut chart equals the extract\'s', cp.length === 0, cp.join(' | '));
  const distinct = async (d: string, column: string): Promise<Reply> => (await post('dataset:distinct', { projectId: P, datasetId: d, column, limit: 200 })).value;
  const [dx, ds] = [await distinct(X, 'many'), await distinct(SEM, 'many')];
  ok('dataset:distinct: dbt\'s values (a group-by-only query), as the extract lists them', show(ds.values) === show(dx.values) && ds.values?.length === 60, show([dx, ds]));
  const [cx, cs] = [await distinct(X, 'cat'), await distinct(SEM, 'cat')];
  const sorted = (xs: string[] | undefined): string => show([...(xs ?? [])].sort());
  ok('…over a field with blanks (\'\', spaces, a tab, NBSP, NULL): the extract\'s values less the blank ones, each once',
    sorted(cs.values) === sorted((cx.values as string[]).filter((v) => v.trim() !== '')) && cs.values?.length > 5, show([cx, cs]));
  const neg = agree(await chart(X, ['max_amount']), await chart(SEM, ['max_amount'], {}, [WEST]), ['max_amount']);
  ok('NEGATIVE CONTROL: a filtered dbt chart is not the unfiltered extract\'s', neg.length > 0);

  // A saved query with its own filter: dbt applies it to every question (sent verbatim by the connector).
  const outside = (await post('connection:addSemanticDataset', { projectId: P, connId: CONN, model: 'orders_outside_north', name: 'Outside the North (dbt)' })).value;
  const outMirrors = await mirrorsOf(outside.dataset.id);
  const NOT_NORTH_STEP = { type: 'filter', column: 'region', op: '!=', value: 'North' };
  const ownExt = await chart(X, ['revenue'], { category: 'cat' }, [NOT_NORTH_STEP]);
  const ownSem = (await post('visual:data', { projectId: P, datasetId: outside.dataset.id, encoding: { category: 'cat', values: [onSem('revenue', outMirrors)] }, filters: [] })).value;
  ok('a saved query\'s own filter: its chart equals the extract\'s under the same filter', agree(ownExt, ownSem, ['revenue']).length === 0, agree(ownExt, ownSem, ['revenue']).join(' | '));
  ok('…its where text went verbatim with the question', fake.requests.filter((r) => r.op === 'createQuery').at(-1)!.variables.where !== undefined && show(fake.requests.filter((r) => r.op === 'createQuery').at(-1)!.variables.where).includes(show(NOT_NORTH).slice(1, -1)));
  ok('NEGATIVE CONTROL: …and without it the figures differ', agree(await chart(X, ['revenue'], { category: 'cat' }), ownSem, ['revenue']).length > 0);

  const all = fake.requests.filter((r) => r.op === 'createQuery');
  ok(`every one of the ${all.length} createQuery calls decodes back to a question the plan asks`, all.length > 20 && all.every((r) => {
    try {
      fakeDbt.decodeDbt({ savedQuery: 'orders', metrics: r.variables.metrics ?? [], groupBy: r.variables.groupBy ?? [], where: r.variables.where ?? [], orderBy: r.variables.orderBy ?? [] }, COLUMNS, 'dbt');
      return true;
    } catch {
      return false;
    }
  }));
  const names = all.map((r) => show({ ...r.variables, where: undefined })).join('\n');
  ok('…no value outside where text: West and the six months\' bounds never in a name, an order or a group-by', !/West|20\d\d-\d\d-\d\d|"m\d\d"/.test(names) && all.some((r) => show(r.variables.where).includes("= 'West'")));
  ok('…every request carried the token as Bearer, every question a whole number of rows under the cap + 1',
    fake.requests.every((r) => r.auth === `Bearer ${TOKEN}`) && all.every((r) => Number.isInteger(r.variables.limit) && Number(r.variables.limit) <= 100_001));

  // ── § refusals ──
  const n0 = created();
  const refusedAt = async (code: string, ask: () => Promise<Reply>): Promise<void> => {
    const r = await ask();
    ok(`${code}: refused at its door, naming dbt, nothing created`, r?.reason === code && /dbt/.test(String(r?.error)) && created() === n0, show(r));
  };
  await refusedAt('pivot', () => chart(SEM, ['revenue'], { pivot: { rows: [{ column: 'region' }], columns: [], values: [onSem('revenue')] }, values: [] }));
  await refusedAt('autoGrain', () => chart(SEM, ['revenue'], { category: 'd' }));
  await refusedAt('columnOnLayer', () => chart(SEM, [], { values: [{ column: 'amt', aggregation: 'sum' }] }));
  await refusedAt('map', () => chart(SEM, ['revenue'], { geo: { level: 'country' } }));
  const TAB = { type: 'filter', column: 'cat', op: '=', value: 'a\tb' };
  await refusedAt('layerFilter', () => chart(SEM, ['revenue'], {}, [TAB, ...SIX_MONTHS]));
  ok('NEGATIVE CONTROL: the same chart without the value dbt cannot be sent answers', (await chart(SEM, ['revenue'], {}, SIX_MONTHS)).ok === true && created() > n0);
  const n1 = created();
  const found = await as(() => liveTarget.liveTarget(P, SEM));
  const target = found.ok ? found.target : null;
  const env = target?.semantic?.env ?? null;
  const locked = { kind: 'chart' as const, measures: [{ metric: 'revenue' }], category: { column: 'region', kind: 'text' as const }, order: 'natural' as const, weekCal: null };
  const lockRun = target ? adapters.semanticRunner(target, new AbortController().signal, () => undefined) : null;
  const r1 = env && lockRun ? await as(() => es.evaluateSemantic({ ...locked, filters: [{ kind: 'in', column: 'region', values: ['East'], negate: false, binary: true }] }, env, lockRun)) : null;
  ok('a row lock on a dbt dataset is refused (layerRowPolicy, naming dbt), asking nothing: dbt compares in the warehouse\'s collation',
    !!env && env.caps.binaryCompare === false && !!r1 && !r1.ok && r1.code === 'layerRowPolicy' && /dbt/.test(r1.message) && created() === n1, show(r1));
  const r2 = env && lockRun ? await as(() => es.evaluateSemantic({ ...locked, filters: [{ kind: 'in', column: 'region', values: ['East'], negate: false }] }, env, lockRun)) : null;
  ok('NEGATIVE CONTROL: the same question unrestricted is answered by dbt', !!r2 && r2.ok && created() === n1 + 1, show(r2));

  // ── § secrets ──
  const conns = (await post('connections:list', { projectId: P })).value;
  const text = JSON.stringify(conns);
  ok('connections:list: the dbt connection says its token is set, and carries no token', /"secretSet"|"secretsSet"|"hasSecret"|"token":true/.test(text) && !text.includes(TOKEN), text.slice(0, 400));
  const logs = captureLogs();
  fake.hook = (op) => (op === 'createQuery' || op === 'savedQuery' ? { status: 200, json: { errors: [{ message: `User is not authorized: Bearer ${TOKEN}` }], data: null } } : undefined);
  H.queryCache.clear();
  const failed = await chart(SEM, ['revenue'], { category: 'cat' });
  const resync = await post('dataset:syncLiveSchema', { projectId: P, datasetId: SEM });
  fake.hook = null;
  logs.restore();
  const replies = JSON.stringify([failed, resync.value]);
  ok('a dbt error carrying the token: the chart fails typed, and the token is in no reply, nor the environment id or host',
    failed.ok === false && !replies.includes(TOKEN) && !replies.includes('getdbt.com') && !replies.includes(`"${ENV}"`), show(failed));
  ok('…dbt\'s words are in the server log for the question and the describe, the token redacted',
    logs.lines.filter((l) => l.includes('not authorized')).length >= 2 && !logs.lines.some((l) => l.includes(TOKEN)), show(logs.lines.slice(-3)));
  ok('…and the describe that failed changed nothing: a sentence, the dataset as it was', resync.value.ok === false && resync.value.code === 'live_failed' && /server log/.test(String(resync.value.error)), show(resync.value));

  // ── § nightly ── the nightly's run (scripts/semanticDbtLive.ts) here against the fake API, so it cannot rot unseen
  // before the first real run: its catalog checks, probes, the whole parity matrix by dbt's qualified names, its control.
  const nightly: typeof import('./semanticDbtLive') = require('./semanticDbtLive');
  const project: typeof import('./dbtFixture') = require('./dbtFixture');
  const PREFIXED = H.fx.COLUMNS.map((c) => ({ ...c, name: `${project.PREFIX}${c.name}` }));
  const amtAt = H.fx.COLUMNS.findIndex((c) => c.name === 'amt'); // the fake's metrics read `amt` itself
  await as(() => H.fx.loadWarehouse('dbt_parity_prefixed', [...PREFIXED, { name: 'amt', type: 'number' }], H.fx.fixtureRows().map((r) => [...r, r[amtAt]])));
  const night = fakeDbt.startFakeDbt({ token: TOKEN, environmentId: ENV, models: [{ name: project.SAVED_QUERY, label: 'Ordinate parity', table: 'dbt_parity_prefixed', columns: fakeDbt.asDbtTypes(PREFIXED) }] });
  dbtConn.setTransport(night.transport);
  const ran = await as(() => nightly.runDbtLive({ region: 'north-america', environmentId: String(ENV), token: TOKEN }, ok, () => undefined));
  ok('§ nightly: every question of the run reached the fake dbt, by its qualified names', ran.queries > 50 && night.ops('createQuery') >= ran.queries
    && night.requests.filter((r) => r.op === 'createQuery').every((r) => (r.variables.groupBy as Array<{ name: string }>).every((g) => g.name.startsWith(project.PREFIX))), `${ran.queries}`);

  dbtConn.setTransport(null);
  await close();
  finish();
})().catch((err: unknown) => {
  ok('the suite reached its end', false, err instanceof Error ? err.stack : String(err));
  finish();
});
