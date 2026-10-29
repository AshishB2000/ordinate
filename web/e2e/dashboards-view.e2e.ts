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
import { csrfToken, e2e, SCREENS, screens, settled } from './fixtures.ts';

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
