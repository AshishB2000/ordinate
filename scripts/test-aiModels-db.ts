// AI models on Postgres (docs/ai-models/00-plan.md §6 "AI1 tests"): the org's
// connected providers, its model allow-list and each member's pick, shared by
// every pod. Real HTTP (header sign-in) against a stub Anthropic API on
// loopback — no real network call is ever made.
//
//   pods       connect on pod A → pod B (another pool, another DATA_DIR) is
//              ready with the same models. NEGATIVE CONTROL: the old
//              config.json path, saved on A, is not ready on B
//   picks      a member's pick is what every model call runs on; removing it
//              → the default; a model not enabled is refused; a pick in one
//              org is invisible in another
//   access     a viewer gets 403 on every admin ai:* channel before its
//              handler runs, and may read ai:status and set their own pick
//   canary     a planted key is in no reply (ai:admin included), log line,
//              SSE frame or file under DATA_DIR
//   legacy     an old config.json (2 providers, one disallowed) imports the
//              allowed one as the default, once across racing reads; a later
//              empty list stays empty. NEGATIVE CONTROL: without the import
//              row it imports again
//   rls        as an ordinary role: the wrong org sees nothing
//   setModels  an unconnected provider, a missing default and a duplicate are
//              refused; two defaults are refused by the database itself
//
// Needs a Postgres it may CREATE DATABASE (and ROLE) on; without DATABASE_URL
// it prints one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-aiModels-db.js

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

let printed = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    printed += String(chunk);
    return orig(chunk, ...rest);
  };
}

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const aiKeys: typeof import('../src/server/aiKeys') = require('../src/server/aiKeys');
const aiConfig: typeof import('../src/server/aiConfig') = require('../src/server/aiConfig');
const byok: typeof import('../src/ai/byok') = require('../src/ai/byok');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const config: typeof import('../src/app/config') = require('../src/app/config');
const orgConfig: typeof import('../src/server/orgConfig') = require('../src/server/orgConfig');

type Identity = import('../src/server/context').Identity;
const CANARY = `sk-ant-Canary/${randomBytes(8).toString('hex')}+x=y`;
const MASTER = randomBytes(32).toString('base64');
const DATA_A = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-aimodels-a-'));
const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-aimodels-b-'));
const BOSS: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
const VIC: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const show = (v: unknown): string => JSON.stringify(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const modelOf = (r: object): unknown => (r as { model?: string }).model;
const as = <T>(who: Identity, fn: () => Promise<T>): Promise<T> => context.runInContext(who, randomUUID(), fn);

/** Every spelling of `v` a leak could take (as test-secrets.ts). */
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
const leaks = (hay: string): boolean => NEEDLES.some((n) => hay.toLowerCase().includes(n));

// ── A stub Anthropic API: lists two models, answers OK, refuses `sk-bad` ────
const stub = { calls: 0, models: [] as string[] };
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    stub.calls++;
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-api-key'] === 'sk-bad') {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { type: 'authentication_error' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-a', display_name: 'Claude Stub A', created_at: 2 }, { id: 'claude-haiku-b', display_name: 'Claude Stub B', created_at: 1 }] }));
      return;
    }
    stub.models.push(String((JSON.parse(body || '{}') as { model?: string }).model));
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
  });
});

let appLog = '';
let wireSeen = '';
const logSink = () => new Writable({ write(c: Buffer, _e, cb) { appLog += c.toString(); cb(); } });

