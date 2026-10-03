// The DataGrid (T1.4) against the real server and a seeded 1,000,000-row
// dataset whose `ordinal` column is each row's position (seed.ts --large).
//
//   1. JUMPS: the scrollbar thrown to every page boundary around 0, 250k,
//      500k and the last page, to the very end, and to 12 fixed pseudo-random
//      offsets. After each, every drawn row's ordinal equals its row index
//      (so no row is drawn twice, skipped or shifted), the drawn rows are
//      consecutive, the target row is in view — and each jump costs at most
//      JUMP_RPCS page requests.
//   2. CONTINUOUS: a scroll through 10,000 rows (20 pages) a screen at a
//      time (overlapping by two rows); the union of rows seen is exactly the range, and the requests
//      stay within PAGES + slack. Then a fast fling for frame times.
//   3. KEYBOARD, RESIZE, STICKY HEADER, TYPE BADGES.
//   4. STATES: loading skeleton, error and empty, screenshotted in both themes.
//
// Measures (printed): time to first rows, RPCs per 10k rows, frame times,
// JS heap and live cell count.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled, withLargeDataset, type Session } from './fixtures.ts';

withLargeDataset();

const ROW_H = 28; // web/src/ui/DataGrid/DataGrid.tsx
const HEAD_H = 34;
const PAGE_ROWS = 500; // web/src/ui/DataGrid/pageCache.ts
const N = 1_000_000;
/** Page requests one jump may cost: the block in view, one straddled boundary, one margin block. */
const JUMP_RPCS = 3;
const SEGMENT = 10_000;
/** Pages a SEGMENT-row scroll may fetch: its 20 blocks plus the margin either side. */
const SEGMENT_RPCS = SEGMENT / PAGE_ROWS + 3;

const BOUNDARIES = [0, 499, 500, 999, 1000, 249_999, 250_000, 499_999, 500_000, 500_499, 500_500, 999_499, 999_500];
// Fixed, so a failure reproduces: a small LCG over [0, N).
const RANDOM = Array.from({ length: 12 }, (_, i) => Math.floor((((i + 1) * 48271 * 2_147_483) % 2_147_483_647) / 2_147_483_647 * N));
const JUMPS = [...BOUNDARIES, ...RANDOM];

const datasetUrl = (s: Session) => `/data/${s.server.sample.projectId}/${s.server.sample.large!.datasetId}`;

/** Counts dataset:page requests; `take()` returns the count since the last take. */
function pageRequests(page: Page): { take(): number; all(): number } {
  let n = 0;
  let mark = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/rpc/dataset%3Apage') n++;
  });
  return {
    take: () => {
      const d = n - mark;
      mark = n;
      return d;
    },
    all: () => n,
  };
}

interface Snap {
  /** Row indexes drawn, in DOM order. */
  rows: number[];
  /** Row indexes whose box is inside the grid, below the header. */
  visible: number[];
  /** Rows whose ordinal / label disagree with their index. */
  wrong: string[];
}

/** What the grid draws right now, read from the DOM (runs in the page). */
function snapshot(): Snap {
  const g = document.querySelector<HTMLElement>('[role="grid"]')!;
  const box = g.getBoundingClientRect();
  const out: Snap = { rows: [], visible: [], wrong: [] };
  for (const r of g.querySelectorAll<HTMLElement>('[role="row"]')) {
    const i = Number(r.getAttribute('aria-rowindex')) - 2;
    if (i < 0) continue;
    out.rows.push(i);
    const b = r.getBoundingClientRect();
    if (b.top >= box.top + 34 - 1 && b.bottom <= box.bottom + 1) out.visible.push(i);
    const ord = r.querySelector('[aria-colindex="1"]')?.textContent ?? '';
    const label = r.querySelector('[aria-colindex="2"]')?.textContent ?? '';
    if (Number(ord.replace(/\D/g, '')) !== i || label !== `row ${i}`) out.wrong.push(`row ${i}: "${ord}" / "${label}"`);
  }
  return out;
}

/** Two frames for React, then until no drawn row is waiting for its block. */
async function loaded(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForFunction(() => document.querySelector('[role="grid"]')?.getAttribute('aria-busy') !== 'true');
}

