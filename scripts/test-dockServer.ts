// The Assistant dock on the server (T2.12), over real HTTP against a stub
// model provider on loopback — no real network call is ever made.
//
//   1. Local CLI execution never happens on a server: this process blocks
//      Electron and records every module that resolves into src/cli; after the
//      whole flow below (readiness, connect, test, ask, models) none has.
//   2. API keys go through the encrypted secrets store (T5.3), never
//      config.json. A canary key is saved through the real RPC, reaches the stub
//      provider (it really was used), and is absent — in plain, URL-encoded,
//      hex and base64 spellings — from every config.json under DATA_DIR, a
//      row_to_json dump of every table, every log line, every RPC reply and
//      every SSE frame. Without a database (or master key) saving a key is
//      refused, and nothing is written.
//   3. The answer streams over SSE to the ASKING tab only: a second tab of the
//      same user, open the whole time, receives no chunk.
//   4. The org's "allowed AI providers" (Admin → Settings) is enforced: a
//      provider the org does not allow is never called and the dock is not ready.
//   5. Conversations are per member: another member of the project sees none of
//      the first member's threads and cannot read one by id.
//   6. The provider settings are org-admin only (a viewer gets 403).
//
// Without DATABASE_URL only the no-database half runs (one skip line).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-dockServer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import { randomBytes, randomUUID } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { Writable } from 'stream';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: the loader hook has no public type

// ── Every byte this process prints ──────────────────────────────────────────
let printed = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    printed += String(chunk);
    return orig(chunk, ...rest);
  };
}

// ── No Electron, and a record of anything that loads src/cli ────────────────
const cliLoads: string[] = [];
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]): string {
  if (request === 'electron' || request.startsWith('electron/')) throw new Error('electron is not available on the server');
  const file: string = resolve.call(this, request, ...rest);
  if (/[\\/]src[\\/]cli[\\/]/.test(file)) cliLoads.push(file);
  return file;
};

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const models: typeof import('../src/ai/models') = require('../src/ai/models');

const CANARY = `sk-ant-Canary/${randomBytes(8).toString('hex')}+x=y`;
const MASTER = randomBytes(32).toString('base64');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dock-'));
const ANSWER = ['This project ', 'has no datasets ', 'yet — import a file ', 'to start.'];

/** Every spelling of `v` a leak could take (as test-secrets.ts): plain, URL-encoded, hex, base64/base64url at 3 alignments. */
function spellings(v: string): string[] {
  const b = Buffer.from(v);
  const out = new Set<string>([v, encodeURIComponent(v), b.toString('hex')]);
  for (let off = 0; off < 3; off++) {
    const sub = b.subarray(off);
    const whole = sub.subarray(0, sub.length - (sub.length % 3));
    out.add(whole.toString('base64'));
    out.add(whole.toString('base64url'));
  }
  return [...out].map((x) => x.toLowerCase());
}
const NEEDLES = spellings(CANARY);
const leaks = (hay: string): boolean => {
  const h = hay.toLowerCase();
  return NEEDLES.some((n) => h.includes(n));
};

// ── A stub Anthropic Messages API ───────────────────────────────────────────
const stub = { keys: [] as string[], calls: 0, streamed: 0 };
const provider = http.createServer((req, res) => {
  stub.keys.push(String(req.headers['x-api-key'] ?? ''));
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    stub.calls++;
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-stub', display_name: 'Claude Stub', created_at: 1 }] }));
      return;
    }
    const json = JSON.parse(body || '{}') as { stream?: boolean };
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
      return;
    }
    stub.streamed++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    let i = 0;
    const tick = setInterval(() => {
      if (i < ANSWER.length) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER[i++] } })}\n\n`);
        return;
      }
      clearInterval(tick);
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }, 15);
  });
});

let appLog = '';
const logSink = () => new Writable({ write(c: Buffer, _e, cb) { appLog += c.toString(); cb(); } });
/** Every RPC reply and SSE frame the browser side saw. */
let wireSeen = '';

interface Tab { frames: { event: string; data: unknown }[]; close(): void }

/** Opens a tab's event stream and collects its frames. */
async function openTab(base: string, headers: Record<string, string>, client: string): Promise<Tab> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events?client=${client}`, { headers, signal: ac.signal });
  const frames: Tab['frames'] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const text = dec.decode(value, { stream: true });
        wireSeen += text;
        buf += text;
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const ev = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (ev && data !== undefined) frames.push({ event: ev, data: wire.decode(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  return { frames, close: () => ac.abort() };
}

function caller(base: string, headers: Record<string, string>) {
  return async (channel: string, payload?: unknown, client?: string) => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json', ...headers, ...(client ? { 'x-ordinate-client': client } : {}) }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    wireSeen += text;
    return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
  };
}

/** Every file under `dir`, as text. */
function allFiles(dir: string): string {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out += allFiles(p);
    else if (e.isFile()) out += fs.readFileSync(p, 'latin1');
  }
  return out;
}

