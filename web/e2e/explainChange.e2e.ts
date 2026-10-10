// "Explain this change" from a point on a chart, against the real server on
// the sample project's "Retail orders" (2023-01 … 2024-12) and a Live dataset
// over the fake warehouse:
//
//   point     a right-click on a bar of a time-series tile → its context menu →
//             "Explain this change" → the side panel: the server's sentence with
//             its figures, ranked dimensions, the waterfall. The baseline
//             switches to "same period last year" from the server's list. "Add
//             as a waterfall tile" saves a visual.
//   keyboard  the tile's ⋯ → "Explain a change…" (no right-click needed): the
//             latest period by default; the first period is refused with the
//             server's sentence and the picker still there.
//   refusals  a chart by category says it needs a date axis; a right-click on
//             it opens NO chart menu (the negative control); a Live tile shows
//             the typed refusal with "Make a copy".
//   handover  "Open in Analytics" lands on the workbench with the same question.
//
// Fails on any console error or CSP violation and stays inside the RPC budget.
// Screens in both themes go to web/e2e/__screens__/explain-change-*.png.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { e2e, SCREENS, settled, withLiveDataset } from './fixtures.ts';

withLiveDataset();

const SENTENCE = /^Sum of revenue (fell|rose) [\d.,]+% in Q[1-4] \d{4} vs Q[1-4] \d{4} \(from .+ to .+\)$/;

/** One screenshot per theme WITHOUT a reload (the panel stays up). */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

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

/** A right-click inside the plot area of a tile's chart, `fx` of the way across. */
async function rightClickChart(tile: Locator, fx: number): Promise<void> {
  const canvas = tile.locator('canvas');
  const box = await canvas.boundingBox();
  assert.ok(box, 'the chart is drawn');
  await canvas.click({ button: 'right', position: { x: box.width * fx, y: box.height * 0.5 } });
}

async function pick(page: Page, label: string, option: string | RegExp): Promise<string> {
  await page.getByRole('combobox', { name: label }).click();
  const opt = page.getByRole('option', { name: option }).first();
  const text = (await opt.textContent()) ?? '';
  await opt.click();
  return text;
}

