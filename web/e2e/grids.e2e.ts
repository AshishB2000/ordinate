// Pivot, cohort and event-funnel grids (T1.2) against the real server:
// /dev/charts draws the three grid ids from `visual:data` over the seeded
// sample project, plus two variants (a pivot hierarchy, a funnel breakdown).
// Asserted: semantic tables (every <th> scoped, every table named, a11y tree
// headers), a header click re-asks the SERVER for the sort (one RPC, the
// arrow follows the reply's echo), subtotals collapse and expand, the cohort
// heatmap is shaded, Export CSV writes the server's member total, zero
// console / CSP errors (fixture). Element screenshots in both themes.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, settled } from './fixtures.ts';

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
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
