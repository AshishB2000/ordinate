// E2E: row access rules (docs/row-policy/00-design.md), on the real server with
// Postgres and header sign-in, over the sample project.
//
//   - The org admin opens the sample dataset's Row access tab, adds a rule —
//     team East sees region East — and saves it, in the UI.
//   - Vera, in team East and a project viewer, opens a dashboard: its Revenue
//     KPI is the server's East-only figure (control: the admin's is the whole
//     table), the Region dropdown offers East and nothing else, and the dataset
//     page and Explore say "Rows limited to your access".
//   - The admin's Publish dialog says why that dashboard cannot be published.
//
// Screens: web/e2e/__screens__/row-access-{tab,viewer,explore,publish}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import type { Page } from 'playwright';

const ADMIN = 'admin@acme.test';
const VERA = 'vera@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('row access e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_rowaccess_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, settled, screens, configureServer, failOnConsoleError, SCREENS } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  /** One screenshot per theme WITHOUT a reload (a dialog stays up). */
  const screensInPlace = async (page: Page, name: string): Promise<void> => {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  };

  e2e('row access: an admin sets a rule; a viewer in team East sees East only; publishing says why it is off', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel} as ${as}: ${await r.text()}`);
      return r.json();
    };
    // The sample project, Vera (a first request provisions her), team East with Vera in it, and the team a viewer.
    const sample = await rpc(ADMIN, 'sample:seed');
    const pid: string = sample.projectId;
    const did: string = ((await rpc(ADMIN, 'dataset:list', { projectId: pid })) as { id: string }[])[0].id;
    await rpc(VERA, 'projects:list');
    const team: string = (await rpc(ADMIN, 'admin:createTeam', { name: 'East' })).id;
    const veraId = ((await rpc(ADMIN, 'admin:users')) as { id: string; email: string }[]).find((u) => u.email === VERA)!.id;
    await rpc(ADMIN, 'admin:teamMember', { teamId: team, userId: veraId, member: true });
    assert.equal((await rpc(ADMIN, 'project:share', { projectId: pid, member: { teamId: team }, role: 'viewer' })).ok, true);
    const card = (type: string, x: number, extra: Record<string, unknown>) => ({ id: crypto.randomUUID(), type, layout: { x, y: 0, w: 4, h: type === 'control' ? 1 : 3 }, ...extra });
    const board = await rpc(ADMIN, 'analysis:create', {
      projectId: pid,
      name: 'Regional',
      sheets: [{ name: 'One', cards: [
        card('control', 0, { control: { kind: 'dropdown', label: 'Region', datasetId: did, column: 'region' } }),
        card('metric', 4, { metric: { datasetId: did, column: 'revenue', aggregation: 'sum', label: 'Revenue' } }),
      ] }],
    });
    const east = { type: 'filter', column: 'region', op: '=', value: 'East' };
    const eastRevenue: number = (await rpc(ADMIN, 'dashboard:metric', { projectId: pid, datasetId: did, column: 'revenue', aggregation: 'sum', filters: [east] })).value;
    const allRevenue: number = (await rpc(ADMIN, 'dashboard:metric', { projectId: pid, datasetId: did, column: 'revenue', aggregation: 'sum' })).value;
    assert.ok(eastRevenue > 0 && eastRevenue < allRevenue, `${eastRevenue} vs ${allRevenue}`);

    // ── The admin sets the rule, in the Row access tab ───────────────────
    await page.goto(`/data/${pid}/${did}?tab=access`);
    await page.getByRole('heading', { name: 'No row access rules' }).waitFor();
    await page.getByRole('button', { name: 'Add rules' }).click();
    await page.getByRole('combobox', { name: 'Rule column' }).click();
    await page.getByRole('option', { name: 'region', exact: true }).click();
    await page.getByRole('combobox', { name: 'Who' }).fill('East');
    await page.getByRole('option', { name: 'East (team)' }).click();
    await page.getByRole('textbox', { name: 'Type a value' }).fill('East');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Row access rules saved.').waitFor();
    const saved = await rpc(ADMIN, 'dataset:rowPolicy', { projectId: pid, datasetId: did });
    assert.deepEqual(saved.policy, { column: 'region', rules: [{ teamId: team, values: ['East'] }] });
    await screens(page, 'row-access-tab');

    // ── Vera, a viewer in team East ──────────────────────────────────────
    const ctx = await page.context().browser()!.newContext({ baseURL: server.base, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-email': VERA } });
    const vpage = await ctx.newPage();
    const problems = await failOnConsoleError(vpage);
    try {
      await vpage.goto(`/analyses/${pid}/${board.id}`);
      await vpage.getByRole('heading', { level: 1, name: 'Regional' }).waitFor();
      const kpi = vpage.getByRole('group', { name: 'Revenue card' });
      const money = /^\$?([\d.,]+)\s?([KMB]?)$/;
      await kpi.getByText(money).first().waitFor({ timeout: 20_000 });
      const shown = (await kpi.getByText(money).first().textContent()) ?? '';
      const m = money.exec(shown)!;
      const value = Number(m[1].replace(/,/g, '')) * ({ '': 1, K: 1e3, M: 1e6, B: 1e9 } as Record<string, number>)[m[2]];
      assert.ok(Math.abs(value - eastRevenue) <= eastRevenue * 0.01, `Vera's Revenue shows ${shown}; East's is ${eastRevenue}, the whole table's ${allRevenue}`);
      await vpage.getByRole('button', { name: 'Region: All' }).click();
      const values = vpage.getByRole('group', { name: 'Region values' });
      await values.getByRole('button', { name: 'East', exact: true }).waitFor();
      const offered = (await values.getByRole('button').allTextContents()).map((t) => t.trim()).filter((t) => t !== 'All');
      assert.deepEqual(offered, ['East'], `the Region dropdown offers ${JSON.stringify(offered)}`);
      await vpage.keyboard.press('Escape');
      await settled(vpage);
      await screens(vpage, 'row-access-viewer');
      await vpage.goto(`/data/${pid}/${did}`);
      await vpage.getByText('Rows limited to your access').waitFor();
      assert.equal(await vpage.getByRole('tab', { name: 'Row access' }).count(), 0, 'a viewer has no Row access tab');
      // Explore: the same chip, and its suggestions drawn over East's rows (they go through visual:data).
      await vpage.goto(`/explore?project=${pid}&dataset=${did}`);
      await vpage.getByRole('heading', { level: 1, name: 'Explore' }).waitFor();
      await vpage.getByText('Rows limited to your access').waitFor();
      await settled(vpage);
      await screens(vpage, 'row-access-explore');
      assert.deepEqual(problems(), []);
    } finally {
      await ctx.close();
    }

    // ── Publishing that dashboard says why it is off ─────────────────────
    await page.goto(`/dashboards?project=${pid}&tab=links`);
    await settled(page);
    await page.getByRole('button', { name: 'Publish…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Publish' });
    await dlg.getByRole('checkbox', { name: 'Regional' }).waitFor();
    const boxes = dlg.getByRole('checkbox');
    for (let i = 0; i < (await boxes.count()); i++) {
      const box = boxes.nth(i);
      const label = (await box.getAttribute('aria-label')) ?? (await box.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? ''));
      if ((await box.isChecked()) !== (label === 'Regional')) await box.click();
    }
    await dlg.getByText(/row access rules/).waitFor();
    await screensInPlace(page, 'row-access-publish');
  }, { rpcBudget: 40 });
}
