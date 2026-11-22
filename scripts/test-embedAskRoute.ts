// POST /embed/ask end to end on Postgres (docs/embedded-assistant/00-design.md): the real secrets store, real HTTP, the model
// scripted. Every refusal is ONE bare answer (no probe tells an unknown org, a bad MAC, an expired token, a dashboard token and an
// unmarked agent apart), framable nowhere, no cookie; a valid token is answered from the customer's rows only; one audit row per
// question after the MAC held (customer id, agent, outcome; never the question); the token, the secret and the customer id are in
// no log line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-embedAskRoute.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { createHmac, randomBytes } from 'crypto';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const analyze: any = require('../src/ai/analyze'); // any: the stub replaces its exports
const execConfig: any = require('../src/app/execConfig'); // any: the stub replaces its exports
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const askRoute: typeof import('../src/server/embed/askRoute') = require('../src/server/embed/askRoute');
const rowAccessMod: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const assistants: typeof import('../src/server/embed/assistants') = require('../src/server/embed/assistants');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-embed-ask-'));
const PORTAL = 'https://portal.acme.test';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = (): number => Math.floor(Date.now() / 1000);
function hostSign(secret: string, payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT', kid: 'acme' }): string {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

async function suite(adminUrl: string): Promise<void> {
  const dbName = `ordinate_embedask_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 3 });
  pool.on('error', () => undefined);
  const logLines: string[] = [];
  const logStream = new Writable({ write(chunk, _enc, done) { logLines.push(String(chunk)); done(); } });
  const cfg = envMod.parseEnv({
    LOG_LEVEL: 'info', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  });
  const app = appMod.buildApp(cfg, logStream);
  const real = { ask: analyze.askCopilot, on: execConfig.assistantOn };
  const asked: string[] = [];
  analyze.askCopilot = async (_p: unknown, facts: string, q: string) => {
    asked.push(facts + q);
    return { ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'by city', spec: { datasetId: DS, category: 'city', measures: [{ column: 'qty', aggregation: 'sum' }], filters: [] } } };
  };
  execConfig.assistantOn = () => true;
  let DS = '';
  try {
    const base = await B.listen(app);
    const boss = B.client(base, { 'x-forwarded-email': 'boss@acme.test' }, []);
    const pid: string = (await boss.call('projects:create', { name: 'Portal' })).body.id;
    const BOSS: B.Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const inBoss = <T>(fn: () => Promise<T>) => B.context.runInContext(BOSS, 'setup', fn);
    const rows = [...Array.from({ length: 6 }, (_, i) => ['CV_ONE', `MINE_${i % 2}`, 1 + i]), ...Array.from({ length: 9 }, (_, i) => ['CV_TWO', `OTHERS_${i % 3}`, 100 + i])];
    DS = (await inBoss(() => datasets.saveDataset(pid, { name: 'Shipments', sourceKind: 'csv', columns: [{ name: 'customer_id', type: 'text' }, { name: 'city', type: 'text' }, { name: 'qty', type: 'number' }], rows })))!.id;
    const agent = await inBoss(async () => (await agents.saveAgent(pid, { name: 'Helper', teamIds: [] }))!);
    const SECRET: string = (await boss.call('embed:rotate')).body.secret;
    ok('setup: a secret exists', /^ord_embed_/.test(SECRET));
    const post = async (token: unknown, extra: Record<string, unknown> = { question: 'How many?' }) => {
      const r = await fetch(`${base}/embed/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...extra }) });
      const text = await r.text();
      return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), r };
    };
    const claims = (over: Record<string, unknown> = {}) => ({ agent: agent.id, sub: 'cust-secret-id-9', exp: now() + 600, params: { customer_id: 'CV_ONE' }, ...over });
    const rowsOfAudit = async () => (await pool.query<{ customer: string; outcome: string; agent_id: string | null }>('SELECT customer, outcome, agent_id::text FROM embed_asks ORDER BY at')).rows;

    // Nothing marked, embedding off: the bare refusal; nothing is asked.
    const t0 = hostSign(SECRET, claims());
    const r0 = await post(t0);
    ok('embedding off and nothing marked: one bare 403, nothing asked', r0.status === 403 && r0.json?.ok === false && asked.length === 0, r0.text);
    ok('the refusal is no cookie, no wide CSP', !r0.r.headers.get('set-cookie') && r0.r.headers.get('cache-control') === 'no-store');
    ok('a refused-after-MAC token (embedding off) writes one audit row', (await rowsOfAudit()).length === 1 && (await rowsOfAudit())[0].outcome === 'denied');

    await boss.call('embed:save', { enabled: true, origins: [PORTAL] });
    const noMark = await post(t0);
    ok('embedding on, agent not marked: the same bare answer', noMark.status === 403 && noMark.text === r0.text && asked.length === 0);
    await assistants.setEmbedAgent('acme', 'boss@acme.test', { agentId: agent.id, projectId: pid, datasets: [{ id: DS, column: 'customer_id', writers: (await inBoss(() => rowAccessMod.pinWriters(pid, DS, 'customer_id')))! }] });

    const good = await post(t0, { question: 'How many shipments by city? SECRET_QUESTION_TEXT' });
    ok('a valid token is answered, with the customer\'s own chart', good.status === 200 && good.json?.ok === true && JSON.stringify(good.json.card?.data).includes('MINE_0'), good.text.slice(0, 300));
    ok('…and nothing of the other customer', !good.text.includes('OTHERS_') && !good.text.includes('CV_TWO') && !asked.join().includes('OTHERS_'));
    ok('…the reply carries no spec steps, chips or customer id', !/"steps"|"chips"|cust-secret-id-9/.test(good.text));
    const refusals: Array<[string, string]> = [
      ['an expired token', hostSign(SECRET, claims({ exp: now() - 600 }))],
      ['24 hours ahead (a dashboard length)', hostSign(SECRET, claims({ exp: now() + 86_400 }))],
      ['no lock', hostSign(SECRET, claims({ params: {} }))],
      ['a lock on a column nothing requires', hostSign(SECRET, claims({ params: { customer_id: 'CV_ONE', region: 'x' } }))],
      ['a lock on the wrong column only', hostSign(SECRET, claims({ params: { region: 'x' } }))],
      ['an unknown claim', hostSign(SECRET, claims({ admin: true }))],
      ['a dashboard token', hostSign(SECRET, { pub: agent.id, exp: now() + 600, params: { customer_id: 'CV_ONE' } })],
      ['another agent', hostSign(SECRET, claims({ agent: DS }))],
      ['the wrong secret', hostSign('ord_embed_' + 'z'.repeat(43), claims())],
      ['another org\'s kid', hostSign(SECRET, claims(), { alg: 'HS256', typ: 'JWT', kid: 'globex' })],
      ['alg none', hostSign(SECRET, claims(), { alg: 'none', typ: 'JWT', kid: 'acme' })],
    ];
    const before = asked.length;
    for (const [label, tok] of refusals) {
      const r = await post(tok);
      ok(`refused: ${label} (403, bare)`, r.status === 403 && r.json?.ok === false && !r.text.includes('CV_ONE') && !r.text.includes(DS), `${r.status} ${r.text}`);
    }
    ok('…and none of them reached the model', asked.length === before);
    for (const bad of [undefined, 5, '', 'a.b', 'x'.repeat(9000)]) ok(`a malformed token ${typeof bad}: 403`, (await post(bad)).status === 403);
    const blank = await post(t0, { question: '   ' });
    ok('a blank question: refused with a sentence, not asked', blank.status === 400 && blank.json?.ok === false);
    // Q4: the caps. 2 a minute per customer, then the next is a 429 with Retry-After and a `limited` audit row, charging nothing more.
    await pool.query(`INSERT INTO embed_assistant_limits (org_id, per_minute_cap, daily_cap) VALUES ('acme', 2, 1000)`);
    const tCap = hostSign(SECRET, claims({ sub: 'capped-customer' }));
    const c1 = await post(tCap); const c2 = await post(tCap); const c3 = await post(tCap);
    ok('caps: the first two questions of a customer are answered', c1.status === 200 && c2.status === 200, `${c1.status} ${c2.status}`);
    ok('caps: the third in the minute is a 429 with Retry-After and a sentence, not asked', c3.status === 429 && Number(c3.r.headers.get('retry-after')) >= 1 && c3.json?.ok === false, `${c3.status} ${c3.text}`);
    const askedBefore = asked.length;
    const other = await post(hostSign(SECRET, claims({ sub: 'another-customer' })));
    ok('caps: another customer is not held by the first one\'s cap', other.status === 200 && asked.length === askedBefore + 1);
    ok('caps: the refusal wrote one `limited` audit row for that customer', (await pool.query(`SELECT count(*)::int AS n FROM embed_asks WHERE outcome = 'limited' AND customer = 'capped-customer'`)).rows[0].n === 1);
    await pool.query(`UPDATE embed_assistant_limits SET per_minute_cap = 100, daily_cap = 3`);
    const day = await post(hostSign(SECRET, claims({ sub: 'daily-a' })));
    ok('caps: the org\'s daily cap holds across customers (more than 3 questions were already counted today)', day.status === 429, `${day.status}`);
    await pool.query(`DELETE FROM embed_assistant_limits`);
    await pool.query(`DELETE FROM shared_counters`);
    ok('control: with the caps cleared the next question is answered', (await post(hostSign(SECRET, claims({ sub: 'daily-b' })))).status === 200);

    // The time limit stops waiting for a model that never answers.
    const hang = analyze.askCopilot;
    analyze.askCopilot = () => new Promise(() => undefined);
    askRoute.setAskTimeoutForTest(400);
    const t0ms = Date.now();
    const slow = await post(hostSign(SECRET, claims({ sub: 'slow-customer' })));
    askRoute.setAskTimeoutForTest();
    analyze.askCopilot = hang;
    ok('timeout: a hanging model gets the failure sentence at the limit, not after it', slow.status === 200 && slow.json?.ok === false && /could not answer/.test(slow.json?.error ?? '') && Date.now() - t0ms < 5000, `${slow.status} ${slow.text} ${Date.now() - t0ms}ms`);
    ok('timeout: …and the audit row says error', (await pool.query(`SELECT outcome FROM embed_asks WHERE customer = 'slow-customer'`)).rows[0]?.outcome === 'error');

    // ── the page: GET /embed/ask/<token> (phase 3) ──
    const pageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-ask-page-'));
    fs.writeFileSync(path.join(pageDir, 'embed-ask.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/embed-ask.js"></script></body></html>');
    askRoute.setAskPageDirForTest(pageDir);
    const page = async (tok: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}/embed/ask/${tok}`, { headers: { accept: 'text/html', ...headers }, redirect: 'manual' });
      return { status: r.status, text: await r.text(), csp: r.headers.get('content-security-policy') ?? '', xfo: r.headers.get('x-frame-options'), r };
    };
    const okPage = await page(t0);
    ok('page: a valid token is served the app\'s page', okPage.status === 200 && okPage.text.includes('id="root"'), `${okPage.status} ${okPage.text.slice(0, 120)}`);
    ok('page: framable by the org\'s listed sites only, never by others, script and style from this server only', okPage.csp.includes(`frame-ancestors ${PORTAL}`) && !okPage.csp.includes('*') && okPage.csp.includes("script-src 'self'") && okPage.csp.includes("style-src 'self'") && okPage.csp.includes("connect-src 'self'") && !okPage.csp.includes('unsafe') && okPage.xfo === null, okPage.csp);
    ok('page: no cache, no robots, no referrer (the token is in its URL), no cookie', okPage.r.headers.get('cache-control') === 'no-store' && /noindex/.test(okPage.r.headers.get('x-robots-tag') ?? '') && okPage.r.headers.get('referrer-policy') === 'no-referrer' && !okPage.r.headers.get('set-cookie'));
    const bad = await page(hostSign('ord_embed_' + 'z'.repeat(43), claims()));
    ok('page: a bad signature is the bare refusal, framable by nobody', bad.status === 403 && bad.xfo === 'DENY' && bad.csp.includes("frame-ancestors 'none'") && !bad.text.includes('id="root"'));
    const old = await page(hostSign(SECRET, claims({ exp: now() - 600 })));
    ok('page: an expired token says so, in a frame the org\'s sites may show', old.status === 403 && /expired/i.test(old.text) && old.csp.includes(`frame-ancestors ${PORTAL}`));
    const unmarked = await page(hostSign(SECRET, claims({ agent: DS })));
    ok('page: an agent that is not marked gets a refusal, not the composer', unmarked.status === 403 && !unmarked.text.includes('id="root"'));
    const noLock = await page(hostSign(SECRET, claims({ params: { region: 'x' } })));
    ok('page: a token that does not lock the required column is refused', noLock.status === 403 && !noLock.text.includes('id="root"'));
    const wrongSite = await page(t0, { referer: 'https://evil.example/page' });
    ok('page: a Referer from a site that is not listed is refused', wrongSite.status === 403 && !wrongSite.text.includes('id="root"'));
    ok('page: a Referer from a listed site passes', (await page(t0, { referer: `${PORTAL}/portal` })).status === 200);
    // The page and the POST route agree: a token the page serves is answered by POST, and one the page refuses is refused by POST too.
    const same = hostSign(SECRET, claims({ sub: 'agree-customer' }));
    const pageSame = await page(same);
    const askSame = await post(same);
    ok('control: a token the page serves is answered by POST /embed/ask', pageSame.status === 200 && askSame.status === 200 && askSame.json?.ok === true, `${pageSame.status} ${askSame.status} ${askSame.text.slice(0, 120)}`);
    const refusedTok = hostSign(SECRET, claims({ sub: 'agree-customer', params: { region: 'x' } }));
    ok('…and one the page refuses (no required lock) is refused by POST too', (await page(refusedTok)).status === 403 && (await post(refusedTok)).status === 403);
    fs.rmSync(pageDir, { recursive: true, force: true });
    ok('page: the app not built is a 503 refusal, not a crash', (await page(t0)).status === 503);
    askRoute.setAskPageDirForTest();

    await boss.call('embed:rotate');
    ok('rotating the secret kills every token', (await post(t0)).status === 403);

    const audit = await rowsOfAudit();
    ok('audit: one row per token whose MAC held, customer, agent and outcome only', audit.some((a) => a.outcome === 'ok' && a.customer === 'cust-secret-id-9' && a.agent_id === agent.id) && audit.every((a) => ['ok', 'denied', 'error', 'refused', 'limited'].includes(a.outcome)), JSON.stringify(audit));
    const dump = JSON.stringify((await pool.query('SELECT * FROM embed_asks')).rows);
    ok('audit: no question, no answer, no value in it', !dump.includes('SECRET_QUESTION_TEXT') && !dump.includes('MINE_') && !dump.includes('CV_ONE'));
    const threads = await pool.query(`SELECT count(*)::int AS n FROM records WHERE kind LIKE '%thread%' OR path LIKE '%threads%'`).catch(() => ({ rows: [{ n: 0 }] }));
    ok('nothing saved: no assistant conversation rows', threads.rows[0].n === 0 && (await pool.query(`SELECT count(*)::int AS n FROM assistant_threads`).then((r) => r.rows[0].n, () => 0)) === 0);
    const logs = logLines.join('');
    ok('canary: the token, the secret and the customer id are in no log line', !logs.includes(t0) && !logs.includes(SECRET) && !logs.includes('cust-secret-id-9') && !logs.includes(t0.split('.')[2]));
    ok('canary: the question is in no log line', !logs.includes('SECRET_QUESTION_TEXT'));
    const ok2 = await fetch(`${base}/embed/ask/${t0}`, { headers: { accept: 'text/html' } });
    await ok2.text();
    ok('a token in a URL is masked in the request log', !logLines.join('').includes(t0));
  } finally {
    analyze.askCopilot = real.ask;
    execConfig.assistantOn = real.on;
    await app.close();
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('skip embed ask DB suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return finish();
  }
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  try {
    await suite(url);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
