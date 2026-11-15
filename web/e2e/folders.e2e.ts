// E2E: shared folders (docs/team-folders E7), on the real server with Postgres and header sign-in, over the sample
// project.
//
//   - The org admin opens Share → Folders (empty), makes a top-level folder Finance and gives team Finance Can view,
//     in the UI.
//   - On Data, the rail appears; Move to… on the sample dataset shows the warning first (who loses access, the sample
//     dashboard that keeps showing its charts), then moves it. Under Finance the list holds it, and its page wears the
//     chip "In Finance · Finance can view".
//   - Vera, a project viewer in team Ops analysts, no longer sees it: not in Data, and its page says it is in a folder
//     she can't open. The admin gives Ops analysts Can view in Admin → Teams → Folders; she sees it again.
//   - At phone width the rail is a row of pills above the list.
//   - Share → Folders → Move everything to Everyone: the warning, then no folder holds anything.
//
//   - Dashboards: the rail beside the grid; the sample dashboard moves into Finance by Move to…; on Data the dataset
//     goes back by a drag onto Everyone in the rail (the Move dialog opens with it picked).
//
// Screens: web/e2e/__screens__/folders-{share-empty,share,move,data,chip,viewer,team,phone,dashboards,everything}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const ADMIN = 'admin@acme.test';
const VERA = 'vera@acme.test';
const FIN = 'fin@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('folders e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_folders_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, settled, screens, screensInPlace, configureServer, failOnConsoleError, rpcBudget } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('folders: an admin makes Finance and moves a dataset into it; a viewer outside Finance loses it until her team is given it', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel} as ${as}: ${await r.text()}`);
      return r.json();
    };
    const sample = await rpc(ADMIN, 'sample:seed');
    const pid: string = sample.projectId;
    const project: string = ((await rpc(ADMIN, 'projects:list')) as { id: string; name: string }[]).find((p) => p.id === pid)!.name;
    const dataset = ((await rpc(ADMIN, 'dataset:list', { projectId: pid })) as { id: string; name: string }[])[0];
    const team = async (name: string, who: string): Promise<string> => {
      await rpc(who, 'projects:list'); // a first header-mode request provisions them
      const id: string = (await rpc(ADMIN, 'admin:createTeam', { name })).id;
      const uid = ((await rpc(ADMIN, 'admin:users')) as { id: string; email: string }[]).find((u) => u.email === who)!.id;
      await rpc(ADMIN, 'admin:teamMember', { teamId: id, userId: uid, member: true });
      assert.equal((await rpc(ADMIN, 'project:share', { projectId: pid, member: { teamId: id }, role: 'viewer' })).ok, true);
      return id;
    };
    await team('Ops analysts', VERA);
    await team('Finance', FIN);

    // ── Share → Folders: make Finance, give it to team Finance ───────────
    const dialog = page.getByRole('dialog', { name: `Share ${project}` });
    const openFolders = async () => {
      await page.getByTestId('project-switcher').click();
      await page.getByRole('dialog', { name: 'Projects' }).getByRole('button', { name: `${project} options` }).click();
      await page.getByRole('menuitem', { name: 'Share…' }).click();
      await dialog.getByRole('tab', { name: 'Folders' }).click();
    };
    await page.goto('/');
    await settled(page);
    await openFolders();
    await dialog.getByRole('heading', { name: 'No folders yet' }).waitFor();
    await screensInPlace(page, 'folders-share-empty');
    await dialog.getByRole('button', { name: 'New folder' }).click();
    const make = page.getByRole('dialog', { name: 'New folder' });
    await make.getByRole('textbox', { name: 'Name' }).fill('Finance');
    await make.getByRole('button', { name: 'Create folder' }).click();
    await make.waitFor({ state: 'detached' });
    const card = dialog.getByRole('listitem', { name: 'Finance' });
    await card.getByRole('combobox', { name: 'Give it to a team' }).click();
    await page.getByRole('option', { name: /^Finance \(/ }).click();
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await card.getByRole('combobox', { name: 'Level of Finance' }).waitFor();
    await screensInPlace(page, 'folders-share');
    await page.keyboard.press('Escape');

    // ── Data: the rail, Move to… with its warning ───────────────────────
    await page.goto(`/data/${pid}`);
    await settled(page);
    const rail = page.getByRole('navigation', { name: 'Folders' });
    await rail.getByRole('button', { name: /^Finance \(0\)/ }).waitFor();
    await page.getByRole('button', { name: `Move ${dataset.name} to another folder` }).click();
    const move = page.getByRole('dialog', { name: `Move “${dataset.name}”` });
    await move.getByRole('radio', { name: /Finance/ }).click();
    const lines = move.getByRole('list', { name: 'What changes' });
    await lines.getByText(/will lose access/).waitFor();
    assert.match((await lines.textContent()) ?? '', /Everyone else in the project \(1 person\) will lose access/);
    await screensInPlace(page, 'folders-move');
    await move.getByRole('button', { name: 'Move to Finance' }).click();
    await move.waitFor({ state: 'detached' });
    const finance = rail.getByRole('button', { name: /^Finance \(1\)/ });
    await finance.waitFor();
    await finance.click();
    await page.getByText('Finance can view').first().waitFor();
    await page.getByRole('link', { name: dataset.name, exact: true }).waitFor();
    await screens(page, 'folders-data');
    await page.goto(`/data/${pid}/${dataset.id}`);
    await settled(page);
    const chip = page.getByRole('button', { name: /^In Finance/ });
    await chip.waitFor();
    assert.equal((await chip.textContent())?.trim(), 'In Finance· Finance can view');
    await screens(page, 'folders-chip');

    // ── Vera, outside Finance ────────────────────────────────────────────
    const vctx = await page.context().browser()!.newContext({ baseURL: server.base, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-email': VERA } });
    const vpage = await vctx.newPage();
    const problems = await failOnConsoleError(vpage);
    const budget = rpcBudget(vpage);
    try {
      await vpage.goto(`/data/${pid}`);
      await settled(vpage);
      assert.equal(await vpage.getByRole('link', { name: dataset.name, exact: true }).count(), 0, 'Vera does not see the moved dataset');
      await vpage.goto(`/data/${pid}/${dataset.id}`);
      await vpage.getByText("This is in a folder you can't open.").waitFor();
      await screens(vpage, 'folders-viewer');

      // ── Admin → Teams → Ops analysts → Folders: Can view on Finance ──────
      await page.goto('/admin');
      await settled(page);
      await page.getByRole('tab', { name: 'Teams' }).click();
      await page.getByRole('button', { name: 'Actions for Ops analysts' }).click();
      await page.getByRole('menuitem', { name: 'Folders…' }).click();
      const tf = page.getByRole('dialog', { name: 'Folders for Ops analysts' });
      await tf.getByRole('combobox', { name: 'Ops analysts on Finance' }).click();
      await page.getByRole('option', { name: 'Can view' }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Ops analysts on Finance"]')?.textContent?.trim() === 'Can view');
      await screensInPlace(page, 'folders-team');
      await page.keyboard.press('Escape');
      await vpage.goto(`/data/${pid}`);
      await settled(vpage);
      await vpage.getByRole('link', { name: dataset.name, exact: true }).waitFor(); // NEGATIVE CONTROL: her team now opens Finance
      assert.deepEqual([...problems(), ...budget.problems()], []);
    } finally {
      await vctx.close();
    }

    // ── Phone width: the rail is a row of pills ──────────────────────────
    const pctx = await page.context().browser()!.newContext({ baseURL: server.base, viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-email': ADMIN } });
    const ppage = await pctx.newPage();
    try {
      await ppage.goto(`/data/${pid}?folder=${(await rpc(ADMIN, 'folder:tree', { projectId: pid })).folders[0].id}`);
      await settled(ppage);
      await ppage.getByRole('navigation', { name: 'Folders' }).waitFor();
      const overflow = await ppage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px at phone width`);
      await screens(ppage, 'folders-phone');
    } finally {
      await pctx.close();
    }

    // ── Dashboards: the rail beside the grid; a card moves by Move to… ──
    const boardName: string = ((await rpc(ADMIN, 'analysis:gallery', { projectId: pid })) as { name: string }[])[0].name;
    await page.goto(`/dashboards?project=${pid}`);
    await settled(page);
    await page.getByRole('button', { name: `${boardName} options` }).click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    const bmove = page.getByRole('dialog', { name: `Move “${boardName}”` });
    await bmove.getByRole('radio', { name: /Finance/ }).click();
    await bmove.getByRole('list', { name: 'What changes' }).waitFor();
    await bmove.getByRole('button', { name: 'Move to Finance' }).click();
    await bmove.waitFor({ state: 'detached' });
    const brail = page.getByRole('navigation', { name: 'Folders' });
    await brail.getByRole('button', { name: /^Finance \(1\)/ }).click();
    await page.getByRole('link', { name: new RegExp(boardName) }).first().waitFor();
    await screens(page, 'folders-dashboards');

    // ── Data: drag the dataset back onto Everyone; the Move dialog opens with it picked ──
    await page.goto(`/data/${pid}`);
    await settled(page);
    await page.getByRole('row', { name: new RegExp(dataset.name) }).dragTo(page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: /^Everyone in the project \(/ }));
    const back = page.getByRole('dialog', { name: `Move “${dataset.name}”` });
    await back.getByRole('button', { name: 'Move to Everyone in the project' }).waitFor();
    await back.getByRole('list', { name: 'What changes' }).waitFor();
    await back.getByRole('button', { name: 'Move to Everyone in the project' }).click();
    await back.waitFor({ state: 'detached' });
    await page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: /^Everyone in the project \(1\)/ }).waitFor();

    // ── Move everything to Everyone ──────────────────────────────────────
    await page.goto('/');
    await settled(page);
    await openFolders();
    await dialog.getByRole('button', { name: 'Move everything to Everyone' }).click();
    const all = page.getByRole('dialog', { name: 'Move everything to Everyone in the project?' });
    await all.getByRole('list', { name: 'What changes' }).waitFor();
    await screensInPlace(page, 'folders-everything');
    await all.getByRole('button', { name: 'Move everything' }).click();
    await all.waitFor({ state: 'detached' });
    const tree = await rpc(ADMIN, 'folder:tree', { projectId: pid });
    assert.deepEqual(tree.placed, { dataset: {}, dashboard: {} }, 'no folder holds anything');
  });
}
