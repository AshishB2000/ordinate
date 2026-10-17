// The filter bar on real data and saved views (docs/dashboard-filters/
// 00-design.md), against the real server and the sample's Retail orders:
//
//   a Day dropdown over order_date (725 dates, first-seen order) says "first
//   200 of 725"; a date the first 200 lack (2024-12-30 — the server's own
//   replies say so) is found by searching, and the KPI becomes the server's
//   figure for it → the Period control's pills, named by the server → Save as
//   a new view, Copy link, the link reopens on the same figure → rename → on a
//   phone, the Filters sheet's "Saved view" applies it → set as default, the
//   plain URL opens on it → the Subscribe dialog lists it → the published page
//   offers it, on → delete it, and the address drops it.
//
// Each phase is its own page load, and every load stays within the RPC budget.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { copiedText, e2e, grantClipboard, SCREENS, settled, watchCopies } from './fixtures.ts';

/** One RPC from the page, as the web client sends it (session cookie + CSRF header). */
async function call(page: Page, channel: string, payload: unknown): Promise<any> { // any: each channel's own reply
  return page.evaluate(
    async ([ch, body]) => {
      const m = /(?:^|;\s*)(?:__Host-)?ordinate_csrf=([A-Za-z0-9_-]{43})/.exec(document.cookie);
      const res = await fetch(`/api/rpc/${ch}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(m ? { 'X-CSRF-Token': m[1] } : {}) }, body: JSON.stringify({ args: [body] }) });
      return res.json();
    },
    [channel, payload] as const,
  );
}

/** One screenshot per theme WITHOUT a reload (a popover or a menu stays up). */
async function screensInPlace(page: Page, name: string, fullPage = true): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

e2e('saved views: a picker over 725 dates, search, date pills, save → link → rename → phone → default → subscribe → publish → delete', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const sets: Array<{ id: string; name: string }> = await call(page, 'dataset:list', { projectId: pid });
  const ds = sets.find((d) => d.name === 'Retail orders');
  assert.ok(ds, 'the sample dataset');
  const card = (type: string, x: number, y: number, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x, y, w: 4, h: type === 'metric' ? 2 : 1 }, ...extra });
  const board = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Year end',
    sheets: [{ name: 'One', cards: [
      card('control', 0, 0, { control: { kind: 'dropdown', label: 'Day', datasetId: ds.id, column: 'order_date' } }),
      card('control', 4, 0, { control: { kind: 'date_range', label: 'Period', datasetId: ds.id, column: 'order_date' } }),
      card('metric', 0, 1, { metric: { datasetId: ds.id, column: 'revenue', aggregation: 'sum', label: 'Revenue' } }),
    ] }],
  });
  assert.ok(board.id, JSON.stringify(board));
  // What the server says: 725 dates, 2024-12-30 not among the first 200, and its revenue that day.
  const first = await call(page, 'dataset:distinct', { projectId: pid, datasetId: ds.id, column: 'order_date', limit: 200 });
  assert.equal(first.total, 725);
  assert.equal(first.values.includes('2024-12-30'), false, 'the first 200 lack the date');
  const dayStep = { type: 'filter', column: 'order_date', op: '=', value: '2024-12-30' };
  const want = await call(page, 'dashboard:metric', { projectId: pid, datasetId: ds.id, column: 'revenue', aggregation: 'sum', filters: [dayStep] });
  const all = await call(page, 'dashboard:metric', { projectId: pid, datasetId: ds.id, column: 'revenue', aggregation: 'sum' });
  assert.ok(want.ok && want.display && want.display !== all.display, JSON.stringify(want));
  const dash = `/analyses/${pid}/${board.id}`;
  const kpi = page.getByRole('group', { name: 'Revenue card' });
  const budget = (what: string) => {
    const n = rpc.loads.at(-1)?.rpcs ?? 0;
    console.log(`rpc: ${what} ${n}`);
    assert.ok(n <= 25, `${what}: ${n} RPCs`);
  };

  // ── The value picker ─────────────────────────────────────────────────
  await page.goto(dash);
  await page.getByRole('heading', { level: 1, name: 'Year end' }).waitFor();
  await kpi.getByText(all.display).waitFor();
  await settled(page);
  budget('dashboard open');
  await page.getByRole('button', { name: 'Day: All' }).click();
  const values = page.getByRole('group', { name: 'Day values' });
  await page.getByText('Showing the first 200 of 725 — search to narrow.').waitFor();
  assert.equal(await values.getByRole('button').count(), 201, 'All and the first 200');
  await screensInPlace(page, 'dashboard-value-picker');
  await page.getByRole('searchbox', { name: 'Search values' }).fill('2024-12-30');
  await values.getByRole('button', { name: '2024-12-30', exact: true }).click();
  await kpi.getByText(want.display).waitFor();
  await page.getByRole('button', { name: 'Day: 2024-12-30' }).waitFor();
  budget('picker');

  // ── The date control: the server's pills and names ───────────────────
  await page.goto(dash);
  await kpi.getByText(all.display).waitFor();
  await page.getByRole('button', { name: 'Period: All dates' }).click();
  const periods = page.getByRole('dialog', { name: 'Period' });
  const pill = periods.getByRole('button', { name: 'Last 30 days' });
  await pill.waitFor();
  await screensInPlace(page, 'dashboard-date-presets');
  await pill.click();
  const named = await call(page, 'period:picker', { spec: { preset: 'last_n_days', n: 30 } });
  await page.getByRole('button', { name: `Period: ${named.current.label}` }).waitFor();
  assert.equal(await pill.getAttribute('aria-pressed'), 'true');
  await periods.getByRole('button', { name: 'All dates' }).click();
  await page.getByRole('button', { name: 'Period: All dates' }).waitFor();
  budget('date pills');

  // ── Save a view, copy its link, open the link ───────────────────────
  await page.goto(dash);
  await kpi.getByText(all.display).waitFor();
  await page.getByRole('button', { name: 'Day: All' }).click();
  await page.getByRole('searchbox', { name: 'Search values' }).fill('2024-12-30');
  await values.getByRole('button', { name: '2024-12-30', exact: true }).click();
  await kpi.getByText(want.display).waitFor();
  await page.getByRole('button', { name: 'Views' }).click();
  await page.getByRole('menuitem', { name: 'Save as a new view…' }).click();
  const naming = page.getByRole('dialog', { name: 'Save as a new view' });
  await naming.getByLabel('Name').fill('Dec 30');
  await naming.getByRole('button', { name: 'Save view' }).click();
  await page.waitForURL(/\?view=[0-9a-f-]{36}$/);
  const viewId = new URL(page.url()).searchParams.get('view') ?? '';
  await grantClipboard(page);
  await watchCopies(page);
  await page.getByRole('button', { name: 'Views: Dec 30' }).click();
  await page.getByRole('menuitemradio', { name: 'Dec 30' }).waitFor();
  await screensInPlace(page, 'dashboard-views-menu', false);
  await page.getByRole('menuitem', { name: 'Copy link' }).click();
  await page.getByText('Link copied').waitFor();
  const link = await copiedText(page);
  assert.equal(link, `${server.base}${dash}?view=${viewId}`);
  budget('save a view');
  await page.goto(link);
  await kpi.getByText(want.display).waitFor();
  await page.getByRole('button', { name: 'Day: 2024-12-30' }).waitFor();
  await settled(page);
  budget('the view’s link');

  // ── Rename ──────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Views: Dec 30' }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const renaming = page.getByRole('dialog', { name: 'Rename view' });
  await renaming.getByLabel('Name').fill('Last trading day');
  await renaming.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Views: Last trading day' }).waitFor();

  // ── A phone: the Filters sheet's "Saved view" ───────────────────────
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(dash);
  await kpi.getByText(all.display).waitFor();
  await page.getByRole('button', { name: 'Filters' }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await sheet.getByRole('combobox', { name: 'Saved view' }).click();
  await page.getByRole('option', { name: 'Last trading day' }).click();
  await kpi.getByText(want.display).waitFor();
  await page.waitForURL(new RegExp(`\\?view=${viewId}$`));
  await screensInPlace(page, 'phone-views', false);
  await sheet.getByRole('button', { name: 'Done' }).click();
  budget('phone');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── Default: the plain address opens on the view ─────────────────────
  await page.goto(`${dash}?view=${viewId}`);
  await page.getByRole('button', { name: 'Views: Last trading day' }).click();
  await page.getByRole('menuitem', { name: 'Set as default' }).click();
  await page.getByRole('button', { name: 'Views: Last trading day' }).click();
  await page.getByRole('menuitemradio', { name: 'Last trading day (default)' }).waitFor();
  await page.keyboard.press('Escape');
  await page.goto(dash);
  await kpi.getByText(want.display).waitFor();
  await page.getByRole('button', { name: 'Views: Last trading day' }).waitFor();
  budget('default view');

  // ── The Subscribe dialog lists it ───────────────────────────────────
  await page.getByRole('button', { name: 'Subscribe' }).click();
  const sub = page.getByRole('dialog', { name: 'Subscribe to Year end' });
  await sub.getByRole('combobox', { name: 'Saved view' }).click({ timeout: 30_000 });
  await page.getByRole('option', { name: 'Last trading day' }).waitFor();
  await page.keyboard.press('Escape');

  // ── Published: the page offers the view, on ──────────────────────────
  const run = await call(page, 'publish:run', { projectId: pid, dashboardIds: [board.id] });
  assert.equal(run.ok, true, JSON.stringify(run).slice(0, 300));
  await page.goto(`/p/${run.site.id}/${run.site.pages[0].file}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const pubView = page.locator('select.pub-view-select');
  assert.deepEqual(await pubView.locator('option').allTextContents(), ['Custom', 'Last trading day']);
  assert.equal(await pubView.locator('option:checked').textContent(), 'Last trading day', 'the default view is on');
  await page.getByText(want.display).first().waitFor();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `published-view-${scheme}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // ── Delete: the address drops it ────────────────────────────────────
  await page.goto(`${dash}?view=${viewId}`);
  await kpi.getByText(want.display).waitFor();
  await page.getByRole('button', { name: 'Views: Last trading day' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete “Last trading day”?' });
  await confirm.getByText(/fall back to the dashboard as saved/).waitFor();
  await confirm.getByRole('button', { name: 'Delete view' }).click();
  await page.waitForURL((u) => !u.search.includes('view='));
  await page.getByRole('button', { name: 'Views' }).click();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['As authored']);
  await page.keyboard.press('Escape');
  const stored = await call(page, 'analysis:open', { projectId: pid, id: board.id });
  assert.deepEqual([stored.analysis.views, stored.analysis.defaultViewId], [[], '']);
});
