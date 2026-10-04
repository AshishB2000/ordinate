// Self-check for the Data section's channels (T2.3) over the real RPC route, in
// server mode, against org acme's locked DuckDB worker.
//
// 1. A PLANTED KEY NEVER REACHES THE BROWSER. Datasets whose origins hold a
//    canary — a URL's query, a file's directory, a connection's statement, a
//    SQL origin — and a stored refresh error quoting the URL. Every T2.3
//    channel is called over HTTP and NO reply body carries the canary.
//    Negative control: the handler `dataset:meta` (no contract) does.
// 2. dataset:source: kind + label + refreshable, nothing else.
// 3. dataset:profile ≡ the JS reference (computeColumnSummary, medianOf,
//    distinctValuesPageJs, buildVizData) through profileView, Object.is — and
//    the resident path never hydrated the table. The legacy dsProfile.ts
//    rules for bar lengths are pinned on hand values.
// 4. dataset:stats carries filledPct = the server's rounding.
// 5. lineage:get keys file/URL sources without their path or URL, and its edges still join.
// 6. relationship:save / list carry matchPct; catalog stamps the signed-in user.
// 7. Inputs the contracts refuse.
//
//   npm run build:ts && node scripts/test-dataViews.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: the loader hook has no public type

Module._load = (function (orig: any) { // any: Module._load's own signature
  return function (this: unknown, request: string, ...rest: unknown[]): unknown {
    if (request === 'electron') throw new Error('electron is not available in server mode');
    return orig.apply(this, [request, ...rest]);
  };
})(Module._load);

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dataviews-'));
const CANARY = 'k3y-CANARY-7f19-never-shown';

const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const pv: typeof import('../src/data/profileView') = require('../src/data/profileView');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };

