// The Data section (T2.3) against the real server and the seeded sample
// project plus a small fixture (seedData.ts): "Regions", a lookup to relate
// Retail orders to, and "Feed", whose origin and stored refresh error hold a
// planted API key.
//
//   1. The list: every dataset, the source and freshness cells, the failed
//      refresh's reason cut to the host; a 5-minute incremental schedule that
//      runs behind it, and the fast cadences greyed out where incremental
//      refresh is off (L0.3); search inside the data → Open filtered.
//   2. The dataset page: the filter banner, sort and hide from a column menu,
//      the column profile (server figures), the lineage drawer.
//   3. Quality: add a rule with its live preview, run the checks, show the
//      failing rows. Columns: a description saved in place.
//   4. Catalog: details saved from the popover; Relationships: a relationship
//      from the suggested key, drawn and listed with its match rate.
//   5. Empty states (a new project) and the import placeholder.
//   Throughout: NO reply the browser receives carries the planted key.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled, type Session } from './fixtures.ts';

const CANARY = 'k3y-E2E-CANARY-91c4';
const SEED = fileURLToPath(new URL('./seedData.ts', import.meta.url));
type Seeded = { regionsId: string; feedId: string; liveId: string; snapshotId: string };
let seeded: Seeded | undefined;

function seed(s: Session): Seeded {
  if (seeded) return seeded;
  const r = spawnSync(process.execPath, [SEED, s.server.dataDir, s.server.sample.projectId, CANARY], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`seedData failed:\n${r.stderr || r.stdout}`);
  seeded = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Seeded;
  return seeded;
}

/** Every RPC reply body the page receives, for the canary check. */
function replies(page: Page): string[] {
  const bodies: string[] = [];
  page.on('response', (res) => {
    if (!new URL(res.url()).pathname.startsWith('/api/')) return;
    void res.text().then((t) => bodies.push(`${res.url()} ${t}`), () => undefined);
  });
  return bodies;
}

/** The grid has drawn rows (not its loading skeleton), and no block is in flight. */
async function rowsDrawn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const g = document.querySelector('[role="grid"]');
    return !!g && g.getAttribute('aria-busy') !== 'true' && !!g.querySelector('[role="gridcell"]')?.textContent;
  });
}

/** The distinct values the grid draws in one column (1-based aria-colindex). */
const drawnValues = (page: Page, col: number) =>
  page.$$eval(`[role="gridcell"][aria-colindex="${col}"]`, (cells) => [...new Set(cells.map((c) => c.textContent))]);

/**
 * The loading skeleton in both themes: `channel` is held unanswered while each
 * theme loads, so the shot is of the skeleton (screens() waits it out).
 */
async function loadingShots(page: Page, url: string, channel: string, label: string, name: string): Promise<void> {
  const held = `**/api/rpc/${encodeURIComponent(channel)}`;
  await page.route(held, () => undefined); // never answered
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
    await page.goto(url);
    await page.getByRole('status', { name: label }).waitFor();
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.unroute(held);
  await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
}

/** A dialog in both themes: each theme loads the page, opens it (`open`), and shoots the page. */
async function dialogShots(page: Page, open: () => Promise<unknown>, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
    await page.reload();
    await settled(page);
    await open();
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
  await page.reload();
  await settled(page);
}

const noCanary = (bodies: string[]) => {
  const leaks = bodies.filter((b) => b.includes(CANARY));
  assert.equal(leaks.length, 0, `the planted key reached the browser:\n${leaks.map((l) => l.slice(0, 200)).join('\n')}`);
};

