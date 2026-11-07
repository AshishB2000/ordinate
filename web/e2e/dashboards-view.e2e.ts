// Drafts and Publish, from the editor's side (docs/superpowers/specs/2026-10-29-dashboard-drafts-publish-design.md),
// against the real server, signed in as the dev admin, on the sample dashboard:
//
//   draft      it opens as a Draft: back to Dashboards, Preview and Publish — no Ready switch
//   preview    Preview → the view page drawing the draft under its strip, no editing tool, the server's figures
//   publish    the strip's Publish → the dialog (who sees it, what freezes, what goes) → the published view: Edit,
//              "Published <date>", ⋯ Copy link; no editing tool, nothing a /p/ page lacks
//   edited     Edit → a text card → "Edits not live · published <date>" and the strip "Not live yet: 1 card added
//              since you published on …" → See changes opens that compare in History → the published view still
//              draws the version viewers see, and tells the editor: "You have edits that aren’t live yet · Open the draft"
//   discard    Discard edits, confirmed → Published again, the text card gone
//   unpublish  ⋯ Unpublish…, confirmed → Draft; the view page is a Preview again
//
// Screens, both themes: web/e2e/__screens__/drafts-*.png. The viewer's side — what a project viewer sees through all
// of this — is web/e2e/dashboard-drafts.e2e.ts (Postgres).
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { clickUntil, csrfToken, e2e, SCREENS, screens, settled } from './fixtures.ts';

/** One screenshot per theme WITHOUT a reload: a reload would close the dialog on screen. */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

