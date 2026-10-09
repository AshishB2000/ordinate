// E2E (T7.1): the Docker Compose stack (deploy/docker-compose.yml) from a
// clean state — the built image, Postgres, MinIO — driven by a real browser:
//
//   sign in    password mode (the compose default) when E2E_COMPOSE_SETUP_CODE
//              is set: the first-run setup form, with the code the server
//              printed in its log, creates the admin. Otherwise header mode
//              (the Helm job): this browser context sends X-Forwarded-Email as
//              oauth2-proxy would. Either way a signed-out page redirects to /sign-in
//   project    New project from the switcher (UI)
//   import     a CSV uploaded on the import page → composer → Save (UI); its
//              table is written to MinIO through DuckDB httpfs
//   chart      New visual → builder → region × revenue → Save (UI)
//   dashboard  Create dashboard (wizard: the dataset, a blank sheet) → Visual →
//              that saved chart as a card → autosaved → reopened from the
//              dashboards list, and the card draws (canvas ink) (UI, T2.8)
//
// Every step goes through the UI. Publishing a read-only copy is T2.9's
// viewer (not on this base); an analysis is the dashboard until then.
//
// Every page fails on a console error or CSP violation and stays inside the
// RPC budget. Screens in both themes: web/e2e/__screens__/compose-*.png.
//
//   cd deploy && docker compose down -v && docker compose up -d --build --wait
//   E2E_COMPOSE_URL=http://127.0.0.1:8080 E2E_COMPOSE_EMAIL=admin@example.com \
//     E2E_COMPOSE_SETUP_CODE=$(docker compose logs ordinate | grep -o 'setup code: [A-Z0-9-]*' | head -n1 | cut -d' ' -f3) \
//     node --test web/e2e/compose.e2e.ts
//
// Without E2E_COMPOSE_URL this spec prints one skip line (the ordinary e2e run has no Docker).

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Browser, Locator, Page } from 'playwright';

const BASE = process.env.E2E_COMPOSE_URL;
const EMAIL = process.env.E2E_COMPOSE_EMAIL || 'admin@example.com';
/** Password sign-in's first-run code, from the server's log; unset = header mode. */
const SETUP_CODE = process.env.E2E_COMPOSE_SETUP_CODE;
const PASSWORD = 'compose-e2e-admin-password';

