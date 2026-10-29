// The editor's title row stays one row (docs/superpowers/specs/2026-10-29-dashboard-drafts-publish-design.md): at
// 1440 and 1280 px the name, where the draft stands and every action sit beside each other in all three states —
//
//   draft      Draft · Saved                              Views  Compare  💬  Present  ⋯ │ Preview  Publish
//   published  Published · Saved                          …                                  Preview  Publish (quiet)
//   edited     Edits not live · published <day> · Saved   …                            ↺  Preview  Publish changes
//
// and the authoring row under it (sheets … undo redo │ layout size │ + Visual …) holds one row too. That what left the
// title row is still there by name (Subscribe… in ⋯, Discard edits) is Head.test.tsx; the flow itself (Publish,
// Discard, Unpublish) is web/e2e/dashboards-view.e2e.ts, and ⋯ → Subscribe… is walked by subscriptions.e2e.ts. This
// spec sets each state up through the API and only measures the header. Screens, both themes:
// web/e2e/__screens__/editor-head-*.png (the edited one at 1280 px too).
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright';
import { csrfToken, e2e, screens } from './fixtures.ts';

const centre = async (el: Locator) => {
  const b = await el.boundingBox();
  assert.ok(b, 'on screen');
  return b.y + b.height / 2;
};

/**
 * The title row: the name, the save chip (the status's last word), ⋯ and the primary button share one centre line; the
 * authoring row: undo and the last add button share theirs. A wrap moves one of them a row (~40 px) down.
 */
async function oneRow(page: Page, primary: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  const head = page.locator('[data-print-root] header').first();
  const title = await centre(head.locator('h1'));
  const row = {
    saved: await centre(head.getByText('Saved', { exact: true })),
    '⋯': await centre(head.getByRole('button', { name: 'More dashboard actions' })),
    [primary]: await centre(head.getByRole('button', { name: primary, exact: true })),
  };
  for (const [name, y] of Object.entries(row)) assert.ok(Math.abs(y - title) < 6, `at ${width} px “${name}” sits on the title's row (title ${title}, ${name} ${y})`);
  const undo = await centre(page.getByRole('button', { name: /^(Undo|Nothing to undo)/ }));
  const more = await centre(page.getByRole('group', { name: 'Add to the sheet' }).getByRole('button', { name: 'More' }));
  assert.ok(Math.abs(undo - more) < 6, `at ${width} px undo and the add buttons share the authoring row (undo ${undo}, More ${more})`);
}

e2e('editor head: one row at 1440 and 1280 px — a draft, published, edits not live', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  const csrf = await csrfToken({ page, server });
  const call = async (channel: string, input: object) =>
    (await (await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: [input] } })).json()) as unknown;
  const gallery = (await call('analysis:gallery', { projectId: pid })) as { id: string; name: string }[];
  const aid = gallery.find((g) => g.name === 'Retail overview')?.id ?? '';
  assert.match(aid, /^[0-9a-f-]{36}$/, 'the sample dashboard');
  const head = page.locator('[data-print-root] header').first();
  const editor = `/analyses/${pid}/${aid}`;
  const ready = async (badge: string, primary: string) => {
    await page.getByRole('group', { name: 'Add to the sheet' }).waitFor();
    await head.getByText(badge, { exact: true }).waitFor();
    await head.getByRole('button', { name: primary, exact: true }).waitFor();
  };

  // ── A draft ──
  await page.goto(editor);
  await ready('Draft', 'Publish');
  console.log(`rpc: the editor ${rpc.loads.at(-1)?.rpcs ?? 0}`);
  for (const w of [1440, 1280]) await oneRow(page, 'Publish', w);
  await page.setViewportSize({ width: 1440, height: 900 });
  await screens(page, 'editor-head-draft');

  // ── Published, in step with the draft ──
  const pub = (await call('analysis:publish', { projectId: pid, id: aid })) as { ok?: boolean };
  assert.equal(pub.ok, true, 'published');
  await page.reload();
  await ready('Published', 'Publish');
  for (const w of [1440, 1280]) await oneRow(page, 'Publish', w);
  await page.setViewportSize({ width: 1440, height: 900 });
  await screens(page, 'editor-head-published');

  // ── Edits not live: one edit after the Publish ──
  await page.getByRole('group', { name: 'Add to the sheet' }).getByRole('button', { name: 'Text' }).click();
  const text = page.getByRole('dialog', { name: 'Add text' });
  await text.getByLabel('Heading (optional)').fill('Draft notes');
  await text.getByRole('button', { name: 'Add' }).click();
  await head.getByText('Edits not live', { exact: true }).waitFor();
  await ready('Edits not live', 'Publish changes');
  for (const w of [1440, 1280]) await oneRow(page, 'Publish changes', w);
  await screens(page, 'editor-head-edited-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  await screens(page, 'editor-head-edited');
});