e2e('drafts: a draft, its Preview, Publish, the published view, edits not live, Discard edits, Unpublish', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  const loaded = (what: string) => console.log(`rpc: ${what} ${rpc.loads.at(-1)?.rpcs ?? 0}`);
  const csrf = await csrfToken({ page, server });
  const gallery = (await (await page.request.post(`${server.base}/api/rpc/analysis:gallery`, { headers: { 'x-csrf-token': csrf }, data: { args: [{ projectId: pid }] } })).json()) as { id: string; name: string }[];
  const aid = gallery.find((g) => g.name === 'Retail overview')?.id ?? '';
  assert.match(aid, /^[0-9a-f-]{36}$/, 'the sample dashboard');
  const editor = `/analyses/${pid}/${aid}`;
  const view = `/dashboards/${pid}/${aid}`;
  const head = page.locator('[data-print-root] header').first();
  const revenue = () => page.getByRole('group', { name: 'Revenue card' }).getByText('$5.2M').waitFor();

  // ── A draft, in the editor ──────────────────────────────────────────────
  await page.goto(editor);
  await page.getByRole('group', { name: 'Add to the sheet' }).waitFor();
  await revenue();
  await head.getByText('Draft', { exact: true }).waitFor();
  assert.equal(await head.getByRole('link', { name: 'Dashboards' }).getAttribute('href'), `/dashboards?project=${pid}`, 'back to Dashboards');
  assert.equal(await page.getByRole('switch', { name: 'Ready' }).count(), 0, 'no Ready switch');
  assert.equal(await page.getByRole('button', { name: 'Discard edits' }).count(), 0, 'nothing to discard: never published');
  await page.getByRole('button', { name: 'Preview' }).waitFor();
  loaded('the editor, a draft');
  await screens(page, 'drafts-editor-draft');

  // ── Preview: the view page on the draft ─────────────────────────────────
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.waitForURL(new RegExp(`${view}\\?draft=1$`));
  const strip = page.getByRole('region', { name: 'Preview' });
  await strip.getByText('This is how viewers will see this dashboard once you publish it.').waitFor();
  await page.getByRole('heading', { level: 1, name: 'Retail overview' }).waitFor();
  await revenue();
  for (const [role, name] of [['group', 'Add to the sheet'], ['navigation', 'Authoring panels'], ['button', 'Nothing to undo'], ['group', 'Layout size']] as const) {
    assert.equal(await page.getByRole(role, { name }).count(), 0, `the Preview shows no “${name}”`);
  }
  assert.equal(await page.getByRole('link', { name: 'Edit', exact: true }).count(), 0, 'Back to editing is the way back, not Edit');
  assert.equal(await strip.getByRole('link', { name: 'Back to editing' }).getAttribute('href'), editor);
  loaded('the Preview');
  await screens(page, 'drafts-preview');

  // ── Publish, from the Preview ───────────────────────────────────────────
  await strip.getByRole('button', { name: 'Publish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish “Retail overview”?' });
  await dialog.getByText(`Everyone in ${server.sample.projectName} can see it`).waitFor();
  await dialog.getByText('Viewers see this version').waitFor();
  await dialog.getByText('Figures stay live').waitFor();
  const chips = await dialog.getByRole('list', { name: 'What is published' }).getByRole('listitem').allTextContents();
  assert.equal(chips[0], '1 sheet', `what goes: ${chips.join(', ')}`);
  assert.ok(chips.some((c) => /^\d+ KPIs?$/.test(c)) && chips.some((c) => /^\d+ charts?$/.test(c)), `the sample's KPIs and charts: ${chips.join(', ')}`);
  await screensInPlace(page, 'drafts-publish-dialog');
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByText('Published', { exact: true }).first().waitFor(); // the toast
  await page.waitForURL(`**${view}`);

  // ── The published view ──────────────────────────────────────────────────
  await page.getByRole('link', { name: 'Edit', exact: true }).waitFor();
  assert.equal(await strip.count(), 0, 'no Preview strip: this is the published version');
  await page.getByText(/Published [A-Z][a-z]+ \d+/).waitFor();
  await revenue();
  assert.equal(await page.getByRole('tablist', { name: 'Sheets' }).count(), 0, 'one sheet: no tabs, like /p/<id>/');
  assert.equal(await page.getByRole('button', { name: 'Present' }).count(), 0, 'no Present: Expand takes its place');
  await page.getByRole('button', { name: 'Subscribe' }).waitFor();
  await page.getByRole('button', { name: 'More dashboard actions' }).click();
  await page.getByRole('menuitem', { name: 'Copy link' }).waitFor();
  for (const name of ['History', 'Lineage']) assert.equal(await page.getByRole('menuitem', { name }).count(), 0, `the view page’s ⋯ has no “${name}”`);
  await page.keyboard.press('Escape');
  loaded('the published view');
  await screens(page, 'drafts-view-published');

  // ── Edit: the draft moves, viewers keep the published version ───────────
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.waitForURL(`**${editor}`);
  await head.getByText('Published', { exact: true }).waitFor();
  await page.getByRole('group', { name: 'Add to the sheet' }).getByRole('button', { name: 'Text' }).click();
  const text = page.getByRole('dialog', { name: 'Add text' });
  await text.getByLabel('Heading (optional)').fill('Draft notes');
  await text.getByLabel('Text (optional)').fill('Not for viewers yet.');
  await text.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('group', { name: 'Draft notes card' }).waitFor();
  await head.getByText('Edits not live', { exact: true }).waitFor(); // the save landed and the server said so
  await head.getByText(/^published \w+/).waitFor();
  await page.getByText(/^Not live yet: 1 card added since you published on .+\.$/).waitFor();
  await page.getByRole('button', { name: 'Publish changes' }).waitFor();
  await page.getByRole('button', { name: 'Discard edits' }).waitFor();
  loaded('the editor, edits not live');
  await screens(page, 'drafts-editor-edited');
  await page.getByText(/^Not live yet: 1 card added/).waitFor(); // after the reload too: it is the server's

  // See changes: the compare in History, from the published version to now.
  await page.getByRole('link', { name: 'See changes' }).click();
  await page.waitForURL(new RegExp(`/versions/${pid}/dashboard/${aid}\\?compare=`));
  await page.getByRole('status').filter({ hasText: '1 card added' }).first().waitFor();

  // The published view still draws what viewers see, and tells the editor about the draft.
  await page.goto(view);
  await revenue();
  await page.getByText('You have edits that aren’t live yet.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('group', { name: 'Draft notes card' }).count(), 0, 'the edit is not live');
  assert.equal(await page.getByRole('link', { name: 'Open the draft' }).getAttribute('href'), editor);
  await screens(page, 'drafts-view-edits-not-live');

  // ── Discard edits: back to the published version ────────────────────────
  await page.getByRole('link', { name: 'Open the draft' }).click();
  await page.getByRole('group', { name: 'Draft notes card' }).waitFor();
  await page.getByRole('button', { name: 'Discard edits' }).click();
  const discard = page.getByRole('dialog', { name: 'Discard your edits?' });
  await discard.getByText(/Charts show as they are now in Visuals/).waitFor();
  await screensInPlace(page, 'drafts-discard-confirm');
  await discard.getByRole('button', { name: 'Discard edits' }).click();
  await page.getByText('Edits discarded: the draft is the published version again.').waitFor();
  await head.getByText('Published', { exact: true }).waitFor();
  await page.getByRole('group', { name: 'Add to the sheet' }).waitFor();
  assert.equal(await page.getByRole('group', { name: 'Draft notes card' }).count(), 0, 'the text card is gone');
  assert.equal(await page.getByText(/^Not live yet/).count(), 0, 'nothing is waiting to go live');

  // ── Unpublish: a draft again ────────────────────────────────────────────
  await page.getByRole('button', { name: 'More dashboard actions' }).click();
  await page.getByRole('menuitem', { name: 'View published version' }).waitFor();
  await page.getByRole('menuitem', { name: 'Unpublish…' }).click();
  const off = page.getByRole('dialog', { name: 'Unpublish “Retail overview”?' });
  await off.getByText(/comes off the Dashboards page/).waitFor();
  await off.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await page.getByText('Unpublished: viewers no longer see it. Your draft stays.').waitFor();
  await head.getByText('Draft', { exact: true }).waitFor();
  await page.goto(view);
  await settled(page);
  await page.getByRole('region', { name: 'Preview' }).waitFor(); // never published again: an editor gets the Preview
});

