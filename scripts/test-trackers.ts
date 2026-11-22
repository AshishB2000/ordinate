// Linear and Jira Cloud from the issues board (docs/issues-board/00-design.md): connect (admin only, the token in the encrypted store and
// never in a reply, a log line or a row), one ticket per issue and tracker with the title, a summary and a link back and NO question text, the
// provider's own host only through the SSRF guard with redirects refused, and no call at all until an admin connects and an editor presses Send.
// A STUB provider replaces the transport: no test makes a network call.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-trackers.js

export {}; // module scope — sibling test scripts share top-level names
import { createSecretKey, randomBytes, randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { evalWorld } from './evalHarness';
import { seeds } from './issuesHarness';

const analyze: any = require('../src/ai/analyze'); // any: the stub replaces its exports
const weekly: typeof import('../src/server/issues/weekly') = require('../src/server/issues/weekly');
const transport: typeof import('../src/server/issues/trackers/transport') = require('../src/server/issues/trackers/transport');
const tokens: typeof import('../src/server/issues/trackers/tokens') = require('../src/server/issues/trackers/tokens');
const secrets: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');
const nameMod: typeof import('../src/ai/issueName') = require('../src/ai/issueName');
const ssrf: typeof import('../src/connectors/ssrf') = require('../src/connectors/ssrf');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const LINEAR_TOKEN = 'lin_api_CANARY_TOKEN_5f3a9c2e';
const JIRA_TOKEN = 'jira_api_CANARY_TOKEN_77d1b0aa';
const QUESTION = 'ZZ-Acme-Corp-deal-QUESTIONWORDS';

interface Seen { host: string; path: string; method: string; headers: Record<string, string>; body: string; redirect?: string }

(async () => {
  const S = await evalWorld('trackers');
  if (!S) return;
  const { W } = S;
  const baseDispatch = analyze.dispatch;
  analyze.dispatch = async (system: string, messages: Array<{ text: string }>) => (system === nameMod.NAME_SYSTEM
    ? { rawText: '{"title":"Define the missing name","fix":"Define it as a business term."}' }
    : baseDispatch(system, messages));
  const master = createSecretKey(randomBytes(32));
  tokens.useTrackerSecrets(secrets.createSecretStore(W.pool, master));
  const seen: Seen[] = [];
  let down = false;
  transport.setTransportForTest(async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    seen.push({ host: url.hostname, path: url.pathname, method: String(init.method), headers, body: String(init.body ?? ''), redirect: init.redirect });
    if (down) throw new Error(`connect ECONNREFUSED ${LINEAR_TOKEN}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'api.linear.app') {
      if (headers.authorization !== LINEAR_TOKEN) return json(400, { errors: [{ message: 'Authentication required, not authenticated' }] });
      return String(init.body).includes('issueCreate')
        ? json(200, { data: { issueCreate: { success: true, issue: { identifier: 'DATA-142', url: 'https://linear.app/acme/issue/DATA-142' } } } })
        : json(200, { data: { teams: { nodes: [{ id: 'team-uuid-1', key: 'DATA' }] } } });
    }
    if (url.hostname === 'acme.atlassian.net') {
      if (headers.authorization !== `Basic ${Buffer.from(`pm@acme.test:${JIRA_TOKEN}`).toString('base64')}`) return json(401, { message: 'bad' });
      if (url.pathname === '/rest/api/3/project/DATA') return json(200, { issueTypes: [{ id: '10', name: 'Epic' }, { id: '11', name: 'Task' }, { id: '12', name: 'Sub-task', subtask: true }] });
      if (url.pathname === '/rest/api/3/project/NOPE') return json(404, {});
      if (url.pathname === '/rest/api/3/issue' && init.method === 'POST') return json(201, { id: '1', key: 'DATA-7' });
    }
    return json(404, {});
  });
  try {
    const P = W.P;
    const { seed, define, thumb } = seeds(W);
    for (const who of ['a', 'b', 'c']) await seed(`${who}@acme.test`, [[`${QUESTION} how many active customers ${who}?`, define('active customer')]]);
    void thumb;
    await W.call('boss', 'issues:setEnabled', { projectId: P, enabled: true });
    await W.as('boss', () => weekly.checkOrg(Date.now() + 60_000));
    const listed = async (who = 'ed') => (await W.call(who, 'issues:list', { projectId: P })).body;
    const board = await listed();
    const issue = board.issues[0];
    ok('fixture: an issue of three questions, named, with no tracker connected', board.issues.length === 1 && board.trackers.linear === false && board.trackers.jira === false && issue.title === 'Define the missing name');
    ok('the weekly check made no tracker call', seen.length === 0);
    const send = (who: string, provider: string, id = issue.id) => W.call(who, 'issues:send', { projectId: P, id, provider });
    const before = await send('ed', 'linear');
    ok('Send before an admin connects: refused with a sentence, and no call', before.body?.ok === false && /not connected/i.test(before.body.error) && seen.length === 0);

    // ── only an org admin connects ───────────────────────────────────────────────────────────────────────────────────────────
    const connectLinear = { provider: 'linear', apiToken: LINEAR_TOKEN, teamKey: 'DATA' };
    ok('an editor and a viewer cannot connect, read the status or disconnect', (await Promise.all(['ed', 'east'].flatMap((w) => [W.call(w, 'tracker:connect', connectLinear), W.call(w, 'tracker:status'), W.call(w, 'tracker:disconnect', { provider: 'linear' })]))).every((r) => r.status === 403) && seen.length === 0);
    ok('an admin cannot connect with a bad shape: a short token, a Jira key with a dot, a missing email', (await Promise.all([
      W.call('boss', 'tracker:connect', { ...connectLinear, apiToken: 'x' }),
      W.call('boss', 'tracker:connect', { provider: 'jira', apiToken: JIRA_TOKEN, site: 'acme', email: 'pm@acme.test', projectKey: 'DA.TA' }),
      W.call('boss', 'tracker:connect', { provider: 'jira', apiToken: JIRA_TOKEN, site: 'acme', projectKey: 'DATA' }),
    ])).every((r) => r.status === 400) && seen.length === 0);
    const bad = await W.call('boss', 'tracker:connect', { ...connectLinear, apiToken: 'lin_api_wrong_token' });
    ok('a wrong token is refused with a sentence, saves nothing, and does not echo the token', bad.body?.ok === false && /did not accept/.test(bad.body.error) && !bad.text.includes('wrong_token') && (await W.pool.query('SELECT count(*)::int AS n FROM secrets')).rows[0].n === 0);
    ok('an unknown team key is refused', (await W.call('boss', 'tracker:connect', { ...connectLinear, teamKey: 'NOPE' })).body?.error?.includes('NOPE') === true);
    const okLinear = await W.call('boss', 'tracker:connect', connectLinear);
    ok('an admin connects Linear: one read call, the team found from its key', okLinear.body?.ok === true && seen.at(-1)?.path === '/graphql' && seen.at(-1)?.body.includes('teams') === true, okLinear.text);
    ok('the token went to the secrets store (encrypted), and the settings row holds no token', (await W.pool.query(`SELECT kind, ref FROM secrets WHERE kind = 'tracker.token'`)).rows[0]?.ref === 'linear' && !JSON.stringify((await W.pool.query('SELECT * FROM tracker_integrations')).rows).includes('CANARY') && !JSON.stringify((await W.pool.query('SELECT ciphertext FROM secrets')).rows).includes(LINEAR_TOKEN));
    const status = await W.call('boss', 'tracker:status');
    ok('the status: connected, has a token, the team; never the token', status.body.providers[0].connected === true && status.body.providers[0].hasToken === true && status.body.providers[0].settings.teamKey === 'DATA' && !status.text.includes('CANARY'));

    // Jira
    ok('a site that is not <name>.atlassian.net is refused before any call', (await Promise.all(['evil.example.com', 'acme.atlassian.net.evil.com', 'https://acme.atlassian.net', 'acme.atlassian.net:8443', 'user@acme.atlassian.net', '169.254.169.254', '-x', 'a/b'].map((site) => W.call('boss', 'tracker:connect', { provider: 'jira', apiToken: JIRA_TOKEN, site, email: 'pm@acme.test', projectKey: 'DATA' })))).every((r) => r.body?.ok === false && r.body.error.includes('atlassian.net')) && !seen.some((s) => s.host !== 'api.linear.app'), JSON.stringify(seen.map((x) => x.host)));
    const callsBefore = seen.length;
    ok('a Jira project that does not exist is refused', (await W.call('boss', 'tracker:connect', { provider: 'jira', apiToken: JIRA_TOKEN, site: 'acme', email: 'pm@acme.test', projectKey: 'NOPE' })).body?.ok === false && seen.length === callsBefore + 1);
    const okJira = await W.call('boss', 'tracker:connect', { provider: 'jira', apiToken: JIRA_TOKEN, site: 'ACME.atlassian.net', email: 'pm@acme.test', projectKey: 'DATA' });
    const jset = (await W.pool.query(`SELECT settings FROM tracker_integrations WHERE provider = 'jira'`)).rows[0]?.settings;
    ok('an admin connects Jira Cloud: the project\'s default issue type is Task (not the Epic, not the sub-task)', okJira.body?.ok === true && jset?.issueTypeId === '11' && jset.site === 'acme.atlassian.net', okJira.text);

    // ── Send ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    ok('a viewer cannot send', (await send('east', 'linear')).status === 403 && (await send('nobody', 'jira')).status === 403);
    ok('the editor\'s board shows which trackers are connected (flags only)', (await listed()).trackers.linear === true && (await listed()).trackers.jira === true);
    process.env.ORDINATE_PUBLIC_URL = '';
    const noUrl = await send('ed', 'linear');
    ok('with no public address a ticket cannot link back: refused, no call', noUrl.body?.ok === false && /ORDINATE_PUBLIC_URL/.test(noUrl.body.error));
    process.env.ORDINATE_PUBLIC_URL = 'https://ordinate.acme.test';
    const n0 = seen.length;
    const sent = await send('ed', 'linear');
    const create = seen.at(-1)!;
    ok('Send to Linear: one ticket, with its reference and URL back', sent.body?.ok === true && sent.body.ref === 'DATA-142' && sent.body.url.includes('linear.app') && seen.length === n0 + 1, sent.text);
    const vars = JSON.parse(create.body).variables.input;
    ok('the ticket is the title, a summary and a link back to this issue', vars.title === 'Define the missing name' && vars.teamId === 'team-uuid-1' && vars.description.includes('3 Assistant questions from 3 people') && vars.description.includes('Define it as a business term.') && vars.description.includes(`https://ordinate.acme.test/model/${P}?tab=assistant&issue=${issue.id}`), vars.description);
    ok('Q2: NO question text leaves Ordinate: the ticket holds none of it, nor an email', !create.body.includes(QUESTION) && !/@acme\.test/.test(create.body) && !create.body.toLowerCase().includes('how many active customers'));
    ok('every call: https to the provider\'s own host, redirects refused, the token only in its header', seen.every((s) => ['api.linear.app', 'acme.atlassian.net'].includes(s.host) && s.redirect === 'error') && !seen.some((s) => s.body.includes('CANARY')), JSON.stringify(seen.map((s) => [s.host, s.redirect, s.body.includes('CANARY')])));
    ok('NEGATIVE CONTROL: the same issue sent to the same tracker again makes no second ticket, and no call', (await send('ed', 'linear')).body?.ok === false && seen.length === n0 + 1 && (await W.pool.query('SELECT count(*)::int AS n FROM issue_tickets')).rows[0].n === 1);
    const listed2 = (await listed()).issues[0];
    ok('the board shows the ticket on the issue', listed2.tickets.length === 1 && listed2.tickets[0].ref === 'DATA-142');
    const sentJira = await send('ed', 'jira');
    const jc = seen.at(-1)!;
    const jbody = JSON.parse(jc.body);
    ok('Send to Jira: Basic auth to the site, the project, the default issue type, an ADF description', sentJira.body?.ok === true && sentJira.body.ref === 'DATA-7' && sentJira.body.url === 'https://acme.atlassian.net/browse/DATA-7' && jc.path === '/rest/api/3/issue' && jbody.fields.project.key === 'DATA' && jbody.fields.issuetype.id === '11' && jbody.fields.summary === 'Define the missing name' && jbody.fields.description.type === 'doc', sentJira.text);
    ok('NEGATIVE CONTROL (Q2): the Jira body holds no question text either', !jc.body.includes(QUESTION) && !/@acme\.test/.test(jc.body.replace('https://ordinate.acme.test', '')));

    // a failing tracker frees the slot
    await W.pool.query('DELETE FROM issue_tickets');
    down = true;
    const failed = await send('ed', 'linear');
    ok('a tracker that cannot be reached: a sentence, not its words or the token; the slot is free again', failed.body?.ok === false && /could not be reached/.test(failed.body.error) && !failed.text.includes('CANARY') && !failed.text.includes('ECONNREFUSED') && (await W.pool.query('SELECT count(*)::int AS n FROM issue_tickets')).rows[0].n === 0);
    down = false;
    ok('…and a retry then works', (await send('ed', 'linear')).body?.ok === true);

    // ── the secret canary ────────────────────────────────────────────────────────────────────────────────────────────────────
    const replies = JSON.stringify([status.text, (await W.call('boss', 'tracker:status')).text, (await W.call('ed', 'issues:list', { projectId: P })).text, (await W.call('ed', 'issues:settings', { projectId: P })).text, okLinear.text, okJira.text, bad.text, failed.text]);
    ok('CANARY: neither token is in any reply', !replies.includes('CANARY'), replies.slice(Math.max(0, replies.indexOf('CANARY') - 150), replies.indexOf('CANARY') + 80));
    const dump = JSON.stringify((await Promise.all(['issues', 'issue_signals', 'issue_tickets', 'issue_settings', 'tracker_integrations', 'audit_log'].map((t) => W.pool.query(`SELECT * FROM ${t}`).then((r) => r.rows).catch(() => [])))));
    ok('CANARY: neither token is in any table (the secrets table holds ciphertext only), nor the audit log', !dump.includes('CANARY'), dump.slice(Math.max(0, dump.indexOf('CANARY') - 200), dump.indexOf('CANARY') + 80));
    const aud = JSON.stringify((await W.pool.query(`SELECT * FROM audit_log ORDER BY 1 DESC LIMIT 50`).catch(() => ({ rows: [] }))).rows);
    ok('the audit log recorded the connection without its token (control: the row is there)', aud.includes('tracker:connect') && !aud.includes('CANARY'));
    ok('disconnect removes the settings and the secret', (await W.call('boss', 'tracker:disconnect', { provider: 'linear' })).body?.ok === true && (await W.pool.query(`SELECT count(*)::int AS n FROM secrets WHERE ref = 'linear'`)).rows[0].n === 0 && (await W.call('boss', 'tracker:status')).body.providers[0].connected === false);
    const after = await send('ed', 'linear', issue.id);
    ok('after a disconnect Send is refused again', after.body?.ok === false);
    // no master key: nothing can be saved
    tokens.useTrackerSecrets(null);
    const nokey = await W.call('boss', 'tracker:connect', connectLinear);
    ok('with no master key a token cannot be saved, with a sentence', nokey.body?.ok === false && /ORDINATE_MASTER_KEY/.test(nokey.body.error));

    // ── the SSRF guard ──────────────────────────────────────────────────────────────────────────────────────────────────────
    ok('jiraHost: only <name>.atlassian.net', transport.jiraHost('acme') === 'acme.atlassian.net' && transport.jiraHost(' Acme.Atlassian.net ') === 'acme.atlassian.net' && ['acme.example.com', 'a.b.atlassian.net', '.atlassian.net', 'acme.atlassian.net/x', 'http://acme.atlassian.net', 'ac me', ''].every((s) => transport.jiraHost(s) === null));
    transport.setTransportForTest(async () => { throw new Error('no network in a test'); });
    let refused = 0;
    for (const host of ['evil.example.com', '127.0.0.1', 'acme.atlassian.net.evil.com', 'localhost']) {
      try { await transport.call(host, '/x', { method: 'GET', headers: {} }); } catch (e) { if ((e as { code?: string }).code === 'unreachable') refused += 1; }
    }
    ok('the transport refuses any host that is not the provider\'s own, before the transport is asked', refused === 4);
    const src = ['transport', 'linear', 'jira', 'service'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'issues', 'trackers', `${f}.ts`), 'utf8')).join('\n');
    ok('no tracker file opens a socket by itself: only safeFetch, no fetch( or http(s).request', /safeFetch/.test(src) && !/[^.\w]fetch\(|https?\.request|from 'https?'|from 'node:https?'|axios|undici/.test(src));
    ok('a real safeFetch refuses a private address (the guard is the one in use)', await ssrf.safeFetch('http://127.0.0.1:9/').then(() => false, (e) => e instanceof ssrf.SsrfError));
    ok('safeFetch is the default transport', String(transport.setTransportForTest).length > 0 && fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'issues', 'trackers', 'transport.ts'), 'utf8').includes('safeFetch(url, init)'));
    void randomUUID;
  } finally {
    transport.setTransportForTest(null);
    tokens.useTrackerSecrets(null);
    analyze.dispatch = baseDispatch;
    await S.close();
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
