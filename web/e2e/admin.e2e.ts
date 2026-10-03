// E2E (T3.4): an org admin, signed in by header mode (X-Forwarded-Email from a
// trusted 127.0.0.1 peer, as oauth2-proxy would send it) against the real
// server on its own scratch Postgres, walks the admin screens: invites a
// person, changes their role, makes a team and hands it a project,
// reads the audit log, then creates a personal API token, uses it on
// /api/mcp (initialize + a tool call; without it → 401) and revokes it from
// the UI (→ 401). A viewer gets the designed "admins only" state. Screens in
// both themes go to web/e2e/__screens__/admin-*.png.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
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

  const { e2e, screens, settled, configureServer } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
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
    const made = await page.request.post(`${server.base}/api/rpc/projects:create`, { data: { args: [{ name: PROJECT }] } });
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

  e2e('admin: a viewer gets the designed admins-only state and no Admin nav', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'x-forwarded-email': 'viewer@acme.test' });
    await page.goto('/admin');
    await page.getByRole('heading', { name: 'Only organization admins can open Admin' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Admin' }).count(), 0);
    await screens(page, 'admin-denied');
  });
}
