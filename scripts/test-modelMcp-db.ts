// The model files over the real MCP door (semantic layer part 7, a4): `POST /api/mcp` with personal API tokens, against
// a real Postgres. The registry-level behaviour is in ./test-modelMcp.ts; this is the access and the audit.
//
//   1. An editor's token exports the model inline, and the call is audited ok.
//   2. NEGATIVE CONTROL / D7: a viewer's token is denied export_model and import_model (dry run and apply), and each call
//      is audited as denied; nothing is written.
//   3. An editor's token dry-runs an edited file, then applies it with the plan's hash; the project's export shows it.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-modelMcp-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

type Identity = import('../src/server/context').Identity;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-model-mcp-db-'));
const BOSS: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip MCP publish DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_modelmcp_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  let app: FastifyInstance | null = null;
  try {
    context.enterServerMode(DATA);
    appMod.registerHandlers();
    app = appMod.buildApp(envMod.parseEnv({
      LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');

    const call = async (email: string, channel: string, payload?: unknown) => {
      const res = await fetch(`${base}/api/rpc/${channel}`, {
        method: 'POST',
        headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email }),
        body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
    };
    let rpcId = 0;
    /** One tools/call: the reply's text, its parsed JSON when it ran, and whether it is an error. */
    const tool = async (token: string, name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
      });
      const body = await res.json() as any; // any: a JSON-RPC reply
      const text = String(body.result?.content?.[0]?.text ?? JSON.stringify(body));
      const isError = body.result?.isError !== false;
      return { isError, text, json: isError ? null : JSON.parse(text) as any }; // any: the tool's JSON
    };
    const q = async <T extends object>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
    const asBoss = <T>(fn: () => Promise<T>) => context.runInContext(BOSS, 'read', fn);

    // ── Members, the project, a dataset, a token each ─────────────────────
    for (const p of ['boss', 'vic', 'eve']) await call(`${p}@acme.test`, 'projects:list');
    await pool.query(`UPDATE users SET role = 'editor' WHERE email = 'eve@acme.test'`);
    const P = (await call('boss@acme.test', 'projects:create', { name: 'Board room' })).body.id as string;
    const uid = async (email: string) => (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))[0].id;
    await call('boss@acme.test', 'project:share', { projectId: P, member: { userId: await uid('vic@acme.test') }, role: 'viewer' });
    await call('boss@acme.test', 'project:share', { projectId: P, member: { userId: await uid('eve@acme.test') }, role: 'editor' });
    await asBoss(() => datasets.saveDataset(P, {
      name: 'Sales', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['north', 3], ['south', 4]],
    }));
    const tokenOf = async (email: string) => (await call(email, 'tokens:create', { name: 'agent', expiresInDays: 30 })).body.token as string;
    const vic = await tokenOf('vic@acme.test');
    const eve = await tokenOf('eve@acme.test');

    const model: typeof import('../src/app/modelExport') = require('../src/app/modelExport');
    const first = await asBoss(() => model.exportModel(P));
    const files0 = Object.fromEntries(first.files);

    // ── 1. The editor exports ─────────────────────────────────────────────
    const ex = await tool(eve, 'export_model', { project: P });
    ok('export_model (editor token): the same files as the server\'s export', !ex.isError && JSON.stringify(ex.json.files) === JSON.stringify(files0) && ex.json.format === 'ordinate-model', ex.text.slice(0, 200));

    // ── 2. NEGATIVE CONTROL: the viewer is denied, and audited ────────────
    const edited = { ...files0 };
    const sales = Object.keys(files0).find((k) => k.startsWith('datasets/') && k.endsWith('.json')) as string;
    edited[sales] = JSON.stringify({ ...JSON.parse(files0[sales]), description: 'Changed by a token' }, null, 2) + '\n';
    const denied = [
      await tool(vic, 'export_model', { project: P }),
      await tool(vic, 'import_model', { project: P, files: edited }),
      await tool(vic, 'import_model', { project: P, files: edited, apply: true, planHash: 'x' }),
    ];
    ok('a viewer\'s token is denied export_model and import_model, dry run or apply', denied.every((d) => d.isError && /needs editor access/.test(d.text) && !d.text.includes('"files"')), denied.map((d) => d.text));
    const audits = await q<{ channel: string; actor: string; outcome: string }>(
      `SELECT channel, actor, outcome FROM audit_log WHERE channel IN ('mcp:export_model', 'mcp:import_model') ORDER BY id`);
    ok('audit: the editor\'s export is an ok row, the viewer\'s three calls are denied rows', JSON.stringify(audits) === JSON.stringify([
      { channel: 'mcp:export_model', actor: 'eve@acme.test', outcome: 'ok' },
      { channel: 'mcp:export_model', actor: 'vic@acme.test', outcome: 'denied' },
      { channel: 'mcp:import_model', actor: 'vic@acme.test', outcome: 'denied' },
      { channel: 'mcp:import_model', actor: 'vic@acme.test', outcome: 'denied' },
    ]), JSON.stringify(audits));
    const nothing = await asBoss(() => model.exportModel(P));
    ok('…and nothing was written', JSON.stringify(Object.fromEntries(nothing.files)) === JSON.stringify(files0));

    // ── 3. The editor dry-runs, then applies with the hash ────────────────
    const dry = await tool(eve, 'import_model', { project: P, files: edited });
    ok('import_model (editor token): a dry run', !dry.isError && typeof dry.json.plan.hash === 'string', dry.text.slice(0, 200));
    const applied = await tool(eve, 'import_model', { project: P, files: edited, apply: true, planHash: dry.json.plan.hash });
    ok('…and an apply with its hash writes one change', !applied.isError && applied.json.written.length === 1 && applied.json.failed.length === 0, applied.text.slice(0, 200));
    const final = await asBoss(() => model.exportModel(P));
    ok('…and the export shows it', [...final.files.values()].some((t) => t.includes('Changed by a token')));
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
