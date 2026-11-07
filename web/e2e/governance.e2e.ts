// Certified and retired status (semantic layer part 4) against the real server and the sample project:
//
//   Certify Revenue through Review; edit its format, which asks first (Save anyway), and its row reads
//   "Changed since certified". Retire Units for Orders: a KPI on Units says "Retired metric" and "Switch to Orders"
//   redraws it; the measure picker lists Orders ahead of the retired Units, which is folded under "Retired (1)".
//   Light and dark screenshots of the Metrics tab. Both statuses are cleared and Revenue's format restored.
//
//   npm --prefix web run e2e -- governance
//
// The viewer's side (no Certify, badges visible) is covered in Vitest (model/status/screens.test.tsx), since the
// e2e harness signs in as the project's admin only.

import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { e2e, screens, screensInPlace, settled } from './fixtures.ts';

const rowOf = (page: Page, name: string) => page.getByRole('table').getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });

e2e('governance: certify, the save warning, retire and switch', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto(`/model/${pid}?tab=metrics`);
  await settled(page);
  const revenue = rowOf(page, 'Revenue');
  await revenue.waitFor();

  // Certify Profit and Revenue through Review.
  for (const name of ['Profit', 'Revenue']) {
    await page.getByRole('button', { name: `Status of ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Certify…' }).click();
    const review = page.getByRole('dialog', { name: `Review ${name}` });
    await review.getByText('Not certified yet').waitFor();
    if (name === 'Revenue') await screensInPlace(page, 'governance-review-first');
    await review.getByRole('button', { name: 'Certify' }).click();
    await review.waitFor({ state: 'detached' });
    await rowOf(page, name).getByText('Certified', { exact: true }).waitFor();
  }

  // A figure-changing save asks first, naming the certifier. (A fresh load: the RPC budget is per page load.)
  await page.goto(`/model/${pid}?tab=metrics`);
  await settled(page);
  await revenue.getByRole('button', { name: 'Revenue', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit metric' });
  await editor.getByRole('spinbutton', { name: 'Decimal places' }).fill('1');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const warn = page.getByRole('dialog', { name: 'Change a certified definition?' });
  await warn.getByText(/Revenue is certified by .+\. Saving changes .+ and needs a project admin to certify it again\./).waitFor();
  await warn.getByRole('button', { name: 'Save anyway' }).click();
  await revenue.getByText('Changed since certified').waitFor();
  await page.getByRole('button', { name: 'Status of Revenue' }).click();
  await page.getByRole('menuitem', { name: 'Review and certify…' }).click();
  await page.getByRole('dialog', { name: 'Review Revenue' }).getByRole('heading', { name: 'What changed' }).waitFor();
  await screensInPlace(page, 'governance-review');
  await page.keyboard.press('Escape');

  // Retire Units for Orders.
  await page.goto(`/model/${pid}?tab=metrics`);
  await settled(page);
  await page.getByRole('button', { name: 'Status of Units' }).click();
  await page.getByRole('menuitem', { name: 'Retire…' }).click();
  const retire = page.getByRole('dialog', { name: 'Retire Units' });
  await retire.getByRole('combobox', { name: 'Replaced by' }).click();
  await page.getByRole('option', { name: 'Orders', exact: true }).click();
  await screensInPlace(page, 'governance-retire');
  await retire.getByRole('button', { name: 'Retire' }).click();
  await retire.waitFor({ state: 'detached' });
  await rowOf(page, 'Units').getByText('Retired · use Orders').waitFor();
  await screens(page, 'governance-metrics');

  // The Retired filter, and the strip's review item for what changed.
  await page.getByRole('button', { name: 'Retired', exact: true }).click();
  await rowOf(page, 'Units').waitFor();
  assert.equal(await rowOf(page, 'Revenue').count(), 0);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.goto(`/model/${pid}`);
  await settled(page);
  await page.getByRole('button', { name: 'Revenue changed since certified' }).waitFor();
  await screens(page, 'governance-strip');

  // A KPI on Units says so, and Switch redraws it on Orders.
  await page.goto(`/dashboards?project=${pid}`);
  await settled(page);
  await page.getByRole('link', { name: /Retail overview/ }).click();
  await page.getByRole('heading', { level: 1, name: 'Retail overview' }).waitFor();
  await page.getByText('Retired metric: Units').waitFor();
  await page.getByRole('button', { name: 'Switch to Orders' }).click();
  await page.getByText('Retired metric: Units').waitFor({ state: 'detached' });
  assert.deepEqual(rpc.problems(), []);

  // Clean up: both statuses cleared, Revenue's format restored.
  await page.goto(`/model/${pid}?tab=metrics`);
  await settled(page);
  await page.getByRole('button', { name: 'Status of Units' }).click();
  await page.getByRole('menuitem', { name: 'Clear status' }).click();
  await rowOf(page, 'Units').getByText(/Retired/).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Status of Profit' }).click();
  await page.getByRole('menuitem', { name: 'Clear status' }).click();
  await rowOf(page, 'Revenue').getByRole('button', { name: 'Revenue', exact: true }).click();
  const again = page.getByRole('dialog', { name: 'Edit metric' });
  await again.getByRole('spinbutton', { name: 'Decimal places' }).fill('0');
  await again.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Status of Revenue' }).click();
  await page.getByRole('menuitem', { name: 'Clear status' }).click();
  await rowOf(page, 'Revenue').getByText(/Changed since certified|Certified/).waitFor({ state: 'detached' });
});