const listen = async (app: import('fastify').FastifyInstance): Promise<string> => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
};

(async () => {
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const stubUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  ok('grep: a planted canary is found in every spelling', NEEDLES.every((n) => leaks(`x ${n} y`)) && !leaks('nothing here'));

  context.enterServerMode(DATA);
  appMod.registerHandlers();
  // The stub provider is on loopback, which the SSRF guard refuses on a server (T6.1);
  // an operator opens an internal gateway the same way.
  process.env.SSRF_ALLOW = '127.0.0.1/32,::1/128';

  // ── 1. No database: keys are refused, nothing is written ──────────────────
  const noDb = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'info', DATA_DIR: DATA, ORDINATE_MASTER_KEY: MASTER }), logSink());
  const noDbBase = await listen(noDb);
  const devCall = caller(noDbBase, {});
  const st0 = await devCall('key:status');
  ok('no DB: key:status answers, not ready', st0.status === 200 && st0.body.isReady === false, JSON.stringify(st0.body));
  ok('no DB: key:status says why keys cannot be stored', /no database/.test(String(st0.body.keyStore)), st0.body.keyStore);
  ok('no DB: the server runs API-key providers only (mode byok, no local CLIs listed)', st0.body.executionMode === 'byok' && st0.body.localCli.clis.length === 0);
  const refused = await devCall('byok:saveProvider', { provider: 'anthropic', fields: { apiKey: CANARY, baseUrl: stubUrl } });
  ok('no DB: saving a key is refused with the reason', refused.status === 200 && refused.body.ok === false && /no database/.test(refused.body.error), JSON.stringify(refused.body));
  ok('no DB: the refused key is in no file under DATA_DIR', !leaks(allFiles(DATA)));
  const plain = await devCall('byok:saveProvider', { provider: 'anthropic', fields: { model: 'claude-x' } });
  ok('no DB: non-secret fields still save', plain.body.ok === true);
  const proj0 = (await devCall('projects:create', { name: 'No DB' })).body.id as string;
  const notReady = await devCall('copilot:ask', { projectId: proj0, context: { kind: '' }, question: 'What is here?' });
  ok('no DB: an ask with no provider is notReady, not an error', notReady.body.ok === false && notReady.body.notReady === true, JSON.stringify(notReady.body));
  ok('contract: an unknown context kind is a 400', (await devCall('copilot:ask', { projectId: proj0, context: { kind: 'shell' }, question: 'x' })).status === 400);
  ok('contract: a local-CLI channel has no contract (404)', (await devCall('cli:detect')).status === 404 && (await devCall('exec:setMode', { mode: 'local' })).status === 404);
  await noDb.close();

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip dock DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    ok('src/cli never loaded on the server', cliLoads.length === 0, cliLoads.join());
    provider.close();
    finish();
    return;
  }

  const dbName = `ordinate_t212_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  try {
    const app = appMod.buildApp(envMod.parseEnv({
      LOG_LEVEL: 'trace', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), ORDINATE_MASTER_KEY: MASTER, AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
    }), logSink());
    const base = await listen(app);
    const H = (email: string) => ({ 'x-forwarded-email': email });
    const boss = caller(base, H('boss@acme.test'));
    const vic = caller(base, H('vic@acme.test'));
    await boss('projects:list');
    await vic('projects:list'); // provisions vic as a viewer
    const project = (await boss('projects:create', { name: 'Ledger' })).body.id as string;
    const vicId = (await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'vic@acme.test'`)).rows[0].id;
    ok('setup: vic is a viewer of the project', (await boss('project:share', { projectId: project, member: { userId: vicId }, role: 'viewer' })).body.ok !== false);

    // ── Provider settings are the org admin's ────────────────────────────────
    ok('authz: a viewer cannot save a provider key (403)', (await vic('byok:saveProvider', { provider: 'anthropic', fields: { apiKey: CANARY } })).status === 403);
    ok('authz: a viewer cannot test or activate a provider (403)', (await vic('byok:test', { provider: 'anthropic' })).status === 403 && (await vic('byok:activate', { provider: 'anthropic' })).status === 403);
    ok('authz: a viewer reads readiness (200)', (await vic('key:status')).status === 200);

    // ── Connect: key → store, test against the stub, activate ────────────────
    const saved = await boss('byok:saveProvider', { provider: 'anthropic', fields: { apiKey: CANARY, baseUrl: stubUrl } });
    ok('connect: the admin saves the key', saved.body.ok === true, JSON.stringify(saved.body));
    const row = (await pool.query(`SELECT org_id, kind, ref FROM secrets`)).rows;
    ok('connect: the key is one encrypted row (acme, ai.apiKey, anthropic)', row.length === 1 && row[0].org_id === 'acme' && row[0].kind === 'ai.apiKey' && row[0].ref === 'anthropic', JSON.stringify(row));
    const tested = await boss('byok:test', { provider: 'anthropic' });
    ok('connect: the connectivity test passes against the stub', tested.body.ok === true, JSON.stringify(tested.body));
    ok('connect: the stub received exactly the stored key (it came back out of the store)', stub.keys.at(-1) === CANARY);
    ok('connect: activate', (await boss('byok:activate', { provider: 'anthropic' })).body.ok === true);
    const st = await boss('key:status');
    ok('status: ready, anthropic active and has a key — as flags only', st.body.isReady === true && st.body.byok.activeProvider === 'anthropic' && st.body.byok.providers.anthropic.hasKey === true, JSON.stringify(st.body.byok));

    // models.ts reads its key through the store too.
    const listed = await context.runInContext({ user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } }, 'models', () => models.listModels('anthropic'));
    ok('models: the live list reaches the stub with the stored key', listed.ok && listed.models[0]?.id === 'claude-sonnet-stub' && stub.keys.at(-1) === CANARY, JSON.stringify(listed));

    // ── Ask: streamed to the asking tab only ──────────────────────────────────
    const tabA = randomUUID();
    const tabB = randomUUID();
    const a = await openTab(base, H('boss@acme.test'), tabA);
    const b = await openTab(base, H('boss@acme.test'), tabB);
    await new Promise((r) => setTimeout(r, 100));
    const askId = randomUUID();
    const asked = await boss('copilot:ask', { projectId: project, context: { kind: '' }, question: 'What is in this project?', askId }, tabA);
    await new Promise((r) => setTimeout(r, 100));
    const chunks = a.frames.filter((f) => f.event === 'copilot:ask:chunk').map((f) => f.data as { askId: string; delta: string });
    ok('ask: the reply is ok and is the stub\'s narration', asked.body.ok === true && asked.body.answer === ANSWER.join(''), JSON.stringify(asked.body).slice(0, 400));
    ok('ask: the stub was called with streaming on', stub.streamed === 1);
    ok('ask: the asking tab got the answer token by token (≥ 2 chunks, all for this askId)', chunks.length >= 2 && chunks.every((c) => c.askId === askId), chunks.length);
    ok('ask: the chunks join to the stored answer exactly', chunks.map((c) => c.delta).join('') === ANSWER.join(''), chunks.map((c) => c.delta).join('|'));
    ok('ask: the asking tab got the app\'s activity steps (incl. the one model step)', a.frames.some((f) => f.event === 'copilot:ask:activity' && (f.data as { step: { kind: string } }).step.kind === 'model'));
    ok('ask: the OTHER tab of the same user got nothing of it', !b.frames.some((f) => f.event.startsWith('copilot:ask')), b.frames.map((f) => f.event).join());
    ok('ask: both turns persisted to a thread', Array.isArray(asked.body.turns) && asked.body.turns.length === 2 && typeof asked.body.threadId === 'string');
    ok('ask: provenance says the app computed the facts', asked.body.provenance?.note === 'stats app-computed' || JSON.stringify(asked.body.turns[1].provenance ?? {}).includes('app-computed'), JSON.stringify(asked.body.provenance));
    a.close();
    b.close();

    // ── Conversations are per member ─────────────────────────────────────────
    const vicThreads = await vic('copilot:threads', { projectId: project });
    ok('threads: another member sees none of the first member\'s conversations', vicThreads.status === 200 && vicThreads.body.threads.length === 0, JSON.stringify(vicThreads.body));
    const peek = await vic('copilot:history', { projectId: project, threadId: asked.body.threadId });
    ok('threads: nor reads one by id', peek.body.ok === true && peek.body.turns.length === 0 && peek.body.threadId === null, JSON.stringify(peek.body));
    ok('threads: the owner still has it', (await boss('copilot:threads', { projectId: project })).body.threads.length === 1);

    // ── The org's allowed providers ──────────────────────────────────────────
    ok('policy: the admin narrows the org to OpenAI', (await boss('admin:saveSettings', { publicLinks: false, aiProviders: ['openai'], uploadCapMb: null })).body.ok === true);
    const blocked = await boss('key:status');
    ok('policy: the dock is not ready when the active provider is not allowed', blocked.body.isReady === false && JSON.stringify(blocked.body.allowedProviders) === '["openai"]', JSON.stringify(blocked.body.allowedProviders));
    const calls = stub.calls;
    const deny = await boss('copilot:ask', { projectId: project, context: { kind: '' }, question: 'Again?' });
    ok('policy: an ask is refused, naming the policy, and the provider is never called', deny.body.ok === false && /does not allow/.test(deny.body.error) && stub.calls === calls, JSON.stringify(deny.body));
    ok('policy: test/save/activate refuse a disallowed provider', (await boss('byok:test', { provider: 'anthropic' })).body.errorType === 'not_allowed'
      && (await boss('byok:saveProvider', { provider: 'anthropic', fields: { model: 'x' } })).body.ok === false && (await boss('byok:activate', { provider: 'anthropic' })).body.ok === false);
    await boss('admin:saveSettings', { publicLinks: false, aiProviders: ['anthropic', 'openai', 'gemini', 'gateway'], uploadCapMb: null });
    ok('policy: allowed again → ready again', (await boss('key:status')).body.isReady === true);

    // ── The canary is nowhere it must not be ─────────────────────────────────
    const tables = (await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.t);
    let dump = '';
    for (const t of tables) dump += (await pool.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM "${t}" x`)).rows.map((r) => r.j).join('\n');
    ok(`leak: no canary in a row_to_json dump of all ${tables.length} tables`, dump.length > 0 && !leaks(dump));
    const configs = allFiles(DATA);
    ok('leak: no canary in any file under DATA_DIR (config.json included)', configs.includes('keyStored') && !leaks(configs));
    ok('leak: no canary in any RPC reply or SSE frame', wireSeen.length > 0 && !leaks(wireSeen));
    ok('leak: no canary in the app log (trace level) or anything this process printed', appLog.length > 0 && !leaks(appLog) && !leaks(printed));

    // ── Clearing the key ──────────────────────────────────────────────────────
    ok('clear: an empty key removes the stored secret', (await boss('byok:saveProvider', { provider: 'anthropic', fields: { apiKey: '' } })).body.ok === true
      && (await pool.query('SELECT 1 FROM secrets')).rowCount === 0 && (await boss('key:status')).body.isReady === false);

    await app.close();
  } finally {
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
    provider.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  ok('src/cli never loaded on the server (asked, connected, tested, listed models)', cliLoads.length === 0, cliLoads.join());
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