e2e('the Data section: list, search, dataset page, quality, columns, catalog, relationships', async (s) => {
  const { page } = s;
  const ids = seed(s);
  const pid = s.server.sample.projectId;
  const bodies = replies(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // ── 1. The list ─────────────────────────────────────────────────────────
  await page.goto('/data');
  await page.waitForURL(`**/data/${pid}`);
  await settled(page);
  const table = page.getByRole('table');
  for (const name of ['Retail orders', 'Regions', 'Feed']) await table.getByRole('link', { name, exact: true }).waitFor();
  const feedRow = table.getByRole('row').filter({ hasText: 'Feed' });
  assert.equal(await feedRow.getByRole('img', { name: 'Last refresh failed' }).count(), 1, 'the failed refresh shows its dot');
  const reason = await feedRow.locator('[title*="Could not fetch"]').getAttribute('title');
  assert.equal(reason, 'Could not fetch https://api.example.com: 401 Unauthorized', 'the reason is shown, cut to the host');
  assert.equal(await feedRow.getByRole('combobox', { name: 'Auto-refresh Feed' }).count(), 1, 'a refreshable dataset offers a schedule');
  // Every 5 minutes, incrementally — and its last run took 7: the server says it is behind.
  const liveRow = table.getByRole('row').filter({ hasText: 'Live orders' });
  await liveRow.getByText(/^Refreshes every 5 minutes · last/).waitFor();
  assert.equal(await liveRow.getByText('Behind schedule').count(), 1, 'a run longer than its cadence shows "Behind schedule"');
  assert.equal(await feedRow.getByText('Behind schedule').count(), 0, 'one that never ran late does not');
  await screens(page, 'data-list');
  // A URL dataset cannot refresh incrementally: the fast cadences are there, greyed, saying why.
  await feedRow.getByRole('combobox', { name: 'Auto-refresh Feed' }).click();
  const fast = page.getByRole('option', { name: /^Every 5 minutes/ });
  assert.equal(await fast.getAttribute('aria-disabled'), 'true', 'no 5-minute schedule without incremental refresh');
  assert.match((await fast.textContent()) ?? '', /needs incremental refresh/);
  await page.keyboard.press('Escape');
  await liveRow.getByRole('combobox', { name: 'Auto-refresh Live orders' }).click();
  assert.equal(await page.getByRole('option', { name: /^Every 15 minutes$/ }).getAttribute('aria-disabled'), null, 'incremental: the fast cadences are offered');
  await page.keyboard.press('Escape');

  // Search inside the data → open the dataset filtered to the value.
  await page.getByRole('searchbox', { name: /Search values/ }).fill('Furniture');
  const hit = page.getByRole('region', { name: 'Values found' }).getByRole('listitem').filter({ hasText: 'Retail orders / category' });
  await hit.waitFor();
  await hit.getByRole('link', { name: 'Open filtered' }).click();
  await page.waitForURL(/where=category&is=Furniture/);
  await settled(page);
  await page.getByRole('status').filter({ hasText: 'Showing rows where category is Furniture' }).waitFor();
  await rowsDrawn(page);
  const cats = await drawnValues(page, 4);
  assert.deepEqual(cats, ['Furniture'], 'every drawn row is in the filter');

  // ── 2. The dataset page ─────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('heading', { level: 1, name: 'Retail orders' }).waitFor();
  // Sort from a column's menu: the request carries it and the arrow shows.
  const sortReq = page.waitForRequest((r) => r.url().endsWith('/api/rpc/dataset%3Apage') && (r.postData() ?? '').includes('"sortDir":"desc"'));
  await rowsDrawn(page);
  const units = page.getByRole('columnheader').filter({ hasText: /^units/ });
  await units.click(); // a header opens its column's menu (DataGrid onHeaderActivate)
  await page.getByRole('dialog', { name: 'Column units' }).getByRole('button', { name: 'Sort descending' }).click();
  await sortReq;
  await page.getByRole('button', { name: /Sorted by units/ }).waitFor();
  // Hide a column: it stops being drawn.
  assert.equal(await page.getByRole('columnheader').filter({ hasText: 'state' }).count(), 1);
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('checkbox', { name: 'state' }).uncheck();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('columnheader').filter({ hasText: 'state' }).count(), 0, 'a hidden column is not drawn');
  // The column profile: the server's figures, a 20-bucket histogram for a number.
  await units.click();
  await page.getByRole('dialog', { name: 'Column units' }).getByRole('button', { name: 'Profile this column' }).click();
  const panel = page.getByRole('complementary', { name: 'units' });
  await panel.getByText('Filled').waitFor();
  assert.match((await panel.locator('dd').first().textContent()) ?? '', /^5,000 of 5,000 \(100%\)$/);
  assert.equal(await panel.getByRole('img', { name: /Histogram of 20 buckets/ }).count(), 1);
  await screens(page, 'dataset-page');
  // Lineage: what is built on it.
  await page.getByRole('button', { name: /^Used in/ }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('group', { name: 'Lineage graph' }).waitFor();
  assert.ok((await drawer.getByRole('link').count()) > 1, 'lineage cards that open their records');
  await page.keyboard.press('Escape');

  // ── 3. Quality: a rule with its live preview, run, failing rows ──────────
  await page.getByRole('tab', { name: /Quality/ }).click();
  await page.getByRole('heading', { name: 'Rules', exact: true }).waitFor();
  await page.getByText('No issues found in this dataset.').or(page.locator('table[aria-label="Completeness of every column"]')).first().waitFor();
  await page.getByRole('button', { name: 'Add rule' }).first().click();
  const editor = page.getByRole('dialog', { name: 'Add rule' });
  await editor.getByRole('radio', { name: /Allowed values/ }).click();
  await editor.getByRole('combobox', { name: 'Column' }).click();
  await page.getByRole('option', { name: 'region · text' }).click();
  // Prefilled from the column's distinct values; take one away so rows fail.
  const box = editor.getByRole('textbox', { name: 'Allowed values' });
  await assert.doesNotReject(box.waitFor());
  await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value ?? '').includes('West'));
  await box.fill('East\nCentral\nSouth\nNortheast');
  await editor.getByRole('status').filter({ hasText: /Would fail now: 1,515 rows/ }).waitFor();
  await editor.getByRole('button', { name: 'Add rule' }).click();
  const ruleRow = page.locator('tr[data-rule-id]');
  await ruleRow.filter({ hasText: 'region is one of' }).waitFor();
  await ruleRow.getByText('1,515 rows').waitFor();
  await page.getByRole('button', { name: 'Run checks' }).click();
  await page.getByText(/checked just now/).waitFor();
  await screens(page, 'dataset-quality');
  await ruleRow.getByRole('button', { name: 'Show failing rows' }).click();
  await page.getByRole('status').filter({ hasText: 'Showing the rows that fail' }).waitFor();
  await rowsDrawn(page);
  const regions = await drawnValues(page, 2);
  assert.deepEqual(regions, ['West'], 'the failing rows are exactly the West ones');

  // Columns: a description saved in place, then shown in the header tooltip.
  await page.getByRole('tab', { name: 'Columns' }).click();
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/rpc/catalog%3AsetColumn') && r.status() === 200);
  await page.getByRole('textbox', { name: 'Description of region' }).fill('Sales region the order shipped to');
  await page.keyboard.press('Enter');
  await saved;

  // ── 4. Catalog and relationships ────────────────────────────────────────
  await page.goto(`/data/${pid}?tab=catalog`);
  await settled(page);
  const catalog = page.getByRole('table');
  await catalog.getByRole('link', { name: 'Open Dataset Regions' }).waitFor();
  await catalog.getByRole('row').filter({ hasText: 'Regions' }).getByRole('button', { name: 'Details for Regions' }).click();
  const pop = page.getByRole('dialog', { name: 'Dataset details' });
  const doc = page.waitForResponse((r) => r.url().endsWith('/api/rpc/catalog%3Aset') && r.status() === 200);
  await pop.getByRole('textbox', { name: 'Description' }).fill('One row per sales region, with its manager');
  await pop.getByRole('textbox', { name: 'Owner' }).click();
  await doc;
  await page.keyboard.press('Escape');
  await catalog.getByText('One row per sales region, with its manager').waitFor();
  await screens(page, 'data-catalog');

  await page.getByRole('tab', { name: 'Relationships' }).click();
  await page.getByRole('group', { name: 'Data model diagram' }).waitFor();
  await page.getByRole('button', { name: 'New relationship' }).click();
  const dlg = page.getByRole('dialog', { name: 'New relationship' });
  await dlg.getByRole('combobox', { name: 'Many side' }).click();
  await page.getByRole('option', { name: 'Retail orders' }).click();
  await dlg.getByRole('combobox', { name: 'One side' }).click();
  await page.getByRole('option', { name: 'Regions' }).click();
  await dlg.getByRole('radio', { name: /region → region/ }).waitFor();
  assert.equal(await dlg.getByRole('radio', { name: /region → region/ }).getAttribute('aria-checked'), 'true', 'the best key arrives selected');
  await dlg.getByRole('button', { name: 'Save relationship' }).click();
  const relRow = page.getByRole('table').getByRole('row').filter({ hasText: 'Many to one' });
  await relRow.waitFor();
  assert.match((await relRow.textContent()) ?? '', /4,585 \(91\.7%\)415$/, 'matched rows, the server\'s rate, and the unmatched (Northeast)');
  await page.getByRole('button', { name: /many to one, 91\.7% matched/ }).waitFor();
  await screens(page, 'data-relationships');

  noCanary(bodies);
  void ids;
});