e2e('drill: a tile over a hierarchy drills by its crumbs on the view page, and a published page does not', async ({ page, server }) => {
  const pid = server.sample.projectId;
  const csrf = await csrfToken({ page, server });
  const call = async (channel: string, payload: unknown): Promise<any> => // any: each channel's own reply
    (await (await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: [payload] } })).json()) as unknown;
  const gallery = (await call('analysis:gallery', { projectId: pid })) as { id: string; name: string }[];
  const aid = gallery.find((g) => g.name === 'Retail overview')?.id ?? '';
  const orders = ((await call('dataset:list', { projectId: pid })) as { id: string; name: string }[]).find((d) => d.name === 'Retail orders')?.id;
  const set = await call('catalog:setTable', { projectId: pid, datasetId: orders, patch: { hierarchies: [{ name: 'Product', levels: ['category', 'sub_category'] }] } });
  assert.equal(set.ok, true, JSON.stringify(set));

  const channels: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/rpc/')) channels.push(decodeURIComponent(r.url().split('/api/rpc/')[1] ?? ''));
  });
  await page.goto(`/dashboards/${pid}/${aid}`);
  await page.getByRole('group', { name: 'Revenue card' }).getByText('$5.2M').waitFor();
  await settled(page);
  const card = page.getByRole('group', { name: 'Revenue by category card' });
  await card.locator('canvas').first().waitFor();
  await page.waitForTimeout(800);
  const load = channels.length;
  assert.equal(channels.includes('model:navigation'), false, 'a page load never reads the model’s hierarchies');

  // Right-click a bar until its menu offers the drill (the sample's tiles filter on a plain click).
  const canvas = (await card.locator('canvas').first().boundingBox())!;
  const item = page.getByRole('menuitem', { name: /^Drill into / });
  let found = false;
  for (let r = 1; r <= 6 && !found; r++) {
    for (let c = 1; c <= 9 && !found; c++) {
      await page.mouse.click(canvas.x + (canvas.width * c) / 10, canvas.y + (canvas.height * r) / 7, { button: 'right' });
      found = await item.waitFor({ timeout: 700 }).then(() => true, () => false);
      if (!found) await page.keyboard.press('Escape');
    }
  }
  assert.ok(found, 'a right-click on a bar offers "Drill into"');
  const picked = ((await item.textContent()) ?? '').replace(/^Drill into (.*) · by sub_category$/, '$1');
  const drilled = page.waitForRequest((r) => r.url().includes('analysis%3Atiles') && (r.postData() ?? '').includes('sub_category'));
  await item.click();
  const asked = JSON.parse((await drilled).postData() ?? '{}').args[0].items.find((i: { encoding?: { category?: string } }) => i.encoding?.category === 'sub_category');
  const crumbs = card.getByRole('navigation', { name: 'Drill path' });
  await crumbs.waitFor();
  assert.equal((await crumbs.innerText()).replace(/\s+/g, ' ').trim(), `Product ${picked} · by sub_category Up`);
  await page.waitForTimeout(800);
  const added = channels.slice(load);
  console.log(`rpc: dashboard drill ${added.length} (${added.join(', ')})`);
  assert.deepEqual([...added].sort(), ['analysis:tiles', 'model:navigation', 'visual:drillDown'], 'the first drill adds exactly the navigation, the drill and one tile read');

  // The tile's bars ARE the server's answer to the drilled question, asked directly.
  const direct = await call('visual:data', { projectId: pid, datasetId: asked.datasetId, encoding: asked.encoding, filters: asked.filters, params: [] });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  const tiled = await call('analysis:tiles', { projectId: pid, params: [], items: [asked] });
  const reply = (Array.isArray(tiled) ? tiled : tiled.items ?? tiled.results)?.[0];
  assert.deepEqual(reply?.data?.labels, direct.data.labels, 'the drilled labels');
  assert.deepEqual(reply?.data?.series, direct.data.series, 'the drilled figures');
  assert.ok(direct.data.labels.length > 0 && !direct.data.labels.includes(picked), 'children, not the parent');
  await screensInPlace(page, 'tile-drilled');

  // Up redraws by category and asks nothing.
  const upFrom = channels.length;
  await crumbs.getByRole('button', { name: 'Up' }).click();
  await crumbs.waitFor({ state: 'detached' });
  await page.waitForTimeout(800);
  assert.deepEqual(channels.slice(upFrom), [], 'Up is a cached tile: no request');

  // A published page has its own renderer: a click on a bar sends nothing.
  const site = await call('publish:run', { projectId: pid, dashboardIds: [aid] });
  assert.equal(site.ok, true, JSON.stringify(site));
  await page.goto(`${server.base}/p/${site.site.id}/`);
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(800);
  const pub = (await page.locator('canvas').first().boundingBox())!;
  const mark = channels.length;
  await clickUntil(page, pub, async () => false, 6, 4);
  assert.deepEqual(channels.slice(mark), [], 'a click on a published chart makes no RPC');
});
