// E2E (T2.2): sharing a project from the switcher, on the real server with
// Postgres (header sign-in from a trusted 127.0.0.1 peer, its own scratch
// database). The org admin opens Share…, adds a person as Editor, changes them
// to Viewer, and that person — signed in as themselves — sees the project
// with a read-only "Who has access" and no Rename / Archive / Delete; then the
// admin removes them and they see nothing. Screens of the dialog in both
// themes go to web/e2e/__screens__/projects-share-*.png.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';

const ADMIN = 'admin@acme.test';
const SAM = 'sam@acme.test';
const PROJECT = 'Shared KPIs';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('projects share e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_share_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, settled, configureServer, SCREENS } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('projects: share from the switcher, and what the grantee then sees', async ({ page, server }) => {
    // Any GET hands the context its CSRF cookie (T6.2); a non-GET repeats it in X-CSRF-Token, as the app does.
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (as: string, channel: string, payload?: unknown) => {
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, {
        data: { args: payload === undefined ? [] : [payload] },
        headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf },
      });
      assert.equal(r.status(), 200, `${channel} as ${as}`);
      return r.json() as Promise<unknown>;
    };
    // Records live in Postgres here: make the project, and sam's account, over RPC.
    await rpc(ADMIN, 'projects:create', { name: PROJECT });
    await rpc(SAM, 'projects:list'); // a first header-mode request provisions sam (org viewer)

    const switcher = page.getByTestId('project-switcher');
    const pop = page.getByRole('dialog', { name: 'Projects' });
    const dialog = page.getByRole('dialog', { name: `Share ${PROJECT}` });
    const openShare = async () => {
      await switcher.click();
      await pop.getByRole('button', { name: `${PROJECT} options` }).click();
      await page.getByRole('menuitem', { name: 'Share…' }).click();
      await dialog.getByRole('list', { name: 'People and teams with access' }).waitFor();
    };

    await page.goto('/');
    await settled(page);
    await page.waitForFunction((n) => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes(n), PROJECT);
    await openShare();
    await dialog.getByText(ADMIN).waitFor(); // the creator's own admin grant
    await dialog.getByRole('combobox', { name: 'Add a person or team' }).click();
    await page.getByRole('option', { name: SAM }).click();
    await dialog.getByRole('combobox', { name: 'Role', exact: true }).click();
    await page.getByRole('option', { name: 'Editor' }).click();
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    const samRole = dialog.getByRole('combobox', { name: `Role of ${SAM}` });
    await samRole.waitFor();
    assert.equal((await samRole.textContent())?.trim(), 'Editor');
    await samRole.click();
    await page.getByRole('option', { name: 'Viewer' }).click();
    await page.waitForFunction((sam) => document.querySelector(`[aria-label="Role of ${sam}"]`)?.textContent?.trim() === 'Viewer', SAM);

    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
      await page.reload();
      await settled(page);
      await openShare();
      await dialog.getByRole('combobox', { name: `Role of ${SAM}` }).waitFor();
      await page.screenshot({ path: path.join(SCREENS, `projects-share-${theme}.png`), animations: 'disabled' });
    }
    await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
    await page.keyboard.press('Escape');

    // ── sam, a viewer on it ───────────────────────────────────────────────
    await page.setExtraHTTPHeaders({ 'x-forwarded-email': SAM });
    await page.reload();
    await settled(page);
    await page.waitForFunction((n) => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes(n), PROJECT);
    await switcher.click();
    assert.equal(await pop.getByRole('button', { name: 'New project' }).count(), 0, 'an org viewer creates no projects');
    await pop.getByRole('button', { name: `${PROJECT} options` }).click();
    const items = (await page.getByRole('menuitem').allTextContents()).map((t) => t.trim());
    assert.deepEqual(items, ['Who has access', 'Export project']);
    await page.getByRole('menuitem', { name: 'Who has access' }).click();
    const ro = page.getByRole('dialog', { name: `Who has access to ${PROJECT}` });
    await ro.getByText(SAM).waitFor();
    assert.equal(await ro.getByRole('combobox').count(), 0, 'read-only: no role pickers');
    await page.keyboard.press('Escape');

    // ── the admin removes sam; sam sees nothing ───────────────────────────
    await page.setExtraHTTPHeaders({ 'x-forwarded-email': ADMIN });
    await page.reload();
    await settled(page);
    await openShare();
    await dialog.getByRole('button', { name: `Remove ${SAM}` }).click();
    await dialog.getByText(SAM).waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await page.setExtraHTTPHeaders({ 'x-forwarded-email': SAM });
    await page.reload();
    await settled(page);
    await switcher.click();
    await pop.getByText('Nothing has been shared with you yet.', { exact: false }).waitFor();
  });
}
