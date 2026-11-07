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
//   - Who sees each column (semantic layer part 4): on its own project, the admin hides
//     salary and ssn from everyone but team HR, in the UI; the carrier bonus_pct is listed
//     read-only. Vera, outside HR, sees "3 columns hidden" over the grid, locks in Columns,
//     the server's sentence on "Pay by department" and "Headcount by department" drawn;
//     Hana, in HR, sees salary. The admin then stops hiding both, each asked first.
//
// Screens: web/e2e/__screens__/row-access-{tab,viewer,explore,publish}-{light,dark}.png,
// column-access-{none,set,editor,dashboard,viewer-grid,viewer-fields}-{light,dark}.png.
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

  const { e2e, settled, screens, configureServer, failOnConsoleError, rpcBudget, SCREENS } = await import('./fixtures.ts');
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
    // Published: Vera, a viewer, reads published dashboards only.
    assert.equal((await rpc(ADMIN, 'analysis:publish', { projectId: pid, id: board.id })).ok, true);
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
      assert.equal(await vpage.getByRole('tab', { name: 'Access', exact: true }).count(), 0, 'a viewer has no Access tab');
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

  e2e('column access: an admin hides salary and ssn from all but HR; a viewer outside HR sees them hidden, HR sees them', async ({ page, server, rpc: adminLoads }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel} as ${as}: ${await r.text()}`);
      return r.json();
    };
    const HANA = 'hana@acme.test';
    // A project of its own: Staff (bonus_pct is computed from salary, so it is a carrier), two charts on a published dashboard.
    const pid: string = (await rpc(ADMIN, 'projects:create', { name: 'People' })).id;
    const DEPTS = ['Ops', 'Eng', 'Sales'];
    const saved = await rpc(ADMIN, 'dataset:composeSave', {
      projectId: pid,
      name: 'Staff',
      base: { inline: { name: 'Staff', columns: [{ name: 'dept', type: 'text' }, { name: 'salary', type: 'number' }, { name: 'ssn', type: 'text' }, { name: 'employee_id', type: 'text' }], rows: Array.from({ length: 9 }, (_, i) => [DEPTS[i % 3], 52000 + i * 1500, `SSN-00${i}`, `e${i}`]) } },
      joins: [],
      steps: [],
      sourceKind: 'paste',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const staff: string = saved.dataset.id;
    assert.equal((await rpc(ADMIN, 'dataset:addStep', { projectId: pid, datasetId: staff, step: { type: 'calculated_field', name: 'bonus_pct', expression: '[salary] / 1000' } })).ok, true);
    assert.equal((await rpc(ADMIN, 'catalog:setColumn', { projectId: pid, datasetId: staff, column: 'ssn', patch: { sensitivity: 'personal' } })).ok, true);
    for (const who of [HANA, VERA]) await rpc(who, 'projects:list'); // a first request provisions each (the row test may not have run)
    const users = (await rpc(ADMIN, 'admin:users')) as { id: string; email: string }[];
    const idOf = (email: string) => users.find((u) => u.email === email)!.id;
    const hr: string = (await rpc(ADMIN, 'admin:createTeam', { name: 'HR' })).id;
    await rpc(ADMIN, 'admin:teamMember', { teamId: hr, userId: idOf(HANA), member: true });
    for (const member of [{ teamId: hr }, { userId: idOf(VERA) }]) assert.equal((await rpc(ADMIN, 'project:share', { projectId: pid, member, role: 'viewer' })).ok, true);
    const visual = async (name: string, values: object[]): Promise<string> => {
      const v = await rpc(ADMIN, 'visual:save', { projectId: pid, datasetId: staff, name, chartType: 'bar', encoding: { category: 'dept', values } });
      return v.visual?.id ?? v.id;
    };
    const pay = await visual('Pay by department', [{ column: 'salary', aggregation: 'sum' }]);
    const heads = await visual('Headcount by department', [{ column: 'employee_id', aggregation: 'count' }]);
    const card = (visualId: string, x: number) => ({ id: crypto.randomUUID(), type: 'visual', layout: { x, y: 0, w: 6, h: 6 }, visualId });
    const board = await rpc(ADMIN, 'analysis:create', { projectId: pid, name: 'People', sheets: [{ name: 'One', cards: [card(pay, 0), card(heads, 6)] }] });
    assert.equal((await rpc(ADMIN, 'analysis:publish', { projectId: pid, id: board.id })).ok, true);

    // ── The admin hides salary and ssn, in the Access tab ─────────────────
    await page.goto(`/data/${pid}/${staff}?tab=access`);
    const section = page.getByRole('region', { name: 'Who sees each column' });
    await section.getByRole('heading', { name: 'No hidden columns' }).waitFor();
    await section.getByText('ssn is marked sensitive. Hide it from viewers?').waitFor();
    await screens(page, 'column-access-none');
    await section.getByRole('button', { name: 'Hide a column…' }).click();
    const add = page.getByRole('dialog', { name: 'Hide a column' });
    await add.getByRole('combobox', { name: 'Column' }).click();
    await page.getByRole('option', { name: 'salary', exact: true }).click();
    await add.getByRole('combobox', { name: 'Add a person or team' }).fill('HR');
    await page.getByRole('option', { name: 'HR (team)' }).click();
    await add.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Who sees salary is saved.').waitFor();
    await section.getByRole('button', { name: 'Hide ssn' }).click(); // one click: hidden from every viewer
    await section.getByText('Hidden from every viewer').waitFor();
    await section.getByRole('button', { name: 'Edit who sees ssn' }).click();
    const edit = page.getByRole('dialog', { name: 'Who sees ssn' });
    await edit.getByRole('combobox', { name: 'Add a person or team' }).fill('HR');
    await page.getByRole('option', { name: 'HR (team)' }).click();
    await edit.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Who sees ssn is saved.').waitFor();
    const rows = section.getByRole('list', { name: 'Hidden columns' }).getByRole('listitem');
    await rows.filter({ hasText: 'ssn' }).getByText('Only: HR').waitFor(); // the list is asked again after the save
    await rows.filter({ hasText: 'bonus_pct' }).getByText('(hidden too: computed from salary)').waitFor();
    assert.deepEqual(await rows.allTextContents().then((t) => t.map((x) => x.replace(/\s+/g, ''))), ['salary·Only:HR', 'ssn·Only:HR', 'bonus_pct·Only:HR(hiddentoo:computedfromsalary)']);
    assert.equal(await rows.filter({ hasText: 'bonus_pct' }).getByRole('button').count(), 0, 'a carrier has no edit');
    const stored = await rpc(ADMIN, 'dataset:columnAccess', { projectId: pid, datasetId: staff });
    assert.deepEqual(stored.rules, [{ column: 'salary', visibleTo: [{ teamId: hr }] }, { column: 'ssn', visibleTo: [{ teamId: hr }] }, { column: 'bonus_pct', visibleTo: [{ teamId: hr }], from: 'salary' }]);
    await screens(page, 'column-access-set');
    await section.getByRole('button', { name: 'Edit who sees salary' }).click();
    await page.getByRole('dialog', { name: 'Who sees salary' }).waitFor();
    await screensInPlace(page, 'column-access-editor');
    await page.getByRole('dialog', { name: 'Who sees salary' }).getByRole('button', { name: 'Cancel' }).click();

    // ── Vera, a viewer outside HR; then Hana, in HR ──────────────────────
    const as = async (email: string, fn: (p: Page) => Promise<void>): Promise<void> => {
      const ctx = await page.context().browser()!.newContext({ baseURL: server.base, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-email': email } });
      const p = await ctx.newPage();
      const problems = await failOnConsoleError(p);
      const budget = rpcBudget(p);
      try {
        await fn(p);
        assert.deepEqual([...problems(), ...budget.problems()], []);
        console.log(budget.loads.map((l) => `rpc ${l.rpcs} ${new URL(l.url).pathname}${new URL(l.url).search}`).join('\n'));
      } finally {
        await ctx.close();
      }
    };
    await as(VERA, async (v) => {
      await v.goto(`/analyses/${pid}/${board.id}`);
      await v.getByRole('heading', { level: 1, name: 'People' }).waitFor();
      await v.getByRole('group', { name: 'Pay by department card' }).getByText(/limited to certain people/).waitFor();
      await v.getByRole('group', { name: 'Headcount by department card' }).locator('canvas').waitFor();
      await settled(v);
      await screens(v, 'column-access-dashboard');
      await v.goto(`/data/${pid}/${staff}`);
      await v.getByText('Limited to your access', { exact: true }).waitFor();
      const note = v.getByText('3 columns hidden');
      await note.waitFor();
      assert.equal(await note.getAttribute('title'), 'Hidden from you: salary, ssn, bonus_pct');
      const grid = v.getByRole('grid', { name: 'Staff rows' });
      await grid.getByText('Ops').first().waitFor();
      const names = (await grid.getByRole('columnheader').allInnerTexts()).map((t) => t.split('\n')[0].trim());
      assert.deepEqual(names, ['dept', 'employee_id']);
      assert.equal(await v.getByText(/SSN-00/).count(), 0, 'no ssn value on the page');
      await screens(v, 'column-access-viewer-grid');
      await v.goto(`/data/${pid}/${staff}?tab=columns`);
      await v.getByRole('img', { name: 'Hidden from you' }).first().waitFor();
      assert.equal(await v.getByRole('img', { name: 'Hidden from you' }).count(), 3);
      await screens(v, 'column-access-viewer-fields');
    });
    await as(HANA, async (h) => {
      await h.goto(`/data/${pid}/${staff}`);
      const grid = h.getByRole('grid', { name: 'Staff rows' });
      await grid.getByText('SSN-000').waitFor();
      const names = (await grid.getByRole('columnheader').allInnerTexts()).map((t) => t.split('\n')[0].trim());
      assert.deepEqual(names, ['dept', 'salary', 'ssn', 'employee_id', 'bonus_pct']);
      assert.equal(await h.getByText(/columns? hidden/).count(), 0);
    });

    // ── Clean up: stop hiding both, each asked first ──────────────────────
    for (const column of ['ssn', 'salary']) {
      await section.getByRole('button', { name: `Stop hiding ${column}` }).click();
      const ask = page.getByRole('dialog', { name: `Stop hiding ${column}?` });
      await ask.getByRole('button', { name: 'Stop hiding' }).click();
      await ask.waitFor({ state: 'detached' });
    }
    await section.getByRole('heading', { name: 'No hidden columns' }).waitFor();
    assert.deepEqual((await rpc(ADMIN, 'dataset:columnAccess', { projectId: pid, datasetId: staff })).rules, []);
    console.log(adminLoads.loads.map((l) => `rpc ${l.rpcs} ${new URL(l.url).pathname}${new URL(l.url).search}`).join('\n'));
  });
}
