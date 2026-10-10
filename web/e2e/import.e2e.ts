// Import, the composer and input tables (T2.4) against the real server:
//
//   1. a CSV is uploaded (POST /api/files → dataset:pickAndParse), opens in the
//      composer, a saved dataset is joined on (key guessed), the join is
//      removed again, a column is renamed and another dropped and restored on
//      the preview's header, and Save lands on the new dataset's page;
//   2. pasted cells parse, stage and save;
//   3. an input table is defined from a template, typed into (the server
//      flags a required cell and a non-number), undone, and saved;
//   4. the designed states: the screenshot source with no model configured,
//      an empty Captures tab — in the current project when the URL names none.
//
// Every page is inside the RPC budget and fails on a console error. Screens in
// both themes go to web/e2e/__screens__/import-*.png.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled } from './fixtures.ts';

const REGIONS = 'region,target\nEast,100\nWest,200\nSouth,150\nNorth,50\n';

/**
 * Both themes of a state that lives in memory (the composer, an open
 * dialog): the fixture's `screens()` reloads, which would lose it. The theme
 * is switched the way theme.ts applies it — the attribute on <html>.
 */
async function screensInPlace(page: Page, name: string): Promise<void> {
  const prev = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light');
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(150); // let transitions on the tokens settle
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), prev);
}

const grid = (page: Page, name: string) => page.getByRole('grid', { name });
const colCount = async (page: Page, name: string) => Number(await grid(page, name).getAttribute('aria-colcount'));

e2e('import: upload a CSV → composer: join, unjoin, rename, drop + restore → save', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/data/import?project=${pid}`);
  await settled(page);
  assert.equal(await page.getByRole('button', { name: /Upload a file/ }).getAttribute('aria-pressed'), 'true');
  await screens(page, 'import-sources');

  await page.getByRole('region', { name: 'Upload a file' }).locator('input[type="file"]').setInputFiles({ name: 'regions.csv', mimeType: 'text/csv', buffer: Buffer.from(REGIONS) });
  await page.getByRole('heading', { level: 1, name: 'New dataset' }).waitFor();
  await page.getByText('4 rows · 2 columns').waitFor();
  assert.equal(await page.getByLabel('Dataset name').inputValue(), 'regions');
  await grid(page, 'Preview').getByText('West').waitFor();

  // Join the sample dataset: `region` matches by name, so the key is guessed.
  const sources = page.getByRole('complementary', { name: 'Sources' });
  await sources.getByRole('button', { name: /Retail orders/ }).click();
  const badge = page.getByRole('button', { name: 'Inner join with Retail orders' });
  await badge.waitFor();
  await page.waitForFunction(() => Number(document.querySelector('[role="grid"][aria-label="Preview"]')?.getAttribute('aria-colcount')) > 2);
  const counted = page.getByText(/^[\d,]+ rows · 14 columns$/);
  await counted.waitFor(); // the server's fold: Retail orders' East/West/South rows, both tables' columns
  const inner = Number((await counted.textContent())?.split(' ')[0]?.replace(/,/g, ''));
  await badge.click();
  const pop = page.getByRole('dialog', { name: 'Join Retail orders' });
  await pop.getByRole('radio', { name: 'Left' }).click();
  await page.getByRole('button', { name: 'Left join with Retail orders' }).waitFor();
  // A left join keeps the one region Retail orders lacks (North): one row more, counted by the server.
  await page.getByText(`${(inner + 1).toLocaleString('en-US')} rows · 14 columns`).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await screensInPlace(page, 'import-composer-join');
  await page.keyboard.press('Escape');

  // Remove it again (the chain is a fold: the confirm says what goes with it).
  await page.getByRole('button', { name: 'Remove Retail orders' }).click();
  await page.getByRole('dialog', { name: 'Remove “Retail orders”?' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByText('4 rows · 2 columns').waitFor();

  // The header is the field mapper: rename `target`, drop and restore `region`.
  await page.getByRole('columnheader').filter({ hasText: 'target' }).click();
  const menu = page.getByRole('dialog', { name: 'Column target' });
  await menu.getByLabel('Name', { exact: true }).fill('goal');
  await menu.getByLabel('Name', { exact: true }).press('Enter');
  await page.keyboard.press('Escape');
  await page.getByRole('columnheader').filter({ hasText: 'goal' }).waitFor();
  await page.getByRole('columnheader').filter({ hasText: 'region' }).click();
  await page.getByRole('dialog', { name: 'Column region' }).getByRole('button', { name: 'Drop column' }).click();
  await page.getByText('4 rows · 1 column').waitFor();
  assert.equal(await colCount(page, 'Preview'), 1);
  await page.getByRole('group', { name: 'Dropped columns' }).getByRole('button', { name: 'region' }).click();
  await page.getByText('4 rows · 2 columns').waitFor();
  await screensInPlace(page, 'import-composer');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL((u) => new RegExp(`^/data/${pid}/[0-9a-f-]{36}$`).test(u.pathname));
  await page.getByRole('heading', { level: 1, name: 'regions' }).waitFor();
  await page.getByText('4 rows · 2 columns').waitFor();
  assert.ok(await page.getByRole('columnheader').filter({ hasText: 'goal' }).isVisible(), 'the rename was saved as a step');
  for (const l of rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}${new URL(l.url).search}`);
});

