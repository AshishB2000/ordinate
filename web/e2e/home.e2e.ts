// Home and the app chrome (T2.1) against the real server and the seeded
// sample: the greeting and its counts, the preview cards, the one table of
// recent work and its pills, the New menu's doors, a pin that survives a
// reload (the caller's own, on the server), the Get-started card folding to
// its pill and back, a question handed to the Assistant dock, and a real job
// (`quality:run`, started from this tab) reaching the Jobs popover and a toast
// over the event stream. Screenshots of Home and the open Jobs popover in both
// themes.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { e2e, screens, settled } from './fixtures.ts';

/** The current document's event-stream id (a new one each load) — the X-Ordinate-Client its RPCs send. */
function clientIdOf(page: Page): { current: string } {
  const id = { current: '' };
  page.on('request', (r) => {
    const m = /\/api\/events\?client=([0-9a-f-]{36})/.exec(r.url());
    if (m) id.current = m[1]!;
  });
  return id;
}

e2e('Home: greeting, preview cards, the table of work, a pin, Get started, the ask bar, and a live job', async (s) => {
  const { page, server } = s;
  const client = clientIdOf(page);
  const t0 = Date.now();
  await page.goto('/');
  await settled(page);
  const firstPaint = Date.now() - t0;

  // ── the greeting ──
  assert.match((await page.getByTestId('home-greet').textContent()) ?? '', /, Dev$/);
  const recent = page.getByRole('region', { name: 'Recent', exact: true });
  const filterBy = (name: string) => page.getByRole('group', { name: 'Filter recent' }).getByRole('button', { name, exact: true });
  await recent.getByRole('listitem').first().waitFor();
  await filterBy('Datasets').click();
  const orders = recent.getByRole('link', { name: /^Retail orders, Dataset, 5,000 rows × \d+ columns, in / });
  await orders.waitFor();
  assert.match((await orders.getAttribute('href')) ?? '', new RegExp(`^/data/${server.sample.projectId}/[0-9a-f-]{36}$`));

  // ── one table, every kind of work: the pills narrow it ──
  await filterBy('Visuals').click();
  assert.ok((await recent.getByRole('listitem').count()) >= 1, 'saved visuals are rows of the same table');
  assert.match((await recent.getByRole('link').first().getAttribute('href')) ?? '', new RegExp(`^/visuals/${server.sample.projectId}/[0-9a-f-]{36}$`));
  assert.equal(await filterBy('Starred').count(), 0, 'no Starred filter: the pins have their own row');
  await filterBy('All').click();

  // ── Starred: the seed's pinned dashboard as a card with its picture drawn, then the sample's newest work to pin ──
  const pins = page.getByRole('region', { name: 'Starred', exact: true });
  const pinned = pins.locator('a:not([aria-label$=", suggested"])');
  await pins.getByRole('link').first().waitFor();
  assert.equal(await pinned.count(), 1);
  assert.match((await pinned.getAttribute('aria-label')) ?? '', /, Dashboard, /);
  assert.match((await pinned.getAttribute('href')) ?? '', new RegExp(`^/analyses/${server.sample.projectId}/[0-9a-f-]{36}$`));
  await pins.locator('canvas').first().waitFor();
  // The rest of the row: three suggestions, each with its own Star, so no hint is left.
  assert.equal(await pins.getByRole('link', { name: /, suggested$/ }).count(), 3);
  assert.equal(await pins.getByRole('button', { name: /^Star / }).count(), 3);
  assert.equal(await pins.getByText('Star what you come back to').count(), 0);
  // Data freshness: the sample is an uploaded file, so nothing refreshes and there is no section.
  assert.equal(await page.getByRole('region', { name: 'Data freshness' }).count(), 0);
  // No side column, and nothing on the page repeats the New menu's doors.
  assert.equal(await page.getByRole('complementary', { name: 'This project' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'CSV / Excel' }).count(), 0);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'New' });
  for (const door of ['Dashboard', 'Visual', 'CSV / Excel', 'Paste data', 'Screenshot', 'Database']) await menu.getByRole('menuitem', { name: door }).waitFor();
  await page.keyboard.press('Escape');
  // ── Your numbers: nothing followed, so the sample's first metrics, each with its figure and Follow ──
  const numbers = page.getByRole('region', { name: 'Your numbers' });
  await numbers.getByRole('article').first().waitFor();
  assert.equal(await numbers.getByRole('article').count(), 3);
  assert.equal(await numbers.getByRole('button', { name: 'Follow', exact: true }).count(), 3);
  assert.match((await numbers.getByRole('article').first().getAttribute('aria-label')) ?? '', /^.+: .*\d.*, suggested$/);
  // ── the hero: the ask bar in its own panel; this server has no model, and the panel says so ──
  const hero = page.getByRole('region', { name: 'What do you want to do?' });
  await hero.getByRole('textbox', { name: 'Ask a question or say what to build' }).waitFor();
  await hero.getByTestId('ai-not-ready').waitFor();
  // No model, so no suggestions: nothing on the page offers what the Assistant could not do (HomePage.test covers them with one).
  assert.equal(await hero.getByRole('group', { name: 'Suggestions' }).count(), 0);

  // ── a pin is the caller's own and survives a reload ──
  await recent.getByRole('button', { name: 'Star Retail orders' }).click();
  await recent.getByRole('button', { name: 'Unstar Retail orders' }).waitFor();
  await page.reload();
  await settled(page);
  await pins.getByRole('link', { name: /^Retail orders, Dataset, / }).waitFor();
  assert.equal(await pinned.count(), 2);
  await recent.getByRole('button', { name: 'Unstar Retail orders' }).click();
  await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="home-starred"] a:not([aria-label$=", suggested"])').length === 1);
  await recent.getByRole('button', { name: 'Star Retail orders' }).waitFor();

  // ── Get started: the tour (no Assistant stop without a model), folds to the pill and comes back ──
  const card = page.getByRole('region', { name: 'Get started' });
  await card.waitFor();
  assert.equal(await card.getByRole('listitem').count(), 4);
  const progress = (await card.getByRole('progressbar').getAttribute('aria-label')) ?? '';
  assert.match(progress, /^Get started: \d of 4 done$/);
  await screensHome(page);
  await card.getByRole('button', { name: 'Fold the checklist into a progress pill' }).click();
  const pill = page.getByRole('button', { name: /^Get started: \d of 4 done\. Show the checklist$/ });
  await pill.waitFor();
  assert.equal(await card.count(), 0);
  await pill.click();
  await card.waitFor();

  // ── the ask bar hands the question to the Assistant dock ──
  const ask = page.getByRole('textbox', { name: 'Ask a question or say what to build' });
  const question = 'Which month had the most orders?';
  await ask.fill(question);
  await ask.press('Enter');
  // The real dock (T2.12). This server has no model set up, but the sample ships verified questions (part 3
  // D8, D13), so the dock asks it at once: not one of them, it comes back to the composer with the connect hint.
  const composer = page.getByRole('textbox', { name: 'Ask the Assistant' });
  await page.waitForFunction((q) => (document.querySelector('#dock-panel textarea') as HTMLTextAreaElement | null)?.value === q, question);
  assert.equal(await composer.inputValue(), question);
  await page.locator('#dock-panel').getByText('Connect a model to ask anything else.').waitFor();
  assert.equal(await ask.inputValue(), '');
  assert.ok(await page.evaluate(() => !!document.getElementById('dock-panel')?.contains(document.activeElement)), 'focus moved into the dock');
  assert.equal(await page.getByRole('button', { name: 'Assistant', exact: true }).getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  await page.locator('#dock-panel').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Assistant', exact: true }).getAttribute('aria-expanded'), 'false');
  await screensOpen(page, 'home-dock', async () => {
    await ask.fill('Which region had the worst month?');
    await ask.press('Enter');
    await page.waitForFunction(() => !!(document.querySelector('#dock-panel textarea') as HTMLTextAreaElement | null)?.value);
  });

  // ── a real job from this tab: the stream drives the button, the toast and the list ──
  const jobs = page.getByRole('button', { name: /^Jobs/ });
  await jobs.click();
  await page.getByRole('heading', { name: 'Nothing running' }).waitFor();
  await page.keyboard.press('Escape');
  const datasetId = /\/data\/[0-9a-f-]{36}\/([0-9a-f-]{36})$/.exec((await orders.getAttribute('href')) ?? '')![1]!;
  const id = client.current;
  assert.ok(id, 'the page opened its event stream');
  const sent = Date.now();
  const reply = await page.evaluate(
    async ([cid, projectId, dsId]) => {
      // As the app's own rpc() sends it: this tab's client id and the CSRF pair (T6.2).
      const csrf = /(?:^|;\s*)(?:__Host-)?ordinate_csrf=([A-Za-z0-9_-]{43})/.exec(document.cookie)?.[1] ?? '';
      const res = await fetch('/api/rpc/quality:run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ordinate-Client': cid!, 'X-CSRF-Token': csrf },
        body: JSON.stringify({ args: [{ projectId, datasetId: dsId }] }),
      });
      return res.status;
    },
    [id, server.sample.projectId, datasetId] as const,
  );
  assert.equal(reply, 200);
  await page.getByRole('status', { name: 'Notifications' }).getByText(/: done$/).waitFor();
  const toastMs = Date.now() - sent;
  await jobs.click();
  const pop = page.getByRole('dialog', { name: 'Jobs' });
  const row = pop.getByRole('region', { name: 'Recent' }).getByRole('listitem');
  assert.equal(await row.count(), 1);
  assert.match((await row.textContent()) ?? '', /Done/);
  await screensOpen(page, 'home-jobs', async () => {
    await page.getByRole('button', { name: /^Jobs/ }).click();
    await page.getByRole('dialog', { name: 'Jobs' }).getByRole('listitem').first().waitFor();
  });
  await page.getByRole('button', { name: /^Jobs/ }).click();
  await pop.getByRole('button', { name: 'Clear finished' }).click();
  await pop.getByRole('heading', { name: 'Nothing running' }).waitFor();

  console.log(`home: settled in ${firstPaint} ms; quality job → toast over SSE in ${toastMs} ms`);
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
});

async function screensHome(page: Page): Promise<void> {
  const files = await screens(page, 'home');
  console.log(`screens: ${files.join(', ')}`);
}

/** Home with something opened over it (screens() reloads, so it is reopened per theme), in both themes. */
async function screensOpen(page: Page, name: string, open: () => Promise<void>): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
    await page.reload();
    await settled(page);
    await open();
    await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running')); // entrances
    const file = new URL(`./__screens__/${name}-${theme}.png`, import.meta.url).pathname;
    await page.screenshot({ path: file });
    console.log(`screens: ${file}`);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
  await page.reload();
  await settled(page);
}

e2e('Home → New → Dashboard opens the new-dashboard wizard, in Home\'s project', async ({ page, server }) => {
  await page.goto('/');
  await settled(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Dashboard' }).click();
  await page.getByRole('dialog', { name: 'Create dashboard' }).waitFor();
  const url = new URL(page.url());
  assert.equal(url.pathname, '/dashboards');
  assert.equal(url.searchParams.get('project'), server.sample.projectId);
});
