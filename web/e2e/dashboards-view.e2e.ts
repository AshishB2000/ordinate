// Dashboards inside the app (docs/superpowers/specs/2026-10-27-dashboards-in-app-design.md) against the real server:
//
//   ready   /dashboards opens on its Dashboards tab, empty, saying what Ready means → the sample dashboard's Ready
//           switch (not an edit: nothing to undo) → its Analyses card wears "Ready" → the tab lists it, with its preview
//   view    one click opens it inside the app at /dashboards/<p>/<id>: the editing canvas with the server's figures
//           ($5.2M), no editing tool, in the app's light and dark → Share link lands on Shared links with Publish
//           open on it → Edit opens the editing screen → Ready off empties the tab again
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { e2e, screens, settled } from './fixtures.ts';

e2e('dashboards in the app: Ready, the Dashboards tab, the view page, Share link and Edit', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  const loaded = (what: string) => console.log(`rpc: ${what} ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // ── The Dashboards tab, before anything is Ready ───────────────────────
  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  await page.getByRole('heading', { name: 'No dashboards are Ready yet' }).waitFor();
  await page.getByRole('link', { name: 'Go to Analyses' }).waitFor();
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

  // ── The view page: the same canvas and figures, no editing tool ────────
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
  ] as const) {
    assert.equal(await page.getByRole(role, { name }).count(), 0, `the view page shows no “${name}”`);
  }
  assert.equal(await page.getByText('View only', { exact: true }).count(), 0, 'no badge: viewing is the point of the page');
  await page.getByRole('main').getByRole('link', { name: 'Dashboards' }).waitFor();
  await page.getByRole('link', { name: 'Edit', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Subscribe' }).waitFor(); // a reader's own write: an editor keeps it here
  await screens(page, 'dashboards-view');

  // ── Share link: the Publish dialog, this dashboard picked, on Shared links ──
  await page.getByRole('button', { name: 'Share link' }).click();
  const dlg = page.getByRole('dialog', { name: 'Publish' });
  const picked = dlg.getByRole('checkbox', { name: 'Retail overview' });
  await picked.waitFor();
  assert.equal(await picked.isChecked(), true, 'this dashboard is picked');
  assert.equal(await page.getByRole('tab', { name: 'Shared links', includeHidden: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  assert.match(new URL(page.url()).search, /^\?project=[^&]+&tab=links$/, 'closed, it stays on Shared links');
  await page.getByRole('heading', { name: 'Nothing published yet' }).waitFor();

  // ── Edit: the editing screen; Ready off takes it off the tab ───────────
  await page.goto(`/dashboards/${pid}/${aid}`);
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByRole('group', { name: 'Add to the sheet' }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/analyses/${pid}/${aid}`);
  await page.getByRole('switch', { name: 'Ready' }).uncheck();
  await page.getByText('Taken off the Dashboards page.').waitFor();
  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  await page.getByRole('heading', { name: 'No dashboards are Ready yet' }).waitFor();
});
