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

e2e('dashboards: list → wizard → blank sheet → text, KPI, parameter → keyboard move → saved → phone layout', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const list = page.getByRole('list', { name: 'Dashboards' });
  await list.getByText('Retail overview').waitFor();
  await page.getByText('1 dashboard').waitFor();
  // The previews are the first sheet's charts, drawn from the server's figures.
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Dashboards"] canvas').length >= 1);
  await screens(page, 'analyses-list');
  // Measured: RPCs for the list's load, then for the wizard (steps 1–2, no URL change).
  const listRpcs = rpc.loads.at(-1)?.rpcs ?? 0;

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
  await wiz.getByText(/AI isn’t set up for your organization yet/).waitFor();
  console.log(`rpc: list load ${listRpcs} · wizard (open → Start from) ${(rpc.loads.at(-1)?.rpcs ?? 0) - listRpcs}`);
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
  // On a phone the chips fold into "Filters (N)" and a sheet (layoutFilters.ts).
  await page.getByRole('button', { name: 'Filters: 1 control, 0 active' }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await sheet.getByText('1 on this page · showing everything').waitFor();
  await screensInPlace(page, 'analyses-phone-filters');
  await sheet.getByRole('button', { name: 'Done' }).click();
  await sheet.waitFor({ state: 'detached' });
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
  console.log(`rpc: canvas load (sample dashboard, client-side open) ${rpc.loads.at(-1)?.rpcs ?? 0}`);
  // The sample sheet is one the app built, so click-to-filter is on: its row is there, idle (dashboards.e2e.ts clicks it).
  await page.getByRole('group', { name: 'Click filters' }).getByText('Click a mark on a chart to filter the other cards.').waitFor();
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
  // On the card's head: the sample sheet has click-to-filter on, so a click that landed on a mark would also filter.
  await page.getByRole('group', { name: 'Revenue by month card' }).click({ position: { x: 200, y: 16 } });
  const props = page.getByRole('complementary', { name: 'Properties' });
  await props.getByRole('link', { name: 'Edit in the Visuals builder' }).waitFor();
  await screensInPlace(page, 'analyses-properties');

  // The chart's figures as an accessible table, and back (tileActions.ts "View as table").
  await page.getByRole('button', { name: 'Revenue by month card actions' }).click();
  await page.getByRole('menuitem', { name: 'View as table' }).click();
  await page.getByRole('group', { name: 'Revenue by month card' }).getByRole('table').waitFor();
  await page.getByRole('button', { name: 'Revenue by month card actions' }).click();
  await page.getByRole('menuitem', { name: 'View as chart' }).click();
  await page.getByRole('group', { name: 'Revenue by month card' }).locator('canvas').waitFor();

  // Undo takes the control away again (an ordinary edit).
  await page.getByRole('button', { name: 'Undo Add control' }).click();
  await revenue.getByText('$5.2M').waitFor();
  await saved(page);
  // Measured, not asserted beyond the fixture's budget: RPCs per page load.
  console.log('rpc per load:', rpc.loads.map((l) => `${new URL(l.url).pathname} ${l.rpcs}`).join(' · '));
});

