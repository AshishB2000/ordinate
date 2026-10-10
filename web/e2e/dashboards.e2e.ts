// Dashboards, sharing, alerts, comments (T2.9) against the real server:
//
//   viewer      the sample dashboard → Present (the authoring chrome goes, Esc
//               comes back) → Style: Dark previews and applies, Auto again →
//               "Alert me…" on a KPI (the server's figure, Test says it would
//               fire, Save) → the card wears the bell, the top bar's inbox and
//               the rules page list the rule → a card comment (the author is
//               the signed-in user, never typed) → reply → resolve → the
//               dashboard's comments with Open / Resolved / All
//   cards       Markdown text (bold, a safe link, an unsafe one dropped,
//               <script> as text, {{Revenue}} = the server's $5.2M), the
//               Summary card's server sentences, a pivot's "Copy as table"
//               and "Export CSV", a navigate action → the target opens with
//               "From …" and Back returns
//   runtime     Reset controls; Category…; a map click joins the selection; a
//               bar click drills; the dataset page's comment door; Home's
//               "Recent comments" opens the thread on its record
//   click       click-to-filter on a new sheet: a bar click filters the OTHER
//               cards (a KPI and a table, both the server's), the clicked
//               chart keeps every category, the chip row says what is on;
//               ⌘/Ctrl-click adds a value, Esc and a chip clear; nothing is
//               saved; the sheet's switch off → the click drills again
//   publish     /dashboards empty → Publish… → the live size estimate →
//               Publish → the row → the published page at /p/<id>/ renders
//               with ZERO CSP violations under its own pinned policy
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled } from './fixtures.ts';

/** One screenshot per theme WITHOUT a reload (a dialog or a mode stays up). */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
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

async function openSample(page: Page, pid: string): Promise<void> {
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  await page.getByRole('link', { name: /Retail overview/ }).click();
  await page.getByRole('heading', { level: 1, name: 'Retail overview' }).waitFor();
  await page.getByRole('group', { name: 'Revenue card' }).getByText('$5.2M').waitFor();
}