/** Puts row `row` at the top of the view (or the end of the table at the bottom), through the compressed space. */
async function jumpTo(page: Page, row: number): Promise<void> {
  await page.evaluate(
    ([row, n, rowH, headH]) => {
      const g = document.querySelector<HTMLElement>('[role="grid"]')!;
      const virtual = headH + n * rowH;
      const ratio = Math.max(1, (virtual - g.clientHeight) / (g.scrollHeight - g.clientHeight));
      g.scrollTop = Math.floor((row * rowH) / ratio); // down, so the row lands below the header, not under it
    },
    [row, N, ROW_H, HEAD_H] as const,
  );
  await loaded(page);
}

function assertConsecutive(xs: number[], what: string): void {
  for (let k = 1; k < xs.length; k++) assert.equal(xs[k], xs[k - 1]! + 1, `${what}: ${xs[k - 1]} then ${xs[k]}`);
}

async function open(s: Session): Promise<number> {
  const t0 = performance.now();
  await s.page.goto(datasetUrl(s));
  await s.page.locator('[role="row"][aria-rowindex="2"] [aria-colindex="1"]', { hasText: /^0$/ }).waitFor();
  const ms = performance.now() - t0;
  await settled(s.page);
  return ms;
}

e2e(
  'jumps to every page boundary, the last page and random offsets with no row skipped or drawn twice',
  async (s) => {
    const { page } = s;
    const reqs = pageRequests(page);
    const first = await open(s);
    assert.equal(await page.locator('main h1').textContent(), 'One million rows');
    assert.equal(await page.getByRole('grid').getAttribute('aria-rowcount'), String(N + 1));
    const initial = reqs.take();

    const perJump: number[] = [];
    for (const row of JUMPS) {
      await jumpTo(page, row);
      const snap = await page.evaluate(snapshot);
      assert.deepEqual(snap.wrong, [], `after a jump to ${row}`);
      assert.equal(new Set(snap.rows).size, snap.rows.length, `a row drawn twice near ${row}`);
      assertConsecutive(snap.rows, `drawn rows near ${row}`);
      assert.ok(snap.visible.includes(Math.min(row, N - 1)), `row ${row} in view (saw ${snap.visible[0]}…${snap.visible.at(-1)})`);
      // A page boundary in view: both sides of it are drawn, adjacent.
      if (row % PAGE_ROWS === PAGE_ROWS - 1 && row + 1 < N) assert.ok(snap.rows.includes(row + 1), `the row after the boundary at ${row}`);
      perJump.push(reqs.take());
    }
    assert.ok(Math.max(...perJump) <= JUMP_RPCS, `per-jump requests ${perJump.join(',')} (budget ${JUMP_RPCS})`);

    // The very end: the scrollbar at its maximum shows the last row, fully.
    await page.evaluate(() => {
      const g = document.querySelector<HTMLElement>('[role="grid"]')!;
      g.scrollTop = g.scrollHeight;
    });
    await loaded(page);
    const end = await page.evaluate(snapshot);
    assert.deepEqual(end.wrong, []);
    assert.equal(end.visible.at(-1), N - 1, 'the last row is in view at the bottom');
    assert.equal(end.rows.at(-1), N - 1, 'nothing is drawn past the last row');
    const atEnd = reqs.take();

    console.log(`time to first rows: ${first.toFixed(0)} ms (1 dataset:columns + ${initial} dataset:page)`);
    console.log(`jumps: ${JUMPS.length}, dataset:page requests per jump ${perJump.join(' ')} (max ${Math.max(...perJump)}), end ${atEnd}`);
    console.log(`total RPCs this load: ${s.rpc.loads.at(-1)?.rpcs}`);
  },
  { rpcBudget: 2 + JUMP_RPCS * (JUMPS.length + 1) },
);

