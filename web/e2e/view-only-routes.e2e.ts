// E2E: the viewer WALK — every route a project viewer can open (viewerRoutes.ts),
// on the real server with Postgres and header sign-in, over one project seeded
// with something on each screen (seed-viewer.ts).
//
//   (a) the route listing    every route in routes.tsx is walked or skipped with
//                            a reason, and a planted route is caught. Needs no
//                            Postgres: it is what CI's web job runs.
//   (b) the viewer           on every route: zero write controls (WRITE, less the
//                            route's exploration names), zero editable fields in
//                            the surfaces that hold stored values, zero RPCs to a
//                            write contract, no view-only toast.
//   (c) the editor           the negative controls: each route's editor control is
//                            there and its write controls are counted, Description
//                            is editable in the Details popover, a write is
//                            recorded; the admin's Home has Get started and Set up.
//
// Screens of the viewer's Home, Prepare, a story, a scorecard and a metric tree,
// both themes, go to web/e2e/__screens__/view-only-routes-*.png.
//
// The walk needs Postgres (roles): without DATABASE_URL, (b) and (c) print one
// skip line. WALK_DISCOVER=1 prints each route's write controls instead of asserting.

import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Page, Request } from 'playwright';
import { details, editableFields, ROUTES, uncovered, WRITE, writeChannels, writeControls, type RouteCase } from './viewerRoutes.ts';
import { seedViewer, type ViewerSeed } from './seed-viewer.ts';

const ROUTES_SRC = readFileSync(new URL('../src/app/routes.tsx', import.meta.url), 'utf8');

void test('view-only routes: every route is walked or skipped, and a planted one is caught', () => {
  assert.deepEqual(uncovered(ROUTES_SRC), []);
  const planted = `${ROUTES_SRC}\n  page('/planted/:projectId', () => import('../features/home/HomePage')),\n`;
  assert.deepEqual(uncovered(planted), ['/planted/:projectId'], 'a route nobody listed fails the spec');
});

const ADMIN = 'admin@acme.test';
const VIEWER = 'vera@acme.test';
const EDITOR = 'eddie@acme.test';
const adminUrl = process.env.DATABASE_URL;
const DISCOVER = process.env.WALK_DISCOVER === '1';
const VIEW_ONLY = /view-only access to this project\. Ask a project admin to make you an editor/;
const OSM = /^https:\/\/[abc]\.tile\.openstreetmap\.org\//;


