// E2E (docs/notifications/00-design.md): a mention reaches its person, on the
// real server with Postgres (header sign-in from a trusted 127.0.0.1 peer, its
// own scratch database). A (the org admin) and B (a project viewer) each have a
// page. B sits on Home. A opens a dashboard's comments, types @ — the picker
// lists the project's readers — picks B and posts. B's open tab shows "Admin
// mentioned you on Weekly review" with Open, and B's Home lists it under
// "Mentioned you", new; the card opens the thread, where the mention is a chip.
// Both pages hold the RPC budget (≤ 25 per load) and fail on any console error
// or CSP violation. Screens in both themes go to web/e2e/__screens__/
// notifications-*.png.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import type { Page } from 'playwright';

const ADMIN = 'admin@acme.test';
const BEA = 'bea@acme.test';
const adminUrl = process.env.DATABASE_URL;

/** One screenshot per theme WITHOUT a reload: a reload would drop the notice on screen. */
async function screensInPlace(page: Page, dir: string, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(dir, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

if (!adminUrl) {
  void test('notifications e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_notify_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, openSession, settled, configureServer, SCREENS } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('notifications: A mentions B on a dashboard → B\'s open tab shows the notice, and B\'s Home lists it', async ({ page, server, rpc }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const call = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, {
        data: { args: payload === undefined ? [] : [payload] },
        headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf },
      });
      assert.equal(r.status(), 200, `${channel} as ${as}`);
      return r.json();
    };
    // The project, B's account and grant, and a dashboard to talk about.
    const pid: string = (await call(ADMIN, 'projects:create', { name: 'Shared KPIs' })).id;
    await call(BEA, 'projects:list'); // a first header-mode request provisions bea (org viewer)
    const db = new pg.Client({ connectionString: scratch.toString() });
    await db.connect();
    const beaId: string = (await db.query<{ id: string }>('SELECT id::text FROM users WHERE email = $1', [BEA])).rows[0].id;
    await db.end();
    await call(ADMIN, 'project:share', { projectId: pid, member: { userId: beaId }, role: 'viewer' });
    const board = await call(ADMIN, 'analysis:create', {
      projectId: pid,
      name: 'Weekly review',
      sheets: [{ name: 'Overview', cards: [{ id: crypto.randomUUID(), type: 'text', layout: { x: 0, y: 0, w: 12, h: 2 }, heading: 'This week', text: 'Revenue against the plan, by week.' }] }],
    });
    assert.ok(board.id, JSON.stringify(board));

    // B's tab, on Home, before anything happens.
    const b = await openSession();
    try {
      await b.page.setExtraHTTPHeaders({ 'x-forwarded-email': BEA });
      await b.page.goto('/');
      await settled(b.page);
      const mentioned = b.page.getByRole('region', { name: 'Mentioned you' });
      await mentioned.getByText('No mentions yet').waitFor();

      // A types @ in the dashboard's comments and picks B.
      await page.goto(`/analyses/${pid}/${board.id}`);
      await settled(page);
      await page.getByRole('button', { name: 'Comments on this dashboard' }).click();
      const panel = page.getByRole('dialog', { name: 'Comments on this dashboard' });
      const box = panel.getByLabel('New comment');
      await box.click();
      await box.pressSequentially('Can you check the plan line, @be');
      const list = panel.getByRole('listbox', { name: 'People who can read this project' });
      await list.getByRole('option', { name: /Bea/ }).waitFor();
      await screensInPlace(page, SCREENS, 'notifications-picker');
      await box.press('Enter');
      assert.equal(await box.inputValue(), `Can you check the plan line, @(${BEA}) `);
      await box.pressSequentially('before Friday?');
      await panel.getByRole('button', { name: 'Post' }).click();
      const thread = panel.getByRole('listitem', { name: `Comment by ${ADMIN}` });
      await thread.getByText('@Bea', { exact: true }).waitFor(); // the chip, not the address
      assert.equal(await thread.getByText(BEA).count(), 0);
      console.log(`rpc: A's dashboard + comment ${rpc.loads.at(-1)?.rpcs ?? 0}`);

      // B's open tab: the notice, and Home's list.
      const notice = b.page.getByText('Admin mentioned you on Weekly review');
      await notice.waitFor();
      await mentioned.getByRole('button', { name: /Admin mentioned you on Weekly review, new/ }).waitFor();
      await screensInPlace(b.page, SCREENS, 'notifications-home');
      await mentioned.getByRole('button', { name: /Admin mentioned you on Weekly review/ }).click();
      await b.page.waitForURL(new RegExp(`/analyses/${pid}/${board.id}\\?comment=analysis:`));
      const bPanel = b.page.getByRole('dialog', { name: /Comments/ });
      await bPanel.getByText('@Bea', { exact: true }).waitFor();
      console.log(`rpc: B's Home ${b.rpc.loads[0]?.rpcs ?? 0}, B's dashboard ${b.rpc.loads.at(-1)?.rpcs ?? 0}`);
      const problems = b.problems();
      assert.deepEqual(problems, [], `B's page: ${problems.join('\n')}`);
    } finally {
      await b.close();
    }
  });
}