e2e(
  'a continuous scroll through 10,000 rows sees every row once, within its request budget',
  async (s) => {
    const { page } = s;
    const reqs = pageRequests(page);
    await open(s);
    const start = 100_200; // mid-block, so the segment crosses 20 boundaries
    await jumpTo(page, start);
    reqs.take();
    const t0 = performance.now();
    const seen = await page.evaluate(
      async ([from, to, n, rowH, headH]) => {
        const g = document.querySelector<HTMLElement>('[role="grid"]')!;
        const ratio = Math.max(1, (headH + n * rowH - g.clientHeight) / (g.scrollHeight - g.clientHeight));
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const step = ((Math.floor((g.clientHeight - headH) / rowH) - 2) * rowH) / ratio; // a screen less two rows
        const rows: number[] = [];
        const wrong: string[] = [];
        const box = g.getBoundingClientRect();
        for (let guard = 0; guard < 5000; guard++) {
          await frame();
          await frame();
          while (g.getAttribute('aria-busy') === 'true') await frame();
          let last = -1;
          for (const r of g.querySelectorAll<HTMLElement>('[role="row"]')) {
            const i = Number(r.getAttribute('aria-rowindex')) - 2;
            const b = r.getBoundingClientRect();
            if (i < 0 || b.top < box.top + headH - 1 || b.bottom > box.bottom + 1) continue;
            const ord = Number((r.querySelector('[aria-colindex="1"]')?.textContent ?? '').replace(/\D/g, ''));
            if (ord !== i) wrong.push(`row ${i} shows ${ord}`);
            rows.push(ord);
            last = Math.max(last, i);
          }
          if (last >= to) break;
          g.scrollTop += step;
        }
        return { rows, wrong, from, to };
      },
      [start, start + SEGMENT - 1, N, ROW_H, HEAD_H] as const,
    );
    const ms = performance.now() - t0;
    const segment = reqs.take();
    assert.deepEqual(seen.wrong, []);
    const uniq = [...new Set(seen.rows)].sort((a, b) => a - b);
    const inRange = uniq.filter((r) => r >= start && r < start + SEGMENT);
    assert.equal(inRange.length, SEGMENT, `rows seen in [${start}, ${start + SEGMENT}): ${inRange.length}`);
    assertConsecutive(inRange, 'the continuous segment');
    assert.ok(segment <= SEGMENT_RPCS, `${segment} page requests for ${SEGMENT} rows (budget ${SEGMENT_RPCS})`);

    // A fast fling (≈15 rows a frame) for frame times; rows may still be loading.
    reqs.take();
    const fling = await page.evaluate(async () => {
      const g = document.querySelector<HTMLElement>('[role="grid"]')!;
      const gaps: number[] = [];
      let last = performance.now();
      for (let k = 0; k < 240; k++) {
        g.scrollTop += 120;
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        gaps.push(now - last);
        last = now;
      }
      gaps.sort((a, b) => a - b);
      const at = (q: number) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]!;
      return { p50: at(0.5), p95: at(0.95), max: gaps.at(-1)!, cells: document.querySelectorAll('[role="gridcell"]').length };
    });
    const flingReqs = reqs.take();
    await loaded(page);
    const after = await page.evaluate(snapshot);
    assert.deepEqual(after.wrong, [], 'rows after the fling');

    const cdp = await page.context().newCDPSession(page).catch(() => null);
    let heap = 'n/a';
    if (cdp) {
      await cdp.send('HeapProfiler.collectGarbage');
      const m = (await cdp.send('Performance.enable').then(() => cdp.send('Performance.getMetrics'))).metrics;
      const used = m.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0;
      heap = `${(used / 1024 / 1024).toFixed(1)} MB`;
    }
    console.log(`continuous: ${SEGMENT} rows in ${(ms / 1000).toFixed(1)} s, ${segment} dataset:page requests (budget ${SEGMENT_RPCS}) → ${((segment * 10_000) / SEGMENT).toFixed(1)} per 10k rows`);
    console.log(`fling (240 frames × 120 px): frame p50 ${fling.p50.toFixed(1)} ms, p95 ${fling.p95.toFixed(1)} ms, max ${fling.max.toFixed(1)} ms (~${(1000 / fling.p50).toFixed(0)} fps); ${flingReqs} requests; ${fling.cells} cells in the DOM`);
    console.log(`JS heap after GC: ${heap}`);
  },
  { rpcBudget: 2 + JUMP_RPCS + SEGMENT_RPCS + 60 },
);

