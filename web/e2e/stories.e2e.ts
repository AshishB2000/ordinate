// Stories (T2.13) against the real server:
//
//   the empty Stories tab → New story → write Markdown with headings (the
//   outline follows) → "/" opens the block picker in the line → a live chart
//   (the server's figures, the app's caption as the placeholder) → a filter
//   pinned to that block → a metric → undo / redo → the autosave survives a
//   reload → present mode, a page per heading, ← → and Esc → Export PDF: a
//   real PDF built in the browser.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

async function saved(page: Page): Promise<void> {
  await page.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor();
}

/** Type into the always-empty last line. */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  const doc = page.locator('article');
  const last = doc.locator('[data-kind="text"]').last();
  const field = last.locator('textarea');
  if (!(await field.count())) await last.getByRole('button', { name: 'Edit text' }).click();
  await last.locator('textarea').fill(text);
}

e2e('stories: new → Markdown + outline → slash picker → live chart, pinned filter, metric → undo → saved → present → PDF', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/reports?project=${pid}&tab=stories`);
  await settled(page);
  await page.getByRole('heading', { name: 'No stories yet' }).waitFor();
  await screens(page, 'stories-empty');

  await page.getByRole('button', { name: 'New story' }).first().click();
  const name = page.getByRole('dialog', { name: 'Name the story' });
  await name.getByLabel('Name').fill('Q3 in review');
  await name.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(new RegExp(`/stories/${pid}/[0-9a-f-]{36}\\?focus=end$`));
  assert.equal(await page.getByLabel('Story name').inputValue(), 'Q3 in review');

  // ── Markdown; the outline is built from the headings ──────────────────
  await page.locator('article textarea').fill('# Revenue\nRevenue **grew** across every category.');
  await page.locator('article textarea').blur();
  const outline = page.getByRole('navigation', { name: 'Outline' });
  await outline.getByRole('button', { name: 'Revenue' }).waitFor();
  await page.locator('article').getByRole('heading', { name: 'Revenue' }).waitFor();
  await page.locator('article strong', { hasText: 'grew' }).waitFor();

  // ── "/" in the empty last line opens the picker; Chart → the chooser ──
  await typeAtEnd(page, '/cha');
  const slash = page.getByRole('listbox', { name: 'Add a block' });
  await slash.getByRole('option', { name: /Chart/ }).waitFor();
  assert.equal(await slash.getByRole('option').count(), 1, 'the picker filters by what follows the slash');
  await page.keyboard.press('Enter');
  const chooser = page.getByRole('dialog', { name: 'Add a chart' });
  await chooser.getByRole('button', { name: /Revenue by category/ }).click();
  const fig = page.locator('[data-kind="visual"]');
  await fig.getByText('Revenue by category').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-kind="visual"] canvas').length === 1);
  const cap = fig.getByLabel('Caption');
  assert.ok(((await cap.getAttribute('placeholder')) ?? '').length > 10, 'the app\'s caption is the placeholder');

  // ── Pin a filter to the block: the server recomputes the chart ────────
  await fig.getByRole('button', { name: 'Pin a filter' }).click();
  const pin = page.getByRole('dialog', { name: 'Pin a filter' });
  await pin.getByRole('combobox', { name: 'Column' }).click();
  await page.getByRole('option', { name: 'category', exact: true }).click();
  await pin.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: '!=', exact: true }).click();
  await pin.getByLabel('Value').fill('Furniture');
  await pin.getByRole('button', { name: 'Pin filter' }).click();
  await fig.getByText('category != Furniture').waitFor();

  // ── A second section with a metric ────────────────────────────────────
  await typeAtEnd(page, '## Profit');
  await typeAtEnd(page, '/metric');
  await page.getByRole('listbox', { name: 'Add a block' }).getByRole('option', { name: /^Metric/ }).first().click();
  await page.getByRole('dialog', { name: 'Add a metric' }).getByRole('button', { name: /^Revenue/ }).click();
  await page.locator('[data-kind="metric"]').getByText('$5.2M').waitFor();
  await outline.getByRole('button', { name: 'Profit' }).waitFor();

  // ── Undo / redo (the toolbar; ⌘Z is the same stack) ───────────────────
  await page.getByRole('button', { name: /^Undo / }).click();
  await page.locator('[data-kind="metric"]').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /^Redo / }).click();
  await page.locator('[data-kind="metric"]').getByText('$5.2M').waitFor();
  await saved(page);
  await page.reload();
  await settled(page);
  await page.locator('[data-kind="metric"]').getByText('$5.2M').waitFor();
  await page.locator('[data-kind="visual"]').getByText('category != Furniture').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-kind="visual"] canvas').length === 1);
  await screens(page, 'story-page');

  // ── Present: a page per heading ───────────────────────────────────────
  await page.getByRole('button', { name: 'Present' }).click();
  const show = page.getByRole('dialog', { name: 'Presenting Q3 in review' });
  // A new story opens with its title as a heading — so three pages: the title, Revenue, Profit.
  await show.getByRole('heading', { name: 'Q3 in review', exact: true }).waitFor();
  await show.getByText('1 / 3').waitFor();
  await page.keyboard.press('ArrowRight');
  await show.getByRole('heading', { name: 'Revenue' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] canvas').length === 1);
  await screensInPlace(page, 'story-present');
  await page.keyboard.press('ArrowRight');
  await show.getByRole('heading', { name: 'Profit' }).waitFor();
  await show.getByText('$5.2M').waitFor();
  await page.keyboard.press('ArrowLeft');
  await show.getByRole('heading', { name: 'Revenue' }).waitFor();
  await page.keyboard.press('Escape');
  await show.waitFor({ state: 'detached' });

  // ── Export: one PDF, a page per heading, built in the browser ─────────
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByRole('button', { name: 'Export PDF' }).click()]);
  assert.equal(readFileSync(await dl.path()).subarray(0, 4).toString('latin1'), '%PDF');
  assert.match(dl.suggestedFilename(), /^q3-in-review-\d{4}-\d{2}-\d{2}\.pdf$/);

  // ── The list card ─────────────────────────────────────────────────────
  await page.locator('#main').getByRole('link', { name: 'Stories' }).click();
  await settled(page);
  const card = page.locator('[data-story-id]').first();
  await card.getByText('Q3 in review').waitFor();
  await card.getByText(/Revenue grew across every category/).waitFor();
  await screens(page, 'stories-list');
  console.log(`RPCs per page load: ${rpc.loads.map((l) => `${l.rpcs} ${l.url.replace(/^https?:\/\/[^/]+/, '')}`).join(' | ')}`);
});
