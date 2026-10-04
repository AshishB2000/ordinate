// E2E (T2.14): settings, themes, privacy, backups, About and the command
// palette against the real server (dev sign-in — an org admin without
// Postgres, records as files — and the seeded sample project).
//
//   My settings   who is signed in; the theme set here is the one the account
//                 menu shows; the keyboard list from the command registry
//   Privacy       the sample project's Share policy → Drop on exports, kept
//                 after a reload; a scan for sensitive columns
//   Palette       ⌘K / Ctrl+K → "> about" → Enter lands on About; "/" searches
//                 the sample project's records and opens a dataset
//   About         the version from package.json and the build-time licence list
//   Organization  Admin → Workspace: currency → EUR, the preview follows (then
//                 back); Themes: duplicate a built-in, edit it (a contrast
//                 warning), save, make it the workspace default; Backups: a
//                 real download → restore with the typed word → the project
//                 back as a new one in the switcher
//
// Screens in both themes go to web/e2e/__screens__/settings-*.png.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, screens, SCREENS, settled, type Session } from './fixtures.ts';

/** One screenshot per theme of a state a reload would close: `open` re-creates it. */
async function shotOpen(page: Page, name: string, open: () => Promise<void>): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
    await page.reload();
    await settled(page);
    await open();
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), animations: 'disabled' });
  }
  await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
  await page.reload();
  await settled(page);
}

