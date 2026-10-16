// The version compare view (docs/version-diff), against the built server and the
// sample project: the sample dashboard is edited (seed-versionDiff.ts — a filter
// added, a KPI's aggregation changed, a card moved, the note rewritten, the
// dashboard renamed), then in its history: pick the older save → "Compare with
// current" → the summary, the layout pair, the figures each spec gives NOW (the
// engine's, so only their presence and shape are asserted), the sentences with a
// word diff → "Restore v1" → the confirmation restates the summary → restored,
// a third save marked "Restored from".
//
// Screens in both themes: web/e2e/__screens__/versions-compare-*.png and
// versions-compare-confirm-*.png.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { e2e, screens, SCREENS, settled } from './fixtures.ts';

const SEED = fileURLToPath(new URL('./seed-versionDiff.ts', import.meta.url));

/** The confirmation is a dialog a reload would close: open it, shoot, per theme. */
async function shotConfirm(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
    await page.reload();
    await settled(page);
    await page.getByRole('region', { name: 'Version compare' }).getByRole('button', { name: 'Restore v1' }).click();
    await page.getByRole('dialog', { name: 'Restore v1?' }).waitFor();
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
  await page.reload();
  await settled(page);
}

e2e('version diff: edit a dashboard, compare two saves, restore the older one', async (s) => {
  const { page, server } = s;
  const pid = server.sample.projectId;
  const seeded = spawnSync(process.execPath, [SEED, server.dataDir, pid], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(seeded.status, 0, seeded.stderr);
  const seed = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { analysisId: string; original: string; edited: string };

  await page.goto(`/versions/${pid}/dashboard/${seed.analysisId}`);
  await settled(page);
  await page.getByRole('heading', { level: 1, name: `${seed.edited} — version history` }).waitFor();
  await page.getByRole('region', { name: 'Saved versions' }).getByRole('button', { pressed: false }).first().click();
  await page.getByRole('button', { name: 'Compare with current' }).click();

  const pane = page.getByRole('region', { name: 'Version compare' });
  const summary = pane.getByRole('status').filter({ hasText: 'changed' });
  await summary.waitFor();
  const line = (await summary.locator('strong').textContent())?.trim() ?? '';
  assert.match(line, /^\d+ cards? changed, \d+ cards? moved, a filter changed, \d+ other changes?$/, line);
  assert.ok(page.url().includes('compare='), 'the compare is in the address');

  // The layout pair: changed and moved tiles drawn on both sides.
  const layout = pane.getByRole('region', { name: 'Layout' });
  assert.ok((await layout.locator('rect[data-status="changed"]').count()) >= 2, 'changed tiles on both sides');
  assert.ok((await layout.locator('rect[data-status="moved"]').count()) >= 2, 'the moved tile on both sides');

  // The sentences: the engine-free words of the edit.
  await pane.getByText('Filter region = East was added').waitFor();
  await pane.getByText('Units sold: measure changed from sum(units) to avg(units)').waitFor();
  await pane.getByText(`Title changed from “${seed.original}” to “${seed.edited}”`).waitFor();
  await pane.getByText(/^“Orders” moved from row \d+ to row \d+$/).waitFor();
  assert.equal(await pane.locator('ins').filter({ hasText: 'quarterly review' }).count(), 1, 'the note\'s word diff');

  // Figures: computed now by the engine, so asserted by shape — every KPI moved by the filter, each side a figure.
  const figures = pane.getByRole('region', { name: 'Figures that moved' });
  await figures.locator('tbody tr').first().waitFor();
  assert.equal(await figures.locator('tbody tr').count(), 4, 'the four KPI cards');
  const units = figures.locator('tbody tr').filter({ hasText: 'Units sold' });
  assert.match((await units.textContent()) ?? '', /measure changed/);
  assert.equal(await figures.locator('[data-live-refusal]').count(), 0, 'no refusal on an extract dataset');

  await screens(page, 'versions-compare');
  // The change list sits below the fold of a full-page shot (only <main> scrolls): scrolled to, per theme.
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
    await page.reload();
    await settled(page);
    await figures.locator('tbody tr').first().waitFor();
    await pane.getByRole('region', { name: 'Changes' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SCREENS, `versions-compare-changes-${theme}.png`), animations: 'disabled' });
  }
  await shotConfirm(page, 'versions-compare-confirm');

  // Restore v1, through the confirmation.
  await pane.getByRole('button', { name: 'Restore v1' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore v1?' });
  await dialog.getByText(line, { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Restore v1' }).click();
  await page.getByText(/^Restored v1 — the version before it is still in the history\.$/).waitFor();
  await page.getByRole('heading', { level: 1, name: `${seed.original} — version history` }).waitFor();
  await page.getByRole('region', { name: 'Version preview' }).waitFor();
  assert.ok(!page.url().includes('compare='), 'the compare closed');
  await page.getByText(/^Restored from /).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Saved versions' }).getByRole('button').count(), 3);
});
