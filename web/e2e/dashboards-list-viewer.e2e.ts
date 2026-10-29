// E2E: the Dashboards page as a project VIEWER reads it on a phone (375 and 414 wide), on the real server with
// Postgres (header sign-in from a trusted 127.0.0.1 peer, its own scratch database). The admin makes a project with a
// published dashboard, long-named, and a draft the viewer never sees, and a second project with nothing published,
// and grants one person Viewer on both. Then, as the viewer:
//
//   list    the published card alone, one column, its name truncated rather than widening the page, Copy link a
//           thumb's target; no tabs, nothing to create
//   empty   "Nothing published yet"
//
// Neither scrolls sideways. Screens: web/e2e/__screens__/dashboards-list-phone-viewer*.png. An editor's phone page is
// dashboards-list.e2e.ts; what a viewer can and cannot do, at desktop width, is view-only.e2e.ts.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { phoneFits, PHONE } from './phoneFits.ts';

const ADMIN = 'admin@acme.test';
const VIEWER = 'vera@acme.test';
const NAME = 'Weekly review for the regional sales leadership team';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('dashboards list, viewer on a phone', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_listviewer_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, settled, screens, configureServer } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('the Dashboards page on a phone, as a viewer: the published card, and nothing published', async ({ page, server }) => {
    // Any GET hands the context its CSRF cookie (T6.2); a non-GET repeats it in X-CSRF-Token, as the app does.
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, {
        data: { args: payload === undefined ? [] : [payload] },
        headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf },
      });
      assert.equal(r.status(), 200, `${channel} as ${as}: ${r.status()} ${await r.text()}`);
      return r.json();
    };

    // ── The admin: a project with a published dashboard (a chart, so its card has a preview) and a draft ──
    const pid: string = (await rpc(ADMIN, 'projects:create', { name: 'Shared KPIs' })).id;
    const saved = await rpc(ADMIN, 'dataset:composeSave', {
      projectId: pid,
      name: 'Orders',
      base: { inline: { name: 'Orders', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['East', 120], ['West', 80], ['North', 45]] } },
      joins: [],
      steps: [],
      sourceKind: 'paste',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const visual = await rpc(ADMIN, 'visual:save', {
      projectId: pid,
      datasetId: saved.dataset.id,
      name: 'Amount by region',
      chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
    });
    const sheets = [{ id: crypto.randomUUID(), name: 'Overview', cards: [{ id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 0, w: 12, h: 6 }, visualId: visual.visual?.id ?? visual.id }] }];
    const aid: string = (await rpc(ADMIN, 'analysis:create', { projectId: pid, name: NAME, sheets })).id;
    assert.equal((await rpc(ADMIN, 'analysis:publish', { projectId: pid, id: aid })).ok, true);
    await rpc(ADMIN, 'analysis:create', { projectId: pid, name: 'Not ready yet', sheets });
    const emptyId: string = (await rpc(ADMIN, 'projects:create', { name: 'Nothing yet' })).id;

    // ── …shared with one viewer ──
    await rpc(VIEWER, 'projects:list'); // a first header-mode request provisions the account (an org viewer)
    const targets = (await rpc(ADMIN, 'project:shareTargets', { projectId: pid })) as { users: { id: string; email: string }[] };
    const member = { userId: targets.users.find((u) => u.email === VIEWER)?.id };
    for (const projectId of [pid, emptyId]) await rpc(ADMIN, 'project:share', { projectId, member, role: 'viewer' });
    assert.deepEqual(await rpc(VIEWER, 'projects:roles'), { [pid]: 'viewer', [emptyId]: 'viewer' });

    // ── The viewer ──
    await page.setExtraHTTPHeaders({ 'x-forwarded-email': VIEWER });
    const misfits: string[] = [];

    await page.goto(`/dashboards?project=${pid}`);
    await settled(page);
    const list = page.getByRole('list', { name: 'Dashboards' });
    await list.getByRole('link', { name: new RegExp(NAME) }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Dashboards"] canvas').length >= 1);
    assert.equal(await list.getByRole('listitem').count(), 1, 'the published dashboard alone, never the draft');
    assert.equal(await page.getByRole('tab').count(), 0, 'no tabs');
    assert.equal(await page.getByRole('button', { name: 'Create dashboard' }).count(), 0, 'nothing to create');
    await phoneFits(page, misfits, 'the viewer’s list', { tap: [page.getByRole('button', { name: `Copy link to ${NAME}` })] });
    await screens(page, 'dashboards-list-phone-viewer');

    await page.goto(`/dashboards?project=${emptyId}`);
    await settled(page);
    await page.getByRole('heading', { name: 'Nothing published yet' }).waitFor();
    await phoneFits(page, misfits, 'the viewer’s empty page');
    await screens(page, 'dashboards-list-phone-viewer-empty');

    assert.deepEqual(misfits, [], misfits.join('\n'));
  }, { device: PHONE });
}
