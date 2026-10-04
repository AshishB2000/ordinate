// Analyses and authoring (T2.8) against the real server:
//
//   the dashboards list with live previews → the create wizard (choose data,
//   start from a blank sheet) → the empty sheet → add a text card and a KPI
//   picked from the project's metrics (the server's figure) → a parameter
//   whose value the text card shows → move a card from the keyboard → the
//   autosave survives a reload → the phone layout (hide a card, the tray,
//   show it) → the sample dashboard drawn on the canvas, a filter control
//   narrows a KPI (a SECOND figure from the server), Properties, undo.
//   And the AI draft with no model says how to connect one.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled } from './fixtures.ts';

/** One screenshot per theme WITHOUT a reload (a dialog or a selection stays up). */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

/** The autosave has written everything (600 ms debounce, then the RPC). */
async function saved(page: Page): Promise<void> {
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
}

e2e('dashboards: list → wizard → blank sheet → text, KPI, parameter → keyboard move → saved → phone layout', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const list = page.getByRole('list', { name: 'Dashboards' });
  await list.getByText('Retail overview').waitFor();
  await page.getByText('1 dashboard').waitFor();
  // The previews are the first sheet's charts, drawn from the server's figures.
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Dashboards"] canvas').length >= 1);
  await screens(page, 'analyses-list');

  // ── The wizard ─────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Create dashboard' }).click();
  const wiz = page.getByRole('dialog', { name: 'Create dashboard' });
  await wiz.getByRole('radio', { name: /Retail orders/ }).click();
  assert.equal(await wiz.getByLabel('Dashboard name').inputValue(), 'Retail orders dashboard', 'the name follows the dataset until typed');
  await wiz.getByLabel('Dashboard name').fill('Quarterly review');
  await screensInPlace(page, 'analyses-wizard-data');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('radiogroup', { name: 'Templates' }).getByRole('radio').first().waitFor();
  // No model on this server: the AI card is not a choice, and says why.
  assert.equal(await wiz.getByRole('radio', { name: /Let the Assistant design it/ }).isDisabled(), true);
  await wiz.getByText('No model is connected.').waitFor();
  await screensInPlace(page, 'analyses-wizard-start');
  await wiz.getByRole('radio', { name: /Blank sheet/ }).click();
  await wiz.getByRole('button', { name: 'Create dashboard' }).click();
  await page.waitForURL(new RegExp(`/analyses/${pid}/[0-9a-f-]{36}$`));
  await page.getByRole('heading', { level: 1, name: 'Quarterly review' }).waitFor();
  await page.getByRole('heading', { name: 'This sheet is empty' }).waitFor();

  // ── Text and a KPI ─────────────────────────────────────────────────────
  await page.getByRole('group', { name: 'Add to the sheet' }).getByRole('button', { name: 'Text' }).click();
  const textDlg = page.getByRole('dialog', { name: 'Add text' });
  await textDlg.getByLabel('Heading (optional)').fill('Notes');
  await textDlg.getByLabel('Text (optional)').fill('Threshold is {{min}}.');
  await textDlg.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('group', { name: 'Notes card' }).waitFor();

  await page.getByRole('group', { name: 'Add to the sheet' }).getByRole('button', { name: 'KPI' }).click();
  const kpiDlg = page.getByRole('dialog', { name: 'Add a KPI' });
  const revenueRow = kpiDlg.getByRole('listitem').filter({ hasText: 'Revenue' }).first();
  await revenueRow.getByText('$5.2M').waitFor(); // metric:values — the server's display string
  await revenueRow.click();
  const kpi = page.getByRole('group', { name: 'Revenue card' });
  await kpi.getByText('$5.2M').waitFor();

  // ── A parameter, shown by the text card through {{min}} ────────────────
  await page.getByRole('button', { name: 'Control' }).click();
  await page.getByRole('menuitem', { name: 'Parameter…' }).click();
  const pDlg = page.getByRole('dialog', { name: 'Add a parameter' });
  await pDlg.getByLabel('Name').fill('min');
  await pDlg.getByLabel('Default').fill('250');
  await pDlg.getByRole('button', { name: 'Add parameter' }).click();
  await page.getByRole('group', { name: 'Filters' }).getByText('min').waitFor();
  await page.getByRole('group', { name: 'Notes card' }).getByText('Threshold is 250.').waitFor();

  // ── Move the text card from the keyboard; the autosave keeps it ────────
  const notes = page.getByRole('group', { name: 'Notes card' });
  const rowBefore = await notes.evaluate((el) => (el as HTMLElement).style.gridRow);
  await notes.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const rowAfter = await notes.evaluate((el) => (el as HTMLElement).style.gridRow);
  assert.notEqual(rowAfter, rowBefore, 'arrow keys move the focused card');
  await page.getByRole('button', { name: 'Undo Move card' }).waitFor();
  await saved(page);
  await page.reload();
  await settled(page);
  await page.getByRole('group', { name: 'Revenue card' }).getByText('$5.2M').waitFor();
  assert.equal(await page.getByRole('group', { name: 'Notes card' }).evaluate((el) => (el as HTMLElement).style.gridRow), rowAfter, 'the move was saved');
  await page.getByRole('group', { name: 'Notes card' }).getByText('Threshold is 250.').waitFor();

  // ── The phone layout: hide a card, find it in the tray, show it again ─
  await page.getByRole('button', { name: /^Phone layout/ }).click();
  await page.getByText('Phone preview · 390px.').waitFor();
  await page.getByRole('button', { name: 'Notes card actions' }).click();
  await page.getByRole('menuitem', { name: 'Hide on phone' }).click();
  const tray = page.getByRole('region', { name: 'Cards hidden on phone' });
  await tray.getByText('Notes').waitFor();
  await page.getByText('Edited', { exact: true }).waitFor();
  await screensInPlace(page, 'analyses-phone');
  await tray.getByRole('button', { name: 'Show Notes on phone' }).click();
  await page.getByRole('group', { name: 'Notes card' }).waitFor();
  await page.getByRole('button', { name: 'Reset to derived' }).click();
  await page.getByText('Derived', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Desktop layout/ }).click();
  await saved(page);

  // ── ⇧-select two cards, put them in a container, fold it ──────────────
  // The keyboard moved Notes onto the KPI's rows: click the part of it the KPI does not cover.
  await page.getByRole('group', { name: 'Revenue card' }).click({ position: { x: 40, y: 50 } });
  await page.getByRole('group', { name: 'Notes card' }).click({ position: { x: 700, y: 50 }, modifiers: ['Shift'] });
  const arrange = page.getByRole('toolbar', { name: 'Arrange selected cards' });
  await arrange.getByText('2 cards selected').waitFor();
  await arrange.getByRole('button', { name: 'Container' }).click();
  const box = page.getByRole('group', { name: 'Container card' });
  await box.waitFor();
  await page.getByRole('complementary', { name: 'Properties' }).getByLabel('Readers can collapse it').waitFor();
  await box.getByRole('button', { name: 'Collapse Container' }).click();
  await page.getByRole('group', { name: 'Notes card' }).waitFor({ state: 'detached' });
  await box.getByRole('button', { name: 'Expand Container' }).click();
  await page.getByRole('group', { name: 'Notes card' }).waitFor();
  await saved(page);
});

