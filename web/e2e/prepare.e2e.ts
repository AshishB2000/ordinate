// E2E (T2.6): Prepare and Pipelines against the real server and the seeded sample.
//
// Prepare: open the sample dataset's pipeline → add a filter through the form
// (its count comes back from the server and the grid re-pages the stored table)
// → a calculated field through the formula editor (the server's verdict: an
// unknown column named, then the type badge and eight preview rows) → a keyword
// rules preview (shares from the server) → move, then remove, the steps added.
// Pipelines: a dataset that appends another becomes a step → select it, set the
// pipeline's schedule through the cron editor (next runs from the server), Run
// all. Fails on any console error / CSP violation, under the RPC budget.
// Screens in both themes: web/e2e/__screens__/prepare-*.png, pipelines-*.png.

import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { e2e, screens, settled, type Session } from './fixtures.ts';

function report(s: Session): void {
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
}

/** An RPC from the spec itself, with the CSRF pair the web client sends (T6.2). */
async function post(s: Session, channel: string, payload?: unknown): Promise<unknown> {
  let csrf = (await s.page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value;
  if (!csrf) {
    await s.page.goto('/');
    csrf = (await s.page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
  }
  const r = await s.page.request.post(`${s.server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
  assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
  return r.json();
}

async function datasets(s: Session): Promise<{ id: string; name: string }[]> {
  return (await post(s, 'dataset:list', { projectId: s.server.sample.projectId })) as { id: string; name: string }[];
}

async function pick(page: Page, label: string, option: string, within = page.locator('body')): Promise<void> {
  await within.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function addStep(page: Page, type: string): Promise<void> {
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByRole('menuitem', { name: type, exact: true }).click();
}

const subText = (page: Page) => page.locator('main h1 + p').textContent();

e2e('prepare: add, preview, edit and remove steps over the server pipeline', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  const retail = (await datasets(s)).find((d) => d.name === 'Retail orders');
  assert.ok(retail, 'the sample dataset');
  // The entry: one link from the dataset page's header (T2.3's page).
  await page.goto(`/data/${pid}/${retail.id}`);
  await settled(page);
  await page.getByRole('link', { name: 'Prepare', exact: true }).click();
  await page.waitForURL(`**/data/${pid}/${retail.id}/prepare`);
  await page.getByRole('button', { name: 'Add step' }).waitFor();
  await settled(page);
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Retail orders');
  const steps = page.getByRole('list', { name: 'Pipeline steps' });
  const before = await steps.getByRole('listitem').count();
  assert.match((await subText(page)) ?? '', /^Prepare · 5,000 rows/);

  // ── A filter, through the form ──
  await addStep(page, 'Filter rows');
  const editor = page.getByRole('region', { name: 'Add: Filter rows' });
  await pick(page, 'Column', 'region', editor);
  await editor.getByRole('textbox', { name: 'Value' }).fill('East');
  await editor.getByRole('button', { name: 'Save step' }).click();
  await steps.getByText('Filter: region = East').waitFor();
  await editor.waitFor({ state: 'detached' });
  const filtered = (await subText(page)) ?? '';
  const n = Number(/Prepare · ([\d,]+) rows/.exec(filtered)?.[1].replace(/,/g, ''));
  assert.ok(n > 0 && n < 5000, filtered);
  // The count under the step is the server's, and the grid pages the stored, prepared table.
  await steps.getByText(new RegExp(`5,000 → ${n.toLocaleString('en-US')} rows`)).waitFor();
  await page.locator('[role="row"]', { hasText: 'East' }).first().waitFor();
  assert.equal(await page.locator('[role="row"]', { hasText: 'West' }).count(), 0, 'no West row after the filter');

  // ── A calculated field, through the formula editor ──
  await addStep(page, 'Calculated field');
  const fx = page.getByRole('dialog', { name: 'New calculated field' });
  await fx.getByRole('textbox', { name: 'New column name' }).fill('double_units');
  const expr = fx.getByRole('textbox', { name: 'Expression' });
  await expr.fill('[unit] * 2');
  await fx.getByText('[unit] is not a column. Did you mean [units]?').waitFor();
  await expr.fill('[units] * 2');
  await fx.getByText('number', { exact: true }).waitFor();
  assert.equal(await fx.locator('tbody tr').count(), 8, 'eight preview rows from the server');
  await page.keyboard.press('ControlOrMeta+Enter');
  await fx.waitFor({ state: 'detached' });
  await steps.getByText('Calculated field "double_units" = [units] * 2').waitFor();
  // The new column is the prepared table's last (the grid virtualises columns, so it may be off screen).
  await page.waitForFunction((t) => document.querySelector('main h1 + p')?.textContent === t, filtered.replace(/(\d+) columns/, (_m, c: string) => `${Number(c) + 1} columns`));

  // ── A keyword-rules preview: the categories' shares are the server's ──
  await addStep(page, 'Text — tag with keyword rules');
  const kw = page.getByRole('region', { name: 'Add: Text — tag with keyword rules' });
  await kw.getByRole('textbox', { name: 'Pattern' }).fill('Furniture');
  await kw.getByRole('textbox', { name: 'Category' }).fill('Chairs and tables');
  await kw.getByText(/^Chairs and tables$/).waitFor();
  await kw.getByText(/\d+ · \d+%/).first().waitFor();
  await screens(page, 'prepare');

  // The reload in screens() dropped the editor; the two steps stay. Move the field up, then remove both.
  const rows = steps.getByRole('listitem');
  assert.equal(await rows.count(), before + 2);
  await page.getByRole('button', { name: `Move step ${before + 2} up` }).click();
  await steps.getByRole('listitem').nth(before).getByText(/double_units/).waitFor();
  await page.getByRole('button', { name: `Remove step ${before + 1}` }).click();
  await page.waitForFunction((k) => document.querySelectorAll('[aria-label="Pipeline steps"] > li').length === k, before + 1);
  await page.getByRole('button', { name: `Remove step ${before + 1}` }).click();
  await page.waitForFunction((k) => document.querySelectorAll('[aria-label="Pipeline steps"] > li').length === k, before);
  assert.match((await subText(page)) ?? '', /^Prepare · 5,000 rows/);
  report(s);
});

e2e('pipelines: a dependent dataset as a step, the cron editor, Run all', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  const list = await datasets(s);
  const retail = list.find((d) => d.name === 'Retail orders')!;
  const other = list.find((d) => d.id !== retail.id)!;
  // Appending another dataset makes Retail orders re-runnable: a step of the pipeline.
  const added = (await post(s, 'dataset:addStep', { projectId: pid, datasetId: retail.id, step: { type: 'union', datasetId: other.id } })) as { ok: boolean };
  assert.ok(added.ok);

  await page.goto('/pipelines');
  await settled(page);
  const card = page.getByRole('button', { name: /^Dataset: Retail orders\./ });
  await card.waitFor();
  await page.getByText(/\d+ steps? in \d+ stages?/).waitFor();
  await card.click();
  const panel = page.getByRole('region', { name: 'Step: Retail orders' });
  await panel.getByText('Run history').waitFor();

  await page.getByRole('button', { name: 'Set a schedule' }).click();
  await page.getByRole('button', { name: 'Daily 06:00' }).click();
  await page.getByText(/· next: /).waitFor();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await page.getByText(/^Times in .* · next run /).waitFor();

  await page.getByRole('button', { name: 'Run all' }).click();
  await page.getByText(/Pipeline ran — \d+ steps? done\.|failed\. An alert was raised\./).waitFor({ timeout: 60_000 });
  await panel.locator('button[aria-expanded]').first().waitFor();
  await screens(page, 'pipelines');

  // Put the sample back for any later spec in this file's server.
  const st = (await post(s, 'prepare:get', { projectId: pid, datasetId: retail.id })) as { steps: { type: string }[] };
  await post(s, 'dataset:removeStep', { projectId: pid, datasetId: retail.id, index: st.steps.findIndex((x) => x.type === 'union') });
  report(s);
});
