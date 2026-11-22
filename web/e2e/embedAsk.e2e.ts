// The embedded Assistant end to end (docs/embedded-assistant): on Postgres with the secrets store and a provider stub. An org admin sets up
// embedding, then marks an agent embeddable in Admin → Embedding → Assistant (the lock column `region`) and sets the caps. A HOST page on
// another local origin frames /embed/ask/<token> signed the way the Admin snippet signs it: the composer takes a question, the model
// (scripted) asks for a chart, and the server draws it from THIS customer's rows only. A second customer in another region gets their own
// states and none of the first's; a third question inside the minute is held back by the cap; a page from an origin that is not on the list
// gets a frame the browser refuses. Zero CSP violations (any console error fails the spec).
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import type { Frame, Page } from 'playwright';

const ADMIN = 'admin@acme.test';
const adminUrl = process.env.DATABASE_URL;
const QUESTION = 'How is revenue split by state?';

/** An Anthropic Messages look-alike on loopback: models, a connectivity test, and a streamed ask that answers the QUESTION with a chart spec. */
function provider(): Promise<{ url: string; asked: string[]; close: () => Promise<void> }> {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-stub', display_name: 'Claude Sonnet Stub', created_at: 1 }] }));
      }
      const json = JSON.parse(body || '{}') as { stream?: boolean; messages?: { content: unknown }[] };
      const last = JSON.stringify(json.messages?.at(-1)?.content ?? '');
      // The embedded ask sends no delta handler, so the app asks WITHOUT streaming; a connectivity test is the other non-stream call.
      const asking = last.includes(QUESTION);
      if (asking) asked.push(last);
      const action = { kind: 'answer', intent: QUESTION, spec: { dataset: 'Retail orders', category: 'state', measures: [{ column: 'revenue', aggregation: 'sum' }], filters: [] } };
      const text = asking ? `Here is revenue by state.\n@@ACTION ${JSON.stringify(action)}` : 'OK';
      if (!json.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
      res.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

/** A host app's page: its own chrome and the Assistant in an iframe. No CSP of its own. */
function portal(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const src = new URL(req.url ?? '/', 'http://x').searchParams.get('src') ?? '';
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Shipco customer portal</title><style>
      body{margin:0;font:14px/1.5 system-ui,sans-serif;background:#f4f5f7;color:#1d2230}
      header{display:flex;align-items:center;gap:12px;padding:14px 24px;background:#fff;border-bottom:1px solid #e3e6eb}
      main{padding:24px}.card{background:#fff;border:1px solid #e3e6eb;border-radius:14px;overflow:hidden}
      .card h2{margin:0;padding:14px 18px;font-size:15px;border-bottom:1px solid #e3e6eb} iframe{display:block;width:100%;height:760px;border:0}
    </style></head><body><header><strong>Shipco</strong><span style="opacity:.6">Your shipments</span></header>
    <main><section class="card"><h2>Ask about your shipments</h2><iframe title="Ask about your shipments" src="${esc(src)}"></iframe></section></main></body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

/** The Admin snippet's signer: header.payload, HMAC-SHA256 with the secret string. */
function sign(secret: string, org: string, claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT', kid: org });
  const body = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 });
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

async function assistantFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector('iframe');
  const frame = await handle.contentFrame();
  assert.ok(frame, 'the iframe has a frame');
  await frame.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  return frame;
}

if (!adminUrl) {
  void test('embedded assistant e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_embedask_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, screens, settled, configureServer, launchBrowser, SCREENS } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN,
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'), SSRF_ALLOW: '127.0.0.1/32', // the provider stub is on loopback
    },
    headers: { 'x-forwarded-email': ADMIN },
  });
  const model = await provider();
  const allowed = await portal();
  const stranger = await portal();
  after(async () => {
    await model.close();
    await allowed.close();
    await stranger.close();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('embedded assistant: Admin marks an agent → a host page frames it → each customer asks and sees only their own rows; the cap holds; another origin is refused', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const call = async (channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
      assert.equal(r.status(), 200, `${channel}: ${r.status()} ${await r.text()}`);
      return r.json();
    };
    const { projectId: pid } = await call('sample:seed');
    assert.equal((await call('ai:connect', { provider: 'anthropic', apiKey: 'sk-ant-e2e-' + randomBytes(6).toString('hex'), baseUrl: model.url })).ok, true);
    assert.equal((await call('ai:setModels', { models: [{ provider: 'anthropic', model: 'claude-sonnet-stub', label: 'Claude Sonnet Stub' }], defaultIndex: 0 })).ok, true);
    const saved = await call('agent:save', { projectId: pid, agent: { name: 'Shipping helper', topicId: null, model: null, build: false, teamIds: [] } });
    const agentId: string = saved.agent?.id ?? saved.id;
    assert.match(agentId, /^[0-9a-f-]{36}$/, JSON.stringify(saved).slice(0, 200));

    // ── Admin → Embedding: the dashboards' set-up first (secret, site, switch) ──
    await page.goto('/admin?tab=embedding');
    await settled(page);
    await page.getByRole('button', { name: 'Generate secret' }).click();
    const secret = (await page.getByTestId('embed-secret').textContent())?.trim() ?? '';
    assert.match(secret, /^ord_embed_[A-Za-z0-9_-]{43}$/);
    await page.getByRole('button', { name: 'I have stored it' }).click();
    await page.getByLabel('Allow a site').fill(allowed.origin);
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await page.getByRole('list', { name: 'Allowed sites' }).getByText(allowed.origin).waitFor();
    await page.getByRole('switch', { name: 'Allow embedding' }).click();
    await page.getByText('On', { exact: true }).first().waitFor();

    // ── …then the Assistant section: nothing embeddable yet, the metadata ceiling said ──
    const section = page.getByRole('region', { name: 'Embedded Assistant' });
    await section.scrollIntoViewIfNeeded();
    await section.getByText(/No agent is embeddable yet/).waitFor();
    assert.match((await section.getByRole('note').textContent()) ?? '', /shown to every customer/);
    await section.getByRole('button', { name: 'Mark an agent' }).click();
    const form = section.getByRole('form', { name: 'Mark an assistant embeddable' });
    const pick = async (label: RegExp, option: string) => {
      await form.getByRole('combobox', { name: label }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    };
    await form.getByRole('combobox', { name: /^Project/ }).click(); // the sample project is the only one
    await page.getByRole('option').first().click();
    await pick(/Assistant agent/, 'Shipping helper');
    await form.getByRole('checkbox', { name: 'Retail orders' }).check();
    await pick(/Lock column of Retail orders/, 'region');
    await form.getByRole('button', { name: 'Save' }).click();
    await section.getByRole('list', { name: 'Embeddable agents' }).getByText('Locked').waitFor();
    await section.getByLabel('Questions a minute, per customer').fill('2');
    await section.getByRole('button', { name: 'Save caps' }).click();
    await page.getByText('Caps saved.').waitFor();
    await screens(page, 'admin-embedding-assistant');
    assert.equal((await page.content()).includes(secret), false, 'the secret is not on the page');
    const org: string = (await call('embedAssistant:settings')).org;

    // ── The host page frames the Assistant for an East customer ──
    const east = sign(secret, org, { agent: agentId, sub: 'cust-east', params: { region: ['East'] } });
    await page.goto(`${allowed.origin}/?src=${encodeURIComponent(`${server.base}/embed/ask/${east}`)}`);
    const frame = await assistantFrame(page);
    await frame.getByText('You see only your own data.').waitFor();
    await page.screenshot({ path: path.join(SCREENS, 'embed-ask-empty.png'), fullPage: true });
    const ask = async (f: Frame, text: string) => {
      await f.getByLabel('Your question').fill(text);
      await f.getByRole('button', { name: 'Ask' }).click();
    };
    await ask(frame, QUESTION);
    const card = frame.getByRole('region', { name: /split by state/i }).first();
    await card.waitFor({ timeout: 60_000 });
    await card.getByRole('img').waitFor();
    await card.getByText('Show as a table').click();
    const eastText = await card.innerText();
    assert.ok(/Pennsylvania|Florida|New York/.test(eastText), `East's states are drawn: ${eastText}`);
    assert.ok(!/California|Texas|Illinois|Massachusetts/.test(eastText), 'no other region\'s state is drawn');
    assert.ok(!/Illinois|California/.test(await frame.locator('body').innerText()), 'nothing of another region anywhere in the page');
    await page.screenshot({ path: path.join(SCREENS, 'embed-ask-answer.png'), fullPage: true });
    assert.ok(model.asked.length >= 1 && model.asked.every((a) => !/California|Texas|Illinois|Massachusetts/.test(a)), 'the model was shown no other region\'s value');

    // ── A West customer: their own states, none of East's ──
    const west = sign(secret, org, { agent: agentId, sub: 'cust-west', params: { region: ['West'] } });
    await page.goto(`${allowed.origin}/?src=${encodeURIComponent(`${server.base}/embed/ask/${west}`)}`);
    const wf = await assistantFrame(page);
    await ask(wf, QUESTION);
    const wcard = wf.getByRole('region', { name: /split by state/i }).first();
    await wcard.waitFor({ timeout: 60_000 });
    await wcard.getByText('Show as a table').click();
    const westText = await wcard.innerText();
    assert.ok(/California|Arizona|Oregon/.test(westText) && !/Pennsylvania|Florida|New York/.test(westText), `West sees West: ${westText}`);

    // ── The cap: 2 a minute per customer (East asked once in the browser above). Asked from this process, not the page: a held-back
    // question is a 429, which a browser logs as a console error and this suite counts as a failure; the composer's wait is a Vitest case.
    const post = (token: string) => page.request.post(`${server.base}/embed/ask`, { data: { token, question: QUESTION } });
    const second = await post(east);
    assert.equal(second.status(), 200, 'the second question of the minute is answered');
    const third = await post(east);
    assert.equal(third.status(), 429, 'the third is held back');
    assert.ok(Number(third.headers()['retry-after']) >= 1, 'with Retry-After');
    assert.match(JSON.stringify(await third.json()), /Too many questions/);
    assert.equal((await post(west)).status(), 200, 'another customer is not held by it');
    const rows = await call('embedAssistant:settings');
    assert.ok(rows.counts.limited >= 1, 'the held-back question is counted');

    // ── The same page on an origin NOT on the list: the browser refuses the frame ──
    const browser = await launchBrowser();
    try {
      const other = await (await browser.newContext()).newPage();
      const errors: string[] = [];
      other.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const token = sign(secret, org, { agent: agentId, sub: 'cust-x', params: { region: ['East'] } });
      await other.goto(`${stranger.origin}/?src=${encodeURIComponent(`${server.base}/embed/ask/${token}`)}`);
      const f = await (await other.waitForSelector('iframe')).contentFrame();
      await other.waitForTimeout(2500);
      const drawn = f ? await f.locator('body[data-ready="true"]').count().catch(() => 0) : 0;
      assert.equal(drawn, 0, 'nothing of the Assistant rendered in the stranger\'s frame');
      assert.ok(errors.some((e) => /frame-ancestors/.test(e)), `the browser names frame-ancestors: ${errors.join(' | ')}`);
    } finally {
      await browser.close();
    }
  });
}
