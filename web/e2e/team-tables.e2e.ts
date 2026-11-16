// E2E (team folders E8, docs/team-folders/00-design.md "Connection tables per team"): an org admin, signed in by
// header mode against the real server on its own scratch Postgres, opens Admin → Teams → <team> → Tables for a project
// whose connection is the test harness's fake warehouse (ORDINATE_TEST_LIVE_FAKE=1, scripts/liveFakeConnector.ts):
//
//   1. The team has no role on the project: the page says its ticks give nothing. Shared, the notice goes.
//   2. Show tables lists the connection's tables on that click alone (a warehouse call); a tick, the viewers' name
//      written on the table's doc, a hidden column picked from the warehouse's own columns — each saved at once and
//      read back from the server. Both themes (admin-team-tables-*.png).
//   3. At phone width nothing scrolls sideways (admin-team-tables-phone-*.png).
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Page } from 'playwright';

const ADMIN = 'admin@acme.test';
const TABLE = 'live_fake_orders';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('team tables e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_teamtables_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, screens, screensInPlace, settled, configureServer } = await import('./fixtures.ts');
  const { PHONE, phoneFits } = await import('./phoneFits.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
      ORDINATE_TEST_LIVE_FAKE: '1',
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
    },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  /** One RPC as the admin, the way the app sends it (the CSRF cookie repeated in its header). */
  const call = async (page: Page, base: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
    await page.request.get(`${base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const r = await page.request.post(`${base}/api/rpc/${encodeURIComponent(channel)}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
    assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
    return r.json();
  };

  let world: { P: string; team: string; conn: string } | null = null;
  async function seed(page: Page, base: string) {
    if (world) return world;
    const P = (await call(page, base, 'projects:create', { name: 'Retail' })).id as string;
    assert.equal((await call(page, base, 'admin:createTeam', { name: 'Ops analysts' })).ok, true);
    const team = ((await call(page, base, 'admin:teams')) as Array<{ id: string; name: string }>).find((t) => t.name === 'Ops analysts')!.id;
    const conn = (await call(page, base, 'connection:testAndSave', { projectId: P, connectorId: 'live-fake', name: 'Warehouse', values: { fixture: 'orders' }, secrets: {} })).connection.id as string;
    const doc = await call(page, base, 'sourceTable:save', { projectId: P, connId: conn, table: TABLE, patch: {} });
    assert.equal((await call(page, base, 'sourceTable:read', { projectId: P, connId: conn, docId: doc.docId })).ok, true, 'the fake warehouse read the table\'s columns');
    world = { P, team, conn };
    return world;
  }

  async function openTables(page: Page): Promise<void> {
    await page.goto('/admin?tab=teams');
    await settled(page);
    await page.getByRole('button', { name: 'Actions for Ops analysts' }).click();
    await page.getByRole('menuitem', { name: 'Tables…' }).click();
    await page.getByRole('heading', { name: 'Ops analysts · Tables' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  }

  e2e('team tables: an admin ticks a table, names it for viewers and hides a column', async ({ page, server }) => {
    const { P, team, conn } = await seed(page, server.base);
    const asked: string[] = [];
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith('/api/rpc/')) asked.push(decodeURIComponent(p.slice('/api/rpc/'.length)));
    });

    // 1. No role on the project: the ticks would give nothing, and the page says so.
    await openTables(page);
    await page.getByRole('heading', { name: 'Ops analysts has no role on Retail' }).waitFor();
    assert.ok(new URL(page.url()).searchParams.get('team') === team, 'the team is in the address');
    assert.ok(!asked.includes('connection:listTables'), 'opening the page asks the warehouse nothing');
    await call(page, server.base, 'project:share', { projectId: P, member: { teamId: team }, role: 'viewer' });
    await page.reload();
    await page.getByRole('heading', { name: 'Ops analysts · Tables' }).waitFor();
    const card = page.getByRole('region', { name: 'Warehouse' });
    await card.getByText('Nothing ticked: this team\'s viewers ask about none of its tables').waitFor();
    assert.equal(await page.getByRole('heading', { name: /has no role on/ }).count(), 0, 'shared: the notice is gone');
    await screens(page, 'admin-team-tables-empty');

    // 2. Show tables (the warehouse, on this click), tick, name, hide.
    await card.getByRole('button', { name: 'Show tables' }).click();
    const tick = card.getByLabel(TABLE, { exact: true });
    await tick.waitFor();
    assert.ok(asked.includes('connection:listTables'));
    await tick.check();
    await card.getByText('Name it for viewers: until then they are not offered it').waitFor();
    const name = card.getByLabel(`Name ${TABLE} for viewers`);
    await name.fill('Shop orders');
    await name.press('Enter');
    await card.getByText('Viewers see it as “Shop orders”').waitFor();
    await card.getByRole('button', { name: 'Hide columns' }).click();
    const dialog = page.getByRole('dialog', { name: `Hide columns of ${TABLE}` });
    await dialog.getByLabel('region', { exact: true }).check();
    await screensInPlace(page, 'admin-team-tables-hide');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await card.getByRole('button', { name: 'Hides region' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    await screensInPlace(page, 'admin-team-tables');

    const got = await call(page, server.base, 'teamTables:get', { projectId: P, teamId: team });
    assert.deepEqual(got.rows, [{ connId: conn, schema: '', table: TABLE, include: true, hidden: ['region'] }], 'the server holds exactly the tick');
    assert.equal(got.role, 'viewer');
    const list = await call(page, server.base, 'sourceTable:list', { projectId: P });
    assert.equal(list.connections[0].rows.find((r: { table: string }) => r.table === TABLE)?.label, 'Shop orders', 'the name is on the table\'s doc');
  });

  e2e('team tables: the screen at phone width', async ({ page, server }) => {
    await seed(page, server.base);
    await openTables(page);
    await page.getByRole('region', { name: 'Warehouse' }).getByRole('button', { name: 'Show tables' }).click();
    await page.getByLabel(TABLE, { exact: true }).waitFor();
    const misfits: string[] = [];
    await phoneFits(page, misfits, 'the Tables screen');
    assert.deepEqual(misfits, []);
    await screensInPlace(page, 'admin-team-tables-phone');
  }, { device: PHONE });
}
