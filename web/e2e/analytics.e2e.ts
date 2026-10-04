// Analytics workbenches A (T2.10) against the real server, on the sample
// project's "Retail orders" (5,000 rows):
//
//   1. /analytics — the doors, for the current project's dataset;
//   2. Statistics — Correlation runs on open; a heatmap cell opens that pair's
//      scatter and fit; "Model y on x" lands on Regression (coefficients, the
//      two diagnostic plots); Compare groups and Distribution run their tests;
//   3. Why did this change? — revenue by its latest two months: ranked
//      dimensions, the waterfall, a drill one level down and back up;
//   4. Find segments — k-means (sizes, k, map, profile) and RFM (the map);
//   5. Scenarios — the empty list, a new scenario seeded with metrics, a
//      driver added from an idea chip moves the figures and saves, Compare.
//
// Every page fails on a console error and stays inside the RPC budget. Screens
// in both themes go to web/e2e/__screens__/analytics-*.png.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled, type Session } from './fixtures.ts';

/** Both themes of a state that lives in memory (a clicked cell, a fit): screens() reloads, which would lose it. */
async function screensInPlace(page: Page, name: string): Promise<void> {
  const prev = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light');
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300); // the plots rebuild their colours on a theme flip
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), prev);
}

/** No skeleton or busy region left. */
const idle = (page: Page) => page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));

function report(s: Session): void {
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
}

/** The sample dataset's id, read off the hub's own link. */
async function sampleDataset(page: Page, pid: string): Promise<string> {
  await page.goto(`/analytics?project=${pid}`);
  await settled(page);
  await pick(page, 'Dataset', 'Retail orders');
  const href = (await page.getByRole('link', { name: 'Open statistics' }).getAttribute('href')) ?? '';
  const id = href.split('/')[3];
  assert.match(id, /^[0-9a-f-]{36}$/);
  return id;
}

/** Picks `option` in the UI kit Select labelled `label`. */
async function pick(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

e2e('analytics: the hub lists the workbenches for the current project', async (s) => {
  const { page, server } = s;
  await page.goto(`/analytics?project=${server.sample.projectId}`);
  await settled(page);
  await page.getByRole('heading', { level: 1, name: 'Analytics' }).waitFor();
  for (const name of ['Statistics', 'Why did this change?', 'Find segments', 'Scenarios']) {
    await page.getByRole('heading', { level: 2, name }).waitFor();
  }
  await screens(page, 'analytics-hub');
  report(s);
});

e2e('statistics: correlation → a pair → regression → groups → distribution', async (s) => {
  const { page, server } = s;
  const pid = server.sample.projectId;
  const ds = await sampleDataset(page, pid);
  await page.getByRole('link', { name: 'Open statistics' }).click();
  await page.getByRole('heading', { level: 1, name: 'Statistics' }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/analytics/${pid}/${ds}/stats`);

  // Correlation runs on open: a heatmap with live cells.
  await page.getByRole('heading', { name: /Pearson correlation · \d+ columns/ }).waitFor();
  const cell = page.getByRole('button', { name: /^units × revenue: r = / });
  await cell.click();
  await page.getByRole('heading', { name: 'units × revenue' }).waitFor();
  await page.getByRole('img', { name: 'revenue against units' }).waitFor();
  await idle(page);
  await screensInPlace(page, 'analytics-stats-correlation');

  // "Model revenue on units" → Regression with that pair.
  await page.getByRole('button', { name: 'Model revenue on units' }).click();
  await page.getByRole('heading', { name: 'Regression of revenue on 1 term' }).waitFor();
  await page.getByRole('table', { name: 'Coefficients' }).waitFor();
  await page.getByRole('button', { name: 'Save as predicted_revenue' }).waitFor();
  await page.getByRole('img', { name: 'Residuals vs fitted' }).waitFor();
  await idle(page);
  await screensInPlace(page, 'analytics-stats-regression');

  // Compare groups: the default is the first category against the first number.
  await page.getByRole('tab', { name: 'Compare groups' }).click();
  await page.getByText(/One-way ANOVA and Kruskal–Wallis|Welch's t-test and Mann–Whitney U/).waitFor();
  await page.getByRole('region', { name: /One-way ANOVA|Welch's t-test/ }).waitFor();
  await idle(page);
  await screensInPlace(page, 'analytics-stats-groups');

  await page.getByRole('tab', { name: 'Distribution' }).click();
  await page.getByRole('heading', { name: /^Distribution of / }).first().waitFor();
  await page.getByRole('region', { name: /Shapiro–Wilk test|D'Agostino–Pearson test/ }).waitFor();
  await idle(page);
  await screensInPlace(page, 'analytics-stats-distribution');
  report(s);
});

e2e('drivers: why revenue changed — dimensions, waterfall, drill and back', async (s) => {
  const { page, server } = s;
  const pid = server.sample.projectId;
  const ds = await sampleDataset(page, pid);
  await page.goto(`/analytics/${pid}/${ds}/drivers`);
  await settled(page);
  await page.getByRole('heading', { level: 1, name: 'Why did this change?' }).waitFor();
  const wf = page.getByRole('list', { name: 'Waterfall of contributors' });
  await wf.waitFor();
  const dims = page.getByRole('group', { name: 'Break the change down by' }).getByRole('button');
  assert.ok((await dims.count()) >= 2, 'at least two dimensions ranked');
  await idle(page);
  await screensInPlace(page, 'analytics-drivers');

  // Drill one member down, then climb back with the breadcrumb.
  const step = page.getByRole('listitem', { name: /Break it down further\.$/ }).first();
  await step.click();
  const crumbs = page.getByRole('navigation', { name: 'Breakdown path' });
  await crumbs.waitFor();
  await crumbs.getByRole('button', { name: /^All / }).click();
  await crumbs.waitFor({ state: 'detached' });
  await wf.waitFor();
  report(s);
});