e2e('the rail’s "Calculated field" opens the dialog in place, over the selected card’s dataset', async ({ page, server }) => {
  await page.goto(`/analyses?project=${server.sample.projectId}`);
  await settled(page);
  await page.getByRole('link', { name: /Retail overview/ }).click();
  await page.getByRole('heading', { level: 1, name: 'Retail overview' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-card-id] canvas').length >= 2);
  const here = page.url();
  await page.getByRole('group', { name: 'Revenue by month card' }).click({ position: { x: 200, y: 120 } });
  await page.getByRole('navigation', { name: 'Authoring panels' }).getByRole('button', { name: 'Data' }).click();
  await page.getByRole('button', { name: 'Calculated field' }).click();
  // No trip to Prepare: both kinds, the measure editor ready, the dataset's metrics on offer.
  const calc = page.getByRole('dialog', { name: 'New calculated field' });
  await calc.getByRole('radio', { name: /^Column \(calculated on every row\)/ }).waitFor();
  await calc.getByLabel('Formula').waitFor();
  await calc.getByRole('button', { name: 'Margin %', exact: true }).waitFor();
  assert.equal(page.url(), here, 'the dialog opened in place');
  await screensInPlace(page, 'analyses-calculated-field');
  await calc.getByRole('button', { name: 'Cancel' }).click();
  await calc.waitFor({ state: 'detached' });
});

e2e('draft with the Assistant, no model: the door is shut and says why', async ({ page, server }) => {
  await page.goto(`/analyses?project=${server.sample.projectId}`);
  await settled(page);
  const draft = page.getByRole('button', { name: 'Draft with the Assistant' });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Draft with the Assistant'));
    return !!b && b.disabled && /AI isn’t set up for your organization/.test(b.title);
  });
  assert.equal(await draft.isDisabled(), true);
});

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

/** A 2×1 PNG (the server reads its aspect from the header). */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e8dd0000000f49444154789c63504d7e2db0b3110008a302be3e2b6cf00000000049454e44ae426082', 'hex');

e2e('card kinds: a statistics card recomputed by the server, an uploaded image, a navigation strip', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
  const made = await call(page, 'analysis:create', { projectId: pid, name: 'Kinds' });
  const added = await call(page, 'stats:addToDashboard', { projectId: pid, analysisId: made.id, spec: { kind: 'groups', datasetId: ds, outcome: 'revenue', group: 'region' }, view: 'table' });
  assert.equal(added.ok, true, JSON.stringify(added));
  await page.goto(`/analyses/${pid}/${made.id}`);
  await settled(page);

  // Statistics: the table cells are the server's strings (stats:tile through analysis:tiles).
  const stats = page.getByRole('group', { name: 'revenue by region card' });
  await stats.getByRole('table').waitFor();
  await stats.getByRole('rowheader', { name: 'East', exact: true }).waitFor();

  // An image: picked, uploaded (T0.4), copied into the project, drawn from a data: URL.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Image…' }).click();
  await (await chooser).setFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  const image = page.getByRole('group', { name: 'Image card' });
  await image.locator('img[src^="data:image/png;base64,"]').waitFor();
  await page.getByRole('complementary', { name: 'Properties' }).getByLabel('Alt text').fill('Company logo');
  await page.getByRole('group', { name: 'Company logo card' }).locator('img[alt="Company logo"]').waitFor();

  // A navigation strip: buttons to the project's other dashboards.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Navigation' }).click();
  const nav = page.getByRole('group', { name: 'Navigation card' });
  await nav.getByRole('button', { name: 'Retail overview' }).waitFor();
  await page.getByRole('complementary', { name: 'Properties' }).getByText('Button 1').waitFor();
  await saved(page);
  await screens(page, 'analyses-kinds');
  await nav.getByRole('button', { name: 'Retail overview' }).click();
  await page.getByRole('heading', { level: 1, name: 'Retail overview' }).waitFor();
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
  // The builder's filter rows and typed dialog: a number column is a range, typed on its declared type by the server.
  await dlg.getByRole('button', { name: 'Add filter' }).click();
  await dlg.getByRole('combobox', { name: 'Filter column' }).click();
  await page.getByRole('option', { name: 'revenue', exact: true }).click();
  await dlg.getByRole('button', { name: 'Edit the filter on revenue' }).click();
  const fdlg = page.getByRole('dialog', { name: 'Filter: revenue' });
  await fdlg.getByLabel('Minimum').fill('1000');
  await fdlg.getByRole('button', { name: 'Apply' }).click();
  await fdlg.waitFor({ state: 'detached' });
  const preview = dlg.getByRole('complementary', { name: 'Preview' });
  await preview.getByText(/where revenue/).waitFor(); // the server's own words for the definition, with the filter
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
