// E2E: shared folders with the operator setting OFF (docs/team-folders E7, D21/D22: `ORDINATE_FOLDERS` unset), on the
// real server with Postgres and header sign-in, over the sample project.
//
//   - Share → Folders, none made: the designed empty state says folders are off, in one line, with no New folder.
//   - A folder made while the setting was on (written here as the database would hold it, the sample dataset in it, a
//     team at Can view): Data keeps the rail, with its one off line where New folder would be and no Move on the row;
//     the dashboards' options have no Move to…; Share → Folders shows the folder and its team as text, one off line, no
//     New folder, team or level controls and no Move everything to Everyone; Admin → Teams → Folders shows the level
//     as text with the same line.
//
// Screens: web/e2e/__screens__/folders-off-{share-empty,data,share,team}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line. folders.e2e.ts is the same screens turned on.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ADMIN = 'admin@acme.test';
const OFF = 'Making, sharing and moving folders is off on this server. An operator turns it on once every server runs this version.';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('folders (off) e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_folders_off_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, settled, screens, screensInPlace, configureServer } = await import('./fixtures.ts');
  configureServer({
    // ORDINATE_FOLDERS is not set: off, its default.
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('folders off: no New folder, no Move to… and no folder controls — one calm line in their place', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-forwarded-email': ADMIN, 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
      return r.json();
    };
    const { projectId: pid } = await rpc('sample:seed');
    const project: string = ((await rpc('projects:list')) as { id: string; name: string }[]).find((p) => p.id === pid)!.name;
    const dataset = ((await rpc('dataset:list', { projectId: pid })) as { id: string; name: string }[])[0];
    const boardName: string = ((await rpc('analysis:gallery', { projectId: pid })) as { name: string }[])[0].name;
    const made = await rpc('folder:create', { projectId: pid, parentId: null, name: 'Finance' });
    assert.equal(made.ok, false, 'off: making a folder is refused');

    // ── Share → Folders, none made ───────────────────────────────────────
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
    assert.equal(await dialog.getByText(OFF).count(), 1, 'one line says why');
    assert.equal(await dialog.getByRole('button', { name: 'New folder' }).count(), 0);
    await screensInPlace(page, 'folders-off-share-empty');
    await page.keyboard.press('Escape');

    // A folder made while the setting was on: Finance holds the sample dataset, team Finance can view it.
    const db = new pg.Client({ connectionString: scratch.toString() });
    await db.connect();
    const FIN = randomUUID();
    const teamId: string = (await rpc('admin:createTeam', { name: 'Finance' })).id;
    try {
      const org = (await db.query<{ org_id: string }>('SELECT org_id FROM users WHERE email = $1', [ADMIN])).rows[0].org_id;
      const p = pid.toLowerCase();
      await db.query('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, NULL, $4, $5)', [org, p, FIN, 'Finance', ADMIN]);
      await db.query("INSERT INTO folder_grants (org_id, project_id, folder_id, team_id, level) VALUES ($1, $2, $3, $4, 'view')", [org, p, FIN, teamId]);
      await db.query("INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, 'dataset', $3, $4, $5)", [org, p, dataset.id.toLowerCase(), FIN, ADMIN]);
    } finally {
      await db.end();
    }

    // ── Data: the rail stays, with one line where New folder would be, and no Move on the row ──
    await page.goto(`/data/${pid}`);
    await settled(page);
    const rail = page.getByRole('navigation', { name: 'Folders' });
    await rail.getByRole('button', { name: /^Finance \(1\)/ }).waitFor();
    await rail.getByText(OFF).waitFor();
    assert.equal(await rail.getByRole('button', { name: 'New folder' }).count(), 0, 'no New folder');
    await page.getByRole('link', { name: dataset.name, exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: `Move ${dataset.name} to another folder` }).count(), 0, 'no Move on the row');
    await screens(page, 'folders-off-data');

    // ── Dashboards: no Move to… among a dashboard's options ─────────────
    await page.goto(`/dashboards?project=${pid}`);
    await settled(page);
    await page.getByRole('button', { name: `${boardName} options` }).click();
    await page.getByRole('menu').waitFor();
    assert.equal(await page.getByRole('menuitem', { name: 'Move to…' }).count(), 0, 'no Move to…');
    await page.keyboard.press('Escape');

    // ── Share → Folders: the folder and its team as text, one line, no controls ──
    await page.goto('/');
    await settled(page);
    await openFolders();
    const card = dialog.getByRole('listitem', { name: 'Finance' });
    await card.getByText('Can view').waitFor();
    assert.equal(await dialog.getByText(OFF).count(), 1, 'one line says why');
    for (const control of [dialog.getByRole('button', { name: 'New folder' }), dialog.getByRole('button', { name: 'Move everything to Everyone' }), card.getByRole('combobox'), card.getByRole('switch')]) {
      assert.equal(await control.count(), 0, 'no change is offered');
    }
    await screensInPlace(page, 'folders-off-share');
    await page.keyboard.press('Escape');

    // ── Admin → Teams → Finance → Folders: the level as text, the same line ──
    await page.goto('/admin');
    await settled(page);
    await page.getByRole('tab', { name: 'Teams' }).click();
    await page.getByRole('button', { name: 'Actions for Finance' }).click();
    await page.getByRole('menuitem', { name: 'Folders…' }).click();
    const tf = page.getByRole('dialog', { name: 'Folders for Finance' });
    await tf.getByText(OFF).waitFor();
    await tf.getByText('Can view').waitFor();
    assert.equal(await tf.getByRole('combobox', { name: 'Finance on Finance' }).count(), 0, 'no level picker');
    await screensInPlace(page, 'folders-off-team');
  });
}