if (!adminUrl) {
  void test('view-only routes: the walk', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_viewwalk_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, settled, screens, configureServer, withLiveDataset, tilePng } = await import('./fixtures.ts');
  const TILE = tilePng([226, 232, 236]); // every map tile, offline: the walk reads controls, not maps
  withLiveDataset(); // the fake warehouse answers the walk's Live dataset
  configureServer({ env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN } });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const WRITES = writeChannels();
  const SHOTS: Record<string, string> = {
    '/': 'home',
    '/data/:projectId/:datasetId/prepare': 'prepare',
    '/stories/:projectId/:storyId': 'story',
    '/scorecards/:projectId/:scorecardId': 'scorecard',
    '/data/metrics/:projectId/:metricId/tree': 'tree',
  };

  /**
   * RPCs in flight, so a check waits until the page has stopped asking (roles, then what they unlock). A request open
   * for 8 s is left behind: one the app abandoned mid-redirect can go unreported by the browser, and waiting on it
   * would hang the walk; nothing that slow decides which controls a screen draws.
   */
  function watch(page: Page) {
    const inflight = new Map<Request, number>();
    const sent: string[] = [];
    const channel = (url: string) => decodeURIComponent(/\/api\/rpc\/([^?]+)/.exec(url)?.[1] ?? '');
    page.on('request', (r) => {
      const c = channel(r.url());
      if (!c) return;
      inflight.set(r, Date.now());
      sent.push(c);
    });
    page.on('requestfinished', (r) => inflight.delete(r));
    page.on('requestfailed', (r) => inflight.delete(r));
    const open = () => [...inflight.values()].filter((at) => Date.now() - at < 8_000).length;
    return {
      sent,
      /** Quiet: no RPC open for 600 ms. */
      async quiet() {
        for (let still = 0; still < 4; ) {
          await page.waitForTimeout(150);
          still = open() === 0 ? still + 1 : 0;
        }
      },
    };
  }

  async function visit(page: Page, net: ReturnType<typeof watch>, r: RouteCase, s: ViewerSeed) {
    await page.goto(r.url(s));
    await settled(page);
    await net.quiet();
  }

  let seed: ViewerSeed;
  const rpcAs = (page: Page, base: string, csrf: string) => async (as: string, channel: string, payload?: unknown) => {
    const r = await page.request.post(`${base}/api/rpc/${channel}`, {
      data: { args: payload === undefined ? [] : [payload] },
      headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf },
    });
    assert.equal(r.status(), 200, `${channel} as ${as}: ${r.status()} ${await r.text()}`);
    return r.json();
  };

  e2e('view-only routes: a viewer is offered nothing that writes, anywhere; an editor is', async ({ page, server }) => {
    // Who is signed in rides on this origin's requests only: a header added to every request (setExtraHTTPHeaders)
    // would go to the map tiles too, and fail their CORS preflight. The tiles are answered here, offline.
    let who = ADMIN;
    await page.route((u) => u.origin === server.base, (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-email': who } }));
    await page.route(OSM, (route) => route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE }));
    await page.request.get(`${server.base}/api/auth/me`, { headers: { 'x-forwarded-email': ADMIN } });
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    seed = await seedViewer(rpcAs(page, server.base, csrf), ADMIN, { viewer: VIEWER, editor: EDITOR });
    const control = (r: RouteCase) => page.getByRole(r.editor!.role, { name: r.editor!.name, exact: typeof r.editor!.name === 'string' });

    // ── (b) the viewer ─────────────────────────────────────────────────────
    who = VIEWER;
    const net = watch(page);
    const found: string[] = [];
    for (const r of ROUTES) {
      const at = `${r.pattern} (${r.url(seed)})`;
      await visit(page, net, r, seed);
      const scope = r.open ? await r.open(page) : undefined;
      await net.quiet();
      const controls = await writeControls(page, r.explore);
      const fields = scope ? await editableFields(scope) : [];
      const editorOnly = r.editor ? await control(r).count() : 0;
      if (DISCOVER) {
        if (controls.length || fields.length || editorOnly) found.push(`VIEWER ${at}\n    controls: ${controls.join(', ')}\n    fields: ${fields.join(', ')}\n    editor control: ${editorOnly}`);
      } else {
        assert.deepEqual(controls, [], `${at}: a viewer is offered a write`);
        assert.deepEqual(fields, [], `${at}: a viewer can edit a stored value`);
        assert.equal(editorOnly, 0, `${at}: a viewer sees the editor's “${String(r.editor?.name)}”`);
      }
      assert.equal(await page.getByText(VIEW_ONLY).count(), 0, `${at}: a view-only refusal`);
      if (scope) await page.keyboard.press('Escape');
      if (SHOTS[r.pattern] && !DISCOVER) await screens(page, `view-only-routes-${SHOTS[r.pattern]}`);
    }
    const wrote = net.sent.filter((c) => WRITES.has(c));
    if (DISCOVER) found.push(`VIEWER writes: ${wrote.join(', ')}`);
    else assert.deepEqual(wrote, [], 'a viewer’s walk sent no write');

    // ── (c) the editor: the negative controls ──────────────────────────────
    who = EDITOR;
    const sentBefore = net.sent.length;
    for (const r of ROUTES) {
      const at = `${r.pattern} (${r.url(seed)})`;
      await visit(page, net, r, seed);
      const scope = r.open ? await r.open(page) : undefined;
      await net.quiet();
      const controls = await writeControls(page, r.explore);
      const fields = scope ? await editableFields(scope) : [];
      if (DISCOVER) {
        found.push(`EDITOR ${at} editor-control=${r.editor ? await control(r).count() : '-'}\n    controls: ${controls.join(', ')}\n    fields: ${fields.join(', ')}`);
      } else if (r.editor) {
        await control(r).first().waitFor();
        // Where the editor's control is a write by name, the detector must count it here (it is not blind on this page).
        if (typeof r.editor.name === 'string' && WRITE.test(r.editor.name)) assert.ok(controls.length > 0, `${at}: the editor's write controls are counted`);
      }
      if (scope && !DISCOVER) assert.ok(fields.length > 0, `${at}: the stored values are editable for an editor (negative control)`);
      if (scope && r.open === details) {
        assert.ok(fields.includes('Description'), `${at}: Description is editable in the Details popover: ${fields.join(', ')}`);
        // A known write, recorded the way the viewer's would have been: the editor documents the dataset.
        await scope.getByRole('textbox', { name: 'Description' }).fill('Orders, one row per line item.');
      }
      if (scope) {
        await page.keyboard.press('Escape');
        await net.quiet();
      }
    }
    const editorWrites = net.sent.slice(sentBefore).filter((c) => WRITES.has(c));
    assert.ok(WRITES.size > 100, `the write set is the contracts' (${WRITES.size})`);
    assert.ok(editorWrites.includes('catalog:set'), `an editor's write is recorded: ${editorWrites.join(', ')}`);
    who = ADMIN;

    // The org admin's Home: the checklist, with the Assistant's "Set up".
    await page.goto(`/?project=${seed.pid}`);
    await settled(page);
    const card = page.getByRole('region', { name: 'Get started' });
    await card.getByRole('link', { name: 'Set up' }).waitFor();
    if (DISCOVER) console.log(`\n===== WALK DISCOVERY =====\n${found.join('\n')}\n===== END =====\n`);
  });
}