// Fresh on ask (L3.1) beside the schedule on the dataset page: offered where incremental refresh is
// on, set and turned off again through dataset:update; disabled, saying why, where it is not — until
// the Incremental refresh panel turns incremental refresh on, and the 5-minute schedule and fresh on
// ask are picked there.
e2e('fresh on ask and incremental refresh: set them beside the schedule, and see why they are off', async (s) => {
  const { page } = s;
  const ids = seed(s);
  const pid = s.server.sample.projectId;
  const bodies = replies(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/data/${pid}/${ids.liveId}`);
  await settled(page);
  await page.getByRole('heading', { level: 1, name: 'Live orders' }).waitFor();
  const picker = page.getByRole('combobox', { name: 'Fresh on ask for Live orders' });
  assert.equal(await picker.isDisabled(), false, 'incremental refresh is on: fresh on ask is offered');
  assert.equal((await picker.textContent())?.trim(), 'Fresh on ask off');
  await picker.click();
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/rpc/dataset%3Aupdate') && r.status() === 200);
  await page.getByRole('option', { name: 'Fresh on ask · 5 min' }).click();
  await saved;
  await page.waitForFunction(() => document.querySelector('[aria-label="Fresh on ask for Live orders"]')?.textContent?.includes('5 min'));
  await screens(page, 'dataset-fresh-on-ask');
  assert.match((await page.getByRole('combobox', { name: 'Fresh on ask for Live orders' }).textContent()) ?? '', /Fresh on ask · 5 min/, 'kept on the record: it survives the reloads');

  // Its Incremental refresh panel: on, over a connection since deleted — so here it can only be
  // turned off — with the run log the record keeps.
  const logPanel = async () => {
    await page.getByRole('button', { name: 'Incremental refresh for Live orders: on' }).click();
    const d = page.getByRole('dialog', { name: 'Incremental refresh · Live orders' });
    await d.getByRole('table', { name: 'Refresh log' }).waitFor();
    return d;
  };
  await dialogShots(page, logPanel, 'dataset-incremental-panel-log');
  const logged = await logPanel();
  assert.equal(await logged.getByRole('note').textContent(), 'The connection this dataset was imported from is gone, so it cannot refresh incrementally.');
  const runs = await logged.getByRole('table', { name: 'Refresh log' }).getByRole('row').allTextContents();
  assert.equal(runs.length, 3, 'a header row and the two runs on the record');
  assert.match(runs[1], /Incremental\s*filtered at the source/);
  assert.match(runs[2], /Full\s*The first run sets the high-water mark/);
  assert.equal(await logged.getByRole('switch', { name: 'Refresh incrementally' }).isDisabled(), false, 'on over a gone connection: it can still be turned off');
  assert.equal(await logged.getByRole('button', { name: 'Save' }).isDisabled(), true, 'nothing to save until it is switched off');
  await logged.getByRole('button', { name: 'Cancel' }).click();
  await logged.waitFor({ state: 'detached' });

  // Without incremental refresh: there, disabled, the reason in words beside it.
  await page.goto(`/data/${pid}/${ids.snapshotId}`);
  await settled(page);
  const off = page.getByRole('combobox', { name: 'Fresh on ask for Orders snapshot — needs incremental refresh' });
  await off.waitFor();
  assert.equal(await off.isDisabled(), true, 'no incremental refresh: fresh on ask is disabled');
  await page.getByText('needs incremental refresh', { exact: true }).waitFor();
  await screens(page, 'dataset-fresh-on-ask-off');

  // Incremental refresh (the desktop panel's port): turn it on here, and the 5-minute
  // schedule and fresh on ask open up beside it.
  const openPanel = async () => {
    await page.getByRole('button', { name: 'Incremental refresh for Orders snapshot: off' }).click();
    const d = page.getByRole('dialog', { name: 'Incremental refresh · Orders snapshot' });
    await d.getByText(/Each run asks PostgreSQL only for rows at or past the mark/).waitFor();
    return d;
  };
  await dialogShots(page, openPanel, 'dataset-incremental-panel');
  const panel = await openPanel();
  await panel.getByText('No runs yet.', { exact: false }).waitFor();
  await panel.getByRole('switch', { name: 'Refresh incrementally' }).check();
  await panel.getByRole('combobox', { name: 'Cursor column' }).click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['id · number', 'updated · number'], 'only number and date columns can be the cursor');
  await page.getByRole('option', { name: 'updated · number' }).click();
  await panel.getByRole('combobox', { name: 'Key column' }).click();
  await page.getByRole('option', { name: 'id', exact: true }).click();
  const turnedOn = page.waitForResponse((r) => r.url().endsWith('/api/rpc/incremental%3Aset') && r.status() === 200);
  await panel.getByRole('button', { name: 'Save' }).click();
  await turnedOn;
  await page.getByText('Incremental refresh is on. The next refresh is a full one: it sets the mark.').waitFor();
  await page.getByRole('button', { name: 'Incremental refresh for Orders snapshot: on' }).waitFor();
  // Now every 5 minutes, and fresh on ask.
  await page.getByRole('combobox', { name: 'Auto-refresh Orders snapshot' }).click();
  const scheduled = page.waitForResponse((r) => r.url().endsWith('/api/rpc/dataset%3Aupdate') && r.status() === 200);
  await page.getByRole('option', { name: 'Every 5 minutes', exact: true }).click();
  await scheduled;
  const fresh = page.getByRole('combobox', { name: 'Fresh on ask for Orders snapshot' });
  await fresh.waitFor();
  assert.equal(await fresh.isDisabled(), false, 'incremental refresh on: fresh on ask is offered');
  await fresh.click();
  const freshSaved = page.waitForResponse((r) => r.url().endsWith('/api/rpc/dataset%3Aupdate') && r.status() === 200);
  await page.getByRole('option', { name: 'Fresh on ask · 5 min' }).click();
  await freshSaved;
  await page.waitForFunction(() => document.querySelector('[aria-label="Fresh on ask for Orders snapshot"]')?.textContent?.includes('5 min'));
  await screens(page, 'dataset-incremental-on');
  assert.match((await page.getByRole('combobox', { name: 'Auto-refresh Orders snapshot' }).textContent()) ?? '', /Every 5 minutes/, 'the schedule is kept on the record');
  // The panel again: the stored settings, and why the next run is full.
  const reopen = async () => {
    await page.getByRole('button', { name: 'Incremental refresh for Orders snapshot: on' }).click();
    const d = page.getByRole('dialog', { name: 'Incremental refresh · Orders snapshot' });
    await d.getByText('Next refresh: full').waitFor();
    return d;
  };
  await dialogShots(page, reopen, 'dataset-incremental-panel-on');
  const again = await reopen();
  assert.equal(await again.getByRole('switch', { name: 'Refresh incrementally' }).isChecked(), true);
  assert.match((await again.getByRole('combobox', { name: 'Key column' }).textContent()) ?? '', /^id/, 'the stored key');
  await again.getByRole('button', { name: 'Cancel' }).click();

  // Back to off, so the rest of the suite reads the seed as it was.
  await page.goto(`/data/${pid}/${ids.liveId}`);
  await settled(page);
  await page.getByRole('combobox', { name: 'Fresh on ask for Live orders' }).click();
  const offSaved = page.waitForResponse((r) => r.url().endsWith('/api/rpc/dataset%3Aupdate') && r.status() === 200);
  await page.getByRole('option', { name: 'Fresh on ask off' }).click();
  await offSaved;
  noCanary(bodies);
});

e2e('empty states: a new project, and the import placeholder', async (s) => {
  const { page } = s;
  seed(s);
  const bodies = replies(page);
  await page.goto('/data');
  await settled(page);
  const id = await page.evaluate(async () => {
    // The CSRF pair, as the web client sends it (T6.2): the cookie's token as a header.
    const token = /(?:^|;\s*)(?:__Host-)?ordinate_csrf=([A-Za-z0-9_-]{43})/.exec(document.cookie)?.[1] ?? '';
    const r = await fetch('/api/rpc/projects%3Acreate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ args: [{ name: 'Empty project' }] }),
    });
    return ((await r.json()) as { id: string }).id;
  });
  await page.goto(`/data/${id}`);
  await settled(page);
  await page.getByRole('heading', { name: 'No datasets yet' }).waitFor();
  await screens(page, 'data-empty');
  await page.getByRole('tab', { name: 'Catalog' }).click();
  await page.getByRole('heading', { name: 'Nothing to catalog yet' }).waitFor();
  await page.getByRole('tab', { name: 'Relationships' }).click();
  await page.getByRole('heading', { name: 'Relate two datasets' }).waitFor();
  await page.getByRole('tab', { name: 'Captures' }).click();
  await page.getByRole('heading', { name: 'No captures in this project' }).waitFor();
  await page.getByRole('link', { name: 'Upload a screenshot' }).click();
  await page.getByRole('heading', { level: 1, name: 'Bring data in' }).waitFor();
  await page.goto(`/data/${s.server.sample.projectId}/00000000-0000-4000-8000-000000000000`);
  await settled(page);
  await page.getByRole('heading', { name: 'Dataset not found' }).waitFor();

  // Error and loading states, both themes: a catalog the server refuses (a handler's
  // `ok: false`, not a 500 — the browser logs a 500 as a console error), a catalog still coming.
  const refused = JSON.stringify({ ok: false, error: 'The catalog could not be read.', rows: [] });
  await page.route('**/api/rpc/catalog%3Alist', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: refused }));
  await page.goto(`/data/${s.server.sample.projectId}?tab=catalog`);
  await settled(page);
  await page.getByRole('alert').filter({ hasText: 'The catalog could not be loaded' }).waitFor();
  await screens(page, 'data-error');
  await page.unroute('**/api/rpc/catalog%3Alist');
  await loadingShots(page, `/data/${s.server.sample.projectId}?tab=catalog`, 'catalog:list', 'Loading the catalog', 'data-loading');
  noCanary(bodies);
});
