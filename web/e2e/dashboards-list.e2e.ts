// The Dashboards page, an editor's (docs/superpowers/specs/2026-10-29-dashboard-drafts-publish-design.md), against
// the real server:
//
//   drafts     the old Analyses address lands here → nothing published yet, so it opens on Drafts: the sample
//              dashboard's card, its preview drawn from the server's figures; Create dashboard's arrow offers a blank
//              dashboard and a screenshot rebuilt, and nothing else in the header does
//   published  published over RPC → the page opens on Published → a rename makes its edits not live, and the card says
//              so → its ⋯ (Open published, Edit, Preview, …, Unpublish, Delete) → Unpublish, confirmed, puts it back in
//              Drafts, and the Published tab says it is empty
//   first      a project with no dashboard: "Start your first dashboard", with Create, Draft with AI (shut, no model),
//              the screenshot rebuild link — Create opens the wizard
//   phone      the same states at 414 and 375 wide (phoneFits.ts): nothing scrolls sideways, both menus and the dialog
//              are on screen, the header's two ways in stack full width, every control of the page's own is a thumb's
//              target (screens: dashboards-list-phone-*)
//
// A viewer's page is walked in view-only.e2e.ts (it needs Postgres for a second person), and on a phone in
// dashboards-list-viewer.e2e.ts.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled } from './fixtures.ts';
import { phoneFits, PHONE } from './phoneFits.ts';

/** One screenshot per theme WITHOUT a reload (a menu stays open). */
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

