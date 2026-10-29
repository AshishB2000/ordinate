// Dashboards inside the app (docs/superpowers/specs/2026-10-27-dashboards-in-app-design.md) against the real server:
//
//   ready   /dashboards opens empty, with no tabs (no Shared links), saying what Ready means → the sample dashboard's
//           Ready switch (not an edit: nothing to undo) → its Analyses card wears "Ready" → the page lists it, with
//           its preview
//   view    one click opens it inside the app at /dashboards/<p>/<id>: the editing canvas with the server's figures
//           ($5.2M), clean like /p/<id>/ (no editing tool, no Edit, no layout size, no History or Lineage, no sheet
//           tabs for its one sheet), in the app's light and dark → Copy link copies the live address, no Publish
//           dialog, no Share link → Ready off, on the editing screen in Analyses, empties the page again
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { e2e, screens, settled } from './fixtures.ts';

e2e('dashboards in the app: Ready, the Dashboards page, the view page, Copy link, Ready off in Analyses', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  const loaded = (what: string) => console.log(`rpc: ${what} ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // ── The Dashboards page, before anything is Ready: no tabs ─────────────
  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  await page.getByRole('heading', { name: 'No dashboards are Ready yet' }).waitFor();
  await page.getByRole('link', { name: 'Go to Analyses' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Shared links' }).count(), 0, 'no Shared links tab: the page is the Ready dashboards');
  loaded('/dashboards, none Ready');
  await screens(page, 'dashboards-ready-empty');

  // ── Ready, on the editing screen ───────────────────────────────────────
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  await page.getByRole('link', { name: /Retail overview/ }).click();
  await page.getByRole('group', { name: 'Revenue card' }).getByText('$5.2M').waitFor();
  const aid = /\/analyses\/[^/]+\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  await page.getByRole('switch', { name: 'Ready' }).check();
  await page.getByText('Ready: it is on the Dashboards page.').waitFor();
  await page.getByRole('button', { name: 'Nothing to undo' }).waitFor(); // not an edit: no undo step, no autosave
  await screens(page, 'dashboards-ready-switch');
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  await page.getByRole('link', { name: /Retail overview/ }).getByText('Ready', { exact: true }).waitFor();
  await screens(page, 'dashboards-ready-mark');

  // ── The Dashboards tab lists it; one click opens it inside the app ─────
  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  const card = page.getByRole('list', { name: 'Ready dashboards' }).getByRole('link', { name: /Retail overview/ });
  await card.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Ready dashboards"] canvas').length > 0); // its preview, drawn
  loaded('/dashboards, one Ready');
  await screens(page, 'dashboards-ready');
  await card.click();
  await page.waitForURL(`**/dashboards/${pid}/${aid}`);

  // ── The view page: the same canvas and figures, no editing tool, nothing a /p/ page lacks ──
  await page.getByRole('heading', { level: 1, name: 'Retail overview' }).waitFor();
  await page.getByRole('group', { name: 'Revenue card' }).getByText('$5.2M').waitFor();
  loaded('/dashboards/<p>/<id>');
  for (const [role, name] of [
    ['group', 'Add to the sheet'],
    ['navigation', 'Authoring panels'],
    ['button', 'Add sheet'],
    ['button', 'Nothing to undo'],
    ['button', 'Card properties'],
    ['switch', 'Ready'],
    ['group', 'Layout size'],
    ['tablist', 'Sheets'], // the sample has one sheet: no tabs row, like /p/<id>/
  ] as const) {
    assert.equal(await page.getByRole(role, { name }).count(), 0, `the view page shows no “${name}”`);
  }
  assert.equal(await page.getByRole('link', { name: 'Edit', exact: true }).count(), 0, 'no Edit: editing is in Analyses');
  assert.equal(await page.getByText('View only', { exact: true }).count(), 0, 'no badge: viewing is the point of the page');
  await page.getByRole('main').getByRole('link', { name: 'Dashboards' }).waitFor();
  await page.getByRole('button', { name: 'Subscribe' }).waitFor(); // a reader's own write: an editor keeps it here
  await page.getByRole('button', { name: 'More dashboard actions' }).click();
  const exportHtml = page.getByRole('menuitem', { name: 'Export HTML' });
  await exportHtml.waitFor();
  for (const name of ['History', 'Lineage']) assert.equal(await page.getByRole('menuitem', { name }).count(), 0, `the ⋯ menu has no “${name}”`);
  await page.keyboard.press('Escape');
  await exportHtml.waitFor({ state: 'detached' });
  await screens(page, 'dashboards-view');

  // ── Copy link: the live in-app address, for an editor too — no Publish dialog, no leaving the page ──
  assert.equal(await page.getByRole('button', { name: 'Share link' }).count(), 0, 'no Share link: the live link is the one to share');
  await page.getByRole('button', { name: 'Copy link' }).click();
  // Either toast: whether a headless browser grants the clipboard is the browser's call, not the page's.
  await page.getByText(/^(Link copied|The clipboard is not available here\.)$/).first().waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Publish' }).count(), 0, 'no Publish dialog');
  assert.equal(new URL(page.url()).pathname, `/dashboards/${pid}/${aid}`, 'still on the view page');

  // ── Ready off, on the editing screen in Analyses, takes it off the page ──
  await page.goto(`/analyses/${pid}/${aid}`);
  await page.getByRole('group', { name: 'Add to the sheet' }).waitFor();
  await page.getByRole('switch', { name: 'Ready' }).uncheck();
  await page.getByText('Taken off the Dashboards page.').waitFor();
  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  await page.getByRole('heading', { name: 'No dashboards are Ready yet' }).waitFor();
});