e2e('keyboard, resize, sticky header and type badges; screenshots in both themes', async (s) => {
  const { page } = s;
  await open(s);
  const grid = page.getByRole('grid', { name: 'One million rows rows' });
  const active = () => grid.getAttribute('aria-activedescendant');
  const activeText = async () => page.locator(`[id="${await active()}"]`).textContent();

  // Type badges: one per column, icon + word, and the type in the accessible name.
  const heads = page.getByRole('columnheader');
  assert.equal(await heads.count(), 3);
  assert.match((await heads.nth(0).textContent()) ?? '', /ordinal.*123.*Number/);
  assert.match((await heads.nth(1).textContent()) ?? '', /label.*Abc.*Text/);
  assert.match((await heads.nth(2).textContent()) ?? '', /day.*Date.*Date/);

  await grid.focus();
  assert.match((await active()) ?? '', /-r0c0$/);
  const ring = await page.locator(`[id="${await active()}"]`).evaluate((el) => getComputedStyle(el).boxShadow);
  assert.notEqual(ring, 'none', 'the active cell is outlined while the grid has focus');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  assert.match((await active()) ?? '', /-r2c1$/);
  assert.equal(await activeText(), 'row 2');
  await page.keyboard.press('End');
  assert.match((await active()) ?? '', /-r2c2$/);
  await page.keyboard.press('PageDown');
  const paged = Number(/-r(\d+)c2$/.exec((await active()) ?? '')?.[1]);
  assert.ok(paged > 10, `PageDown moved a screen (to row ${paged})`);
  await page.keyboard.press('ControlOrMeta+End');
  await loaded(page);
  assert.match((await active()) ?? '', /-r999999c2$/);
  await page.keyboard.press('Home');
  assert.equal(await activeText(), '999,999', 'the last row, drawn and in view');
  await page.keyboard.press('ControlOrMeta+Home');
  await loaded(page);
  assert.equal(await activeText(), '0');

  // The header stays put while the body scrolls under it.
  await jumpTo(page, 400_000);
  const gridTop = (await grid.boundingBox())!.y;
  const headTop = (await heads.nth(0).boundingBox())!.y;
  assert.ok(Math.abs(headTop - gridTop) <= 2, `sticky header at ${headTop}, grid at ${gridTop}`);

  // Resize: Shift+Arrow on a header cell, and a drag on its edge.
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowUp');
  assert.match((await active()) ?? '', /-h0$/);
  const w0 = (await heads.nth(0).boundingBox())!.width;
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  const w1 = (await heads.nth(0).boundingBox())!.width;
  assert.equal(Math.round(w1 - w0), 32, 'two Shift+Right steps widen by 32 px');
  const edge = (await heads.nth(1).boundingBox())!;
  await page.mouse.move(edge.x + edge.width - 1, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width + 59, edge.y + edge.height / 2, { steps: 4 });
  await page.mouse.up();
  const w2 = (await heads.nth(1).boundingBox())!.width;
  assert.equal(Math.round(w2 - edge.width), 60, 'a drag on the edge widens by the drag');

  const files = await screens(page, 'datagrid');
  console.log(`screens: ${files.join(', ')}`);
});

e2e('loading, error and empty states', async (s) => {
  const { page } = s;
  const url = datasetUrl(s);
  const shots: string[] = [];
  const both = async (name: string, ready: () => Promise<unknown>) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
      await page.goto(url);
      await ready();
      const file = path.join(SCREENS, `datagrid-${name}-${theme}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
    }
  };
  await page.goto('/');
  await settled(page);

  // Loading: the first page held back — the real header over skeleton rows, not a spinner.
  const held: (() => void)[] = [];
  await page.route('**/api/rpc/dataset%3Apage', async (route) => {
    await new Promise<void>((r) => held.push(r));
    await route.continue().catch(() => {}); // the page that asked may be gone
  });
  await both('loading', async () => {
    await page.locator('[role="grid"][aria-busy="true"][aria-rowcount="-1"]').waitFor();
    assert.equal(await page.getByRole('columnheader').count(), 3, 'the real header over the loading rows');
  });
  for (const go of held) go();
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // Error: the server answers { ok: false } (a 200 — a 500 would itself be a console error).
  await page.route('**/api/rpc/dataset%3Apage', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'The table file is missing.' }) }),
  );
  await both('error', () => page.getByRole('alert').getByText('Rows could not be loaded').waitFor());
  assert.ok(await page.getByText('The table file is missing.').isVisible());
  assert.ok(await page.getByRole('button', { name: 'Try again' }).isVisible());
  await page.unroute('**/api/rpc/dataset%3Apage');
  // …and Try again recovers.
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('[role="row"][aria-rowindex="2"] [aria-colindex="1"]', { hasText: /^0$/ }).waitFor();

  // Empty: a search that matched nothing looks like this.
  await page.route('**/api/rpc/dataset%3Apage', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, rows: [], total: 0, offset: 0 }) }),
  );
  await both('empty', () => page.getByRole('heading', { name: 'No rows' }).waitFor());
  await page.unroute('**/api/rpc/dataset%3Apage');

  // A dataset id that does not exist: the page's own empty state.
  await page.goto(`/data/${s.server.sample.projectId}/00000000-0000-4000-8000-000000000000`);
  await page.getByRole('heading', { name: 'Dataset not found' }).waitFor();
  await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
  console.log(`screens: ${shots.join(', ')}`);
});
