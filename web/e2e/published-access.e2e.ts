// E2E (T2.9): who may open a published link, on the real server with Postgres
// (header sign-in from a trusted 127.0.0.1 peer, its own scratch database).
//
//   org (default)  a member opens it; a visitor who is not signed in gets
//                  nothing — the server sends them to sign in
//   link           refused until an org admin turns public links on; then a
//                  signed-out visitor opens the page, with zero CSP
//                  violations under its own pinned policy; turned off again,
//                  the same link closes at once
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const ADMIN = 'admin@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('published access e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_pub_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, configureServer, launchBrowser, failOnConsoleError } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('published links: org members by default, anyone only when the org allows it', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, {
        data: { args: payload === undefined ? [] : [payload] },
        headers: { 'x-forwarded-email': ADMIN, 'x-csrf-token': csrf },
      });
      assert.equal(r.status(), 200, `${channel}: ${r.status()}`);
      return r.json();
    };
    const project = await rpc('projects:create', { name: 'Board room' });
    const dash = await rpc('analysis:create', {
      projectId: project.id,
      name: 'Weekly note',
      sheets: [{ id: crypto.randomUUID(), name: 'Sheet 1', cards: [{ id: crypto.randomUUID(), type: 'text', layout: { x: 0, y: 0, w: 12, h: 3 }, heading: 'This week', text: 'All on track.' }] }],
    });
    const published = await rpc('publish:run', { projectId: project.id, dashboardIds: [dash.id] });
    assert.equal(published.ok, true, JSON.stringify(published));
    const link = `${server.base}/p/${published.site.id}/`;

    // A member opens it.
    await page.goto(link);
    await page.getByRole('link', { name: 'Dashboard Weekly note' }).waitFor();

    // Signed out: nothing of the page — the server sends the visitor to sign in.
    const browser = await launchBrowser();
    try {
      const anon = await (await browser.newContext()).newPage();
      const problems = await failOnConsoleError(anon);
      const res = await anon.goto(link);
      assert.match(anon.url(), /\/sign-in\?next=/, 'a signed-out visitor is sent to sign in');
      assert.equal((await res?.text())?.includes('Weekly note'), false);

      // Public links are off by default: a public site is refused.
      const refused = await rpc('publish:access', { projectId: project.id, id: published.site.id, access: 'link' });
      assert.equal(refused.ok, false);
      const settings = await rpc('admin:settings');
      await rpc('admin:saveSettings', { publicLinks: true, aiProviders: settings.aiProviders, uploadCapMb: settings.uploadCapMb });
      assert.equal((await rpc('publish:access', { projectId: project.id, id: published.site.id, access: 'link' })).ok, true);

      // Now anyone with the link opens it, signed out, under its own pinned CSP.
      const open = await anon.goto(link);
      assert.match(open?.headers()['content-security-policy'] ?? '', /^default-src 'none'.*frame-ancestors 'none'$/);
      await anon.getByRole('link', { name: 'Dashboard Weekly note' }).click();
      await anon.getByText('All on track.').waitFor();
      assert.deepEqual(problems(), [], 'the published page under its own CSP: zero violations, zero console errors');

      // Turned off again: the same link closes at once.
      await rpc('admin:saveSettings', { publicLinks: false, aiProviders: settings.aiProviders, uploadCapMb: settings.uploadCapMb });
      await anon.goto(link);
      assert.match(anon.url(), /\/sign-in\?next=/);
    } finally {
      await browser.close();
    }
  });
}
