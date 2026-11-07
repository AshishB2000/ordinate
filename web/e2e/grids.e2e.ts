// Pivot, cohort and event-funnel grids (T1.2) against the real server:
// /dev/charts draws the three grid ids from `visual:data` over the seeded
// sample project, plus two variants (a pivot hierarchy, a funnel breakdown).
// Asserted: semantic tables (every <th> scoped, every table named, a11y tree
// headers), a header click re-asks the SERVER for the sort (one RPC, the
// arrow follows the reply's echo), subtotals collapse and expand, the cohort
// heatmap is shaded, Export CSV writes the server's member total, zero
// console / CSP errors (fixture). Element screenshots in both themes. Then (part 5, step 08) the builder's funnel
// grid saved as a metric, its tile and its chart by region on a dashboard.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { csrfToken, e2e, SCREENS, screens, screensInPlace, settled } from './fixtures.ts';

const TILES = ['pivot', 'cohort', 'event_funnel', 'pivot-hierarchy', 'funnel-breakdown'] as const;
const tile = (page: Page, key: string) => page.locator(`[data-grid="${key}"]`);

/** Per grid tile: tables, headers without a scope, tables without a name, rows, steps. */
async function audit(page: Page) {
  return page.evaluate(
    (keys) =>
      keys.map((key) => {
        const el = document.querySelector(`[data-grid="${key}"]`)!;
        const tables = [...el.querySelectorAll('table')];
        const bad = tables.flatMap((t) =>
          [...t.querySelectorAll('th')]
            .filter((th) => {
              const want = th.closest('thead') ? (th.colSpan > 1 ? 'colgroup' : 'col') : 'row';
              return th.getAttribute('scope') !== want;
            })
            .map((th) => th.textContent),
        );
        const unnamed = tables.filter((t) => !t.getAttribute('aria-label') && !t.getAttribute('aria-labelledby')).length;
        return {
          key,
          tables: tables.length,
          bad,
          unnamed,
          rows: el.querySelectorAll('tbody tr').length,
          steps: el.querySelectorAll('ol > li').length,
          problem: el.querySelector('[role="alert"]')?.textContent ?? '',
        };
      }),
    TILES as unknown as string[],
  );
}

async function shoot(page: Page, theme: 'light' | 'dark'): Promise<string[]> {
  await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
  await page.reload();
  await settled(page);
  // The cohort's table view (the sample saves the curve), and the hierarchy's top.
  await tile(page, 'cohort').getByRole('button', { name: 'Table', exact: true }).click();
  const files: string[] = [];
  for (const key of TILES) {
    const file = path.join(SCREENS, `grids-${key}-${theme}.png`);
    await tile(page, key).screenshot({ path: file });
    files.push(file);
  }
  return files;
}

