// Dashboard SHAPES on screen (src/analysis/dashboardShapes.ts): the wizard's
// Assistant step offers the four, each with its picture; a draft of each is
// reviewed — shape named, the app's takeaway, each chart's note — and built,
// and the built sheet carries the takeaway under its title.
//
// No model runs here: this server has no database to keep a key in. So two
// answers are given at the browser's edge — `ai:status` as ready, and
// `analysis:draft` as the plan a model would write for that shape, PREVIEWED
// BY THIS SERVER (`analysis:previewPlan`, the same function a draft's reply
// is). The model only ever writes structure; every figure, the takeaway
// included, is still the server's. The real draft round-trip is dock.e2e.ts.

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { csrfToken, e2e, screens, settled, SCREENS } from './fixtures.ts';

const DS = 'Retail orders';
const sum = (column: string) => [{ column, aggregation: 'sum' }];
const kpi = (column: string, label: string, aggregation = 'sum') => ({ dataset: DS, column, aggregation, label });
const chart = (name: string, chartType: string, encoding: object, note?: string) => ({ dataset: DS, name, chartType, encoding, ...(note ? { note } : {}) });
const byMonth = { category: 'order_date', grain: 'month', values: sum('revenue') };

/** What a model would draft for each shape on the sample's retail orders: structure only, never a figure. */
const PLANS: Record<string, { title: string; plan: object }> = {
  scorecard: {
    title: 'Scorecard',
    plan: {
      name: 'Retail scorecard',
      shape: 'scorecard',
      sheets: [{
        name: 'Health',
        rows: [
          { type: 'kpis', metrics: [kpi('revenue', 'Revenue'), kpi('profit', 'Profit'), kpi('units', 'Units sold'), kpi('order_date', 'Orders', 'count'), kpi('discount', 'Average discount', 'avg'), kpi('ship_days', 'Days to ship', 'avg')] },
          { type: 'charts', visuals: [chart('Revenue by month', 'area', byMonth, 'The line to watch for the season')] },
        ],
      }],
    },
  },
  review: {
    title: 'Review',
    plan: {
      name: 'Retail review',
      shape: 'review',
      sheets: [{
        name: 'Trends',
        rows: [
          { type: 'kpis', metrics: [kpi('revenue', 'Revenue'), kpi('profit', 'Profit'), kpi('units', 'Units sold'), kpi('order_date', 'Orders', 'count')] },
          { type: 'charts', visuals: [chart('Revenue by month', 'line', byMonth, 'Read the peaks against the same month a year before')] },
          { type: 'charts', visuals: [chart('Revenue by month, each region', 'line', { ...byMonth, grain: 'quarter', facet: { cols: 'region', scale: 'shared' } }, 'One scale, so the regions compare by eye')] },
        ],
      }],
    },
  },
  visual: {
    title: 'Visual analysis',
    plan: {
      name: 'Where the revenue comes from',
      shape: 'visual',
      sheets: [{
        name: 'Analysis',
        rows: [
          { type: 'charts', visuals: [chart('Which category leads?', 'bar', { category: 'category', values: sum('revenue') }, 'The leader sets the pace for the rest')] },
          { type: 'charts', visuals: [chart('What share does each segment take?', 'donut', { category: 'customer_segment', values: sum('revenue') }, 'Each slice is a segment’s share of revenue')] },
          { type: 'charts', visuals: [chart('How has each region moved?', 'line', { category: 'order_date', grain: 'quarter', values: sum('revenue'), series: 'region' }, 'The accent line is the region to watch')] },
        ],
      }],
    },
  },
  table: {
    title: 'Table',
    plan: {
      name: 'Every state',
      shape: 'table',
      sheets: [{
        name: 'States',
        rows: [{ type: 'charts', visuals: [chart('Every state, by revenue', 'table', { category: 'state', values: [...sum('revenue'), ...sum('profit'), ...sum('units')] }, 'Sort a column or search for a state')] }],
        controls: [{ dataset: DS, kind: 'dropdown', column: 'region', label: 'Region' }],
      }],
    },
  },
};

const READY = JSON.stringify({ ready: true, models: [{ provider: 'anthropic', model: 'stub', label: 'Stub', isDefault: true }], mine: { provider: 'anthropic', model: 'stub' }, copilotEnabled: true, keyStore: null });

