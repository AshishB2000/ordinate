// Self-check for the Cube connector (semantic layer part 7, e1; src/connectors/cube.ts, docs/live-data/cube.md), in
// server mode — the SSRF guard checks and pins every socket — against the fake Cube on 127.0.0.1
// (scripts/semanticFakeCube.ts), which SSRF_ALLOW admits. No network leaves the machine.
//
//   § registry   one `cube` entry: family cube, the Semantic layers group, fields url / auth / token (secret), the
//                semantic capability (backend cube, lookups, no byte-exact compare), the catalog flag
//   § catalog    /v1/meta → models (cubes and views; nothing hidden or unquotable), a model's typed dimensions and
//                its measures with whether they add up; listTables lists the models; the copy path refuses
//   § auth       the API secret signs a fresh HS256 token per request, valid five minutes; a token goes as is
//   § load       "Continue wait" is polled until the answer, the signal stops the polling and closes the socket,
//                the timeout too; Cube's errors come back redacted
//   § network    a private URL refused without SSRF_ALLOW and asked with it; plain http only to an address
//                SSRF_ALLOW admits; a redirect is never followed; the URL's REST path
//
//   npm run build:ts && node scripts/test-connectorsCube.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { ConnectorContext } from '../src/connectors/types';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-cubeconn-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(path.join(tmp, 'data'));

const registry: typeof import('../src/connectors') = require('../src/connectors');
const fakeCube: typeof import('./semanticFakeCube') = require('./semanticFakeCube');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');

const show = (v: unknown): string => JSON.stringify(v);
const SECRET = `cube-secret-${Date.now().toString(36)}-canary`;
const MODELS: import('./semanticFakeCube').FakeModel[] = [
  { name: 'orders', title: 'Orders', description: 'Every order', table: 'cube_conn_fixture', columns: fx.COLUMNS, hidden: { dimensions: ['secret_note'], measures: ['cost'] } },
  { name: 'orders_view', type: 'view', table: 'cube_conn_fixture', columns: fx.COLUMNS },
  { name: 'staging', table: 'cube_conn_fixture', columns: fx.COLUMNS, public: false },
];

const ctxOf = (url: string, over: Partial<ConnectorContext> = {}, auth = 'secret', token = SECRET): ConnectorContext =>
  ({ values: { url, auth }, secrets: { token }, rowLimit: 100_000, timeoutMs: 5_000, ...over });

function jwtOf(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>, payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown> };
}

