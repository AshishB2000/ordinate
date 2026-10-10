// E2E: what a project VIEWER sees, on the real server with Postgres (header
// sign-in from a trusted 127.0.0.1 peer, its own scratch database). The admin
// makes a project with a dataset, a visual and a dashboard over RPC, and grants
// one person Viewer and another Editor. Then, signed in as each:
//
//   the viewer   Home, Data, a dataset, Visuals, the builder, Analyses, the
//                open dashboard and Dashboards show NO control that changes
//                the project — and the dashboard still draws its tiles, its
//                figure from the server, and takes no edit from the keyboard.
//                Not one call is refused on the way (a 403 is a console error,
//                which the harness fails on): nothing writes behind their back.
//   the editor   the same pages have every one of those controls — the
//                negative control: the checks above are not passing on a page
//                that simply failed to draw.
//
// Screens of the viewer's Home and dashboard, both themes, go to
// web/e2e/__screens__/view-only-*.png.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Page } from 'playwright';

const ADMIN = 'admin@acme.test';
const VIEWER = 'vera@acme.test';
const EDITOR = 'eddie@acme.test';
const PROJECT = 'Shared KPIs';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('view-only e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_viewonly_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, settled, screens, configureServer, SCREENS } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  /** Is the control there? Roles arrive after the page: a present control is waited for, an absent one is counted once the page has settled. */
  const count = (page: Page, role: 'button' | 'link' | 'group', name: string | RegExp) => page.getByRole(role, { name, exact: typeof name === 'string' }).count();

  e2e('view-only: a viewer reads everything and is offered nothing that changes it; an editor is', async ({ page, server }) => {
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

    // ── The admin builds the project (records live in Postgres here) ──────
    const project = await rpc(ADMIN, 'projects:create', { name: PROJECT });
    const pid: string = project.id;
    const saved = await rpc(ADMIN, 'dataset:composeSave', {
      projectId: pid,
      name: 'Orders',
      base: {
        inline: {
          name: 'Orders',
          columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
          rows: [['East', 120], ['West', 80], ['North', 45], ['East', 30]],
        },
      },
      joins: [],
      steps: [],
      sourceKind: 'paste',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const did: string = saved.dataset.id;
    const visual = await rpc(ADMIN, 'visual:save', {
      projectId: pid,
      datasetId: did,
      name: 'Amount by region',
      chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
    });
    const vid: string = visual.visual?.id ?? visual.id;
    assert.match(vid, /^[0-9a-f-]{36}$/, JSON.stringify(visual));
    const dash = await rpc(ADMIN, 'analysis:create', {
      projectId: pid,
      name: 'Weekly review',
      sheets: [
        {
          id: crypto.randomUUID(),
          name: 'Overview',
          cards: [
            { id: crypto.randomUUID(), type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: did, column: 'amount', aggregation: 'sum', label: 'Revenue' } },
            { id: crypto.randomUUID(), type: 'text', layout: { x: 3, y: 0, w: 9, h: 2 }, heading: 'This week', text: 'All on track.' },
            { id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 2, w: 12, h: 6 }, visualId: vid },
          ],
        },
      ],
    });
    const aid: string = dash.id;
    assert.match(aid, /^[0-9a-f-]{36}$/, JSON.stringify(dash));

    // ── …and shares it: one viewer, one editor ────────────────────────────
    await rpc(VIEWER, 'projects:list'); // a first header-mode request provisions the account (an org viewer)
    await rpc(EDITOR, 'projects:list');
    const targets = (await rpc(ADMIN, 'project:shareTargets', { projectId: pid })) as { users: { id: string; email: string }[] };
    const userId = (email: string) => targets.users.find((u) => u.email === email)?.id;
    await rpc(ADMIN, 'project:share', { projectId: pid, member: { userId: userId(VIEWER) }, role: 'viewer' });
    await rpc(ADMIN, 'project:share', { projectId: pid, member: { userId: userId(EDITOR) }, role: 'editor' });
    assert.deepEqual(await rpc(VIEWER, 'projects:roles'), { [pid]: 'viewer' });
    assert.deepEqual(await rpc(EDITOR, 'projects:roles'), { [pid]: 'editor' });

    // Every write the browser sends while someone is signed in (the dashboard's autosave above all).
    const writes: string[] = [];
    page.on('request', (r) => {
      const m = /\/api\/rpc\/([^?]+)/.exec(r.url());
      if (m && /^(analysis:(update|rename|delete|create)|visual:(save|update|delete)|dataset:(update|delete|refresh)|format:colors:assign|alerts:)/.test(decodeURIComponent(m[1]!))) writes.push(decodeURIComponent(m[1]!));
    });
    const open = async (path: string) => {
      await page.goto(path);
      await settled(page);
    };
    const tiles = async () => {
      await page.getByRole('heading', { level: 1, name: 'Weekly review' }).waitFor();
      const kpi = page.getByRole('group', { name: 'Revenue card' });
      await kpi.getByText('275').waitFor(); // 120 + 80 + 45 + 30, summed by the server
      await page.getByRole('group', { name: 'This week card' }).getByText('All on track.').waitFor();
      await page.getByRole('group', { name: 'Amount by region card' }).locator('canvas').first().waitFor();
      return kpi;
    };

    // ── The viewer ────────────────────────────────────────────────────────
    await page.setExtraHTTPHeaders({ 'x-forwarded-email': VIEWER });

    await open(`/?project=${pid}`);
    await page.getByTestId('home-sub').getByText(PROJECT).waitFor();
    await page.getByRole('region', { name: 'Recent', exact: true }).getByRole('link', { name: /^Orders, Dataset/ }).waitFor();
    await page.getByPlaceholder('Ask about your data…').waitFor(); // asking is anyone's
    assert.equal(await count(page, 'button', 'New'), 0, 'Home: no New menu');
    assert.equal(await count(page, 'link', 'Bring in some data'), 0);
    assert.equal(await count(page, 'button', 'Save as visual'), 0);
    await screens(page, 'view-only-home');

    await open(`/data/${pid}`);
    const row = page.getByRole('row', { name: /Orders/ });
    await row.getByText('4 rows').waitFor();
    await page.getByRole('link', { name: 'Metrics' }).waitFor();
    assert.equal(await count(page, 'link', 'Import file'), 0, 'Data: no Import file');
    assert.equal(await count(page, 'link', 'Paste data'), 0);
    assert.equal(await count(page, 'button', 'Move Orders to the Trash'), 0);
    assert.equal(await count(page, 'link', 'New visual'), 0);

    await open(`/data/${pid}/${did}`);
    await page.getByRole('heading', { level: 1, name: 'Orders' }).waitFor();
    await page.getByRole('button', { name: 'Details' }).waitFor();
    assert.equal(await count(page, 'link', 'Prepare'), 0, 'dataset: no Prepare');
    assert.equal(await count(page, 'link', 'New visual'), 0);
    assert.equal(await count(page, 'link', 'New dashboard'), 0);
    await page.getByRole('button', { name: 'More dataset actions' }).click();
    assert.deepEqual((await page.getByRole('menuitem').allTextContents()).map((t) => t.trim()), ['Lineage', 'Pipeline history'], 'dataset ⋯: nothing that changes it');
    await page.keyboard.press('Escape');

    await open(`/visuals/${pid}`);
    await page.getByRole('button', { name: /^Amount by region/ }).waitFor();
    await page.getByText('1 visual', { exact: true }).waitFor();
    assert.equal(await count(page, 'button', 'New visual'), 0, 'Visuals: no New visual');
    assert.equal(await count(page, 'button', 'Favourite Amount by region'), 0);

    await open(`/visuals/${pid}/${vid}`);
    await page.getByText('View only', { exact: true }).waitFor();
    await page.locator('canvas').first().waitFor();
    assert.equal(await count(page, 'button', 'Save visual'), 0, 'builder: no Save visual');

    await open(`/analyses?project=${pid}`);
    await page.getByRole('list', { name: 'Dashboards' }).getByText('Weekly review').waitFor();
    await page.getByRole('link', { name: 'Metrics' }).waitFor();
    assert.equal(await count(page, 'button', 'Create dashboard'), 0, 'Analyses: no Create dashboard');

    await open(`/analyses/${pid}/${aid}`);
    const kpi = await tiles();
    await page.getByText('View only', { exact: true }).waitFor();
    assert.equal(await count(page, 'group', 'Add to the sheet'), 0, 'editor: no add row');
    for (const name of ['Add sheet', 'Card properties', 'Nothing to undo', 'Nothing to redo', 'Revenue card actions']) assert.equal(await count(page, 'button', name), 0, `editor: no “${name}”`);
    assert.equal(await count(page, 'link', 'Edit'), 0, 'editor: no tile Edit');
    assert.equal(await page.getByRole('navigation', { name: 'Authoring panels' }).count(), 0, 'editor: no tool rail');
    // What reads stays: the sheet tab, Present, comments, the tile's own read-only menu.
    await page.getByRole('tab', { name: 'Overview' }).waitFor();
    await page.getByRole('button', { name: 'Present' }).waitFor();
    await page.getByRole('button', { name: 'Comments on this dashboard' }).waitFor();
    await page.getByRole('button', { name: 'Amount by region card actions' }).click();
    const items = (await page.getByRole('menuitem').allTextContents()).map((t) => t.trim());
    assert.ok(items.includes('View as table') && items.includes('Show the rows'), `the tile's reading menu: ${items.join(', ')}`);
    assert.ok(!items.some((t) => /Remove|Wider|Properties/.test(t)), `no edit in the tile menu: ${items.join(', ')}`);
    await page.keyboard.press('Escape');
    // The keyboard moves nothing, and nothing is written.
    const before = await kpi.boundingBox();
    await kpi.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await page.waitForTimeout(1200); // past the 600 ms autosave debounce
    assert.deepEqual(await kpi.boundingBox(), before, 'the card did not move');
    await screens(page, 'view-only-analysis');
    await tiles();
    // Click-to-filter is a READER's: a viewer's click on a bar filters the other cards for them alone — the KPI is
    // recomputed by the server (a read), the chip says what is on, Esc clears it, and nothing is written (`writes`, below).
    const chips = page.getByRole('group', { name: 'Click filters' });
    await chips.getByText('Click a mark on a chart to filter the other cards.').waitFor(); // a viewer is told, too
    const chip = chips.getByRole('button', { name: /^Remove click filter region: (East|West|North)$/ });
    const bars =(await page.getByRole('group', { name: 'Amount by region card' }).locator('canvas').first().boundingBox())!;
    let hit = false;
    for (let c = 1; c <= 14 && !hit; c++) {
      await page.mouse.click(bars.x + (bars.width * c) / 15, bars.y + bars.height * 0.8);
      await page.waitForTimeout(150);
      hit = (await chip.count()) > 0;
    }
    assert.ok(hit, 'a viewer’s click on a bar puts its region in the chip row');
    await kpi.getByText('275').waitFor({ state: 'detached' }); // one region's amount now, summed by the server
    // In place: `screens` reloads, and a reload forgets a click-filter (it is view state).
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SCREENS}view-only-clickfilter-${theme}.png`, fullPage: true });
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.keyboard.press('Escape');
    await chip.waitFor({ state: 'detached' });
    await tiles();

    await open(`/dashboards?project=${pid}`);
    await page.getByRole('heading', { name: 'Nothing published yet' }).waitFor();
    await page.getByText(/An editor of this project can publish/).waitFor();
    assert.equal(await count(page, 'button', 'Publish…'), 0, 'Dashboards: no Publish…');
    assert.equal(await count(page, 'button', 'Publish a dashboard'), 0);

    assert.deepEqual(writes, [], 'a viewer’s visit sent no write');
    assert.equal(await page.getByText(/view-only access to this project\. Ask a project admin to make you an editor/).count(), 0, 'and met no refusal');

    // ── The editor: the same pages, with the controls (negative control) ──
    await page.setExtraHTTPHeaders({ 'x-forwarded-email': EDITOR });

    await open(`/?project=${pid}`);
    await page.getByRole('button', { name: 'New', exact: true }).waitFor();
    await page.getByRole('link', { name: 'CSV / Excel' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Paste data' }).getAttribute('href'), `/data/import?project=${pid}&source=paste`);

    await open(`/data/${pid}`);
    await page.getByRole('link', { name: 'Import file' }).waitFor();
    await page.getByRole('button', { name: 'Move Orders to the Trash' }).waitFor();

    await open(`/data/${pid}/${did}`);
    await page.getByRole('link', { name: 'Prepare' }).waitFor();
    await page.getByRole('link', { name: 'New dashboard' }).waitFor();
    await page.getByRole('button', { name: 'More dataset actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to Trash' }).waitFor();
    await page.keyboard.press('Escape');

    await open(`/visuals/${pid}`);
    await page.getByRole('button', { name: 'New visual' }).waitFor();
    await open(`/visuals/${pid}/${vid}`);
    await page.getByRole('button', { name: 'Save visual' }).waitFor();

    await open(`/analyses?project=${pid}`);
    await page.getByRole('button', { name: 'Create dashboard' }).waitFor();

    await open(`/analyses/${pid}/${aid}`);
    await tiles();
    await page.getByRole('group', { name: 'Add to the sheet' }).getByRole('button', { name: 'KPI' }).waitFor();
    await page.getByRole('button', { name: 'Add sheet' }).waitFor();
    await page.getByRole('navigation', { name: 'Authoring panels' }).waitFor();
    await page.getByRole('button', { name: 'Nothing to undo' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Card properties' }).count(), 3, 'every card has its Properties');
    await page.getByRole('group', { name: 'Amount by region card' }).getByRole('link', { name: 'Edit' }).waitFor();
    assert.equal(await page.getByText('View only', { exact: true }).count(), 0);

    await open(`/dashboards?project=${pid}`);
    await page.getByRole('button', { name: 'Publish…' }).waitFor();
  });
}
