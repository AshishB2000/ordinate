// Maps (T1.3) against the real server: /dev/maps draws every map kind from
// `visual:data` over the seeded sample project — region, bubble, offline
// basemap, points (clustered), hexbin and flow — each with its canvas really
// painted and its DOM markers present, zero console errors and zero CSP
// violations (the fixture fails on either), and nothing fetched from any host
// but the server and the OSM tile servers.
//
// OSM tiles are answered locally with a plain PNG: a test must not load a
// volunteer-run tile server, and the CSP check happens before the request is
// made, so an intercepted tile still proves the CSP admits the host.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import type { Page } from 'playwright';
import { e2e, screens, settled } from './fixtures.ts';

const KINDS = ['region', 'bubble', 'offline', 'points', 'hexbin', 'flow'] as const;
const OSM = /^https:\/\/[abc]\.tile\.openstreetmap\.org\//;

/** A flat 256×256 PNG — a stand-in tile. */
function tilePng(rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(256, 0);
  ihdr.writeUInt32BE(256, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 256 }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: 256 }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE = tilePng([226, 232, 236]);

async function serveTiles(page: Page): Promise<string[]> {
  const tiles: string[] = [];
  await page.route(OSM, (route) => {
    tiles.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE });
  });
  return tiles;
}

const card = (page: Page, id: string) => page.locator(`[data-map-card="${id}"]`);
const figure = (page: Page, id: string) => card(page, id).locator('[data-map-status]');

/** Every map drawn: its status is ready and it has gone idle (tiles in, nothing pending). */
async function allReady(page: Page): Promise<void> {
  await page.waitForFunction((n) => document.querySelectorAll('[data-map-status="ready"][aria-busy="false"]').length === n, KINDS.length, { timeout: 60_000 });
}

/** How many distinct colours the map's WebGL canvas holds (sampled, quantised) — 1–2 means blank. */
async function canvasColours(page: Page, id: string): Promise<number> {
  return card(page, id)
    .locator('canvas.maplibregl-canvas')
    .evaluate((gl: HTMLCanvasElement) => {
      const c = document.createElement('canvas');
      c.width = gl.width;
      c.height = gl.height;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      ctx.drawImage(gl, 0, 0); // preserveDrawingBuffer: the last frame is still there
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const seen = new Set<number>();
      for (let i = 0; i < data.length; i += 4 * 97) seen.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
      return seen.size;
    });
}