e2e('the Dashboards page: drafts, published with edits not live, the card menu, Unpublish, the create menu', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  const loaded = (what: string) => console.log(`rpc: ${what} ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // ── Drafts: the old address lands here, on the tab that has something ──
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  await page.waitForURL(/\/dashboards\?project=/);
  const drafts = page.getByRole('list', { name: 'Draft dashboards' });
  await drafts.getByRole('link', { name: /Retail overview/ }).waitFor();
  assert.equal(await page.getByRole('tab', { name: /^Drafts/ }).getAttribute('aria-selected'), 'true', 'nothing published: Drafts');
  assert.deepEqual((await page.getByRole('tab').allTextContents()).map((t) => t.trim()), ['Published0', 'Drafts1'], 'two tabs, no All');
  assert.equal(await page.getByRole('navigation').getByRole('link', { name: 'Analyses' }).count(), 0, 'no Analyses in the sidebar');
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Draft dashboards"] canvas').length >= 1); // its preview, drawn
  loaded('/dashboards, drafts');
  await screens(page, 'dashboards-list-drafts');

  // Create dashboard and its arrow: the other ways in are there, not in the header.
  assert.equal(await page.getByRole('button', { name: /Rebuild/ }).count(), 0, 'no Rebuild button in the header');
  await page.getByRole('button', { name: 'More ways to create' }).click();
  const create = page.getByRole('menu', { name: 'More ways to create' });
  assert.deepEqual((await create.getByRole('menuitem').allTextContents()).map((t) => t.trim()), ['Blank dashboard', 'Rebuild from a screenshot']);
  await screensInPlace(page, 'dashboards-list-create-menu');
  await page.keyboard.press('Escape');

  // ── Published, then edits not live ─────────────────────────────────────
  const href = (await drafts.getByRole('link', { name: /Retail overview/ }).getAttribute('href')) ?? '';
  const aid = /\/analyses\/[^/]+\/([0-9a-f-]{36})$/.exec(href)?.[1] ?? '';
  assert.match(aid, /^[0-9a-f-]{36}$/, `a draft opens in the editor: ${href}`);
  assert.equal((await call(page, 'analysis:publish', { projectId: pid, id: aid })).ok, true);
  assert.equal((await call(page, 'analysis:rename', { projectId: pid, id: aid, name: 'Retail overview, revised' })).ok, true);
  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  const published = page.getByRole('list', { name: 'Published dashboards' });
  const card = published.getByRole('link', { name: /Retail overview, revised/ });
  await card.getByText('Edits not live').waitFor();
  assert.equal(await card.getAttribute('href'), `/dashboards/${pid}/${aid}`, 'a published card opens its view page');
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Published dashboards"] canvas').length >= 1);
  loaded('/dashboards, published');
  await screens(page, 'dashboards-list-published');

  await page.getByRole('button', { name: 'Retail overview, revised options' }).click();
  assert.deepEqual(
    (await page.getByRole('menuitem').allTextContents()).map((t) => t.trim()),
    ['Open published', 'Edit', 'Preview', 'Duplicate', 'Rename', 'History', 'Lineage', 'Unpublish…', 'Delete…'],
  );
  await screensInPlace(page, 'dashboards-list-card-menu');
  await page.getByRole('menuitem', { name: 'Unpublish…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Unpublish “Retail overview, revised”?' });
  await confirm.getByText(/The draft stays/).waitFor();
  await screensInPlace(page, 'dashboards-list-unpublish');
  await confirm.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await page.getByText('“Retail overview, revised” is a draft again.').waitFor();
  // Nothing is published now, and no tab was picked: the page follows it to Drafts.
  await page.getByRole('list', { name: 'Draft dashboards' }).getByRole('link', { name: /Retail overview, revised/ }).waitFor();
  assert.equal(await page.getByRole('tab', { name: /^Drafts/ }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: /^Published/ }).click();
  await page.getByRole('heading', { name: 'Nothing published yet' }).waitFor();
  assert.equal((await call(page, 'analysis:rename', { projectId: pid, id: aid, name: 'Retail overview' })).ok, true);
});

e2e('an editor’s first dashboard: every way to start one, and Create opens the wizard', async ({ page, rpc }) => {
  await page.goto('/');
  await settled(page);
  const made = await call(page, 'projects:create', { name: 'Fresh start' });
  assert.match(made.id ?? '', /^[0-9a-f-]{36}$/, JSON.stringify(made));
  await page.goto(`/dashboards?project=${made.id}`);
  await settled(page);
  await page.getByRole('heading', { name: 'Start your first dashboard' }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 0, 'nothing to sort into tabs');
  assert.equal(await page.getByRole('button', { name: 'More ways to create' }).count(), 0, 'the panel holds the ways in, not the header');
  assert.equal(await page.getByRole('button', { name: 'Draft with AI' }).isDisabled(), true, 'no model on this server');
  await page.getByTestId('ai-not-ready').waitFor();
  assert.equal(await page.getByRole('link', { name: 'Rebuild it here' }).getAttribute('href'), `/analyses/${made.id}/rebuild`);
  console.log(`rpc: /dashboards, empty ${rpc.loads.at(-1)?.rpcs ?? 0}`);
  await screens(page, 'dashboards-list-empty');
  await page.getByRole('button', { name: 'Create dashboard' }).click();
  await page.getByRole('dialog', { name: 'Create dashboard' }).waitFor();
});

e2e('the Dashboards page on a phone: the header, tabs, cards, both menus, a dialog and the empty panels fit', async ({ page, server }) => {
  const pid = server.sample.projectId;
  const misfits: string[] = [];
  const name = 'Retail overview, revised for the quarterly business review'; // a long one: it must truncate, not widen the card
  // Every control on the page a thumb presses: the header's three, the tabs, each card's ⋯.
  // Menus' rows and dialogs' buttons are the UI kit's (32px, web/src/ui), so only the page's own controls are measured.
  const tap = [
    page.getByRole('button', { name: 'Draft with AI' }),
    page.getByRole('button', { name: 'Create dashboard', exact: true }),
    page.getByRole('button', { name: 'More ways to create' }),
    page.getByRole('tab'),
    page.getByRole('button', { name: / options$/ }),
  ];

  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  const drafts = page.getByRole('list', { name: 'Draft dashboards' });
  await drafts.getByRole('link', { name: /Retail overview/ }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Draft dashboards"] canvas').length >= 1);
  await phoneFits(page, misfits, 'Drafts', { tap });
  // Stacked, the header's two ways in share the row: the split's arrow ends where Draft with AI does.
  const right = async (label: string) => page.getByRole('button', { name: label, exact: true }).evaluate((el) => Math.round(el.getBoundingClientRect().right));
  if ((await right('More ways to create')) !== (await right('Draft with AI'))) misfits.push('Drafts @375: Create dashboard does not span the row, as Draft with AI does');
  await screens(page, 'dashboards-list-phone-drafts');

  await page.getByRole('button', { name: 'More ways to create' }).click();
  const create = page.getByRole('menu', { name: 'More ways to create' });
  await phoneFits(page, misfits, 'the create menu', { on: [create] });
  await screensInPlace(page, 'dashboards-list-phone-create-menu');
  await page.keyboard.press('Escape');

  // ── Published, with edits not live: the badge and the longest meta a card has ──
  const href = (await drafts.getByRole('link', { name: /Retail overview/ }).getAttribute('href')) ?? '';
  const aid = /\/analyses\/[^/]+\/([0-9a-f-]{36})$/.exec(href)?.[1] ?? '';
  assert.equal((await call(page, 'analysis:publish', { projectId: pid, id: aid })).ok, true);
  assert.equal((await call(page, 'analysis:rename', { projectId: pid, id: aid, name })).ok, true);
  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  await page.getByRole('list', { name: 'Published dashboards' }).getByText('Edits not live').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Published dashboards"] canvas').length >= 1);
  await phoneFits(page, misfits, 'Published', { tap });
  await screens(page, 'dashboards-list-phone-published');
  await page.setViewportSize({ width: 414, height: 896 });
  await screens(page, 'dashboards-list-phone-414-published');
  await page.setViewportSize(PHONE.viewport);

  await page.getByRole('button', { name: `${name} options` }).click();
  const menu = page.getByRole('menu', { name: `${name} options` });
  await phoneFits(page, misfits, 'the card menu', { on: [menu] });
  await screensInPlace(page, 'dashboards-list-phone-card-menu');
  await menu.getByRole('menuitem', { name: 'Unpublish…' }).click();
  const confirm = page.getByRole('dialog', { name: /^Unpublish/ });
  await confirm.getByText(/The draft stays/).waitFor();
  await phoneFits(page, misfits, 'the Unpublish dialog', { on: [confirm] });
  await screensInPlace(page, 'dashboards-list-phone-unpublish');
  await confirm.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await page.getByText(/is a draft again/).waitFor();
  await page.getByRole('tab', { name: /^Published/ }).click();
  await page.getByRole('heading', { name: 'Nothing published yet' }).waitFor();
  await phoneFits(page, misfits, 'the empty Published tab', { tap });
  await screensInPlace(page, 'dashboards-list-phone-empty-tab');
  assert.equal((await call(page, 'analysis:rename', { projectId: pid, id: aid, name: 'Retail overview' })).ok, true);

  // ── A project with no dashboard: the first-dashboard panel ──
  const made = await call(page, 'projects:create', { name: 'Phone start' });
  await page.goto(`/dashboards?project=${made.id}`);
  await settled(page);
  await page.getByRole('heading', { name: 'Start your first dashboard' }).waitFor();
  await phoneFits(page, misfits, 'the first-dashboard panel', { tap: [page.getByRole('main').getByRole('button')] });
  await screens(page, 'dashboards-list-phone-empty');

  assert.deepEqual(misfits, [], misfits.join('\n'));
}, { device: PHONE });