async function main(): Promise<void> {
  process.env.SSRF_ALLOW = '127.0.0.1/32';
  const def = registry.getConnector('cube');
  ok('the registry has one `cube` connector', !!def && registry.listConnectors().filter((d) => d.family === 'cube').length === 1);
  if (!def) return;
  const layer = def.semantic!;
  ok('…in the Semantic layers group, after Apps & SaaS', def.category === 'Semantic layers'
    && registry.listConnectors().findIndex((d) => d.id === 'cube') > registry.listConnectors().findIndex((d) => d.category === 'Apps & SaaS'));
  ok('…its fields: the URL, how it signs in, and one secret (the API secret or a token)', show(def.fields.map((f) => [f.key, f.type, f.secret === true])) === show([['url', 'text', false], ['auth', 'select', false], ['token', 'password', true]]));
  ok('…the semantic capability: backend cube, lookups, no byte-exact compare (restricted viewers refused)', layer.backend === 'cube' && layer.caps.lookups && !layer.caps.binaryCompare);
  ok('…and the catalog says so, with no function and no secret', registry.connectorCatalog().find((c) => c.id === 'cube')?.semantic === true);

  await fx.loadWarehouse('cube_conn_fixture', fx.COLUMNS, fx.fixtureRows());
  const stub = await fakeCube.startFakeCube({ models: MODELS, secret: SECRET });
  const ctx = ctxOf(stub.url);

  // ── § catalog ──
  const listed = await layer.listModels(ctx);
  ok('meta → models: the cube and the view, labelled by their titles; a model that is not public is not listed',
    listed.ok && show(listed.models) === show([{ name: 'orders', label: 'Orders', description: 'Every order' }, { name: 'orders_view' }]), show(listed));
  ok('…asked at <url>/cubejs-api/v1/meta, signed', stub.metas === 1 && !!fakeCube.verifyHs256(stub.auths.at(-1)!, SECRET));
  const d = await layer.describeModel(ctx, 'orders');
  const grains = ['day', 'week', 'month', 'quarter', 'year'];
  ok('describe: dimensions typed (string → text, number, time → date at every grain), a member that is not public left out',
    d.ok && show(d.dimensions) === show(fx.COLUMNS.map((c) => (c.type === 'date' ? { name: c.name, type: 'date', grains } : { name: c.name, type: c.type }))), show(d));
  const metric = (n: string) => (d.ok ? d.metrics.find((m) => m.name === n) : undefined);
  ok('describe: measures with whether they add up (sum, count yes; avg, max no); one not public left out',
    metric('revenue')?.additive === true && metric('orders')?.additive === true && metric('avg_amount')?.additive === false && metric('max_amount')?.additive === false && !metric('cost'), show(d));
  stub.hook = (p) => (p.endsWith('/meta') ? { status: 200, json: { cubes: [{ name: 'm', type: 'cube', isVisible: true, public: true, dimensions: [{ name: 'm.b', type: 'boolean' }, { name: 'm.g', type: 'geo' }, { name: 'm.ok', type: 'string' }, { name: 'm.x y', type: 'string' }],
    measures: [{ name: 'm.running', type: 'number', aggType: 'sum', cumulative: true }, { name: 'm.users', type: 'number', aggType: 'countDistinct' }, { name: 'm.ratio', type: 'number', aggType: 'number' }, { name: 'm.n', type: 'number', aggType: 'count' }] }, { name: 'bad name', type: 'cube', dimensions: [], measures: [] }] } } : undefined);
  const odd = await layer.describeModel(ctx, 'm');
  ok('describe: a running total, a distinct count and a formula do not add up; booleans, places and unquotable names are not read',
    odd.ok && show(odd.dimensions) === '[{"name":"ok","type":"text"}]' && show(odd.metrics.map((m) => [m.name, m.additive])) === '[["running",false],["users",false],["ratio",false],["n",true]]', show(odd));
  const oddList = await layer.listModels(ctx);
  ok('…and a model whose name could not be written into a query is not listed', oddList.ok && show(oddList.models.map((m) => m.name)) === '["m"]');
  // A view joins cubes: a measure grouped by another cube's dimension can count a row in two groups (one-to-many).
  const alias = (view: string, members: Array<[string, string, string?]>, aggType?: string) => members.map(([n, type, from]) => ({ name: `${view}.${n}`, type, ...(aggType ? { aggType } : {}), ...(from ? { aliasMember: from } : {}) }));
  stub.hook = (p) => (p.endsWith('/meta') ? { status: 200, json: { cubes: [
    { name: 'v', type: 'view', dimensions: alias('v', [['city', 'string', 'customers.city'], ['status', 'string', 'orders.status']]), measures: alias('v', [['n', 'number', 'orders.count']], 'count') },
    { name: 'w', type: 'view', dimensions: alias('w', [['status', 'string', 'orders.status'], ['at', 'time', 'orders.created_at']]), measures: alias('w', [['n', 'number', 'orders.count']], 'count') },
    { name: 'u', type: 'view', dimensions: alias('u', [['status', 'string']]), measures: alias('u', [['n', 'number']], 'count') },
  ] } } : undefined);
  const additiveIn = async (view: string) => { const r = await layer.describeModel(ctx, view); return r.ok ? r.metrics[0]?.additive : undefined; };
  ok("a view's count is not additive when the view also holds another cube's dimension (aliasMember)", (await additiveIn('v')) === false);
  ok('NEGATIVE CONTROL: …a view whose dimensions are all the measure\'s own cube\'s keeps it additive', (await additiveIn('w')) === true);
  ok('…and a view member without aliasMember is not additive (failing safe)', (await additiveIn('u')) === false);
  stub.hook = null;
  const missing = await layer.describeModel(ctx, 'nope');
  ok('describe: a model Cube does not list is an error', !missing.ok);
  const metasBefore = stub.metas;
  const badName = await layer.describeModel(ctx, 'orders"; drop');
  ok('describe: a model name that is no identifier is refused before any request', !badName.ok && stub.metas === metasBefore, `${stub.metas}`);
  const tables = await def.listTables(ctx);
  ok('listTables lists the models (the connection test)', tables.ok && show(tables.tables.map((t) => t.name)) === '["orders","orders_view"]');
  const copy = await def.run(ctx, 'select 1');
  ok('run (the copy path) refuses: a semantic layer has no rows to copy', !copy.ok && /no rows to copy/.test(copy.error));

  // ── § auth ──
  const tok = jwtOf(stub.auths.at(-1)!);
  ok('secret auth: an HS256 JWT signed with the API secret, sent as is, valid for five minutes', tok.header.alg === 'HS256' && tok.header.typ === 'JWT'
    && tok.payload.exp === Number(tok.payload.iat) + 300 && Math.abs(Number(tok.payload.iat) - Date.now() / 1000) < 5 && !!fakeCube.verifyHs256(stub.auths.at(-1)!, SECRET) && !stub.auths.at(-1)!.startsWith('Bearer'));
  ok('…a fresh one per request: every request carried its own valid token', stub.auths.length === stub.metas && stub.auths.every((a) => !!fakeCube.verifyHs256(a, SECRET)));
  const tokenStub = await fakeCube.startFakeCube({ models: MODELS, token: 'fixed-api-token-123' });
  const viaToken = await layer.listModels(ctxOf(tokenStub.url, {}, 'token', 'fixed-api-token-123'));
  ok('token auth: the token goes as is', viaToken.ok && tokenStub.auths.at(-1) === 'fixed-api-token-123');
  const wrong = await layer.listModels(ctxOf(stub.url, {}, 'secret', 'not-the-secret'));
  ok('a token Cube refuses: the 403 comes back as an error', !wrong.ok && /403/.test(wrong.error), show(wrong));
  const asked = stub.auths.length;
  const none = await layer.listModels(ctxOf(stub.url, {}, 'secret', ''));
  ok('no secret: refused before any request', !none.ok && stub.auths.length === asked, show(none));
  await tokenStub.close();

  // ── § load ──
  const cubeEnc: typeof import('../src/engine/live/semantic/cube') = require('../src/engine/live/semantic/cube');
  const q = { dimensions: [{ name: 'region' }], metrics: ['revenue'], where: [{ kind: 'compare' as const, column: 'region', op: '!=' as const, value: 'North' }], order: [{ by: 'revenue', desc: true }, { by: 'region', desc: false }], limit: 51 };
  const req = cubeEnc.cubeAdapter.encode(q, 'orders', fx.COLUMNS);
  if ('ok' in req) {
    ok('the question encodes', false, show(req));
    return;
  }
  const answered = await layer.run(ctx, req.body);
  ok('run: one POST to /v1/load, the rows named as the question reads them, numbers as numbers',
    answered.ok && show(answered.columns.map((c) => c.name)) === '["region","revenue"]' && answered.rows.length === 4 && answered.rows.every((r) => typeof r[1] === 'number') && !answered.rows.some((r) => r[0] === 'North'), show(answered));
  ok('…its values went as JSON in `values`', show(stub.bodies.at(-1)!.query.filters) === show([{ member: 'orders.region', operator: 'notEquals', values: ['North'] }]));
  const loads = stub.loads;
  stub.waits = 2;
  const waited = await layer.run(ctx, req.body);
  ok('a load that says "Continue wait" is polled until it answers: three posts, one answer', waited.ok && stub.loads - loads === 3 && show(waited) === show(answered), `${stub.loads - loads}`);
  ok('…each poll signed anew', stub.auths.slice(-3).every((a) => !!fakeCube.verifyHs256(a, SECRET)));
  stub.waits = 1_000;
  const ac = new AbortController();
  const before = stub.loads;
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  const aborted = await layer.run(ctxOf(stub.url, { signal: ac.signal, timeoutMs: 20_000 }), req.body);
  await new Promise((r) => setTimeout(r, 100));
  ok('the signal stops the polling: Cancelled, promptly, and no socket left open', !aborted.ok && aborted.error === 'Cancelled' && Date.now() - t0 < 2_000 && stub.loads - before >= 1 && stub.openSockets() === 0, show([aborted, stub.loads - before, stub.openSockets()]));
  const t1 = Date.now();
  const timedOut = await layer.run(ctxOf(stub.url, { timeoutMs: 700 }), req.body);
  ok('…and the timeout does too, across polls', !timedOut.ok && /timed out/i.test(timedOut.error) && Date.now() - t1 < 3_000, show(timedOut));
  stub.waits = 0;
  stub.hook = (p, b) => (p.endsWith('/load') ? { status: 400, json: { error: `Error: syntax error near ${SECRET} for token ${stub.auths.at(-1)} in ${show(b).slice(0, 40)}` } } : undefined);
  const failed = await layer.run(ctx, req.body);
  const sent = stub.auths.at(-1)!;
  ok('Cube\'s error comes back with its status and words, the API secret and the signed token redacted', !failed.ok && /HTTP 400/.test(failed.error) && /syntax error/.test(failed.error) && !failed.error.includes(SECRET) && !failed.error.includes(sent), failed.ok ? '' : failed.error);
  stub.hook = (p) => (p.endsWith('/load') ? { status: 200, json: { error: 'Query timeout' } } : undefined);
  const said = await layer.run(ctx, req.body);
  ok('an error Cube answers with status 200 is an error', !said.ok && /Query timeout/.test(said.error));
  stub.hook = null;
  ok('a body that is not the encoder\'s is refused before any request', !(await layer.run(ctx, { sql: 'select 1' })).ok);

  // ── § network ──
  const ten = await layer.listModels(ctxOf('http://10.0.0.5:4000'));
  ok('SSRF: a private URL is refused without SSRF_ALLOW admitting it', !ten.ok && /Refused/.test(ten.error) && /SSRF_ALLOW/.test(ten.error), show(ten));
  delete process.env.SSRF_ALLOW;
  const metas = stub.metas;
  const loop = await layer.listModels(ctx);
  ok('SSRF: the fake on 127.0.0.1 is refused without SSRF_ALLOW, and never reached', !loop.ok && /Refused/.test(loop.error) && stub.metas === metas, show(loop));
  process.env.SSRF_ALLOW = '127.0.0.1/32';
  ok('NEGATIVE CONTROL: with SSRF_ALLOW=127.0.0.1/32 it is asked', (await layer.listModels(ctx)).ok && stub.metas === metas + 1);
  const publicHttp = await layer.listModels(ctxOf('http://93.184.216.34:4000'));
  ok('plain http to an address SSRF_ALLOW does not admit is refused (use https), before any socket', !publicHttp.ok && /https/.test(publicHttp.error), show(publicHttp));
  let followed = false;
  const target = await fakeCube.startFakeCube({ models: MODELS, secret: SECRET });
  target.hook = () => {
    followed = true;
    return undefined;
  };
  stub.hook = (p) => (p.endsWith('/meta') ? { status: 302, text: '', headers: { location: `${target.url}/cubejs-api/v1/meta` } } : undefined);
  const redirected = await layer.listModels(ctx);
  ok('a redirect is never followed: the 302 is an error and its target is never asked', !redirected.ok && /302/.test(redirected.error) && !followed && target.metas === 0, show(redirected));
  stub.hook = null;
  await target.close();
  const at = async (url: string): Promise<string> => {
    let seen = '';
    const s = await fakeCube.startFakeCube({ models: MODELS, secret: SECRET, basePath: '/x' });
    s.hook = (p) => {
      seen = p;
      return { status: 200, json: { cubes: [] } };
    };
    await layer.listModels(ctxOf(url.replace('PORT', String(s.port))));
    await s.close();
    return seen;
  };
  ok('the URL: a bare origin gets /cubejs-api/v1, a REST API URL (…/v1) is kept, another base path gets /v1',
    await at('http://127.0.0.1:PORT') === '/cubejs-api/v1/meta' && await at('http://127.0.0.1:PORT/cubejs-api/v1/') === '/cubejs-api/v1/meta' && await at('http://127.0.0.1:PORT/api') === '/api/v1/meta');
  const bad = await Promise.all(['ftp://127.0.0.1/', 'not a url', 'https://user:pw@cube.example.com/', 'https://cube.example.com/?x=1'].map((u) => layer.listModels(ctxOf(u))));
  ok('a URL that is not http(s), carries credentials or a query is refused', bad.every((r) => !r.ok), show(bad));
  await stub.close();
}

void context.runInContext({ user: { email: "cube@ordinate.invalid", role: "admin" as const }, org: { id: "cubeconn" } }, `cube-conn-${process.pid}`, main)
  .catch((err: unknown) => ok('the suite reached its end', false, err instanceof Error ? err.stack : String(err)))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