e2e('every map kind renders from the server, painted and labelled', async (s) => {
  const { page, server } = s;
  const hosts = new Set<string>();
  page.on('request', (r) => hosts.add(new URL(r.url()).origin));
  const tiles = await serveTiles(page);

  await page.goto('/dev/maps');
  await settled(page);
  await allReady(page);

  const stat = async (id: string, name: string) => Number(await figure(page, id).getAttribute(`data-${name}`));
  for (const id of KINDS) {
    const colours = await canvasColours(page, id);
    // At country zoom every point is in a cluster, and clusters are DOM markers over a canvas of tiles alone.
    const markers = await card(page, id).locator('.cv-map-cluster, .cv-map-value-label').count();
    console.log(`map  ${id.padEnd(8)} ${String(colours).padStart(3)} colours  ${markers} markers`);
    assert.ok(colours >= 4 || (id === 'points' && markers > 0), `${id}: blank — ${colours} colours, ${markers} markers`);
  }
  // The sample's orders come from 25 states, every one named in full (geoMatch joins names, not codes).
  assert.equal(await stat('region', 'matched'), 25, 'region: every state matched');
  assert.equal(await stat('offline', 'matched'), 25, 'offline: every state matched');
  assert.equal(await stat('bubble', 'points'), 25, 'bubble: a bubble per state, at its centroid');
  assert.ok((await stat('points', 'clusters')) > 0, 'points: 2,400 rows cluster at country zoom');
  assert.ok((await stat('hexbin', 'hexes')) > 0, 'hexbin: hexagons drawn');
  assert.ok((await stat('flow', 'flows')) > 10, 'flow: routes drawn');

  // DOM markers (no glyphs URL, so no symbol layer): value labels and cluster counts.
  assert.equal(await card(page, 'region').locator('.cv-map-value-label').count(), 2, 'region: Max & min labels by default');
  assert.ok((await card(page, 'points').locator('.cv-map-cluster').count()) > 0, 'points: cluster count markers');
  assert.match((await card(page, 'region').locator('[class*="legend"]').first().textContent()) ?? '', /Value/);
  assert.match((await card(page, 'flow').getByText(/routes? ·|Showing the top/).first().textContent()) ?? '', /route/);
  assert.match((await card(page, 'hexbin').getByText(/points · .* hexagons/).textContent()) ?? '', /2,400 points/);

  // Values → All labels every region with a value.
  await card(page, 'region').getByRole('button', { name: 'Value labels' }).click();
  await page.getByRole('menuitemradio', { name: 'All' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-map-card="region"] .cv-map-value-label').length > 2);
  // 26, not 25: West Virginia is not in the sample, but geoMatch's substring rule ("virginia" ⊂ "west
  // virginia") gives it Virginia's value — a desktop bug kept for parity (geo.test.ts pins it too).
  assert.equal(await card(page, 'region').locator('.cv-map-value-label').count(), 26);

  // Thumbnails: the same shapes on a 2D canvas, no WebGL. A point map has no polygons to draw on and
  // keeps the map glyph, as on the desktop (mapThumb.ts: point/city/ZIP levels resolve null).
  await page.waitForFunction(() => document.querySelectorAll('[data-drawn="true"]').length === 5, undefined, { timeout: 20_000 });
  assert.equal(await card(page, 'points').locator('[data-drawn]').getAttribute('data-drawn'), 'false');

  assert.ok(tiles.length > 0, 'OSM tiles were requested (and answered locally)');
  const allowed = new Set([server.base, 'https://a.tile.openstreetmap.org', 'https://b.tile.openstreetmap.org', 'https://c.tile.openstreetmap.org']);
  assert.deepEqual([...hosts].filter((h) => !allowed.has(h)), [], 'no host beyond the server and the OSM tile servers');

  // Tall enough that the full-page shots hold all six maps (the shell scrolls <main>, not the page).
  await page.setViewportSize({ width: 1440, height: 2200 });
  const files = await screens(page, 'maps');
  console.log(`screens: ${files.join(', ')}`);
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
});

e2e('the radius control resolves a place and narrows the point map', async (s) => {
  const { page } = s;
  await serveTiles(page);
  await page.goto('/dev/maps');
  await settled(page);
  await allReady(page);
  const before = Number(await figure(page, 'points').getAttribute('data-clusters'));
  assert.ok(before > 0);

  await page.getByRole('textbox', { name: 'Place' }).fill('Atlantis');
  await page.getByText('No place called "Atlantis" in the offline places table.').waitFor();
  await page.getByRole('textbox', { name: 'Place' }).fill('Chicago');
  await page.getByText(/^Chicago.* · 41\.\d{3}, -87\.\d{3}$/).waitFor();
  await page.getByRole('button', { name: '50 km' }).click();
  // The point map re-asks the server with a within_km step: Chicago's deliveries only, too few to cluster.
  await page.waitForFunction(() => {
    const f = document.querySelector('[data-map-card="points"] [data-map-status="ready"][aria-busy="false"]');
    return !!f && f.getAttribute('data-clusters') === '0' && Number(f.getAttribute('data-points')) > 0;
  }, undefined, { timeout: 30_000 });
  const points = Number(await figure(page, 'points').getAttribute('data-points'));
  console.log(`radius  50 km of Chicago → ${points} points`);
  assert.ok(points > 20 && points < 2400, `a narrowed point map (${points})`);
});