e2e('the sample dashboard on the canvas: a control narrows a KPI on the server, Properties, undo', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  await page.getByRole('link', { name: /Retail overview/ }).click();
  await page.getByRole('heading', { level: 1, name: 'Retail overview' }).waitFor();
  const revenue = page.getByRole('group', { name: 'Revenue card' });
  await revenue.getByText('$5.2M').waitFor();
  // Every chart card drew (canvases), and the map card is a MapLibre map.
  await page.waitForFunction(() => document.querySelectorAll('[data-card-id] canvas').length >= 2);
  await settled(page);
  await screens(page, 'analyses-editor');

  // A dropdown control on region: the KPI is recomputed by the server under it.
  await page.getByRole('button', { name: 'Control' }).click();
  await page.getByRole('menuitem', { name: 'Filter control…' }).click();
  const cDlg = page.getByRole('dialog', { name: 'Add a control' });
  await cDlg.getByRole('combobox', { name: 'Dataset' }).click();
  await page.getByRole('option', { name: 'Retail orders' }).click();
  await cDlg.getByRole('combobox', { name: 'Column' }).click();
  await page.getByRole('option', { name: 'region (text)' }).click();
  await cDlg.getByRole('button', { name: 'Add' }).click();
  const chip = page.getByRole('group', { name: 'Filters' });
  await chip.getByRole('combobox', { name: 'region' }).selectOption('East');
  await revenue.getByText('$5.2M').waitFor({ state: 'detached' });
  const narrowed = (await revenue.getByText(/^\$[\d.,]+[KMB]?$/).first().textContent()) ?? '';
  assert.match(narrowed, /^\$\d/, `a narrowed figure from the server, got ${narrowed}`);
  assert.notEqual(narrowed, '$5.2M');

  // Selecting a card opens its Properties; a visual's fields are the builder's.
  await page.getByRole('group', { name: 'Revenue by month card' }).click({ position: { x: 200, y: 120 } });
  const props = page.getByRole('complementary', { name: 'Properties' });
  await props.getByRole('link', { name: 'Edit in the Visuals builder' }).waitFor();
  await screensInPlace(page, 'analyses-properties');

  // Undo takes the control away again (an ordinary edit).
  await page.getByRole('button', { name: 'Undo Add control' }).click();
  await revenue.getByText('$5.2M').waitFor();
  await saved(page);
  // Measured, not asserted beyond the fixture's budget: RPCs per page load.
  console.log('rpc per load:', rpc.loads.map((l) => `${new URL(l.url).pathname} ${l.rpcs}`).join(' · '));
});

