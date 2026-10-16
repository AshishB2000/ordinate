// "Find similar values" in Prepare's Replace step, against the real server.
//
// The sample's `region` is clean, so the spec first makes it messy the way real
// data is: a calculated column that upper-cases the region on some rows
// ("East" and "EAST" are then two values). Then:
//
//   find      the Replace form, on that column: "Find similar values" lists the
//             server's groups — "Merge 2 variations into …" with each value's
//             row count — and adds nothing until asked
//   add       unticking a group leaves it out; the rest become ordinary
//             find → replace rules in the form, and the saved step is a plain
//             "Replace values" step
//   applied   asking again on a step after it finds one group fewer: the merge
//             happened in the data, not on the screen
//   clean     NEGATIVE CONTROL: the original `region` has nothing to merge
//
// Fails on any console error or CSP violation and stays inside the RPC budget.
// Screens in both themes go to web/e2e/__screens__/similar-values-*.png.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { csrfToken, e2e, SCREENS, settled, type Session } from './fixtures.ts';

/** One screenshot per theme WITHOUT a reload (the groups stay listed). */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

/** An RPC from the spec itself, with the CSRF pair the web client sends (T6.2). */
async function post(s: Session, channel: string, payload?: unknown): Promise<any> { // any: each channel's own reply
  const csrf = await csrfToken(s);
  const r = await s.page.request.post(`${s.server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
  assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
  return r.json();
}

e2e('similar values: the server’s groups → replace rules → a plain step; a clean column has none', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  const retail = ((await post(s, 'dataset:list', { projectId: pid })) as { id: string; name: string }[]).find((d) => d.name === 'Retail orders');
  assert.ok(retail, 'the sample dataset');
  const at = { projectId: pid, datasetId: retail.id };
  const messy = await post(s, 'dataset:addStep', { ...at, step: { type: 'calculated_field', name: 'region_raw', expression: 'if([units] > 5, upper([region]), [region])' } });
  assert.equal(messy.ok, true, JSON.stringify(messy).slice(0, 300));
  const server = await post(s, 'prepare:similarValues', { ...at, index: -1, column: 'region_raw' });
  assert.ok(server.ok && server.clusters.length >= 2, `the fixture has groups to merge: ${JSON.stringify(server).slice(0, 300)}`);
  const first = server.clusters[0] as { to: string; from: { value: string; count: number }[]; rows: number };
  const second = server.clusters[1] as typeof first;

  await page.goto(`/data/${pid}/${retail.id}/prepare?add=replace_values&column=region_raw`);
  await settled(page);
  const editor = page.getByRole('region', { name: 'Add: Replace values' });

  // ── Find ────────────────────────────────────────────────────────────────
  await editor.getByRole('button', { name: 'Find similar values' }).click();
  const box = editor.getByRole('region', { name: 'Similar values' });
  await box.getByText(new RegExp(`^${server.clusters.length} groups of similar values in “region_raw”`)).waitFor();
  const firstBox = box.getByRole('checkbox', { name: `Merge 2 variations into “${first.to}”` });
  await firstBox.waitFor();
  await box.getByText(`"${first.from[0].value}" (${first.from[0].count.toLocaleString('en-US')}) · ${first.rows.toLocaleString('en-US')} rows change`).waitFor();
  assert.equal(await editor.getByRole('textbox', { name: 'Find' }).first().inputValue(), '', 'nothing is added to the rules until asked');
  await box.scrollIntoViewIfNeeded();
  await screensInPlace(page, 'similar-values-found');

  // ── Add ─────────────────────────────────────────────────────────────────
  await box.getByRole('checkbox', { name: `Merge 2 variations into “${second.to}”` }).click();
  await box.getByRole('button', { name: `Add ${server.clusters.length - 1} merge${server.clusters.length - 1 === 1 ? '' : 's'} as rules` }).click();
  await box.waitFor({ state: 'detached' });
  const finds = editor.getByRole('textbox', { name: 'Find' });
  const found = await Promise.all(Array.from({ length: await finds.count() }, (_, i) => finds.nth(i).inputValue()));
  assert.ok(found.includes(first.from[0].value), `the ticked group is a rule: ${found.join(', ')}`);
  assert.ok(!found.includes(second.from[0].value), 'the unticked group is not');
  assert.ok(!found.includes(''), 'the blank starter rule is gone');
  await editor.getByRole('button', { name: 'Save step' }).click();
  await editor.waitFor({ state: 'detached' });
  await page.getByRole('list', { name: 'Pipeline steps' }).getByText(/^Replace/).waitFor();

  // ── Applied ─────────────────────────────────────────────────────────────
  const after = await post(s, 'prepare:similarValues', { ...at, index: -1, column: 'region_raw' });
  assert.equal(after.clusters.length, 1, `only the unticked group is left to merge: ${JSON.stringify(after.clusters)}`);
  assert.equal(after.clusters[0].to, second.to);

  // ── A clean column ──────────────────────────────────────────────────────
  await page.goto(`/data/${pid}/${retail.id}/prepare?add=replace_values&column=region`);
  await settled(page);
  await editor.getByRole('button', { name: 'Find similar values' }).click();
  await box.getByText(/^No similar values among the \d+ values of “region”\.$/).waitFor();
  assert.equal(await box.getByRole('checkbox').count(), 0, 'NEGATIVE CONTROL: a clean column offers nothing to merge');
});
