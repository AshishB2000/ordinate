// Two editors never overwrite each other (docs/edit-conflicts/00-design.md),
// against the real server: two pages on one dashboard.
//
//   A renames it and saves; B, opened before that save, renames too → B's
//   banner ("This dashboard was changed in another tab or by someone else."),
//   and the record is still A's → Reload in B shows A's name, no banner →
//   again, A saves and B edits → Save mine as a copy opens a new dashboard
//   holding B's change, and the original keeps A's.
//
// Then the dialog form of the banner: B has a metric open in its editor when A
// saves the metric; B's Save is refused, the banner is inside the dialog, and
// Reload brings A's change into the boxes.
//
// Page B is wired with the same fixtures as A (console errors, CSP, RPC budget).
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, failOnConsoleError, rpcBudget, SCREENS, settled } from './fixtures.ts';

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

/** One screenshot per theme WITHOUT a reload: a reload would be the banner's Reload. */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

async function rename(page: Page, to: string): Promise<void> {
  await page.getByTitle('Click to rename').click();
  const dlg = page.getByRole('dialog', { name: 'Rename dashboard' });
  await dlg.getByRole('textbox', { name: 'Name' }).fill(to);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
}

/** Until the server holds `name` for the dashboard (A's autosave has landed). */
async function stored(page: Page, pid: string, id: string, name: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const r = await call(page, 'analysis:open', { projectId: pid, id });
    if (r.ok && r.analysis.name === name) return;
    await page.waitForTimeout(200);
  }
  assert.fail(`the server never held “${name}”`);
}

