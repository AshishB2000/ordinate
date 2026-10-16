// The metric tree (docs/metric-tree), against the real server on the sample
// project's "Retail orders" (2023-01 … 2024-12):
//
//   start     Metrics → Revenue's menu → "Break it down…": the root alone, and
//             the breakdown read from the formulas (Avg order value = [Revenue]
//             / [Orders]) offered as one click
//   build     one click → Revenue = Orders × Avg order value; the editor splits
//             Orders by region; every node, the lead branch from the root down,
//             the server's headline for the newest closed month (Dec 2024)
//   read      the keyboard tree (↓ → ←), the Compare control (last year)
//   card      "Add to dashboard" → the dashboard draws the Metric tree card
//
// Fails on any console error or CSP violation and stays inside the RPC budget.
// Screens in both themes go to web/e2e/__screens__/metric-tree-*.png.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import path from 'node:path';
import { e2e, SCREENS, screens, settled } from './fixtures.ts';

async function pick(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** The card itself, one shot per theme, switched in place (a reload would scroll it away). */
async function cardScreens(page: Page, card: ReturnType<Page['locator']>, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await card.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

const tree = (page: Page) => page.getByRole('tree');
const item = (page: Page, name: string) => tree(page).locator(`[role="treeitem"][aria-label^="${name},"]`).first();

e2e('metric tree: build Revenue = Orders × Avg order value split by region, read why it moved, add it to a dashboard', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/data/metrics?project=${pid}`);
  await settled(page);
  await page.getByRole('button', { name: 'Actions for Revenue' }).click();
  await page.getByRole('menuitem', { name: 'Break it down…' }).click();
  await page.waitForURL(/\/data\/metrics\/[^/]+\/[^/]+\/tree$/);
  await settled(page);

  // ── start: the root alone, the formula's breakdown offered ────────────────
  await tree(page).waitFor();
  assert.equal(await tree(page).getByRole('treeitem').count(), 1, 'no tree yet: the root alone');
  assert.equal(await page.getByRole('heading', { name: 'Break Revenue down' }).count(), 1);
  assert.match((await page.locator('section[aria-live]').innerText()).replace(/\s+/g, ' '), /^Dec 2024 vs Nov 2024 Revenue (rose|fell) \$[\d.,]+K \([\d.]+%\) vs previous period\.$/);
  await screens(page, 'metric-tree-start');

  // ── build: one click, then the editor splits Orders by region ─────────────
  await page.getByRole('button', { name: 'Orders × Avg order value' }).click();
  await item(page, 'Orders').waitFor();
  await page.getByRole('button', { name: 'Edit tree' }).click();
  const dialog = page.getByRole('dialog', { name: 'Break down Revenue' });
  await dialog.waitFor();
  await dialog.locator('li li').filter({ hasText: 'Orders' }).getByRole('button', { name: 'Break down…' }).click();
  await dialog.getByRole('radio', { name: /Split by a column/ }).click();
  await pick(page, 'Column', 'region');
  await dialog.getByRole('button', { name: 'Break it down', exact: true }).click();
  assert.equal(await dialog.getByText('by region').count(), 1, 'the editor shows the split');
  await dialog.getByRole('button', { name: 'Save tree' }).click();
  await dialog.waitFor({ state: 'detached' });
  await item(page, 'West').waitFor();
  await settled(page);

  const items = tree(page).getByRole('treeitem');
  // Revenue, Orders, five regions, Avg order value — and no residual: Revenue IS Orders × AOV.
  assert.equal(await items.count(), 8, (await items.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).join('\n'));
  assert.equal(await page.getByText('Not explained by its parts').count(), 0, 'the parts add up');
  const headline = await page.locator('section[aria-live] p').innerText();
  assert.match(headline, /^Revenue (rose|fell) \$[\d.,]+K \([\d.]+%\) vs previous period\. (Orders|Avg order value) explains −?\d+% of it(, led by \w+)?\.$/, headline);
  // The lead branch, root down: one tinted card per level, joined by the thick connector.
  const leads = await tree(page).locator('[data-card][class*="leadCard"]').count();
  assert.ok(leads >= 2, `lead cards: ${leads}`);
  assert.ok((await tree(page).locator('path[class*="edgeLead"]').count()) >= 1, 'a lead connector');
  const orders = await item(page, 'Orders').getAttribute('aria-label');
  assert.match(orders ?? '', /contributes [+−]\$[\d.,]+K?, −?\d+% of the change/, orders ?? '');
  await screens(page, 'metric-tree');

  // ── read: the keyboard ─────────────────────────────────────────────────────
  await items.first().focus();
  await page.keyboard.press('ArrowDown');
  assert.match((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ?? '', /^Orders,/);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await item(page, 'West').count(), 0, '← closes Orders');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.match((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ?? '', /^(West|East|Central|South|Northeast),/);

  // The same Compare a dashboard uses: last year.
  await pick(page, 'Compare the period with', 'vs same period last year');
  await page.getByText('Dec 2023', { exact: true }).waitFor();
  assert.match(await page.locator('section[aria-live] p').innerText(), /vs same period last year/);

  // A phone: the tree becomes an outline, the page never scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await settled(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'no sideways scroll on a phone');
  await page.screenshot({ path: path.join(SCREENS, 'metric-tree-phone-light.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── card: add it to the sample dashboard ───────────────────────────────────
  await page.getByRole('button', { name: 'Add to dashboard' }).click();
  const add = page.getByRole('dialog', { name: 'Add to dashboard' });
  await add.getByRole('combobox', { name: 'Dashboard' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] [aria-disabled="true"], [role="dialog"] button[disabled]'));
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Open it' }).click();
  await page.waitForURL(/\/analyses\/[^/]+\/[^/]+$/);
  await settled(page);
  const card = page.locator('[data-card-id]').filter({ has: page.getByRole('tree') });
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  assert.match(await card.innerText(), /Revenue (rose|fell) /);
  assert.ok((await card.getByRole('treeitem').count()) >= 3, 'the card draws the tree');
  await cardScreens(page, card, 'metric-tree-card');
});