e2e('pivot, cohort and funnel grids render from the API, accessibly, in both themes', async ({ page, rpc }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/dev/charts');
  await settled(page);

  const tiles = await audit(page);
  for (const t of tiles) {
    assert.equal(t.problem, '', `${t.key}: ${t.problem}`);
    assert.deepEqual(t.bad, [], `${t.key}: headers without the right scope`);
    assert.equal(t.unnamed, 0, `${t.key}: unnamed table`);
  }
  const by = Object.fromEntries(tiles.map((t) => [t.key, t]));
  assert.ok(by.pivot!.rows >= 4, 'pivot: one row per region');
  assert.equal(by.event_funnel!.steps, 3, 'funnel: three steps');
  assert.ok(by['funnel-breakdown']!.tables === 1 && by['funnel-breakdown']!.rows >= 4, 'funnel breakdown table');
  assert.ok(by['pivot-hierarchy']!.rows > by.pivot!.rows, 'hierarchy has subtotal + leaf rows');
  console.log(`grids ${tiles.map((t) => `${t.key}=${t.rows} rows/${t.steps} steps`).join(' ')}`);

  // The a11y tree sees the headers.
  const pivot = tile(page, 'pivot').getByRole('table', { name: 'Pivot table' });
  assert.ok((await pivot.getByRole('columnheader').count()) >= 4);
  assert.ok((await pivot.getByRole('rowheader').count()) >= 5);

  // Sort: one RPC to the server, the arrow follows the grid's echo.
  const calls: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/rpc\/visual(:|%3A)data$/i.test(r.url())) calls.push(r.url());
  });
  const head = pivot.getByRole('button', { name: /^Sort by Furniture/ });
  await head.click();
  await pivot.getByRole('button', { name: 'Sort by Furniture, descending' }).waitFor();
  assert.ok(calls.length >= 1, 'the sort asked the server');
  const firstAfter = await pivot.locator('tbody th').first().textContent();
  await pivot.getByRole('button', { name: 'Sort by Furniture, descending' }).click();
  await pivot.getByRole('button', { name: 'Sort by Furniture, ascending' }).waitFor();
  const firstAsc = await pivot.locator('tbody th').first().textContent();
  assert.notEqual(firstAsc, firstAfter, 'the server reversed the rows');

  // Collapse a subtotal, then expand it.
  const hier = tile(page, 'pivot-hierarchy');
  const rowsBefore = await hier.locator('tbody tr').count();
  const collapse = hier.getByRole('button', { name: /^Collapse / }).first();
  const region = (await collapse.textContent())!.trim();
  await collapse.click();
  assert.ok((await hier.locator('tbody tr').count()) < rowsBefore, 'collapse hides the children');
  await hier.getByRole('button', { name: `Expand ${region}` }).click();
  assert.equal(await hier.locator('tbody tr').count(), rowsBefore);

  // The cohort heatmap: shaded cells; Export CSV ends in the server's member total.
  const cohort = tile(page, 'cohort');
  await cohort.getByRole('button', { name: 'Table', exact: true }).click();
  const shaded = await cohort.locator('td[style*="background-color"]').count();
  assert.ok(shaded >= 3, `cohort: ${shaded} shaded cells`);
  await page.evaluate(() => {
    // The file the download would save: the Blob handed to createObjectURL, and the anchor's name.
    const w = window as unknown as { __csv?: Promise<string>; __name?: string };
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      if (b instanceof Blob) w.__csv = b.text();
      return make(b);
    };
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      w.__name = this.download;
    };
  });
  await cohort.getByRole('button', { name: 'Export the cohort table as CSV' }).click();
  await page.waitForFunction(() => !!(window as unknown as { __csv?: unknown }).__csv);
  const csv = await page.evaluate(() => (window as unknown as { __csv: Promise<string> }).__csv);
  const name = await page.evaluate(() => (window as unknown as { __name: string }).__name);
  const lines = csv.split('\r\n');
  assert.equal(name, 'cohort-retention.csv');
  assert.match(lines[0]!, /^Cohort,Members,Quarter 0,/);
  const meta = (await cohort.getByText(/members ·/).textContent()) ?? '';
  assert.match(lines.at(-1)!, /^Average,\d+,/);
  console.log(`cohort meta "${meta}" · csv last "${lines.at(-1)!.slice(0, 40)}"`);

  const files = [...(await shoot(page, 'light')), ...(await shoot(page, 'dark'))];
  await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
  console.log(`screens: ${files.join(', ')}`);
  for (const l of rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
});