e2e('edit conflicts: two pages on one dashboard → B’s banner → Reload shows A’s change → Save mine as a copy holds B’s', async ({ page: a, server }) => {
  const pid = server.sample.projectId;
  await a.goto(`/analyses?project=${pid}`);
  await settled(a);
  const sets: Array<{ id: string; name: string }> = await call(a, 'dataset:list', { projectId: pid });
  const ds = sets.find((d) => d.name === 'Retail orders');
  assert.ok(ds, 'the sample dataset');
  const board = await call(a, 'analysis:create', {
    projectId: pid,
    name: 'Weekly review',
    sheets: [{ name: 'Overview', cards: [
      { id: crypto.randomUUID(), type: 'metric', layout: { x: 0, y: 0, w: 4, h: 2 }, metric: { datasetId: ds.id, column: 'revenue', aggregation: 'sum', label: 'Revenue' } },
      { id: crypto.randomUUID(), type: 'text', layout: { x: 4, y: 0, w: 8, h: 2 }, heading: 'This week', text: 'Revenue against the plan, by week.' },
    ] }],
  });
  assert.ok(board.id, JSON.stringify(board));
  const dash = `/analyses/${pid}/${board.id}`;

  // B: a second tab, wired like A.
  const b = await a.context().newPage();
  const bProblems = await failOnConsoleError(b);
  const bRpc = rpcBudget(b);

  await a.goto(dash);
  await b.goto(dash);
  await a.getByTitle('Click to rename').waitFor();
  await b.getByTitle('Click to rename').waitFor();

  // A saves first; B, still on the copy it opened, edits too.
  await rename(a, 'Edited in A');
  await stored(a, pid, board.id, 'Edited in A');
  await rename(b, 'Edited in B');
  const banner = b.getByRole('alert').filter({ hasText: 'This dashboard was changed in another tab or by someone else.' });
  await banner.waitFor();
  await b.getByRole('status').filter({ hasText: 'Not saved' }).waitFor();
  assert.deepEqual(await banner.getByRole('button').allTextContents(), ['Reload', 'Save mine as a copy'], 'no way to dismiss it');
  // Autosave stopped: well past the 600 ms debounce, the record is still A's.
  await b.waitForTimeout(1500);
  assert.equal((await call(b, 'analysis:open', { projectId: pid, id: board.id })).analysis.name, 'Edited in A');
  assert.equal(await a.getByRole('alert').count(), 0, 'A, whose save landed, has no banner');
  await screensInPlace(b, 'edit-conflicts-banner');

  // Reload: B's change is dropped, A's is on screen, and B edits again from there.
  await banner.getByRole('button', { name: 'Reload' }).click();
  await b.getByTitle('Click to rename').filter({ hasText: 'Edited in A' }).waitFor();
  assert.equal(await b.getByRole('alert').count(), 0, 'no banner after Reload');

  // Again: A saves, B edits — this time B keeps its version as a copy.
  await rename(a, 'Final from A');
  await stored(a, pid, board.id, 'Final from A');
  await rename(b, 'Kept from B');
  await banner.waitFor();
  await banner.getByRole('button', { name: 'Save mine as a copy' }).click();
  await b.waitForURL((u) => u.pathname.startsWith(`/analyses/${pid}/`) && !u.pathname.endsWith(board.id));
  await b.getByTitle('Click to rename').filter({ hasText: 'Kept from B (copy)' }).waitFor();
  assert.equal(await b.getByRole('alert').count(), 0, 'the copy opens without a banner');
  const copyId = new URL(b.url()).pathname.split('/').pop();
  const copy = await call(b, 'analysis:open', { projectId: pid, id: copyId });
  assert.equal(copy.analysis.name, 'Kept from B (copy)');
  assert.equal(copy.analysis.sheets[0].cards.length, 2, 'the copy holds B’s whole document');
  assert.equal((await call(b, 'analysis:open', { projectId: pid, id: board.id })).analysis.name, 'Final from A', 'the original keeps A’s');

  // The dialog form: B has a metric open when A saves it.
  const metrics: { ok: boolean; metrics: Array<{ id: string; name: string }> } = await call(a, 'metric:list', { projectId: pid });
  const revenue = metrics.metrics.find((m) => m.name === 'Revenue');
  assert.ok(revenue, 'the sample Revenue metric');
  await b.goto(`/data/metrics?project=${pid}`);
  await settled(b);
  await b.getByRole('table').getByRole('button', { name: 'Revenue', exact: true }).click();
  const dlg = b.getByRole('dialog', { name: 'Edit metric' });
  await dlg.getByLabel('Description').waitFor();
  const changed = await call(a, 'metric:update', { projectId: pid, id: revenue.id, patch: { description: 'Gross revenue, before refunds — updated in A.' } });
  assert.ok(changed.ok, JSON.stringify(changed));
  await dlg.getByLabel('Description').fill('Revenue as B describes it.');
  const save = dlg.getByRole('button', { name: 'Save', exact: true });
  if (await save.isEnabled()) await save.click(); // the server's push may have raised the banner already
  const inDialog = dlg.getByRole('alert').filter({ hasText: 'This metric was changed in another tab or by someone else.' });
  await inDialog.waitFor();
  assert.equal(await save.isEnabled(), false, 'Save is paused');
  await inDialog.scrollIntoViewIfNeeded(); // typing in Description after the push raised it scrolled it away
  await screensInPlace(b, 'edit-conflicts-dialog');
  await inDialog.getByRole('button', { name: 'Reload' }).click();
  const reopened = b.getByRole('dialog', { name: 'Edit metric' });
  let seen = '';
  for (let i = 0; i < 50 && seen !== 'Gross revenue, before refunds — updated in A.'; i += 1) {
    await b.waitForTimeout(200);
    seen = await reopened.getByLabel('Description').inputValue().catch(() => '');
  }
  assert.equal(seen, 'Gross revenue, before refunds — updated in A.', 'Reload brings A’s change into the boxes');
  assert.equal(await reopened.getByRole('alert').count(), 0, 'no banner after Reload');

  const problems = [...bProblems(), ...bRpc.problems()];
  assert.deepEqual(problems, [], `page B: ${problems.join('; ')}`);
  await b.close();
});
