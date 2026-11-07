// A Cube semantic dataset through the three doors (semantic layer part 7, e1; docs/live-data/cube.md): the SHIPPED
// `cube` connector and encoder — not a test connector — over the real RPC route (scripts/liveRouteHarness.ts), the
// deployment played by the fake Cube on 127.0.0.1 (scripts/semanticFakeCube.ts): /v1/meta for the model, every
// /v1/load decoded as Cube would read it and answered over the parity fixture in Cube's wire shape.
//
//   § doors     Connections lists the models, Add as dataset, the sync's mirrors; charts, "Other", a month axis under
//               a relative period (the latest-day lookup), a split, a filter, a batch, KPI tiles and a comparison,
//               metric:values, answer:card and a value list, each equal to the extract's with equal Ordinate
//               metrics (Object.is; sum/avg within 1e-13); every query Cube saw carried each value in `values`
//               only; NEGATIVE CONTROL a filtered Cube chart is not the unfiltered extract's
//   § refusals  each D16 code at its door with "Cube" in the sentence and nothing posted, a filter Cube cannot express
//               (`layerFilter`) too; a row lock refused (`layerRowPolicy`: no byte-exact compare), asking nothing;
//               NEGATIVE CONTROL the same question without the lock answers
//   § secrets   connections:list carries the has-secret flag only; Cube's error text carrying the API secret and the
//               signed token reaches the log redacted and no reply
//   § nightly   scripts/semanticCubeLive.ts end to end against the in-process Cube (its checks count here)
//
// This proves our encoder and the connector's plumbing against our engine; that Cube itself answers the same is the
// nightly's (scripts/test-semanticCubeLive.ts).
//
//   npm run build:ts && node scripts/test-semanticCubeDoors.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';
import { captureLogs } from './logCapture';

process.env.SSRF_ALLOW = '127.0.0.1/32'; // the fake Cube's address: a self-hosted deployment the operator admits

const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
const liveTarget: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const fakeCube: typeof import('./semanticFakeCube') = require('./semanticFakeCube');

const { ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x)).slice(0, 600);
const SECRET = `cube-api-secret-${Date.now().toString(36)}-canary`;
const MODELS: import('./semanticFakeCube').FakeModel[] = [
  { name: 'orders', title: 'Orders', description: 'Every order', table: 'live_typed', columns: H.fx.COLUMNS },
  { name: 'orders_view', type: 'view', title: 'Orders (view)', table: 'live_typed', columns: H.fx.COLUMNS },
];
const TWINS: Array<{ layer: string; def: { column: string; aggregation: string }; tolerant: boolean }> = [
  { layer: 'revenue', def: { column: 'amt', aggregation: 'sum' }, tolerant: true },
  { layer: 'orders', def: { column: 'many', aggregation: 'count' }, tolerant: false },
  { layer: 'avg_amount', def: { column: 'amt', aggregation: 'avg' }, tolerant: true },
  { layer: 'max_amount', def: { column: 'amt', aggregation: 'max' }, tolerant: false },
];
const tolerantOf = (layer: string): boolean => TWINS.find((t) => t.layer === layer)!.tolerant;
const SIX_MONTHS = [{ type: 'filter', column: 'd', op: 'period', period: { preset: 'last_n_months', n: 6 } }];
const WEST = { type: 'filter', column: 'region', op: '=', value: 'West' };

/** Every string anywhere in a Cube query outside its `values` arrays: members, operators, granularities. */
function namesOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => namesOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'values') namesOf(x, out);
  return out;
}

