// E2E (T3.4): an org admin, signed in by header mode (X-Forwarded-Email from a
// trusted 127.0.0.1 peer, as oauth2-proxy would send it) against the real
// server on its own scratch Postgres, walks the admin screens: invites a
// person, changes their role, makes a team and hands it a project,
// reads the audit log, opens Live usage (empty, then a month of counts on two
// connections over the test harness's fake warehouse, then today's limit
// reached), then creates a personal API token, uses it on /api/mcp
// (initialize + a tool call; without it → 401) and revokes it from the UI
// (→ 401). Admin → AI connects a STUB provider on loopback (an Anthropic API
// look-alike in this process) with a write-only key, adds two of its models,
// moves the default, and disconnects. A viewer gets the designed "admins
// only" state. Screens in both themes go to web/e2e/__screens__/admin-*.png.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const ADMIN = 'admin@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('admin e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_admin_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  // Admin → AI's provider: lists two models and answers a connection test with OK.
  const stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        req.method === 'GET' && req.url === '/v1/models'
          ? JSON.stringify({ data: [{ id: 'claude-sonnet-stub', display_name: 'Claude Sonnet Stub', created_at: 2 }, { id: 'claude-haiku-stub', display_name: 'Claude Haiku Stub', created_at: 1 }] })
          : JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  after(() => stub.close());

  const { e2e, screens, settled, configureServer } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
      // Live usage: named connections over the fake warehouse, and a small limit to see reached.
      ORDINATE_TEST_LIVE_FAKE: '1',
      LIVE_DAILY_QUERY_LIMIT: '2000',
      // Admin → AI: keys need the encrypted store; the stub provider is on loopback (SSRF guard, T6.1).
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
      SSRF_ALLOW: '127.0.0.1/32',
    },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('admin: invite, role change, team ownership, audit log, token create → use → revoke', async ({ page, server }) => {
    // Records live in Postgres here, so the file-seeded sample is not visible: make a project over RPC.
    const PROJECT = 'Quarterly KPIs';
    // Any GET hands the context its CSRF cookie (T6.2); a non-GET repeats it in X-CSRF-Token, as the app does.
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const made = await page.request.post(`${server.base}/api/rpc/projects:create`, { headers: { 'x-csrf-token': csrf }, data: { args: [{ name: PROJECT }] } });
    assert.equal(made.status(), 200);

    // ── People ─────────────────────────────────────────────────────────
    await page.goto('/admin');
    await settled(page);
    await page.getByRole('combobox', { name: `Role of ${ADMIN}` }).waitFor();
    await page.getByRole('button', { name: 'Invite people' }).click();
    await page.getByLabel('Email').fill('sam@acme.test');
    await page.getByRole('combobox', { name: 'Role', exact: true }).click();
    await page.getByRole('option', { name: 'Editor' }).click();
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const samRow = page.getByRole('row').filter({ hasText: 'sam@acme.test' });
    await samRow.getByText('Invited').waitFor();
    const samRole = page.getByRole('combobox', { name: 'Role of sam@acme.test' });
    assert.equal((await samRole.textContent())?.trim(), 'Editor');

    await samRole.click();
    await page.getByRole('option', { name: 'Viewer' }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[aria-label="Role of sam@acme.test"]');
      return el?.textContent?.trim() === 'Viewer' && !el.hasAttribute('disabled');
    });
    await page.reload();
    await settled(page);
    assert.equal((await page.getByRole('combobox', { name: 'Role of sam@acme.test' }).textContent())?.trim(), 'Viewer', 'the role change persisted');
    await screens(page, 'admin-people');

    // ── Teams and project ownership ─────────────────────────────────────
    await page.getByRole('tab', { name: 'Teams' }).click();
    await page.getByRole('heading', { name: 'No teams yet' }).waitFor();
    await page.getByRole('button', { name: 'Create a team' }).click();
    await page.getByLabel('Team name').fill('Analysts');
    await page.getByRole('button', { name: 'Create team' }).click();
    await page.getByRole('cell', { name: 'Analysts', exact: true }).waitFor();
    await screens(page, 'admin-teams');

    await page.getByRole('tab', { name: 'Projects' }).click();
    await page.getByRole('button', { name: `Transfer ${PROJECT}` }).click();
    await page.getByRole('combobox', { name: 'New owner team' }).click();
    await page.getByRole('option', { name: 'Analysts' }).click();
    await page.getByRole('button', { name: 'Transfer ownership' }).click();
    await page.getByRole('row').filter({ hasText: PROJECT }).getByRole('cell', { name: 'Analysts', exact: true }).waitFor();
    await screens(page, 'admin-projects');

    // ── Audit log: the actions above, filtered by channel ───────────────
    await page.getByRole('tab', { name: 'Audit log' }).click();
    await page.getByRole('cell', { name: 'admin:invite', exact: true }).first().waitFor();
    for (const ch of ['admin:setRole', 'admin:createTeam', 'admin:transferOwner']) {
      assert.ok((await page.getByRole('cell', { name: ch, exact: true }).count()) >= 1, `${ch} is in the audit log`);
    }
    await page.getByRole('combobox', { name: 'Channel' }).click();
    await page.getByRole('option', { name: 'admin:invite' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('tbody tr')].every((r) => r.textContent?.includes('admin:invite')));
    await screens(page, 'admin-audit');

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('switch', { name: 'Allow public links' }).waitFor();
    await screens(page, 'admin-settings');

    // ── Live usage: empty, then counted, then today's limit reached ─────
    await page.getByRole('tab', { name: 'Live usage' }).click();
    await page.getByRole('heading', { name: 'No live queries in the last 30 days' }).waitFor();
    await screens(page, 'admin-live-usage-empty');
    const projectId = ((await made.json()) as { id: string }).id;
    const saveConn = async (name: string) => {
      const r = await page.request.post(`${server.base}/api/rpc/connection:testAndSave`, {
        headers: { 'x-csrf-token': csrf },
        data: { args: [{ projectId, connectorId: 'live-fake', name, values: { fixture: 'orders' } }] },
      });
      const body = (await r.json()) as { ok: boolean; connection: { id: string } };
      assert.equal(body.ok, true, `${name} saved`);
      return body.connection.id;
    };
    const orders = await saveConn('Orders warehouse');
    const finance = await saveConn('Finance warehouse');
    // The doors that send Live statements are routed by L2.4: the counts are seeded where every pod writes them.
    const db = new pg.Client({ connectionString: scratch.toString() });
    await db.connect();
    const org = (await db.query<{ org_id: string }>('SELECT org_id FROM users WHERE email = $1', [ADMIN])).rows[0].org_id;
    const seedDay = (ago: number, conn: string, queries: number, bytes: number | null, refused = 0) =>
      db.query(
        `INSERT INTO live_usage (org_id, day, connection_id, project_id, queries, bytes, refused)
         VALUES ($1, (now() AT TIME ZONE 'UTC')::date - $2::int, $3, $4, $5, $6, $7)`,
        [org, ago, conn, projectId, queries, bytes, refused],
      );
    await seedDay(0, orders, 1240, 3_650_722_201);
    await seedDay(0, finance, 412, null);
    await seedDay(1, orders, 1873, 5_368_709_120);
    await seedDay(1, finance, 127, null, 0);
    await seedDay(2, orders, 960, 2_147_483_648);
    await seedDay(4, finance, 2000, null, 41);
    await page.reload();
    await settled(page);
    await page.getByRole('cell', { name: /Orders warehouse/ }).first().waitFor();
    assert.ok((await page.getByText('of 2,000 live warehouse queries').count()) === 1, 'today against the limit');
    assert.ok((await page.getByRole('cell', { name: '3.4 GB' }).count()) === 1, 'bytes as the server labelled them');
    assert.ok((await page.getByRole('cell', { name: 'Not reported' }).count()) >= 1, 'a warehouse that reports no bytes says so');
    await screens(page, 'admin-live-usage');
    await db.query(`UPDATE live_usage SET queries = 1588, refused = 37 WHERE connection_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date`, [orders]);
    await db.end();
    await page.reload();
    await settled(page);
    await page.getByRole('heading', { name: 'Today’s limit was reached' }).waitFor();
    await screens(page, 'admin-live-usage-limit');

    // ── API token: create (shown once) → use on /api/mcp → revoke ───────
    await page.goto('/tokens');
    await settled(page);
    await page.getByRole('heading', { name: 'No API tokens' }).waitFor();
    await screens(page, 'tokens-empty');
    await page.getByRole('button', { name: 'New token' }).click();
    await page.getByLabel('Name').fill('e2e MCP');
    await page.getByRole('button', { name: 'Create token' }).click();
    const token = (await page.getByTestId('new-token').textContent()) ?? '';
    assert.match(token, /^ord_[A-Za-z0-9_-]{43}$/);
    await page.getByRole('button', { name: 'I have copied it' }).click();
    await page.getByRole('cell', { name: `${token.slice(0, 12)}…` }).waitFor();
    assert.equal(await page.getByText(token).count(), 0, 'the token is not on the page after the dialog closes');

    const mcp = (auth: string | null, body: unknown) =>
      fetch(`${server.base}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(body),
      });
    const init = await mcp(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.status, 200);
    assert.equal(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'ordinate');
    const tool = await mcp(`Bearer ${token}`, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
    const listed = (await tool.json()) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(listed.result.isError, false);
    assert.ok(listed.result.content[0].text.includes(PROJECT), 'the tool call ran as the admin and saw the project');
    assert.equal((await mcp(null, { jsonrpc: '2.0', id: 3, method: 'initialize' })).status, 401, 'no token → 401');

    await page.reload();
    await settled(page);
    await page.getByRole('cell', { name: 'e2e MCP', exact: true }).waitFor();
    await screens(page, 'tokens');
    await page.getByRole('button', { name: 'Revoke e2e MCP' }).click();
    await page.getByRole('button', { name: 'Revoke token' }).click();
    await page.getByRole('heading', { name: 'No API tokens' }).waitFor();
    assert.equal((await mcp(`Bearer ${token}`, { jsonrpc: '2.0', id: 4, method: 'initialize' })).status, 401, 'revoked → 401');
  });

  e2e('admin: AI — connect a stubbed provider with a write-only key, add models, move the default, disconnect', async ({ page }) => {
    const KEY = 'sk-ant-e2e-' + randomBytes(8).toString('hex');
    await page.goto('/admin?tab=ai');
    await settled(page);
    const providers = page.getByRole('list', { name: 'Providers' });
    await providers.getByText('Not connected').first().waitFor();
    await page.getByRole('heading', { name: 'No models yet' }).waitFor();
    await screens(page, 'admin-ai-empty');

    // ── Connect: the key is a password field, never prefilled, cleared once sent ──
    await providers.getByRole('button', { name: 'Connect' }).first().click();
    const form = page.getByRole('form', { name: 'Connect Anthropic' });
    const key = form.getByLabel('API key');
    assert.equal(await key.getAttribute('type'), 'password');
    assert.equal(await key.inputValue(), '');
    await key.fill(KEY);
    await form.getByRole('button', { name: 'Advanced' }).click();
    await form.getByLabel('Base URL (optional)').fill(stubUrl);
    await form.getByRole('button', { name: 'Connect' }).click();
    await providers.getByText(/^Connected · tested/).waitFor();
    assert.equal(await form.count(), 0, 'the form closes once the test passed');

    // ── Add two of the provider's models; the first is the default ──────────
    await page.getByRole('button', { name: 'Add models' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add models' });
    await dialog.getByLabel('Claude Sonnet Stub').check();
    await dialog.getByLabel('Claude Haiku Stub').check();
    await dialog.getByRole('button', { name: 'Add 2 models' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('radio', { name: 'Make Claude Haiku Stub the default' }).waitFor();
    assert.equal(await page.getByRole('radio', { name: 'Make Claude Sonnet Stub the default' }).isChecked(), true);

    // ── Move the default; it holds across a reload ───────────────────────────
    await page.getByRole('radio', { name: 'Make Claude Haiku Stub the default' }).click();
    await page.getByRole('radio', { name: 'Make Claude Haiku Stub the default', checked: true }).waitFor();
    await page.reload();
    await settled(page);
    await page.getByRole('radio', { name: 'Make Claude Haiku Stub the default', checked: true }).waitFor();
    assert.equal((await page.content()).includes(KEY), false, 'the key is nowhere in the page');
    await screens(page, 'admin-ai');

    // ── Disconnect: the confirmation names what members lose ─────────────────
    await page.getByRole('button', { name: 'Disconnect' }).click();
    const confirm = page.getByRole('dialog', { name: 'Disconnect Anthropic?' });
    await confirm.getByText(/members lose 2 models/).waitFor();
    await confirm.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('heading', { name: 'No models yet' }).waitFor();
    await providers.getByText('Not connected').first().waitFor();
  });

  e2e('admin: a viewer gets the designed admins-only state and no Admin nav', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'x-forwarded-email': 'viewer@acme.test' });
    await page.goto('/admin');
    await page.getByRole('heading', { name: 'Only organization admins can open Admin' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Admin' }).count(), 0);
    await screens(page, 'admin-denied');
  });
}
