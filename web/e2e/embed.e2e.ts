// Signed embedding end to end (docs/embed/00-design.md), on Postgres with the
// secrets store: an org admin sets it up in Admin → Embedding — generates the
// secret (shown once), allows a site, turns it on, previews — an editor opens
// a published link's Embed… dialog and locks it to one region, and then a
// PARENT PAGE on another local origin frames /embed/<token> signed the way the
// Admin snippet signs it. The dashboard renders inside the frame with zero CSP
// violations; the same page served from an origin NOT on the list gets a
// frame the browser refuses (frame-ancestors).
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

/** A host app's page: its own chrome and the dashboard in an iframe. No CSP of its own. */
function portal(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const src = u.searchParams.get('src') ?? '';
    const dark = u.searchParams.get('theme') === 'dark';
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Acme customer portal</title><style>
      body{margin:0;font:14px/1.5 system-ui,sans-serif;background:${dark ? '#0f1115' : '#f4f5f7'};color:${dark ? '#e7e9ee' : '#1d2230'}}
      header{display:flex;align-items:center;gap:12px;padding:14px 24px;background:${dark ? '#171a21' : '#fff'};border-bottom:1px solid ${dark ? '#262b35' : '#e3e6eb'}}
      .logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#2563eb)}
      main{display:grid;grid-template-columns:200px 1fr;gap:24px;padding:24px}
      nav a{display:block;padding:8px 12px;border-radius:8px;color:inherit;text-decoration:none;opacity:.75}
      nav a.on{background:${dark ? '#222734' : '#e9edff'};opacity:1;font-weight:600}
      .card{background:${dark ? '#171a21' : '#fff'};border:1px solid ${dark ? '#262b35' : '#e3e6eb'};border-radius:14px;overflow:hidden}
      .card h2{margin:0;padding:14px 18px;font-size:15px;border-bottom:1px solid ${dark ? '#262b35' : '#e3e6eb'}}
      iframe{display:block;width:100%;height:900px;border:0}
    </style></head><body><header><span class="logo"></span><strong>Acme</strong><span style="opacity:.6">Customer portal · East region account</span></header>
    <main><nav><a>Orders</a><a class="on">Analytics</a><a>Invoices</a><a>Support</a></nav>
    <section class="card"><h2>Your sales</h2><iframe title="Sales dashboard" src="${esc(src)}"></iframe></section></main></body></html>`);
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

/** The embed frame of `page` once its dashboard has drawn. */
async function embedFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector('iframe');
  const frame = await handle.contentFrame();
  assert.ok(frame, 'the iframe has a frame');
  await frame.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  return frame;
}

if (!adminUrl) {
  void test('embed e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_embed_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, screens, settled, configureServer, launchBrowser, SCREENS } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN,
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
    },
    headers: { 'x-forwarded-email': ADMIN },
  });
  const allowed = await portal();
  const stranger = await portal();
  after(async () => {
    await allowed.close();
    await stranger.close();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const screensInPlace = async (page: Page, name: string): Promise<void> => {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  };
  /** One element, both themes — for what sits below the fold of the app's scrolling main area. */
  const elementShots = async (page: Page, selector: string, name: string): Promise<void> => {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(300);
      await page.locator(selector).screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`) });
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  };

  e2e('embedding: set up in Admin → an editor\'s Embed… with a locked region → a portal on an allowed origin frames it; another origin is refused', async ({ page, server, rpc }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const call = async (channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
      assert.equal(r.status(), 200, `${channel}: ${r.status()}`);
      return r.json();
    };
    const { projectId: pid } = await call('sample:seed');
    const dash = (await call('publish:targets', { projectId: pid })).dashboards[0];
    const published = await call('publish:run', { projectId: pid, dashboardIds: [dash.id] });
    assert.equal(published.ok, true, JSON.stringify(published).slice(0, 200));
    const site = published.site;

    // ── Admin → Embedding: nothing set up ──────────────────────────────
    await page.goto('/admin?tab=embedding');
    await settled(page);
    await page.getByRole('heading', { name: 'Show published dashboards inside your portal or app' }).waitFor();
    assert.equal(await page.getByRole('switch', { name: 'Allow embedding' }).isDisabled(), true, 'the switch waits for a secret and a site');
    await screens(page, 'admin-embedding-setup');
    console.log(`rpc: Admin → Embedding load ${rpc.loads.at(-1)?.rpcs ?? 0}`);

    // The secret, once.
    await page.getByRole('button', { name: 'Generate secret' }).click();
    const secret = (await page.getByTestId('embed-secret').textContent())?.trim() ?? '';
    assert.match(secret, /^ord_embed_[A-Za-z0-9_-]{43}$/);
    await page.getByText('Stored', { exact: true }).waitFor();
    await screensInPlace(page, 'admin-embedding-secret');
    await page.getByRole('button', { name: 'I have stored it' }).click();
    assert.equal((await page.content()).includes(secret), false, 'the secret is gone from the page once stored');

    // A site that is not an origin is refused as it is typed; the portal's is allowed.
    await page.getByLabel('Allow a site').fill(`${allowed.origin}/analytics`);
    await page.getByText(/no path, no wildcard/).waitFor();
    await page.getByLabel('Allow a site').fill(allowed.origin);
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await page.getByRole('list', { name: 'Allowed sites' }).getByText(allowed.origin).waitFor();
    await page.getByRole('switch', { name: 'Allow embedding' }).click();
    await page.getByText('On', { exact: true }).waitFor();

    await screens(page, 'admin-embedding');
    const org: string = (await call('embed:settings')).org;

    // Preview: the real page, signed by the server, in a same-origin frame.
    await page.getByRole('combobox', { name: 'Project' }).click();
    await page.getByRole('option').first().click();
    await page.getByRole('combobox', { name: 'Published link' }).click();
    await page.getByRole('option').first().click();
    await page.getByRole('button', { name: 'Preview embed' }).click();
    const preview = await embedFrame(page);
    assert.ok((await preview.content()).includes('Revenue'), 'the preview draws the dashboard');
    await elementShots(page, 'section[aria-label="Preview embed"]', 'admin-embedding-preview');

    // ── Dashboards → ⋯ → Embed…, locked to East ────────────────────────
    await page.goto(`/dashboards?project=${pid}`);
    await settled(page);
    await page.getByRole('button', { name: /options$/ }).first().click();
    await page.getByRole('menuitem', { name: 'Embed…' }).click();
    const dlg = page.getByRole('dialog', { name: /^Embed · / });
    await dlg.getByRole('button', { name: 'Lock a column' }).click();
    await dlg.getByRole('combobox', { name: 'Column' }).click();
    await page.getByRole('option', { name: 'region' }).click();
    await dlg.getByLabel('Values for region').fill('East');
    await dlg.getByTestId('embed-claims').getByText(/"region"/).waitFor();
    assert.match((await dlg.getByTestId('embed-claims').textContent()) ?? '', /"East"/);
    await dlg.getByRole('button', { name: 'Preview embed' }).click();
    const locked = await embedFrame(page);
    const lockedText = (await locked.locator('body').innerText());
    assert.ok(!/\bWest\b|\bCentral\b|\bSouth\b/.test(lockedText), 'the locked preview names no other region');
    await screensInPlace(page, 'embed-dialog');
    await dlg.getByRole('tab', { name: 'Signing code' }).click();
    await dlg.getByTestId('snippet-node').getByText(/"region"/).waitFor();
    await screensInPlace(page, 'embed-dialog-code');
    await dlg.getByRole('button', { name: 'Done' }).click();

    // ── A portal on an allowed origin frames it ─────────────────────────
    for (const theme of ['light', 'dark'] as const) {
      const token = sign(secret, org, { pub: site.id, dash: dash.id, params: { region: ['East'] }, theme, hide: ['title'] });
      await page.goto(`${allowed.origin}/?theme=${theme}&src=${encodeURIComponent(`${server.base}/embed/${token}`)}`);
      const frame = await embedFrame(page);
      const text = await frame.locator('body').innerText();
      assert.ok(text.includes('Revenue') && !/\bWest\b|\bCentral\b|\bSouth\b/.test(text), 'the portal shows East only');
      assert.equal(await frame.locator('.pub-title').count(), 0, 'hide: title is honoured');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENS, `embed-portal-${theme}.png`), fullPage: true });
    }

    // ── The same page on an origin NOT on the list: the browser refuses the frame ──
    // Its own browser: the refusal IS a console error (frame-ancestors), which this page's fixtures would fail on.
    const browser = await launchBrowser();
    try {
      const other = await (await browser.newContext()).newPage();
      const errors: string[] = [];
      other.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const token = sign(secret, org, { pub: site.id, dash: dash.id, params: { region: ['East'] } });
      await other.goto(`${stranger.origin}/?src=${encodeURIComponent(`${server.base}/embed/${token}`)}`);
      const frame = await (await other.waitForSelector('iframe')).contentFrame();
      await other.waitForTimeout(2500);
      const drawn = frame ? await frame.locator('body[data-ready="true"]').count().catch(() => 0) : 0;
      assert.equal(drawn, 0, 'nothing of the dashboard rendered in the stranger\'s frame');
      assert.ok(errors.some((e) => /frame-ancestors/.test(e)), `the browser names frame-ancestors: ${errors.join(' | ')}`);
      await other.screenshot({ path: path.join(SCREENS, 'embed-portal-refused.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  });
}