function report(s: Session): void {
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}${new URL(l.url).search}`);
}

e2e('settings: my settings, privacy, the palette, About, and the organization tabs', async (s) => {
  const { page, server } = s;
  const mod = (await page.evaluate(() => /mac/i.test(navigator.platform))) ? 'Meta' : 'Control';
  const palette = () => page.getByRole('combobox', { name: 'Search commands and records' });

  // ── My settings ──────────────────────────────────────────────────────────
  await page.goto('/settings');
  await settled(page);
  assert.equal(await page.getByTestId('settings-email').textContent(), 'dev@local');
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.getByRole('button', { name: 'Account and theme' }).click();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Dark' }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'System' }).click();
  const keyboard = page.getByRole('region', { name: 'Keyboard' });
  await keyboard.getByText('Command palette', { exact: true }).waitFor();
  await screens(page, 'settings-you');

  // ── Privacy (the sample project) ─────────────────────────────────────────
  await page.getByRole('tab', { name: 'Privacy' }).click();
  const exportsSeg = page.getByRole('radiogroup', { name: 'Exports' });
  await exportsSeg.waitFor();
  assert.equal(page.url().endsWith('/settings?tab=privacy'), true);
  await exportsSeg.getByRole('radio', { name: 'Drop' }).click();
  // The control shows what the server answered (the overview, re-read after the write).
  await exportsSeg.locator('[role=radio][aria-checked=true]', { hasText: 'Drop' }).waitFor();
  await page.reload();
  await settled(page);
  assert.equal(await page.getByRole('radiogroup', { name: 'Exports' }).getByRole('radio', { name: 'Drop' }).getAttribute('aria-checked'), 'true');
  const scan = page.getByRole('button', { name: /^Check \d+ datasets? for sensitive columns$/ });
  if (await scan.count()) {
    await scan.first().click();
    await page.getByText(/to review\.|Nothing new looks sensitive\./).first().waitFor();
  }
  await screens(page, 'settings-privacy');
  await page.getByRole('radiogroup', { name: 'Exports' }).getByRole('radio', { name: 'Mask' }).click();

  // ── Palette → About ──────────────────────────────────────────────────────
  await page.keyboard.press(`${mod}+k`);
  await palette().waitFor();
  await palette().fill('> about');
  assert.match((await page.getByRole('option').first().textContent()) ?? '', /About Ordinate/);
  await page.keyboard.press('Enter');
  await page.waitForURL('**/about');
  await settled(page);
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  await page.getByTestId('about-version').filter({ hasText: `Version ${version}` }).waitFor();
  const count = Number(/^(\d+) packages$/.exec((await page.getByTestId('licence-count').textContent()) ?? '')?.[1]);
  assert.ok(count > 100, `${count} packages listed`);
  await page.getByLabel('Filter packages').fill('react-dom');
  await page.getByTestId('licence-count').filter({ hasText: /^2 of \d+ packages$/ }).waitFor();
  const reactDom = page.locator('details', { has: page.locator('summary', { hasText: /^react-dom/ }) });
  await reactDom.locator('summary').click();
  await reactDom.getByText(/Permission is hereby granted/).waitFor();
  await page.getByLabel('Filter packages').fill('');
  await screens(page, 'settings-about');

  // ── Palette: a record in the current project ─────────────────────────────
  await page.keyboard.press(`${mod}+k`);
  await palette().fill('/retail');
  const hit = page.getByRole('option', { name: /Retail orders/ });
  await hit.waitFor();
  await shotOpen(page, 'settings-palette', async () => {
    await page.keyboard.press(`${mod}+k`);
    await palette().fill('new');
    await page.getByRole('option').first().waitFor();
  });
  await page.keyboard.press(`${mod}+k`);
  await palette().fill('/retail');
  await page.getByRole('option', { name: /Retail orders/ }).click();
  await page.waitForURL(new RegExp(`/data/${server.sample.projectId}/[0-9a-f-]{36}$`));
  // ? → the shortcuts sheet, read off the same registry.
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+?');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByText('Command palette', { exact: true }).waitFor();
  await page.keyboard.press('Escape');

  // ── Organization → Workspace ─────────────────────────────────────────────
  await page.goto('/admin');
  await settled(page);
  await page.getByRole('heading', { name: 'This server keeps no accounts' }).waitFor();
  const money = page.getByTestId('fmt-money');
  assert.equal(await money.textContent(), '$5.2M');
  await page.getByRole('combobox', { name: 'Currency' }).click();
  await page.getByRole('option', { name: /^EUR/ }).click();
  await money.filter({ hasText: '€5.2M' }).waitFor();
  await page.reload();
  await settled(page);
  assert.equal(await page.getByTestId('fmt-money').textContent(), '€5.2M', 'kept by the server');
  await screens(page, 'settings-org-workspace');
  await page.getByRole('combobox', { name: 'Currency' }).click();
  await page.getByRole('option', { name: /^USD/ }).click();
  await money.filter({ hasText: '$5.2M' }).waitFor();

  // ── Themes ───────────────────────────────────────────────────────────────
  await page.getByRole('tab', { name: 'Themes' }).click();
  await page.getByText('No themes of your own yet').waitFor();
  await page.getByRole('button', { name: 'Duplicate Executive' }).click();
  const mine = page.getByRole('list', { name: 'Your themes' });
  await mine.getByRole('listitem', { name: 'Copy of Executive' }).waitFor();
  await mine.getByRole('button', { name: 'Edit' }).click();
  const series = page.getByLabel('Series 1 as hex');
  await series.fill('#f4f4f4');
  await series.press('Enter');
  await page.getByText(/under (its|their) contrast floor/).waitFor();
  await page.locator('[data-token="--chart-1"]').getByRole('note').waitFor();
  await page.screenshot({ path: path.join(SCREENS, 'settings-theme-editor-light.png'), fullPage: true });
  await series.fill('#7c3aed');
  await series.press('Enter');
  await page.getByLabel('Theme name').fill('Board pack');
  await page.getByRole('button', { name: 'Save theme' }).click();
  await mine.getByRole('listitem', { name: 'Board pack' }).waitFor();
  await page.getByRole('combobox', { name: 'Workspace theme' }).click();
  await page.getByRole('option', { name: 'Board pack' }).click();
  await mine.getByText('Workspace default').waitFor();
  await screens(page, 'settings-org-themes');

  // ── Backups: a real download, restored as a new project ──────────────────
  await page.getByRole('tab', { name: 'Backups' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
  assert.match(download.suggestedFilename(), /^Ordinate backup default \d{4}-\d{2}-\d{2}\.zip$/);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'ordinate-e2e-backup-')), download.suggestedFilename());
  await download.saveAs(file);
  await page.getByRole('button', { name: 'Restore from a backup…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore from a backup' });
  const go = dialog.getByRole('button', { name: 'Restore as new projects' });
  await dialog.locator('input[type=file]').setInputFiles(file);
  assert.equal(await go.isDisabled(), true, 'a file alone does not restore');
  await dialog.getByLabel('Type “restore” to confirm').fill('restore');
  await page.screenshot({ path: path.join(SCREENS, 'settings-restore-dialog-light.png'), animations: 'disabled' });
  await go.click();
  const restored = dialog.getByRole('list', { name: 'Restored projects' }).getByText(new RegExp(`^${server.sample.projectName} \\(restored `));
  await restored.waitFor({ timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await screens(page, 'settings-org-backups');
  await page.getByTestId('project-switcher').click();
  await page.getByText(new RegExp(`^${server.sample.projectName} \\(restored `)).first().waitFor();
  await page.keyboard.press('Escape');

  report(s);
});
