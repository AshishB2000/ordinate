// Analytics workbenches B (T2.11) against the real server: the sample project
// plus seed-analyticsB.ts ("Web events" for the cohort and the funnel, and an
// "Orders feed" refreshed twice, so it keeps two snapshots):
//
//   1. /analytics — the new doors (pivot, cohorts, funnel, insights, snapshots, SQL, events);
//   2. Pivot — the shelves replace the encoding form, a date rolled up by month,
//      a column dimension added, a header click re-asks the SERVER sorted, Save;
//   3. Cohort and event funnel — their shelves, the grid, steps from the event
//      column's own values (dataset:distinct);
//   4. Snapshots — the kept versions with the server's "vs now", Compare (whole
//      row, then by key), "As of" in the builder, Restore;
//   5. Events — the empty state, New event, CSV import, a holiday calendar, Delete;
//   6. Insights — the dataset tab grouped by kind, Dismiss; Home's "What stands out";
//   7. SQL — run with a bound [[parameter]], Explain, a file read refused by the
//      server's gate, Save as dataset through the composer, View query.
//
// Every page fails on a console error and stays inside the RPC budget. Screens
// in both themes go to web/e2e/__screens__/analyticsB-*.png.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Request } from 'playwright';
import { e2e, SCREENS, screens, settled, type Session } from './fixtures.ts';

const SEED = fileURLToPath(new URL('./seed-analyticsB.ts', import.meta.url));
let seeded: { eventsId: string; feedId: string } | null = null;

/** The extra datasets, seeded once per server (the spec's tests share it, in order). */
function seed(s: Session): { eventsId: string; feedId: string } {
  if (seeded) return seeded;
  const r = spawnSync(process.execPath, [SEED, s.server.dataDir, s.server.sample.projectId], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`seed-analyticsB failed:\n${r.stderr || r.stdout}`);
  seeded = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { eventsId: string; feedId: string };
  return seeded;
}

/** Both themes of a state that lives in memory (an open comparison, a sorted grid): screens() reloads. */
async function screensInPlace(page: Page, name: string): Promise<void> {
  const prev = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light');
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300); // charts and grids re-read their colours on a theme flip
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), prev);
}

const idle = (page: Page) => page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));

function report(s: Session): void {
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
}