/** A dialog in both themes: a reload would close it, so the theme is set in place. */
async function dialogShots(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

e2e('shapes: the wizard offers four, and a draft of each is built with the app\'s own takeaway', async (s) => {
  const { page, server } = s;
  const pid = server.sample.projectId;
  const csrf = await csrfToken(s);
  await page.route('**/api/rpc/ai%3Astatus', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: READY }));
  let drafted = '';
  await page.route('**/api/rpc/analysis%3Adraft', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: drafted }));

  const built: { id: string; analysisId: string; takeaway?: string }[] = [];
  for (const [id, { title, plan }] of Object.entries(PLANS)) {
    // The server's own preview of that plan: what the draft reply is, figures and takeaway computed here.
    const res = await page.request.post(`${server.base}/api/rpc/analysis:previewPlan`, { headers: { 'x-csrf-token': csrf }, data: { args: [{ projectId: pid, plan }] } });
    drafted = await res.text();
    const preview = JSON.parse(drafted) as { shape?: string; takeaway?: string; dropped?: unknown[] };
    assert.equal(preview.shape, id, `${id}: the preview carries its shape`);
    assert.deepEqual(preview.dropped, [], `${id}: nothing in the plan was refused (${JSON.stringify(preview.dropped)})`);

    await page.goto(`/analyses?project=${pid}`);
    await settled(page);
    await page.getByRole('button', { name: 'Create dashboard' }).first().click();
    const wiz = page.getByRole('dialog', { name: 'Create dashboard' });
    await wiz.getByRole('radio', { name: new RegExp(`^${DS}`) }).click();
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('radio', { name: /Let the Assistant design it/ }).click();
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('textbox', { name: 'Describe the dashboard' }).fill(`A ${title.toLowerCase()} of retail revenue`);
    const shapes = wiz.getByRole('radiogroup', { name: 'Shape' });
    assert.deepEqual(await shapes.getByRole('radio').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value)), ['auto', 'scorecard', 'review', 'visual', 'table']);
    await shapes.getByRole('radio', { name: new RegExp(`^${title}`) }).check();
    if (id === 'scorecard') await dialogShots(page, 'shapes-wizard');
    const asked = page.waitForRequest((r) => decodeURIComponent(new URL(r.url()).pathname) === '/api/rpc/analysis:draft');
    await wiz.getByRole('button', { name: 'Draft with the Assistant' }).click();
    assert.equal(((await asked).postDataJSON() as { args: [{ shape: string }] }).args[0].shape, id, `${id}: the brief's shape is what the draft is asked for`);

    const review = page.getByRole('dialog', { name: 'Assistant draft — review before creating' });
    await review.getByText(title, { exact: true }).first().waitFor(); // the shape, by its registry name (a table's type says "Table" too)
    if (preview.takeaway) await review.getByText(preview.takeaway, { exact: true }).waitFor();
    await dialogShots(page, `shapes-draft-${id}`);
    await review.getByRole('button', { name: 'Create dashboard' }).click();
    await page.waitForURL(/\/analyses\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    built.push({ id, analysisId: page.url().split('/').at(-1) ?? '', takeaway: preview.takeaway });
    await settled(page);
    // The built sheet: its takeaway is the lead chart's caption — the same sentence the preview computed.
    const take = page.getByTestId('takeaway');
    await take.waitFor();
    if (preview.takeaway) assert.equal(await take.textContent(), preview.takeaway, `${id}: the sheet says what the review said`);
    if (id === 'scorecard') await page.locator('svg[aria-label^="Monthly trend"]').first().waitFor(); // every KPI's months
    if (id === 'table') {
      await page.getByRole('searchbox', { name: /^Search Every state/ }).waitFor();
      await page.getByRole('button', { name: /sum of revenue/i }).first().click(); // largest first
    }
    await screens(page, `shapes-${id}`);
  }

  // ── Published: each shape's page, with the same takeaway under its title ──
  const res = await page.request.post(`${server.base}/api/rpc/publish:run`, { headers: { 'x-csrf-token': csrf }, data: { args: [{ projectId: pid, dashboardIds: built.map((b) => b.analysisId) }] } });
  const run = JSON.parse(await res.text()) as { ok: boolean; site: { id: string; pages: { file: string; name: string }[] } };
  assert.equal(run.ok, true, JSON.stringify(run).slice(0, 300));
  for (const b of built) {
    const file = run.site.pages.find((p) => p.name === (PLANS[b.id].plan as { name: string }).name)?.file;
    assert.ok(file, `${b.id}: published`);
    await page.goto(`/p/${run.site.id}/${file}`);
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    if (b.takeaway) assert.equal(await page.locator('.pub-takeaway').textContent(), b.takeaway, `${b.id}: the page says what the app said`);
    if (b.id === 'table') {
      await page.getByRole('searchbox', { name: /^Search Every state/ }).waitFor();
      assert.ok((await page.locator('.pub-bar').count()) > 10, 'a bar in each figure\'s cell');
      await page.locator('.pub-sort', { hasText: 'sum of revenue' }).click(); // largest first
      assert.equal(await page.locator('th[aria-sort="descending"]').count(), 1);
    }
    if (b.id === 'scorecard') await page.locator('.pub-kpi svg').first().waitFor(); // each KPI's months
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400); // an Auto dashboard redraws its charts in the reader's scheme
      if (b.id === 'table') await page.locator('.pub-sort', { hasText: 'sum of revenue' }).click(); // the redraw reset it: largest first again
      await page.screenshot({ path: path.join(SCREENS, `shapes-published-${b.id}-${scheme}.png`), fullPage: true });
    }
    await page.emulateMedia({ colorScheme: null });
  }
});