if (!BASE) {
  void test('compose e2e', { skip: 'E2E_COMPOSE_URL is unset (start deploy/docker-compose.yml and point it at the app port)' }, () => {});
} else {
  const { launchBrowser, failOnConsoleError, rpcBudget, settled, SCREENS } = await import('./fixtures.ts');
  let browser: Browser;
  before(async () => {
    browser = await launchBrowser();
  });
  after(async () => browser?.close());

  const PROJECT = `Compose check ${new Date().toISOString().slice(0, 16)}`;
  const DATASET = 'Regional sales';
  const BOARD = 'Sales overview';
  const REGIONS = ['East', 'West', 'North', 'South'];
  const CSV = ['region,month,units,revenue']
    .concat(Array.from({ length: 48 }, (_, i) => `${REGIONS[i % 4]},2026-${String(1 + Math.floor(i / 4)).padStart(2, '0')},${10 + ((i * 7) % 23)},${(1000 + ((i * 137) % 900)).toFixed(2)}`))
    .join('\n');

  /** Both themes of the page as it is now (the theme attribute flipped in place — no reload, so in-memory state survives). */
  async function shots(page: Page, name: string): Promise<void> {
    const prev = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light');
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SCREENS, `compose-${name}-${theme}.png`), fullPage: true });
    }
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), prev);
  }

  const idle = (page: Page) => page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));

  /** Pixels with any alpha on a canvas: a drawn chart has thousands, a blank one 0. */
  const canvasInk = (canvas: Locator): Promise<number> =>
    canvas.evaluate((c: HTMLCanvasElement) => {
      if (!c.width) return 0;
      const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
      return n;
    });

  void test('compose: sign in → project → import CSV → chart → dashboard', async () => {
    // ── Signed out (no session, no identity from the proxy) → the sign-in page
    const anon = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    const anonPage = await anon.newPage();
    await anonPage.goto('/data');
    assert.equal(new URL(anonPage.url()).pathname, '/sign-in', 'a signed-out navigation lands on /sign-in');
    await anon.close();

    // ── Signed in: the first-run setup form, or through the "proxy" ────────
    const proxied = SETUP_CODE ? {} : { extraHTTPHeaders: { 'x-forwarded-email': EMAIL } };
    const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, ...proxied });
    const page = await context.newPage();
    const problems = await failOnConsoleError(page);
    const rpc = rpcBudget(page);
    try {
      await page.goto('/');
      if (SETUP_CODE) {
        await page.getByRole('heading', { level: 1, name: 'Create the admin account' }).waitFor();
        await page.getByLabel('Setup code').fill(SETUP_CODE);
        await page.getByLabel('Your email').fill(EMAIL);
        await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
        await page.getByLabel('Confirm password').fill(PASSWORD);
        await page.getByRole('button', { name: /Create admin account/ }).click();
        await page.getByRole('navigation', { name: 'Sections' }).waitFor();
      }
      await settled(page);
      await page.getByRole('button', { name: 'Account and theme' }).click();
      assert.equal(await page.getByTestId('user-email').textContent(), EMAIL, 'the shell shows the signed-in admin');
      await page.keyboard.press('Escape');
      await shots(page, 'home');

      // ── Project (UI) ─────────────────────────────────────────────────────
      await page.getByTestId('project-switcher').click();
      await page.getByRole('dialog', { name: 'Projects' }).getByRole('button', { name: 'New project' }).click();
      await page.getByLabel('Project name').fill(PROJECT);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await page.getByText(`Created “${PROJECT}”.`).waitFor();
      await page.waitForFunction((n) => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes(n), PROJECT);
      // /data opens the current project — the one just created — so its id comes off the URL.
      await page.getByRole('link', { name: 'Data', exact: true }).click();
      await page.waitForURL((u) => /^\/data\/[0-9a-f-]{36}$/.test(u.pathname));
      const pid = new URL(page.url()).pathname.split('/')[2];

      // ── Import a CSV (UI) ────────────────────────────────────────────────
      await page.goto(`/data/import?project=${pid}`);
      await settled(page);
      await page.getByRole('region', { name: 'Upload a file' }).locator('input[type="file"]').setInputFiles({ name: 'regional-sales.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
      await page.getByRole('heading', { level: 1, name: 'New dataset' }).waitFor();
      await page.getByText('48 rows · 4 columns').waitFor();
      await page.getByLabel('Dataset name').fill(DATASET);
      await idle(page);
      await shots(page, 'import');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL((u) => new RegExp(`^/data/${pid}/[0-9a-f-]{36}$`).test(u.pathname));
      const ds = new URL(page.url()).pathname.split('/')[3];
      await page.getByRole('heading', { level: 1, name: DATASET }).waitFor();
      await page.getByText('48 rows · 4 columns').waitFor();
      await page.getByRole('grid').getByText('West').first().waitFor(); // rows read back from MinIO
      await idle(page);
      await shots(page, 'dataset');

      // ── A chart (UI) ─────────────────────────────────────────────────────
      await page.goto(`/visuals/${pid}`);
      await settled(page);
      // A fresh project: the designed empty state carries its own "New visual" beside the header's.
      await page.getByLabel('No visuals yet').getByRole('button', { name: 'New visual' }).click();
      const dialog = page.getByRole('dialog', { name: 'New visual' });
      await dialog.getByRole('radio', { name: new RegExp(`^${DATASET}`) }).click();
      await dialog.getByRole('button', { name: 'Open the builder' }).click();
      await page.waitForURL(/\/visuals\/[0-9a-f-]{36}\/new\?dataset=/);
      await page.getByRole('combobox', { name: 'Category' }).click();
      await page.getByRole('option', { name: 'region', exact: true }).click();
      await page.getByRole('combobox', { name: 'Measure column' }).click();
      await page.getByRole('option', { name: 'revenue', exact: true }).click();
      await page.locator('[data-chart-type] canvas').first().waitFor();
      await idle(page);
      await page.waitForTimeout(400);
      const ink = await canvasInk(page.locator('[data-chart-type] canvas').first());
      assert.ok(ink > 1000, `the chart has ink (${ink} px)`);
      await shots(page, 'chart');
      await page.getByRole('button', { name: 'Save visual' }).click();
      const named = page.getByRole('dialog', { name: 'Name this visual' });
      await named.getByLabel('Name').fill('Revenue by region');
      await named.getByRole('button', { name: 'Save' }).click();
      await page.waitForURL(new RegExp(`/visuals/${pid}$`));
      await page.getByRole('button', { name: /^Revenue by region/ }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[data-visual-id] canvas').length >= 1);
      await idle(page);
      await shots(page, 'visuals');

      // ── That visual on a dashboard (UI: T2.8's wizard and canvas) ────────
      await page.goto(`/analyses?project=${pid}`);
      await settled(page);
      // A fresh project: the designed empty state may carry its own "Create dashboard" beside the header's.
      await page.getByRole('button', { name: 'Create dashboard' }).first().click();
      const wiz = page.getByRole('dialog', { name: 'Create dashboard' });
      await wiz.getByRole('radio', { name: new RegExp(DATASET) }).click();
      await wiz.getByLabel('Dashboard name').fill(BOARD);
      await wiz.getByRole('button', { name: 'Next' }).click();
      await wiz.getByRole('radio', { name: /Blank sheet/ }).click();
      await wiz.getByRole('button', { name: 'Create dashboard' }).click();
      await page.waitForURL(new RegExp(`/analyses/${pid}/[0-9a-f-]{36}$`));
      const board = new URL(page.url()).pathname.split('/')[3];
      await page.getByRole('heading', { level: 1, name: BOARD }).waitFor();
      await page.getByRole('heading', { name: 'This sheet is empty' }).waitFor();
      await page.getByRole('group', { name: 'Add to the sheet' }).getByRole('button', { name: 'Visual' }).click();
      await page.getByRole('dialog', { name: 'Add a visual' }).getByRole('button', { name: /^Revenue by region/ }).click();
      await page.getByRole('group', { name: 'Revenue by region card' }).locator('canvas').waitFor();
      await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor(); // the autosave wrote it

      // Open it again from the dashboards list: the card draws from the server's figures.
      // (Publishing to a read-only dashboard is T2.9's viewer, not on this base.)
      await page.goto(`/analyses?project=${pid}`);
      await settled(page);
      await page.getByRole('link', { name: new RegExp(BOARD) }).click();
      await page.getByRole('heading', { level: 1, name: BOARD }).waitFor();
      const card = page.getByRole('group', { name: 'Revenue by region card' });
      await card.locator('canvas').waitFor();
      await idle(page);
      await page.waitForTimeout(400);
      const cardInk = await canvasInk(card.locator('canvas').first());
      assert.ok(cardInk > 1000, `the dashboard's visual card has ink (${cardInk} px)`);
      await shots(page, 'dashboard');

      for (const l of rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
      console.log(JSON.stringify({ projectId: pid, datasetId: ds, dashboardId: board, chartInk: ink, cardInk }));
      const found = [...problems(), ...rpc.problems()];
      assert.deepEqual(found, [], `${found.length} problem(s):\n  ${found.join('\n  ')}`);
    } finally {
      await context.close();
    }
  });
}