e2e('draft with the Assistant, no model: the dialog says how to connect one', async ({ page, server }) => {
  await page.goto(`/analyses?project=${server.sample.projectId}`);
  await settled(page);
  await page.getByRole('button', { name: 'Draft with the Assistant' }).click();
  const dlg = page.getByRole('dialog', { name: 'Assistant draft — review before creating' });
  await dlg.getByRole('heading', { name: 'Connect a model to draft' }).waitFor();
  await dlg.getByRole('button', { name: 'Close' }).first().click();
});

e2e('metrics: the table from the server, a new metric with a live preview and a filter, delete to Trash', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/data/metrics?project=${pid}`);
  await settled(page);
  const table = page.getByRole('table');
  const revenue = table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Revenue', exact: true }) });
  await revenue.getByRole('cell', { name: '$5.2M' }).waitFor(); // metric:value's display, through metric:table
  await revenue.getByRole('img', { name: 'Revenue trend' }).waitFor(); // metric:series
  await revenue.getByText(/card/).waitFor(); // metric:usage — the sample dashboard's KPI uses it
  await page.getByText('6 metrics').waitFor();
  await screens(page, 'metrics-table');

  await page.getByRole('button', { name: 'New metric' }).click();
  const dlg = page.getByRole('dialog', { name: 'New metric' });
  await dlg.getByLabel('Name').fill('Large orders');
  await dlg.getByRole('combobox', { name: 'Dataset' }).click();
  await page.getByRole('option', { name: 'Retail orders' }).click();
  await dlg.getByRole('combobox', { name: 'Column', exact: true }).click();
  await page.getByRole('option', { name: 'revenue (number)' }).click();
  await dlg.getByRole('radio', { name: 'Count' }).click();
  await dlg.getByRole('combobox', { name: 'Filter column' }).click();
  await page.getByRole('option', { name: 'revenue', exact: true }).click();
  await dlg.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: '>', exact: true }).click();
  await dlg.getByLabel('Filter value').fill('1000');
  await dlg.getByRole('button', { name: 'Add filter' }).click();
  const preview = dlg.getByRole('complementary', { name: 'Preview' });
  await preview.getByText(/revenue > 1000/).waitFor(); // the server's own words for the definition
  const figure = (await preview.getByText(/^[\d,.]+[KM]?$/).first().textContent()) ?? '';
  assert.match(figure, /^\d/, `a figure computed by the server, got ${figure}`);
  await screensInPlace(page, 'metrics-editor');
  await dlg.getByRole('button', { name: 'Create metric' }).click();
  const row = table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Large orders' }) });
  await row.getByRole('cell', { name: figure }).waitFor();

  await page.getByRole('button', { name: 'Actions for Large orders' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete “Large orders”?' });
  await confirm.getByText('Nothing uses it yet.').waitFor();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await page.getByText('Moved “Large orders” to Trash').waitFor();
  await row.waitFor({ state: 'detached' });
});