/** '' when equal with Object.is at every leaf, else the first difference's path. */
function firstDiff(a: unknown, b: unknown, at = '$'): string {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${at}: length`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) {
      const d = firstDiff(ra[k], rb[k], `${at}.${k}`);
      if (d) return d;
    }
    return '';
  }
  return Object.is(a, b) ? '' : `${at}: ${String(a)} vs ${String(b)}`;
}

const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'sales', type: 'number' },
  { name: 'day', type: 'date' },
  { name: 'order_id', type: 'text' },
];
const ROWS: Cell[][] = Array.from({ length: 600 }, (_, i) => [
  i % 9 === 0 ? '' : `r${i % 13}`,
  i % 11 === 0 ? null : ((i * 37) % 101) - 20 + i * 0.5,
  i % 7 === 0 ? '' : new Date(Date.UTC(2024, 0, 1) + ((i * 5) % 400) * 86_400_000).toISOString().slice(0, 10),
  `o-${i}`,
]);

(async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
  const stats: typeof import('../src/data/datasetStats') = require('../src/data/datasetStats');
  const colProfile: typeof import('../src/data/columnProfile') = require('../src/data/columnProfile');
  const dp: typeof import('../src/engine/datasetPage') = require('../src/engine/datasetPage');
  const vizData: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const buildViz: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
  const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');

  // ── Fixture, as the signed-in admin ───────────────────────────────────────
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    await datasets.init();
    const projectId = (await projects.createProject('Data views')).id;
    const save = async (name: string, columns: ParsedColumn[], rows: Cell[][], origin?: unknown, sourceKind: 'csv' | 'json' | 'sql' | 'postgres' = 'csv') => {
      const ds = await datasets.saveDataset(projectId, { name, sourceKind, columns, rows, origin });
      if (!ds) throw new Error(`could not save ${name}`);
      return ds.id;
    };
    const orders = await save('Orders', COLUMNS, ROWS);
    const regions = await save('Regions', [{ name: 'region', type: 'text' }, { name: 'manager', type: 'text' }],
      Array.from({ length: 10 }, (_, i) => [`r${i}`, `m${i}`]));
    const url = await save('From a URL', [{ name: 'a', type: 'number' }], [[1], [2]],
      { kind: 'url', url: `https://api.example.com/v1/data.json?api_key=${CANARY}&page=2` }, 'json');
    const file = await save('From a file', [{ name: 'a', type: 'number' }], [[1]],
      { kind: 'file', path: path.join(DATA, `uploads-${CANARY}`, 'sales.csv') });
    const conn = await save('From a connection', [{ name: 'a', type: 'number' }], [[1]],
      { kind: 'connection', connId: '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d', table: 'orders', sql: `SELECT * FROM orders WHERE token = '${CANARY}'` }, 'postgres');
    const sql = await save('From SQL', [{ name: 'a', type: 'number' }], [[1]],
      { kind: 'sql', sql: `SELECT a FROM "Orders" WHERE note <> '${CANARY}'`, deps: [orders] }, 'sql');
    // A refresh failure as the URL connector words one: it quotes the address.
    await record.markRefresh(projectId, url, 'error', `Could not fetch https://api.example.com/v1/data.json?api_key=${CANARY}: 401`);
    return { projectId, orders, regions, url, file, conn, sql };
  });
  const { projectId: P } = seed;
  duck.forbidSyncOnMainThread();

  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const bodies: string[] = [];
  const post = async (channel: string, payload: unknown) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }),
      payload: wire.encode({ args: [payload] }),
    });
    bodies.push(`${channel} ${r.body}`);
    return { status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : null) as any }; // any: each reply is narrowed by the check that reads it
  };

  // ── 1. Every channel, every planted dataset ───────────────────────────────
  for (const id of [seed.url, seed.file, seed.conn, seed.sql]) {
    for (const [ch, payload] of [
      ['dataset:columns', { projectId: P, id }],
      ['dataset:source', { projectId: P, id }],
      ['dataset:profile', { projectId: P, datasetId: id, column: 'a' }],
      ['dataset:stats', { projectId: P, datasetId: id }],
      ['dataset:update', { projectId: P, datasetId: id, autoRefresh: 'daily' }],
      ['dataset:update', { projectId: P, datasetId: id, watch: true }],
      ['lineage:get', { projectId: P, type: 'dataset', id }],
      ['quality:list', { projectId: P, datasetId: id }],
      ['catalog:columns', { projectId: P, datasetId: id }],
    ] as [string, unknown][]) {
      const r = await post(ch, payload);
      ok(`${ch} on a planted dataset → 200`, r.status === 200, r.body.slice(0, 200));
    }
  }
  for (const [ch, payload] of [
    ['dataset:list', { projectId: P }],
    ['catalog:list', { projectId: P }],
    ['catalog:tags', { projectId: P }],
    ['relationship:list', { projectId: P }],
    ['dataSearch:query', { projectId: P, term: 'r1' }],
    ['lineage:get', { projectId: P, type: 'dataset', id: seed.orders }],
  ] as [string, unknown][]) {
    const r = await post(ch, payload);
    ok(`${ch} → 200`, r.status === 200, r.body.slice(0, 200));
  }
  // T6.3: a server keeps no file origin — the planted path is dropped on load, so
  // the dataset is a plain snapshot and a refresh never opens a server path.
  const rf = await post('dataset:refresh', { projectId: P, id: seed.file });
  ok('dataset:refresh of a planted file origin → ok:false, not re-fetchable, no path', rf.status === 200 && rf.value?.ok === false && /no re-fetchable source/.test(rf.value?.error) && !rf.body.includes(CANARY), rf.body);
  const listAfter = await post('dataset:list', { projectId: P });
  const urlRow = (listAfter.value as { id: string; lastRefreshError?: string }[]).find((d) => d.id === seed.url);
  ok('…a stored URL in a reason is cut to its origin', urlRow?.lastRefreshError === 'Could not fetch https://api.example.com: 401', JSON.stringify(urlRow));

  const leaks = bodies.filter((b) => b.includes(CANARY));
  ok(`no reply of ${bodies.length} carries the planted key, path or statement`, leaks.length === 0, leaks.map((b) => b.slice(0, 160)).join('\n'));
  const meta = await context.runInContext(ADMIN, 'meta', async () => JSON.stringify(await rpc.handlers.get('dataset:meta')!(null, { projectId: P, id: seed.url })));
  ok('negative control: dataset:meta (uncontracted) does carry it', meta.includes(CANARY));
  const metaRoute = await post('dataset:meta', { projectId: P, id: seed.url });
  ok('…and dataset:meta is not reachable over HTTP (404)', metaRoute.status === 404, String(metaRoute.status));
  const fileMeta = await context.runInContext(ADMIN, 'raw', async () =>
    (require('../src/data/datasets') as typeof import('../src/data/datasets')).getDatasetMeta(P, seed.file));
  ok('T6.3: the file origin is gone from the record itself (server mode drops it on load)', !!fileMeta && fileMeta.origin === undefined, JSON.stringify(fileMeta?.origin));

  // ── 2. dataset:source ─────────────────────────────────────────────────────
  const src = async (id: string) => (await post('dataset:source', { projectId: P, id })).value;
  ok('source: a URL → its host only', firstDiff(await src(seed.url), { kind: 'url', label: 'Web address · api.example.com', refreshable: true }) === '', JSON.stringify(await src(seed.url)));
  ok('source: a (dropped) file origin → the format, no name or path, not refreshable', firstDiff(await src(seed.file), { kind: 'csv', label: 'CSV file', refreshable: false }) === '', JSON.stringify(await src(seed.file)));
  ok('source: a deleted connection, its table', firstDiff(await src(seed.conn), { kind: 'connection', label: 'Connection · a deleted connection · orders', refreshable: true }) === '', JSON.stringify(await src(seed.conn)));
  ok('source: SQL → how many datasets it reads', firstDiff(await src(seed.sql), { kind: 'sql', label: 'SQL query over 1 dataset', refreshable: true }) === '');
  ok('source: no origin → not refreshable', firstDiff(await src(seed.orders), { kind: 'csv', label: 'CSV file', refreshable: false }) === '');

  // ── 3. dataset:profile ≡ the JS reference ────────────────────────────────
  const back = await context.runInContext(ADMIN, 'back', () => datasets.getDataset(P, seed.orders));
  if (!back) throw new Error('fixture unreadable');
  const realGet = datasets.getDataset;
  let hydrations = 0;
  (datasets as { getDataset: typeof realGet }).getDataset = async (...a: Parameters<typeof realGet>) => { hydrations += 1; return realGet(...a); };
  trace.reset();
  for (const [c, col] of COLUMNS.entries()) {
    const r = await post('dataset:profile', { projectId: P, datasetId: seed.orders, column: col.name });
    const cells = back.rows.map((row) => row[c] ?? null);
    const enc = vizData.sanitizeEncoding({
      category: col.name, values: [{ column: col.name, aggregation: 'count' }],
      ...(col.type === 'number' ? { bins: pv.PROFILE_BINS } : col.type === 'date' ? { grain: 'month' } : {}),
    });
    const js = buildViz.buildVizData(back.columns, back.rows, enc);
    const num = col.type === 'number';
    const want = pv.columnProfile(col, back.rowCount, stats.computeColumnSummary(col, cells), {
      median: num ? colProfile.medianOf(back.columns, back.rows, col.name) : null,
      distinct: num ? dp.distinctValuesPageJs(back.columns, back.rows, col.name, { limit: 1 }).total : null,
    }, { labels: js.data.labels, values: js.data.series[0].values });
    const d = firstDiff(r.value?.profile, want);
    ok(`profile ${col.type} "${col.name}" ≡ the JS reference (Object.is)`, r.value?.ok === true && d === '', d || r.body.slice(0, 200));
  }
  ok('profile: the resident path never hydrated the table', hydrations === 0, String(hydrations));
  const tr = trace.snapshot().datasetProfile;
  ok('profile: traced resident, never failed', !!tr && tr.resident === COLUMNS.length && tr.failed === 0, JSON.stringify(tr));
  (datasets as { getDataset: typeof realGet }).getDataset = realGet;
  const sales = (await post('dataset:profile', { projectId: P, datasetId: seed.orders, column: 'sales' })).value?.profile;
  ok('profile: a number column → a 20-bucket histogram with a median', sales?.distribution?.kind === 'histogram' && sales.distribution.bars.length === pv.PROFILE_BINS && typeof sales.median === 'number', JSON.stringify(sales?.distribution).slice(0, 200));
  const region = (await post('dataset:profile', { projectId: P, datasetId: seed.orders, column: 'region' })).value?.profile;
  ok('profile: a text column → its 10 largest values, largest first', region?.distribution?.bars.length === pv.PROFILE_TOP && region.distribution.of === 13
    && region.distribution.bars.every((b: { value: number }, i: number, a: { value: number }[]) => i === 0 || a[i - 1].value >= b.value), JSON.stringify(region?.distribution));
  const missing = await post('dataset:profile', { projectId: P, datasetId: seed.orders, column: 'nope' });
  ok('profile: an unknown column → ok:false', missing.value?.ok === false, missing.body);

  // The legacy bar rules (dsProfile.ts), on hand values.
  const h = pv.distribution('number', ['0–5', '5–10', '10–15', '-5–-1'], [100, 0, 1, 50]);
  ok('histogram: share of the tallest, 3% floor, an empty bucket at 0', firstDiff(h?.bars.map((b) => b.pct), [100, 0, 3, 50]) === '', JSON.stringify(h?.bars));
  ok('histogram: total and the two edges, split on the en dash', h?.total === 151 && h.lo === '0' && h.hi === '-1', JSON.stringify(h));
  const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
  const plan = ck.binPlan(0, 40, pv.PROFILE_BINS);
  const lab = (i: number) => ck.binLabel(i, plan.lo, plan.width, plan.bins, plan.hi);
  const ax = pv.distribution('number', ['', lab(7), lab(0), lab(19)], [0, 4, 2, 8], { min: 0, max: 40 });
  ok('histogram: every bucket in axis order, absent ones at 0, the empty-cell bucket left out',
    ax?.bars.length === 20 && ax.bars[0].value === 2 && ax.bars[7].value === 4 && ax.bars[19].value === 8
    && ax.bars.filter((b) => b.value === 0).length === 17 && ax.bars.every((b, i) => b.label === lab(i)), JSON.stringify(ax?.bars.slice(0, 3)));
  const months = pv.distribution('date', ['', '2024-06', '2024-01', '2024-03'], [0, 1, 2, 3]);
  ok('bars: months in timeline order', firstDiff(months?.bars.map((b) => b.label), ['2024-01', '2024-03', '2024-06']) === '', JSON.stringify(months));
  const t = pv.distribution('text', ['a', 'b', 'c'], [1, 300, 0]);
  ok('bars: text sorted by count, 2% floor', firstDiff(t?.bars.map((b) => [b.label, b.pct]), [['b', 100], ['a', 2], ['c', 2]]) === '', JSON.stringify(t));
  ok('nothing to chart → null', pv.distribution('text', [], []) === null);
  ok('filled %: rounded, and an empty table reads 100', firstDiff(pv.filledPcts([{ name: 'x', type: 'text', nonEmpty: 2 }], 3), [67]) === '' && pv.filledPcts([{ name: 'x', type: 'text', nonEmpty: 0 }], 0)[0] === 100);

  // ── 4. dataset:stats filledPct ────────────────────────────────────────────
  const st = (await post('dataset:stats', { projectId: P, datasetId: seed.orders })).value;
  ok('stats: filledPct = the server\'s rounding of each summary', st?.ok && firstDiff(st.filledPct, pv.filledPcts(st.summaries, back.rowCount)) === '', JSON.stringify(st?.filledPct));

  // ── 5. Lineage keys ───────────────────────────────────────────────────────
  const ln = (await post('lineage:get', { projectId: P, type: 'dataset', id: seed.url })).value;
  const ids = new Set((ln?.nodes ?? []).map((n: { id: string }) => n.id));
  ok('lineage: the URL source is keyed source:url:<n>, named by host', (ln?.nodes ?? []).some((n: { id: string; name: string }) => /^source:url:\d+$/.test(n.id) && n.name === 'api.example.com'), JSON.stringify(ln?.nodes));
  ok('lineage: every edge still joins two nodes of the reply', (ln?.edges ?? []).length > 0 && ln.edges.every((e: { from: string; to: string }) => ids.has(e.from) && ids.has(e.to)), JSON.stringify(ln?.edges));

  // ── 6. Relationships and catalog ──────────────────────────────────────────
  const rs = await post('relationship:save', { projectId: P, relationship: { from: { datasetId: seed.orders, column: 'region' }, to: { datasetId: seed.regions, column: 'region' }, cardinality: 'many_to_one' } });
  const rel = rs.value?.relationship;
  const n = rel ? rel.verified.matched + rel.verified.unmatchedFrom : 0;
  ok('relationship:save: matchPct = matched over keyed rows, one decimal', rs.value?.ok === true && rel.matchPct === Math.round((rel.verified.matched / n) * 1000) / 10, rs.body.slice(0, 300));
  const rl = (await post('relationship:list', { projectId: P })).value;
  ok('relationship:list carries the same matchPct', rl?.ok && rl.relationships[0]?.matchPct === rel?.matchPct);
  const sg = (await post('relationship:suggest', { projectId: P, fromId: seed.orders, toId: seed.regions })).value;
  ok('relationship:suggest: region → region first, with its rate as a percent', sg?.ok && sg.best?.from === 'region' && sg.best.to === 'region' && sg.candidates[0].ratePct === Math.round(sg.candidates[0].rate * 1000) / 10, JSON.stringify(sg?.best));
  const cs = (await post('catalog:set', { projectId: P, ref: `dataset:${seed.orders}`, patch: { description: 'All orders', tags: ['Sales Team'] } })).value;
  ok('catalog:set: stamped with the signed-in user, not the OS account', cs?.ok && cs.doc.updatedBy === 'ana@acme.test', JSON.stringify(cs));
  const cl = (await post('catalog:list', { projectId: P })).value;
  ok('catalog:list: kind counts add up to the rows', cl?.ok && cl.kinds.reduce((s: number, k: { count: number }) => s + k.count, 0) === cl.rows.length && cl.kinds.find((k: { kind: string }) => k.kind === 'dataset')?.count === 6, JSON.stringify(cl?.kinds));

  // ── 7. Refused inputs ─────────────────────────────────────────────────────
  for (const [label, ch, payload] of [
    ['dataSearch without a project', 'dataSearch:query', { projectId: '', term: 'r1' }],
    ['a catalog ref that is a path', 'catalog:set', { projectId: P, ref: `dataset:../../${CANARY}`, patch: {} }],
    ['a rule of an unknown kind', 'quality:save', { projectId: P, datasetId: seed.orders, rule: { kind: 'eval', severity: 'fail' } }],
    ['an unknown schedule', 'dataset:update', { projectId: P, datasetId: seed.orders, autoRefresh: 'minutely' }],
    ['lineage of an unknown type', 'lineage:get', { projectId: P, type: 'connection', id: seed.orders }],
  ] as [string, string, unknown][]) {
    const r = await post(ch, payload);
    ok(`400 ${label}, never echoing the value`, r.status === 400 && !r.body.includes(CANARY), `${r.status} ${r.body}`);
  }

  await app.close();
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
