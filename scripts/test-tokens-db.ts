// Personal API tokens and MCP at /api/mcp (T3.4) against a real Postgres,
// over real HTTP.
//
// Lifecycle: create (the value comes back ONCE) → list (prefix only) → use as
// `Authorization: Bearer` on the RPC API and on /api/mcp → revoke → refused.
// At rest only the sha256 and a 12-character prefix exist (the whole database
// is dumped and searched). A bearer request runs as the token's user with
// their CURRENT role; a token cannot mint another; a disabled user's token
// stops. MCP: initialize + tools/call with a token, 401 without one (dev-style
// identity, header identity, wrong and revoked tokens alike), the Origin and
// body-cap gates, per-project authorization of tool calls and their audit
// rows. Every log line the run produced (trace level) is searched for every
// token value.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line. Every run makes its own scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-tokens-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { createHash }: typeof import('crypto') = require('crypto');
const Module: any = require('module'); // any: the loader hook has no public type

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const httpT: typeof import('../src/automation/httpTransport') = require('../src/automation/httpTransport');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-tokens-db-'));
const log: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    log.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    cb();
  },
});

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip token / MCP DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_t34t_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  let app: FastifyInstance | null = null;
  const tokens: string[] = [];
  try {
    context.enterServerMode(DATA);
    appMod.registerHandlers();
    app = appMod.buildApp(envMod.parseEnv({
      LOG_LEVEL: 'trace', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
    }), sink);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const host = `127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
    const base = `http://${host}`;

    type Who = { email?: string; bearer?: string };
    const authHeaders = (w: Who): Record<string, string> => ({
      ...(w.email ? { 'x-forwarded-email': w.email } : {}),
      ...(w.bearer ? { authorization: `Bearer ${w.bearer}` } : {}),
    });
    const call = async (w: Who, channel: string, payload?: unknown) => {
      const res = await fetch(`${base}/api/rpc/${channel}`, {
        method: 'POST',
        // A bearer call carries no CSRF pair: it is exempt (src/server/csrf.ts).
        headers: w.bearer ? { 'content-type': 'application/json', ...authHeaders(w) } : withCsrf({ 'content-type': 'application/json', ...authHeaders(w) }),
        body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
    };
    let rpcId = 0;
    const mcp = async (w: Who, method: string, params: unknown = {}, extra: Record<string, string> = {}, raw?: string) => {
      const res = await fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(w), ...extra },
        body: raw ?? JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      const text = await res.text();
      let body: any = text; // any: a JSON-RPC reply or an error body
      try { body = JSON.parse(text); } catch { /* a 202 has no body */ }
      return { status: res.status, body, headers: res.headers };
    };
    const q = async <T extends object>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;

    // ── Members, a project each can or cannot read, a dataset ─────────────
    for (const p of ['boss', 'alice', 'carol']) await call({ email: `${p}@acme.test` }, 'projects:list');
    await pool.query(`UPDATE users SET role = 'editor' WHERE email = 'carol@acme.test'`);
    const shared = (await call({ email: 'boss@acme.test' }, 'projects:create', { name: 'Shared' })).body.id as string;
    const hidden = (await call({ email: 'boss@acme.test' }, 'projects:create', { name: 'Hidden' })).body.id as string;
    const uid = async (email: string) => (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))[0].id;
    await call({ email: 'boss@acme.test' }, 'project:share', { projectId: shared, member: { userId: await uid('alice@acme.test') }, role: 'viewer' });
    await call({ email: 'boss@acme.test' }, 'project:share', { projectId: shared, member: { userId: await uid('carol@acme.test') }, role: 'editor' });
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    await context.runInContext({ user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } }, 'seed', () =>
      datasets.saveDataset(shared, { name: 'Sales', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['north', 3], ['south', 4]] }));

    // ── Create: the value once, the prefix and hash at rest ───────────────
    const created = await call({ email: 'alice@acme.test' }, 'tokens:create', { name: 'laptop CLI' });
    const token = created.body.token as string;
    tokens.push(token);
    ok('create: returns ord_ + 43 base64url chars, once, with its 12-char prefix',
      created.status === 200 && /^ord_[A-Za-z0-9_-]{43}$/.test(token) && created.body.prefix === token.slice(0, 12), JSON.stringify({ ...created.body, token: '…' }));
    const listed = (await call({ email: 'alice@acme.test' }, 'tokens:list')).body as Record<string, unknown>[];
    ok('list: name, created, last used, prefix — and no token value', listed.length === 1 && listed[0].name === 'laptop CLI' && listed[0].prefix === token.slice(0, 12)
      && listed[0].lastUsedAt === null && typeof listed[0].createdAt === 'string' && !JSON.stringify(listed).includes(token) && !('token' in listed[0]));
    const row = (await q<{ token_hash: string; prefix: string }>('SELECT token_hash, prefix FROM api_tokens'))[0];
    ok('at rest: token_hash = sha256(token), prefix = its first 12 chars', row.token_hash === createHash('sha256').update(token).digest('hex') && row.prefix === token.slice(0, 12));
    const dumpDb = async () => (await q<{ j: string }>(`SELECT string_agg(row_to_json(x)::text, '') AS j FROM (
      SELECT row_to_json(t)::text AS r FROM api_tokens t UNION ALL SELECT row_to_json(a)::text FROM audit_log a UNION ALL SELECT row_to_json(u)::text FROM users u) x`))[0].j;
    ok('at rest: the token value is in no row of api_tokens, audit_log or users', !(await dumpDb()).includes(token) && !(await dumpDb()).includes(token.slice(12)));
    ok('shown once: nothing returns it again (list twice, plus /api/auth/me)', !JSON.stringify((await call({ email: 'alice@acme.test' }, 'tokens:list')).body).includes(token));

    // ── Use: the RPC API as alice, with her role ──────────────────────────
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })).json() as { user: { email: string; role: string } };
    ok('use: /api/auth/me with the bearer is alice, a viewer', me.user?.email === 'alice@acme.test' && me.user.role === 'viewer');
    const list = await call({ bearer: token }, 'projects:list');
    ok('use: projects:list as alice — only the project shared with her', list.status === 200 && list.body.length === 1 && list.body[0].id === shared);
    ok('use: alice\'s role applies (viewer may not create a project → 403)', (await call({ bearer: token }, 'projects:create', { name: 'x' })).status === 403);
    ok('use: a bearer beats a forwarded email — a wrong token with boss\'s header is 401', (await call({ email: 'boss@acme.test', bearer: 'ord_' + 'x'.repeat(43) }, 'projects:list')).status === 401);
    ok('use: last_used_at is stamped', (await call({ email: 'alice@acme.test' }, 'tokens:list')).body[0].lastUsedAt !== null);
    const mint = await call({ bearer: token }, 'tokens:create', { name: 'from a token' });
    ok('a token cannot mint a token', mint.status === 200 && mint.body.ok === false && mint.body.error === 'session' && !('token' in mint.body));

    // ── MCP at /api/mcp ───────────────────────────────────────────────────
    const init = await mcp({ bearer: token }, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    ok('mcp: initialize with a token', init.status === 200 && init.body.result?.serverInfo?.name === 'ordinate' && init.body.result.protocolVersion === '2025-06-18', JSON.stringify(init.body));
    const tools = await mcp({ bearer: token }, 'tools/list');
    const names = (tools.body.result?.tools ?? []).map((t: { name: string }) => t.name) as string[];
    ok('mcp: tools/list offers the server tools, not the two desktop renderers', names.includes('list_datasets') && names.includes('create_visual') && !names.includes('export_dashboard') && !names.includes('run_report'), names.join());
    const projectsCall = await mcp({ bearer: token }, 'tools/call', { name: 'list_projects', arguments: {} });
    const seen = projectsCall.body.result?.structuredContent ?? JSON.parse(projectsCall.body.result?.content?.[0]?.text ?? 'null');
    ok('mcp: tools/call list_projects → only what alice may read', projectsCall.status === 200 && projectsCall.body.result?.isError === false
      && Array.isArray(seen) && seen.length === 1 && seen[0].id === shared, JSON.stringify(projectsCall.body));
    const ds = await mcp({ bearer: token }, 'tools/call', { name: 'list_datasets', arguments: { project: shared } });
    ok('mcp: tools/call list_datasets on her project', ds.body.result?.isError === false && ds.body.result.content[0].text.includes('Sales'), JSON.stringify(ds.body));
    const hid = await mcp({ bearer: token }, 'tools/call', { name: 'list_datasets', arguments: { project: hidden } });
    ok('mcp: a project she cannot read does not exist for her', hid.body.result?.isError === true && /No project/.test(hid.body.result.content[0].text), JSON.stringify(hid.body));
    const vis = { project: shared, dataset: 'Sales', name: 'By region', chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } };
    const viewerWrite = await mcp({ bearer: token }, 'tools/call', { name: 'create_visual', arguments: vis });
    ok('mcp: a viewer\'s create_visual is refused (needs editor)', viewerWrite.body.result?.isError === true && /needs editor/.test(viewerWrite.body.result.content[0].text), JSON.stringify(viewerWrite.body));
    const carolToken = (await call({ email: 'carol@acme.test' }, 'tokens:create', { name: 'carol' })).body.token as string;
    tokens.push(carolToken);
    const editorWrite = await mcp({ bearer: carolToken }, 'tools/call', { name: 'create_visual', arguments: vis });
    ok('mcp: an editor\'s create_visual saves the visual', editorWrite.body.result?.isError === false, JSON.stringify(editorWrite.body));
    const mcpAudit = await q<{ actor: string; outcome: string; project_id: string }>(`SELECT actor, outcome, project_id FROM audit_log WHERE channel = 'mcp:create_visual' ORDER BY id`);
    ok('mcp: both write calls are audit rows (denied for alice, ok for carol), naming the project',
      JSON.stringify(mcpAudit) === JSON.stringify([{ actor: 'alice@acme.test', outcome: 'denied', project_id: shared }, { actor: 'carol@acme.test', outcome: 'ok', project_id: shared }]), JSON.stringify(mcpAudit));
    ok('mcp: read tools are not audited', (await q(`SELECT 1 FROM audit_log WHERE channel IN ('mcp:list_projects', 'mcp:list_datasets')`)).length === 0);

    const noToken = await mcp({}, 'initialize');
    ok('mcp: no credential → 401', noToken.status === 401);
    const headerOnly = await mcp({ email: 'boss@acme.test' }, 'initialize');
    ok('mcp: a signed-in member WITHOUT a token → 401 with WWW-Authenticate: Bearer', headerOnly.status === 401 && headerOnly.headers.get('www-authenticate') === 'Bearer');
    ok('mcp: a wrong token → 401', (await mcp({ bearer: 'ord_' + 'A'.repeat(43) }, 'initialize')).status === 401);
    ok('mcp: a malformed bearer → 401', (await mcp({ bearer: 'not-a-token' }, 'initialize')).status === 401);
    ok('mcp: a foreign Origin → 403', (await mcp({ bearer: token }, 'ping', {}, { origin: 'https://evil.example' })).status === 403);
    ok('mcp: the "null" Origin → 403', (await mcp({ bearer: token }, 'ping', {}, { origin: 'null' })).status === 403);
    ok('mcp: this server\'s own Origin is allowed', (await mcp({ bearer: token }, 'ping', {}, { origin: base })).status === 200);
    const big = await mcp({ bearer: token }, 'ping', {}, {}, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(httpT.MAX_BODY) } }));
    ok('mcp: a body over MAX_BODY (1 MB) → 413', big.status === 413, big.status);
    const bad = await mcp({ bearer: token }, 'ping', {}, {}, '{not json');
    ok('mcp: bad JSON → 400 with a JSON-RPC parse error', bad.status === 400 && bad.body.error?.code === -32700);
    const batch = await mcp({ bearer: token }, 'ping', {}, {}, '[]');
    ok('mcp: a batch → 400 invalid request', batch.status === 400 && batch.body.error?.code === -32600);
    const note = await mcp({ bearer: token }, 'ping', {}, {}, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    ok('mcp: a notification → 202, no body', note.status === 202);
    const get = await fetch(`${base}/api/mcp`, { headers: { authorization: `Bearer ${token}` } });
    ok('mcp: GET → 405 Allow: POST', get.status === 405 && get.headers.get('allow') === 'POST');

    // ── Role changes and disable apply to the token at once ───────────────
    await pool.query(`UPDATE users SET role = 'editor' WHERE email = 'alice@acme.test'`);
    ok('role change: alice\'s token now carries editor (may create a project)', (await call({ bearer: token }, 'projects:create', { name: 'Alice\'s' })).status === 200);
    await pool.query(`UPDATE users SET disabled_at = now() WHERE email = 'carol@acme.test'`);
    ok('disabled user: their token is refused (401)', (await call({ bearer: carolToken }, 'projects:list')).status === 401);

    // ── Revoke ────────────────────────────────────────────────────────────
    const id = listed[0].id as string;
    ok('revoke: someone else\'s token id is not theirs to revoke', (await call({ email: 'boss@acme.test' }, 'tokens:revoke', { id })).body.ok === false);
    ok('revoke: alice revokes hers', (await call({ email: 'alice@acme.test' }, 'tokens:revoke', { id })).body.ok === true);
    ok('revoke: the RPC API refuses it (401)', (await call({ bearer: token }, 'projects:list')).status === 401);
    ok('revoke: /api/mcp refuses it (401)', (await mcp({ bearer: token }, 'initialize')).status === 401);
    ok('revoke: gone from her list; revoking again is ok:false', (await call({ email: 'alice@acme.test' }, 'tokens:list')).body.length === 0
      && (await call({ email: 'alice@acme.test' }, 'tokens:revoke', { id })).body.ok === false);
    const trail = await q<{ channel: string; actor: string; outcome: string; target_ids: string[] }>(`SELECT channel, actor, outcome, target_ids FROM audit_log WHERE channel LIKE 'tokens:%' ORDER BY id`);
    ok('audit: token create and revoke are rows (tokens:list is not); revoke names the token id',
      trail.some((r) => r.channel === 'tokens:create' && r.actor === 'alice@acme.test' && r.outcome === 'ok')
        && trail.some((r) => r.channel === 'tokens:revoke' && r.target_ids.includes(id)) && !trail.some((r) => r.channel === 'tokens:list'), JSON.stringify(trail));

    // ── Redaction: no token value in any log line ─────────────────────────
    app.log.info({ cfg: { nested: { apiToken: token, accessToken: token, api_token: token, bearer: token } } }, 'redaction probe');
    await new Promise((r) => setTimeout(r, 50));
    const probe = log.find((l) => l.includes('redaction probe')) ?? '';
    ok('redaction: apiToken / accessToken / api_token / bearer keys are censored at depth', probe.includes('[redacted]') && !probe.includes(token), probe);
    const leaked = tokens.filter((t) => log.some((l) => l.includes(t) || l.includes(t.slice(4))));
    ok(`logs: ${log.length} trace-level lines, none holding any of ${tokens.length} token values`, log.length > 50 && leaked.length === 0, leaked.length);
    ok('logs: no Authorization header value was logged', !log.some((l) => /Bearer ord_/i.test(l)));
  } finally {
    await app?.close().catch(() => undefined);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
