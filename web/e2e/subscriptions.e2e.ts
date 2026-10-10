// Subscriptions against the real server, as it runs with no database (dev
// sign-in): everything that needs no stored webhook URL.
//
//   Reports → Subscriptions, empty: what a subscription is and the first action
//   → the sample dashboard → Subscribe: the wide dialog, its four steps and the
//   preview beside them, drawn from the server's own message for that dashboard
//   (a KPI figure the server computed, a chart as rows) → When: weekly, a day
//   chip, the server's "Next:" line → Where: no channel can exist on this
//   server, and the step says why → Message → the Teams preview
//   → Admin → Channels: the designed "cannot keep webhook URLs" state.
//
// The full flow — add channels, subscribe, send, runs, remove — needs the
// secrets store, so it is channels.e2e.ts, on Postgres.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled } from './fixtures.ts';

/** One screenshot per theme WITHOUT a reload (the dialog stays up). */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

e2e('subscriptions (no database): empty list → Subscribe dialog, four steps and the live preview → Admin → Channels says why none can be added', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;

  // ── Reports → Subscriptions, empty ────────────────────────────────────
  await page.goto(`/reports?project=${pid}&tab=subscriptions`);
  await settled(page);
  await page.getByRole('heading', { name: 'Nothing is scheduled yet' }).waitFor();
  await page.getByText(/posts a dashboard’s figures to a Slack or Teams channel on a schedule/).waitFor();
  await page.getByRole('button', { name: 'New subscription' }).waitFor();
  await screens(page, 'subscriptions-empty');
  console.log(`rpc: Reports → Subscriptions load ${rpc.loads.at(-1)?.rpcs ?? 0}`);

  // ── The dashboard's Subscribe action ──────────────────────────────────
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  await page.getByRole('list', { name: 'Dashboards' }).getByText('Retail overview').click();
  await page.waitForURL(new RegExp(`/analyses/${pid}/[0-9a-f-]{36}$`));
  await page.getByRole('button', { name: 'Subscribe' }).click();
  const dlg = page.getByRole('dialog', { name: 'Subscribe to Retail overview' });
  await dlg.waitFor();
  const before = rpc.loads.at(-1)?.rpcs ?? 0;

  // What: the preview is the server's message for this dashboard.
  const slack = dlg.getByTestId('preview-slack');
  await slack.waitFor({ timeout: 30_000 });
  await slack.getByText('Retail overview', { exact: true }).waitFor();
  await slack.getByText('$5.2M').first().waitFor();
  assert.match((await slack.innerText()).replace(/\s+/g, ' '), /Sent by Ordinate · Retail overview — weekdays · Every weekday at 08:00/);
  assert.match(await dlg.getByText(/of 50 blocks/).innerText(), /^\d+ of 50 blocks · \d+(\.\d+)? (B|KB)$/);
  await screensInPlace(page, 'subscribe-what');

  await dlg.getByRole('radio', { name: 'Chosen cards' }).click();
  const cards = dlg.getByRole('checkbox');
  assert.ok((await cards.count()) >= 4, `the dashboard's cards are listed: ${await cards.count()}`);
  await dlg.getByText(/^KPI · /).first().waitFor();
  await dlg.getByText(/^Visual · /).first().waitFor();
  await cards.first().check();
  await dlg.getByText(/Cards · 1 of \d+/).waitFor();
  await screensInPlace(page, 'subscribe-what-cards');
  await dlg.getByRole('radio', { name: 'The whole dashboard' }).click();

  // When: the next runs are the server's.
  await dlg.getByRole('button', { name: /^When/ }).click();
  await dlg.getByRole('radio', { name: 'Weekly' }).click();
  await dlg.getByRole('button', { name: 'Thursday' }).click();
  await dlg.getByLabel('At', { exact: true }).fill('09:30');
  const next = dlg.getByRole('status', { name: 'Next runs' });
  await next.getByText(/Every Mon, Thu at 09:30/).waitFor({ timeout: 15_000 });
  assert.match(await next.innerText(), /Next: (Mon|Thu) \d{1,2} \w{3},? 09:30 · (Mon|Thu) /);
  await screensInPlace(page, 'subscribe-when');

  // Where: this server has no secrets store, so no channel can exist — said, not hidden.
  await dlg.getByRole('button', { name: /^Where/ }).click();
  await dlg.getByRole('heading', { name: 'No channels yet' }).waitFor();
  await dlg.getByText(/cannot keep webhook URLs yet/).waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Subscribe' }).isDisabled(), true, 'nothing to send to: Subscribe is off');
  await screensInPlace(page, 'subscribe-where-empty');

  // Message, and the Teams preview.
  await dlg.getByRole('button', { name: /^Message/ }).click();
  await dlg.getByLabel('Title').fill('Monday numbers');
  await dlg.getByLabel('Note').fill('For the weekly review.');
  await dlg.getByText(/does not know its public address/).waitFor();
  await dlg.getByRole('tab', { name: 'Teams' }).click();
  const teams = dlg.getByTestId('preview-teams');
  await teams.getByText('Monday numbers').waitFor({ timeout: 15_000 });
  await teams.getByText('For the weekly review.').waitFor();
  assert.equal(await teams.getByText('Open in Ordinate').count(), 0, 'no public address: no link in the message');
  await dlg.getByText(/of 28 KB$/).waitFor();
  await screensInPlace(page, 'subscribe-message-teams');
  console.log(`rpc: Subscribe dialog, all four steps ${(rpc.loads.at(-1)?.rpcs ?? 0) - before}`);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await dlg.waitFor({ state: 'detached' });

  // ── Admin → Channels on a server that cannot keep a secret ────────────
  await page.goto('/admin?tab=channels');
  await settled(page);
  await page.getByRole('heading', { name: 'This server cannot keep webhook URLs yet' }).waitFor();
  await page.getByRole('heading', { name: 'No channels yet' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add a channel' }).isDisabled(), true);
  await screens(page, 'admin-channels-nostore');
});