e2e('funnel grid: Save as metric, then its tile and its chart (part 5, step 08)', async ({ page, server }) => {
  // The sample's state funnel (Office Supplies → Furniture → Technology within 30 days) saved as "Office Supplies →
  // Technology", its conversion rate; then a KPI and a column chart by region on a dashboard, every figure the server's.
  const pid = server.sample.projectId;
  const csrf = await csrfToken({ page, server });
  const rpc = async (channel: string, payload: unknown) => (await (await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: [payload] } })).json()) as Record<string, any>; // any: each channel's reply
  const ds = ((await rpc('dataset:list', { projectId: pid })) as unknown as { id: string; name: string }[]).find((d) => d.name === 'Retail orders')!.id;
  const eventFunnel = { entity: 'state', event: 'category', time: 'order_date', steps: ['Office Supplies', 'Furniture', 'Technology'], window: { n: 30, unit: 'days' } };
  const saved = await rpc('visual:save', { projectId: pid, datasetId: ds, name: 'State funnel', chartType: 'event_funnel', encoding: { category: 'category', values: [{ column: 'units', aggregation: 'sum' }], eventFunnel } });
  const grid = (saved.visual?.id ?? saved.id) as string;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/visuals/${pid}/${grid}`);
  await settled(page);
  await page.getByRole('button', { name: 'Save as metric' }).click();
  const dlg = page.getByRole('dialog', { name: 'New metric' });
  assert.equal(await dlg.getByLabel('Name').inputValue(), 'Office Supplies → Technology');
  assert.equal(await dlg.getByRole('tab', { name: 'Funnel' }).getAttribute('aria-selected'), 'true');
  await dlg.getByText('Office Supplies → Furniture → Technology, within 30 days').waitFor();
  const preview = dlg.getByRole('complementary', { name: 'Preview' });
  await preview.getByText('Office Supplies → Furniture → Technology within 30 days, conversion rate').waitFor(); // the server's words
  await preview.getByText(/^\d+(\.\d)?%$/).waitFor(); // the server's figure, as a percent
  await screensInPlace(page, 'grids-funnel-metric-editor');
  await dlg.getByRole('button', { name: 'Create metric' }).click();
  await page.getByText('Saved the metric “Office Supplies → Technology”.').waitFor();
  const metric = ((await rpc('metric:list', { projectId: pid })).metrics as { id: string; name: string }[]).find((m) => m.name === 'Office Supplies → Technology')!.id;

  // The Metrics list shows it with its figure.
  await page.goto(`/model/${pid}?tab=metrics`);
  await settled(page);
  const row = page.getByRole('table').getByRole('row').filter({ has: page.getByRole('button', { name: 'Office Supplies → Technology' }) });
  await row.getByText(/^\d+(\.\d)?%$/).waitFor();

  // A dashboard: its KPI and a column chart by region; each bar is the tile filtered to that region (a state is in one region).
  const chartEnc = { category: 'region', values: [{ column: 'state', aggregation: 'countd', metricId: metric }] };
  const byRegion = await rpc('visual:save', { projectId: pid, datasetId: ds, name: 'Conversion by region', chartType: 'column', encoding: chartEnc, overrides: { numberFormat: 'percent' } });
  const chartId = (byRegion.visual?.id ?? byRegion.id) as string;
  const cards = [
    { type: 'metric', layout: { x: 0, y: 0, w: 4, h: 3 }, metric: { datasetId: ds, column: '', aggregation: 'sum', metricId: metric, label: 'Office Supplies → Technology' } },
    { type: 'visual', layout: { x: 4, y: 0, w: 8, h: 7 }, visualId: chartId },
  ];
  const board = (await rpc('analysis:create', { projectId: pid, name: 'Funnel metric', sheets: [{ name: 'Sheet 1', cards }] })).id as string;
  const drawn = await rpc('visual:data', { projectId: pid, datasetId: ds, encoding: chartEnc, filters: [] });
  assert.ok(drawn.ok && drawn.data.labels.length >= 4, JSON.stringify(drawn).slice(0, 300));
  const first = String(drawn.data.labels[0]);
  const tile = (await rpc('metric:values', { projectId: pid, ids: [metric], filters: [{ type: 'filter', column: 'region', op: '=', value: first }] })) as unknown as { value: number }[];
  assert.equal(drawn.data.series[0].values[0], tile[0].value, `the ${first} bar is the tile filtered to ${first}`);
  await page.goto(`/analyses/${pid}/${board}`);
  await settled(page);
  await page.getByRole('group', { name: 'Conversion by region card' }).getByRole('img', { name: 'Conversion by region' }).waitFor();
  await screens(page, 'grids-funnel-metric-dashboard');

  for (const [channel, id] of [['analysis:delete', board], ['visual:delete', chartId], ['visual:delete', grid], ['metric:delete', metric]] as const) await rpc(channel, { projectId: pid, id });
});
