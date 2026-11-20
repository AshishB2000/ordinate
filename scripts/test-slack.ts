// Ordinate in Slack, phase 1 (docs/slack/00-design.md, "Tests"): install, the Events route, linking, the ask after
// authorize(), the share policy, escaping, crash retake and the secrets canaries — against a LOCAL STUB of Slack
// (scripts/slackStub.ts), never the real one, over a scratch Postgres (skips without DATABASE_URL).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-slack.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { APP_TOKEN, SIGNING, slackWorld, sleep, until } from './slackHarness';

const store: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const askMod: typeof import('../src/server/slack/ask') = require('../src/server/slack/ask');
const workerMod: typeof import('../src/server/slack/worker') = require('../src/server/slack/worker');
const say: typeof import('../src/server/slackMessages') = require('../src/server/slackMessages');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const sharePolicy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');

(async () => {
  const S = await slackWorld('slack');
  if (!S) return;
  const { W, stub } = S;
  const BOT = stub.team.botToken;
  try {
    // ── install ───────────────────────────────────────────────────────────────
    const status = await W.call('boss', 'slack:status');
    ok('Admin: the install is saved, with has-key flags only',
      status.body.ok && status.body.install.teamId === stub.team.id && status.body.install.hasBotToken && status.body.install.hasSigningSecret && status.body.install.hasClientSecret && status.body.install.hasAppToken, status.text);
    ok('Admin: the manifest carries this server\'s address, the scopes and the events',
      /ordinate\.test\/api\/slack\/events/.test(status.body.manifest.events) && /app_mentions:read/.test(status.body.manifest.events) && !/users:read\.email/.test(status.body.manifest.events));
    ok('Admin: a viewer (and an editor) may not read or change the install',
      (await W.call('east', 'slack:status')).status === 403 && (await W.call('ed', 'slack:install', { botToken: BOT, mode: 'events' })).status === 403);
    const bad = await W.call('boss', 'slack:install', { botToken: 'xoxb-not-the-right-token-1', signingSecret: 'x', mode: 'events' });
    ok('Admin: Slack refusing the bot token is said in fixed words, with no token in them', bad.body.ok === false && !bad.text.includes('xoxb-not'), bad.text);

    // ── signature ─────────────────────────────────────────────────────────────
    const q0 = (await S.questions()).length;
    const dmEv = (id: string) => S.dm('boss', 'how many orders?', { id });
    await S.link('boss');
    const goodSig = await stub.send(`http://127.0.0.1:${(W.app.server.address() as import('net').AddressInfo).port}`, '/api/slack/events', { type: 'url_verification', challenge: 'abc123' });
    const base = `http://127.0.0.1:${(W.app.server.address() as import('net').AddressInfo).port}`;
    ok('Signature: a good signature passes (url_verification is answered)', goodSig.status === 200 && (await goodSig.json()).challenge === 'abc123');
    ok('Signature: a changed body fails', (await stub.send(base, '/api/slack/events', dmEv('EvT1'), { tamper: true })).status === 401);
    ok('Signature: an old timestamp fails', (await stub.send(base, '/api/slack/events', dmEv('EvT2'), { ts: Math.floor(Date.now() / 1000) - 3600 })).status === 401);
    ok('Signature: a wrong secret fails', (await stub.send(base, '/api/slack/events', dmEv('EvT3'), { secret: 'not-the-secret' })).status === 401);
    ok('Signature: url_verification with a wrong secret fails', (await stub.send(base, '/api/slack/events', { type: 'url_verification', challenge: 'x' }, { secret: 'nope' })).status === 401);
    ok('Signature: nothing from a refused call became a question', (await S.questions()).length === q0);

    // ── a direct message, linked ──────────────────────────────────────────────
    S.answer = { text: 'There were 42 orders <!channel> & <@U_BOSS> see <http://evil.test|here>.', datasets: [W.plain] };
    const row = await S.deliver(S.dm('boss', 'how many orders?', { id: 'EvDM1' }));
    ok('DM: the question was answered', row?.status === 'done' && /^posted:direct$|^posted:/.test(row.outcome), JSON.stringify(row));
    ok('DM: the ask ran as the linked user, through the handler, with no askId and no via', S.asked.length === 1 && S.asked[0].email === 'boss@acme.test' && !('askId' in S.asked[0].payload) && S.asked[0].payload.projectId === W.P, JSON.stringify(S.asked));
    const final = S.updated().at(-1);
    ok('DM: the placeholder was edited into the answer', !!final && /42 orders/.test(final.text));
    const blocks = JSON.stringify(final?.blocks ?? []);
    ok('Pings: <!channel>, <@U…> and a hidden link arrive escaped', !/<!channel>|<@U_BOSS>|<http:/.test(blocks) && /&lt;!channel&gt;/.test(blocks), blocks.slice(0, 400));
    ok('DM: the footer names the datasets and the asker\'s access', /Plain/.test(blocks) && /asker's access/.test(blocks));
    ok('DM: Open in Ordinate points at this server, never a request header', /http:\/\/ordinate\.test\/assistant\?slack=/.test(blocks));
    // Retries: the same event id twice → one question, one answer.
    const askedBefore = S.asked.length;
    const again = await stub.send(base, '/api/slack/events', S.dm('boss', 'how many orders?', { id: 'EvDM1' }));
    await sleep(600);
    ok('Retries: the same event_id again is acknowledged and nothing more runs', again.status === 200 && S.asked.length === askedBefore && (await S.questions()).length === 1);
    ok('Ignored: a bot\'s post, an edit, Ordinate\'s own message and an unknown team make no question', await (async () => {
      const ev = S.dm('boss', 'x');
      for (const patch of [{ bot_id: 'B1' }, { subtype: 'message_changed' }, { user: stub.team.botUser }]) {
        await stub.send(base, '/api/slack/events', { ...(ev as object), event_id: `Ev${Math.random()}`, event: { ...(ev as { event: object }).event, ...patch } });
      }
      await stub.send(base, '/api/slack/events', { ...(ev as object), team_id: 'T_OTHER', event_id: 'EvOther' });
      await sleep(400);
      return (await S.questions()).length === 1;
    })());

    // ── authorization: the handler is never called for a user with no read ────
    await W.call('zed', 'projects:list'); // provisioned, granted nothing
    await store.saveLink('acme', stub.team.id, 'U_ZED', 'zed@acme.test');
    stub.users.set('U_ZED', { id: 'U_ZED', team_id: stub.team.id });
    const zedEv = (id: string) => ({ type: 'event_callback', team_id: stub.team.id, event_id: id, event: { type: 'message', channel_type: 'im', user: 'U_ZED', text: 'orders?', channel: 'DU_ZED', ts: '1800000001.000200' } });
    const seen = S.asked.length;
    const zrow = await S.deliver(zedEv('EvZ1'));
    ok('Authorization: a linked user with no project gets a fixed sentence and the handler is not called', zrow?.status === 'done' && S.asked.length === seen && S.updated().at(-1)?.text === say.noProject(), S.updated().at(-1)?.text);
    const pool = appMod.appPool();
    const zed = { user: { email: 'zed@acme.test', role: 'viewer' as const }, org: { id: 'acme' } };
    const denied = await context.runInContext(zed, 'zed', () => askMod.ask(pool as never, zed, 'zed', 'orders?', { projectId: W.P, agentId: null }));
    ok('Authorization: asking a project they cannot read is `denied` and the handler is not called', !denied.ok && denied.reason === 'denied' && S.asked.length === seen, JSON.stringify(denied));
    // The negative control: the handler itself applies no authorization (the RPC layer does), so the guard above is the only thing standing.
    await context.runInContext(zed, 'zed2', async () => { await (rpc.handlers.get('copilot:ask') as (e: unknown, p: unknown) => Promise<unknown>)({}, { projectId: W.P, context: { kind: '' }, question: 'direct' }); });
    ok('Authorization (negative control): called directly, the handler runs for zed — so authorize() in ask.ts is what refuses', S.asked.length === seen + 1);
    S.asked.length = 0;

    // ── outsiders ─────────────────────────────────────────────────────────────
    stub.users.set('U_OUT', { id: 'U_OUT', team_id: 'T_OTHER', is_stranger: true });
    const out = await S.deliver({ type: 'event_callback', team_id: stub.team.id, event_id: 'EvOut', event: { type: 'message', channel_type: 'im', user: 'U_OUT', text: 'figures?', channel: 'DU_OUT', ts: '1800000002.000200' } });
    ok('Outsiders: a stranger is never answered and never offered a Connect button', out?.status === 'failed' && out.outcome === 'not_linkable' && S.asked.length === 0
      && !JSON.stringify(stub.callsOf('chat.postEphemeral').at(-1)?.params).includes('/api/slack/connect'), JSON.stringify(out));

    // ── linking ───────────────────────────────────────────────────────────────
    const connectTokenOf = (): string => {
      const p = stub.callsOf('chat.postEphemeral').at(-1)?.params as { blocks: Array<{ elements?: Array<{ url?: string }> }> };
      return new URL(p.blocks[1].elements?.[0].url as string).searchParams.get('s') as string;
    };
    const asWest = (url: string) => W.app.inject({ method: 'GET', url, headers: { 'x-forwarded-email': 'west@acme.test' }, remoteAddress: '127.0.0.1' });
    const follow = async (loc: string) => (await fetch(loc, { redirect: 'manual' })).headers.get('location') as string;
    const wrow = await S.deliver(S.dm('west', 'orders for the west?', { id: 'EvW1' }));
    const tok = connectTokenOf();
    ok('Linking: an unknown Slack user gets a private Connect button and the question waits', wrow?.status === 'awaiting_link' && tok.length >= 40, JSON.stringify(wrow));
    ok('Linking: the Connect button is ephemeral and carries no question text', !JSON.stringify(stub.callsOf('chat.postEphemeral').at(-1)?.params).includes('west?'));
    const callbackNoState = await W.app.inject({ method: 'GET', url: '/api/slack/connect/callback?code=zzz&state=nope' });
    ok('Linking: a callback with no state row is refused', /slack=state/.test(String(callbackNoState.headers.location)), String(callbackNoState.headers.location));
    // Wrong Slack account: the state is for U_WEST, Slack signs in U_EAST.
    const r1 = await asWest(`/api/slack/connect?s=${tok}`);
    ok('Linking: /api/slack/connect (signed in) goes to Slack\'s authorize endpoint with scope openid, a state and a nonce',
      r1.statusCode === 302 && String(r1.headers.location).startsWith(stub.origin + '/openid/connect/authorize'));
    stub.oauth.signInAs = { userId: 'U_EAST', teamId: stub.team.id };
    const back1 = new URL(await follow(String(r1.headers.location)));
    ok('Linking: authorize was asked for openid with state, nonce and the app\'s redirect', stub.lastAuthorize?.get('scope') === 'openid' && !!stub.lastAuthorize.get('nonce') && stub.lastAuthorize.get('state') === tok && stub.lastAuthorize.get('redirect_uri') === 'http://ordinate.test/api/slack/connect/callback');
    const mismatch = await W.app.inject({ method: 'GET', url: back1.pathname + back1.search });
    ok('Linking: an id_token for a different Slack user than the state\'s is refused ("another Slack account")', /slack=mismatch/.test(String(mismatch.headers.location)) && !(await store.linkedEmail('acme', stub.team.id, 'U_WEST')));
    const replay = await W.app.inject({ method: 'GET', url: back1.pathname + back1.search });
    ok('Linking: a used state is refused', /slack=state/.test(String(replay.headers.location)));
    // A state is bound to ONE person: a second signed-in user cannot take it over (they could keep the authorize URL and its nonce).
    await S.deliver(S.dm('west', 'bind test', { id: 'EvWB' }));
    const tokBind = connectTokenOf();
    const bound = await asWest(`/api/slack/connect?s=${tokBind}`);
    const second = await W.app.inject({ method: 'GET', url: `/api/slack/connect?s=${tokBind}`, headers: { 'x-forwarded-email': 'east@acme.test' }, remoteAddress: '127.0.0.1' });
    ok('Linking: a state bound to one person cannot be rebound to another (negative control: the first binding went to Slack)',
      String(bound.headers.location).startsWith(stub.origin) && /slack=state/.test(String(second.headers.location)), `${bound.headers.location} | ${second.headers.location}`);
    const again2 = await asWest(`/api/slack/connect?s=${tokBind}`);
    ok('Linking: the same person may open their own Connect button again', String(again2.headers.location).startsWith(stub.origin));
    // Expired.
    await S.deliver(S.dm('west', 'second try', { id: 'EvW2' }));
    const tokExp = connectTokenOf();
    await W.pool.query(`UPDATE slack_link_states SET expires_at = now() - interval '1 minute' WHERE token = $1`, [tokExp]);
    ok('Linking: an expired state is refused at Connect', /slack=state/.test(String((await asWest(`/api/slack/connect?s=${tokExp}`)).headers.location)));
    // The real thing, from a cross-site form_post with no session cookie.
    await S.deliver(S.dm('west', 'third try', { id: 'EvW3' }));
    const tok3 = connectTokenOf();
    stub.oauth.signInAs = { userId: 'U_WEST', teamId: stub.team.id };
    const ok3 = await asWest(`/api/slack/connect?s=${tok3}`);
    const back3 = new URL(await follow(String(ok3.headers.location)));
    S.asked.length = 0;
    const post = await W.app.inject({
      method: 'POST', url: back3.pathname,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://slack.com', 'sec-fetch-site': 'cross-site' },
      payload: `code=${back3.searchParams.get('code')}&state=${back3.searchParams.get('state')}`,
    });
    ok('Linking: the form_post callback works with no session cookie and from another origin (CSRF-exempt)', /slack=linked/.test(String(post.headers.location)), `${post.statusCode} ${post.headers.location}`);
    ok('Linking: the link stored is who signed in at /connect', (await store.linkedEmail('acme', stub.team.id, 'U_WEST')) === 'west@acme.test');
    ok('Linking: the parked question was answered after linking, as west', await until(async () => S.asked.some((a) => a.email === 'west@acme.test')));
    const noCsrfOther = await W.app.inject({ method: 'POST', url: '/api/rpc/slack:myLink', headers: { origin: 'https://evil.test', 'x-forwarded-email': 'west@acme.test', 'content-type': 'application/json' }, payload: '{"args":[]}' });
    ok('Linking (negative control): the CSRF exemption is only the callback — an RPC from another origin is still refused', noCsrfOther.statusCode === 403, String(noCsrfOther.statusCode));
    const mine = await W.call('west', 'slack:myLink');
    ok('Profile: myLink shows the person\'s own link; unlink removes it', mine.body.links.length === 1 && (await W.call('west', 'slack:unlink')).body.removed === 1 && (await W.call('west', 'slack:myLink')).body.links.length === 0);

    // ── share policy ──────────────────────────────────────────────────────────
    await S.link('boss');
    await W.call('boss', 'privacy:decide', { projectId: W.P, datasetId: W.plain, column: 'customer', level: 'personal' });
    const sqlCard = { ok: true, kind: 'sql', title: 'Customers', columns: [{ name: 'customer', type: 'text' }, { name: 'sales', type: 'number' }], rows: [['c1', 5], ['c2', 9]], rowCount: 2, truncated: false, caption: '', bullets: [], datasets: ['Plain'], sql: 'SELECT 1' };
    S.answer = { text: 'Customer c1 bought 5.', datasets: [W.plain], card: sqlCard };
    await S.deliver(S.dm('boss', 'customers?', { id: 'EvSP1' }));
    const masked = JSON.stringify(S.updated().at(-1));
    ok('Share policy: a masked personal column never reaches Slack unmasked', !/"c1"|"c2"|c1 bought/.test(masked) && /"sales"/.test(masked), masked.slice(0, 500));
    ok('Share policy: the model\'s sentence is replaced by the fixed caption when anything was masked', masked.includes('hidden by the project') && !masked.includes('bought'));
    ok('Share policy: the card carries no SQL text', !masked.includes('SELECT'));
    await W.call('boss', 'privacy:setPolicy', { projectId: W.P, policy: { slack: 'include' } });
    await S.deliver(S.dm('boss', 'customers again?', { id: 'EvSP2' }));
    ok('Share policy (negative control): with `include` the same card goes through unmasked', /"c1"/.test(JSON.stringify(S.updated().at(-1))));
    await W.call('boss', 'privacy:setPolicy', { projectId: W.P, policy: { slack: 'mask' } });
    // An alias must not hide a marked column: `customer AS c` is not named in the result, but the statement names it.
    const aliased = { ...sqlCard, columns: [{ name: 'c', type: 'text' }, { name: 'sales', type: 'number' }], sql: 'SELECT customer AS c, sales FROM Plain' };
    S.answer = { text: 'Customer c1 bought 5.', datasets: [W.plain], card: aliased };
    await S.deliver(S.dm('boss', 'customers aliased?', { id: 'EvSP3' }));
    const al = JSON.stringify(S.updated().at(-1));
    ok('Share policy: a marked column renamed by the SQL (customer AS c) is withheld, not posted under its alias', !/"c1"|"c2"|bought/.test(al) && al.includes('hidden by the project'), al.slice(0, 400));
    await W.call('boss', 'privacy:setPolicy', { projectId: W.P, policy: { slack: 'include' } });
    await S.deliver(S.dm('boss', 'customers aliased again?', { id: 'EvSP4' }));
    ok('Share policy (negative control): with `include` the aliased table is posted', /"c1"/.test(JSON.stringify(S.updated().at(-1))));
    await W.call('boss', 'privacy:setPolicy', { projectId: W.P, policy: { slack: 'mask' } });
    ok('Share policy: `slack` is a share path, default mask', sharePolicy.SHARE_PATHS.includes('slack') && sharePolicy.DEFAULT_POLICY.slack === 'mask');

    // ── charts (phase 4): a chart that fits is a Slack chart block; a masked one never is ─────────────────
    const chartCard = (category: string, labels: string[]) => ({
      ok: true, title: 'Sales', chartType: 'column', caption: '', headline: [], bullets: [],
      spec: { datasetId: W.plain, category, measures: [{ column: 'sales', aggregation: 'sum' }] }, data: { labels, series: [{ name: 'Sum of sales', values: [5, 9] }] },
    });
    S.answer = { text: 'Sales by region.', datasets: [W.plain], card: chartCard('region', ['East', 'West']) };
    await S.deliver(S.dm('boss', 'sales by region?', { id: 'EvCh1' }));
    ok('Charts: an answer whose chart fits is posted as a data_visualization block, with the sentence', /"data_visualization"/.test(JSON.stringify(S.updated().at(-1))) && /Sales by region/.test(JSON.stringify(S.updated().at(-1))));
    S.answer = { text: 'Sales by customer c1.', datasets: [W.plain], card: chartCard('customer', ['c1', 'c2']) };
    await S.deliver(S.dm('boss', 'sales by customer?', { id: 'EvCh2' }));
    const maskedChart = JSON.stringify(S.updated().at(-1));
    ok('Charts: labels from a masked personal column are tokens, never the values, and the sentence is the fixed caption', !/"c1"|"c2"|by customer c1/.test(maskedChart) && maskedChart.includes('hidden by the project'), maskedChart.slice(0, 400));

    // ── crash: a lapsed lease is retaken and the thread gets ONE answer ───────
    workerMod.pauseForTest(true);
    S.answer = { text: 'Crash test answer 77.', datasets: [W.plain] };
    const crashEv = S.dm('boss', 'crash?', { id: 'EvCr1' });
    await stub.send(base, '/api/slack/events', crashEv);
    const first = await until(async () => (await S.questions()).some((q) => q.status === 'pending'), 3000);
    const claimed = await store.claim('pod-that-dies/1', 400); // a pod claims, posts its placeholder, then dies
    ok('Crash: a pending question is claimed under a lease', first && !!claimed && claimed.attempts === 1);
    const postsBefore = S.posted().length;
    await store.setPlaceholder(claimed!.id, 'pod-that-dies/1', '1700099999.000100', null, null);
    ok('Crash: while the lease holds, nobody else claims it', (await store.claim('pod-b/1', 400)) === null);
    await sleep(600);
    workerMod.pauseForTest(false);
    ok('Crash: after the lease lapses another pod retakes it and answers once', await until(async () => (await S.questions()).find((q) => q.id === claimed!.id)?.status === 'done'));
    const crashUpdates = S.updated().filter((u) => /Crash test answer 77/.test(u.text));
    ok('Crash: the thread got one answer, edited into the placeholder the first pod kept', crashUpdates.length === 1 && crashUpdates[0].ts === '1700099999.000100' && S.posted().length === postsBefore, JSON.stringify({ n: crashUpdates.length, posted: S.posted().length - postsBefore }));

    // ── secrets canaries ──────────────────────────────────────────────────────
    const canaries = [BOT, SIGNING, stub.oauth.clientSecret, APP_TOKEN];
    const replies = [
      JSON.stringify((await W.call('boss', 'slack:status')).body), JSON.stringify((await W.call('boss', 'slack:links')).body),
      JSON.stringify((await W.call('boss', 'slack:settings', { allowGuests: false })).body), JSON.stringify((await W.call('boss', 'slack:channels', { projectId: W.P })).body),
    ];
    ok('Secrets: no key (bot token, signing, client secret, app token) is in any reply', canaries.every((c) => replies.every((r) => !r.includes(c))));
    ok('Secrets: no key is in any outbound body (the bot token rides the Authorization header only)', canaries.every((c) => stub.calls.every((k) => !JSON.stringify(k.params).includes(c))));
    ok('Secrets: the bot token is sent as a bearer header, never in a URL or body', stub.calls.filter((k) => k.method.startsWith('chat.')).every((k) => k.token === BOT));
    const logged: string[] = [];
    const pino = require('pino');
    const log = pino({ redact: { paths: [...appMod.REDACT_PATHS], censor: '[redacted]' } }, { write: (l: string) => logged.push(l) });
    log.info({ botToken: BOT, signingSecret: SIGNING, clientSecret: stub.oauth.clientSecret, appToken: APP_TOKEN, req: { headers: { 'x-slack-signature': 'v0=abc' } }, nested: { slack: { botToken: BOT } } }, 'x');
    ok('Secrets: the logger redacts every Slack key and the request signature', canaries.every((c) => !logged.join('').includes(c)) && !logged.join('').includes('v0=abc'), logged.join('').slice(0, 300));
    const stored = JSON.stringify((await W.pool.query(`SELECT * FROM slack_installs`)).rows) + JSON.stringify((await W.pool.query(`SELECT * FROM slack_questions`)).rows) + JSON.stringify((await W.pool.query(`SELECT * FROM slack_link_states`)).rows);
    ok('Secrets: none is in a Slack table (they are in the encrypted store)', canaries.every((c) => !stored.includes(c)));
    const sec = JSON.stringify((await W.pool.query(`SELECT kind FROM secrets WHERE kind LIKE 'slack.%'`)).rows);
    ok('Secrets: all four kinds are stored', ['botToken', 'signingSecret', 'clientSecret', 'appToken'].every((k) => sec.includes(`slack.${k}`)), sec);

    // ── uninstall ─────────────────────────────────────────────────────────────
    ok('Admin: uninstall removes the install, links and keys', (await W.call('boss', 'slack:uninstall')).body.ok === true && !(await store.installByOrg('acme')) && !(await store.getSecret('acme', 'botToken')));
    ok('Events after uninstall: acknowledged and dropped', (await stub.send(base, '/api/slack/events', S.dm('boss', 'hi', { id: 'EvAfter' }))).status === 200 && (await S.questions()).every((q) => q.text !== 'hi'));
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
