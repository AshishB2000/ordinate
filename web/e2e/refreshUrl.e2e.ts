// E2E (live data L0.5): a project editor makes a refresh URL for a dataset
// from its page, against the real server on its own scratch Postgres (header
// sign-in from a trusted 127.0.0.1 peer). The URL is shown once; a POST to it
// from outside the browser — as dbt or Airflow would — answers 202 and
// refreshes the dataset; the list then says when it was last called; the
// examples are there; revoking it from the panel makes the URL a 404. Light
// and dark screenshots of the panel go to web/e2e/__screens__/refresh-url-*.png.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import type { Page } from 'playwright';

const EDITOR = 'boss@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('refresh URL e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_hooks_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, SCREENS, settled, configureServer } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: EDITOR, REFRESH_HOOK_MIN_INTERVAL_SEC: '60' },
    headers: { 'x-forwarded-email': EDITOR },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  /** Every running animation (the dialog's entrance, the tab underline) has finished. */
  const still = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))).then(() => undefined));

  /** The panel in both themes: the stored theme switched, the page reloaded and the panel reopened (a reload closes it). */
  async function panelScreens(page: Page, name: string, reopen: () => Promise<void>): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
      await page.reload();
      await settled(page);
      await reopen();
      await still(page);
      await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
    }
    await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
    await page.reload();
    await settled(page);
    await reopen();
  }

  /** A state that cannot be reached twice (a URL shown once): both themes by flipping the applied theme in place. */
  async function inPlaceScreens(page: Page, name: string): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await still(page);
      await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  }

  e2e('refresh URL: make one → call it from outside → listed as called → revoke → 404', async ({ page, server }) => {
    // Records live in Postgres here: make a project and a refreshable (composed) dataset over RPC.
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (channel: string, payload?: unknown) => {
      const res = await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
      assert.equal(res.status(), 200, `${channel}: ${await res.text()}`);
      return res.json();
    };
    const projectId = (await rpc('projects:create', { name: 'Warehouse' })).id as string;
    const staged = async (text: string) => (await rpc('dataset:parsePaste', { text })).preview.stagedId as string;
    const south = await rpc('dataset:composeSave', { projectId, name: 'South', base: { inline: { name: 'South', stagedId: await staged('region,revenue\nsouth,20') } }, joins: [], steps: [], sourceKind: 'paste' });
    const orders = await rpc('dataset:composeSave', {
      projectId, name: 'Orders', base: { inline: { name: 'North', stagedId: await staged('region,revenue\nnorth,10') } },
      joins: [{ datasetId: south.dataset.id, mode: 'append' }], steps: [], sourceKind: 'paste',
    });
    const datasetId = orders.dataset.id as string;

    await page.goto(`/data/${projectId}/${datasetId}`);
    await settled(page);
    const openPanel = async () => {
      await page.getByRole('button', { name: 'More dataset actions' }).click();
      await page.getByRole('menuitem', { name: 'Refresh URL…' }).click();
      await page.getByRole('dialog', { name: 'Refresh URL · Orders' }).waitFor();
    };
    await openPanel();
    const panel = page.getByRole('dialog', { name: 'Refresh URL · Orders' });
    await panel.getByRole('heading', { name: 'No refresh URLs yet' }).waitFor();
    await panel.getByText(/refreshes “Orders” from its source/).waitFor();
    await panelScreens(page, 'refresh-url-empty', openPanel);

    // Make one: shown once.
    await panel.getByRole('button', { name: 'New refresh URL' }).click();
    const url = (await panel.getByTestId('new-refresh-url').textContent()) ?? '';
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/api\/hooks\/refresh\/ordh_[A-Za-z0-9_-]{43}$/);
    await panel.getByText(/ordh_[A-Za-z0-9_-]{8}…/).waitFor();
    await inPlaceScreens(page, 'refresh-url-created');

    // Called from outside the browser, as a pipeline would: no cookie, no CSRF pair.
    const call = await fetch(url, { method: 'POST' });
    assert.equal(call.status, 202);
    assert.deepEqual(await call.json(), { status: 'queued' });
    const again = await fetch(url, { method: 'POST' });
    assert.equal(again.status, 429, 'a second call inside the minute');
    // The refresh it queued lands (the dataset's own record says so).
    let refreshed = false;
    for (let i = 0; i < 50 && !refreshed; i++) {
      const list = (await rpc('dataset:list', { projectId })) as { id: string; lastRefreshedAt?: string; lastRefreshStatus?: string }[];
      const d = list.find((x) => x.id === datasetId);
      refreshed = !!d?.lastRefreshedAt && d.lastRefreshStatus !== 'error';
      if (!refreshed) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(refreshed, 'the call refreshed the dataset');
    await page.keyboard.press('Escape');
    await page.reload();
    await settled(page);

    // Reopened: the URL is gone from the screen for good; the list says it was called.
    await openPanel();
    await panel.getByText(/last called/).waitFor();
    assert.equal(await panel.getByTestId('new-refresh-url').count(), 0, 'the URL is not shown again');
    await panel.getByRole('tab', { name: 'Airflow' }).click();
    await panel.getByText(/HttpOperator\(/).waitFor();
    await panelScreens(page, 'refresh-url', async () => {
      await openPanel();
      await panel.getByText(/last called/).waitFor();
      await panel.getByRole('tab', { name: 'Airflow' }).click();
      await page.mouse.move(0, 0); // no hover state in the picture
    });

    // Revoke from the panel: the URL is a 404 from its next call.
    await panel.getByRole('button', { name: /^Revoke ordh_/ }).click();
    await page.getByRole('dialog', { name: 'Revoke this refresh URL?' }).getByRole('button', { name: 'Revoke URL' }).click();
    await panel.getByText('Revoked', { exact: true }).waitFor();
    const gone = await fetch(url, { method: 'POST' });
    assert.equal(gone.status, 404);
    assert.ok(!server.log().includes(url.split('/').pop() ?? '-'), 'the token is in no server log line');
  });
}