e2e('viewer: present, style, alert me, the inbox, comments', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await openSample(page, pid);
  console.log(`rpc: dashboard open ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // ── Present ────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Present' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).waitFor();
  assert.equal(await page.getByRole('group', { name: 'Add to the sheet' }).count(), 0, 'the authoring chrome is gone');
  await page.waitForTimeout(1200); // the map redraws into its new size
  await screensInPlace(page, 'dashboards-present');
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Add to the sheet' }).waitFor();

  // ── Style ──────────────────────────────────────────────────────────────
  const more = () => page.getByRole('button', { name: 'More dashboard actions' }).click();
  await more();
  await page.getByRole('menuitem', { name: 'Style…' }).click();
  const style = page.getByRole('dialog', { name: 'Dashboard style' });
  await style.getByRole('radio', { name: /Dark/ }).click();
  await page.waitForFunction(() => /theme_dark/.test(document.querySelector('[data-print-root]')?.className ?? ''));
  await screensInPlace(page, 'dashboards-style');
  await style.getByRole('button', { name: 'Apply' }).click();
  await style.waitFor({ state: 'detached' });
  await more();
  await page.getByRole('menuitem', { name: 'Style…' }).click();
  await style.getByRole('radio', { name: /Auto/ }).click();
  await style.getByRole('button', { name: 'Apply' }).click();
  await page.waitForFunction(() => !/theme_dark/.test(document.querySelector('[data-print-root]')?.className ?? ''));
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  console.log(`rpc: open + present + style ${rpc.loads.at(-1)?.rpcs ?? 0}`);
  // Each part of the flow on a fresh load, so the budget measures one part at a time.
  await page.reload();
  await settled(page);

  // ── Alert me on a KPI ──────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Revenue card actions' }).click();
  await page.getByRole('menuitem', { name: 'Alert me…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Alert me…' });
  await dlg.getByText(/^(\$5\.2M|5[.,][0-9])/).first().waitFor(); // the server's figure, before any field
  await dlg.getByLabel('Value').fill('1000000000000');
  await dlg.getByRole('button', { name: 'Test' }).click();
  await dlg.getByText(/Would fire/).waitFor();
  await screensInPlace(page, 'dashboards-alert');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.getByRole('group', { name: 'Revenue card' }).getByRole('img', { name: 'Watched by an alert' }).waitFor();
  await page.getByRole('button', { name: 'Alerts', exact: true }).click();
  await page.getByText('Nothing has fired').waitFor();
  await screensInPlace(page, 'dashboards-inbox');
  await page.getByRole('button', { name: 'Manage rules' }).click();
  const rules = page.getByRole('dialog', { name: 'Alert rules' });
  await rules.getByRole('cell', { name: 'Revenue falls below 1000000000000', exact: true }).waitFor();
  await screensInPlace(page, 'dashboards-rules');
  await rules.getByRole('button', { name: 'Done' }).click();
  console.log(`rpc: open + alert me + inbox + rules ${rpc.loads.at(-1)?.rpcs ?? 0}`);
  await page.reload();
  await settled(page);

  // ── Comments ───────────────────────────────────────────────────────────
  const kpi = page.getByRole('group', { name: 'Revenue card' });
  await kpi.getByRole('button', { name: 'Comment on this' }).click();
  const panel = page.getByRole('dialog', { name: 'Comments on this card' });
  await panel.getByText('No comments yet — start the discussion').waitFor();
  await panel.getByLabel('New comment').fill('Check the **North** figure');
  await panel.getByRole('button', { name: 'Post' }).click();
  const thread = panel.getByRole('listitem', { name: 'Comment by dev@local' });
  await thread.locator('strong', { hasText: 'North' }).waitFor();
  await thread.getByLabel('Reply').fill('On it');
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await thread.getByText('On it').waitFor();
  await screensInPlace(page, 'dashboards-comments');
  await thread.getByRole('button', { name: 'Resolve' }).click();
  await thread.getByText('Resolved', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await kpi.getByRole('button', { name: 'Comments — all resolved' }).waitFor();
  await page.getByRole('button', { name: 'Comments on this dashboard' }).click();
  const all = page.getByRole('dialog', { name: 'Comments on this dashboard' });
  await all.getByText('All caught up').waitFor();
  await all.getByRole('radio', { name: /Resolved/ }).click();
  await all.getByText('Check the').waitFor();
  await page.keyboard.press('Escape');
  console.log(`rpc: open + comments ${rpc.loads.at(-1)?.rpcs ?? 0}`);
});

e2e('cards: markdown text, the summary, a pivot copied and exported, a navigate action and Back', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
  const pivot = await call(page, 'visual:save', {
    projectId: pid, datasetId: ds, name: 'Revenue pivot', chartType: 'pivot',
    encoding: {
      category: 'region', series: 'category', values: [{ column: 'revenue', aggregation: 'sum' }],
      pivot: { rows: [{ column: 'region' }], columns: [{ column: 'category' }], values: [{ column: 'revenue', aggregation: 'sum' }], totals: { rows: true, columns: true, grand: true } },
    },
  });
  const target = await call(page, 'analysis:create', { projectId: pid, name: 'Linked detail' });
  const card = (type: string, layout: object, extra: object) => ({ id: crypto.randomUUID(), type, layout, ...extra });
  const made = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Cards',
    sheets: [{
      id: crypto.randomUUID(),
      name: 'Sheet 1',
      cards: [
        card('summary', { x: 0, y: 0, w: 12, h: 4 }, {}),
        card('text', { x: 0, y: 4, w: 6, h: 5 }, {
          heading: 'Notes',
          text: '## Read me\n**Revenue** is {{Revenue}} — see [the guide](https://example.com/guide) or [this](javascript:alert(1)).\n\n- one\n- two\n\n<script>alert(1)</script>',
        }),
        card('visual', { x: 6, y: 4, w: 6, h: 6 }, {
          visualId: pivot.id,
          actions: [{ kind: 'navigate', trigger: 'menu', carry: 'all_selection', target: { analysisId: target.id }, label: 'Open the detail' }],
        }),
      ],
    }],
  });
  assert.ok(made.id, JSON.stringify(made));
  await page.goto(`/analyses/${pid}/${made.id}`);
  await settled(page);

  // Markdown: elements, never HTML; the token is the server's figure for the saved metric.
  const notes = page.getByRole('group', { name: 'Notes card' });
  await notes.getByRole('heading', { name: 'Read me' }).waitFor();
  await notes.locator('[data-token="Revenue"]', { hasText: '$5.2M' }).waitFor();
  assert.equal(await notes.locator('a').count(), 1, 'only the https link survives');
  assert.equal(await notes.locator('a').getAttribute('href'), 'https://example.com/guide');
  assert.equal(await notes.locator('script').count(), 0);
  await notes.getByText('<script>alert(1)</script>').waitFor();

  // The summary: sentences the server wrote about the sheet's own tiles (or its designed empty state).
  const summary = page.getByRole('group', { name: 'Summary card' });
  await summary.locator('li, h3').first().waitFor();
  await summary.getByText(/Updated|Nothing to summarise yet/).first().waitFor();

  // The pivot: T1.2's table; Copy as table / Export CSV through the Share policy.
  const pv = page.getByRole('group', { name: 'Revenue pivot card' });
  await pv.getByRole('table').first().waitFor();
  await screens(page, 'dashboards-cards');
  await page.getByRole('button', { name: 'Revenue pivot card actions' }).click();
  await page.getByRole('menuitem', { name: 'Copy as table' }).click();
  await page.getByText('Table copied').waitFor();
  const tsv = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(tsv, /\tTotal\n/, tsv.slice(0, 120));
  assert.match(tsv, /\nTotal\t/);
  await page.getByRole('button', { name: 'Revenue pivot card actions' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export CSV' }).click();
  assert.equal((await download).suggestedFilename(), 'Revenue pivot.csv');

  // A navigate action from the menu: the target opens saying where it came from; Back returns.
  await page.getByRole('button', { name: 'Revenue pivot card actions' }).click();
  await page.getByRole('menuitem', { name: 'Open the detail' }).click();
  await page.getByRole('heading', { level: 1, name: 'Linked detail' }).waitFor();
  const strip = page.getByRole('region', { name: 'Selection' });
  await strip.getByText('From Cards').waitFor();
  await screensInPlace(page, 'dashboards-crumb');
  await strip.getByRole('button', { name: 'Back to Cards' }).click();
  await page.getByRole('heading', { level: 1, name: 'Cards' }).waitFor();
});

e2e('publish: the dialog, the list, and the published page under its own CSP', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  await page.getByRole('heading', { name: 'Nothing published yet' }).waitFor();
  await screensInPlace(page, 'dashboards-empty');
  console.log(`rpc: /dashboards load ${rpc.loads.at(-1)?.rpcs ?? 0}`);
  await page.getByRole('button', { name: 'Publish…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Publish' });
  await dlg.getByRole('checkbox', { name: 'Retail overview' }).waitFor();
  // The newest dashboard is picked first (the earlier test made two); publish the sample alone.
  const boxes = dlg.getByRole('checkbox');
  assert.equal(await boxes.first().isChecked(), true, 'the first dashboard is picked');
  for (let i = 0; i < (await boxes.count()); i++) {
    const box = boxes.nth(i);
    const want = (await box.getAttribute('aria-label') ?? (await box.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? ''))) === 'Retail overview';
    if ((await box.isChecked()) !== want) await box.click();
  }
  await dlg.getByRole('meter').waitFor(); // the server's size estimate
  assert.equal(await dlg.getByRole('radio', { name: 'Anyone with the link' }).isDisabled(), true, 'public links are an org setting, off');
  await dlg.getByLabel('Site title').fill('Retail board');
  await dlg.getByRole('checkbox', { name: 'Re-publish after data refreshes' }).check();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent?.trim() === 'Publish' && !(b as HTMLButtonElement).disabled));
  await screensInPlace(page, 'dashboards-publish');
  await dlg.getByRole('button', { name: 'Publish', exact: true }).click();
  await dlg.waitFor({ state: 'detached' });
  const row = page.getByRole('listitem', { name: 'Retail board' });
  await row.getByText('Your organisation').waitFor();
  await row.getByText(/re-publishes after data refreshes/).waitFor();
  await screens(page, 'dashboards-list');
  const href = (await row.getByRole('link', { name: 'Retail board' }).getAttribute('href')) as string;
  assert.match(href, /\/p\/[0-9a-f-]{36}\/$/);

  // The published page: the server's own route, its pinned policy as the header; zero CSP violations (fixture).
  const res = await page.goto(href);
  assert.match(res?.headers()['content-security-policy'] ?? '', /^default-src 'none'.*frame-ancestors 'none'$/);
  await page.getByRole('link', { name: /Retail overview/ }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('canvas').length > 0 && !!document.querySelector('.pub-title'));
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SCREENS, `dashboards-published-${scheme}.png`), fullPage: true });
  }
});

/** Clicks points across a box until `done()` holds — a mark's pixel position depends on the data and the font. */
async function clickUntil(page: Page, box: { x: number; y: number; width: number; height: number }, done: () => Promise<boolean>, cols = 9, rows = 6): Promise<boolean> {
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      await page.mouse.click(box.x + (box.width * c) / (cols + 1), box.y + (box.height * r) / (rows + 1));
      await page.waitForTimeout(120);
      if (await done()) return true;
    }
  }
  return false;
}

e2e('runtime: reset controls, quick filters, map selection, a drill, comment doors and Home', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
  const vis = (await call(page, 'visual:list', { projectId: pid })) as { id: string; name: string }[];
  const byName = (n: string) => vis.find((v) => v.name === n)?.id as string;
  const card = (type: string, layout: object, extra: object) => ({ id: crypto.randomUUID(), type, layout, ...extra });
  const made = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Runtime',
    sheets: [{
      id: crypto.randomUUID(),
      name: 'Sheet 1',
      // Click-to-filter is ON for a new sheet; this one turns it off, so a plain click on a bar still drills (below).
      clickFilter: false,
      cards: [
        card('control', { x: 0, y: 0, w: 0, h: 0 }, { control: { kind: 'dropdown', label: 'Region', datasetId: ds, column: 'region', default: { value: 'West' } } }),
        card('visual', { x: 0, y: 0, w: 6, h: 7 }, { visualId: byName('Revenue by category') }),
        card('visual', { x: 6, y: 0, w: 6, h: 7 }, { visualId: byName('Profit by state') }),
      ],
    }],
  });
  await page.goto(`/analyses/${pid}/${made.id}`);
  await settled(page);

  // ── Reset controls: back to what the author published ─────────────────
  const bar = page.getByRole('group', { name: 'Filters' });
  assert.equal(await bar.getByRole('button', { name: 'Reset controls' }).count(), 0, 'at the defaults there is nothing to reset');
  await bar.getByRole('button', { name: /^Clear Region/ }).click();
  await bar.getByRole('button', { name: 'Reset controls' }).click();
  await bar.getByRole('button', { name: /^Clear Region/ }).waitFor(); // West again, so the control is on
  assert.equal(await bar.getByRole('button', { name: 'Reset controls' }).count(), 0);

  // ── Category…: a one-value dashboard filter ─────────────────────────────
  await page.getByRole('navigation', { name: 'Authoring panels' }).getByRole('button', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'Category…' }).click();
  const quick = page.getByRole('dialog', { name: 'Category: pick a value' });
  await quick.getByRole('combobox', { name: 'Column' }).click();
  await page.getByRole('option', { name: 'category (text)', exact: true }).click();
  await quick.getByRole('combobox', { name: 'Value' }).click();
  await page.getByRole('option').first().click();
  await quick.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('button', { name: 'Undo Set category filter' }).waitFor();
  await page.getByRole('button', { name: 'Undo Set category filter' }).click();

  // ── A click on a map region joins the selection (cv-mark-click) ─────────
  const map = page.getByRole('group', { name: 'Profit by state card' }).locator('canvas').first();
  await map.waitFor();
  await page.waitForTimeout(1500); // the map's first paint
  const strip = page.getByRole('region', { name: 'Selection' });
  const hit = await clickUntil(page, (await map.boundingBox())!, async () => (await strip.count()) > 0);
  assert.ok(hit, 'a click on a region puts it in the selection strip');
  await strip.getByText(/^state = /).waitFor();
  await screensInPlace(page, 'dashboards-runtime');
  await strip.getByRole('button', { name: /^Remove selection/ }).click();

  // ── A plain click on a bar shows the rows behind it (wireDrillClick) ───
  const bars = page.getByRole('group', { name: 'Revenue by category card' }).locator('canvas').first();
  const drilled = await clickUntil(page, (await bars.boundingBox())!, async () => (await page.getByRole('dialog').count()) > 0, 7, 4);
  assert.ok(drilled, 'a click on a bar opens the rows behind it');
  await page.getByRole('dialog').getByText(/rows?/i).first().waitFor();
  await screensInPlace(page, 'dashboards-drill');
  await page.keyboard.press('Escape');
  console.log(`rpc: runtime dashboard ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // ── The dataset page's comment door, then Home's "Recent comments" ─────
  await page.goto(`/data/${pid}/${ds}`);
  await settled(page);
  await page.getByRole('button', { name: 'Comments' }).click();
  const panel = page.getByRole('dialog', { name: 'Comments on this dataset' });
  await panel.getByLabel('New comment').fill('Is **ship_days** right for the West?');
  await panel.getByRole('button', { name: 'Post' }).click();
  await panel.getByRole('listitem', { name: 'Comment by dev@local' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '1 open comment' }).waitFor();
  console.log(`rpc: dataset page + comment ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // The visual builder has the same door.
  await page.goto(`/visuals/${pid}/${byName('Revenue by category')}`);
  await settled(page);
  await page.getByRole('button', { name: 'Comments' }).waitFor();

  await page.goto('/');
  await settled(page);
  const recent = page.getByRole('region', { name: 'Recent comments' });
  await recent.getByText('1 open').waitFor();
  await screens(page, 'dashboards-home-comments');
  await recent.getByRole('button', { name: /dev@local on Retail orders/ }).click();
  await page.waitForURL(new RegExp(`/data/${pid}/${ds}\\?comment=dataset:`));
  await page.getByRole('dialog', { name: 'Comments on this dataset' }).getByText('ship_days').waitFor();
  await page.goto('/');
  await settled(page);
  await page.getByRole('region', { name: 'Recent comments' }).getByText('Is ship_days right for the West?').waitFor();
});

type Point = { x: number; y: number };

/** Clicks along a box, low rows first (where every bar is), until `done()` holds; returns the point that did it. */
async function findMark(page: Page, box: { x: number; y: number; width: number; height: number }, done: () => Promise<boolean>, fromRight = false): Promise<Point | null> {
  const cols = 14;
  for (const fy of [0.8, 0.65, 0.5]) {
    for (let c = 1; c <= cols; c++) {
      const at = { x: box.x + (box.width * (fromRight ? cols + 1 - c : c)) / (cols + 1), y: box.y + box.height * fy };
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(150);
      if (await done()) return at;
    }
  }
  return null;
}

async function until(cond: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(what);
}

e2e('click-to-filter: a bar filters the other cards, its own chart stays whole, chips, multi-select, Esc, the switch', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
  const vis = (await call(page, 'visual:list', { projectId: pid })) as { id: string; name: string }[];
  const bars = vis.find((v) => v.name === 'Revenue by category')?.id as string;
  // A second visual over the same category: what the OTHER cards see, read as a table.
  const check = await call(page, 'visual:save', { projectId: pid, datasetId: ds, name: 'Category check', chartType: 'column', encoding: { category: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] } });
  const card = (type: string, layout: object, extra: object) => ({ id: crypto.randomUUID(), type, layout, ...extra });
  // No `clickFilter` in the request: a NEW dashboard's sheet gets it ON from the server.
  const made = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Click to filter',
    sheets: [{
      id: crypto.randomUUID(),
      name: 'Sheet 1',
      cards: [
        card('metric', { x: 0, y: 0, w: 4, h: 3 }, { metric: { datasetId: ds, column: 'revenue', aggregation: 'sum', label: 'Total revenue' } }),
        card('visual', { x: 0, y: 3, w: 7, h: 7 }, { visualId: bars }),
        card('visual', { x: 7, y: 3, w: 5, h: 7 }, { visualId: check.visual?.id ?? check.id }),
      ],
    }],
  });
  assert.equal(made.sheets[0].clickFilter, true, 'a new sheet is written with click-to-filter on');
  // Every write of the record from here on: a click must never be one.
  const updates: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/rpc\/analysis(:|%3A)update/.test(r.url())) updates.push(r.url());
  });
  await page.goto(`/analyses/${pid}/${made.id}`);
  await settled(page);

  const kpi = page.getByRole('group', { name: 'Total revenue card' });
  const source = page.getByRole('group', { name: 'Revenue by category card' });
  const other = page.getByRole('group', { name: 'Category check card' });
  const chips = page.getByRole('group', { name: 'Click filters' });
  const chip = chips.getByRole('button', { name: /^Remove click filter category: / });
  const picked = async () => ((await chip.count()) ? ((await chip.getAttribute('aria-label')) ?? '').replace('Remove click filter category: ', '') : '');
  const asTable = async (group: typeof source, name: string, on: boolean) => {
    await page.getByRole('button', { name: `${name} card actions` }).click();
    await page.getByRole('menuitem', { name: on ? 'View as table' : 'View as chart' }).click();
    await (on ? group.getByRole('table') : group.locator('canvas').first()).waitFor();
  };
  const rows = (group: typeof source) => group.locator('tbody tr').count();

  await asTable(other, 'Category check', true);
  const all = await rows(other);
  assert.ok(all >= 2, `the sample has several categories, got ${all}`);
  // The KPI's figure: the server's display string, the one text in the card that is only a number.
  const figure = () => kpi.getByText(/^[^\d\s]?[\d.,]+[KMB]?$/).first().innerText();
  await kpi.getByText(/^[^\d\s]?[\d.,]+[KMB]?$/).first().waitFor();
  const total = await figure();
  // Nothing clicked yet: the row is already there, saying what a click does — so the sheet does not jump when a chip arrives.
  await chips.getByText('Click a mark on a chart to filter the other cards.').waitFor();
  assert.equal(await chip.count(), 0, 'nothing clicked: no chip');

  // ── A plain click: the other cards filter, this chart does not ─────────
  // A click on a card selects it and opens Properties beside the sheet: open it first, so the bars do not move after they are measured.
  await source.getByRole('button', { name: 'Card properties' }).click();
  const props = page.getByRole('complementary', { name: 'Properties' });
  await props.getByRole('checkbox', { name: 'Clicking this visual filters the sheet' }).waitFor();
  assert.equal(await props.getByRole('checkbox', { name: 'Clicking this visual filters the sheet' }).isChecked(), true, 'the visual follows the sheet’s switch');
  const canvas = source.locator('canvas').first();
  await canvas.waitFor();
  await page.waitForTimeout(600); // the bars' entrance, the flyout's slide
  const box = (await canvas.boundingBox())!;
  const p1 = await findMark(page, box, async () => (await chip.count()) === 1);
  assert.ok(p1, 'a click on a bar puts its category in the chip row');
  const v1 = await picked();
  assert.ok(v1 && !v1.includes(','), `one value picked, got “${v1}”`);
  await until(async () => (await rows(other)) === 1, 'the other card is filtered to the one clicked category');
  await other.getByRole('rowheader', { name: v1, exact: true }).waitFor();
  await until(async () => (await figure()) !== total, 'the KPI is recomputed by the server under the click');
  const narrowed = await figure();
  await page.waitForTimeout(400); // the dimming's transition
  await screensInPlace(page, 'dashboards-clickfilter');
  // The clicked chart keeps EVERY category (its own click is left out of its request).
  await asTable(source, 'Revenue by category', true);
  assert.equal(await rows(source), all, 'the clicked chart stays whole');
  await asTable(source, 'Revenue by category', false);
  await page.waitForTimeout(400);

  // ── A different bar replaces; ⌘/Ctrl-click adds; ⌘/Ctrl-click again takes away ─
  const p2 = await findMark(page, box, async () => { const v = await picked(); return !!v && v !== v1; }, true);
  assert.ok(p2, 'a plain click on another bar replaces the selection');
  const v2 = await picked();
  assert.ok(!v2.includes(','), `still one value after a plain click, got “${v2}”`);
  await page.mouse.click(p1.x, p1.y);
  await until(async () => (await picked()) === v1, 'back to the first bar');
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(p2.x, p2.y);
  await page.keyboard.up('ControlOrMeta');
  await until(async () => (await picked()) === `${v1}, ${v2}`, 'a ⌘/Ctrl-click adds the second value');
  await chips.getByText(`${v1}, ${v2}`).waitFor();
  await until(async () => (await rows(other)) === 2, 'the other card shows both picked categories');
  await screensInPlace(page, 'dashboards-clickfilter-multi');
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(p1.x, p1.y);
  await page.keyboard.up('ControlOrMeta');
  await until(async () => (await picked()) === v2, 'a ⌘/Ctrl-click on a picked bar takes it away');

  // ── Esc clears everything; the only picked bar clicked again clears; a chip removes from the keyboard ─
  await page.keyboard.press('Escape');
  await until(async () => (await chip.count()) === 0, 'Esc clears the click-filters');
  await until(async () => (await rows(other)) === all && (await figure()) === total, 'and every card is back to the full figures');
  await page.mouse.click(p1.x, p1.y);
  await until(async () => (await picked()) === v1, 'picked again');
  await page.mouse.click(p1.x, p1.y);
  await until(async () => (await chip.count()) === 0, 'clicking the only picked bar again clears it');
  await page.mouse.click(p1.x, p1.y);
  await until(async () => (await picked()) === v1, 'picked a third time');
  await until(async () => (await figure()) === narrowed, 'the same click, the same figure');
  await chip.focus();
  await page.keyboard.press('Enter');
  await until(async () => (await chip.count()) === 0, 'a chip is a button: Enter removes it');
  await page.mouse.click(p1.x, p1.y);
  await until(async () => (await picked()) === v1, 'picked once more');
  await chips.getByRole('button', { name: 'Clear' }).click();
  await until(async () => (await chip.count()) === 0, 'Clear removes every chip');
  await page.waitForTimeout(900); // past the 600 ms autosave debounce
  assert.deepEqual(updates, [], 'clicking wrote nothing: click-filters are view state');
  console.log(`rpc: click-to-filter ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // ── The sheet's switch: off, and a plain click drills again ────────────
  await page.reload();
  await settled(page);
  await page.getByRole('navigation', { name: 'Authoring panels' }).getByRole('button', { name: 'Filters' }).click();
  const sw = page.getByRole('switch', { name: 'Click to filter' });
  assert.equal(await sw.isChecked(), true, 'the sheet’s switch is on');
  await screensInPlace(page, 'dashboards-clickfilter-switch');
  await sw.click();
  await page.getByRole('button', { name: 'Undo Turn off click to filter' }).waitFor();
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  const canvas2 = source.locator('canvas').first();
  await canvas2.waitFor();
  await page.waitForTimeout(600);
  const drilled = await findMark(page, (await canvas2.boundingBox())!, async () => (await page.getByRole('dialog').count()) > 0);
  assert.ok(drilled, 'with the switch off a click on a bar opens the rows behind it');
  assert.equal(await chips.count(), 0, 'and filters nothing: with no chart to click, the row is gone too');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  // ── A sheet the author adds starts with the switch ON, written to the record ─
  await page.getByRole('button', { name: 'Add sheet' }).click();
  await page.getByRole('tab', { name: 'Sheet 2' }).waitFor();
  await page.getByRole('navigation', { name: 'Authoring panels' }).getByRole('button', { name: 'Filters' }).click();
  await sw.waitFor();
  assert.equal(await sw.isChecked(), true, 'a new sheet has click-to-filter on');
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  const stored = (await call(page, 'analysis:open', { projectId: pid, id: made.id })) as { analysis: { sheets: { name: string; clickFilter?: boolean }[] } };
  assert.deepEqual(stored.analysis.sheets.map((s) => [s.name, s.clickFilter]), [['Sheet 1', false], ['Sheet 2', true]], 'both switches are in the saved record, as set');
});
