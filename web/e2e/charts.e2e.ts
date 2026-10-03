// The chart engine against the real server (T1.1): /dev/charts asks
// `visual:data` for every chart id over the seeded sample dataset and draws
// each answer. Every one of the 39 must have drawn — a canvas with ink on it,
// or (the `table` id) a table with rows — with no error or empty state, no
// console error, inside the RPC budget. The PNG helper's output is opaque on
// the theme surface. Screens in both themes.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { e2e, screens, settled } from './fixtures.ts';

const IDS = 39;

/** Per tile: its id, and what it drew. Ink = canvas pixels with any alpha. */
async function inspect(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-chart-id]')].map((tile) => {
      const canvas = tile.querySelector('canvas');
      let ink = 0;
      if (canvas && canvas.width && canvas.height) {
        const px = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < px.length; i += 4) if (px[i]) ink++;
      }
      return {
        id: tile.dataset.chartId!,
        ink,
        visible: !!canvas && getComputedStyle(canvas).visibility === 'visible',
        rows: tile.querySelectorAll('tbody tr').length,
        problem: tile.querySelector('[role="alert"]')?.textContent ?? (tile.textContent?.includes('Nothing to draw') ? 'empty' : ''),
      };
    }),
  );
}

/** The PNG the tile's download button makes, as {width, height, corner pixel}. */
async function pngOf(page: Page, id: string) {
  await page.evaluate(() => {
    const w = window as unknown as { __png?: string };
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      w.__png = this.href;
    };
  });
  await page.locator(`[data-chart-id="${id}"]`).getByRole('button', { name: /as PNG$/ }).click();
  return page.evaluate(async () => {
    const url = (window as unknown as { __png?: string }).__png ?? '';
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return { png: url.startsWith('data:image/png;base64,'), width: img.width, height: img.height, corner: [...ctx.getImageData(1, 1, 1, 1).data] };
  });
}

e2e('every chart id renders from the API, in both themes', async ({ page, rpc }) => {
  // The final frame at once: no Chart.js animation, no CSS fade (base.css).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/dev/charts');
  await settled(page);

  const tiles = await inspect(page);
  assert.equal(tiles.length, IDS, 'one tile per chart id');
  for (const t of tiles) {
    assert.equal(t.problem, '', `${t.id}: ${t.problem}`);
    if (t.id === 'table') assert.ok(t.rows > 0, 'table: no rows');
    else {
      assert.ok(t.visible, `${t.id}: canvas hidden`);
      assert.ok(t.ink > 2000, `${t.id}: blank canvas (${t.ink} inked pixels)`);
    }
  }
  console.log(`ink  ${tiles.map((t) => `${t.id}=${t.id === 'table' ? `${t.rows} rows` : t.ink}`).join(' ')}`);

  // Export: an opaque PNG on the theme surface (#ffffff light), not a transparent canvas.
  const light = await pngOf(page, 'column');
  assert.ok(light.png && light.width > 0 && light.height > 0, JSON.stringify(light));
  assert.deepEqual(light.corner, [255, 255, 255, 255]);

  // The shell scrolls inside <main>, so a full-page shot is one viewport: make it tall enough for all 39.
  await page.setViewportSize({ width: 1440, height: 4900 });
  const files = await screens(page, 'charts');
  console.log(`screens: ${files.join(', ')}`);

  // The same page in dark: every chart redrawn from the dark tokens, the PNG on the dark surface.
  await page.evaluate(() => localStorage.setItem('ordinate.theme', 'dark'));
  await page.reload();
  await settled(page);
  const dark = await inspect(page);
  for (const t of dark) if (t.id !== 'table') assert.ok(t.ink > 2000, `${t.id} (dark): blank canvas`);
  const darkPng = await pngOf(page, 'column');
  assert.deepEqual(darkPng.corner, [28, 28, 32, 255], 'dark surface #1c1c20');

  for (const l of rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
});