e2e('explain a change: a chart point → the panel → another baseline → a tile; the keyboard way; refusals; the workbench', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
  const live = server.sample.live?.datasetId as string;
  const save = async (name: string, datasetId: string, chartType: string, encoding: object): Promise<string> => {
    const r = await call(page, 'visual:save', { projectId: pid, datasetId, name, chartType, encoding });
    const id = (r.visual?.id ?? r.id) as string;
    assert.match(id, /^[0-9a-f-]{36}$/, JSON.stringify(r));
    return id;
  };
  const byQuarter = await save('Revenue by quarter', ds, 'column', { category: 'order_date', grain: 'quarter', values: [{ column: 'revenue', aggregation: 'sum' }] });
  const byCategory = await save('Revenue by category (bars)', ds, 'column', { category: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] });
  const liveByMonth = await save('Live amount by month', live, 'column', { category: 'day', grain: 'month', values: [{ column: 'amount', aggregation: 'sum' }] });
  const card = (visualId: string, layout: object) => ({ id: crypto.randomUUID(), type: 'visual', layout, visualId });
  const made = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Explain a change',
    sheets: [{ id: crypto.randomUUID(), name: 'Sheet 1', cards: [card(byQuarter, { x: 0, y: 0, w: 12, h: 7 }), card(byCategory, { x: 0, y: 7, w: 6, h: 6 }), card(liveByMonth, { x: 6, y: 7, w: 6, h: 6 })] }],
  });
  assert.ok(made.id, JSON.stringify(made));
  await page.goto(`/analyses/${pid}/${made.id}`);
  await settled(page);
  const quarters = page.getByRole('group', { name: 'Revenue by quarter card' });
  await quarters.getByRole('img', { name: 'Revenue by quarter' }).waitFor();
  await page.waitForTimeout(600); // the bars finish animating in before a point is hit-tested

  // ── A right-click on a bar ──────────────────────────────────────────────
  await rightClickChart(quarters, 0.8);
  const menu = page.getByRole('menu', { name: 'Chart point actions' });
  await menu.getByRole('menuitem', { name: 'Explain this change' }).waitFor();
  await screensInPlace(page, 'explain-change-menu');
  await menu.getByRole('menuitem', { name: 'Explain this change' }).click();
  const panel = page.getByRole('dialog', { name: 'Explain a change · Revenue by quarter' });
  const heading = panel.getByRole('heading', { name: /^Sum of revenue / });
  await panel.getByRole('list', { name: 'Waterfall of contributors' }).waitFor();
  const first = (await heading.textContent()) ?? '';
  assert.match(first, SENTENCE, 'the header is the server’s sentence with its figures');
  const period = (await panel.getByRole('combobox', { name: 'Period' }).textContent()) ?? '';
  assert.ok(first.includes(` in ${period.trim()} vs `), `the sentence is about the picked period (${period}): ${first}`);
  assert.match((await panel.getByRole('combobox', { name: 'Compared with' }).textContent()) ?? '', /· previous period/);
  assert.ok((await panel.getByRole('group', { name: 'Break the change down by' }).getByRole('button').count()) >= 2, 'at least two dimensions ranked');
  await panel.getByRole('button', { name: 'Open in Analytics' }).waitFor();
  await screensInPlace(page, 'explain-change-panel');

  // ── Another baseline, from the server's list ────────────────────────────
  const chosen = await pick(page, 'Compared with', /same period last year/);
  const year = chosen.replace(/ · same period last year$/, '').trim();
  await page.waitForFunction((y) => Array.from(document.querySelectorAll('[role="dialog"] h2')).some((h) => (h.textContent ?? '').includes(` vs ${y} `)), year);
  assert.match((await heading.textContent()) ?? '', SENTENCE);
  assert.notEqual(await heading.textContent(), first, 'the comparison changed');

  // ── Add as a waterfall tile ─────────────────────────────────────────────
  await panel.getByRole('button', { name: 'Add as a waterfall tile' }).click();
  await page.getByText(/^Saved “Why Sum of revenue changed, by .+” to Visuals\.$/).waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  console.log(`rpc: open + point + baseline + tile ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // ── The keyboard's way: the tile menu ───────────────────────────────────
  await page.getByRole('button', { name: 'Revenue by quarter card actions' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Explain a change…' }).click();
  await panel.getByRole('list', { name: 'Waterfall of contributors' }).waitFor();
  assert.match((await panel.getByRole('combobox', { name: 'Period' }).textContent()) ?? '', /Q4 2024/, 'no point named → the latest period');
  // The first period has nothing before it: the server says so, and the picker stays.
  await pick(page, 'Period', 'Q1 2023');
  await panel.getByText('Q1 2023 is the first period on this chart, so there is nothing before it to compare with. Choose a later period.').waitFor();
  assert.equal(await panel.getByRole('list', { name: 'Waterfall of contributors' }).count(), 0);
  await panel.getByRole('combobox', { name: 'Period' }).waitFor();
  await screensInPlace(page, 'explain-change-refusal');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });

  // ── Not a chart over time ───────────────────────────────────────────────
  const bars = page.getByRole('group', { name: 'Revenue by category (bars) card' });
  await bars.getByRole('img', { name: 'Revenue by category (bars)' }).waitFor();
  await rightClickChart(bars, 0.5);
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole('menu', { name: 'Chart point actions' }).count(), 0, 'NEGATIVE CONTROL: no chart menu on a chart that is not over time');
  await page.getByRole('button', { name: 'Revenue by category (bars) card actions' }).click();
  await page.getByRole('menuitem', { name: 'Explain a change…' }).click();
  const flat = page.getByRole('dialog', { name: 'Explain a change · Revenue by category (bars)' });
  await flat.getByText('A change is explained between two periods, so this needs a chart with a date on its axis.').waitFor();
  await page.keyboard.press('Escape');
  await flat.waitFor({ state: 'detached' });

  // ── A Live dataset: the typed refusal and a copy ────────────────────────
  const liveTile = page.getByRole('group', { name: 'Live amount by month card' });
  await liveTile.getByRole('img', { name: 'Live amount by month' }).waitFor();
  await page.waitForTimeout(600);
  await rightClickChart(liveTile, 0.5);
  await menu.getByRole('menuitem', { name: 'Explain this change' }).click();
  const livePanel = page.getByRole('dialog', { name: 'Explain a change · Live amount by month' });
  await livePanel.getByRole('heading', { name: 'Off for this Live dataset' }).waitFor();
  await livePanel.getByRole('button', { name: 'Make a copy' }).waitFor();
  assert.equal(await livePanel.getByRole('list', { name: 'Waterfall of contributors' }).count(), 0);
  await screensInPlace(page, 'explain-change-live');
  await page.keyboard.press('Escape');
  await livePanel.waitFor({ state: 'detached' });
  console.log(`rpc: the whole dashboard visit ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // ── Open in Analytics ───────────────────────────────────────────────────
  await rightClickChart(quarters, 0.8);
  await menu.getByRole('menuitem', { name: 'Explain this change' }).click();
  await panel.getByRole('list', { name: 'Waterfall of contributors' }).waitFor();
  const asked = (await heading.textContent()) ?? '';
  await panel.getByRole('button', { name: 'Open in Analytics' }).click();
  await page.getByRole('heading', { level: 1, name: 'Why did this change?' }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/analytics/${pid}/${ds}/drivers`);
  assert.equal(new URL(page.url()).search, '', 'the question travels in router state, not the URL');
  await page.getByRole('heading', { level: 2, name: asked }).waitFor();
  await page.getByRole('note').filter({ hasText: 'the change you opened from a chart' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await screensInPlace(page, 'explain-change-analytics');
  for (const l of rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
});