void (async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const X = s.extractId;
  const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(ORG_A, fn);
  const cube = await as(() => fakeCube.startFakeCube({ models: MODELS, secret: SECRET })); // answers in acme's worker
  const CONN = await as(async () => {
    const c = await H.connections.saveConnection(P, { name: 'Cube prod', connectorId: 'cube', values: { url: cube.url, auth: 'secret' } });
    await secretsIpc.storeSecrets(c!.id, { token: SECRET });
    return c!.id;
  });
  const posted = (): number => cube.loads;

  // ── § doors ──
  const listed = (await post('connection:semanticModels', { projectId: P, connId: CONN })).value;
  ok('Connections lists the Cube deployment\'s cube and view', listed.ok === true && show(listed.models?.map((m: Reply) => m.name)) === show(['orders', 'orders_view']), show(listed));
  const added = (await post('connection:addSemanticDataset', { projectId: P, connId: CONN, model: 'orders', name: 'Orders (Cube)' })).value;
  ok('…and one is added as a dataset', added.ok === true && typeof added.dataset?.id === 'string', show(added));
  const SEM: string = added.dataset.id;
  ok('…its dimensions are the cube\'s, as /v1/meta types them (no table, no SQL stored)',
    show(added.dataset.columns) === show(H.fx.COLUMNS.map((c) => ({ name: c.name, type: c.type }))), show(added.dataset.columns));
  let mirrors: Awaited<ReturnType<typeof metrics.listMetrics>> = [];
  for (let i = 0; i < 300 && mirrors.length < 4; i += 1) {
    mirrors = (await as(() => metrics.listMetrics(P))).filter((m) => m.datasetId === SEM);
    if (mirrors.length < 4) await new Promise((r) => setTimeout(r, 10));
  }
  ok('…the queued sync mirrors the cube\'s four measures, sum and count marked as adding up', mirrors.length === 4
    && show(mirrors.map((m) => [m.name, (m.definition as { additive?: boolean }).additive === true]).sort()) === show([['avg_amount', false], ['max_amount', false], ['orders', true], ['revenue', true]]), show(mirrors));
  const mirror = (n: string): string => mirrors.find((m) => m.name === n)!.id;
  const twin = new Map<string, string>();
  for (const t of TWINS) twin.set(t.layer, (await as(() => metrics.saveMetric(P, { name: `${t.layer} X`, datasetId: X, definition: t.def })))!.id);
  const onSem = (layer: string) => ({ column: '', aggregation: 'sum', metricId: mirror(layer) });
  const onExt = (layer: string) => ({ ...TWINS.find((t) => t.layer === layer)!.def, metricId: twin.get(layer)! });
  const enc = (d: string, layers: string[], over: Record<string, unknown> = {}) => ({ category: 'region', values: layers.map((x) => (d === SEM ? onSem(x) : onExt(x))), ...over });
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
    ok(`${label}: the Cube figures equal the extract's`, p.length === 0, p.join(' | '));
  };
  const ALL4 = TWINS.map((t) => t.layer);
  await charts('visual:data, a text axis, all four metrics', ALL4);
  const before = posted();
  await charts('visual:data, 60 categories ("Other" asked of Cube)', ['avg_amount'], { category: 'many' });
  const otherBody = cube.bodies.at(-1)!;
  ok('…"Other" was a second load, excluding the 50 kept with notEquals', posted() - before === 2 && otherBody.query.dimensions.length === 0
    && show(otherBody.query.filters.map((f) => ('operator' in f ? [f.operator, f.values?.length] : 'group'))) === show([['notEquals', 50]]), show(otherBody.query));
  await charts('visual:data, a month axis under a relative period (the latest day looked up first)', ['revenue', 'avg_amount'], { category: 'd', grain: 'month' }, SIX_MONTHS);
  ok('…the month asked of Cube as a granularity, the period as afterOrOnDate / beforeDate',
    cube.bodies.some((b) => show(b.query.timeDimensions) === show([{ dimension: 'orders.d', granularity: 'month' }]) && /afterOrOnDate/.test(show(b.query.filters))));
  await charts('visual:data, a split', ['orders'], { category: 'cat', series: 'region' }, [], true);
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
  ok('dataset:distinct: Cube\'s values (a dimensions-only query), as the extract lists them', show(ds.values) === show(dx.values) && ds.values?.length === 60, show([dx, ds]));
  const [cx, cs] = [await distinct(X, 'cat'), await distinct(SEM, 'cat')];
  // A layer's value list is planned "not empty" (b2's planValues), in the layer's order: the extract's values less its blank ones.
  const sorted = (xs: string[] | undefined): string => show([...(xs ?? [])].sort());
  ok('…over a field with blanks (\'\', spaces, a tab, NBSP, NULL): the extract\'s values less the blank ones, each once, none blank',
    sorted(cs.values) === sorted((cx.values as string[]).filter((v) => v.trim() !== '')) && cs.values?.length > 5 && (cx.values as string[]).some((v) => v.trim() === ''), show([cx, cs]));
  const neg = agree(await chart(X, ['max_amount']), await chart(SEM, ['max_amount'], {}, [WEST]), ['max_amount']);
  ok('NEGATIVE CONTROL: a filtered Cube chart is not the unfiltered extract\'s', neg.length > 0);

  const all = cube.bodies;
  ok(`every one of the ${all.length} loads decodes back to a question the plan asks`, all.length > 20 && all.every((b) => {
    try {
      fakeCube.decodeCube(b, H.fx.COLUMNS);
      return true;
    } catch {
      return false;
    }
  }));
  const leaked = all.flatMap((b) => namesOf(b.query)).filter((n) => /West|20\d\d-\d\d-\d\d|^m\d\d$/.test(n));
  ok('…no value outside `values`: West, the six months\' bounds and the kept categories appear only there', leaked.length === 0 && all.some((b) => show(b.query.filters).includes('"values":["West"]')), show(leaked.slice(0, 3)));
  ok('…each signed with a fresh token from the connection\'s secret, every request a whole number of rows under the cap',
    cube.auths.every((a) => !!fakeCube.verifyHs256(a, SECRET)) && all.every((b) => b.query.limit >= 1 && b.query.limit <= 50_000));

  // ── § refusals ──
  const n0 = posted();
  const refusedAt = async (code: string, ask: () => Promise<Reply>): Promise<void> => {
    const r = await ask();
    ok(`${code}: refused at its door, naming Cube, nothing posted`, r?.reason === code && /Cube/.test(String(r?.error)) && posted() === n0, show(r));
  };
  await refusedAt('pivot', () => chart(SEM, ['revenue'], { pivot: { rows: [{ column: 'region' }], columns: [], values: [onSem('revenue')] }, values: [] }));
  await refusedAt('bins', () => chart(SEM, ['revenue'], { category: 'amt' }));
  await refusedAt('autoGrain', () => chart(SEM, ['revenue'], { category: 'd' }));
  await refusedAt('columnOnLayer', () => chart(SEM, [], { values: [{ column: 'amt', aggregation: 'sum' }] }));
  await refusedAt('map', () => chart(SEM, ['revenue'], { geo: { level: 'country' } }));
  await refusedAt('layerFilter', () => chart(SEM, ['revenue'], {}, [{ type: 'filter', column: 'cat', op: 'contains', value: 'a' }, ...SIX_MONTHS]));
  // A reply that fills Cube's row limit is refused as too many groups, in a sentence naming Cube's limit, not Live SQL's.
  cube.hook = (p) => (p.endsWith('/load') ? { status: 200, json: { data: Array.from({ length: 50_000 }, (_v, i) => ({ 'orders.d.day': `d${i}`, 'orders.d': `d${i}`, 'orders.revenue': '1' })), annotation: {} } } : undefined);
  H.queryCache.clear();
  const tooMany = await chart(SEM, ['revenue'], { category: 'd', grain: 'day' });
  cube.hook = null;
  ok('a Cube answer at its 50,000-row limit is refused (tooManyGroups), naming 50,000: Cube\'s limit, not Live SQL\'s 100,000',
    tooMany.ok === false && tooMany.reason === 'tooManyGroups' && String(tooMany.error).includes('50,000') && !String(tooMany.error).includes('100,000'), show(tooMany));
  const n1 = posted();
  const found = await as(() => liveTarget.liveTarget(P, SEM));
  const target = found.ok ? found.target : null;
  const env = target?.semantic?.env ?? null;
  const locked = { kind: 'chart' as const, measures: [{ metric: 'revenue' }], category: { column: 'region', kind: 'text' as const }, order: 'natural' as const, weekCal: null };
  const lockRun = target ? adapters.semanticRunner(target, new AbortController().signal, () => undefined) : null;
  const r1 = env && lockRun ? await as(() => es.evaluateSemantic({ ...locked, filters: [{ kind: 'in', column: 'region', values: ['East'], negate: false, binary: true }] }, env, lockRun)) : null;
  ok('a row lock on a Cube dataset is refused (layerRowPolicy, naming Cube), asking nothing: Cube compares in the warehouse\'s collation',
    !!env && env.caps.binaryCompare === false && !!r1 && !r1.ok && r1.code === 'layerRowPolicy' && /Cube/.test(r1.message) && posted() === n1, show(r1));
  const r2 = env && lockRun ? await as(() => es.evaluateSemantic({ ...locked, filters: [{ kind: 'in', column: 'region', values: ['East'], negate: false }] }, env, lockRun)) : null;
  ok('NEGATIVE CONTROL: the same question unrestricted is answered by Cube', !!r2 && r2.ok && posted() === n1 + 1, show(r2));

  // ── § secrets ──
  const conns = (await post('connections:list', { projectId: P })).value;
  const text = JSON.stringify(conns);
  ok('connections:list: the Cube connection says its secret is set, and carries neither the secret nor a token',
    /"secretSet"|"secretsSet"|"hasSecret"|"token":true/.test(text) && !text.includes(SECRET) && !cube.auths.some((a) => text.includes(a)), text.slice(0, 400));
  const logs = captureLogs();
  cube.hook = (p) => (p.endsWith('/load') || p.endsWith('/meta') ? { status: 400, json: { error: `Error: no access with ${cube.auths.at(-1)} (secret ${SECRET}) on orders` } } : undefined);
  H.queryCache.clear();
  const failed = await chart(SEM, ['revenue'], { category: 'cat' });
  const resync = await post('dataset:syncLiveSchema', { projectId: P, datasetId: SEM });
  cube.hook = null;
  logs.restore();
  const replies = JSON.stringify([failed, resync.value]);
  const tokens = cube.auths.slice(-4);
  ok('a Cube error carrying the API secret and the signed token: the chart fails typed, and neither is in the reply, nor the deployment\'s URL',
    failed.ok === false && !replies.includes(SECRET) && !tokens.some((t) => replies.includes(t)) && !replies.includes(cube.url), show(failed));
  ok('…Cube\'s words are in the server log for the question and the describe, the secret and tokens redacted',
    logs.lines.filter((l) => l.includes('no access')).length >= 2 && !logs.lines.some((l) => l.includes(SECRET) || tokens.some((t) => l.includes(t))), show(logs.lines.slice(-3)));
  ok('…and the describe that failed changed nothing: a sentence, the dataset as it was', resync.value.ok === false && resync.value.code === 'live_failed' && /server log/.test(String(resync.value.error)), show(resync.value));

  // ── § nightly ── the nightly's run (scripts/semanticCubeLive.ts), here against the in-process Cube, so it cannot rot
  // unseen before (or between) real runs: its catalog checks, probes, the whole parity matrix and its control.
  const nightly: typeof import('./semanticCubeLive') = require('./semanticCubeLive');
  const ran = await as(() => nightly.runCubeLive({ url: cube.url, secret: SECRET }, ok, () => undefined));
  ok('§ nightly: every question of the run reached the fake Cube', ran.loads > 50 && cube.loads > ran.loads, `${ran.loads}`);

  await cube.close();
  await close();
  finish();
})().catch((err: unknown) => {
  ok('the suite reached its end', false, err instanceof Error ? err.stack : String(err));
  finish();
});
