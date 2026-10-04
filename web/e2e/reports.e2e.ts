// Reports (T2.13) against the real server:
//
//   the empty Reports tab → New report from the sample dashboard → the builder:
//   the cover, a sheet page and the MAP tile previewed as the file will print
//   them (charts drawn by the shared engine; the map's WebGL canvas with its
//   DOM value labels composited in) → a caption override → settings (Narrative
//   adds a page, PowerPoint drops the paper) → a Notes page → Save → Generate:
//   real PDF, PPTX and DOCX downloads built in the browser, checked by their
//   bytes → the list card says it was generated.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
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

/** The preview has painted: the sheet is up and nothing is resolving. */
async function previewed(page: Page, title: string | RegExp): Promise<void> {
  await page.getByTestId('report-sheet').and(page.getByLabel(typeof title === 'string' ? `Preview: ${title}` : title)).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, { timeout: 30_000 });
}

/** Click, take the browser download, return its first bytes and size. */
async function download(page: Page, button: string): Promise<{ name: string; head: string; size: number }> {
  const t0 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByRole('button', { name: button }).click()]);
  console.log(`${button}: click → download ${Date.now() - t0} ms`);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), head: readFileSync(file).subarray(0, 4).toString('latin1'), size: statSync(file).size };
}

e2e('reports: empty → new from a dashboard → preview (sheet, map) → settings → notes → save → PDF, PPTX, DOCX downloads', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/reports?project=${pid}`);
  await settled(page);
  await page.getByRole('heading', { name: 'No reports yet' }).waitFor();
  await screens(page, 'reports-empty');

  // ── New report from the sample dashboard ──────────────────────────────
  await page.getByRole('button', { name: 'New report' }).click();
  const dlg = page.getByRole('dialog', { name: 'New report' });
  await dlg.getByRole('button', { name: /Retail overview/ }).click();
  await page.waitForURL(new RegExp(`/reports/${pid}/[0-9a-f-]{36}$`));
  await page.getByRole('heading', { level: 1, name: 'Retail overview report' }).waitFor();
  await previewed(page, 'Retail overview');
  const pages = page.getByRole('complementary', { name: 'Pages' });
  // The server built the default pages: cover, summary, the sheet, a page per big chart.
  const kinds = await pages.locator('li').allInnerTexts();
  assert.ok(kinds.length >= 4, `default pages: ${kinds.join(' | ')}`);
  assert.match(kinds.join(' '), /Cover/);
  assert.match(kinds.join(' '), /Summary/);

  // A sheet page: its KPIs are the server's display strings, its charts pictures.
  await pages.locator('ol').getByRole('button', { name: /Sheet/ }).first().click();
  await previewed(page, /^Preview: /);
  const sheet = page.getByTestId('report-sheet');
  await sheet.getByText('$5.2M').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="report-sheet"] img[src^="data:image/png"]').length >= 2);

  // The map tile: drawn off-screen, read back, DOM markers composited — a real picture, not a blank box.
  await pages.locator('ol').getByRole('button', { name: /Profit by state/ }).click();
  await previewed(page, 'Profit by state');
  const mapPng = await sheet.locator('img').first().getAttribute('src');
  assert.ok(mapPng && mapPng.startsWith('data:image/png') && mapPng.length > 5000, `the map picture: ${mapPng?.length} chars`);
  const caption = page.getByLabel('Caption');
  const app = await caption.inputValue();
  assert.ok(app.length > 10, `the app's caption for the map: ${app}`);
  await caption.fill('Profit concentrates in a few states.');
  await page.getByRole('button', { name: 'Reset to the app’s caption' }).waitFor();
  await page.getByText('Unsaved').waitFor();
  await screensInPlace(page, 'reports-builder-map');

  // ── Settings: Narrative is a page; a deck has no paper ────────────────
  await page.getByRole('switch', { name: 'Narrative' }).check();
  await pages.locator('ol').getByRole('button', { name: /Narrative/ }).waitFor();
  await page.getByRole('switch', { name: 'Narrative' }).uncheck();
  await page.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'PowerPoint (.pptx)' }).click();
  await page.getByText('Slides are always 16:9').waitFor();
  await page.getByRole('button', { name: 'Generate PowerPoint' }).waitFor();

  // ── A Notes page ──────────────────────────────────────────────────────
  await pages.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByLabel('Notes').last().fill('Prepared for the board.\n\nFigures as of the latest month.');
  await previewed(page, 'Notes');
  await sheet.getByText('Prepared for the board.').waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Report saved').waitFor();
  assert.equal(await page.getByText('Unsaved').count(), 0);
  await screens(page, 'reports-builder');

  // ── Generate: a real file of each format, built in the browser ────────
  const pptx = await download(page, 'Generate PowerPoint');
  assert.equal(pptx.head.slice(0, 2), 'PK', 'a .pptx is a zip');
  assert.match(pptx.name, /^retail-overview-report-\d{4}-\d{2}-\d{2}\.pptx$/);
  assert.ok(pptx.size > 20_000, `pptx size ${pptx.size}`);

  await page.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'PDF' }).click();
  const pdf = await download(page, 'Generate PDF');
  assert.equal(pdf.head, '%PDF');
  assert.ok(pdf.size > 20_000, `pdf size ${pdf.size}`);

  await page.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'Word (.docx)' }).click();
  const docx = await download(page, 'Generate Word');
  assert.equal(docx.head.slice(0, 2), 'PK', 'a .docx is a zip');

  // ── The list says it was generated ────────────────────────────────────
  await page.locator('#main').getByRole('link', { name: 'Reports' }).click();
  await settled(page);
  const card = page.locator('[data-report-id]').first();
  await card.getByText(/Last generated/).waitFor();
  await card.getByText('DOCX').waitFor();
  await screens(page, 'reports-list');
  console.log(`RPCs per page load: ${rpc.loads.map((l) => `${l.rpcs} ${l.url.replace(/^https?:\/\/[^/]+/, '')}`).join(' | ')}`);
}, { rpcBudget: 25 });
