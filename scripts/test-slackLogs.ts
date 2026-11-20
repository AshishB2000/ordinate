// Ordinate in Slack: the app's REAL log stream, captured through a whole life — install (the four keys in a request),
// an event, the Connect flow (its token in a URL and the OIDC code in the callback), an answer, a Share press and a
// failing Slack call — holds none of the four secrets, no Connect token and no OIDC code. A second app is built on the
// same database with its own log stream (`buildApp` takes one); the harness's first app stays silent.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-slackLogs.js

export {}; // module scope — sibling test scripts share top-level names
import { Writable } from 'stream';
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { APP_TOKEN, SIGNING, slackWorld, sleep, until } from './slackHarness';

const store: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const sig: typeof import('../src/server/slack/signature') = require('../src/server/slack/signature');

(async () => {
  const S = await slackWorld('slack logs');
  if (!S) return;
  const { W, stub } = S;
  const TEAM = stub.team.id;
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } });
  const connectUrlOf = (): string => String((stub.callsOf('chat.postEphemeral').slice(-1)[0] ?? { params: { blocks: [0, { elements: [{ url: '' }] }] } }).params.blocks[1].elements[0].url);
  const dbUrl = (W.pool as unknown as { options: { connectionString: string } }).options.connectionString;
  let app2: import('fastify').FastifyInstance | null = null;
  try {
    app2 = appMod.buildApp(envMod.parseEnv({
      LOG_LEVEL: 'trace', DATA_DIR: process.env.TMPDIR ?? '/tmp', DATABASE_URL: dbUrl, AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test', RATE_LIMIT_RPC_PER_MINUTE: '100000', RATE_LIMIT_RPC_IP_PER_MINUTE: '100000',
    }), stream);
    await app2.ready();
    store.useSlackDb(W.pool, S.secrets); // the second app wired its own (no master key): put the first's back
    const inject = (o: Record<string, unknown>) => (app2 as import('fastify').FastifyInstance).inject({ remoteAddress: '127.0.0.1', ...o } as never);
    const call = (who: string, channel: string, payload?: unknown) => inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`, headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': `${who}@acme.test` }),
      payload: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const send = (path: string, payload: unknown, form = false) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const raw = form ? `payload=${encodeURIComponent(JSON.stringify(payload))}` : JSON.stringify(payload);
      return inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig.sign(SIGNING, ts, raw) } });
    };

    // install: the four keys travel in a request body
    const installed = await call('boss', 'slack:install', { botToken: stub.team.botToken, signingSecret: SIGNING, clientId: stub.oauth.clientId, clientSecret: stub.oauth.clientSecret, appToken: APP_TOKEN, mode: 'events' });
    ok('install: accepted through the second app', installed.statusCode === 200 && JSON.parse(installed.body).ok !== false, installed.body.slice(0, 120));
    // an unknown person's question: a Connect button, then the whole link flow
    stub.users.set('U_LOG', { id: 'U_LOG', team_id: TEAM });
    const ev = (id: string, user: string, text: string) => ({ type: 'event_callback', team_id: TEAM, event_id: id, event: { type: 'message', channel_type: 'im', user, text, channel: `D${user}`, ts: `18009${Math.floor(Math.random() * 1e4)}.000200` } });
    await send('/api/slack/events', ev('EvLog1', 'U_LOG', 'hello'));
    ok('flow: the Connect button was sent', await until(async () => stub.callsOf('chat.postEphemeral').length > 0, 15_000));
    const url = connectUrlOf();
    const token = new URL(url).searchParams.get('s') as string;
    await call('boss', 'projects:list');
    stub.oauth.signInAs = { userId: 'U_LOG', teamId: TEAM };
    const go = await inject({ method: 'GET', url: `/api/slack/connect?s=${token}`, headers: { 'x-forwarded-email': 'boss@acme.test' } });
    const back = new URL((await fetch(String(go.headers.location), { redirect: 'manual' })).headers.get('location') as string);
    const code = back.searchParams.get('code') as string;
    const done = await inject({ method: 'GET', url: back.pathname + back.search });
    ok('flow: the callback linked the person', /slack=linked/.test(String(done.headers.location)));
    // a question answered, a failing Slack call, a share press
    S.answer = { text: 'There were 42 orders.', datasets: [W.orders] };
    stub.fail = { method: 'chat.update', times: 2 };
    await send('/api/slack/events', ev('EvLog2', 'U_LOG', 'orders?'));
    await sleep(3000);
    await send('/api/slack/interactions', { type: 'block_actions', team: { id: TEAM }, user: { id: 'U_LOG' }, actions: [{ action_id: 'ord_share', value: '11111111-1111-4111-8111-111111111111:share' }] }, true);
    await send('/api/slack/events', { ...ev('EvLog3', 'U_LOG', 'x'), team_id: 'T_NOPE' });
    await sleep(500);

    const log = lines.join('');
    ok('the captured log is the real one: it holds the requests of the flow', lines.length > 10 && log.includes('/api/slack/events') && log.includes('/api/slack/connect'), `${lines.length} lines`);
    const secrets: Array<[string, string]> = [['bot token', stub.team.botToken], ['signing secret', SIGNING], ['client secret', stub.oauth.clientSecret], ['app token', APP_TOKEN], ['Connect token', token], ['OIDC code', code]];
    for (const [name, value] of secrets) ok(`log: the ${name} appears nowhere in the app's log`, !log.includes(value));
    ok('log: no Slack request signature appears either', !/v0=[0-9a-f]{64}/.test(log));
  } finally {
    await app2?.close().catch(() => undefined);
    store.useSlackDb(W.pool, S.secrets);
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