function allFiles(dir: string): string {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out += allFiles(p);
    else if (e.isFile()) out += fs.readFileSync(p, 'latin1');
  }
  return out;
}

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip AI models DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    finish();
    return;
  }
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const stubUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const dbName = `ordinate_ai1_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const podB = new Pool({ connectionString: scratch.toString(), max: 4 });
  podB.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const role = `ordinate_ai1_${process.pid}_${randomBytes(3).toString('hex')}`;
  let rolePool: Pool | null = null;
  const env = (org: string) => envMod.parseEnv({
    LOG_LEVEL: 'trace', DATA_DIR: DATA_A, DATABASE_URL: scratch.toString(), ORDINATE_MASTER_KEY: MASTER, AUTH_MODE: 'header',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: org, ORDINATE_ADMIN_EMAIL: `boss@${org}.test`, RATE_LIMIT_RPC_PER_MINUTE: '100000',
  });
  const apps: import('fastify').FastifyInstance[] = [];
  try {
    context.enterServerMode(DATA_A);
    appMod.registerHandlers();
    process.env.SSRF_ALLOW = '127.0.0.1/32,::1/128'; // the stub is on loopback, as an operator opens an internal gateway
    const base: Record<string, string> = {};
    for (const org of ['acme', 'beta']) {
      const app = appMod.buildApp(env(org), logSink());
      apps.push(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      base[org] = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    }
    const call = async (org: string, email: string, channel: string, payload?: unknown) => {
      const res = await fetch(`${base[org]}/api/rpc/${channel}`, {
        method: 'POST', headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email }), body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      wireSeen += text;
      return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
    };
    const boss = (ch: string, p?: unknown) => call('acme', 'boss@acme.test', ch, p);
    const vic = (ch: string, p?: unknown) => call('acme', 'vic@acme.test', ch, p);
    const q = async <T extends object>(sql: string, args: unknown[] = []) => (await podB.query<T>(sql, args)).rows;
    await boss('projects:list');
    await vic('projects:list'); // provisions vic as a viewer
    const project = (await boss('projects:create', { name: 'Ledger' })).body.id as string;
    const vicId = (await q<{ id: string }>(`SELECT id FROM users WHERE email = 'vic@acme.test'`))[0].id;
    await boss('project:share', { projectId: project, member: { userId: vicId }, role: 'viewer' });
    ok('migration: the four tables exist with forced RLS', (await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class WHERE relname IN ('org_ai_providers', 'org_ai_models', 'user_ai_model', 'org_ai_imports') AND relforcerowsecurity`))[0].n === '4');

    // An event stream for the admin, to see the pushes (and that no key rides one).
    const ac = new AbortController();
    const frames: string[] = [];
    const sse = await fetch(`${base.acme}/api/events?client=${randomUUID()}`, { headers: { 'x-forwarded-email': 'boss@acme.test' }, signal: ac.signal });
    void (async () => {
      const reader = sse.body!.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          const text = dec.decode(value, { stream: true });
          wireSeen += text;
          frames.push(text);
        }
      } catch {
        // aborted
      }
    })();

    // ── Nothing set up ──────────────────────────────────────────────────────
    const st0 = await vic('ai:status');
    ok('empty: a member is not ready, no models, no pick', st0.status === 200 && st0.body.ready === false && st0.body.reason === 'no_model' && st0.body.models.length === 0 && st0.body.mine === null, show(st0.body));
    const ask0 = await as(VIC, () => byok.resolveByok());
    ok('empty: a model call refuses with the Admin → AI sentence', ask0.error?.message === 'AI isn’t set up for your organization. An admin can turn it on in Admin → AI.', show(ask0));

    // ── Access: a viewer, before any handler runs ───────────────────────────
    const callsBefore = stub.calls;
    const denied = await Promise.all([
      vic('ai:admin'), vic('ai:connect', { provider: 'anthropic', apiKey: CANARY, baseUrl: stubUrl }), vic('ai:disconnect', { provider: 'anthropic' }),
      vic('ai:setModels', { models: [], defaultIndex: 0 }), vic('ai:providerModels', { provider: 'anthropic' }),
    ]);
    ok('access: a viewer gets 403 on ai:admin, connect, disconnect, setModels, providerModels', denied.every((r) => r.status === 403), show(denied.map((r) => r.status)));
    ok('access: …before the handler ran (no provider call, no key, no row)', stub.calls === callsBefore
      && (await q('SELECT 1 FROM secrets')).length === 0 && (await q('SELECT 1 FROM org_ai_providers')).length === 0);
    ok('access NEGATIVE CONTROL: the admin reaches ai:admin (200)', (await boss('ai:admin')).status === 200);

    // ── Connect: a bad key is saved but not connected; a good one connects ──
    const bad = await boss('ai:connect', { provider: 'anthropic', apiKey: 'sk-bad', baseUrl: stubUrl });
    const badRow = (await q<{ verified_at: Date | null }>(`SELECT verified_at FROM org_ai_providers WHERE org_id = 'acme'`))[0];
    ok('connect: a failing test answers with the provider\'s error and leaves the provider not connected', bad.body.ok === false && badRow && badRow.verified_at === null, show(bad.body));
    const good = await boss('ai:connect', { provider: 'anthropic', apiKey: CANARY, baseUrl: stubUrl });
    ok('connect: a passing test connects it', good.body.ok === true && (await boss('ai:admin')).body.providers[0].connected === true, show(good.body));
    ok('connect: openai with no key is refused, nothing called', (await boss('ai:connect', { provider: 'openai' })).body.ok === false);
    // SSRF: the gateway's base URL goes through the guard (providerFetch); only loopback is allowlisted here.
    const meta = await boss('ai:connect', { provider: 'gateway', baseUrl: 'http://169.254.169.254/v1', model: 'x' });
    ok('ssrf: a gateway at the metadata address fails its test and is not connected', meta.body.ok === false
      && (await q<{ verified_at: Date | null }>(`SELECT verified_at FROM org_ai_providers WHERE provider = 'gateway'`))[0]?.verified_at === null, show(meta.body));
    ok('ssrf: …refused by the guard before any socket (its own sentence in the log, not a timeout)', printed.includes('169.254.169.254 is an internal address'));
    await boss('ai:disconnect', { provider: 'gateway' });
    const listed = await boss('ai:providerModels', { provider: 'anthropic' });
    ok('providerModels: the provider\'s live list, through the stored key', listed.body.ok === true && listed.body.models.map((m: { id: string }) => m.id).join() === 'claude-sonnet-a,claude-haiku-b', show(listed.body));

    // ── setModels: the allow-list's rules ───────────────────────────────────
    const two = [{ provider: 'anthropic', model: 'claude-sonnet-a', label: 'Claude Stub A' }, { provider: 'anthropic', model: 'claude-haiku-b', label: 'Claude Stub B' }];
    ok('setModels: a provider that is not connected is refused', (await boss('ai:setModels', { models: [...two, { provider: 'openai', model: 'gpt-x', label: 'x' }], defaultIndex: 0 })).body.ok === false);
    ok('setModels: no default (index past the list) is refused', (await boss('ai:setModels', { models: two, defaultIndex: 2 })).body.ok === false);
    ok('setModels: a model listed twice is refused', (await boss('ai:setModels', { models: [two[0], two[0]], defaultIndex: 0 })).body.ok === false);
    ok('setModels: …and none of those wrote a row', (await q('SELECT 1 FROM org_ai_models')).length === 0);
    ok('setModels: two models, the first the default', (await boss('ai:setModels', { models: two, defaultIndex: 0 })).body.ok === true);
    let twoDefaults = '';
    const one = await podB.connect();
    try {
      await one.query(`BEGIN; SELECT set_config('ordinate.org', 'acme', true)`);
      await one.query(`UPDATE org_ai_models SET is_default = true WHERE org_id = 'acme'`);
    } catch (e) {
      twoDefaults = (e as Error).message;
    } finally {
      await one.query('ROLLBACK');
      one.release();
    }
    ok('setModels: two defaults are refused by the database itself (unique partial index)', /org_ai_models_one_default/.test(twoDefaults), twoDefaults);

    // ── Pods: pod B, another pool and another disk, sees the same setup ─────
    const masterKey = env('acme').masterKey;
    // NEGATIVE CONTROL first: the old path, saved on A's disk… The org's settings
    // document is a Postgres row now (0014_org_config), so this is the file alone.
    config.useBacking(null);
    const legacyA = await as(BOSS, async () => {
      await execConfig.saveByokProvider('gateway', { baseUrl: stubUrl, model: 'x' });
      execConfig.setByokVerified('gateway', true);
      return execConfig.effectiveByokActive();
    });
    aiKeys.useAiKeys(podB, masterKey);
    context.enterServerMode(DATA_B);
    const legacyB = await as(BOSS, async () => execConfig.effectiveByokActive());
    const viewB = await as(VIC, () => aiConfig.memberView());
    ok('pods NEGATIVE CONTROL: config.json saved on pod A says ready there and not on pod B', legacyA === 'gateway' && legacyB === null, show({ legacyA, legacyB }));
    orgConfig.useOrgConfig(podB, DATA_A);
    ok('pods: pod B is ready with the same two models and the default', viewB.ready && viewB.models.map((m) => m.model).join() === 'claude-sonnet-a,claude-haiku-b' && viewB.mine?.model === 'claude-sonnet-a', show(viewB));
    context.enterServerMode(DATA_A);

    // ── Picks ───────────────────────────────────────────────────────────────
    const vs = await vic('ai:status');
    ok('picks: a viewer reads ai:status (200) — the default is marked', vs.status === 200 && vs.body.models.find((m: { isDefault: boolean }) => m.isDefault)?.model === 'claude-sonnet-a');
    ok('picks: a viewer may pick a model (200, ok)', (await vic('ai:setMine', { provider: 'anthropic', model: 'claude-haiku-b' })).body.ok === true);
    ok('picks: a model that is not enabled is refused', (await vic('ai:setMine', { provider: 'anthropic', model: 'claude-opus-z' })).body.ok === false
      && (await vic('ai:setMine', { provider: 'openai', model: 'claude-sonnet-a' })).body.ok === false);
    const r1 = await as(VIC, () => byok.resolveByok());
    ok('picks: the member\'s pick is what resolveByok returns', r1.error === undefined && r1.model === 'claude-haiku-b' && r1.apiKey === CANARY, show({ ...r1, apiKey: undefined }));
    const asked = await call('acme', 'vic@acme.test', 'copilot:ask', { projectId: project, context: { kind: '' }, question: 'Which model?' });
    ok('picks: …and what a real ask sent the provider', asked.body.ok === true && stub.models.at(-1) === 'claude-haiku-b', show(stub.models.slice(-2)));
    ok('picks: the admin still gets the default', modelOf(await as(BOSS, () => byok.resolveByok())) === 'claude-sonnet-a');
    const beta = await as({ user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'beta' } }, () => aiConfig.memberView());
    ok('picks: the same email in org beta has no pick and no models', beta.mine === null && beta.models.length === 0 && (await call('beta', 'boss@beta.test', 'ai:status')).body.ready === false, show(beta));
    ok('picks: removing the picked model falls back to the default', (await boss('ai:setModels', { models: [two[0]], defaultIndex: 0 })).body.ok === true
      && modelOf(await as(VIC, () => byok.resolveByok())) === 'claude-sonnet-a' && (await q('SELECT 1 FROM user_ai_model')).length === 0);

    // ── Disconnect leaves no pick pointing at nothing ───────────────────────
    await vic('ai:setMine', { provider: 'anthropic', model: 'claude-sonnet-a' });
    ok('disconnect: removes the key, the provider, its models and every pick', (await boss('ai:disconnect', { provider: 'anthropic' })).body.ok === true
      && (await q('SELECT 1 FROM secrets')).length === 0 && (await q('SELECT 1 FROM org_ai_models UNION ALL SELECT 1 FROM user_ai_model')).length === 0
      && (await vic('ai:status')).body.ready === false);
    await sleep(100);
    ok('push: every write reached the admin\'s stream as key:changed', frames.join('').split('event: key:changed').length - 1 >= 5);

    // ── Legacy import ───────────────────────────────────────────────────────
    const LEG: Identity = { user: { email: 'boss@legacy.test', role: 'admin' }, org: { id: 'legacy' } };
    await podB.query(`INSERT INTO orgs (id, name) VALUES ('legacy', 'Legacy')`);
    await podB.query(`INSERT INTO org_settings (org_id, ai_providers) VALUES ('legacy', ARRAY['anthropic'])`);
    const dir = path.join(DATA_A, 'orgs', 'legacy', 'userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      version: 2,
      byok: {
        activeProvider: 'openai',
        providers: {
          anthropic: { apiKey: null, keyStored: true, verified: true, baseUrl: stubUrl, model: 'claude-old', maxTokens: '' },
          openai: { apiKey: null, keyStored: true, verified: true, baseUrl: 'https://api.openai.com/v1', model: 'gpt-old', maxTokens: '' },
        },
      },
    }));
    const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    await as(LEG, async () => { config.load(); await aiKeys.putKey('anthropic', CANARY); });
    const raced = await as(LEG, () => Promise.all([aiConfig.memberView(), aiConfig.memberView(), aiConfig.adminView(), aiConfig.memberView()]));
    const legRows = await as(LEG, async () => (await podB.query<{ provider: string; model: string; is_default: boolean }>(
      `SELECT provider, model, is_default FROM org_ai_models WHERE org_id = 'legacy'`)).rows);
    ok('legacy: the allowed provider is imported with its model as the default; the disallowed one is not', legRows.length === 1
      && legRows[0].provider === 'anthropic' && legRows[0].model === 'claude-old' && legRows[0].is_default
      && (await q(`SELECT 1 FROM org_ai_providers WHERE org_id = 'legacy'`)).length === 1, show(legRows));
    ok('legacy: four racing reads imported once, and every one answered ready', raced.filter((v) => 'ready' in v).every((v) => (v as { ready: boolean }).ready)
      && (await q(`SELECT 1 FROM org_ai_imports WHERE org_id = 'legacy'`)).length === 1);
    ok('legacy: config.json is never edited', fs.readFileSync(path.join(dir, 'config.json'), 'utf8') === before);
    await as(LEG, () => aiConfig.disconnect('anthropic'));
    ok('legacy: after a disconnect the empty list stays empty (no re-import)', (await as(LEG, () => aiConfig.memberView())).ready === false
      && (await q(`SELECT 1 FROM org_ai_providers WHERE org_id = 'legacy'`)).length === 0);
    await podB.query(`BEGIN; SELECT set_config('ordinate.org', 'legacy', true); DELETE FROM org_ai_imports; COMMIT`);
    await as(LEG, () => aiConfig.memberView());
    ok('legacy NEGATIVE CONTROL: without the import row the next read imports again', (await q(`SELECT 1 FROM org_ai_providers WHERE org_id = 'legacy'`)).length === 1);

    // ── RLS, as an ordinary role ────────────────────────────────────────────
    await boss('ai:connect', { provider: 'anthropic', apiKey: CANARY, baseUrl: stubUrl });
    await boss('ai:setModels', { models: [two[0]], defaultIndex: 0 });
    const pw = randomBytes(12).toString('hex');
    await podB.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await podB.query(`GRANT SELECT ON org_ai_providers, org_ai_models, user_ai_model, org_ai_imports TO ${role}`);
    const asRole = new URL(scratch.toString());
    asRole.username = role;
    asRole.password = pw;
    rolePool = new Pool({ connectionString: asRole.toString(), max: 2 });
    rolePool.on('error', () => undefined);
    const rp = rolePool;
    const see = async (org: string | null) => {
      const c = await rp.connect();
      try {
        await c.query('BEGIN');
        if (org) await c.query(`SELECT set_config('ordinate.org', $1, true)`, [org]);
        const r = await c.query<{ org_id: string }>('SELECT org_id FROM org_ai_providers UNION ALL SELECT org_id FROM org_ai_models UNION ALL SELECT org_id FROM org_ai_imports');
        await c.query('COMMIT');
        return r.rows;
      } finally {
        c.release();
      }
    };
    const seenAcme = await see('acme');
    ok('rls: as acme the ordinary role sees acme\'s rows only (not vacuous)', seenAcme.length >= 3 && seenAcme.every((r) => r.org_id === 'acme'), show(seenAcme));
    ok('rls: with the wrong org (beta), none of acme\'s', (await see('beta')).every((r) => r.org_id === 'beta'));
    ok('rls: with no setting, nothing', (await see(null)).length === 0);

    // ── The canary is nowhere it must not be ────────────────────────────────
    ok('canary: ai:admin carries has-key flags, never the key', (await boss('ai:admin')).body.providers[0].hasKey === true);
    await sleep(100);
    ac.abort();
    ok('canary: in no RPC reply or SSE frame', wireSeen.length > 0 && !leaks(wireSeen));
    ok('canary: in no file under either DATA_DIR', !leaks(allFiles(DATA_A)) && !leaks(allFiles(DATA_B)));
    ok('canary: in no log line (trace level) or anything this process printed', appLog.length > 0 && !leaks(appLog) && !leaks(printed));
    ok('canary NEGATIVE CONTROL: the grep finds a planted one', leaks(`x ${CANARY} y`) && leaks(Buffer.from(CANARY).toString('base64')));
  } finally {
    for (const a of apps) await a.close();
    await rolePool?.end();
    await podB.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await root.end();
    provider.close();
    for (const d of [DATA_A, DATA_B]) fs.rmSync(d, { recursive: true, force: true });
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