e2e('import: paste cells → composer → save', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/data/import?project=${pid}&source=paste`);
  await settled(page);
  await page.getByLabel('Paste a table').fill('city\tvisits\nOslo\t12\nLima\t7\n');
  await screensInPlace(page, 'import-paste');
  await page.getByRole('button', { name: 'Parse' }).click();
  await page.getByText('2 rows · 2 columns').waitFor();
  await page.getByLabel('Dataset name').fill('Visits');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Visits' }).waitFor();
  await page.getByText('2 rows · 2 columns').waitFor();
});

e2e('input table: define from a template, type, get flagged, undo, saved', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/data/import?project=${pid}&source=input`);
  await settled(page);
  await page.getByRole('button', { name: 'Define the columns' }).click();
  const dlg = page.getByRole('dialog', { name: 'New input table' });
  await dlg.getByRole('button', { name: /Targets/ }).click();
  assert.equal(await dlg.getByLabel('Name', { exact: true }).inputValue(), 'Targets');
  await screensInPlace(page, 'import-input-define');
  await dlg.getByRole('button', { name: 'Create table' }).click();
  await page.waitForURL((u) => u.pathname.startsWith(`/data/input/${pid}/`));
  await page.getByRole('heading', { level: 1, name: 'Targets' }).waitFor();
  await page.getByText('No rows yet').waitFor();

  const g = grid(page, 'Targets, editable');
  // Type into the new-row line: region, then (Tab) skip month, a non-number target.
  await g.locator('[data-row="0"][data-col="0"]').click();
  await page.keyboard.type('East');
  await page.keyboard.press('Enter');
  await page.getByText('Saved · 1 row').waitFor();
  // `target` is required: the server flags the empty cell.
  await page.getByRole('button', { name: /1 cell needs attention/ }).waitFor();
  await g.locator('[data-row="0"][data-col="2"]').click();
  await page.keyboard.type('lots');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-row="0"][data-col="2"]')?.getAttribute('aria-invalid') === 'true'
    && document.querySelector('[data-row="0"][data-col="2"]')?.textContent === 'lots');
  await page.getByText('Saved · 1 row').waitFor();
  assert.match((await g.locator('[data-row="0"][data-col="2"]').getAttribute('title')) ?? '', /number/i);
  await screensInPlace(page, 'import-input-table');

  // Undo the last edit; then a real value clears the flag.
  await page.getByRole('button', { name: /^Undo edit target/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-row="0"][data-col="2"]')?.textContent === '');
  await g.locator('[data-row="0"][data-col="2"]').click();
  await page.keyboard.type('120');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('[aria-invalid="true"]'));
  await page.getByText('Saved · 1 row').waitFor();
  await page.reload();
  await settled(page);
  await g.locator('[data-row="0"][data-col="0"]').getByText('East').waitFor();
  assert.equal(await g.locator('[data-row="0"][data-col="2"]').textContent(), '120', 'the edits were stored');
});

e2e('designed states: no model, no captures (in the current project)', async ({ page, server }) => {
  // No ?project=: the importer works in the current project (T2.2 — here the only one).
  await page.goto('/data/import');
  await settled(page);
  await page.getByRole('heading', { level: 1, name: 'Bring data in' }).waitFor();

  await page.getByRole('button', { name: /Upload or paste a screenshot/ }).click();
  await page.getByRole('heading', { name: 'Reading a screenshot needs AI' }).waitFor();
  await page.getByText(/AI isn’t set up for your organization yet/).waitFor();
  // The dev admin on a server with no database: what the operator sets, not a button to a tab that cannot help.
  await page.getByText(/An operator sets DATABASE_URL and ORDINATE_MASTER_KEY/).waitFor();
  await screens(page, 'import-screenshot-not-ready');

  await page.goto(`/data/captures?project=${server.sample.projectId}`);
  await settled(page);
  await page.getByRole('heading', { name: 'No captures yet' }).waitFor();
  await screens(page, 'import-captures-empty');
});