/** Picks `option` in the UI kit Select labelled `label`. */
async function pick(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** The next request to `channel` whose body passes `test`. */
const rpcRequest = (page: Page, channel: string, test: (body: string) => boolean = () => true) =>
  page.waitForRequest((r: Request) => decodeURIComponent(r.url()).endsWith(`/api/rpc/${channel}`) && test(r.postData() ?? ''));

/** Opens a hub door on `dataset`. */
async function door(page: Page, pid: string, dataset: string, link: string): Promise<void> {
  await page.goto(`/analytics?project=${pid}`);
  await settled(page);
  await pick(page, 'Dataset', dataset);
  await page.getByRole('link', { name: link }).click();
}

e2e('analytics B: the hub offers the new doors', async (s) => {
  seed(s);
  const { page, server } = s;
  await page.goto(`/analytics?project=${server.sample.projectId}`);
  await settled(page);
  for (const name of ['Pivot table', 'Cohorts', 'Event funnel', 'Insights', 'Snapshots', 'SQL query', 'Events']) {
    await page.getByRole('heading', { level: 2, name, exact: true }).waitFor();
  }
  await screens(page, 'analyticsB-hub');
  report(s);
});

e2e('pivot: shelves, a month roll-up, a column dimension, a server-sorted header, Save', async (s) => {
  seed(s);
  const { page, server } = s;
  const pid = server.sample.projectId;
  await door(page, pid, 'Retail orders', 'New pivot table');
  await page.waitForURL(new RegExp(`/visuals/${pid}/new\\?dataset=`));
  await settled(page);
  // The shelves REPLACE Category / Measures; the first dimension and measure are on them.
  const rows = page.getByRole('group', { name: 'Rows' });
  await rows.getByText('order_date', { exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Category (dimension)' }).count(), 0);
  // Roll the date up by month, then add region across.
  let asked = rpcRequest(page, 'visual:preview', (b) => b.includes('"grain":"month"'));
  await pick(page, 'Roll order_date up by', 'Month');
  await asked;
  asked = rpcRequest(page, 'visual:preview', (b) => b.includes('"columns":[{"column":"region"}]'));
  await page.getByRole('button', { name: 'Add a field to Columns' }).click();
  await page.getByRole('menuitem', { name: 'region', exact: true }).click();
  await asked;
  const grid = page.getByRole('table', { name: /by order_date|units/ });
  await grid.waitFor();
  await page.getByRole('rowheader').first().waitFor();
  // A header click is a question to the server — the browser never sorts the cells.
  await page.getByRole('columnheader', { name: /East/ }).waitFor(); // region runs across now
  asked = rpcRequest(page, 'visual:preview', (b) => /"sort":\{"by":\d+,"dir":"desc"\}/.test(b));
  await page.getByRole('button', { name: /^Sort by East/ }).click();
  await asked;
  await idle(page);
  await page.getByText(/^Column \d+, descending$/).waitFor();
  await page.getByRole('button', { name: 'Sort by East, descending' }).waitFor(); // the server's reply says it is sorted
  await screensInPlace(page, 'analyticsB-pivot');
  // The corner sorts by the row labels: a visible "Label", and again a question to the server.
  const corner = page.getByRole('button', { name: /^Sort by label/ });
  assert.equal((await corner.innerText()).trim().toLowerCase().startsWith('label'), true);
  asked = rpcRequest(page, 'visual:preview', (b) => b.includes('"sort":{"by":"label","dir":"asc"}'));
  await corner.click();
  await asked;
  await idle(page);
  await page.getByText('Row labels, ascending').waitFor();
  await page.getByRole('button', { name: 'Sort by label, ascending' }).waitFor();

  // "Use a metric…": a formula metric is refused and says why; a column metric fills the value, named for it.
  const openPicker = async () => {
    await page.getByRole('button', { name: /^Options for (Sum of units|Revenue)$/ }).click();
    await page.getByRole('menuitem', { name: /^(Use a|Change) metric…$/ }).click();
    return page.getByRole('dialog', { name: 'Use a metric' });
  };
  let picker = await openPicker();
  await picker.getByRole('button', { name: /^Margin %/ }).waitFor();
  await picker.getByRole('button', { name: /^Margin %/ }).click();
  await page.getByText('"Margin %" is a formula metric. Every pivot cell is a column rolled up within a group — use it on a KPI card instead.').waitFor();
  picker = await openPicker();
  await picker.getByText('$', { exact: true }).first().waitFor(); // a row's format badge; its figure is metric:values' display
  await idle(page);
  await screensInPlace(page, 'analyticsB-metric-picker');
  asked = rpcRequest(page, 'visual:preview', (b) => b.includes('"column":"revenue","aggregation":"sum"') && b.includes('"metricId":'));
  await picker.getByRole('button', { name: /^Revenue/ }).click();
  await asked;
  await page.getByRole('group', { name: 'Values' }).getByText('Revenue', { exact: true }).waitFor();

  // Save: the pivot block is what is stored.
  const saved = rpcRequest(page, 'visual:save', (b) => b.includes('"chartType":"pivot"') && b.includes('"pivot":{'));
  await page.getByRole('button', { name: 'Save visual' }).click();
  const dialog = page.getByRole('dialog', { name: 'Name this visual' });
  await dialog.getByLabel('Name').fill('Units by month and region');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await saved;
  await page.waitForURL(new RegExp(`/visuals/${pid}$`));
  report(s);
});

e2e('cohort and event funnel: their shelves, the grid, steps from the server', async (s) => {
  const { eventsId } = seed(s);
  const { page, server } = s;
  const pid = server.sample.projectId;
  await door(page, pid, 'Web events', 'New cohort grid');
  await page.waitForURL(new RegExp(`/visuals/${pid}/new\\?dataset=${eventsId}`));
  await settled(page);
  assert.match(await page.getByRole('combobox', { name: 'Entity' }).innerText(), /user_id/);
  assert.match(await page.getByRole('combobox', { name: 'Event date' }).innerText(), /event_time/);
  await page.getByRole('region', { name: 'Cohort table' }).waitFor();
  await idle(page);
  await screensInPlace(page, 'analyticsB-cohort');

  await door(page, pid, 'Web events', 'New event funnel');
  await settled(page);
  assert.match(await page.getByRole('combobox', { name: 'Event name' }).innerText(), /event/);
  for (const step of ['visit', 'browse', 'purchase']) {
    await page.getByRole('button', { name: 'Add step' }).click();
    await page.getByRole('menuitem', { name: step, exact: true }).click();
  }
  await page.getByRole('img', { name: /^Step 3, purchase: \d+ entities/ }).or(page.getByLabel(/^Step 3, purchase: /)).first().waitFor();
  await idle(page);
  await screensInPlace(page, 'analyticsB-funnel');
  report(s);
});

e2e('snapshots: kept versions, compare, as of in the builder, restore', async (s) => {
  const { feedId } = seed(s);
  const { page, server } = s;
  const pid = server.sample.projectId;
  await page.goto(`/data/${pid}/${feedId}?tab=snapshots`);
  await settled(page);
  await page.getByRole('heading', { level: 2, name: 'Snapshots' }).waitFor();
  await page.getByText('2 kept · each is the table as it was before a refresh replaced it').waitFor();
  // "vs now" is the server's delta: the newest snapshot has 3 rows, the table 4.
  await page.getByText('+1 since').waitFor();
  await page.getByRole('button', { name: 'Compare' }).first().click();
  const panel = page.getByRole('region', { name: 'Comparison' });
  await panel.getByText(/2\s+added/).waitFor();
  await panel.getByText('Matched on the whole row: a row with any cell different reads as one removed and one added.').waitFor();
  await pick(page, 'Match rows by', 'region');
  await panel.getByText(/1\s+changed/).waitFor();
  await panel.getByRole('heading', { name: 'Changed · 1' }).waitFor();
  await screensInPlace(page, 'analyticsB-snapshots');

  // "As of" in the builder: the chart as the oldest snapshot held it, read in full through visual:data.
  await page.goto(`/visuals/${pid}/new?dataset=${feedId}`);
  await settled(page);
  const asOf = rpcRequest(page, 'visual:data', (b) => b.includes('"asOf"'));
  await page.getByRole('combobox', { name: 'Show the data as of' }).click();
  await page.getByRole('option').last().click();
  await asOf;
  await idle(page);

  // Restore the oldest: the data goes back, the current table is kept first.
  await page.goto(`/data/${pid}/${feedId}?tab=snapshots`);
  await settled(page);
  await page.getByRole('button', { name: 'Restore…' }).last().click();
  const dlg = page.getByRole('dialog', { name: 'Restore this snapshot?' });
  await dlg.getByRole('button', { name: 'Restore' }).click();
  await page.getByText(/^Restored the data as of /).waitFor();
  await page.getByText('3 kept · each is the table as it was before a refresh replaced it').waitFor();
  report(s);
});

e2e('events: empty state, new event, CSV import, a holiday calendar, delete', async (s) => {
  seed(s);
  const { page, server } = s;
  const pid = server.sample.projectId;
  await page.goto(`/analytics/${pid}/events`);
  await settled(page);
  await page.getByRole('heading', { name: 'No events yet' }).waitFor();
  await screens(page, 'analyticsB-events-empty');

  await page.getByRole('button', { name: 'New event' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Black Friday');
  await dlg.getByRole('radio', { name: 'Campaign' }).click();
  await dlg.getByLabel('Starts').fill('2024-11-29');
  await dlg.getByLabel('Ends').fill('2024-12-02');
  await dlg.getByRole('button', { name: 'Add event' }).click();
  await page.getByText('Added "Black Friday" — every date axis it falls on now marks it.').waitFor();
  const row = page.getByRole('row', { name: /Black Friday/ });
  await row.getByText('4 days · drawn as a band').waitFor(); // the server's count
  await row.getByText(/Nov 29/).waitFor(); // the server's "when"

  const csv = path.join(os.tmpdir(), `events-${process.pid}.csv`);
  writeFileSync(csv, 'date,end,title,kind\n2024-03-04,,v2 launch,launch\n2024-06-10,2024-06-11,Checkout outage,incident\nnope,,Broken,other\n');
  await page.getByLabel('Events CSV file').setInputFiles(csv);
  await page.getByText(/^Imported 2 events from events-\d+\.csv · 1 row skipped/).waitFor();
  await page.getByRole('row', { name: /Checkout outage/ }).waitFor();

  const us = page.getByRole('switch').first();
  await us.check();
  await page.getByText(/holidays now mark every date axis\.$/).waitFor();
  await page.getByRole('button', { name: /^Incident/ }).click(); // the kind filter
  assert.equal(await page.getByRole('row', { name: /Black Friday/ }).count(), 0);
  await page.getByRole('button', { name: /^All/ }).click();
  await screens(page, 'analyticsB-events');

  await page.getByRole('button', { name: 'Delete v2 launch' }).click();
  await page.getByRole('dialog', { name: 'Delete "v2 launch"?' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByText('Deleted "v2 launch".').waitFor();
  assert.equal(await page.getByRole('row', { name: /v2 launch/ }).count(), 0);
  report(s);
});

e2e('insights: the dataset tab grouped by kind, dismiss; Home shows what stands out', async (s) => {
  seed(s);
  const { page, server } = s;
  const pid = server.sample.projectId;
  await door(page, pid, 'Retail orders', 'Open insights');
  await settled(page);
  await page.getByRole('tab', { name: 'Insights', selected: true }).waitFor();
  const cards = page.locator('article[data-insight-id]');
  await cards.first().waitFor();
  const before = await cards.count();
  assert.ok(before > 1, `insights on the sample: ${before}`);
  await idle(page);
  await screens(page, 'analyticsB-insights');
  const gone = await cards.first().getAttribute('data-insight-id');
  const dismissed = rpcRequest(page, 'insights:dismiss');
  await cards.first().getByRole('button', { name: 'Dismiss this insight' }).click();
  await dismissed;
  await page.waitForFunction((id) => !document.querySelector(`article[data-insight-id="${CSS.escape(String(id))}"]`), gone);

  await page.goto('/');
  await settled(page);
  const row = page.getByRole('region', { name: 'What stands out' });
  await row.locator('article').first().waitFor();
  assert.equal(await row.locator(`article[data-insight-id="${gone}"]`).count(), 0, 'a dismissed card stays gone on Home');
  await idle(page);
  await screens(page, 'analyticsB-home-insights');
  report(s);
});

e2e('sql: a bound parameter, explain, a refused file read, save as dataset, view query', async (s) => {
  seed(s);
  const { page, server } = s;
  const pid = server.sample.projectId;
  await page.goto(`/analytics?project=${pid}`);
  await settled(page);
  await page.getByRole('link', { name: 'Open SQL' }).click();
  await page.waitForURL(new RegExp(`/analytics/${pid}/sql$`));
  await settled(page);
  const tree = page.getByRole('tree', { name: 'Datasets and columns' });
  await tree.getByText('retail_orders', { exact: true }).waitFor();
  const editor = page.getByRole('combobox', { name: 'SQL' });

  const sql = 'select category, sum(revenue) as revenue\nfrom retail_orders\nwhere region = [[r]]\ngroup by 1\norder by 2 desc';
  await editor.fill(sql);
  await page.getByLabel('Value of r').fill('West');
  const ran = rpcRequest(page, 'sql:run', (b) => b.includes('[[r]]') && b.includes('"value":"West"'));
  await page.getByRole('button', { name: 'Run' }).click();
  await ran; // the text as typed and the value apart: bound on the server, never spliced
  await page.getByText(/^3 rows · \d+ ms$/).waitFor();
  await page.getByRole('grid', { name: 'Query results' }).waitFor();
  await page.getByRole('button', { name: 'Explain' }).click();
  await page.getByText('Valid · returns 2 columns').waitFor();
  await idle(page);
  await screensInPlace(page, 'analyticsB-sql');

  // The server's gate: a filesystem read is refused, nothing comes back.
  await editor.fill("select * from read_csv('/etc/passwd')");
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByText("Only this project's datasets can be queried here — not files, other databases or the app's own tables.").waitFor();

  // Save as dataset: the whole result read on the server, the ordinary composer, the sql origin.
  await editor.fill(sql);
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByText(/^3 rows · \d+ ms$/).waitFor();
  await page.getByRole('button', { name: 'Save as dataset' }).click();
  const name = page.getByLabel('Dataset name');
  await name.waitFor();
  assert.equal(await name.inputValue(), 'Retail orders query');
  await page.getByText(/^3 rows · 2 columns$/).waitFor(); // the composer's preview, from the stage
  await name.fill('West revenue by category');
  const saved = rpcRequest(page, 'dataset:composeSave', (b) => b.includes('"kind":"sql"'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await saved;
  await page.waitForURL(new RegExp(`/data/${pid}/[0-9a-f-]{36}$`));
  await settled(page);
  await page.getByRole('heading', { level: 1, name: 'West revenue by category' }).waitFor();

  // View query: back in the workbench with the statement and its value, run.
  await page.getByRole('link', { name: 'View query' }).click();
  await page.waitForURL(/\/sql\?dataset=/);
  await page.getByText(/^3 rows · \d+ ms$/).waitFor();
  assert.equal(await editor.inputValue(), sql);
  assert.equal(await page.getByLabel('Value of r').inputValue(), 'West');
  report(s);
});
