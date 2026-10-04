// Scorecards (T2.13) against the real server:
//
//   the empty Scorecards tab → New scorecard (seeded with the project's
//   metrics) → the targets editor opens → a fixed target, an owner and a group
//   → the table: every value, target, attainment, change and status the
//   server's; the status summary and group roll-up counted by the server → step
//   back a period (the server recomputes) → a row's detail: history with its
//   target, the breakdown → Create report: the report builder previews the
//   scorecard page as a native table.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled } from './fixtures.ts';

async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

e2e('scorecards: new → targets → server-computed rows and roll-ups → previous period → detail → report', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/reports?project=${pid}&tab=scorecards`);
  await settled(page);
  await page.getByRole('heading', { name: 'No scorecards yet' }).waitFor();
  await screens(page, 'scorecards-empty');

  await page.getByRole('button', { name: 'New scorecard' }).first().click();
  const nameDlg = page.getByRole('dialog', { name: 'Name the scorecard' });
  await nameDlg.getByLabel('Name').fill('Monthly KPIs');
  await nameDlg.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(new RegExp(`/scorecards/${pid}/[0-9a-f-]{36}`));

  // ── The targets editor opens on the seeded metrics ────────────────────
  const ed = page.getByRole('dialog', { name: 'Metrics, targets and owners' });
  const rev = ed.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^Revenue/ }) });
  await rev.waitFor();
  assert.ok((await ed.getByRole('row').count()) >= 4, 'seeded with the project\'s metrics');
  await rev.getByRole('combobox', { name: /Target type for Revenue/ }).click();
  await page.getByRole('option', { name: 'Number' }).click();
  await rev.getByLabel('Target value').fill('150000');
  await rev.getByLabel('Owner').fill('Ana');
  await rev.getByLabel('Group').fill('Sales');
  await screensInPlace(page, 'scorecard-editor');
  await ed.getByRole('button', { name: 'Save' }).click();
  await ed.waitFor({ state: 'detached' });

  // ── The table: the server's figures and words ─────────────────────────
  const row = page.locator('tr[data-metric-id]').filter({ hasText: 'Revenue' }).first();
  await row.getByText('Ana').waitFor();
  const status = await row.getAttribute('data-status');
  assert.ok(status && status !== 'none', `a target gives a status: ${status}`);
  assert.match(await row.innerText(), /\d+%/, 'attainment printed as the server wrote it');
  await page.locator('tbody tr').filter({ hasText: 'Sales' }).first().getByText(/of 1 on track/).waitFor();
  await page.getByLabel('Status summary').getByText(/on track/).waitFor();
  const label = await page.locator('[aria-live="polite"] strong').innerText();
  await screens(page, 'scorecard-page');

  // ── Step back a period: the server recomputes ─────────────────────────
  await page.getByRole('button', { name: 'Previous period' }).click();
  await page.waitForFunction((l) => document.querySelector('[aria-live="polite"] strong')?.textContent !== l, label);
  await page.getByRole('button', { name: 'Next period' }).click();
  await page.waitForFunction((l) => document.querySelector('[aria-live="polite"] strong')?.textContent === l, label);

  // ── A row's detail ────────────────────────────────────────────────────
  await page.locator('tr[data-metric-id]').filter({ hasText: 'Revenue' }).first().click();
  const detail = page.getByRole('complementary', { name: 'Metric detail' });
  await detail.getByText('$150K').waitFor(); // the server's display string for the target
  await detail.getByText(/Last \d+ periods, by/).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('aside[aria-label="Metric detail"] canvas').length >= 1);
  await screensInPlace(page, 'scorecard-detail');
  await detail.getByRole('button', { name: 'Close the detail' }).click();

  // ── Scorecards export through reports ─────────────────────────────────
  await page.getByRole('button', { name: 'Scorecard options' }).click();
  await page.getByRole('menuitem', { name: 'Create report…' }).click();
  await page.waitForURL(new RegExp(`/reports/${pid}/[0-9a-f-]{36}$`));
  await page.getByRole('heading', { level: 1, name: 'Monthly KPIs report' }).waitFor();
  await page.getByRole('complementary', { name: 'Pages' }).getByRole('button', { name: /Scorecard/ }).click();
  const sheet = page.getByTestId('report-sheet');
  await sheet.locator('table').getByText('Revenue').waitFor({ timeout: 30_000 });
  await sheet.locator('table').getByText('Ana').waitFor();
  console.log(`RPCs per page load: ${rpc.loads.map((l) => `${l.rpcs} ${l.url.replace(/^https?:\/\/[^/]+/, '')}`).join(' | ')}`);
});
